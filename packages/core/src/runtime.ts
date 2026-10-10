import {existsSync,readFileSync} from 'node:fs';
import {projectCodeVersion} from './code-version.js';
import {randomUUID} from 'node:crypto';
import {CapabilityError,SourcePolicy,type CheckRef,RecordStore,digest,object,text,isSessionDeleted,type JsonObject,type PluginContext,type ExecutionMode} from './index.js';

const now=()=>new Date().toISOString();
export interface AcceptanceCheck {command:string;args:string[]}
export interface CheckEvidence {command:string;args:string[];exitCode:number|null;output:string;at:string;hash:string}
export interface TaskRecord {
 id:string;logicalStepId:string;goalId?:string;projectId:string;sessionId:string;runId?:string;title:string;
 mode:'read'|'write';status:'pending'|'running'|'repair'|'completed'|'blocked'|'unknown'|'stopped';
 acceptance:string[];checks:AcceptanceCheck[];evidence:CheckEvidence[];sources:unknown[];checkRefs?:CheckRef[];result?:string;
 repairCount:number;revision:number;createdAt:string;updatedAt:string;error?:string;verificationWriteEpoch?:number;verificationCodeVersion?:string;
}
export interface GoalRecord {
 id:string;projectId:string;sessionId:string;origin:'user'|'agent';sourceRunId?:string;objective:string;
 mode:ExecutionMode;status:'active'|'waiting'|'verifying'|'completed'|'paused'|'blocked'|'stopped';
 revision:number;progress:string;nextAction:string;waitFor?:string;tokenBudget?:number;tokens:number;
 usageAvailable:boolean;safeCheckpoint:boolean;checkpointRevision?:number;generation:number;
 modelId?:string;thinkingLevel?:string;createdAt:string;updatedAt:string;error?:string;audit?:unknown;writeObserved?:boolean;writeEpoch?:number;acceptance?:{binding:string;taskVersion:string;codeVersion:string;goalVersion:string;requestedAt:string};cachedAudit?:{binding:string;result:{approved:boolean;findings:string;[key:string]:unknown};sourceHash:string};
}
export interface WakeFrame {id:string;generation:number;runId?:string;goalId?:string;message:string;createdAt:string}

/** Durable delivery admission; a stop invalidates all previously captured wake frames. */
export class ContinuationCoordinator {
 readonly store:RecordStore;
 constructor(readonly sessionId:string,dataDir?:string){this.store=new RecordStore('runtime-wake',dataDir);}
 generation(){return this.store.get<number>(`generation:${this.sessionId}`)?.value||0;}
 invalidate(){const next=this.generation()+1;this.store.put(`generation:${this.sessionId}`,next);for(const row of this.store.list<WakeFrame>(`queue:${this.sessionId}:`))this.store.remove(row.key);return next;}
 enqueue(id:string,message:string,options:{generation?:number;runId?:string;goalId?:string}={}){
  const generation=options.generation??this.generation();if(generation!==this.generation())return false;
  const seen=`seen:${this.sessionId}:${id}`;if(this.store.get(seen))return false;
  this.store.transaction(()=>{this.store.put(seen,{generation,at:now()},null);this.store.put(`queue:${this.sessionId}:${id}`,{id,generation,runId:options.runId,goalId:options.goalId,message,createdAt:now()} satisfies WakeFrame,null);});return true;
 }
 take(eligible:(frame:WakeFrame)=>boolean){
  const pending=this.store.list<WakeFrame>(`queue:${this.sessionId}:`).sort((a,b)=>a.value.createdAt.localeCompare(b.value.createdAt));
  for(const row of pending){if(row.value.generation!==this.generation()){this.store.remove(row.key);continue;}if(!eligible(row.value))continue;this.store.remove(row.key);return row.value;}
  return undefined;
 }
 /** Return an admitted but unsent wake after extension reload, retaining dedup. */
 defer(frame:WakeFrame){
  const key=`queue:${this.sessionId}:${frame.id}`;
  if(frame.generation!==this.generation()||!this.store.get(`seen:${this.sessionId}:${frame.id}`)||this.store.get(key))return false;
  this.store.put(key,frame,null);return true;
 }
 pending(){return this.store.list<WakeFrame>(`queue:${this.sessionId}:`).map(row=>row.value);}
 dispose(){this.store.close();}
}

export class TaskLedger {
 readonly store:RecordStore;
 constructor(dataDir?:string){this.store=new RecordStore('task-journal',dataDir);}
 private key(ctx:PluginContext,id:string){return `task:${ctx.projectId}:${id}`;}
 list(ctx:PluginContext,goalId?:string){return this.store.list<TaskRecord>(`task:${ctx.projectId}:`).map(row=>row.value).filter(task=>goalId?task.goalId===goalId:task.sessionId===ctx.sessionId);}
 read(id:string,ctx:PluginContext){const row=this.store.get<TaskRecord>(this.key(ctx,id));if(!row||row.value.sessionId!==ctx.sessionId)throw new Error('步骤不属于当前会话');return row.value;}
 private put(task:TaskRecord,ctx:PluginContext){task={...task,revision:task.revision+1,updatedAt:now()};this.store.put(this.key(ctx,task.id),task);this.store.afterCommit(()=>{ctx.emit('task.changed',task);ctx.appendEntry('friend-pi.task.receipt',{taskId:task.id,revision:task.revision,status:task.status,evidence:task.evidence.map(item=>({hash:item.hash,exitCode:item.exitCode}))});});return task;}
 resolveIdentity(input:JsonObject,ctx:PluginContext,goalId?:string){
  const identity=digest({title:text(input.title,'步骤',4000),mode:input.mode==='write'?'write':'read',checks:input.checks||[],acceptance:input.acceptance||[]}),alias=`step-identity:${ctx.projectId}:${goalId||ctx.runId||ctx.sessionId}:${identity}`;
  return this.store.transaction(()=>{const old=this.store.get<string>(alias)?.value;if(old)return {logicalStepId:old};const logicalStepId=typeof input.logicalStepId==='string'?text(input.logicalStepId):identity;this.store.put(alias,logicalStepId,null);return {logicalStepId};});
 }
 create(input:JsonObject,ctx:PluginContext,goalId?:string){
  const id=randomUUID(),{logicalStepId}=this.resolveIdentity(input,ctx,goalId);
  const existing=this.list(ctx,goalId).find(task=>task.logicalStepId===logicalStepId&&task.goalId===goalId&&(goalId!==undefined||task.runId===ctx.runId));
  if(existing)return existing;
  const acceptance=Array.isArray(input.acceptance)?input.acceptance.map(value=>text(value,'完成条件',4000)):[text(input.title,'步骤',4000)];
  const checks=(Array.isArray(input.checks)?input.checks:[]).map(raw=>{const check=object(raw);if(!Array.isArray(check.args)||check.args.some(value=>typeof value!=='string'))throw new Error('检查参数必须是字符串数组');return {command:text(check.command,'检查命令',1000),args:check.args as string[]};});
  const task:TaskRecord={id,logicalStepId,goalId,projectId:ctx.projectId,sessionId:ctx.sessionId,runId:ctx.runId,title:text(input.title,'步骤',4000),mode:input.mode==='write'?'write':'read',status:'pending',acceptance,checks,evidence:[],sources:[],repairCount:this.repairCount(logicalStepId,ctx,goalId),revision:0,createdAt:now(),updatedAt:now()};
  return this.put(task,ctx);
 }
 repairCount(logicalStepId:string,ctx:PluginContext,goalId?:string){return this.store.get<number>(`repairs:${ctx.projectId}:${goalId||ctx.runId||ctx.sessionId}:${logicalStepId}`)?.value||0;}
 claimRepair(input:JsonObject,ctx:PluginContext,goalId?:string){
  const logicalStepId=text(input.logicalStepId,'逻辑步骤');const key=`repairs:${ctx.projectId}:${goalId||ctx.runId||ctx.sessionId}:${logicalStepId}`;
  return this.store.transaction(()=>{const count=this.store.get<number>(key)?.value||0;if(count>=2)return {allowed:false,count};this.store.put(key,count+1);return {allowed:true,count:count+1};});
 }
 claimRepairBatch(input:JsonObject,ctx:PluginContext,goalId?:string){
  const graphId=text(input.graphId),waveId=text(input.waveId);if(!Array.isArray(input.logicalStepIds)||!input.logicalStepIds.length||input.logicalStepIds.length>64)throw new Error('返工波必须指定逻辑步骤');const logicalStepIds=[...new Set(input.logicalStepIds.map(id=>text(id)))],scope=`${ctx.projectId}:${goalId||ctx.runId||ctx.sessionId}`,waveKey=`repair-wave:${scope}:${graphId}:${waveId}`,payload=digest({logicalStepIds,reason:input.reason});
  return this.store.transaction(()=>{const old=this.store.get<{payload:string;result:unknown}>(waveKey)?.value;if(old){if(old.payload!==payload)throw new Error('返工波幂等键已用于不同请求');return old.result;}const round=this.store.get<number>(`repair-round:${scope}:${graphId}`)?.value||0,counts=Object.fromEntries(logicalStepIds.map(id=>[id,this.repairCount(id,ctx,goalId)]));if(round>=2||Object.values(counts).some(count=>count>=2))return {allowed:false,round,counts};for(const id of logicalStepIds){counts[id]++;this.store.put(`repairs:${scope}:${id}`,counts[id]);}this.store.put(`repair-round:${scope}:${graphId}`,round+1);const result={allowed:true,round:round+1,counts};this.store.put(waveKey,{payload,result},null);return result;});
 }
 resolveUnknown(id:string,input:JsonObject,ctx:PluginContext){if(ctx.origin!=='user'||input.confirmUnknown!==true)throw new Error('步骤未知现场需用户检查确认');const task=this.read(id,ctx);if(task.status!=='unknown')throw new Error('步骤状态已变化');text(input.evidence,'检查说明');return this.put({...task,status:'pending',evidence:[],result:undefined,error:undefined},ctx);}
 start(id:string,ctx:PluginContext){const task=this.read(id,ctx);if(['blocked','unknown','completed'].includes(task.status))throw new Error('步骤当前不可直接重启');return this.put({...task,status:'running'},ctx);}
 async verify(id:string,input:JsonObject,ctx:PluginContext,run:(check:AcceptanceCheck)=>Promise<Omit<CheckEvidence,'at'|'hash'>>,writeEpoch=0){
  const task=this.read(id,ctx);if(['unknown','stopped','blocked'].includes(task.status))throw new Error('步骤需先处理阻塞或未知现场');
  this.put({...task,status:'running'},ctx);
  const codeBefore=projectCodeVersion(ctx.projectDir,ctx.dataDir);const evidence:CheckEvidence[]=[];
  for(const check of task.checks){const actual=await run(check);const item={...actual,at:now(),hash:digest(actual)};evidence.push(item);if(actual.exitCode!==0)break;}
  if(['stopped','unknown'].includes(this.read(id,ctx).status))throw new Error('步骤已经停止或现场未知，迟到检查不能推进');
  const codeAfter=projectCodeVersion(ctx.projectDir,ctx.dataDir);if(evidence.length&&codeAfter!==codeBefore)throw new Error('检查期间源码改变，请重新验证当前成果');
  const result=typeof input.result==='string'?text(input.result,'交付说明',32000):task.result;
  const sources=Array.isArray(input.sources)?input.sources:task.sources;
  for(const source of sources)ctx.readSource(source as Parameters<PluginContext['readSource']>[0]);
  if(task.checks.length===0&&!result&&!sources.length)throw new Error('需要实际成果说明或来源证据，不能仅声明完成');
  const registerChecks=(latest:TaskRecord)=>{const checkRefs=evidence.map((item,index)=>({checkId:`${task.id}:${index}`,version:latest.revision+1,hash:digest({evidence:item,codeVersion:codeAfter,taskId:task.id,version:latest.revision+1}),taskId:task.id,producerRunId:ctx.runId||ctx.sessionId,artifacts:[]} satisfies CheckRef));for(const [index,ref] of checkRefs.entries())new SourcePolicy(this.store).registerCheck({ref,projectId:ctx.projectId,passed:evidence[index].exitCode===0,output:{...evidence[index],codeVersion:codeAfter,writeEpoch},sources:sources as Parameters<PluginContext['readSource']>[0][]});return checkRefs;};
  if(evidence.some(item=>item.exitCode!==0))return this.store.transaction(()=>{
   const latest=this.read(id,ctx),repair=this.claimRepair({logicalStepId:task.logicalStepId},ctx,task.goalId),checkRefs=registerChecks(latest);
   return this.put({...latest,evidence,result,sources,checkRefs,repairCount:repair.count,status:repair.allowed?'repair':'blocked',error:repair.allowed?'检查未通过，请定向修复后重新验证':'已达两轮修复上限，步骤及其依赖保持阻塞'},ctx);
  });
  if(task.mode==='write'&&!task.checks.length)throw new Error('写入步骤必须配置并实际通过客观检查');
  return this.store.transaction(()=>{const latest=this.read(id,ctx),checkRefs=registerChecks(latest);return this.put({...latest,evidence,result,sources,checkRefs,status:'completed',error:undefined,verificationWriteEpoch:writeEpoch,verificationCodeVersion:codeAfter},ctx);});
 }
 fail(id:string,error:string,ctx:PluginContext,unknown=false){const task=this.read(id,ctx);return this.put({...task,status:unknown?'unknown':'blocked',error},ctx);}
 stop(ctx:PluginContext){for(const task of this.list(ctx))if((!ctx.runId||task.runId===ctx.runId)&&['running','repair','pending'].includes(task.status))this.put({...task,status:'stopped'},ctx);}
 assertComplete(goalId:string,ctx:PluginContext){const incomplete=this.list(ctx,goalId).filter(task=>task.status!=='completed');if(incomplete.length)throw new Error(`目标仍有未完成步骤：${incomplete.map(task=>task.title).join('、')}`);}
 /** Only host observers call this with a controller's committed execution snapshot. */
 syncExecution(graph:JsonObject,ctx:PluginContext,goalId:string,writeEpoch=0){
  const tasks=Array.isArray(graph.tasks)?graph.tasks.map(object):[],attempts=Array.isArray(graph.attempts)?graph.attempts.map(object):[];
  const integration=graph.integration&&typeof graph.integration==='object'?object(graph.integration):{};
  const checks=Array.isArray(integration.checks)?integration.checks.map(object):[];
  for(const child of tasks){
   const logicalStepId=typeof child.logicalStepId==='string'?child.logicalStepId:`${String(graph.id)}:${String(child.id)}`;
   let task=this.list(ctx,goalId).find(item=>item.logicalStepId===logicalStepId);
   if(!task)task=this.create({title:child.title||child.id,logicalStepId,mode:child.mode,acceptance:[String(child.prompt||child.title)],checks:[]},ctx,goalId);
   const attempt=attempts.find(item=>item.id===child.currentAttempt);const finished=child.status==='skipped'||child.status==='completed'&&(child.mode==='read'||graph.status==='integrated');
   const status:TaskRecord['status']=finished?'completed':child.status==='unknown'?'unknown':['blocked','cancelled'].includes(String(child.status))?'blocked':'running';
   const evidence=checks.map(check=>{const actual={command:String(check.command),args:Array.isArray(check.args)?check.args.map(String):[],exitCode:typeof check.exitCode==='number'?check.exitCode:null,output:String(check.output||'')};return {...actual,at:String(check.at||now()),hash:digest(actual)};});
   const evidenceChanged=digest({checks:integration.checks,commit:integration.commit,attempts:tasks.map(item=>item.currentAttempt)})!==this.store.get<string>(`execution-evidence:${task.id}`)?.value;
   if(evidenceChanged)this.store.put(`execution-evidence:${task.id}`,digest({checks:integration.checks,commit:integration.commit,attempts:tasks.map(item=>item.currentAttempt)}));
   const next={...task,status,verificationWriteEpoch:evidenceChanged?writeEpoch:task.verificationWriteEpoch,verificationCodeVersion:evidenceChanged&&finished&&evidence.length?projectCodeVersion(ctx.projectDir,ctx.dataDir):task.verificationCodeVersion,result:child.status==='skipped'?'条件不成立，工作流跳过此分支':typeof attempt?.summary==='string'?attempt.summary:task.result,evidence,repairCount:Math.max(task.repairCount,Number(child.rework)||0),error:status==='blocked'||status==='unknown'?String(graph.error||'执行步骤未完成'):undefined};
   if(digest({...task,revision:0,updatedAt:''})!==digest({...next,revision:0,updatedAt:''}))this.put(next,ctx);
  }
 }
 dispose(){this.store.close();}
}

/** Goals store business progress; all execution is performed by the host's Pi session. */
export class GoalLedger {
 readonly store:RecordStore;
 constructor(dataDir?:string){this.store=new RecordStore('goal-journal',dataDir);}
 private key(ctx:PluginContext,id:string){return `goal:${ctx.projectId}:${id}`;}
 list(ctx:PluginContext){return this.store.list<GoalRecord>(`goal:${ctx.projectId}:`).map(row=>row.value);}
 current(ctx:PluginContext){const id=this.store.get<string>(`focus:${ctx.sessionId}`)?.value;const goal=id?this.read(id,ctx):undefined;return goal?.sessionId===ctx.sessionId?goal:undefined;}
 read(id:string,ctx:PluginContext){const row=this.store.get<GoalRecord>(this.key(ctx,id));if(!row)throw new Error('目标不属于当前项目');return row.value;}
 private put(goal:GoalRecord,ctx:PluginContext){goal={...goal,revision:goal.revision+1,updatedAt:now()};this.store.put(this.key(ctx,goal.id),goal);this.store.afterCommit(()=>{ctx.emit('goal.changed',goal);ctx.appendEntry('friend-pi.goal.receipt',{goalId:goal.id,revision:goal.revision,status:goal.status,generation:goal.generation});});return goal;}
 create(input:JsonObject,ctx:PluginContext,generation:number){
  if(ctx.origin!=='user'&&(!ctx.runId||ctx.policy?.planMode))throw new Error('Agent 只能在已授权执行任务内设定目标');
  const prior=this.current(ctx);if(prior&&['active','waiting','verifying'].includes(prior.status))throw new Error('当前会话已有运行目标，请先处理或暂停');
  const tokenBudget=input.tokenBudget===undefined?undefined:Number(input.tokenBudget);if(tokenBudget!==undefined&&(!Number.isSafeInteger(tokenBudget)||tokenBudget<1))throw new Error('令牌预算必须是正整数');
  const goal:GoalRecord={id:randomUUID(),projectId:ctx.projectId,sessionId:ctx.sessionId,origin:ctx.origin==='user'?'user':'agent',sourceRunId:ctx.runId,objective:text(input.objective,'目标',32000),mode:ctx.executionMode||'single',status:ctx.policy?.planMode?'paused':'active',revision:0,progress:'',nextAction:typeof input.nextAction==='string'?text(input.nextAction):text(input.objective),tokenBudget,tokens:0,usageAvailable:true,safeCheckpoint:false,generation,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,createdAt:now(),updatedAt:now()};
  this.store.put(`focus:${ctx.sessionId}`,goal.id);return this.put(goal,ctx);
 }
 update(input:JsonObject,ctx:PluginContext){
  const goal=input.goalId?this.read(text(input.goalId),ctx):this.current(ctx);if(!goal||goal.sessionId!==ctx.sessionId)throw new Error('没有当前会话目标');
  if(input.objective!==undefined||input.tokenBudget!==undefined){if(ctx.origin!=='user')throw new Error('Agent 不能扩大目标或增加预算');}
  if(input.objective!==undefined){const budget=input.tokenBudget===undefined?goal.tokenBudget:Number(input.tokenBudget);if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<1))throw new Error('令牌预算必须是正整数');return this.put({...goal,objective:text(input.objective),tokenBudget:budget,nextAction:text(input.objective),safeCheckpoint:false,status:'paused'},ctx);}
  if(input.tokenBudget!==undefined){const budget=Number(input.tokenBudget);if(!Number.isSafeInteger(budget)||budget<1)throw new Error('令牌预算必须是正整数');return this.put({...goal,tokenBudget:budget,status:goal.tokens>=budget?'paused':goal.status,error:goal.tokens>=budget?'目标预算已经耗尽':goal.error},ctx);}
  if(['completed','stopped'].includes(goal.status))throw new Error('目标已结束');
  const continuation=input.continuation?object(input.continuation):undefined;
  const waiting=continuation?.kind==='wait';const nextAction=typeof input.nextAction==='string'?text(input.nextAction):typeof continuation?.nextAction==='string'?text(continuation.nextAction):goal.nextAction;
  return this.put({...goal,progress:typeof input.progress==='string'?text(input.progress):goal.progress,nextAction,status:waiting?'waiting':goal.status==='waiting'?'active':goal.status,waitFor:waiting?text(continuation?.taskId,'等待对象'):undefined,safeCheckpoint:false},ctx);
 }
 deliveryFailure(ctx:PluginContext,receipt:JsonObject,generation:number){const goal=this.current(ctx);if(!goal||goal.sourceRunId!==receipt.runId||goal.generation!==generation||['paused','stopped'].includes(goal.status))return;return this.put({...goal,status:'blocked',error:`角色交付未通过：${String(receipt.error)}`,safeCheckpoint:false,audit:{objectiveAudit:goal.audit,delivery:receipt}},ctx);}
 setState(status:GoalRecord['status'],ctx:PluginContext,error?:string){const goal=this.current(ctx);if(!goal||['completed','stopped'].includes(goal.status))return;return this.put({...goal,status,error,safeCheckpoint:false},ctx);}
 checkpoint(ctx:PluginContext,safe:boolean){const goal=this.current(ctx);if(goal?.waitFor==='user-acceptance')return goal;if(!goal||!['active','waiting'].includes(goal.status))return;return this.put({...goal,safeCheckpoint:safe,checkpointRevision:goal.revision+1},ctx);}
 admit(ctx:PluginContext){const goal=this.current(ctx);if(!goal||!['active','waiting'].includes(goal.status))return;return this.put({...goal,safeCheckpoint:false},ctx);}
 noteWrite(ctx:PluginContext,eventId?:string){const goal=this.current(ctx);if(!goal||!['active','waiting','verifying'].includes(goal.status))return;const key=eventId?`write:${goal.id}:${eventId}`:undefined;if(key&&this.store.get(key))return goal;if(key)this.store.put(key,true,null);return this.put({...goal,writeObserved:true,writeEpoch:(goal.writeEpoch||0)+1,safeCheckpoint:false},ctx);}
 account(ctx:PluginContext,tokens:number|undefined,goalId?:string){const goal=goalId?this.read(goalId,ctx):this.current(ctx);if(!goal)return;const next=this.put({...goal,tokens:goal.tokens+(tokens||0),usageAvailable:goal.usageAvailable&&tokens!==undefined},ctx);if(!['completed','stopped'].includes(next.status)&&this.current(ctx)?.id===next.id&&next.tokenBudget!==undefined&&(!next.usageAvailable||next.tokens>=next.tokenBudget))return this.setState('paused',ctx,'目标令牌预算耗尽或使用量不可核实');return next;}

 resume(input:JsonObject,ctx:PluginContext,generation:number){
  if(ctx.origin!=='user')throw new Error('暂停或阻塞后的接续必须由用户执行');const goal=input.goalId?this.read(text(input.goalId),ctx):this.current(ctx);if(!goal||goal.status==='completed')throw new Error('目标不可接续');
  if(ctx.executionMode&&ctx.executionMode!==goal.mode)throw new Error('目标沿用原执行模式；切回原模式接续，或为新模式创建新目标');
  if(goal.sessionId!==ctx.sessionId)throw new Error('目标与步骤由原会话持有，请在原会话接续');
  if(goal.tokenBudget!==undefined&&goal.tokens>=goal.tokenBudget&&input.tokenBudget===undefined)throw new Error('预算耗尽，请明确增加预算');
  const budget=input.tokenBudget===undefined?goal.tokenBudget:Number(input.tokenBudget);if(budget!==undefined&&(!Number.isSafeInteger(budget)||budget<=goal.tokens))throw new Error('预算须高于已使用令牌');
  if(goal.sessionId!==ctx.sessionId&&this.store.get<string>(`focus:${goal.sessionId}`)?.value===goal.id)this.store.remove(`focus:${goal.sessionId}`);
  const revalidate=goal.waitFor==='user-acceptance';
  this.store.put(`focus:${ctx.sessionId}`,goal.id);return this.put({...goal,sessionId:ctx.sessionId,mode:ctx.executionMode||goal.mode,generation,status:'active',tokenBudget:budget,safeCheckpoint:false,error:undefined,waitFor:undefined,acceptance:undefined,...(revalidate?{writeEpoch:(goal.writeEpoch||0)+1,cachedAudit:undefined}: {})},ctx);
 }
 restore(ctx:PluginContext,generation:number,safeObjects:boolean){const goal=this.current(ctx);if(goal?.waitFor==='user-acceptance')return false;if(!goal||!['active','waiting'].includes(goal.status))return false;if(!goal.safeCheckpoint||!safeObjects||goal.mode!==(ctx.executionMode||'single')){this.put({...goal,status:'paused',error:'检查点或执行现场未确认安全，未自动重放'},ctx);return false;}this.put({...goal,generation},ctx);return true;}
 async finish(ctx:PluginContext,tasks:TaskLedger,audit:(goal:GoalRecord)=>Promise<{approved:boolean;findings:string;[key:string]:unknown}>,safeObjects:boolean){
  const goal=this.current(ctx);if(!goal||goal.sessionId!==ctx.sessionId)throw new Error('没有当前目标');if(!['active','waiting'].includes(goal.status))throw new Error('目标需先显式接续，停止或暂停后不能完成');if(!safeObjects)throw new Error('执行对象尚未收敛，不能完成目标');tasks.assertComplete(goal.id,ctx);
  if(goal.writeObserved&&!tasks.list(ctx,goal.id).some(task=>task.status==='completed'&&(task.verificationWriteEpoch||0)>=(goal.writeEpoch||0)&&task.evidence.length&&task.evidence.every(item=>item.exitCode===0)&&task.verificationCodeVersion===projectCodeVersion(ctx.projectDir,ctx.dataDir)))throw new Error('目标写入或成果已变化，需记录当前成果实际通过的客观检查步骤');
  if(!goal.progress.trim())throw new Error('先记录实际成果和完成证据');
  this.put({...goal,status:'verifying',safeCheckpoint:false},ctx);const goalVersion=digest({objective:goal.objective,progress:goal.progress,nextAction:goal.nextAction,mode:goal.mode,modelId:goal.modelId,writeEpoch:goal.writeEpoch}),taskVersion=digest(tasks.list(ctx,goal.id)),codeVersion=projectCodeVersion(ctx.projectDir,ctx.dataDir);
  const binding=digest([goalVersion,taskVersion,codeVersion]);let cacheValid=false;try{const source=object(goal.cachedAudit?.result.source);cacheValid=goal.cachedAudit?.binding===binding&&goal.cachedAudit.result.independent===true&&typeof source.sessionFile==='string'&&typeof source.sessionId==='string'&&!isSessionDeleted(ctx.dataDir,source.sessionId)&&existsSync(source.sessionFile)&&digest(readFileSync(source.sessionFile))===goal.cachedAudit.sourceHash;}catch{}
  if(goal.mode==='single'&&goal.writeObserved){const current=this.read(goal.id,ctx);return this.put({...current,status:'waiting',waitFor:'user-acceptance',safeCheckpoint:false,audit:{approved:false,independent:false,needsUserAcceptance:true,findings:'客观检查已通过，Single 写入成果等待用户验收'},acceptance:{binding,taskVersion,codeVersion,goalVersion,requestedAt:now()},error:'请在任务面板检查成果并确认验收，或切换协作模式进行独立复核'},ctx);}
  try {const result=goal.mode==='single'?{approved:true,findings:'Single：主 Agent 完成说明及已记录客观检查；无独立审核'}:cacheValid?{...goal.cachedAudit!.result,reused:true}:await audit(goal);const current=this.read(goal.id,ctx);if(this.current(ctx)?.id!==goal.id||current.status!=='verifying'||current.generation!==goal.generation||current.writeEpoch!==goal.writeEpoch||digest({objective:current.objective,progress:current.progress,nextAction:current.nextAction,mode:current.mode,modelId:current.modelId,writeEpoch:current.writeEpoch})!==goalVersion||digest(tasks.list(ctx,goal.id))!==taskVersion||projectCodeVersion(ctx.projectDir,ctx.dataDir)!==codeVersion)throw new Error('审核期间目标或执行代次变化，迟到结果未采用');let cachedAudit=current.cachedAudit;try{const source=object((result as JsonObject).source);if(result.approved&&(result as JsonObject).independent===true&&typeof source.sessionFile==='string')cachedAudit={binding,result,sourceHash:digest(readFileSync(source.sessionFile))};}catch{}return this.put({...current,cachedAudit,status:result.approved?'completed':'blocked',audit:result,error:result.approved?undefined:result.findings,safeCheckpoint:result.approved},ctx);}catch(error){const current=this.current(ctx);if(current?.id===goal.id&&current.status==='verifying')this.setState('blocked',ctx,String(error));throw error;}
 }
 accept(input:JsonObject,ctx:PluginContext,tasks:TaskLedger,safe:boolean){
  if(ctx.origin!=='user')throw new CapabilityError('PERMISSION_DENIED','Single 写入成果只能由用户确认验收');const goal=this.current(ctx);if(!goal||goal.mode!=='single'||goal.status!=='waiting'||goal.waitFor!=='user-acceptance'||!goal.acceptance||!safe)throw new CapabilityError('VERSION_CONFLICT','当前成果不在可验收状态');if(input.goalId!==goal.id||input.expectedRevision!==goal.revision||input.candidateDigest!==goal.acceptance.binding)throw new CapabilityError('VERSION_CONFLICT','验收候选或目标版本已变化');tasks.assertComplete(goal.id,ctx);const goalVersion=digest({objective:goal.objective,progress:goal.progress,nextAction:goal.nextAction,mode:goal.mode,modelId:goal.modelId,writeEpoch:goal.writeEpoch});if(goalVersion!==goal.acceptance.goalVersion||digest(tasks.list(ctx,goal.id))!==goal.acceptance.taskVersion||projectCodeVersion(ctx.projectDir,ctx.dataDir)!==goal.acceptance.codeVersion)throw new CapabilityError('VERSION_CONFLICT','成果或检查已变化，请重新验证');return this.put({...goal,status:'completed',waitFor:undefined,safeCheckpoint:true,error:undefined,audit:{approved:true,independent:false,kind:'user-acceptance',candidateDigest:goal.acceptance.binding,at:now()}},ctx);
 }
 dispose(){this.store.close();}
}
