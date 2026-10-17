import {Type} from 'typebox';
import {CapabilityError,RecordStore,RuntimeCapabilityServices,normalizeCapabilityError,ContinuationCoordinator,TaskLedger,GoalLedger,makeContext,object,text,digest,type PluginContext,type JsonObject,type GoalRecord,type ExecutionMode,type WakeFrame} from '@friend-pi/core';
import type {ExtensionAPI,ExtensionContext,ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {ProcessJobs,type ProcessJob} from './process-jobs.js';

export interface RuntimeHooks {
 publish(event:string,data:unknown):void;busy():boolean;mode():ExecutionMode;planMode():boolean;
 admitUserInput?():Promise<boolean>|boolean;
 sendWake?(frame:WakeFrame):Promise<void>|void;prepareWake(frame:WakeFrame):Promise<void>|void;haltExecution?(origin:PluginContext['origin']):Promise<void>|void;runId():string|undefined;modelId():string|undefined;thinkingLevel():string;
}
interface Activity {sessionId:string;id:string;tool:string;sideEffect:boolean;status:'running'|'settled'|'unknown';runId?:string}
const reading=new Set(['read','grep','find','ls']);
const queries=new Set(['snapshot','list','read','status','result','logs','history.search','history.read','history.around','role.snapshot','role.read','role.versions']);
export class RuntimeController {
 readonly capabilities:RuntimeCapabilityServices;readonly goals:GoalLedger;readonly tasks:TaskLedger;readonly jobs:ProcessJobs;readonly store:RecordStore;
 private nativeContext?:ExtensionContext;private pi?:ExtensionAPI;private coordinator?:ContinuationCoordinator;
 private disposed=false;private draining=false;private activeWake?:WakeFrame;private bindingEpoch=0;private checkpointSerial=0;private readonly wakeEvents=new Set<string>();
 private readonly admittedGoalEpochs=new WeakMap<WakeFrame,number>();
 private goalEpoch=0;private turn?:{automatic:boolean;goalId?:string;objective?:string;goalEpoch:number;success:boolean;unavailable:boolean;response:boolean};
 private readonly waitHandles=new Map<string,{goalId:string;runId?:string;active:boolean}>();
 private readonly swarmStatuses=new Map<string,string>();
 constructor(readonly dataDir:string,readonly hooks:RuntimeHooks){
  this.capabilities=new RuntimeCapabilityServices(dataDir);this.goals=new GoalLedger(dataDir);this.tasks=new TaskLedger(dataDir);this.store=new RecordStore('runtime-activity',dataDir);
  this.jobs=new ProcessJobs(dataDir,job=>this.jobFinished(job),(event,data)=>this.hooks.publish(event,data));
 }
 context(origin:PluginContext['origin']='plugin'){
  if(!this.pi||!this.nativeContext)throw new Error('宿主运行时尚未绑定');return makeContext(this.pi,this.nativeContext,origin);
 }
 generation(){return this.coordinator?.generation()||0;}
 currentGoal(){const session=this.nativeContext?.sessionManager.getSessionId();if(!session)return undefined;const id=this.goals.store.get<string>(`focus:${session}`)?.value;return id?this.goals.store.list<GoalRecord>('goal:').find(row=>row.value.id===id)?.value:undefined;}
 suspendForQueuedInput(){const goal=this.currentGoal();if(!goal||goal.status!=='active')return undefined;this.cancelGoalWake(goal.id);return {id:goal.id,revision:goal.revision,sourceRunId:goal.sourceRunId,objective:goal.objective};}
 setGoalForInput(input:JsonObject,ctx:PluginContext){const prior=this.goals.current(ctx);const goal=this.goals.set(input,ctx,this.generation());this.cancelGoalWake(prior?.id);this.resetGoalStreak(goal.id,ctx);return goal;}
 private resetGoalStreak(goalId:string,ctx:PluginContext){this.store.remove(`turn-streak:${ctx.sessionId}:${goalId}`);}
 cancelGoalWake(goalId?:string){this.goalEpoch++;if(goalId)this.coordinator?.cancelGoal(goalId);}
 beginTurn({automatic}:{automatic:boolean}){this.goals.bindRun(this.context());const goal=this.currentGoal();this.turn={automatic,goalId:goal?.id,objective:goal?.objective,goalEpoch:this.goalEpoch,success:false,unavailable:false,response:false};}
 recordGoalToolOutcome({success,executionUnavailable=false}:{success:boolean;executionUnavailable?:boolean}){if(this.turn){this.turn.success ||= success;this.turn.unavailable ||= executionUnavailable;}}
 recordGoalResponse({text='',reasoning='',questions=[]}:{text?:string;reasoning?:string;questions?:unknown[]}){if(this.turn)this.turn.response ||= !!(text.trim()||reasoning.trim()||questions.length);}

 activeTools(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.store.list<Activity>(`activity:${session}:`).map(row=>row.value).filter(row=>row.status==='running'):[];}
 safeObjects(){return !this.hooks.busy()&&!this.activeTools().length&&!this.jobs.hasFinite(this.context())&&!this.jobs.hasUnknown(this.context())&&!this.store.list<Activity>(`activity:${this.context().sessionId}:`).some(row=>row.value.status==='unknown'&&row.value.sideEffect);}
 unsettledJobs(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.jobs.store.list<ProcessJob>('job:').map(row=>row.value).filter(job=>job.sessionId===session&&(job.status==='unknown'||job.kind==='task'&&job.status==='running')):[];}
 unknownActivities(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.store.list<Activity>(`activity:${session}:`).map(row=>row.value).filter(row=>row.status==='unknown'&&row.sideEffect):[];}
 snapshot(ctx=this.context()){return {goal:this.goals.current(ctx),lastCompletedGoal:this.goals.getLastCompleted(ctx),goalStatuses:['active','paused','blocked','usage_limited','complete'],goals:this.goals.list(ctx),tasks:this.tasks.list(ctx),jobs:this.jobs.list(ctx),pendingWakes:this.coordinator?.pending()||[],activeTools:this.activeTools(),unknownActivities:this.unknownActivities()};}
 hasCurrentWake(){return this.bound()&&[...(this.activeWake?[this.activeWake]:[]),...this.coordinator!.pending()].some(frame=>frame.generation===this.generation()&&this.eligible(frame,this.currentGoal(),frame===this.activeWake));}
 extension():ExtensionFactory{return pi=>{
  this.pi=pi;
  pi.on('session_start',(_event,ctx)=>{const reloading=!!this.coordinator,binding=++this.bindingEpoch;this.pi=pi;this.nativeContext=ctx;const context=makeContext(pi,ctx);if(!this.coordinator)this.coordinator=new ContinuationCoordinator(context.sessionId,this.dataDir);if(reloading)setImmediate(()=>{if(this.bound(binding))void this.drain();});});
  pi.on('before_agent_start',(_event,ctx)=>{this.nativeContext=ctx;const context=makeContext(pi,ctx),goal=this.goals.current(context);if(!goal)return;
   if(goal.status==='active'&&!this.hooks.planMode())this.goals.admit(context);
   return {systemPrompt:`${_event.systemPrompt}\n当前目标 ${goal.id}（${goal.status}）：${goal.objective}\n进度：${goal.progress}\n下一步：${goal.nextAction}\n仅当用户明确要求创建长期目标时调用 create_goal；普通任务不得自动创建目标。get_goal 查询当前目标。只有主 Agent 可以更新当前目标。update_goal({status:"complete"}) 前由主 Agent 核对原始要求、实际成果和证据，不需另派审核者；还有必要工作时不得完成。只有用户明确要求暂停时才设置 paused。相同阻塞至少连续三轮且无法继续有效推进时才设置 blocked；一般测试失败、任务难度或未完成不算执行不可用。暂停、额度耗尽或阻塞状态不得自动续跑。Plan 模式只规划，禁止执行。用户排队消息优先。`};
  });
  for(const [name,description,parameters] of [
   ['create_goal','仅在用户明确要求创建长期目标时使用；不得从普通任务自行推断目标。仅设置 objective，不设令牌、时长或轮数预算。',Type.Object({objective:Type.String()})],
   ['get_goal','读取当前长期目标状态、进度与使用量。',Type.Object({})],
   ['update_goal','仅由主 Agent 更新当前目标。complete 需要主 Agent 核实全部原始要求和实际证据；paused 仅用于用户明确要求暂停；blocked 需要相同阻塞连续至少三轮且无法有效推进。',Type.Object({status:Type.Union([Type.Literal('complete'),Type.Literal('blocked'),Type.Literal('paused')])})],
  ] as const)pi.registerTool({name,label:name,description,parameters,execute:async(_id,params,_signal,_update,ctx)=>{this.nativeContext=ctx;const input=object(params);const result=await this.dispatch(name==='create_goal'?'goal.create':name==='get_goal'?'goal.get':'goal.update',name==='create_goal'?{...input,userRequested:true}:input,makeContext(pi,ctx,'agent',_id));return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const off=pi.events.on('friend-pi:v1:request',raw=>{
   if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.v!==1||request.plugin!=='runtime')return;
   void(async()=>{try{const ctx=this.context(request.origin==='user'?'user':'plugin');const result=await this.dispatch(text(request.action),object(request.input||{}),ctx);pi.events.emit('friend-pi:v1:response',{id:request.id,result});}catch(error){pi.events.emit('friend-pi:v1:response',{id:request.id,...normalizeCapabilityError(error)});}})();
  });
  for(const [name,prefix,description] of [
   ['friend_task','task','步骤记录与验证。create input={title,logicalStepId?,mode:"read"|"write",acceptance:string[],checks:[{command,args:string[]}]}；start {id}；verify {id,result,sources?}会真正运行配置检查。失败最多两轮修复，不能以新步骤绕过阻塞。read/list查询。'],
   ['friend_jobs','jobs','后台普通命令，不能启动模型代理。run input={name,command,kind:"task"|"service",timeoutSeconds?,autoContinue?}。Agent发起有限任务默认结束后接续；services持续运行不占本轮状态。list/status/logs {id,maxBytes?}/kill {id}。不要反复查询等待。'],
  ] as const){
   pi.registerTool({name,label:description.split('。')[0],description,parameters:Type.Object({action:Type.String(),input:Type.Optional(Type.Record(Type.String(),Type.Unknown()))}),execute:async(_id,params,_signal,_update,ctx)=>{this.nativeContext=ctx;const result=await this.dispatch(`${prefix}.${params.action}`,params.input||{},makeContext(pi,ctx,'agent',_id));return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
   pi.registerCommand(prefix,{description,handler:async(args,ctx)=>{this.nativeContext=ctx;const split=args.indexOf(' '),action=args?(split<0?args:args.slice(0,split)):'list';const raw=split<0?'':args.slice(split+1);const result=await this.dispatch(`${prefix}.${action}`,raw.trim()?object(JSON.parse(raw)): {},makeContext(pi,ctx,'user'));ctx.ui.notify(JSON.stringify(result),'info');}});
  }
  pi.registerCommand('goal',{description:'设置或查看当前会话目标；pause / resume / clear 管理目标。',handler:async(args,ctx)=>{
   this.nativeContext=ctx;const value=args.trim(),split=value.indexOf(' '),verb=split<0?value:value.slice(0,split),rest=split<0?'':value.slice(split+1).trim();
   const aliases:Record<string,string>={get:'get',read:'get',status:'get',list:'list',pause:'pause',resume:'resume',clear:'clear',stop:'pause'};
   const action=!value?'goal.get':aliases[verb]?`goal.${aliases[verb]}`:'goal.set';
   const input=action==='goal.set'?{objective:value,status:'active'}:rest?object(JSON.parse(rest)):{};
   const result=await this.dispatch(action,input,makeContext(pi,ctx,'user'));ctx.ui.notify(JSON.stringify(result??null),'info');
  }});
  pi.on('session_shutdown',event=>{off();this.bindingEpoch++;this.nativeContext=undefined;this.pi=undefined;if(event.reason!=='reload'){this.disposed=true;}});
 };}
 async restore(){
  const ctx=this.context();this.jobs.recover(ctx);
  for(const row of this.store.list<Activity>(`activity:${ctx.sessionId}:`))if(row.value.status==='running')this.store.put(row.key,{...row.value,status:row.value.sideEffect?'unknown':'settled'});
  if(this.goals.restore(ctx,this.generation(),this.safeObjects())){const goal=this.goals.current(ctx)!;this.enqueue(`restore:${goal.id}:${goal.revision}`,`继续恢复的长期目标：${goal.objective}。检查原始成果与下一步，不重放已完成工具。`,{goalId:goal.id});}
 }
 beginTool(id:string,tool:string,input:unknown){
  const raw=input&&typeof input==='object'?input as JsonObject:{};const action=String(raw.action||'');
  if(['create_goal','get_goal','update_goal','friend_goal','friend_plan'].includes(tool)||tool.startsWith('friend_')&&(queries.has(action)||['role.assign','role.switch','update','create','submit'].includes(action)&&!['friend_swarm','friend_team','friend_jobs'].includes(tool)))return;
  const ctx=this.context();const sideEffect=['write','edit','bash'].includes(tool)||tool==='friend_jobs';this.store.put(`activity:${ctx.sessionId}:${id}`,{sessionId:ctx.sessionId,id,tool,sideEffect,status:'running',runId:ctx.runId} satisfies Activity);if(sideEffect)this.goals.noteWrite(ctx,id);this.goals.admit(ctx);
 }
 endTool(id:string){const ctx=this.context();const key=`activity:${ctx.sessionId}:${id}`,row=this.store.get<Activity>(key);if(row)this.store.put(key,{...row.value,status:'settled'});void this.drain();}
 account(tokens:number|undefined,eventId?:string,usageRunId=this.hooks.runId()){const ctx=this.context(),goal=this.goals.list(ctx).find(item=>item.sessionId===ctx.sessionId&&item.sourceRunId===usageRunId);if(!goal)return;if(eventId){const key=`usage:${ctx.sessionId}:${eventId}`;if(this.store.get(key))return;this.store.put(key,true,null);}this.goals.account(ctx,tokens,goal.id);}
 async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown>{
  if(action==='recovery.confirm'){if(ctx.origin!=='user'||input.confirmUnknown!==true)throw new Error('未知现场需用户检查后明确确认');const evidence=text(input.evidence,'检查说明',16000);for(const id of Array.isArray(input.activityIds)?input.activityIds:[]){const key=`activity:${ctx.sessionId}:${text(id)}`,row=this.store.get<Activity>(key);if(!row||row.value.status!=='unknown')throw new Error('未知活动版本已变化');this.store.put(key,{...row.value,status:'settled',recovery:{evidence,at:new Date().toISOString(),origin:'user'}});}for(const id of Array.isArray(input.jobIds)?input.jobIds:[])this.jobs.confirmUnknown(text(id),evidence,ctx);ctx.appendEntry('friend-pi.recovery.confirmed',{v:1,evidence,activityIds:input.activityIds,jobIds:input.jobIds});return this.snapshot(ctx);}
  const dot=action.indexOf('.'),area=action.slice(0,dot),operation=action.slice(dot+1);
  const read=queries.has(operation)||['get','repair.count'].includes(operation);
  if(ctx.policy?.planMode&&!read&&!(area==='goal'&&['create','set','get','clear','update','pause','stop'].includes(operation))&&!(area==='task'&&operation==='create'))throw new Error('计划模式只允许查询与草稿元数据，不能执行');
  if(area==='resource'||area==='budget')return this.capabilities.dispatch(action,input,ctx,this.goals.current(ctx));
  if(area==='jobs')return this.jobs.dispatch(operation,input,ctx,this.generation());
  if(area==='task'){
   const focused=this.goals.current(ctx),goal=focused&&focused.status==='active'?focused:undefined;
   if(operation==='identity')return this.tasks.resolveIdentity(input,ctx,goal?.id);
   if(ctx.origin==='agent'&&['start','verify','fail','resolveUnknown'].includes(operation)){const target=this.tasks.read(text(input.id),ctx);if(target.goalId?target.goalId!==goal?.id||goal.sourceRunId!==ctx.runId:target.runId!==ctx.runId)throw new Error('步骤不属于当前执行，不能修改其他任务');}
   if(operation==='repair.claimBatch')return this.tasks.claimRepairBatch(input,ctx,goal?.id);
   if(operation==='repair.claim')return this.tasks.claimRepair(input,ctx,goal?.id);
   if(operation==='create')return this.tasks.create(input,ctx,goal?.id);
   if(operation==='list'||operation==='snapshot')return this.tasks.list(ctx);
   if(operation==='read'||operation==='status')return this.tasks.read(text(input.id),ctx);
   if(operation==='resolveUnknown')return this.tasks.resolveUnknown(text(input.id),input,ctx);
   if(operation==='start')return this.tasks.start(text(input.id),ctx);
   if(operation==='verify'){const task=this.tasks.read(text(input.id),ctx);if(ctx.origin==='agent'&&ctx.policy?.tools.includes('friend_expert')){const role=object(await ctx.request('expert','role.read',{},1000)).role;if(role&&typeof role==='object'&&Array.isArray(object(role).effectiveWriteScopes)&&!(object(role).effectiveWriteScopes as unknown[]).length&&task.checks.length)throw new Error('只读角色只能确认无命令的读取成果；客观命令检查由实现/整合角色执行');}return this.tasks.verify(task.id,input,ctx,check=>this.jobs.check(check,ctx,this.generation()),goal?.writeEpoch||0);}
   if(operation==='fail')return this.tasks.fail(text(input.id),text(input.reason),ctx,input.unknown===true);
   throw new Error('未知步骤操作');
  }
  if(area==='goal'){
   const focused=this.goals.current(ctx),mutating=!['get','read','status','list','snapshot'].includes(operation);
   if(mutating&&input.goalId!==undefined&&input.goalId!==focused?.id)throw new CapabilityError('VERSION_CONFLICT','当前目标已变化，请重新读取后操作');
   if(mutating&&input.expectedRevision!==undefined&&input.expectedRevision!==focused?.revision)throw new CapabilityError('VERSION_CONFLICT','目标版本已变化，请重新读取后操作');
   if(ctx.origin==='agent'&&mutating&&operation!=='create'&&(!focused||focused.sourceRunId!==ctx.runId))throw new Error('目标不属于当前执行');
   if(ctx.origin==='agent'&&mutating&&this.turn){
    if(operation==='create'&&this.turn.goalEpoch!==this.goalEpoch)throw new CapabilityError('VERSION_CONFLICT','用户已改变目标控制，当前回合不能重新创建目标');
    if(operation!=='create'&&(this.turn.goalId!==focused?.id||this.turn.objective!==focused?.objective))throw new CapabilityError('VERSION_CONFLICT','目标已更新，请先用 get_goal 读取当前目标再核对成果');
   }
   if(operation==='create'||operation==='set'){
    const goal=operation==='set'?this.goals.set(input,ctx,this.generation()):this.goals.create(input,ctx,this.generation());
    this.cancelGoalWake(focused?.id);this.resetGoalStreak(goal.id,ctx);if(ctx.origin==='agent'&&this.turn){this.turn.goalId=goal.id;this.turn.objective=goal.objective;this.turn.goalEpoch=this.goalEpoch;}if(ctx.origin==='user'&&goal.status==='active')this.enqueue(`set:${goal.id}:${goal.revision}`,`推进用户设定的目标：${goal.objective}`,{goalId:goal.id});return goal;
   }
   if(operation==='list'||operation==='snapshot')return this.goals.list(ctx);
   if(['get','read','status'].includes(operation)){const result=input.id?this.goals.read(text(input.id),ctx):focused||null;if(ctx.origin==='agent'&&this.turn&&result?.id===focused?.id){this.turn.goalId=focused?.id;this.turn.objective=focused?.objective;}return result;}
   if(operation==='clear'){if(ctx.origin!=='user')throw new Error('仅用户可以清除目标');const result=this.goals.clear(ctx,input);this.cancelGoalWake(focused?.id);return result;}
   if(operation==='update'&&input.status===undefined){const continuation=input.continuation?object(input.continuation):undefined;if(continuation?.kind==='wait'&&(!focused||!this.knownWait(text(continuation.taskId,'等待对象'),focused,ctx)))throw new Error('等待对象必须是当前目标已知且未结束的实际执行对象');return this.goals.update(input,ctx);}
   const status=operation==='update'?String(input.status):operation;
   if(status==='pause'||status==='paused'||status==='stop'||status==='blocked'){
    const goal=this.goals.setState(status==='blocked'?'blocked':'paused',ctx,typeof input.reason==='string'?input.reason:status==='blocked'?'主 Agent 报告持续阻塞':'用户要求暂停目标',input);this.cancelGoalWake(focused?.id);return goal;
   }
   if(operation==='resume'){if(this.unknownActivities().length||this.jobs.hasUnknown(ctx))throw new Error('请先检查并确认未知现场，再接续目标');const goal=this.goals.resume(input,ctx,this.generation());this.cancelGoalWake(focused?.id);this.resetGoalStreak(goal.id,ctx);this.enqueue(`resume:${goal.id}:${goal.revision}`,`继续目标：${goal.objective}。依据现有成果推进。`,{goalId:goal.id});return goal;}
   if(operation==='accept')return this.goals.accept(input,ctx,this.tasks,this.safeObjects());
   if(status==='complete'){
    const result=await this.goals.finish(ctx,this.tasks,async()=>({approved:true,findings:'主 Agent 完成核对'}),this.safeObjects(),input);this.cancelGoalWake(focused?.id);return result;
   }
   throw new Error('未知目标操作');
  }
  if(action==='snapshot')return this.snapshot(ctx);
  throw new Error('未知宿主能力');
 }
 settled(outcome='completed'){
  const ctx=this.context(),current=this.goals.current(ctx),turn=this.turn;this.turn=undefined;
  if(current?.status==='active'){
   if(['usage_limited','quota_exceeded','rate_limit_exceeded'].includes(outcome)){this.goals.setState('usage_limited',ctx,'模型提供方使用额度暂不可用');this.cancelGoalWake(current.id);}
   else if(['stopped','interrupted'].includes(outcome)){this.goals.setState('paused',ctx,'用户停止当前执行');this.cancelGoalWake(current.id);}
   else if(turn?.goalId===current.id){
    const key=`turn-streak:${ctx.sessionId}:${current.id}`,prior=this.store.get<{blank:number;unavailable:number}>(key)?.value||{blank:0,unavailable:0};
    const blank=turn.automatic&&!turn.success&&!turn.unavailable&&!turn.response?prior.blank+1:0;
    const unavailable=turn.unavailable&&!turn.success?prior.unavailable+1:0;
    this.store.put(key,{blank,unavailable});
    if(blank>=3||unavailable>=3){this.goals.setState('blocked',ctx,blank>=3?'连续三次自动回合无正文、推理、问题或成功工具结果':'连续三轮执行环境不可用，且没有成功工具结果');this.cancelGoalWake(current.id);}
   }
  }
  if(current?.status==='active'&&current.waitFor&&!this.knownWait(current.waitFor,current,ctx))this.goals.update({},ctx);
  const safe=this.safeObjects();this.goals.checkpoint(ctx,safe);const goal=this.goals.current(ctx);
  if(goal?.status==='active'&&!goal.waitFor&&safe&&!this.hooks.planMode()&&!this.hasCurrentWake())this.enqueue(`goal:${goal.id}:${goal.revision}:${this.generation()}`,`继续长期目标：${goal.objective}\n已保存进度：${goal.progress}\n下一步：${goal.nextAction}。先检查已有成果，完成则用 update_goal({status:"complete"})；不要重复执行。`,{goalId:goal.id});
  this.hooks.publish('runtime',this.snapshot(ctx));void this.drain();
 }
 private knownWait(id:string,goal:GoalRecord,ctx:PluginContext){
  const handle=this.waitHandles.get(id);if(handle?.active&&handle.goalId===goal.id&&handle.runId===goal.sourceRunId)return true;
  if(this.tasks.list(ctx,goal.id).some(task=>[task.id,task.logicalStepId].includes(id)&&['running','pending','repair'].includes(task.status)))return true;
  return this.jobs.list(ctx).some(job=>job.id===id&&job.kind==='task'&&job.status==='running'&&(job.goalId?job.goalId===goal.id:job.runId===goal.sourceRunId));
 }
 private jobFinished(job:ProcessJob){
  if(!this.bound())return;
  // User-created finite jobs can release a queue without requesting a model wake.
  setImmediate(()=>void this.drain());
  if(job.notify)this.hooks.publish('notice',{message:`后台任务“${job.name}”${job.status==='completed'?'已完成':job.status==='killed'?'已停止':'失败'}`,level:job.status==='failed'?'error':'info'});
  if(!job.autoContinue||job.generation!==this.generation())return;
  const goal=this.currentGoal();if(job.goalId&&goal?.id!==job.goalId||goal&&!job.goalId&&goal.sourceRunId!==job.runId)return;if(goal&&goal.status!=='active')return;
  if(goal?.waitFor===job.id)this.goals.update({progress:`后台任务 ${job.name}：${job.status}`,nextAction:goal.nextAction},this.context());
  this.enqueue(`job:${job.id}:${job.status}`,`后台任务 ${job.name}（${job.id}）${job.status}，请读取日志并处理结果，勿无依据重跑。`,{generation:job.generation,runId:job.runId,goalId:goal?.id});
 }
 teamResult(data:JsonObject){if(!this.bound())return;const id=String(data.attemptId||data.graphId);if(this.wakeEvents.has(id))return;const owner=this.store.get<{generation:number;runId?:string;goalId?:string}>(`attempt-owner:${this.nativeContext?.sessionManager.getSessionId()}:${id}`)?.value;if(!owner||owner.generation!==this.generation()||owner.runId!==data.runId)return;this.wakeEvents.add(id);this.enqueue(`team:${id}`,`Team 成员成果已返回。请用 friend_team result 查询实际成果；写入仍需检查、独立复核并由主 Agent 决定整合。`,{generation:owner.generation,runId:owner.runId,goalId:owner.goalId});}
 observeSwarm(data:JsonObject,modelGraphs?:ReadonlySet<string>){
  if(!this.bound())return;
  const ctx=this.context(),goal=this.goals.current(ctx);for(const graph of Array.isArray(data.graphs)?data.graphs.map(object):[]){if(graph.sessionId!==ctx.sessionId||graph.audit===true)continue;
   const id=String(graph.id),previous=this.swarmStatuses.get(id);this.swarmStatuses.set(id,String(graph.status));
   for(const attempt of Array.isArray(graph.attempts)?graph.attempts.map(object):[]){const key=`attempt-owner:${ctx.sessionId}:${String(attempt.id)}`;if(!this.store.get(key)&&attempt.status==='running')this.store.put(key,{generation:this.generation(),runId:graph.runId,goalId:goal?.id});}
   if(graph.goalId===undefined&&(!goal||goal.status!=='active')&&modelGraphs?.has(id)&&graph.runId===ctx.runId&&this.hooks.mode()==='swarm'&&!this.hooks.planMode()&&graph.status==='integrated'&&previous&&['running','awaiting_review','ready'].includes(previous)&&Array.isArray(graph.tasks)&&graph.tasks.length>0&&graph.tasks.every(task=>object(task).mode==='read')){
    const version=digest(graph.tasks.map(task=>{const t=object(task);return[t.id,t.currentAttempt,t.resultRevision];})),generation=this.generation();
    this.enqueue(`swarm-result:${id}:${generation}:${version}`,`只读 Swarm 任务图 ${id} 已整合。本条是原用户请求的成果回传，不是新的任务。请用 friend_swarm snapshot 读取当前实际成果及必要的完整交接，按原用户要求的语言与格式直接交付结论和必要来源。核对成员陈述的依据；发现影响结论的具体矛盾时再回源验证，不能从片段推断全文。省略未要求的统计、阅读过程与图状态。不重建任务、不重跑成员，不再询问是否继续已授权的汇总。`,{generation,runId:ctx.runId});
   }
   if(!goal||graph.audit===true||graph.sessionId!==ctx.sessionId||(graph.goalId!==undefined?graph.goalId!==goal.id:graph.runId!==goal.sourceRunId))continue;
   const activeGraph=['running','awaiting_review','ready','pending'].includes(String(graph.status));this.waitHandles.set(id,{goalId:goal.id,runId:String(graph.runId||''),active:activeGraph});
   for(const task of Array.isArray(graph.tasks)?graph.tasks.map(object):[])for(const handle of [task.id,task.logicalStepId,task.currentAttempt])if(handle)this.waitHandles.set(String(handle),{goalId:goal.id,runId:String(graph.runId||''),active:activeGraph&&!['completed','skipped','blocked','cancelled','unknown'].includes(String(task.status))});
   if(Array.isArray(graph.attempts))for(const attempt of graph.attempts.map(object))if(attempt.mode==='write')this.goals.noteWrite(ctx,`member:${String(attempt.id)}`);this.tasks.syncExecution(graph,ctx,goal.id,this.goals.current(ctx)?.writeEpoch||0);
   if(graph.status==='integrated'&&previous&&['running','awaiting_review','ready'].includes(previous)){
    const generation=this.generation(),binding=this.bindingEpoch;
    // The host updates its busy flags after this observer. Admit only after that stack settles.
    setImmediate(()=>{
     if(!this.bound(binding)||generation!==this.generation())return;
     const current=this.currentGoal(),native=this.context();
     if(!current||current.id!==goal.id||current.generation!==generation||current.status!=='active'||graph.runId!==current.sourceRunId||native.runId!==current.sourceRunId)return;
     const tasks=(Array.isArray(graph.tasks)?graph.tasks:[]).map(object),waitIds=new Set([id,...tasks.flatMap(task=>[String(task.id),String(task.logicalStepId||`${id}:${task.id}`)])]);
     for(const task of this.tasks.list(native,current.id))if(waitIds.has(task.logicalStepId))waitIds.add(task.id);
     if(current.waitFor&&!waitIds.has(current.waitFor))return;
     if(current.waitFor)this.goals.update({},native);
     const version=digest({integration:graph.integration,tasks:tasks.map(task=>[task.id,task.currentAttempt,task.resultRevision])});
     this.enqueue(`swarm:${current.id}:${id}:${generation}:${version}`,`Swarm 任务图 ${id} 已整合。请用 friend_swarm snapshot 读取实际成果及合同要求的检查、复核记录，继续目标的验证与收尾；不要重放已完成成员，不把未要求或未执行的检查、复核当作通过。`,{generation,runId:current.sourceRunId,goalId:current.id});
    });
   }
  }
 }
 enqueue(id:string,message:string,options:{generation?:number;runId?:string;goalId?:string;goalRevision?:number}={}){const goal=this.currentGoal();if(options.goalId&&(!goal||goal.id!==options.goalId||goal.status!=='active'))return false;const added=this.coordinator?.enqueue(id,message,{...options,...(options.goalId?{goalRevision:options.goalRevision??goal?.revision,runId:options.runId??goal?.sourceRunId}:{})})||false;if(added)void this.drain();return added;}
 private bound(epoch=this.bindingEpoch){return !this.disposed&&epoch===this.bindingEpoch&&!!this.pi&&!!this.nativeContext&&!!this.coordinator;}
 async drain(){
  // Pi invalidates extension contexts during quit/reload. Even querying a stale
  // sessionManager throws, so test the binding before touching context or stores.
  if(this.draining||!this.bound()||!this.nativeContext!.isIdle())return;
  if(!this.safeObjects())return;
  const binding=this.bindingEpoch;this.draining=true;let goalEpoch=this.goalEpoch,admitted:WakeFrame|undefined,sending=false;
  try{
   const userInput=await this.hooks.admitUserInput?.();if(!this.bound(binding)||userInput||this.hooks.planMode())return;
   const goal=this.currentGoal(),frame=this.coordinator!.take(item=>this.eligible(item,goal,false));if(frame?.goalId){frame.goalRevision=goal?.revision;this.admittedGoalEpochs.set(frame,this.goalEpoch);}goalEpoch=this.goalEpoch;admitted=frame;this.activeWake=frame;if(!frame)return;
   await this.hooks.prepareWake(frame);
   if(!this.bound(binding)||frame.goalId&&goalEpoch!==this.goalEpoch)return;
   const queued=await this.hooks.admitUserInput?.();
   if(!this.bound(binding)||queued||frame.goalId&&goalEpoch!==this.goalEpoch||!this.safeObjects()||frame.generation!==this.generation()||!this.eligible(frame,this.currentGoal())||this.hooks.planMode()||!this.nativeContext!.isIdle())return;
   sending=true;if(this.hooks.sendWake)await this.hooks.sendWake(frame);else this.pi!.sendMessage({customType:'friend-pi.goal-wake',content:frame.message,display:false,details:{eventId:frame.id,generation:frame.generation,goalId:frame.goalId,goalRevision:frame.goalRevision}},{triggerTurn:true,deliverAs:'followUp'});
  }catch(error){
   if(this.bound(binding)&&admitted?.generation===this.generation()&&(!admitted.goalId||goalEpoch===this.goalEpoch)&&this.eligible(admitted,this.currentGoal())){if(admitted.goalId){this.beginTurn({automatic:true});this.recordGoalToolOutcome({success:false,executionUnavailable:true});this.settled('failed');}this.hooks.publish('notice',{level:'error',message:String(error)});}
  }finally{
   this.draining=false;this.activeWake=undefined;
   if(this.bound()&&admitted)this.hooks.publish('runtime',this.snapshot());
   // Only an unsent wake can return to the queue after a reload. Once sending
   // begins its outcome may be unknown, and replay would risk a duplicate turn.
   if(!this.disposed&&binding!==this.bindingEpoch&&admitted&&!sending&&(!admitted.goalId||goalEpoch===this.goalEpoch))this.coordinator?.defer(admitted);
   if(this.bound()&&(admitted||binding!==this.bindingEpoch)&&this.coordinator!.pending().some(frame=>frame.generation===this.generation()&&this.eligible(frame,this.currentGoal(),false))&&this.nativeContext!.isIdle()&&!this.hooks.planMode()&&this.safeObjects())setImmediate(()=>void this.drain());
  }
 }
 isWakeCurrent(frame:WakeFrame){return this.bound()&&frame.generation===this.generation()&&(!frame.goalId||this.admittedGoalEpochs.get(frame)===undefined||this.admittedGoalEpochs.get(frame)===this.goalEpoch)&&this.eligible(frame,this.currentGoal());}
 private eligible(frame:WakeFrame,goal:GoalRecord|undefined,checkRevision=true){if(frame.goalId)return goal?.id===frame.goalId&&goal.status==='active'&&(!checkRevision||frame.goalRevision===undefined||frame.goalRevision===goal.revision)&&(!frame.runId||frame.runId===goal.sourceRunId)&&(!frame.runId||frame.runId===this.hooks.runId());return !frame.runId||frame.runId===this.hooks.runId();}
 async stop(){this.coordinator?.invalidate();this.goalEpoch++;const ctx=this.context();this.goals.setState('paused',ctx,'用户停止当前任务');this.tasks.stop(ctx);await this.jobs.stopRun(ctx,ctx.runId);}

 beforeQuit(){const ctx=this.context();this.goals.checkpoint(ctx,this.nativeContext?.isIdle()===true&&this.safeObjects());}
 dispose(){this.disposed=true;this.bindingEpoch++;this.nativeContext=undefined;this.pi=undefined;this.jobs.dispose();this.capabilities.dispose();this.goals.dispose();this.tasks.dispose();this.coordinator?.dispose();this.store.close();}
}
