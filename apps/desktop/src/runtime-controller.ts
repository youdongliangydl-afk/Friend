import {Type} from 'typebox';
import {RecordStore,RuntimeCapabilityServices,normalizeCapabilityError,ContinuationCoordinator,TaskLedger,GoalLedger,makeContext,object,text,digest,type PluginContext,type JsonObject,type GoalRecord,type ExecutionMode,type WakeFrame} from '@friend-pi/core';
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
 private disposed=false;private draining=false;private bindingEpoch=0;private checkpointSerial=0;private readonly wakeEvents=new Set<string>();
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
 suspendForQueuedInput(){const ctx=this.context(),goal=this.currentGoal();if(!goal||!['active','waiting'].includes(goal.status))return undefined;if(!this.safeObjects())throw new Error('原目标尚未收敛');this.coordinator?.invalidate();const paused=this.goals.setState('paused',ctx,'处理用户排队消息，完成后自动恢复')!;this.goals.store.remove(`focus:${ctx.sessionId}`);return {id:paused.id,revision:paused.revision,sourceRunId:paused.sourceRunId,objective:paused.objective};}
 activeTools(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.store.list<Activity>(`activity:${session}:`).map(row=>row.value).filter(row=>row.status==='running'):[];}
 safeObjects(){return !this.hooks.busy()&&!this.activeTools().length&&!this.jobs.hasFinite(this.context())&&!this.jobs.hasUnknown(this.context())&&!this.store.list<Activity>(`activity:${this.context().sessionId}:`).some(row=>row.value.status==='unknown'&&row.value.sideEffect);}
 unsettledJobs(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.jobs.store.list<ProcessJob>('job:').map(row=>row.value).filter(job=>job.sessionId===session&&(job.status==='unknown'||job.kind==='task'&&job.status==='running')):[];}
 unknownActivities(){const session=this.nativeContext?.sessionManager.getSessionId();return session?this.store.list<Activity>(`activity:${session}:`).map(row=>row.value).filter(row=>row.status==='unknown'&&row.sideEffect):[];}
 snapshot(ctx=this.context()){return {goal:this.goals.current(ctx),goals:this.goals.list(ctx),tasks:this.tasks.list(ctx),jobs:this.jobs.list(ctx),pendingWakes:this.coordinator?.pending()||[],activeTools:this.activeTools(),unknownActivities:this.unknownActivities()};}
 extension():ExtensionFactory{return pi=>{
  this.pi=pi;
  pi.on('session_start',(_event,ctx)=>{const reloading=!!this.coordinator,binding=++this.bindingEpoch;this.pi=pi;this.nativeContext=ctx;const context=makeContext(pi,ctx);if(!this.coordinator)this.coordinator=new ContinuationCoordinator(context.sessionId,this.dataDir);if(reloading)setImmediate(()=>{if(this.bound(binding))void this.drain();});});
  pi.on('before_agent_start',(_event,ctx)=>{this.nativeContext=ctx;const goal=this.goals.current(makeContext(pi,ctx));if(!goal||!['active','waiting'].includes(goal.status))return;
   this.goals.admit(makeContext(pi,ctx));return {systemPrompt:`${_event.systemPrompt}\n当前长期目标 ${goal.id}：${goal.objective}\n进度：${goal.progress}\n下一步：${goal.nextAction}\n沿用原任务范围与 ${goal.mode} 模式。用 friend_task 保存步骤与实际验证，friend_goal update 记录进度和下一步；完整完成才调用 complete。等待子任务时 update continuation={kind:"wait",taskId:"实际任务ID"}，不要轮询或重放已经完成的工具。检查失败两轮修复仍无效时报告阻塞。用户停止优先于目标续跑。`};
  });
  const off=pi.events.on('friend-pi:v1:request',raw=>{
   if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.v!==1||request.plugin!=='runtime')return;
   void(async()=>{try{const ctx=this.context(request.origin==='user'?'user':'plugin');const result=await this.dispatch(text(request.action),object(request.input||{}),ctx);pi.events.emit('friend-pi:v1:response',{id:request.id,result});}catch(error){pi.events.emit('friend-pi:v1:response',{id:request.id,...normalizeCapabilityError(error)});}})();
  });
  for(const [name,prefix,description] of [
   ['friend_goal','goal','长期目标。create input={objective,nextAction?,tokenBudget?}；Agent仅在当前已授权执行中可自设。update {progress,nextAction?,continuation?:{kind:"wait",taskId}}；read/list/pause/stop/resume/complete。写入完成需要实际客观检查；Team/Swarm最终独立审核；Single不另派审核Agent。默认无自动轮数上限。'],
   ['friend_task','task','步骤记录与验证。create input={title,logicalStepId?,mode:"read"|"write",acceptance:string[],checks:[{command,args:string[]}]}；start {id}；verify {id,result,sources?}会真正运行配置检查。失败最多两轮修复，不能以新步骤绕过阻塞。read/list查询。'],
   ['friend_jobs','jobs','后台普通命令，不能启动模型代理。run input={name,command,kind:"task"|"service",timeoutSeconds?,autoContinue?}。Agent发起有限任务默认结束后接续；services持续运行不占本轮状态。list/status/logs {id,maxBytes?}/kill {id}。不要反复查询等待。'],
  ] as const){
   pi.registerTool({name,label:description.split('。')[0],description,parameters:Type.Object({action:Type.String(),input:Type.Optional(Type.Record(Type.String(),Type.Unknown()))}),execute:async(_id,params,_signal,_update,ctx)=>{this.nativeContext=ctx;const result=await this.dispatch(`${prefix}.${params.action}`,params.input||{},makeContext(pi,ctx,'agent',_id));return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
   pi.registerCommand(prefix,{description,handler:async(args,ctx)=>{this.nativeContext=ctx;const split=args.indexOf(' '),action=args?(split<0?args:args.slice(0,split)):'list';const raw=split<0?'':args.slice(split+1);const result=await this.dispatch(`${prefix}.${action}`,raw.trim()?object(JSON.parse(raw)): {},makeContext(pi,ctx,'user'));ctx.ui.notify(JSON.stringify(result),'info');}});
  }
  pi.on('session_shutdown',event=>{off();this.bindingEpoch++;this.nativeContext=undefined;this.pi=undefined;if(event.reason!=='reload'){this.disposed=true;}});
 };}
 async restore(){
  const ctx=this.context();this.jobs.recover(ctx);
  for(const row of this.store.list<Activity>(`activity:${ctx.sessionId}:`))if(row.value.status==='running')this.store.put(row.key,{...row.value,status:row.value.sideEffect?'unknown':'settled'});
  if(this.goals.restore(ctx,this.generation(),this.safeObjects())){const goal=this.goals.current(ctx)!;this.enqueue(`restore:${goal.id}:${goal.revision}`,`继续恢复的长期目标：${goal.objective}。检查原始成果与下一步，不重放已完成工具。`,{goalId:goal.id});}
 }
 beginTool(id:string,tool:string,input:unknown){
  const raw=input&&typeof input==='object'?input as JsonObject:{};const action=String(raw.action||'');
  if(tool==='friend_goal'||tool==='friend_plan'||tool.startsWith('friend_')&&(queries.has(action)||['role.assign','role.switch','update','create','submit'].includes(action)&&!['friend_swarm','friend_team','friend_jobs'].includes(tool)))return;
  const ctx=this.context();const sideEffect=['write','edit','bash'].includes(tool)||tool==='friend_jobs';this.store.put(`activity:${ctx.sessionId}:${id}`,{sessionId:ctx.sessionId,id,tool,sideEffect,status:'running',runId:ctx.runId} satisfies Activity);if(sideEffect)this.goals.noteWrite(ctx,id);this.goals.admit(ctx);
 }
 endTool(id:string){const ctx=this.context();const key=`activity:${ctx.sessionId}:${id}`,row=this.store.get<Activity>(key);if(row)this.store.put(key,{...row.value,status:'settled'});void this.drain();}
 account(tokens:number|undefined,eventId?:string,usageRunId=this.hooks.runId()){const ctx=this.context(),goal=this.goals.list(ctx).find(item=>item.sessionId===ctx.sessionId&&item.sourceRunId===usageRunId);if(!goal)return;if(eventId){const key=`usage:${ctx.sessionId}:${eventId}`;if(this.store.get(key))return;this.store.put(key,true,null);}this.goals.account(ctx,tokens,goal.id);}
 async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown>{
  if(action==='recovery.confirm'){if(ctx.origin!=='user'||input.confirmUnknown!==true)throw new Error('未知现场需用户检查后明确确认');const evidence=text(input.evidence,'检查说明',16000);for(const id of Array.isArray(input.activityIds)?input.activityIds:[]){const key=`activity:${ctx.sessionId}:${text(id)}`,row=this.store.get<Activity>(key);if(!row||row.value.status!=='unknown')throw new Error('未知活动版本已变化');this.store.put(key,{...row.value,status:'settled',recovery:{evidence,at:new Date().toISOString(),origin:'user'}});}for(const id of Array.isArray(input.jobIds)?input.jobIds:[])this.jobs.confirmUnknown(text(id),evidence,ctx);ctx.appendEntry('friend-pi.recovery.confirmed',{v:1,evidence,activityIds:input.activityIds,jobIds:input.jobIds});return this.snapshot(ctx);}
  const dot=action.indexOf('.'),area=action.slice(0,dot),operation=action.slice(dot+1);
  const read=queries.has(operation)||['repair.count'].includes(operation);
  if(ctx.policy?.planMode&&!read&&!(area==='goal'&&['create','update','pause','stop'].includes(operation))&&!(area==='task'&&operation==='create'))throw new Error('计划模式只允许查询与草稿元数据，不能执行');
  if(area==='resource'||area==='budget')return this.capabilities.dispatch(action,input,ctx,this.goals.current(ctx));
  if(area==='jobs')return this.jobs.dispatch(operation,input,ctx,this.generation());
  if(area==='task'){
   const focused=this.goals.current(ctx),goal=focused&&['active','waiting','verifying'].includes(focused.status)?focused:undefined;
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
   if(operation==='create'){const goal=this.goals.create(input,ctx,this.generation());if(ctx.origin==='user'&&goal.status==='active')this.enqueue(`create:${goal.id}`,`推进用户设定的目标：${goal.objective}`,{goalId:goal.id});return goal;}
   if(operation==='list'||operation==='snapshot')return this.goals.list(ctx);
   if(operation==='read'||operation==='status')return input.id?this.goals.read(text(input.id),ctx):this.goals.current(ctx)||null;
   if(operation==='update'){if(ctx.origin==='agent'){const focused=this.goals.current(ctx);if(!focused||focused.sourceRunId!==ctx.runId||input.goalId&&input.goalId!==focused.id)throw new Error('目标不属于当前执行');}return this.goals.update(input,ctx);}
   if(operation==='pause'||operation==='stop'){this.coordinator?.invalidate();this.goals.setState(operation==='pause'?'paused':'stopped',ctx,typeof input.reason==='string'?input.reason:'显式停止');this.tasks.stop(ctx);await this.jobs.stopRun(ctx,ctx.runId);await this.hooks.haltExecution?.(ctx.origin);return this.snapshot(ctx);}
   if(operation==='resume'){if(this.unknownActivities().length||this.jobs.hasUnknown(ctx))throw new Error('请先检查并确认未知现场，再接续目标');this.coordinator?.invalidate();const goal=this.goals.resume(input,ctx,this.generation());this.enqueue(`resume:${goal.id}:${goal.revision}`,`继续目标：${goal.objective}。依据现有成果推进。`,{goalId:goal.id});return goal;}
   if(operation==='accept')return this.goals.accept(input,ctx,this.tasks,this.safeObjects());
   if(operation==='complete')return this.goals.finish(ctx,this.tasks,goal=>this.auditGoal(goal,ctx),this.safeObjects());
   throw new Error('未知目标操作');
  }
  if(action==='snapshot')return this.snapshot(ctx);
  throw new Error('未知宿主能力');
 }
 private async auditGoal(goal:GoalRecord,ctx:PluginContext){const result=object(await ctx.request('swarm','audit',{goalId:goal.id,objective:goal.objective,evidence:{progress:goal.progress,tasks:this.tasks.list(ctx,goal.id)},modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel},120000));return {...result,approved:result.approved===true&&result.independent===true&&!!result.source,findings:String(result.findings||'独立审核没有结论')};}
 settled(outcome='completed'){
  const ctx=this.context();if(['failed','stopped','interrupted'].includes(outcome)){const goal=this.goals.current(ctx);if(goal&&['active','waiting'].includes(goal.status))this.goals.setState('paused',ctx,'模型或执行未正常完成，请检查后显式接续');this.hooks.publish('runtime',this.snapshot(ctx));return;}const current=this.goals.current(ctx);const blocked=this.tasks.list(ctx,current?.id).filter(task=>current||task.runId===ctx.runId).find(task=>task.status==='blocked'||task.status==='unknown');if(blocked){this.goals.setState('blocked',ctx,blocked.error||'步骤阻塞');this.hooks.publish('runtime',this.snapshot(ctx));return;}
  const safe=this.safeObjects();this.goals.checkpoint(ctx,safe);const goal=this.goals.current(ctx);
  if(goal?.status==='active'&&safe&&!this.hooks.planMode())this.enqueue(`goal:${goal.id}:${goal.revision}:${this.generation()}`,`继续长期目标：${goal.objective}\n已保存进度：${goal.progress}\n下一步：${goal.nextAction}。先检查已有成果，完成则用 friend_goal complete；不要重复执行。`,{goalId:goal.id});
  this.hooks.publish('runtime',this.snapshot(ctx));void this.drain();
 }
 private jobFinished(job:ProcessJob){
  if(!this.bound())return;
  // User-created finite jobs can release a queue without requesting a model wake.
  setImmediate(()=>void this.drain());
  if(job.notify)this.hooks.publish('notice',{message:`后台任务“${job.name}”${job.status==='completed'?'已完成':job.status==='killed'?'已停止':'失败'}`,level:job.status==='failed'?'error':'info'});
  if(!job.autoContinue||job.generation!==this.generation())return;
  const goal=this.currentGoal();if(job.goalId&&goal?.id!==job.goalId||goal&&!job.goalId&&goal.sourceRunId!==job.runId)return;if(goal&&['paused','stopped','blocked','completed'].includes(goal.status))return;
  if(goal?.waitFor===job.id)this.goals.update({progress:`后台任务 ${job.name}：${job.status}`,nextAction:goal.nextAction},this.context());
  this.enqueue(`job:${job.id}:${job.status}`,`后台任务 ${job.name}（${job.id}）${job.status}，请读取日志并处理结果，勿无依据重跑。`,{generation:job.generation,runId:job.runId,goalId:goal?.id});
 }
 teamResult(data:JsonObject){if(!this.bound())return;const id=String(data.attemptId||data.graphId);if(this.wakeEvents.has(id))return;const owner=this.store.get<{generation:number;runId?:string;goalId?:string}>(`attempt-owner:${this.nativeContext?.sessionManager.getSessionId()}:${id}`)?.value;if(!owner||owner.generation!==this.generation()||owner.runId!==data.runId)return;this.wakeEvents.add(id);this.enqueue(`team:${id}`,`Team 成员成果已返回。请用 friend_team result 查询实际成果；写入仍需检查、独立复核并由主 Agent 决定整合。`,{generation:owner.generation,runId:owner.runId,goalId:owner.goalId});}
 observeSwarm(data:JsonObject){
  if(!this.bound())return;
  const ctx=this.context(),goal=this.goals.current(ctx);for(const graph of Array.isArray(data.graphs)?data.graphs.map(object):[]){if(graph.sessionId!==ctx.sessionId||graph.audit===true)continue;
   const id=String(graph.id),previous=this.swarmStatuses.get(id);this.swarmStatuses.set(id,String(graph.status));
   for(const attempt of Array.isArray(graph.attempts)?graph.attempts.map(object):[]){const key=`attempt-owner:${ctx.sessionId}:${String(attempt.id)}`;if(!this.store.get(key)&&attempt.status==='running')this.store.put(key,{generation:this.generation(),runId:graph.runId,goalId:goal?.id});}
   if(!goal||graph.audit===true||graph.sessionId!==ctx.sessionId||(graph.goalId!==undefined?graph.goalId!==goal.id:graph.runId!==goal.sourceRunId))continue;
   if(Array.isArray(graph.attempts))for(const attempt of graph.attempts.map(object))if(attempt.mode==='write')this.goals.noteWrite(ctx,`member:${String(attempt.id)}`);this.tasks.syncExecution(graph,ctx,goal.id,this.goals.current(ctx)?.writeEpoch||0);
   if(graph.status==='integrated'&&previous&&['running','awaiting_review','ready'].includes(previous)){
    const generation=this.generation(),binding=this.bindingEpoch;
    // The host updates its busy flags after this observer. Admit only after that stack settles.
    setImmediate(()=>{
     if(!this.bound(binding)||generation!==this.generation())return;
     const current=this.currentGoal(),native=this.context();
     if(!current||current.id!==goal.id||current.generation!==generation||!['active','waiting'].includes(current.status)||graph.runId!==current.sourceRunId||native.runId!==current.sourceRunId)return;
     const tasks=(Array.isArray(graph.tasks)?graph.tasks:[]).map(object),waitIds=new Set([id,...tasks.flatMap(task=>[String(task.id),String(task.logicalStepId||`${id}:${task.id}`)])]);
     for(const task of this.tasks.list(native,current.id))if(waitIds.has(task.logicalStepId))waitIds.add(task.id);
     if(current.status==='waiting'&&!waitIds.has(String(current.waitFor)))return;
     if(current.tokenBudget!==undefined&&(!current.usageAvailable||current.tokens>=current.tokenBudget))return;
     if(current.status==='waiting')this.goals.update({progress:current.progress,nextAction:current.nextAction},native);
     const version=digest({integration:graph.integration,tasks:tasks.map(task=>[task.id,task.currentAttempt,task.resultRevision])});
     this.enqueue(`swarm:${current.id}:${id}:${generation}:${version}`,`Swarm 任务图 ${id} 已通过检查与独立复核并整合。请用 friend_swarm snapshot 读取实际成果，继续目标的验证与收尾；不要重放已完成成员。`,{generation,runId:current.sourceRunId,goalId:current.id});
    });
   }
  }
 }
 enqueue(id:string,message:string,options:{generation?:number;runId?:string;goalId?:string}={}){const added=this.coordinator?.enqueue(id,message,options)||false;if(added)void this.drain();return added;}
 private bound(epoch=this.bindingEpoch){return !this.disposed&&epoch===this.bindingEpoch&&!!this.pi&&!!this.nativeContext&&!!this.coordinator;}
 async drain(){
  // Pi invalidates extension contexts during quit/reload. Even querying a stale
  // sessionManager throws, so test the binding before touching context or stores.
  if(this.draining||!this.bound()||!this.nativeContext!.isIdle())return;
  if(this.unknownActivities().length||this.jobs.hasUnknown(this.context()))return;
  const binding=this.bindingEpoch;this.draining=true;let admitted:WakeFrame|undefined,sending=false;
  try{
   const userInput=await this.hooks.admitUserInput?.();if(!this.bound(binding)||userInput||this.hooks.planMode())return;
   const goal=this.currentGoal(),frame=this.coordinator!.take(item=>this.eligible(item,goal));admitted=frame;if(!frame)return;
   await this.hooks.prepareWake(frame);
   if(!this.bound(binding)||frame.generation!==this.generation()||!this.eligible(frame,this.currentGoal())||this.hooks.planMode()||!this.nativeContext!.isIdle())return;
   sending=true;if(this.hooks.sendWake)await this.hooks.sendWake(frame);else this.pi!.sendMessage({customType:'friend-pi.runtime-wake',content:frame.message,display:true,details:{eventId:frame.id,generation:frame.generation}},{triggerTurn:true,deliverAs:'followUp'});
  }catch(error){
   if(this.bound(binding)&&admitted?.generation===this.generation()&&this.eligible(admitted,this.currentGoal())){this.goals.setState('paused',this.context(),String(error));this.hooks.publish('notice',{level:'error',message:String(error)});}
  }finally{
   this.draining=false;
   // Only an unsent wake can return to the queue after a reload. Once sending
   // begins its outcome may be unknown, and replay would risk a duplicate turn.
   if(!this.disposed&&binding!==this.bindingEpoch&&admitted&&!sending)this.coordinator?.defer(admitted);
   if(this.bound()&&(admitted||binding!==this.bindingEpoch)&&this.coordinator!.pending().some(frame=>frame.generation===this.generation()&&this.eligible(frame,this.currentGoal()))&&this.nativeContext!.isIdle()&&!this.hooks.planMode())setImmediate(()=>void this.drain());
  }
 }
 private eligible(frame:WakeFrame,goal:GoalRecord|undefined){if(goal?.waitFor==='user-acceptance')return false;if(frame.goalId)return goal?.id===frame.goalId&&['active','waiting'].includes(goal.status);return !frame.runId||frame.runId===this.hooks.runId();}
 async stop(){this.coordinator?.invalidate();const ctx=this.context();this.goals.setState('stopped',ctx,'用户停止当前任务');this.tasks.stop(ctx);await this.jobs.stopRun(ctx,ctx.runId);}
 beforeQuit(){const ctx=this.context();this.goals.checkpoint(ctx,this.nativeContext?.isIdle()===true&&this.safeObjects());}
 dispose(){this.disposed=true;this.bindingEpoch++;this.nativeContext=undefined;this.pi=undefined;this.jobs.dispose();this.capabilities.dispose();this.goals.dispose();this.tasks.dispose();this.coordinator?.dispose();this.store.close();}
}
