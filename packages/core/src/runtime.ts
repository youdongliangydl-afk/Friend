import {projectCodeVersion} from './code-version.js';
import {randomUUID} from 'node:crypto';
import {CapabilityError,SourcePolicy,type CheckRef,RecordStore,digest,object,text,type JsonObject,type PluginContext,type ExecutionMode} from './index.js';

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
 mode:ExecutionMode;status:'active'|'paused'|'blocked'|'usage_limited'|'complete';
 schemaVersion?:number;revision:number;progress:string;nextAction:string;waitFor?:string;tokens:number;
 timeUsedSeconds?:number;activeSince?:string;legacyStatus?:string;completionHistory?:unknown[];
 usageAvailable:boolean;safeCheckpoint:boolean;checkpointRevision?:number;generation:number;
 modelId?:string;thinkingLevel?:string;createdAt:string;updatedAt:string;error?:string;audit?:unknown;writeObserved?:boolean;writeEpoch?:number;acceptance?:{binding:string;taskVersion:string;codeVersion:string;goalVersion:string;requestedAt:string};cachedAudit?:{binding:string;result:{approved:boolean;findings:string;[key:string]:unknown};sourceHash:string};
}
export interface WakeFrame {id:string;generation:number;runId?:string;goalId?:string;goalRevision?:number;message:string;createdAt:string}

/** Durable delivery admission; a stop invalidates all previously captured wake frames. */
export class ContinuationCoordinator {
 readonly store:RecordStore;
 constructor(readonly sessionId:string,dataDir?:string){this.store=new RecordStore('runtime-wake',dataDir);}
 generation(){return this.store.get<number>(`generation:${this.sessionId}`)?.value||0;}
 invalidate(){const next=this.generation()+1;this.store.put(`generation:${this.sessionId}`,next);for(const row of this.store.list<WakeFrame>(`queue:${this.sessionId}:`))this.store.remove(row.key);return next;}
 enqueue(id:string,message:string,options:{generation?:number;runId?:string;goalId?:string;goalRevision?:number}={}){
  const generation=options.generation??this.generation();if(generation!==this.generation())return false;
  const seen=`seen:${this.sessionId}:${id}`;if(this.store.get(seen))return false;
  this.store.transaction(()=>{this.store.put(seen,{generation,at:now()},null);this.store.put(`queue:${this.sessionId}:${id}`,{id,generation,runId:options.runId,goalId:options.goalId,goalRevision:options.goalRevision,message,createdAt:now()} satisfies WakeFrame,null);});return true;
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
 cancelGoal(goalId:string){for(const row of this.store.list<WakeFrame>(`queue:${this.sessionId}:`))if(row.value.goalId===goalId)this.store.remove(row.key);}
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
  const trialAttribution=ctx.captureCheckAttribution?.(ctx.runId);
  this.put({...task,status:'running'},ctx);
  const codeBefore=projectCodeVersion(ctx.projectDir,ctx.dataDir);const evidence:CheckEvidence[]=[];
  for(const check of task.checks){const actual=await run(check);const item={...actual,at:now(),hash:digest(actual)};evidence.push(item);if(actual.exitCode!==0)break;}
  if(['stopped','unknown'].includes(this.read(id,ctx).status))throw new Error('步骤已经停止或现场未知，迟到检查不能推进');
  const codeAfter=projectCodeVersion(ctx.projectDir,ctx.dataDir);if(evidence.length&&codeAfter!==codeBefore)throw new Error('检查期间源码改变，请重新验证当前成果');
  const result=typeof input.result==='string'?text(input.result,'交付说明',32000):task.result;
  const sources=Array.isArray(input.sources)?input.sources:task.sources;
  for(const source of sources)ctx.readSource(source as Parameters<PluginContext['readSource']>[0]);
  if(task.checks.length===0&&!result&&!sources.length)throw new Error('需要实际成果说明或来源证据，不能仅声明完成');
  const registerChecks=(latest:TaskRecord)=>{const checkRefs=evidence.map((item,index)=>({checkId:`${task.id}:${index}`,version:latest.revision+1,hash:digest({evidence:item,codeVersion:codeAfter,taskId:task.id,version:latest.revision+1,trialAttribution}),taskId:task.id,producerRunId:ctx.runId||ctx.sessionId,artifacts:[]} satisfies CheckRef));for(const [index,ref] of checkRefs.entries())new SourcePolicy(this.store).registerCheck({ref,projectId:ctx.projectId,passed:evidence[index].exitCode===0,output:{...evidence[index],codeVersion:codeAfter,writeEpoch,...(trialAttribution?{trialAttribution}:{})},sources:sources as Parameters<PluginContext['readSource']>[0][]});return checkRefs;};
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
 // Only time observed by this live ledger is chargeable. Persisted wall clocks
 // never count time while the host was offline.
 private readonly loaded=new Set<string>();
 constructor(dataDir?:string){this.store=new RecordStore('goal-journal',dataDir);}
 private key(ctx:PluginContext,id:string){return `goal:${ctx.projectId}:${id}`;}
 private focusKey(ctx:PluginContext){return `focus:${ctx.sessionId}`;}
 private completedKey(ctx:PluginContext){return `last-completed:${ctx.projectId}:${ctx.sessionId}`;}
 list(ctx:PluginContext){return this.store.list<GoalRecord>(`goal:${ctx.projectId}:`).filter(row=>row.value.sessionId===ctx.sessionId).map(row=>this.read(row.value.id,ctx));}
 current(ctx:PluginContext){
  const id=this.store.get<string>(this.focusKey(ctx))?.value;if(!id)return;
  const raw=this.store.get<GoalRecord>(this.key(ctx,id))?.value;
  // A stale project/session pointer must not expose another session's goal.
  if(!raw||raw.sessionId!==ctx.sessionId)return;
  const goal=this.read(id,ctx);return goal.status==='complete'?undefined:goal;
 }
 getLastCompleted(ctx:PluginContext){const id=this.store.get<string>(this.completedKey(ctx))?.value;if(!id)return;const goal=this.read(id,ctx);return goal.status==='complete'?goal:undefined;}
 read(id:string,ctx:PluginContext):GoalRecord {
  return this.store.transaction(()=>{
   const row=this.store.get<GoalRecord>(this.key(ctx,id));if(!row||row.value.sessionId!==ctx.sessionId)throw new Error('目标与步骤由原会话持有，请在原会话查看或接续');
   let goal=row.value;const oldStatus=String(goal.status),first=!this.loaded.has(this.key(ctx,id));
   const audit=goal.audit&&typeof goal.audit==='object'?goal.audit as JsonObject:undefined,error=goal.error||'';
   const executionUnknown=/未知|unknown|未收敛/iu.test(error);
   const legacyAuditBlocked=goal.schemaVersion!==2&&oldStatus==='blocked'&&!executionUnknown&&(
    audit?.approved===false&&!audit.delivery&&(!error||error===audit.findings)||
    /(?:独立审核|独立审计|独立复核|audit).*(?:不可用|未配置|无法启动|unavailable|not available|timeout)/iu.test(error)
   );
   const status:GoalRecord['status']=oldStatus==='completed'?'complete':legacyAuditBlocked||oldStatus==='stopped'||oldStatus==='verifying'||oldStatus==='waiting'&&(!goal.waitFor?.trim()||goal.waitFor==='user-acceptance')?'paused':oldStatus==='waiting'?'active':goal.status;
   if(goal.schemaVersion!==2||status!==oldStatus||goal.timeUsedSeconds===undefined||first&&goal.activeSince!==undefined){
    goal={...goal,schemaVersion:2,status,timeUsedSeconds:Number.isFinite(goal.timeUsedSeconds)?Math.max(0,goal.timeUsedSeconds!):0,...(status!==oldStatus?{legacyStatus:oldStatus}:{}),...(first||goal.schemaVersion!==2||status!==oldStatus||status!=='active'?{activeSince:undefined}:{})};
    this.store.put(this.key(ctx,id),goal); // Preserve evidence and logical revision during format migration.
   }
   this.loaded.add(this.key(ctx,id));
   if(goal.status==='complete'){
    const previousId=this.store.get<string>(this.completedKey(ctx))?.value,previous=previousId?this.store.get<GoalRecord>(this.key(ctx,previousId))?.value:undefined;
    if(!previous||previous.updatedAt<=goal.updatedAt)this.store.put(this.completedKey(ctx),goal.id);
    if(this.store.get<string>(this.focusKey(ctx))?.value===goal.id)this.store.remove(this.focusKey(ctx));
   }
   return goal;
  });
 }
 private cas(input:JsonObject,goal:GoalRecord|undefined){if(input.goalId!==undefined&&input.goalId!==goal?.id||input.expectedRevision!==undefined&&input.expectedRevision!==goal?.revision)throw new CapabilityError('VERSION_CONFLICT','目标或版本已变化，请刷新后重试');}
 private put(goal:GoalRecord,ctx:PluginContext){
  const timestamp=now(),previous=this.store.get<GoalRecord>(this.key(ctx,goal.id))?.value;
  const elapsed=previous?.status==='active'&&previous.activeSince&&this.loaded.has(this.key(ctx,goal.id))?Math.max(0,(Date.parse(timestamp)-Date.parse(previous.activeSince))/1000):0;
  goal={...goal,schemaVersion:2,timeUsedSeconds:(previous?.timeUsedSeconds??goal.timeUsedSeconds??0)+(Number.isFinite(elapsed)?elapsed:0),activeSince:goal.status==='active'?timestamp:undefined,revision:goal.revision+1,updatedAt:timestamp};
  this.loaded.add(this.key(ctx,goal.id));this.store.put(this.key(ctx,goal.id),goal);
  if(goal.status==='complete'){this.store.put(this.completedKey(ctx),goal.id);if(this.store.get<string>(this.focusKey(ctx))?.value===goal.id)this.store.remove(this.focusKey(ctx));}
  this.store.afterCommit(()=>{ctx.emit('goal.changed',goal);ctx.appendEntry('friend-pi.goal.receipt',{goalId:goal.id,revision:goal.revision,status:goal.status,generation:goal.generation});});return goal;
 }
 create(input:JsonObject,ctx:PluginContext,generation:number):GoalRecord {
  return this.store.transaction(()=>{
   if(ctx.origin!=='user'&&input.userRequested!==true)throw new CapabilityError('PERMISSION_DENIED','只有用户明确请求才能创建长期目标');
   const prior=this.current(ctx);this.cas(input,prior);if(prior)throw new Error('当前会话已有未完成目标；替换需要用户明确确认');
   const objective=text(input.objective,'目标',4000),status='active';
   const goal:GoalRecord={id:randomUUID(),projectId:ctx.projectId,sessionId:ctx.sessionId,origin:ctx.origin==='user'?'user':'agent',sourceRunId:ctx.runId,objective,mode:ctx.executionMode||'single',status,revision:0,progress:'',nextAction:typeof input.nextAction==='string'?text(input.nextAction):objective,tokens:0,usageAvailable:true,timeUsedSeconds:0,safeCheckpoint:false,generation,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,createdAt:now(),updatedAt:now()};
   this.store.put(this.focusKey(ctx),goal.id);return this.put(goal,ctx);
  });
 }
 set(input:JsonObject,ctx:PluginContext,generation:number):GoalRecord {
  if(ctx.origin!=='user')throw new CapabilityError('PERMISSION_DENIED','只有用户可以设置目标或修改目标状态');
  return this.store.transaction(()=>{
   const goal=this.current(ctx);this.cas(input,goal);
   if(input.status!==undefined&&input.status!=='active'&&input.status!=='paused')throw new Error('设置目标仅支持 active 或 paused');
   const objective=input.objective===undefined?goal?.objective:text(input.objective,'目标',4000);
   if(!goal||input.replace===true){
    // Validate before clearing so rejected replacements preserve the current focus.
    text(objective,'目标',4000);if(goal)this.clear(ctx,{goalId:goal.id,expectedRevision:goal.revision});
    const created=this.create({...input,objective,goalId:undefined,expectedRevision:undefined},ctx,generation);
    return input.status==='paused'&&created.status!=='paused'?this.put({...created,status:'paused'},ctx):created;
   }
   return this.put({...goal,objective:objective!,nextAction:input.objective===undefined?goal.nextAction:objective!,status:input.status==='paused'?'paused':input.status==='active'||input.objective!==undefined?'active':goal.status,generation,safeCheckpoint:false,error:undefined},ctx);
  });
 }
 clear(ctx:PluginContext,input:JsonObject={}){
  if(ctx.origin!=='user')throw new CapabilityError('PERMISSION_DENIED','只有用户可以清除当前目标');
  return this.store.transaction(()=>{const goal=this.current(ctx);this.cas(input,goal);if(!goal)return;const saved=this.put({...goal,status:goal.status==='active'?'paused':goal.status,safeCheckpoint:false},ctx);this.store.remove(this.focusKey(ctx));return saved;});
 }
 update(input:JsonObject,ctx:PluginContext){
  return this.store.transaction(()=>{
   const goal=this.current(ctx);this.cas(input,goal);if(!goal)throw new Error('没有当前会话目标');
   if(input.objective!==undefined||input.status!==undefined)return this.set(input,ctx,goal.generation);
   const continuation=input.continuation?object(input.continuation):undefined,waiting=continuation?.kind==='wait';
   const nextAction=typeof input.nextAction==='string'?text(input.nextAction):typeof continuation?.nextAction==='string'?text(continuation.nextAction):goal.nextAction;
   return this.put({...goal,progress:typeof input.progress==='string'?text(input.progress):goal.progress,nextAction,waitFor:waiting?text(continuation?.taskId,'等待对象'):undefined,safeCheckpoint:false},ctx);
  });
 }
 deliveryFailure(ctx:PluginContext,receipt:JsonObject,generation:number){const goal=this.current(ctx);if(!goal||goal.sourceRunId!==receipt.runId||goal.generation!==generation||goal.status==='paused')return;return this.put({...goal,status:'blocked',error:`角色交付未通过：${String(receipt.error)}`,safeCheckpoint:false,audit:{objectiveAudit:goal.audit,delivery:receipt}},ctx);}
 setState(status:GoalRecord['status']|'stopped'|'waiting'|'verifying'|'completed',ctx:PluginContext,error?:string,input:JsonObject={}){
  return this.store.transaction(()=>{const goal=this.current(ctx);this.cas(input,goal);if(!goal)return;if(status==='complete'||status==='completed')throw new Error('请记录完成说明并调用 finish');const canonical=status==='stopped'||status==='verifying'?'paused':status==='waiting'?'active':status;return this.put({...goal,status:canonical,error,safeCheckpoint:false},ctx);});
 }
 checkpoint(ctx:PluginContext,safe:boolean){const goal=this.current(ctx);if(goal?.status!=='active')return;return this.put({...goal,safeCheckpoint:safe,checkpointRevision:goal.revision+1},ctx);}
 admit(ctx:PluginContext){const goal=this.current(ctx);if(goal?.status!=='active')return;return this.put({...goal,safeCheckpoint:false},ctx);}
 noteWrite(ctx:PluginContext,eventId?:string){const goal=this.current(ctx);if(goal?.status!=='active')return;const key=eventId?`write:${goal.id}:${eventId}`:undefined;if(key&&this.store.get(key))return goal;if(key)this.store.put(key,true,null);return this.put({...goal,writeObserved:true,writeEpoch:(goal.writeEpoch||0)+1,safeCheckpoint:false},ctx);}
 account(ctx:PluginContext,tokens:number|undefined,goalId?:string){return this.store.transaction(()=>{const goal=goalId?this.read(goalId,ctx):this.current(ctx);if(!goal)return;const available=tokens!==undefined&&Number.isFinite(tokens)&&tokens>=0;return this.put({...goal,tokens:goal.tokens+(available?tokens:0),usageAvailable:goal.usageAvailable&&available},ctx);});}
 resume(input:JsonObject,ctx:PluginContext,generation:number){
  if(ctx.origin!=='user')throw new CapabilityError('PERMISSION_DENIED','暂停或阻塞后的接续必须由用户执行');
  return this.store.transaction(()=>{
   const current=this.current(ctx),goal=input.goalId?this.read(text(input.goalId),ctx):current;
   if(!goal||goal.status==='complete')throw new Error('目标不可接续');this.cas(input,goal);
   if(current&&current.id!==goal.id)throw new CapabilityError('VERSION_CONFLICT','当前会话已有其他目标');
   this.store.put(this.focusKey(ctx),goal.id);return this.put({...goal,mode:ctx.executionMode||goal.mode,modelId:ctx.modelId??goal.modelId,thinkingLevel:ctx.thinkingLevel??goal.thinkingLevel,sourceRunId:ctx.runId,generation,status:'active',safeCheckpoint:false,error:undefined,waitFor:undefined},ctx);
  });
 }
 bindRun(ctx:PluginContext){const goal=this.current(ctx);if(goal?.status!=='active')return goal;return this.put({...goal,sourceRunId:ctx.runId,mode:ctx.executionMode||goal.mode,modelId:ctx.modelId??goal.modelId,thinkingLevel:ctx.thinkingLevel??goal.thinkingLevel,safeCheckpoint:false},ctx);}
 restore(ctx:PluginContext,generation:number,safeObjects:boolean){const goal=this.current(ctx);if(goal?.status!=='active'||ctx.policy?.planMode)return false;if(!goal.safeCheckpoint||!safeObjects){this.put({...goal,status:'paused',error:'检查点或执行现场未确认安全，未自动重放'},ctx);return false;}this.put({...goal,generation,mode:ctx.executionMode||goal.mode},ctx);return true;}
 async finish(ctx:PluginContext,_tasks:TaskLedger,_audit:(goal:GoalRecord)=>Promise<{approved:boolean;findings:string;[key:string]:unknown}>,safeObjects:boolean,input:JsonObject={}){
  return this.store.transaction(()=>{
   const goal=this.current(ctx);this.cas(input,goal);if(!goal)throw new Error('没有当前目标');if(goal.status!=='active')throw new Error('目标需先显式接续，停止或暂停后不能完成');if(!safeObjects)throw new Error('执行对象尚未收敛，不能完成目标');
   const provided=input.completionSummary??input.summary??input.progress;const summary=provided!==undefined?text(provided,'实际成果和完成说明',32000):goal.progress.trim()||'主 Agent 声明目标已完成；依据保留在 Pi 原生会话中';
   return this.put({...goal,status:'complete',progress:summary,waitFor:undefined,safeCheckpoint:true,error:undefined,completionHistory:goal.audit===undefined?goal.completionHistory:[...(goal.completionHistory||[]),goal.audit],audit:{approved:true,independent:false,kind:'agent-completion',judgedBy:'main-agent',findings:summary,at:now(),goalRevision:goal.revision}},ctx);
  });
 }
 accept(_input:JsonObject,_ctx:PluginContext,_tasks:TaskLedger,_safe:boolean):GoalRecord {throw new CapabilityError('VERSION_CONFLICT','旧验收入口已停用，请显式恢复目标、核对成果后记录完成说明');}
 dispose(){for(const row of this.store.list<GoalRecord>('goal:')){const goal=row.value;if(this.loaded.has(`goal:${goal.projectId}:${goal.id}`)&&goal.activeSince){const elapsed=Math.max(0,(Date.now()-Date.parse(goal.activeSince))/1000);this.store.put(row.key,{...goal,timeUsedSeconds:(goal.timeUsedSeconds||0)+(Number.isFinite(elapsed)?elapsed:0),activeSince:undefined});}}this.store.close();}
}
