import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionFactory,ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerSourceSession,TaskLedger,RuntimeCapabilityServices,CapabilityError,normalizeCapabilityError,SourcePolicy,agentDirectory, assertTemporaryArtifactPath,ConflictError, digest, object, parseModelJson, RecordStore, registerPlugin, text,makeContext,visibleText } from '@friend-pi/core';
import type { CapabilityDependency,JsonObject, PluginContext, PluginController, StoredDocument } from '@friend-pi/core';
import { contains, destructiveCommand } from './guard.js';
import type { Attempt, Baseline, Check, CheckResult, Graph, MemberHandle, MemberLauncher, MemberMessage, MemberOutput, MemberStart, Review, SharedDocument, Task,StopObject,TaskWait } from './types.js';
import {managedCommand,ownChild,checkCancelled,CancelledError} from './managed.js';
import {SharedMaterials} from './shared.js';
import {memberPrompt} from './member-role.js';
import {TeammateStore,nativeBranch} from './teammates.js';
import type {Teammate} from './types.js';
import {DynamicWorkflowController} from './workflow.js';
import {SwarmStorage} from './storage.js';
import {Artifacts,fileDigest} from './artifacts.js';
import {Operations} from './operations.js';
import {Budget} from './budget.js';
import {contract} from './contracts.js';
import {declarativeCheck,failureFingerprint} from './verification.js';
import type {BudgetSnapshot,VerificationRecord,ArtifactVersion} from './types.js';
import {projectSwarmToolResult} from './tool-result.js';
import {nativeCheckType,memberNativeInput,readMemberChecks,trialAdoptions} from './member-checks.js';
import {graphReachability} from './reachability.js';
import {prepareHandoff,readHandoff,verifyHandoffRead} from './handoff.js';
export {DynamicWorkflowController} from './workflow.js';
export type {WorkflowResumePreview} from './workflow.js';
export type {HandoffRef,StructuredHandoff} from './handoff.js';
export type * from './types.js';

const now = () => new Date().toISOString();
const alive = (pid:number) => {try {process.kill(pid,0);return true;} catch {return false;}};
function errorText(error:unknown): string {return error instanceof Error ? error.message : String(error);}
function number(value:unknown,fallback:number,min:number,max:number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value)<min || Number(value)>max) throw new Error(`数值必须在 ${min}–${max} 之间`);
  return Number(value);
}
function thinkingLevel(value:unknown,fallback?:string):string|undefined {
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!['off','minimal','low','medium','high','xhigh'].includes(value))throw new Error('未知思考等级');
  return value;
}
function strings(value:unknown,label=''): string[] {if (!Array.isArray(value) || value.some(x=>typeof x !== 'string')) throw new Error(`${label}必须提供字符串数组`); return value as string[];}
type ExecutionContext=PluginContext&{planMode?:boolean};
function assertExecution(ctx:PluginContext,style:'team'|'swarm'):void {
  const host=ctx as ExecutionContext,mode=host.policy?.executionMode??host.executionMode;
  if(host.policy?.executionStopped)throw new Error('宿主已停止本轮执行');
  if(host.planMode||host.policy?.planMode)throw new Error('计划模式不能启动协作成员');
  if(mode==='single'||mode&&mode!==style)throw new Error(`${mode} 模式不能启动 ${style} 成员`);
}
function validateTaskModel(task:Task,ctx:PluginContext,defaultModel?:string,defaultThinking?:string):void {
  const modelId=task.modelId??defaultModel,level=task.thinkingLevel??defaultThinking;
  const models=(ctx as ExecutionContext).availableModels;
  if(task.modelId&&(!models||!models.some(model=>model.id===modelId)))throw new Error('委派模型必须是已配置且可用的型号');
  const model=models?.find(item=>item.id===modelId);if(level&&model?.thinkingLevels&&!model.thinkingLevels.includes(level))throw new Error('委派模型不支持此思考等级');
}
function boundTaskPolicy(task:Task,ctx:PluginContext):void {
  const policy=(ctx as ExecutionContext).policy;if(!policy)return;
  if(task.mode==='write'){
    if(!policy.tools.some(tool=>['write','edit','bash'].includes(tool)))throw new Error('父任务权限不允许写入委派');
    const scopes=task.writeScopes.flatMap(scope=>policy.writeScopes.flatMap(parent=>contains(resolve(ctx.projectDir,parent),resolve(ctx.projectDir,scope))?[scope]:contains(resolve(ctx.projectDir,scope),resolve(ctx.projectDir,parent))?[parent]:[]));
    if(!scopes.length)throw new Error('委派写入范围超出父任务权限');task.writeScopes=[...new Set(scopes)];
  }
}
const taskSettled=(task:Task)=>task.status==='completed'||task.status==='skipped';
const currentUnknown=(graph:Graph)=>graph.tasks.some(task=>task.status==='unknown'||graph.attempts.some(attempt=>attempt.id===task.currentAttempt&&attempt.status==='unknown'));
function assertOrdinaryGraph(graph:Graph):void {if(graph.audit)throw new Error('内部 Goal 审计图不能通过通用 Swarm 操作修改或接续；请使用 friend_goal complete 重新发起独立审计。');}
function graphKey(projectId:string,id:string): string {return `graph:${projectId}:${id}`;}
function taskSpec(raw:unknown,index:number): Task {
  const item=object(raw),id=item.id ? text(item.id,'任务标识',100) : `task-${index+1}`; const mode=item.mode === 'read' ? 'read' : 'write';
  if(item.workflowHeld!==undefined&&typeof item.workflowHeld!=='boolean')throw new CapabilityError('VALIDATION_ERROR','workflowHeld必须为布尔值');
  if(item.mode!==undefined&&item.mode!=='read'&&item.mode!=='write')throw new Error(`任务 ${id} 的 mode 必须是 read 或 write`);
  const scopes=item.writeScopes === undefined ? ['.'] : strings(item.writeScopes,`任务 ${id} 的写入范围：`);
  if (mode==='write'&&!scopes.length)throw new Error(`任务 ${id}：写入任务必须提供非空 writeScopes`);
  if (scopes.some(path=>isAbsolute(path) || !contains('/scope',resolve('/scope',path)))) throw new Error(`任务 ${id}：写入范围必须相对于成员工作区，不能越出工作区`);
  const prompt=text(item.prompt || item.title,'任务要求');return {constraints:item.constraints===undefined?undefined:strings(item.constraints).map(value=>text(value,'完整约束',100000)),unresolved:item.unresolved===undefined?undefined:strings(item.unresolved).map(value=>text(value,'未决问题',100000)),memberId:item.memberId?text(item.memberId,'队友标识',100):undefined,memberName:item.memberName?text(item.memberName,'队友名称',80):undefined,id,title:text(item.title,'任务标题',500),prompt,originalPrompt:prompt,requirementVersions:[{version:1,prompt,at:now()}],dependencies:item.dependencies === undefined ? [] : strings(item.dependencies),mode,expertId:item.expertId ? text(item.expertId,'专家标识',100):undefined,roleId:item.roleId?text(item.roleId,'角色标识',100):undefined,logicalStepId:item.logicalStepId?text(item.logicalStepId,'逻辑步骤标识',300):undefined,workflowHeld:item.workflowHeld===true,modelId:item.modelId?text(item.modelId,'模型标识',200):undefined,thinkingLevel:thinkingLevel(item.thinkingLevel),writeScopes:scopes,status:'pending',rework:0,resultRevision:0};
}
export function validateDAG(tasks:Task[]): void {
  const map=new Map(tasks.map(task=>[task.id,task]));if (map.size!==tasks.length) throw new Error('任务标识重复');
  const visiting=new Set<string>();const visited=new Set<string>();
  function visit(id:string): void {
    if (visiting.has(id)) throw new Error('任务依赖形成循环');if (visited.has(id)) return;
    const task=map.get(id);if (!task) throw new Error(`依赖任务不存在：${id}`);
    visiting.add(id);for (const dep of task.dependencies) visit(dep);visiting.delete(id);visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}
export function validateWriteRanges(tasks:Task[]):void {
  const {depends}=graphReachability(tasks),writers=tasks.filter(task=>task.mode==='write'&&task.status!=='skipped');
  for(let i=0;i<writers.length;i++)for(let j=i+1;j<writers.length;j++){
    const a=writers[i],b=writers[j];
    const overlaps=a.writeScopes.flatMap(x=>b.writeScopes.filter(y=>contains(resolve('/scope',x),resolve('/scope',y))||contains(resolve('/scope',y),resolve('/scope',x))).map(y=>[x,y]));
    if(overlaps.length&&!depends(a.id,b.id)&&!depends(b.id,a.id))throw new CapabilityError('VALIDATION_ERROR','并行写任务范围重叠，请声明依赖或缩小范围',{v:1,taskIds:[a.id,b.id],overlappingScopes:overlaps});
  }
}
function checkSpecs(input:unknown): Check[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('checks 必须是数组');
  return input.map(raw=>{const c=object(raw);const command=text(c.command,'检查程序',200);const args=c.args === undefined ? [] : strings(c.args); if (destructiveCommand([command,...args].join(' '))) throw new Error('验证检查不能包含破坏性或发布操作');return {command,args};});
}
/** Host context alone can authorize command checks; tool input cannot promote its origin. */
function assertCheckPolicy(graph:Pick<Graph,'tasks'|'checks'|'contract'>,ctx:PluginContext):void {
  if(ctx.origin!=='user'&&graph.tasks.length&&graph.tasks.every(task=>task.mode==='read')&&(graph.checks.length||graph.contract?.checks.some(check=>check.kind==='command')))
    throw new CapabilityError('PERMISSION_DENIED','只读协作不能安排或执行命令检查。保持只读，使用 read/grep/find/ls 与声明式检查核对原文；按合同完成必要的独立复核，不必改成写入任务。');
}
function productionLauncher(start:MemberStart,output:(message:MemberOutput)=>void,exited:(code:number|null)=>void): MemberHandle {
  const worker=process.env.FRIEND_PI_MEMBER_WORKER || fileURLToPath(new URL('./member.js',import.meta.url));
  if (!existsSync(worker)) throw new Error(`Swarm 成员运行器不存在：${worker}；请构建或完整安装 Swarm 包`);
  const groupOwned=process.platform!=='win32';const child=fork(worker,[],{cwd:start.cwd,detached:groupOwned,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,FRIEND_PI_DATA_DIR:start.dataDir,FRIEND_PI_AGENT_DIR:start.agentDir,ELECTRON_RUN_AS_NODE:'1'},execArgv:[]});
  const owned=ownChild(child,start.attemptId,'member',groupOwned,()=>{},1000);
  // Keep diagnostics bounded and never echo environment/configuration containing credentials.
  let diagnostics=''; child.stderr?.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-4000);});
  child.stdout?.resume();
  child.on('message',raw=>{if (raw && typeof raw==='object' && 'v' in raw && [1,2].includes(Number(raw.v))) output(raw as MemberOutput);});
  child.on('error',error=>output({v:1,type:'failed',error:error.message}));
  // close follows stdio/IPC drain; exit can race a queued settled frame.
  child.on('close',(code)=>{if (code && diagnostics) output({v:1,type:'failed',error:`成员进程退出（${code}），请查阅保留的会话与工作区`});exited(code);});
  try{child.send(start);}catch(error){void owned.stop();throw error;}
  return {pid:child.pid,groupOwned,closed:owned.ended,send:message=>{if (child.connected) child.send(message);},stop:()=>owned.stop(()=>{if(child.connected)child.send({v:1,type:'stop'});})};
}

interface Execution {abort:AbortController;operations:Map<string,{stop:()=>Promise<StopObject>;ended?:Promise<StopObject>}>;receipts:Map<string,StopObject>;activities:Set<Promise<unknown>>;stopping?:Promise<Graph>;context?:PluginContext}

/** Every entry point uses this controller. SQLite transactions serialize claims and revisions. */
export class SwarmController implements PluginController {
  private readonly stores=new Map<string,RecordStore>();
  private readonly nativeTaskLedgers=new Map<string,TaskLedger>();
  private readonly nativeServices=new Map<string,RuntimeCapabilityServices>();
  private readonly persistence=new Map<string,SwarmStorage>();
  private readonly rosters=new Map<string,TeammateStore>();
  private readonly runtime=randomUUID();
  private readonly leaseHeartbeats=new Map<string,ReturnType<typeof setInterval>>();
  private readonly members=new Map<string,{handle:MemberHandle;graphId:string;context:PluginContext}>();
  private readonly pumping=new Set<string>();
  private readonly resourceRetries=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly releasingAttempts=new Map<string,Promise<void>>();
  private readonly trialObserving=new Map<string,Promise<void>>();
  private readonly trialRetries=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly finishing=new Set<string>();
  private readonly preparing=new Set<string>();
  private readonly executions=new Map<string,Execution>();
  private readonly confirmations=new Map<string,(accepted:boolean)=>void>();
  private readonly confirmationOwners=new Map<string,string>();
  private nativeConfirm?: (title:string,message:string)=>Promise<boolean>;
  private disposed=false;
  constructor(private readonly launcher:MemberLauncher=productionLauncher) {}
  private async runtimeRequest(ctx:PluginContext,action:string,input:JsonObject):Promise<unknown>{if(ctx.policy)return ctx.request('runtime',action,input);if(['task.identity','task.repair.claimBatch','task.repair.claim'].includes(action)){let ledger=this.nativeTaskLedgers.get(ctx.dataDir);if(!ledger){ledger=new TaskLedger(ctx.dataDir);this.nativeTaskLedgers.set(ctx.dataDir,ledger);}return action==='task.identity'?ledger.resolveIdentity(input,ctx):action==='task.repair.claimBatch'?ledger.claimRepairBatch(input,ctx):ledger.claimRepair(input,ctx);}let service=this.nativeServices.get(ctx.dataDir);if(!service){service=new RuntimeCapabilityServices(ctx.dataDir);this.nativeServices.set(ctx.dataDir,service);}return service.dispatch(action,input,{...ctx,origin:'plugin'});}
  private async identify(tasks:Task[],ctx:PluginContext):Promise<void>{for(const task of tasks){const result=object(await this.runtimeRequest(ctx,'task.identity',{title:task.title,mode:task.mode,acceptance:[task.originalPrompt||task.prompt],logicalStepId:task.logicalStepId}));task.logicalStepId=text(result.logicalStepId);}}
  private registerChild(sessionId:string|undefined,file:string|undefined,cwd:string,ctx:PluginContext,sessionDir:string):void {if(!sessionId||!file||!existsSync(file)||!contains(sessionDir,file))throw new CapabilityError('SOURCE_UNAVAILABLE','成员原史尚未持久保存');const header=object(JSON.parse(readFileSync(file,'utf8').split('\n',1)[0])),nativeCwd=text(header.cwd);const workspaces=join(ctx.policy?.temporaryWriteRoot||ctx.dataDir,'swarm-workspaces',ctx.projectId);if(realpathSync(nativeCwd)!==realpathSync(ctx.projectDir)&&!contains(workspaces,nativeCwd)&&realpathSync(nativeCwd)!==realpathSync(cwd))throw new CapabilityError('SOURCE_UNAVAILABLE','成员原史工作区未核验');registerSourceSession({sessionId,path:file,projectDir:ctx.projectDir,nativeCwd},ctx.dataDir);}
  private storage(ctx:PluginContext):SwarmStorage {this.store(ctx);return this.persistence.get(ctx.dataDir)!;}
  private artifacts(ctx:PluginContext):Artifacts {return new Artifacts(this.store(ctx),(a,c)=>this.storage(c).enqueue('swarm.artifact.changed',a.graphId,a.revision,c,{artifactId:a.artifactId}));}
  private operations(ctx:PluginContext):Operations {return new Operations(this.store(ctx),(op,c)=>this.storage(c).enqueue('swarm.operation.changed',op.graphId,op.revision,c,{operationId:op.id,status:op.status}));}
  private fence(graph:Graph,ctx:PluginContext):void {if(graph.sourceFence)new SourcePolicy(this.store(ctx)).assert(graph.sourceFence);}
  private bindDependencies(id:string,attemptId:string,dependencies:CapabilityDependency[],sources:import('@friend-pi/core').SourceRef[],ctx:PluginContext):void {this.update(id,ctx,g=>{const previous=g.sourceFence,refs=[...(previous?.dependencies||[]),...dependencies];const unique=[...new Map(refs.map(r=>[digest(r),r])).values()];const fence=new SourcePolicy(this.store(ctx)).capture({projectId:ctx.projectId,sources:[...new Map([...(previous?.sources||[]),...sources].map(r=>[digest(r),r])).values()],dependencies:unique,artifacts:previous?.artifacts||[]});g.sourceFence=fence;const attempt=g.attempts.find(a=>a.id===attemptId)!;attempt.sourceFence=fence;if(attempt.frozen){attempt.frozen.memoryRefs=unique.filter(d=>d.capability==='memory');attempt.frozen.expertRefs=unique.filter(d=>d.capability==='expert');attempt.frozen.dependencyEpoch=fence.sourceEpoch;}});}
  private async usage(id:string,attemptId:string,entryId:string,tokens:number|undefined,ctx:PluginContext):Promise<void>{const graph=this.get(id,ctx).value;if(graph.budget){const budget=await new Budget(this.store(ctx)).usage(graph.budget,id,attemptId,entryId,tokens,ctx);this.update(id,ctx,g=>{g.budget=budget;});this.storage(ctx).enqueue('swarm.budget.changed',id,this.get(id,ctx).revision,ctx,{budget});}const memberId=graph.attempts.find(a=>a.id===attemptId)?.memberId||(graph.reviewAttempts?.some(a=>a.attemptId===attemptId)?attemptId:undefined);ctx.emit('swarm.member-usage',{v:1,graphId:id,memberId,attemptId,entryId,tokens,runId:graph.runId});}
  private pauseError(id:string,error:unknown,ctx:PluginContext):void {const e=normalizeCapabilityError(error);this.update(id,ctx,g=>{g.status='paused';g.error=e.error;g.pauseReason={code:e.code,message:e.error};});this.changed(ctx);}
  private verification(record:VerificationRecord,ctx:PluginContext):void {this.store(ctx).transaction(()=>{this.store(ctx).db.prepare('INSERT INTO swarm_verification VALUES(?,?,?,?,?,?) ON CONFLICT(verification_id) DO UPDATE SET status=excluded.status,json=excluded.json').run(record.id,record.graphId,record.candidateDigest,record.contractDigest,record.status,JSON.stringify(record));this.update(record.graphId,ctx,g=>{g.integration!.verification=record;});this.storage(ctx).enqueue('swarm.verification.changed',record.graphId,this.get(record.graphId,ctx).revision,ctx,{verificationId:record.id,status:record.status});});}
  private roster(ctx:PluginContext):TeammateStore {
    let roster=this.rosters.get(ctx.dataDir);if(roster)return roster;
    roster=new TeammateStore(this.store(ctx));this.rosters.set(ctx.dataDir,roster);
    for(const member of roster.list(ctx))if(['provisioning','running','stopping'].includes(member.state)&&(!member.ownerPid||!alive(member.ownerPid)))roster.update(member.id,ctx,m=>{m.state='paused';m.generation++;m.reason='原运行时已结束；现场未知，消息保留，未重放';});
    return roster;
  }
  private memberContext(attempt:Attempt,graph:Graph,ctx:PluginContext,terminal=false):import('@friend-pi/core').TrustedPluginContext {
    const current=this.get(graph.id,ctx).value;if(current.tasks.find(t=>t.id===attempt.taskId)?.currentAttempt!==attempt.id||!terminal&&current.attempts.find(a=>a.id===attempt.id)?.status!=='running')throw new CapabilityError('CANCELLED','成员尝试已失效');
    if(!terminal&&attempt.memberId&&!this.roster(ctx).owns(this.roster(ctx).get(attempt.memberId,ctx),attempt.id,attempt.generation))throw new CapabilityError('CANCELLED','成员代次已失效');
    const file=terminal?attempt.sessionFile:attempt.memberId?this.roster(ctx).trustedFile(this.roster(ctx).get(attempt.memberId,ctx),ctx):attempt.sessionFile;
    const root=attempt.memberId?join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,attempt.memberId):join(ctx.dataDir,'swarm-sessions',graph.id,attempt.id);
    if(!file||!existsSync(file)||!contains(root,file))throw new CapabilityError('SOURCE_UNAVAILABLE','成员原史路径尚未核验');
    this.registerChild(attempt.sessionId,file,attempt.cwd,ctx,root);
    return {runId:attempt.id,memberId:attempt.memberId||attempt.id,taskId:attempt.taskId,taskScope:digest(graph.id),inputHash:memberNativeInput(nativeBranch(file),graph,attempt),findJournalEntry:operationId=>{const current=this.get(graph.id,ctx).value.attempts.find(a=>a.id===attempt.id);if(current?.status!=='running')throw new CapabilityError('CANCELLED','成员尝试已失效');if(current.memberId&&!this.roster(ctx).owns(this.roster(ctx).get(current.memberId,ctx),attempt.id,current.generation))throw new CapabilityError('CANCELLED','成员代次已失效');for(const raw of [...nativeBranch(file)].reverse()){const entry=object(raw);if(entry.type==='custom'&&entry.data&&typeof entry.data==='object'&&object(entry.data).operationId===operationId)return {entryId:String(entry.id),customType:String(entry.customType),data:entry.data};}return undefined;}};
  }
  private admitMemberChecks(id:string,attemptId:string,ctx:PluginContext,locator?:{entryId:string;operationId:string},terminal=false):void {
    const graph=this.get(id,ctx).value,attempt=graph.attempts.find(a=>a.id===attemptId);if(!attempt||graph.tasks.find(t=>t.id===attempt.taskId)?.currentAttempt!==attemptId)throw new CapabilityError('CANCELLED','成员检查对应的尝试已失效');
    const member=attempt.memberId?this.roster(ctx).get(attempt.memberId,ctx):undefined,file=terminal?attempt.sessionFile:member?this.roster(ctx).trustedFile(member,ctx):attempt.sessionFile;
    // Terminal retries read the sealed attempt's exact file/run, even after its teammate is released.
    if(terminal&&attempt.exitReceipt?.status!=='terminated'||!terminal&&member&&(member.attemptId!==attempt.id||member.generation!==attempt.generation))throw new CapabilityError('CANCELLED','成员检查对应的代次已失效');
    const sessionDir=attempt.memberId?join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,attempt.memberId):join(ctx.dataDir,'swarm-sessions',id,attemptId);
    this.registerChild(attempt.sessionId,file,attempt.cwd,ctx,sessionDir);const entries=nativeBranch(file!);
    if(locator&&!entries.some(raw=>{const e=object(raw);return e.id===locator.entryId&&e.type==='custom'&&e.customType===nativeCheckType&&object(e.data).operationId===locator.operationId&&object(e.data).runId===attemptId;}))throw new CapabilityError('SOURCE_UNAVAILABLE','成员检查通知没有原生回执');
    const checks=readMemberChecks(entries,graph,attempt,attempt.sessionId!,terminal);for(const check of checks)new SourcePolicy(this.store(ctx)).registerCheck(check);
    this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.nativeChecks=checks.map(c=>c.ref);});
  }
  private async observeMemberTrial(id:string,attemptId:string,outcome:'completed'|'failed'|'cancelled'|'unknown',ctx:PluginContext):Promise<void> {
    if(this.disposed)return;const pending=this.trialObserving.get(attemptId);if(pending){await pending;if(!this.disposed)return this.observeMemberTrial(id,attemptId,outcome,ctx);return;}const work=this.observeMemberTrialOnce(id,attemptId,outcome,ctx);this.trialObserving.set(attemptId,work);try{await work;}finally{this.trialObserving.delete(attemptId);}
  }
  private async observeMemberTrialOnce(id:string,attemptId:string,outcome:'completed'|'failed'|'cancelled'|'unknown',ctx:PluginContext):Promise<void> {
    let graph=this.get(id,ctx).value,attempt=graph.attempts.find(a=>a.id===attemptId);if(!attempt||!trialAdoptions(attempt).length)return;
    if(attempt.trialTerminalOutcome==='cancelled')outcome='cancelled';else if(attempt.exitReceipt?.status==='terminated'&&(attempt.trialTerminalOutcome==='completed'||attempt.trialTerminalOutcome==='failed'))outcome=attempt.trialTerminalOutcome;let key='',attempts=0,requested=false;try{
      if(outcome==='completed'||outcome==='failed'){if(attempt.exitReceipt?.status!=='terminated'||graph.tasks.find(t=>t.id===attempt!.taskId)?.currentAttempt!==attemptId)throw new CapabilityError('OPERATION_UNKNOWN','成员尚无可靠终态，试运行保持等待');this.admitMemberChecks(id,attemptId,ctx,undefined,true);graph=this.get(id,ctx).value;attempt=graph.attempts.find(a=>a.id===attemptId)!;}
      const checks=attempt.nativeChecks||[];key=`swarm:${digest([attemptId,outcome,checks])}`;const previous=attempt.trialObservation?.key===key?attempt.trialObservation:undefined;if(previous?.status==='observed'||previous&&((previous.attempts||0)>=3||previous.retryAt&&previous.retryAt>Date.now()))return;attempts=(previous?.attempts||0)+1;
      if(!ctx.requestWithContext)throw new CapabilityError('CAPABILITY_UNAVAILABLE','宿主没有可信成员试运行通道');
      const trusted=this.memberContext(attempt,graph,ctx,true);requested=true;const result=await ctx.requestWithContext('expert','trial.observe',{runId:attempt.id,taskId:attempt.taskId,checks,outcome,key},trusted,1500);
      const settled=object(result).settled;this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.trialObservation={key,outcome,attempts,status:Array.isArray(settled)&&settled.length?'observed':'waiting',result};});
    }catch(error){const retryAt=requested&&attempts<3?Date.now()+(attempts===1?250:1000):undefined;this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.trialObservation={key,outcome,attempts,retryAt,status:'waiting',error:errorText(error)};});if(retryAt)this.retryMemberTrial(id,attemptId,outcome,retryAt,ctx);ctx.notify(`成员试运行证据保持等待：${errorText(error)}`,'warning');}
  }
  private retryMemberTrial(id:string,attemptId:string,outcome:'completed'|'failed'|'cancelled'|'unknown',retryAt:number,ctx:PluginContext):void {
    if(this.trialRetries.has(attemptId)||this.disposed)return;const timer=setTimeout(()=>{this.trialRetries.delete(attemptId);if(!this.disposed)void this.observeMemberTrial(id,attemptId,outcome,ctx).then(()=>this.changed(ctx)).catch(()=>{});},Math.max(0,retryAt-Date.now()));timer.unref();this.trialRetries.set(attemptId,timer);
  }
  private async memberAction(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    const roster=this.roster(ctx);
    if(action==='list')return {teammates:roster.list(ctx)};
    if(action==='create'){assertExecution(ctx,'swarm');const member=roster.create(input,ctx);this.changed(ctx);return member;}
    const id=text(input.memberId,'队友标识',100),member=roster.get(id,ctx);
    if(action==='history')return roster.history(id,ctx);
    if(action==='send'){
      if((ctx.policy?.executionMode??ctx.executionMode)&&(ctx.policy?.executionMode??ctx.executionMode)!=='swarm'||ctx.policy?.planMode)throw new Error('请在 Swarm 执行模式补充成员要求');
      const message=roster.enqueue(id,input,ctx,ctx.origin==='user'?'你':'主 Agent');this.changed(ctx);
      if(ctx.policy?.executionStopped){roster.update(id,ctx,m=>{if(m.state==='idle'){m.state='paused';m.stopReceipt={id:m.id,kind:'member',status:'terminated'};}m.reason=ctx.policy?.executionWaitReason||'当前执行已停止，消息已保存';});this.changed(ctx);}
      else void this.wakeOrDeliver(id,ctx).catch(error=>{roster.update(id,ctx,m=>{if(m.state==='idle'){m.state='paused';m.stopReceipt={id:m.id,kind:'member',status:'terminated'};}m.reason=errorText(error);});this.changed(ctx);});
      if(ctx.origin==='user')ctx.emit('swarm.member-supplement',{v:1,memberId:id,messageId:message.id,graphId:member.graphId,runId:ctx.runId});
      return message;
    }
    if(action==='interrupt'){if(input.generation!==undefined&&input.generation!==member.generation)throw new ConflictError('队友执行代次已变化');return this.interruptMember(id,ctx);}
    if(action==='resume'){
      assertExecution(ctx,'swarm');if(ctx.origin!=='user')throw new Error('成员中断接续必须由用户发起');
      if(member.state==='running'||member.state==='stopping'||member.stopReceipt?.status==='unknown')throw new Error('成员尚无明确退出收据，请等待或检查原进程');
      if(member.state==='paused'&&input.confirmUnknown!==true)throw new Error('请检查保留的工作树和会话，并以 confirmUnknown:true 启动新尝试');
      if(member.attemptId&&this.members.has(member.attemptId))throw new Error('成员尚无退出收据');
      if(member.state==='paused'&&member.sessionFile&&!member.stopReceipt)throw new Error('中断现场缺少原成员退出收据，继续保留，不并发打开原会话');
      const graph=member.graphId?this.get(member.graphId,ctx).value:undefined,task=graph?.tasks.find(item=>item.id===member.taskId);
      if(graph&&this.execution(graph.id).abort.signal.aborted){const run=this.execution(graph.id);if(run.operations.size||run.activities.size)throw new Error('整轮停止尚未到安全边界');this.executions.delete(graph.id);}
      if(graph&&task?.mode==='write'&&graph.baseline&&(await this.git(graph.id,graph.baseline.repoRoot,['status','--porcelain'],ctx)||await this.git(graph.id,graph.baseline.repoRoot,['rev-parse','HEAD'],ctx)!==graph.baseline.head))throw new Error('原项目基线或工作区已变化，成果保留');
      roster.update(id,ctx,m=>{m.state='idle';m.attemptId=undefined;m.reason=undefined;});
      if(graph&&task?.status==='unknown'){
        this.update(graph.id,ctx,g=>{const current=g.tasks.find(item=>item.id===task.id)!;current.resumeFromAttempt=current.currentAttempt;current.status='pending';current.currentAttempt=undefined;g.status='running';g.error=undefined;g.executionOwner={pid:process.pid,runtime:this.runtime};});
        void this.track(graph.id,this.pump(graph.id,ctx));
      }else void this.wakeOrDeliver(id,ctx).catch(error=>{roster.update(id,ctx,m=>{if(m.state==='idle'){m.state='paused';m.stopReceipt={id:m.id,kind:'member',status:'terminated'};}m.reason=errorText(error);});this.changed(ctx);});
      this.changed(ctx);return roster.get(id,ctx);
    }
    throw new Error('未知队友动作：'+action);
  }
  private deliverTeammate(id:string,ctx:PluginContext):void {
    const roster=this.roster(ctx),member=roster.get(id,ctx);if(member.state!=='running'||!member.attemptId||!member.sessionId)return;
    const handle=this.members.get(member.attemptId)?.handle;if(!handle)return;
    roster.recover(id,ctx);
    for(const message of roster.messages(id,ctx))if(!message.processedAt)handle.send({v:2,type:'steer',messageId:message.id,text:message.body,bodyDigest:message.bodyDigest,memberId:id,attemptId:member.attemptId,generation:member.generation});
  }
  private async wakeOrDeliver(id:string,ctx:PluginContext):Promise<void> {
    const roster=this.roster(ctx),member=roster.get(id,ctx);if(member.state==='running'){this.deliverTeammate(id,ctx);return;}
    if(member.state!=='idle'||ctx.policy?.executionStopped||ctx.policy?.planMode)return;
    await roster.serialize(id,async()=>{
      const latest=roster.get(id,ctx);roster.recover(id,ctx);if(latest.state!=='idle'||!roster.messages(id,ctx).some(message=>!message.processedAt))return;
      if(!latest.graphId){roster.update(id,ctx,m=>{m.reason='队友尚未获分配任务，消息已保存';});this.changed(ctx);return;}
      const graph=this.get(latest.graphId,ctx).value;this.execution(graph.id).context=ctx;
      if(graph.tasks.some(task=>task.memberId===id&&['pending','running','unknown','blocked'].includes(task.status)))return;
      const attemptId=randomUUID(),lease=roster.acquire(id,attemptId,graph.id,latest.taskId||'discussion',ctx,this.runtime,true);
      const start:MemberStart={v:2,type:'start',memberId:id,rootSessionId:ctx.sessionId,generation:lease.generation,graphId:graph.id,taskId:lease.taskId!,attemptId,cwd:ctx.projectDir,dataDir:ctx.dataDir,agentDir:ctx.agentDir||graph.agentDir||agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,id),nativeSessionFile:lease.sessionFile?roster.trustedFile(lease,ctx):undefined,modelId:ctx.modelId||lease.modelId||graph.modelId,thinkingLevel:ctx.thinkingLevel||lease.thinkingLevel||graph.thinkingLevel,mode:'read',writeScopes:[],executionStyle:'swarm',discussion:true,parentTools:[...['read','grep','find','ls'].filter(tool=>!ctx.policy||ctx.policy.tools.includes(tool)),'swarm_message'],permissionMode:ctx.policy?.permissionMode,temporaryWriteRoot:ctx.policy?.temporaryWriteRoot,prompt:'继续只读讨论补充要求。成果修改须用 swarm_message 发给 parent，由主 Agent 创建新尝试；不能修改文件、共享材料或派生成员。'};
      roster.update(id,ctx,m=>{m.cwd=start.cwd;m.modelId=start.modelId;m.thinkingLevel=start.thinkingLevel;});
      let handle:MemberHandle|undefined;
      try{
        await this.track(graph.id,new Promise<void>((resolveDiscussion,reject)=>{
          let done=false;const timer=setTimeout(()=>finish(new Error('成员讨论超时，消息和现场保留')),120000);
          const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolveDiscussion();};
          handle=this.launcher(start,message=>{
            if(message.protocol!==2||message.memberId!==id||message.generation!==lease.generation||message.attemptId!==attemptId||!roster.owns(roster.get(id,ctx),attemptId,lease.generation))return;
            if(message.type==='ready'){roster.update(id,ctx,m=>{m.sessionId=message.sessionId;m.sessionFile=message.sessionFile;});this.deliverTeammate(id,ctx);}
            if(message.type==='event')ctx.emit('swarm.member-event',{v:1,graphId:graph.id,memberId:id,attemptId,generation:lease.generation,event:message.event});
            if(message.type==='usage')ctx.emit('swarm.member-usage',{v:1,graphId:graph.id,memberId:id,attemptId,entryId:message.entryId,tokens:message.tokens,runId:ctx.runId});
            if(message.type==='request'){
              if(message.action==='send'&&message.input.to==='parent'){ctx.emit('swarm.member-request',{v:1,graphId:graph.id,memberId:id,attemptId,runId:ctx.runId,body:text(message.input.body)});handle?.send({v:1,type:'request.response',requestId:message.requestId,result:{saved:true}});}
              else handle?.send({v:1,type:'request.response',requestId:message.requestId,error:'完成后的补充讨论只读，修改由主 Agent 安排'});
            }
            if(message.type==='confirm')handle?.send({v:1,type:'confirm.response',requestId:message.requestId,accepted:false});
            if(message.type==='settled'){ctx.emit('swarm.member-request',{v:1,graphId:graph.id,memberId:id,attemptId,runId:ctx.runId,body:'用户补充后的只读讨论结果：'+message.summary});finish();}if(message.type==='failed')finish(new Error(message.error));this.changed(ctx);
          },()=>{if(!done)finish(new Error('成员讨论进程中断，未自动重放'));});
          this.members.set(attemptId,{handle,graphId:graph.id,context:ctx});this.memberOwned(graph.id,attemptId,handle,ctx);this.changed(ctx);
        }));
        if(handle?.closed)await handle.closed;
        if(!roster.owns(roster.get(id,ctx),attemptId,lease.generation))return;
        roster.release(id,attemptId,ctx);this.members.delete(attemptId);this.changed(ctx);setImmediate(()=>void this.wakeOrDeliver(id,ctx).catch(()=>{}));
      }catch(error){if(!roster.owns(roster.get(id,ctx),attemptId,lease.generation))return;if(handle)await this.interruptMember(id,ctx);else roster.update(id,ctx,m=>{if(m.attemptId===attemptId){m.state='paused';m.stopReceipt={id:attemptId,kind:'member',status:'terminated',detail:'运行器未创建进程'};m.reason=errorText(error);}});this.changed(ctx);throw error;}
    });
  }
  private async interruptMember(id:string,ctx:PluginContext):Promise<Teammate> {
    const roster=this.roster(ctx),member=roster.get(id,ctx),attemptId=member.attemptId;
    roster.update(id,ctx,m=>{m.state='stopping';m.generation++;m.reason='用户停止成员，消息保留';});this.changed(ctx);
    if(member.graphId&&!member.discussion){this.update(member.graphId,ctx,g=>{const attempt=g.attempts.find(item=>item.id===attemptId);if(attempt?.status==='running'){attempt.status='unknown';attempt.error='用户停止该成员，现场保留';const task=g.tasks.find(item=>item.currentAttempt===attemptId);if(task)task.status='unknown';}});}
    const handle=attemptId?this.members.get(attemptId)?.handle:undefined;
    const receipt=handle?await handle.stop():{id:attemptId||id,kind:'member' as const,status:attemptId?'unknown' as const:'terminated' as const,detail:attemptId?'成员仍在启动或退出收据未知，现场保留':undefined};
    const accepted=receipt||{id,kind:'member' as const,status:'unknown' as const};
    roster.update(id,ctx,m=>{m.state=accepted.status==='terminated'?'paused':'stopping';m.stopReceipt=accepted;m.reason=accepted.status==='terminated'?'成员已暂停；检查现场后明确接续':'退出收据未知，等待原成员终止';});
    if(accepted.status==='terminated'&&attemptId)this.members.delete(attemptId);
    else if(handle?.closed&&attemptId)void handle.closed.then(closed=>{if(this.disposed||closed.status!=='terminated')return;roster.update(id,ctx,m=>{if(m.attemptId===attemptId){m.state='paused';m.stopReceipt=closed;}});this.members.delete(attemptId);this.changed(ctx);});
    if(member.graphId&&!member.discussion){const graph=this.get(member.graphId,ctx).value;if(graph.status==='running'&&graph.tasks.some(task=>task.status==='unknown'||task.status==='blocked')&&!graph.attempts.some(attempt=>attempt.status==='running'))this.update(graph.id,ctx,g=>{g.status='paused';g.error='成员已暂停，依赖任务等待接续';});}
    this.changed(ctx);return roster.get(id,ctx);
  }
  private execution(id:string):Execution {let run=this.executions.get(id);if(!run){run={abort:new AbortController(),operations:new Map(),receipts:new Map(),activities:new Set()};this.executions.set(id,run);}return run;}
  private track<T>(id:string,promise:Promise<T>):Promise<T> {const run=this.execution(id);run.activities.add(promise);void promise.then(()=>run.activities.delete(promise),()=>run.activities.delete(promise));return promise;}
  private own(id:string,operation:{id:string;stop:()=>Promise<StopObject>;ended?:Promise<StopObject>}):void {const run=this.execution(id);run.operations.set(operation.id,operation);if(operation.ended)void operation.ended.then(receipt=>{run.receipts.set(operation.id,receipt);run.operations.delete(operation.id);});}
  private memberOwned(id:string,attemptId:string,handle:MemberHandle,ctx:PluginContext):void {
    const clearHeartbeat=()=>{const timer=this.leaseHeartbeats.get(attemptId);if(timer)clearInterval(timer);this.leaseHeartbeats.delete(attemptId);};
    const resource=this.get(id,ctx).value.attempts.find(attempt=>attempt.id===attemptId)?.resourceReservationId;
    if(resource){let checking=false;const timer=setInterval(()=>{if(this.disposed||!this.members.has(attemptId)||this.get(id,ctx).value.attempts.find(attempt=>attempt.id===attemptId)?.status!=='running'){clearHeartbeat();return;}if(checking)return;checking=true;void this.runtimeRequest(ctx,'resource.check',{reservationId:resource}).then(()=>{this.fence(this.get(id,ctx).value,ctx);}).catch(async error=>{clearHeartbeat();await this.fail(id,attemptId,error,ctx,true);}).catch(()=>{this.changed(ctx);}).finally(()=>{checking=false;});},20000);timer.unref();this.leaseHeartbeats.set(attemptId,timer);}
    this.own(id,{id:attemptId,ended:handle.closed,stop:async()=>{try{return await handle.stop()||{id:attemptId,kind:'member',status:'unknown',pid:handle.pid,detail:'成员适配器没有提供退出回执'};}finally{clearHeartbeat();}}});
    if(handle.closed)void handle.closed.finally(clearHeartbeat);
    const inform=(action:'started'|'closed')=>{if(handle.pid)try{ctx.emit('swarm.process',{v:1,graphId:id,operationId:attemptId,kind:'member',action,pid:handle.pid,groupOwned:!!handle.groupOwned});}catch{/* Retain local ownership even when a subscriber fails. */}};inform('started');
    if(handle.closed)void handle.closed.then(receipt=>{inform('closed');if(this.disposed||receipt.status!=='terminated')return;const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId);if(attempt&&['failed','unknown'].includes(attempt.status)){this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.exitReceipt=receipt;});void this.releaseAttemptReservations(id,attemptId,ctx).then(()=>this.observeMemberTrial(id,attemptId,attempt.trialTerminalOutcome||'unknown',ctx)).then(()=>this.changed(ctx)).catch(()=>this.changed(ctx));}const teammate=this.roster(ctx).list(ctx).find(member=>member.attemptId===attemptId&&member.state==='stopping');if(teammate){this.roster(ctx).update(teammate.id,ctx,m=>{if(m.attemptId===attemptId&&m.state==='stopping'){m.state='paused';m.stopReceipt=receipt;}});this.members.delete(attemptId);this.changed(ctx);}});
  }
  private signal(id:string,ctx:PluginContext):AbortSignal {const run=this.execution(id);run.context=ctx;const signal=run.abort.signal;return ctx.signal?AbortSignal.any([signal,ctx.signal]):signal;}
  private async git(id:string,cwd:string,args:string[],ctx:PluginContext):Promise<string> {
    const result=await managedCommand('git',args,cwd,this.signal(id,ctx),ctx,id,'git',operation=>this.own(id,operation));
    if(result.cancelled)throw new CancelledError();if(result.exitCode!==0)throw new Error(`Git 操作失败：${args[0]}；${result.stderr.slice(-2000)}`);return result.stdout.trim();
  }
  private async stop(id:string,ctx:PluginContext,pause=false,reason?:string):Promise<Graph> {
    const run=this.execution(id);if(run.stopping)return run.stopping;
    const original=this.get(id,ctx).value;if(original.status==='integrated')throw new Error('已整合成果不能停止');const owner=original.executionOwner;if(owner&&owner.runtime!==this.runtime&&alive(owner.pid)&&(!['paused','stopped'].includes(original.status)||!original.stopReceipt?.objects.every(receipt=>receipt.status==='terminated')))throw new Error('任务仍由另一个存活运行时持有；请在原运行时停止，不能冒充已终止');
    run.stopping=(async()=>{
      const operationId=randomUUID(),requestedAt=now();for(const member of this.roster(ctx).list(ctx))if(member.graphId===id&&(member.state==='provisioning'||member.state==='running'||member.state==='idle'))this.roster(ctx).update(member.id,ctx,m=>{m.stopReceipt=m.state==='idle'?{id:m.id,kind:'member',status:'terminated'}:undefined;m.state=m.state==='idle'?'paused':'stopping';m.generation++;m.reason='用户停止整轮 Swarm，消息保留';});
      this.update(id,ctx,g=>{if(g.status==='integrated')throw new Error('已整合成果不能停止');g.status='stopping';for(const attempt of g.attempts)if(attempt.status==='running'){attempt.status='unknown';attempt.trialTerminalOutcome='cancelled';attempt.error='用户中断；工具副作用未重放';const task=g.tasks.find(t=>t.currentAttempt===attempt.id);if(task)task.status='unknown';}for(const attempt of g.reviewAttempts||[])if(attempt.status==='running'){attempt.status='unknown';attempt.error='用户中断独立复核；结果未采用';}});this.changed(ctx);run.abort.abort();
      for(const [confirmationId,resolver] of this.confirmations)if(this.confirmationOwners.get(confirmationId)===id)resolver(false);
      const stopped=await Promise.allSettled([...run.operations.values()].map(operation=>operation.stop()));
      let receipts=stopped.map((result,index)=>result.status==='fulfilled'?result.value:{id:`stop-${index}`,kind:'activity' as const,status:'unknown' as const,detail:errorText(result.reason)});
      if(owner?.runtime!==this.runtime)receipts.push(...(original.stopReceipt?.objects.filter(receipt=>receipt.status==='unknown')||[]));
      for(const receipt of receipts){if(receipt.status==='terminated')run.operations.delete(receipt.id);run.receipts.set(receipt.id,receipt);}
      let timer:ReturnType<typeof setTimeout>|undefined;
      const activities=await Promise.race([Promise.allSettled([...run.activities]).then(()=>true),new Promise<false>(done=>{timer=setTimeout(()=>done(false),5000);})]);if(timer)clearTimeout(timer);
      const merged=new Map(receipts.map(receipt=>[receipt.id,receipt]));for(const receipt of run.receipts.values())if(receipt.status==='terminated'||!merged.has(receipt.id))merged.set(receipt.id,receipt);for(const attempt of this.get(id,ctx).value.attempts)if(!merged.has(attempt.id)&&attempt.status!=='completed'){merged.set(attempt.id,attempt.exitReceipt||{id:attempt.id,kind:'member',status:activities&&attempt.ownerRuntime===this.runtime&&!attempt.childCreationStarted?'terminated':'unknown',detail:'启动活动与成员退出边界对账'});}receipts=[...merged.values()];
      if(activities&&!receipts.some(r=>r.status==='unknown')&&!this.operations(ctx).list(id).some(op=>['dispatched','unknown'].includes(op.status))){for(const attempt of original.attempts){if(attempt.resourceReservationId)try{await this.runtimeRequest(ctx,'resource.release',{reservationId:attempt.resourceReservationId});}catch(error){receipts.push({id:attempt.resourceReservationId,kind:'activity',status:'unknown',detail:errorText(error)});}if(original.budget&&attempt.budgetReservationId)await new Budget(this.store(ctx)).release(this.get(id,ctx).value.budget!,attempt.budgetReservationId,ctx);}if(original.integration?.applyReservationId&&!this.store(ctx).db.prepare("SELECT 1 FROM swarm_file_applications WHERE operation_id=? AND status='unknown'").get(`apply:${id}:${original.integration.candidateDigest}`))try{await this.runtimeRequest(ctx,'resource.release',{reservationId:original.integration.applyReservationId});}catch(error){receipts.push({id:original.integration.applyReservationId,kind:'activity',status:'unknown',detail:errorText(error)});}}
      for(const operation of this.operations(ctx).list(id))if(['dispatched','unknown'].includes(operation.status))receipts.push({id:operation.id,kind:'activity',status:'unknown',detail:'外部操作结果未知，取消连接不撤销远端效果'});
      if(!activities)receipts.push({id:operationId,kind:'activity',status:'unknown',detail:'取消后仍有后台活动未到安全边界'});
      for(const [attemptId,member] of this.members)if(member.graphId===id){const receipt=receipts.find(item=>item.id===attemptId);if(receipt?.status==='terminated')this.members.delete(attemptId);}
      for(const member of this.roster(ctx).list(ctx))if(member.graphId===id&&member.state==='stopping'){const receipt=receipts.find(item=>item.id===member.attemptId);this.roster(ctx).update(member.id,ctx,m=>{m.state=receipt?.status==='terminated'?'paused':'stopping';m.stopReceipt=receipt||{id:m.attemptId||m.id,kind:'member',status:'unknown'};});}
      const graph=this.update(id,ctx,g=>{g.stopReceipt={operationId,requestedAt,finishedAt:now(),objects:receipts,unknownAttemptIds:g.attempts.filter(a=>a.status==='unknown').map(a=>a.id)};g.status=pause||receipts.some(receipt=>receipt.status==='unknown')?'paused':'stopped';g.error=receipts.some(receipt=>receipt.status==='unknown')?`停止尚无完整退出回执；现场保留，请检查后显式接续${reason?`；${reason}`:''}`:reason;});for(const attempt of original.attempts.filter(a=>a.status==='running'))await this.observeMemberTrial(id,attempt.id,'cancelled',ctx);this.changed(ctx);return this.get(id,ctx).value;
    })();return run.stopping;
  }
  setConfirmationHandler(handler:(title:string,message:string)=>Promise<boolean>): void {this.nativeConfirm=handler;}
  private store(ctx:PluginContext): RecordStore {
    let store=this.stores.get(ctx.dataDir);if (store) return store;
    store=new RecordStore('swarm',ctx.dataDir);this.stores.set(ctx.dataDir,store);this.persistence.set(ctx.dataDir,new SwarmStorage(store));
    // Crash recovery never replays tools. A live owner process retains authority over its attempts.
    for (const doc of store.list<Graph>('graph:')) {
      let changed=false;
      for (const attempt of doc.value.attempts) if (attempt.status==='running' && !alive(attempt.ownerPid)) {
        attempt.status='unknown';attempt.error='原成员进程已结束；副作用未知，需显式接续';
        const task=doc.value.tasks.find(t=>t.currentAttempt===attempt.id);if (task) task.status='unknown';changed=true;
      }
      for(const attempt of doc.value.reviewAttempts||[])if(attempt.status==='running'&&(!doc.value.executionOwner||!alive(doc.value.executionOwner.pid))){attempt.status='unknown';attempt.error='复核运行时已结束，结果未采用';changed=true;}
      if (changed) {if(doc.value.integration?.verification){doc.value.integration.verification.status='stale';}doc.value.pauseReason={code:'OPERATION_UNKNOWN',message:'中断执行现场未知，未重放'};doc.value.status='paused';doc.value.error='检测到中断任务，尚未自动重放';store.put(doc.key,doc.value,doc.revision);}
      else if(doc.value.status==='stopping'&&(!doc.value.executionOwner||!alive(doc.value.executionOwner.pid))){doc.value.status='paused';doc.value.error='停止期间原运行时中断，退出回执未知；现场保留，需检查后显式接续';doc.value.stopReceipt={operationId:randomUUID(),requestedAt:doc.value.updatedAt,finishedAt:now(),objects:[{id:'interrupted-stop',kind:'activity',status:'unknown',detail:doc.value.error}],unknownAttemptIds:doc.value.attempts.filter(attempt=>attempt.status==='unknown').map(attempt=>attempt.id)};store.put(doc.key,doc.value,doc.revision);}
    }
    for(const doc of store.list<import('./types.js').SharedConflict>('shared-conflict:'))if(doc.value.status==='pending'&&(!doc.value.ownerPid||!alive(doc.value.ownerPid))){doc.value.status='paused';doc.value.reason='合并运行时已结束；三方材料保留，未自动重放合并';store.put(doc.key,doc.value,doc.revision);}
    this.operations(ctx).recover(ctx);return store;
  }
  private get(id:string,ctx:PluginContext): StoredDocument<Graph> {
    const doc=this.store(ctx).get<Graph>(graphKey(ctx.projectId,id));if (!doc || doc.value.sessionId!==ctx.sessionId) throw new Error('任务图不存在或不属于当前会话');return doc;
  }
  private update(id:string,ctx:PluginContext,change:(graph:Graph)=>void): Graph {
    return this.store(ctx).transaction(()=>{const doc=this.get(id,ctx);change(doc.value);doc.value.updatedAt=now();this.store(ctx).put(doc.key,doc.value,doc.revision);return doc.value;});
  }
  private changed(ctx:PluginContext): void {try{const snapshot=this.snapshot(ctx) as {graphs:(Graph&{revision:number})[]};this.storage(ctx).projection(ctx,snapshot.graphs);ctx.emit('swarm.changed',snapshot);}catch{/* Durable records remain authoritative when a refresh subscriber fails. */}}
  snapshot(ctx:PluginContext): unknown {
    if(this.disposed)throw new Error('Swarm 已关闭');
    const store=this.store(ctx);const graphs=store.list<Graph>(`graph:${ctx.projectId}:`).filter(doc=>doc.value.sessionId===ctx.sessionId).map(doc=>({...doc.value,revision:doc.revision}));
    for(const graph of graphs)for(const task of graph.tasks)task.waiting=this.taskWait(graph,task,ctx);
    for(const graph of graphs)for(const attempt of graph.attempts){const pending=attempt.trialObservation;if(pending?.status==='waiting'&&pending.retryAt&&(pending.attempts||0)<3)this.retryMemberTrial(graph.id,attempt.id,pending.outcome,pending.retryAt,ctx);}
    const ids=new Set(graphs.map(graph=>graph.id));const projection=this.storage(ctx).projectionStatus(ctx,graphs);if(projection.drift)this.storage(ctx).projection(ctx,graphs);this.storage(ctx).flush(ctx);const artifacts=graphs.flatMap(g=>this.artifacts(ctx).list(g.id));const fileApplications=store.db.prepare('SELECT * FROM swarm_file_applications').all().filter(r=>graphs.some(g=>String(r.operation_id).startsWith(`apply:${g.id}:`)));const operations=[...graphs.flatMap(g=>this.operations(ctx).list(g.id)),...fileApplications.map(r=>({id:r.operation_id,graphId:graphs.find(g=>String(r.operation_id).startsWith(`apply:${g.id}:`))!.id,connector:'file',target:r.target,status:r.status==='unknown'?'unknown':r.status==='applied'?'confirmed':'prepared',payloadDigest:r.digest,expectedTargetVersion:r.baseline}))];const verifications=store.db.prepare('SELECT json FROM swarm_verification').all().map(r=>JSON.parse(String(r.json))).filter(r=>ids.has(r.graphId));
    return {projection:{...projection,rebuilt:projection.drift},fileApplications,artifacts,operations,verifications,budgets:graphs.filter(g=>g.budget).map(g=>({graphId:g.id,...g.budget})),teammates:this.roster(ctx).list(ctx),graphs,members:graphs.flatMap(graph=>graph.attempts.map(attempt=>({...attempt,graphId:graph.id}))),messages:[...store.list<MemberMessage>('message:').map(doc=>doc.value).filter(msg=>ids.has(msg.graphId)),...store.list<MemberMessage>('teammate-message:'+ctx.sessionId+':').map(doc=>doc.value).filter(msg=>ids.has(msg.graphId))],shared:store.list<SharedDocument>('shared:').map(doc=>({...doc.value,revision:doc.revision})).filter(item=>ids.has(item.graphId)),sharedConflicts:store.list('shared-conflict:').map(doc=>doc.value).filter(raw=>raw&&typeof raw==='object'&&'graphId' in raw&&ids.has(String(raw.graphId))),confirmations:[...this.confirmations.keys()],status:graphs.some(graph=>['running','stopping','awaiting_review','ready'].includes(graph.status)||graph.attempts.some(attempt=>attempt.status==='running'))||this.roster(ctx).list(ctx).some(member=>['provisioning','running','stopping'].includes(member.state))?'running':'idle'};
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext): Promise<unknown> {
    if(this.disposed)throw new Error('Swarm 已关闭');
    if(action==='resume.preview'){const preview=this.resumePreview(text(input.graphId,'任务图标识',100),ctx);if(input.expectedRevision!==undefined&&input.expectedRevision!==preview.graphRevision)throw new CapabilityError('VERSION_CONFLICT','任务图版本已变化',{preview});return preview;}
    if(input.expectedRevision!==undefined&&!action.startsWith('shared.')&&input.revision===undefined)input={...input,revision:input.expectedRevision};
    for(const field of ['confirmUnknown','accepted','deferPreparation','workflowHeld','gateOnly','repair','automatic'])if(input[field]!==undefined&&typeof input[field]!=='boolean')throw new CapabilityError('VALIDATION_ERROR',`${field}必须为布尔值`);
    const read=['plan.validate','resume.preview','handoff.read','snapshot','history','member.list','member.history','shared.read','shared.readVersion','shared.conflicts','artifact.list','artifact.read','budget.read','search'];
    return read.includes(action)||action.startsWith('operation.')?this.dispatchInternal(action,input,ctx):this.storage(ctx).action(action,input,ctx,()=>this.dispatchInternal(action,input,ctx));
  }
  private async dispatchInternal(action:string,input:JsonObject,ctx:PluginContext): Promise<unknown> {
    if(input.expectedRevision!==undefined&&!action.startsWith('shared.')){if(!Number.isInteger(input.expectedRevision)||Number(input.expectedRevision)<0)throw new CapabilityError('VALIDATION_ERROR','expectedRevision无效');if(input.graphId&&this.get(String(input.graphId),ctx).revision!==input.expectedRevision)throw new CapabilityError('VERSION_CONFLICT','任务图版本已变化');}
    if(this.disposed)throw new Error('Swarm 已关闭');
    if(action.startsWith('member.'))return this.memberAction(action.slice(7),input,ctx);
    if(action==='stop.members'){await Promise.allSettled(this.roster(ctx).list(ctx).filter(member=>member.state==='provisioning'||member.state==='running'||member.state==='idle').map(member=>this.interruptMember(member.id,ctx)));return this.snapshot(ctx);}
    if(action.startsWith('team.'))return this.team(action.slice(5),input,ctx);
    if(action==='audit')return this.audit(input,ctx);
    if (action==='snapshot') return this.snapshot(ctx);
    if(action==='plan.validate')return this.validatePlan(input,ctx);
    if(action==='search'){const graphs=(this.snapshot(ctx) as {graphs:Graph[]}).graphs;this.store(ctx).transaction(()=>{for(const g of graphs){for(const task of g.tasks)this.storage(ctx).index(g.id,'task',task.id,`${task.title} ${task.requirementVersions?.at(-1)?.prompt||task.prompt}`);for(const row of this.store(ctx).list<SharedDocument>(`shared:${g.id}:`))this.storage(ctx).index(g.id,'shared',row.value.name,row.value.content);}});const terms=text(input.query).replace(/([\p{Script=Han}])/gu,' $1 ').match(/[\p{L}\p{N}_]+/gu)||[];if(!terms.length)return {matches:[]};const query=terms.map(term=>`"${term}"`).join(' ');return {matches:graphs.flatMap(g=>this.store(ctx).db.prepare('SELECT kind,record_id,text FROM swarm_search WHERE graph_id=? AND swarm_search MATCH ? ORDER BY bm25(swarm_search) LIMIT 20').all(g.id,query))};}
    if (action==='history') return {graphs:this.store(ctx).list<Graph>(`graph:${ctx.projectId}:`).map(doc=>({...doc.value,revision:doc.revision})),readOnly:true};
    if (action==='create') return this.create(input,ctx);
    if (action==='confirm') {if (ctx.origin && ctx.origin!=='user') throw new Error('关键确认必须来自用户');const resolver=this.confirmations.get(text(input.id));if (!resolver) throw new Error('确认请求已结束');resolver(input.accepted===true);return {accepted:input.accepted===true};}
    const id=text(input.graphId,'任务图标识',100);
    if(action==='artifact.list'){this.get(id,ctx);return {artifacts:this.artifacts(ctx).list(id)};}
    if(action==='artifact.read'){this.get(id,ctx);return this.artifacts(ctx).read(id,text(input.artifactId),input.revision===undefined?undefined:number(input.revision,1,1,1000000));}
    if(action==='budget.read')return this.get(id,ctx).value.budget??{available:false,tokenUnknown:true};
    if(action==='resume.preview')return this.resumePreview(id,ctx);
    if(action==='handoff.read'){const graph=this.get(id,ctx).value,attempt=graph.attempts.find(a=>a.id===input.attemptId);if(!attempt?.requiredHandoff)throw new CapabilityError('SOURCE_UNAVAILABLE','本尝试没有必读交接');this.fence(graph,ctx);return readHandoff(this.store(ctx),id,attempt.requiredHandoff,input.offset,input.maxChars);}
    if(action.startsWith('operation.')){const graph=this.get(id,ctx).value;this.fence(graph,ctx);const operations=this.operations(ctx);if(action==='operation.prepare'){const task=graph.tasks.find(t=>t.id===input.taskId),attempt=graph.attempts.find(a=>a.id===input.attemptId);if(!task||!attempt||attempt.taskId!==task.id)throw new CapabilityError('PERMISSION_DENIED','操作必须绑定当前任务尝试');const op=await operations.prepare(input,ctx);if(op.status==='prepared'&&!op.resourceReservationId){const reservation=object(await this.runtimeRequest(ctx,'resource.reserve',{graphId:id,taskId:op.taskId,attemptId:op.attemptId,ownerRuntime:this.runtime,generation:attempt.generation||1,resources:[{kind:'external',key:op.target,access:'write'}]}));return operations.bindResource(op.id,text(reservation.reservationId),ctx);}return op;}if(action==='operation.dispatch'){const op=operations.read(text(input.operationId),ctx);if(op.status==='confirmed'||op.status==='rejected')return op;if(!op.resourceReservationId)throw new CapabilityError('CAPABILITY_UNAVAILABLE','外部写入缺少宿主资源预约');await this.runtimeRequest(ctx,'resource.check',{reservationId:op.resourceReservationId});const result=await this.track(id,operations.dispatch(op.id,input.revision,ctx));if(result.status==='confirmed'||result.status==='rejected')await this.runtimeRequest(ctx,'resource.release',{reservationId:op.resourceReservationId});return result;}if(action==='operation.reconcile'){const result=await this.track(id,operations.reconcile(text(input.operationId),ctx));if(result.resourceReservationId&&(result.status==='confirmed'||result.status==='rejected'))try{await this.runtimeRequest(ctx,'resource.release',{reservationId:result.resourceReservationId});}catch(error){if(error instanceof CapabilityError&&error.code==='OPERATION_UNKNOWN'&&result.reconciliation?.receiptId)await this.runtimeRequest(ctx,'resource.reconcile',{reservationId:result.resourceReservationId,operationId:result.id,receiptId:result.reconciliation.receiptId});else throw error;}return result;}}
    if(!['pause','stop','shared.read','shared.readVersion','shared.conflicts'].includes(action))assertOrdinaryGraph(this.get(id,ctx).value);
    if(['start','resume','prepare','review','integrate','rework','append','update_task','workflow_skip'].includes(action))assertExecution(ctx,this.get(id,ctx).value.executionStyle||'swarm');
    if(action==='append')return this.appendTasks(id,input,ctx);
    if(action==='update_task')return this.reviseTask(id,input,ctx);
    if(action==='workflow_skip'){
      const graph=this.get(id,ctx).value;assertCheckPolicy(graph,ctx);const taskId=text(input.taskId),task=graph.tasks.find(item=>item.id===taskId);if(!graph.workflowId||!task||!['pending','skipped'].includes(task.status)||task.rework>=2)throw new Error('只有安全等待中的工作流节点可按条件跳过');
      const skipped=this.update(id,ctx,g=>{g.tasks.find(item=>item.id===taskId)!.status='skipped';});this.changed(ctx);if(skipped.status==='running')void this.track(id,this.pump(id,ctx));return skipped;
    }
    if (action==='start') {await this.track(id,this.start(id,input,ctx));return this.get(id,ctx).value;}
    if (action==='pause' || action==='stop')return this.stop(id,ctx,action==='pause');
    if (action==='resume') {
      const graph=this.get(id,ctx).value;assertCheckPolicy(graph,ctx);
      const preview=this.resumePreview(id,ctx);if(input.previewBinding!==undefined&&input.previewBinding!==preview.binding)throw new CapabilityError('VERSION_CONFLICT','恢复预览已过期，请重新核对',{preview});if(!preview.sourceValidity.valid)throw new CapabilityError('SOURCE_UNAVAILABLE',preview.sourceValidity.reason||'来源不可用');if(preview.nodes.some(node=>node.decision==='redo'&&graph.tasks.find(task=>task.id===node.id)?.status==='completed'))throw new CapabilityError('VERSION_CONFLICT','保留成果已变化，请通过任务修复重新验证',{preview});
      if(graph.status==='stopping'||this.execution(id).activities.size||this.execution(id).operations.size)throw new Error('停止尚未到安全边界，请等待退出收据');
      if (graph.status==='integrated') throw new Error('已整合任务不能重新执行');
      if(graph.reworkRound>=2&&graph.tasks.some(task=>task.status==='blocked'))throw new CapabilityError('BUDGET_EXHAUSTED','任务图已达2波返工上限');
      if(graph.tasks.some(task=>task.status==='blocked'&&task.rework>=2))throw new Error('任务已达 2 轮修复上限；不能用接续绕过额度');
      if (graph.tasks.some(t=>t.status==='unknown') && (input.confirmUnknown!==true || (ctx.origin && ctx.origin!=='user'))) throw new Error('存在副作用未知的任务；请检查保留的会话和工作区，并由用户以 confirmUnknown:true 明确启动新尝试');
      for(const memberId of new Set(graph.tasks.flatMap(task=>task.memberId?[task.memberId]:[]))){const member=this.roster(ctx).get(memberId,ctx);if(member.state==='running'||member.state==='stopping'||member.stopReceipt?.status==='unknown'||member.state==='paused'&&member.sessionFile&&!member.stopReceipt)throw new Error('成员尚无明确退出收据，不并发打开原生会话');}
      for(const task of graph.tasks)if(task.memberId&&this.roster(ctx).get(task.memberId,ctx).state==='paused')this.roster(ctx).update(task.memberId,ctx,m=>{m.state='idle';m.attemptId=undefined;});
      this.update(id,ctx,g=>{for (const task of g.tasks) if (['unknown','blocked','cancelled'].includes(task.status)) {if(task.status==='unknown')task.resumeFromAttempt=task.currentAttempt;task.status='pending';task.currentAttempt=undefined;}g.error=undefined;});
      this.executions.delete(id);await this.track(id,this.start(id,input,ctx));for(const memberId of new Set(graph.tasks.flatMap(task=>task.memberId?[task.memberId]:[])))setImmediate(()=>void this.wakeOrDeliver(memberId,ctx).catch(()=>{}));return this.get(id,ctx).value;
    }
    if (action==='configure') return this.update(id,ctx,g=>{if (['running','stopping','awaiting_review'].includes(g.status)) throw new Error('并发配置在空闲边界修改');const requested=number(input.maxWorkers,g.maxWorkers,1,16);if(g.budget&&requested>(g.budget.parentMaxWorkers??16))throw new CapabilityError('PERMISSION_DENIED','并发不能超过父任务分配');g.maxWorkers=requested;if(g.budget)g.budget.maxWorkers=requested;});
    if (action==='send') return this.sendMessage(id,input,ctx);
    if (action==='shared.write'){
      this.fence(this.get(id,ctx).value,ctx);try{const saved=await this.track(id,new SharedMaterials(this.store(ctx),()=>this.changed(ctx)).write(id,input,{...ctx,signal:this.signal(id,ctx),complete:async(prompt,options)=>{const graph=this.get(id,ctx).value;if(!graph.budget)return ctx.complete(prompt,options);const r=await new Budget(this.store(ctx)).complete(graph.budget,id,'shared-merge',ctx,prompt,options);this.update(id,ctx,g=>{g.budget=r.budget;});return r.text;}}));this.storage(ctx).index(id,'shared',saved.name,saved.content);return saved;}
      catch(error){if(error instanceof ConflictError&&['running','awaiting_review'].includes(this.get(id,ctx).value.status))void this.stop(id,ctx,true,errorText(error)).catch(()=>{});throw error;}
    }
    if (action==='shared.read') {this.get(id,ctx);const doc=this.store(ctx).get<SharedDocument>(`shared:${id}:${text(input.name)}`);return doc?{...doc.value,revision:doc.revision}:null;}
    if(action==='shared.readVersion'){this.get(id,ctx);return new SharedMaterials(this.store(ctx),()=>this.changed(ctx)).version(id,text(input.name),number(input.revision,0,1,10000000));}
    if(action==='shared.conflicts'){this.get(id,ctx);return this.store(ctx).list(`shared-conflict:${id}:`).map(doc=>({...object(doc.value),revision:doc.revision}));}
    if(action==='rework')return this.rework(id,input,ctx);
    if (action==='prepare' || action==='review') {
      const graph=this.get(id,ctx).value;assertCheckPolicy(graph,ctx);
      if(!graph.tasks.every(taskSettled))throw new Error('所有成果完成后才能整合复核');
      if(graph.status==='integrated'||graph.status==='ready'||this.preparing.has(id))return graph;if(input.candidateDigest!==undefined&&input.candidateDigest!==this.artifacts(ctx).candidate(graph))throw new CapabilityError('VERSION_CONFLICT','请求候选已过期');
      // The native review may exceed the request bridge timeout. Return its retained state
      // immediately and keep completion/failure authority in the actual member lifecycle.
      void this.track(id,this.prepare(id,ctx)).catch(()=>{});this.changed(ctx);return this.get(id,ctx).value;
    }
    if (action==='integrate') {if(input.candidateDigest!==undefined&&input.candidateDigest!==this.get(id,ctx).value.integration?.candidateDigest)throw new CapabilityError('VERSION_CONFLICT','请求候选已过期');if(this.get(id,ctx).value.executionStyle==='team'&&ctx.origin==='plugin')throw new Error('Team 整合必须由主 Agent 或用户决定');await this.track(id,this.integrate(id,ctx));return this.get(id,ctx).value;}
    throw new Error(`未知 Swarm 操作：${action}`);
  }
  private teamGraph(input:JsonObject,ctx:PluginContext):Graph|undefined {
    if(input.graphId){const graph=this.get(text(input.graphId),ctx).value;if(graph.executionStyle!=='team')throw new Error('此任务图不是 Team');return graph;}
    return this.store(ctx).list<Graph>(`graph:${ctx.projectId}:`).map(row=>row.value).find(graph=>graph.sessionId===ctx.sessionId&&graph.executionStyle==='team'&&!graph.audit&&graph.runId===ctx.runId);
  }
  private async team(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(action==='list')return {graphs:(this.snapshot(ctx) as {graphs:Graph[]}).graphs.filter(graph=>graph.executionStyle==='team'&&!graph.audit&&(!ctx.runId||graph.runId===ctx.runId))};
    const graph=this.teamGraph(input,ctx);
    if(action==='result'){
      if(!graph)throw new Error('本轮没有 Team 委派');
      const tasks=input.taskId?graph.tasks.filter(task=>task.id===text(input.taskId)):graph.tasks;if(!tasks.length)throw new Error('任务不存在');
      return {graphId:graph.id,status:graph.status,tasks:tasks.map(task=>({task,attempt:graph.attempts.find(attempt=>attempt.id===task.currentAttempt)})),messages:this.store(ctx).list<MemberMessage>(`message:${graph.id}:`).map(row=>row.value).filter(message=>message.to==='parent')};
    }
    assertExecution(ctx,'team');if(ctx.origin==='plugin')throw new Error('Team 委派与整合必须来自主 Agent 或用户');
    if(action==='delegate'){
      if(graph)assertOrdinaryGraph(graph);
      if(graph&&graph.runId!==ctx.runId)throw new Error('不能向另一轮 Team 委派追加任务');
      const raw=Array.isArray(input.tasks)?input.tasks.map(item=>{const task=object(item);return {...task,mode:task.mode??'read'};}):input.tasks??[{...input,id:input.taskId??input.id??randomUUID(),title:input.title??String(input.prompt||'委派任务').slice(0,80),mode:input.mode??'read'}];
      if(graph){if(['paused','stopped','stopping'].includes(graph.status)||graph.tasks.some(task=>task.status==='unknown'))throw new Error('Team 已暂停或副作用未知，检查后显式接续');await this.appendTasks(graph.id,{...input,tasks:raw},ctx);return this.get(graph.id,ctx).value;}
      const created=await this.create({...input,goal:input.goal??input.prompt??'本轮 Team 委派',tasks:raw,executionStyle:'team'},ctx);await this.track(created.id,this.start(created.id,{},ctx));return this.get(created.id,ctx).value;
    }
    if(!graph)throw new Error('本轮没有 Team 委派');
    if(!['send','stop','prepare','integrate'].includes(action))throw new Error('未知 Team 操作');
    return this.dispatch(action,{...input,graphId:graph.id},ctx);
  }
  private async appendTasks(id:string,input:JsonObject,ctx:PluginContext):Promise<Graph> {
    const current=this.get(id,ctx).value;if(!Array.isArray(input.tasks)||!input.tasks.length)throw new Error('必须提供新增任务');
    if(current.executionOwner&&current.executionOwner.runtime!==this.runtime&&alive(current.executionOwner.pid)&&['running','awaiting_review','stopping'].includes(current.status))throw new Error('任务仍由另一个运行时持有，不能追加执行');
    if(['stopping','paused','stopped','awaiting_review'].includes(current.status)||this.preparing.has(id))throw new Error('任务图未到可追加的安全边界');
    const tasks=input.tasks.map((raw,index)=>taskSpec(raw,current.tasks.length+index));for(const task of tasks){if(current.executionStyle==='team'&&!task.roleId){task.modelId??=ctx.modelId;task.thinkingLevel??=ctx.thinkingLevel;}boundTaskPolicy(task,ctx);validateTaskModel(task,ctx,current.modelId,current.thinkingLevel);}
    if((current.cumulativeTaskCount??current.tasks.length)+tasks.length>64)throw new Error('任务图累计任务上限为 64');validateDAG([...current.tasks,...tasks]);if(current.schemaVersion===3)validateWriteRanges([...current.tasks,...tasks]);
    const combinedTasks=[...current.tasks,...tasks],prospectiveContract=current.schemaVersion===3?contract(input.contract??{...current.contract,verification:current.contract?.verification==='V0'&&tasks.some(t=>t.mode==='write')?'V1':current.contract?.verification},current.goal,combinedTasks):current.contract;
    assertCheckPolicy({tasks:combinedTasks,checks:current.checks,contract:prospectiveContract},ctx);
    if(tasks.some(task=>task.mode==='write')){
      const baseline=current.baseline??await this.baseline(id,ctx.projectDir,ctx);
      if(current.schemaVersion!==3&&current.executionStyle==='team'&&!baseline){this.update(id,ctx,g=>{g.tasks.push(...tasks);g.status='paused';g.error='Team 写入委派需要 Git 隔离工作树；新增任务保留，未启动成员';});this.changed(ctx);throw new Error('Team 写入委派需要 Git 隔离工作树');}
      if(baseline&&(await this.git(id,baseline.repoRoot,['status','--porcelain'],ctx)||await this.git(id,baseline.repoRoot,['rev-parse','HEAD'],ctx)!==baseline.head)){this.update(id,ctx,g=>{g.tasks.push(...tasks);g.baseline=baseline;g.status='paused';g.error='原项目基线或工作区已变化；新增写入任务保留，未启动成员';});this.changed(ctx);throw new Error('原项目基线或工作区已变化；任务保留并暂停');}
      if(baseline&&!current.baseline)this.update(id,ctx,g=>{g.baseline=baseline;});
    }
    if(current.schemaVersion===3)await this.identify(tasks,ctx);
    if(current.collaborationVersion===2)for(const task of tasks)task.memberId=this.roster(ctx).forTask(task,ctx).id;
    const graph=this.update(id,ctx,g=>{if(input.revision!==undefined&&input.revision!==this.get(id,ctx).revision)throw new ConflictError();g.tasks.push(...tasks);if(g.schemaVersion===3){g.contract=contract(input.contract??{...g.contract,verification:g.contract?.verification==='V0'&&tasks.some(t=>t.mode==='write')?'V1':g.contract?.verification},g.goal,g.tasks);assertCheckPolicy(g,ctx);g.sourceFence=new SourcePolicy(this.store(ctx)).capture({projectId:ctx.projectId,sources:[...(g.sourceFence?.sources||[]),...g.contract.artifacts.flatMap(a=>a.sources||[])],dependencies:g.sourceFence?.dependencies||[]});}g.cumulativeTaskCount=(g.cumulativeTaskCount??current.tasks.length)+tasks.length;g.integration=undefined;g.error=undefined;if(g.status!=='created')g.status='running';});
    this.changed(ctx);if(graph.status==='running')void this.track(id,this.pump(id,ctx));return graph;
  }
  private async reviseTask(id:string,input:JsonObject,ctx:PluginContext):Promise<Graph> {
    const current=this.get(id,ctx).value,taskId=text(input.taskId,'任务标识',100),previous=current.tasks.find(task=>task.id===taskId);if(!previous)throw new Error('任务不存在');
    if(input.gateOnly===true){assertCheckPolicy(current,ctx);if(!current.workflowId||!['pending','skipped'].includes(previous.status)||typeof input.workflowHeld!=='boolean'||Object.keys(input).some(key=>!['graphId','taskId','workflowHeld','gateOnly','revision'].includes(key)))throw new Error('工作流门闸只可切换等待节点，不能修改要求');const gated=this.update(id,ctx,g=>{if(input.revision!==undefined&&input.revision!==this.get(id,ctx).revision)throw new ConflictError();const task=g.tasks.find(item=>item.id===taskId)!;task.workflowHeld=input.workflowHeld===true;if(!task.workflowHeld)task.status='pending';});this.changed(ctx);if(gated.status==='running')void this.track(id,this.pump(id,ctx));return gated;}
    if(current.status==='running'||current.status==='stopping'||current.status==='awaiting_review'||this.execution(id).operations.size||this.execution(id).activities.size)throw new Error('先停止成员并等待安全边界，才能修改任务要求');
    if(currentUnknown(current)&&(input.confirmUnknown!==true||ctx.origin!=='user'))throw new Error('存在未知副作用，需用户检查并确认 confirmUnknown:true');
    const changed=taskSpec({...previous,...input,id:taskId,logicalStepId:previous.logicalStepId},0);boundTaskPolicy(changed,ctx);validateTaskModel(changed,ctx,current.modelId,current.thinkingLevel);const changedTasks=current.tasks.map(task=>task.id===taskId?changed:task);validateDAG(changedTasks);if(current.schemaVersion===3)validateWriteRanges(changedTasks);assertCheckPolicy({tasks:changedTasks,checks:current.checks,contract:current.contract},ctx);
    const reason=text(input.reason,'修改依据');if(input.repair===true||previous.status==='blocked')await this.claimRepair(current,[taskId],reason,ctx);
    const graph=this.update(id,ctx,g=>{if(input.revision!==undefined&&input.revision!==this.get(id,ctx).revision)throw new ConflictError();if(input.repair===true||previous.status==='blocked')g.reworkRound++;const target=g.tasks.find(task=>task.id===taskId)!;const versions=target.requirementVersions||[{version:1,prompt:target.prompt,at:g.createdAt}];const repair=target.rework;Object.assign(target,changed,{originalPrompt:target.originalPrompt||target.prompt,requirementVersions:[...versions,{version:versions.at(-1)!.version+1,prompt:changed.prompt,reason,at:now()}],rework:repair,resultRevision:target.resultRevision});assertCheckPolicy(g,ctx);const affected=new Set([taskId]);let grew=true;while(grew){grew=false;for(const task of g.tasks)if(!affected.has(task.id)&&task.dependencies.some(dep=>affected.has(dep))){affected.add(task.id);grew=true;}}for(const task of g.tasks)if(affected.has(task.id)){task.status='pending';task.currentAttempt=undefined;if(g.workflowId)task.workflowHeld=true;}g.integratedTaskIds=g.integratedTaskIds?.filter(task=>!affected.has(task));g.integration=undefined;g.status='paused';g.error=undefined;});
    this.executions.delete(id);this.changed(ctx);return graph;
  }
  private async audit(input:JsonObject,ctx:PluginContext):Promise<unknown> {
    const style=ctx.executionMode||ctx.policy?.executionMode||'swarm';if(style==='single')throw new Error('Single 使用主 Agent 自检，不启动独立审核成员');assertExecution(ctx,style);
    const goalId=text(input.goalId??ctx.policy?.goalId,'目标标识',200),objective=text(input.objective,'审核目标');
    const requestedModel=typeof input.modelId==='string'?input.modelId:undefined,requestedThinking=thinkingLevel(input.thinkingLevel,ctx.thinkingLevel);
    validateTaskModel({...taskSpec({id:'audit-evidence',title:'目标交付证据',prompt:objective,mode:'read'},0),modelId:requestedModel,thinkingLevel:requestedThinking},ctx,ctx.modelId,ctx.thinkingLevel);
    const context={...ctx,modelId:requestedModel??ctx.modelId,thinkingLevel:requestedThinking};
    const created=await this.create({goal:objective,tasks:[{id:'audit-evidence',title:'目标交付证据',prompt:objective,mode:'read'}],checks:[],executionStyle:style,deferPreparation:true},context,true);
    this.update(created.id,ctx,g=>{g.goalId=goalId;g.audit=true;g.executionOwner={pid:process.pid,runtime:this.runtime};g.status='awaiting_review';g.tasks[0].status='completed';g.tasks[0].resultRevision=1;const evidence=JSON.stringify(input.evidence??{});if(evidence.length>100000)throw new Error('目标审核证据过大');g.auditEvidence=JSON.parse(evidence);g.integration={cwd:ctx.projectDir,checks:[]};});this.changed(ctx);
    try {const review=await this.track(created.id,this.reviewer(this.get(created.id,ctx).value,ctx.projectDir,context));const receipt={...review,at:now()};this.update(created.id,ctx,g=>{g.reviews=[...(g.reviews||[]),receipt];g.integration!.review=receipt;g.status=review.approved?'completed':'paused';g.error=review.approved?undefined:review.findings;});this.changed(ctx);return {...review,goalId,independent:true,source:{graphId:created.id,attemptId:review.attemptId,sessionId:review.sessionId,sessionFile:review.sessionFile}};}
    catch(error){this.update(created.id,ctx,g=>{g.status='paused';g.error=errorText(error);});this.changed(ctx);throw error;}
  }
  private validatePlan(input:JsonObject,ctx:PluginContext):unknown {
    assertExecution(ctx,'swarm');const goal=text(input.goal,'目标'),reason=text(input.reason,'分工或直接执行依据',8000),strategy=input.strategy??'collaboration';
    if(strategy!=='direct'&&strategy!=='collaboration')throw new CapabilityError('VALIDATION_ERROR','未知Swarm内执行策略');
    if(!Array.isArray(input.tasks)||input.tasks.length>64||strategy==='collaboration'&&!input.tasks.length||strategy==='direct'&&input.tasks.length)throw new CapabilityError('VALIDATION_ERROR','协作需要1–64任务；直接完成不派发任务');
    const tasks=input.tasks.map(taskSpec);if(input.tasks.some(raw=>!['read','write'].includes(String(object(raw).mode))))throw new CapabilityError('VALIDATION_ERROR','必须明确任务mode');
    validateDAG(tasks);validateWriteRanges(tasks);for(const task of tasks){boundTaskPolicy(task,ctx);validateTaskModel(task,ctx,ctx.modelId,ctx.thinkingLevel);}
    const checks=checkSpecs(input.checks),risk=input.risk??object(input.contract??{}).risk??(tasks.some(task=>task.mode==='write')?'medium':'low');if(!['low','medium','high'].includes(String(risk)))throw new CapabilityError('VALIDATION_ERROR','风险等级无效');
    const frozenContract=tasks.length?contract({...object(input.contract??{}),risk},goal,tasks):undefined;
    assertCheckPolicy({tasks,checks,contract:frozenContract},ctx);
    if(frozenContract?.verification==='V2'&&!checks.length&&!frozenContract.checks.length)throw new CapabilityError('VALIDATION_ERROR','V2必须声明宿主目标oracle检查');
    const budget=input.budget===undefined?{}:object(input.budget);if(budget.tokenLimit!==undefined&&(!Number.isSafeInteger(budget.tokenLimit)||Number(budget.tokenLimit)<1))throw new CapabilityError('VALIDATION_ERROR','tokenLimit必须为正整数');
    return {v:1,valid:true,mode:'swarm',strategy,reason,goal,risk,tasks,dependencies:tasks.map(task=>({taskId:task.id,dependsOn:task.dependencies})),conflicts:[],permissions:{tools:ctx.policy?.tools??[],writeScopes:ctx.policy?.writeScopes??[],expandsAuthority:false},checks,contract:frozenContract,budget:{tokenLimit:budget.tokenLimit,maxWorkers:number(input.maxWorkers,4,1,16),maxTasks:64,estimatesKnown:false},executionRequiresValidation:true,verificationRequired:risk==='high'?'objective-and-independent-review':'objective-checks-as-applicable'};
  }
  private withRecoveryStore<T>(ctx:PluginContext,read:(store:RecordStore)=>T):T {
    const known=this.stores.get(ctx.dataDir);if(known)return read(known);if(!existsSync(join(ctx.dataDir,'plugins.sqlite')))throw new CapabilityError('SOURCE_UNAVAILABLE','原任务数据库不存在');const store=new RecordStore('swarm',ctx.dataDir);try{return read(store);}finally{store.close();}
  }
  /** Preview cold state without running startup recovery or installing a new writer fence. */
  readRecoveryGraph(id:string,ctx:PluginContext):Graph&{revision:number} {
    return this.withRecoveryStore(ctx,store=>{const document=store.get<Graph>(graphKey(ctx.projectId,id));if(!document||document.value.sessionId!==ctx.sessionId)throw new Error('任务图不存在或不属于当前会话');const graph={...document.value,revision:document.revision};for(const attempt of graph.attempts)if(attempt.status==='running'&&!alive(attempt.ownerPid)){attempt.status='unknown';const task=graph.tasks.find(t=>t.currentAttempt===attempt.id);if(task)task.status='unknown';}return graph;});
  }
  private resumePreview(id:string,ctx:PluginContext) {return this.withRecoveryStore(ctx,store=>{
    const graph=this.readRecoveryGraph(id,ctx),sourceValidity:{valid:boolean;reason?:string}={valid:true};try{if(graph.sourceFence)new SourcePolicy(store).assert(graph.sourceFence);}catch(error){sourceValidity.valid=false;sourceValidity.reason=errorText(error);}
    const latest=new Map<string,ArtifactVersion>();if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='swarm_artifact_versions'").get())for(const row of store.db.prepare('SELECT json FROM swarm_artifact_versions WHERE graph_id=? ORDER BY artifact_id,revision').all(id)){const artifact=JSON.parse(String(row.json)) as ArtifactVersion;latest.set(artifact.artifactId,artifact);}const artifacts=[...latest.values()],nodes=graph.tasks.map(task=>{const attempt=graph.attempts.find(a=>a.id===task.currentAttempt),owned=artifacts.filter(a=>a.attemptId===attempt?.id),reasons:string[]=[],actual=owned.map(a=>({artifactId:a.artifactId,revision:a.revision,digest:a.digest,actual:a.stagingPath?fileDigest(a.stagingPath):a.digest}));
      if(actual.some(a=>a.actual!==a.digest))reasons.push('成果文件摘要变化');if(task.status==='unknown'||attempt?.status==='unknown')reasons.push('副作用未知，必须核对后明确确认');if(!sourceValidity.valid)reasons.push(sourceValidity.reason||'来源不可用');
      const decision:'keep'|'redo'|'check'=!sourceValidity.valid||task.status==='unknown'||attempt?.status==='unknown'||task.status==='running'?'check':reasons.length||task.status==='pending'||task.status==='blocked'||task.status==='cancelled'?'redo':'keep';
      return {id:task.id,decision,reasons:reasons.length?reasons:[decision==='keep'?'保留绑定有效':decision==='redo'?'尚未完成，按原依赖和额度继续':'执行尚未结束'],requirementVersion:task.requirementVersions?.at(-1)?.version,inputDigest:digest({prompt:task.prompt,constraints:task.constraints,dependencies:task.dependencies,dependencyResults:attempt?.dependencyResults}),resultRevision:task.resultRevision,resultDigest:digest({attemptId:attempt?.id,summary:attempt?.summary,commit:attempt?.commit,actual}),rework:task.rework};});
    const operations=store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='swarm_operations'").get()?store.db.prepare('SELECT operation_id,status,revision FROM swarm_operations WHERE graph_id=?').all(id):[];
    const body={v:1 as const,readOnly:true as const,graphId:id,graphRevision:graph.revision,definitionHash:digest({contract:graph.contract,tasks:graph.tasks.map(task=>({id:task.id,prompt:task.prompt,dependencies:task.dependencies,mode:task.mode,writeScopes:task.writeScopes,constraints:task.constraints,unresolved:task.unresolved}))}),sourceValidity,nodes};return {...body,binding:digest({body,sourceFence:graph.sourceFence,permission:ctx.policy&&{tools:ctx.policy.tools,writeScopes:ctx.policy.writeScopes,permissionMode:ctx.policy.permissionMode},operations})};
  });
  }
  private async create(input:JsonObject,ctx:PluginContext,audit=false): Promise<Graph> {
    const style=input.executionStyle===undefined?'swarm':input.executionStyle;if(style!=='team'&&style!=='swarm')throw new Error('未知协作方式');if(input.collaborationVersion!==1||input.tasks===undefined)assertExecution(ctx,style);
    const goal=text(input.goal || input.text,'目标');let raw=input.tasks;const graphId=randomUUID(),newSchema=input.collaborationVersion!==1&&!audit;let initialBudget:BudgetSnapshot|undefined;if(newSchema)initialBudget=await new Budget(this.store(ctx)).capture(graphId,input.budget,number(input.maxWorkers,4,1,16),ctx);
    if (raw===undefined) {
      const planningPrompt=`用户已选择 Swarm。把已授权目标拆为成果任务，输出纯 JSON {"reason":"分工依据与依赖，未知时间费用不能估造","tasks":[{"id":"task-1","title":"...","prompt":"...","dependencies":[],"mode":"read|write","writeScopes":["."]}]}。依赖必须是 DAG，避免重复修改同一文件。不推荐或切换协作模式。简单任务允许主 Agent 直接完成，此处已请求协作则可用单任务。禁止编造已完成工作。目标：${goal}`;let planned:string;if(initialBudget){const result=await new Budget(this.store(ctx)).complete(initialBudget,graphId,'planner',ctx,planningPrompt,{maxTokens:3000});planned=result.text;initialBudget=result.budget;}else planned=await ctx.complete(planningPrompt,{maxTokens:3000});const plan=parseModelJson(planned);raw=plan.tasks;if(typeof plan.reason==='string')input={...input,reason:plan.reason};
    }
    if (!Array.isArray(raw) || raw.length<1 || raw.length>64) throw new Error('任务数必须在 1–64 之间');
    if(newSchema&&raw.some(item=>!['read','write'].includes(String(object(item).mode))))throw new CapabilityError('VALIDATION_ERROR','必须明确每个任务mode');
    const tasks=raw.map(taskSpec);validateDAG(tasks);if(newSchema)validateWriteRanges(tasks);
    for(const task of tasks){boundTaskPolicy(task,ctx);validateTaskModel(task,ctx,ctx.modelId,ctx.thinkingLevel);}
    let checks=checkSpecs(input.checks);
    const executionStyle=input.executionStyle===undefined?'swarm':input.executionStyle;if(executionStyle!=='team'&&executionStyle!=='swarm')throw new Error('未知协作方式');
    if (input.checks===undefined && (ctx.origin==='user'||tasks.some(task=>task.mode==='write')) && (executionStyle!=='team'||tasks.some(task=>task.mode==='write')) && existsSync(join(ctx.projectDir,'package.json'))) {try {const pkg=JSON.parse(readFileSync(join(ctx.projectDir,'package.json'),'utf8'));if (pkg.scripts?.test) checks=[{command:'npm',args:['test']}];}catch {}}
    const graph:Graph={schemaVersion:input.collaborationVersion===1||audit?undefined:3,collaborationVersion:executionStyle==='swarm'&&!audit&&input.collaborationVersion!==1?2:undefined,audit:audit||undefined,id:graphId,projectId:ctx.projectId,projectDir:ctx.projectDir,sessionId:ctx.sessionId,goal,status:'created',createdAt:now(),updatedAt:now(),tasks,attempts:[],maxWorkers:number(input.maxWorkers,4,1,16),reworkRound:0,modelId:ctx.modelId,thinkingLevel:thinkingLevel(input.thinkingLevel,ctx.thinkingLevel),checks,executionStyle,workflowId:input.workflowId?text(input.workflowId,'工作流标识',100):undefined,deferPreparation:input.deferPreparation===true,runId:ctx.runId,parentTools:(ctx as ExecutionContext).policy?.tools,permissionMode:ctx.policy?.permissionMode,temporaryWriteRoot:ctx.policy?.temporaryWriteRoot,goalId:ctx.policy?.goalId};
    if(graph.schemaVersion===3)graph.contract=contract(input.contract,goal,tasks);
    assertCheckPolicy(graph,ctx);
    if(input.reason!==undefined)graph.planning={reason:text(input.reason,'分工依据',8000),strategy:'collaboration',estimatesKnown:false};
    if(graph.schemaVersion===3){if(graph.contract!.verification==='V2'&&!graph.checks.length&&!graph.contract!.checks.length)throw new CapabilityError('VALIDATION_ERROR','V2必须声明宿主目标oracle检查');graph.cumulativeTaskCount=tasks.length;graph.budget=initialBudget!;graph.maxWorkers=Math.min(graph.maxWorkers,graph.budget.maxWorkers);const sources=graph.contract!.artifacts.flatMap(a=>a.sources||[]);for(const source of sources)ctx.readSource(source);graph.sourceFence=new SourcePolicy(this.store(ctx)).capture({projectId:ctx.projectId,sources});await this.identify(tasks,ctx);}
    this.store(ctx).transaction(()=>{if(graph.collaborationVersion===2)for(const task of tasks)task.memberId=this.roster(ctx).forTask(task,ctx).id;this.store(ctx).put(graphKey(ctx.projectId,graph.id),graph,null);});for(const task of tasks)this.storage(ctx).index(graph.id,'task',task.id,`${task.title} ${task.prompt}`);ctx.appendEntry('friend-pi:swarm-created',{graphId:graph.id,goal});this.changed(ctx);return graph;
  }
  private async baseline(id:string,projectDir:string,ctx:PluginContext): Promise<Baseline|undefined> {
    let repoRoot:string;try {repoRoot=await this.git(id,projectDir,['rev-parse','--show-toplevel'],ctx);}catch(error) {checkCancelled(this.signal(id,ctx));return undefined;}
    const head=await this.git(id,repoRoot,['rev-parse','HEAD'],ctx);let branch:string|undefined;try {branch=await this.git(id,repoRoot,['symbolic-ref','HEAD'],ctx);}catch {checkCancelled(this.signal(id,ctx));}
    return {repoRoot,projectRelative:relative(realpathSync(repoRoot),realpathSync(projectDir)),head,branch};
  }
  private async start(id:string,input:JsonObject,ctx:PluginContext): Promise<void> {
    const current=this.get(id,ctx).value;assertCheckPolicy(current,ctx);if(current.schemaVersion===3){if(input.agentDir!==undefined&&(typeof input.agentDir!=='string'||resolve(input.agentDir)!==resolve(ctx.agentDir||agentDirectory())))throw new CapabilityError('PERMISSION_DENIED','成员agentDir必须来自真实宿主');if(input.modelId!==undefined&&(typeof input.modelId!=='string'||input.modelId!==ctx.modelId&&!ctx.availableModels?.some(m=>m.id===input.modelId)))throw new CapabilityError('CAPABILITY_UNAVAILABLE','委派型号未明确配置');}
    validateDAG(current.tasks);if(current.schemaVersion===3)validateWriteRanges(current.tasks);for(const task of current.tasks){const bounded=structuredClone(task);boundTaskPolicy(bounded,ctx);validateTaskModel(bounded,ctx,current.modelId,current.thinkingLevel);if(digest(bounded.writeScopes)!==digest(task.writeScopes))throw new CapabilityError('PERMISSION_DENIED','权限范围变化，需要明确更新任务后再执行');}
    if (current.status==='running') return;
    assertExecution(ctx,current.executionStyle||'swarm');
    if(current.executionOwner&&current.executionOwner.runtime!==this.runtime&&alive(current.executionOwner.pid)&&(!['paused','stopped'].includes(current.status)||!current.stopReceipt?.objects.every(receipt=>receipt.status==='terminated')))throw new Error('前一运行时仍存活，不能并行接续其未知副作用');
    if(current.status==='stopping')throw new Error('正在停止，尚不能启动新尝试');checkCancelled(this.signal(id,ctx));
    if (current.status==='integrated') throw new Error('任务已整合');
    if (current.tasks.some(task=>task.status==='unknown')) throw new Error('请通过 resume 明确接续中断任务');
    const baseline=current.baseline || await this.baseline(id,ctx.projectDir,ctx);
    if(current.schemaVersion!==3&&current.executionStyle==='team'&&!baseline&&current.tasks.some(task=>task.mode==='write'&&!current.integratedTaskIds?.includes(task.id))){this.update(id,ctx,g=>{g.status='paused';g.error='Team 写入委派需要 Git 隔离工作树，未启动成员';});this.changed(ctx);throw new Error('Team 写入委派需要 Git 隔离工作树');}
    if (baseline && current.tasks.some(task=>task.mode==='write'&&!current.integratedTaskIds?.includes(task.id))) {
      if (await this.git(id,baseline.repoRoot,['status','--porcelain'],ctx)) throw new Error('项目有未提交改动，暂不能启动隔离写入；保留这些改动后仍可使用 Single 或只读 Swarm');
      if (await this.git(id,baseline.repoRoot,['rev-parse','HEAD'],ctx)!==baseline.head) throw new Error('项目基线已变化，请创建新任务图；旧成果保留');
    }
    const catalog=current.expertCatalog??await this.freezeExpert(undefined,ctx);checkCancelled(this.signal(id,ctx));
    for(const task of current.tasks)if(task.expertId){if(object(catalog).unavailable)throw new CapabilityError('CAPABILITY_UNAVAILABLE','明确专家不可用，不能改用基础角色');this.taskExpert(task,catalog);}
    this.fence(current,ctx);
    this.update(id,ctx,g=>{g.permissionMode=ctx.policy?.permissionMode;g.temporaryWriteRoot=ctx.policy?.temporaryWriteRoot;g.baseline=baseline;g.expertCatalog=catalog;g.expertUnavailable=object(catalog).unavailable===true;g.runId=g.runId||ctx.runId||randomUUID();g.executionOwner={pid:process.pid,runtime:this.runtime};g.status='running';g.error=undefined;g.pauseReason=undefined;g.stopReceipt=undefined;if (!g.attempts.length) {g.modelId=typeof input.modelId==='string'?input.modelId:ctx.modelId;g.thinkingLevel=thinkingLevel(input.thinkingLevel,ctx.thinkingLevel??g.thinkingLevel);g.agentDir=typeof input.agentDir==='string'?resolve(input.agentDir):(ctx.agentDir || agentDirectory());}});
    this.changed(ctx);void this.track(id,this.pump(id,ctx));
  }
  /** Atomic claim is intentionally public for deterministic race verification. */
  claim(id:string,taskId:string,ctx:PluginContext,reservations?:{attemptId:string;resourceReservationId?:string;budgetReservationId?:string;budget?:BudgetSnapshot}): Attempt {
    let claimed:Attempt|undefined;
    this.update(id,ctx,graph=>{
      assertExecution(ctx,graph.executionStyle||'swarm');this.fence(graph,ctx);
      if(graph.budget?.tokenLimit!==undefined&&graph.budget.tokenUsed+graph.budget.tokenReserved>=graph.budget.tokenLimit)throw new CapabilityError('BUDGET_EXHAUSTED','任务预算耗尽');
      if (graph.status!=='running') throw new ConflictError('任务图未运行');
      const task=graph.tasks.find(t=>t.id===taskId);if(graph.schemaVersion===3&&ctx.policy&&task?.mode==='write'&&!reservations?.resourceReservationId)throw new CapabilityError('CAPABILITY_UNAVAILABLE','写成员必须绑定宿主资源预约');if(graph.schemaVersion===3&&ctx.policy&&graph.budget&&!reservations?.budgetReservationId)throw new CapabilityError('CAPABILITY_UNAVAILABLE','成员必须绑定宿主预算预留');if (!task || task.status!=='pending') throw new ConflictError('任务已被领取或不可领取');
      if(task.workflowHeld)throw new ConflictError('工作流门闸尚未放行');
      if (task.dependencies.some(dep=>!taskSettled(graph.tasks.find(t=>t.id===dep)!))) throw new ConflictError('依赖尚未完成');
      if (graph.attempts.filter(a=>a.status==='running').length>=graph.maxWorkers) throw new ConflictError('成员并发已满');
      if (graph.schemaVersion!==3 && !graph.baseline && task.mode==='write' && graph.attempts.some(a=>a.status==='running' && a.mode==='write')) throw new ConflictError('非 Git 项目写入串行');
      const catalog=graph.expertCatalog&&typeof graph.expertCatalog==='object'?graph.expertCatalog as Record<string,unknown>:undefined;const role=task.roleId&&Array.isArray(catalog?.roles)?catalog.roles.map(object).find(item=>item.id===task.roleId):undefined;
      const selected={...task,modelId:task.modelId??(typeof role?.modelId==='string'?role.modelId:undefined),thinkingLevel:task.thinkingLevel??(typeof role?.thinkingLevel==='string'?thinkingLevel(role.thinkingLevel):undefined)};
      validateTaskModel(selected,ctx,graph.modelId,graph.thinkingLevel);
      claimed={id:reservations?.attemptId??randomUUID(),resourceReservationId:reservations?.resourceReservationId,budgetReservationId:reservations?.budgetReservationId,sourceFence:graph.sourceFence,dependencyResults:task.dependencies.map(id=>{const dep=graph.tasks.find(t=>t.id===id)!;const a=graph.attempts.find(a=>a.id===dep.currentAttempt);return {taskId:id,resultRevision:dep.resultRevision,commit:a?.commit,artifactDigest:digest(this.artifacts(ctx).latest(graph.id).filter(a=>a.taskId===id).map(a=>a.digest))};}),memberId:task.memberId,retainedFrom:task.resumeFromAttempt,taskId:task.id,number:graph.attempts.filter(a=>a.taskId===task.id).length+1,resultRevision:task.resultRevision+1,requirementVersion:task.requirementVersions?.at(-1)?.version||1,status:'running',cwd:ctx.projectDir,mode:task.mode,ownerPid:process.pid,ownerRuntime:this.runtime,startedAt:now(),modelId:selected.modelId??graph.modelId,thinkingLevel:selected.thinkingLevel??graph.thinkingLevel,writeScopes:task.writeScopes};
      if(claimed.memberId)claimed.generation=this.roster(ctx).acquire(claimed.memberId,claimed.id,id,task.id,ctx,this.runtime,false,graph.schemaVersion===3).generation;
      if(reservations?.budget)graph.budget=reservations.budget;
      task.resumeFromAttempt=undefined;task.status='running';task.currentAttempt=claimed.id;graph.attempts.push(claimed);
    });return claimed!;
  }
  private async freezeExpert(task:Task|undefined,ctx:PluginContext): Promise<unknown> {
    try {const result=object(await ctx.request('expert','freeze',{expertId:task?.expertId,catalog:true},1500));if(!Array.isArray(result.experts)||typeof result.hash!=='string')throw new Error('Expert 冻结响应无效');return result;}
    catch(error){if(!/(?:optional.*absent|optional absent|optional plugin absent|expert 不可用或操作超时|插件.*(?:未加载|关闭|未安装))/i.test(errorText(error)))throw error;return {id:'basic',version:1,prompt:'使用基础任务方法；Expert 插件当前不可用。',unavailable:true};}
  }
  private taskExpert(task:Task,catalog:unknown):unknown {
    const frozen=object(structuredClone(catalog));if(frozen.unavailable)return {...frozen,prompt:`执行任务：${task.title}；Expert 插件不可用，使用基础角色。`};
    if(!task.expertId)return frozen;const experts=(frozen.experts as unknown[]).map(object);const expert=experts.find(item=>item.id===task.expertId);if(!expert)throw new Error(`明确专家 ${task.expertId} 不在已冻结目录中`);
    return {...frozen,id:expert.id,selectionMode:'explicit',selectedIds:[expert.id],adoptedIds:[expert.id],experts:[expert],prompt:`${expert.title} v${expert.version}\n${expert.prompt}${(Array.isArray(expert.skillContents)?expert.skillContents:[]).map(raw=>{const skill=object(raw);return `\n\nSkill ${skill.path} (${skill.hash})\n${skill.content}`;}).join('')}`,toolScope:Array.isArray(expert.tools)&&expert.tools.length?expert.tools:undefined};
  }
  private dependencyCommits(graph:Graph,task:Task): string[] {
    const visited=new Set<string>();const commits:string[]=[];
    const visit=(id:string)=>{if (visited.has(id)) return;visited.add(id);const dep=graph.tasks.find(t=>t.id===id)!;dep.dependencies.forEach(visit);const attempt=graph.attempts.find(a=>a.id===dep.currentAttempt);if (attempt?.commit&&!graph.integratedTaskIds?.includes(id)) commits.push(attempt.commit);};
    task.dependencies.forEach(visit);return [...new Set(commits)];
  }
  private async launch(id:string,attempt:Attempt,ctx:PluginContext): Promise<void> {
    let graph=this.get(id,ctx).value;const task=graph.tasks.find(t=>t.id===attempt.taskId)!;
    const expert=object(this.taskExpert(task,graph.expertCatalog||await this.freezeExpert(task,ctx)));
    if(task.roleId){if(expert.unavailable)throw new Error('明确角色需要启用 Expert 插件');const role=await ctx.request('expert','freeze.role',{catalogHash:expert.hash,roleId:task.roleId,capability:{tools:graph.parentTools??(task.mode==='read'?['read','grep','find','ls','friend_expert']:['read','write','edit','bash','friend_expert']),writeScopes:task.mode==='read'?[]:task.writeScopes,modelId:attempt.modelId,thinkingLevel:attempt.thinkingLevel}},1500);expert.role=role;const frozen=object(role);if(frozen.modelId&&frozen.modelId!==attempt.modelId||frozen.thinkingLevel&&frozen.thinkingLevel!==attempt.thinkingLevel)throw new Error('角色模型映射与已冻结任务配置不一致，请明确该任务型号后重试');const adopted=Array.isArray(expert.adoptedIds)?expert.adoptedIds:expert.selectedIds;expert.prompt=(Array.isArray(expert.experts)?expert.experts:[]).map(object).filter(method=>Array.isArray(adopted)&&adopted.includes(method.id)).map(method=>`${method.title} v${method.version}\n${method.prompt}`).join('\n\n');}
    let memoryText='';const memoryDependencies:CapabilityDependency[]=[];const memorySources:import('@friend-pi/core').SourceRef[]=[];
    if(graph.schemaVersion===3){try{const selected=object(await ctx.request('memory','select',{query:task.prompt,limit:6},1500));if(!Array.isArray(selected.records))throw new CapabilityError('VALIDATION_ERROR','Memory select响应无效');for(const raw of selected.records){const m=object(raw);if(typeof m.id!=='string'||!Number.isInteger(m.revision)||typeof m.hash!=='string'||typeof m.content!=='string'||digest(m.content)!==m.hash)throw new CapabilityError('SOURCE_UNAVAILABLE','Memory正文版本/摘要无效');memoryText+=`\nMemory ${m.id} v${m.revision} (${m.hash})：\n${m.content}\n适用条件：${JSON.stringify(m.conditions||[])}`;memoryDependencies.push({capability:'memory',id:m.id,version:Number(m.revision),hash:m.hash,relation:'adopted'});if(Array.isArray(m.sources))memorySources.push(...m.sources as import('@friend-pi/core').SourceRef[]);}}catch(error){if(!(error instanceof CapabilityError&&error.code==='CAPABILITY_UNAVAILABLE')&&!/(optional.*absent|不可用或操作超时|插件.*未加载)/i.test(errorText(error)))throw error;}}
    if (this.disposed) return;checkCancelled(this.signal(id,ctx));
    let cwd=ctx.projectDir;
    if(graph.baseline&&task.mode==='write'&&attempt.retainedFrom){const prior=graph.attempts.find(item=>item.id===attempt.retainedFrom);if(!prior||prior.taskId!==task.id||!contains(join(ctx.policy?.temporaryWriteRoot||ctx.dataDir,'swarm-workspaces',ctx.projectId,id,'attempts'),prior.cwd))throw new Error('原尝试工作树身份不匹配');cwd=prior.cwd;await this.git(id,cwd,['rev-parse','HEAD'],ctx);}
    else if (graph.baseline && task.mode==='write') {
      const worktree=join(ctx.policy?.temporaryWriteRoot||ctx.dataDir,'swarm-workspaces',ctx.projectId,id,'attempts',attempt.id);assertTemporaryArtifactPath(worktree,ctx.policy?.temporaryWriteRoot);mkdirSync(resolve(worktree,'..'),{recursive:true,mode:0o700});
      this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attempt.id)!.cwd=join(worktree,graph.baseline!.projectRelative);});
      await this.git(id,graph.baseline.repoRoot,['worktree','add','--detach',worktree,graph.baseline.head],ctx);
      if (this.disposed) return;checkCancelled(this.signal(id,ctx));
      for (const commit of this.dependencyCommits(graph,task)) await this.git(id,worktree,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit],ctx);
      cwd=join(worktree,graph.baseline.projectRelative);
    }
    if(!graph.baseline&&task.mode==='write'&&graph.schemaVersion===3){const staged=this.artifacts(ctx).stage(graph,attempt,ctx);cwd=staged.cwd;this.update(id,ctx,g=>{const current=g.attempts.find(a=>a.id===attempt.id)!;current.targetBaselines=staged.baselines;current.inputBaselines=staged.inputBaselines;});}
    this.fence(graph,ctx);if(attempt.resourceReservationId)await this.runtimeRequest(ctx,'resource.check',{reservationId:attempt.resourceReservationId});
    graph=this.update(id,ctx,g=>{const target=g.attempts.find(a=>a.id===attempt.id)!;target.cwd=cwd;target.expert=expert;if(g.schemaVersion===3){target.frozen={schemaVersion:3,graphRevision:this.get(id,ctx).revision,contractDigest:digest(g.contract),modelId:target.modelId,thinkingLevel:target.thinkingLevel,agentDir:g.agentDir||ctx.agentDir||agentDirectory(),parentTools:g.parentTools||[],writeScopes:target.writeScopes,permissionDigest:g.contract!.permissionDigest,memoryRefs:[],expertRefs:[],skillRefs:[],adoptionRefs:[],dependencyEpoch:g.sourceFence?.sourceEpoch||0,budget:g.budget};}});
    if (graph.status!=='running' || graph.attempts.find(a=>a.id===attempt.id)?.status!=='running'){if(attempt.memberId&&this.roster(ctx).get(attempt.memberId,ctx).state==='stopping')this.roster(ctx).update(attempt.memberId,ctx,m=>{m.state='paused';m.stopReceipt={id:attempt.id,kind:'member',status:'terminated',detail:'启动已到安全边界，未创建成员进程'};});return;}
    const teammate=attempt.memberId?this.roster(ctx).get(attempt.memberId,ctx):undefined;
    if(graph.schemaVersion===3){const selected=Array.isArray(expert.adoptedIds)?expert.adoptedIds:expert.selectedIds;const refs=(Array.isArray(expert.experts)?expert.experts:[]).map(object).filter(e=>Array.isArray(selected)&&selected.includes(e.id)).map(e=>({capability:'expert' as const,id:String(e.id),version:Number(e.version),hash:String(e.hash),relation:'adopted' as const}));this.bindDependencies(id,attempt.id,[...memoryDependencies,...refs],memorySources,ctx);graph=this.get(id,ctx).value;}
    const handoff=prepareHandoff(this.store(ctx),graph,task,graph.attempts.find(a=>a.id===attempt.id)!,this.artifacts(ctx).latest(id).filter(a=>graph.tasks.some(t=>t.currentAttempt===a.attemptId)).map(({artifactId,revision,digest,taskId})=>({artifactId,revision,digest,taskId})),memoryText);if(handoff.required)this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attempt.id)!.requiredHandoff=handoff.required;});
    const start:MemberStart={requiredHandoff:handoff.required,resourceReservationId:attempt.resourceReservationId,sourceFence:graph.sourceFence,frozen:graph.attempts.find(a=>a.id===attempt.id)?.frozen,v:teammate?2:1,memberId:attempt.memberId,rootSessionId:ctx.sessionId,generation:attempt.generation,nativeSessionFile:teammate?.sessionFile?this.roster(ctx).trustedFile(teammate,ctx):undefined,type:'start',graphId:id,taskId:task.id,attemptId:attempt.id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir || ctx.agentDir || agentDirectory(),sessionDir:teammate?join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,teammate.id):join(ctx.dataDir,'swarm-sessions',id,attempt.id),modelId:attempt.modelId,thinkingLevel:attempt.thinkingLevel,prompt:`${handoff.prompt}\n${graph.executionStyle==='team'?'只能与主 Agent 通信，不能向同级成员通信或操作共享材料。':'共享资料通过协调者提供。'}不能递归派生。交接中的记忆仅为有来源的数据，不授予权限。`,expert,mode:task.mode,writeScopes:task.writeScopes,executionStyle:graph.executionStyle,roleId:task.roleId,permissionMode:graph.permissionMode,temporaryWriteRoot:graph.temporaryWriteRoot,parentTools:graph.parentTools};
    if(graph.schemaVersion===3||handoff.required)this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attempt.id)!.startPromptDigest=digest(memberPrompt(start));});
    this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attempt.id)!.childCreationStarted=true;});
    const handle=this.launcher(start,message=>void this.track(id,this.memberOutput(id,attempt.id,message,ctx)),code=>{
      if (this.disposed) return;
      this.members.delete(attempt.id);const current=this.get(id,ctx).value.attempts.find(a=>a.id===attempt.id);
      if (current?.status==='running' && !this.finishing.has(attempt.id)) void this.fail(id,attempt.id,`成员进程退出，状态未知（${code ?? 'signal'}）`,ctx,true);
    });
    if(attempt.memberId){const timer=setTimeout(()=>{if(!this.disposed&&!this.get(id,ctx).value.attempts.find(item=>item.id===attempt.id)?.sessionId)void this.fail(id,attempt.id,'运行器未声明 v2 支持或启动超时，现场保留',ctx);},10000);timer.unref();}
    this.members.set(attempt.id,{handle,graphId:id,context:ctx});this.memberOwned(id,attempt.id,handle,ctx);this.deliverPending(id,attempt.id,ctx);this.changed(ctx);
  }
  private taskWait(graph:Graph,task:Task,ctx:PluginContext):TaskWait|undefined {
    if(task.status!=='pending')return undefined;
    if(graph.status!=='running')return {kind:graph.pauseReason?.code==='BUDGET_EXHAUSTED'?'budget':'paused',message:graph.pauseReason?.message||graph.error||'任务图尚未开始或已暂停'};
    const dependencies=task.dependencies.filter(id=>!taskSettled(graph.tasks.find(item=>item.id===id)!));if(dependencies.length)return {kind:'dependency',message:'等待前置成果',dependencyIds:dependencies};
    if(task.workflowHeld)return {kind:'workflow',message:'等待流程条件放行'};
    if(task.memberId&&this.roster(ctx).get(task.memberId,ctx).state!=='idle')return {kind:'member',message:'等待该队友结束当前任务',memberId:task.memberId};
    if(graph.budget&&(graph.budget.deadline&&Date.now()>Date.parse(graph.budget.deadline)||graph.budget.tokenLimit!==undefined&&(graph.budget.tokenUnknown||graph.budget.tokenUsed+graph.budget.tokenReserved>=graph.budget.tokenLimit)))return {kind:'budget',message:'全局预算耗尽或用量未知，必须安全暂停'};
    if(task.waiting?.kind==='resource')return task.waiting;
    if(graph.attempts.filter(attempt=>attempt.status==='running').length>=graph.maxWorkers)return {kind:'concurrency',message:'等待固定并发名额'};
    return undefined;
  }
  private retryResources(id:string,ctx:PluginContext):void {
    if(this.resourceRetries.has(id)||this.disposed)return;
    const timer=setTimeout(()=>{this.resourceRetries.delete(id);if(!this.disposed&&this.get(id,ctx).value.status==='running')void this.track(id,this.pump(id,ctx));},1000);timer.unref();this.resourceRetries.set(id,timer);
  }
  private async pump(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed || this.pumping.has(id)) return;this.pumping.add(id);
    try {const waiting=new Set<string>();
      while (!this.disposed && this.get(id,ctx).value.status==='running') {
        const graph=this.get(id,ctx).value;
        const running=graph.attempts.filter(a=>a.status==='running');
        const task=graph.tasks.find(t=>!waiting.has(t.id)&&t.status==='pending'&&(!t.memberId||this.roster(ctx).get(t.memberId,ctx).state==='idle')&&!t.workflowHeld && t.dependencies.every(dep=>taskSettled(graph.tasks.find(d=>d.id===dep)!)) && (graph.schemaVersion===3 || graph.baseline || t.mode==='read' || !running.some(a=>a.mode==='write')));
        if (!task || running.length>=graph.maxWorkers) break;
        let reservations:{attemptId:string;resourceReservationId?:string;budgetReservationId?:string;budget?:BudgetSnapshot}={attemptId:randomUUID()};
        try{if(graph.schemaVersion===3){this.fence(graph,ctx);if(task.mode==='write'){const r=object(await this.runtimeRequest(ctx,'resource.reserve',{graphId:id,taskId:task.id,attemptId:reservations.attemptId,ownerRuntime:this.runtime,generation:1,resources:graph.contract!.resources.filter(r=>r.kind==='external'||r.kind==='path'&&task.writeScopes.some(scope=>contains(resolve(ctx.projectDir,scope),resolve(ctx.projectDir,r.key))||contains(resolve(ctx.projectDir,r.key),resolve(ctx.projectDir,scope)))).map(r=>({...r,key:r.kind==='path'?resolve(ctx.projectDir,r.key):r.key}))}));reservations.resourceReservationId=text(r.reservationId);}if(graph.budget){const r=await new Budget(this.store(ctx)).reserve(graph.budget,id,task.id,reservations.attemptId,ctx);reservations.budgetReservationId=r.reservationId;reservations.budget=r.budget;}}}catch(error){if(reservations.resourceReservationId)await this.runtimeRequest(ctx,'resource.release',{reservationId:reservations.resourceReservationId});const e=normalizeCapabilityError(error);if(e.code==='VERSION_CONFLICT'&&e.details?.v===1&&e.details.waitSafe===true&&!reservations.resourceReservationId&&!reservations.budgetReservationId){const detail=e.details,reason:TaskWait={kind:'resource',message:e.error,reservationId:typeof detail.reservationId==='string'?detail.reservationId:undefined,resourceKeys:Array.isArray(detail.resourceKeys)?detail.resourceKeys.filter((v):v is string=>typeof v==='string'):undefined,blockingTaskId:typeof detail.blockingTaskId==='string'?detail.blockingTaskId:undefined,blockingGraphId:typeof detail.blockingGraphId==='string'?detail.blockingGraphId:undefined};if(digest(task.waiting??null)!==digest(reason)){this.update(id,ctx,g=>{g.tasks.find(t=>t.id===task.id)!.waiting=reason;});this.changed(ctx);}waiting.add(task.id);this.retryResources(id,ctx);continue;}this.pauseError(id,error,ctx);break;}
        let attempt:Attempt;try{attempt=this.claim(id,task.id,ctx,reservations);}catch(error){if(reservations.resourceReservationId)await this.runtimeRequest(ctx,'resource.release',{reservationId:reservations.resourceReservationId});if(graph.budget)await new Budget(this.store(ctx)).release(graph.budget,reservations.budgetReservationId,ctx);throw error;}
        this.update(id,ctx,g=>{g.tasks.find(t=>t.id===task.id)!.waiting=undefined;});try {await this.launch(id,attempt,ctx);}catch (error) {if (!this.disposed&&!this.signal(id,ctx).aborted) await this.fail(id,attempt.id,errorText(error),ctx,false,true);break;}
      }
      if (this.disposed) return;
      const graph=this.get(id,ctx).value;
      if(graph.status==='running'&&!graph.attempts.some(a=>a.status==='running')&&graph.tasks.some(t=>t.status==='unknown'||t.status==='blocked')){this.update(id,ctx,g=>{g.status='paused';g.error='有成员需要检查并明确接续';});this.changed(ctx);}
      if (graph.status==='running' && graph.tasks.every(taskSettled)) {
        if(graph.deferPreparation||graph.executionStyle==='team'&&graph.contract?.verification!=='V2'&&!graph.tasks.some(task=>task.mode==='write'&&!graph.integratedTaskIds?.includes(task.id))){this.update(id,ctx,g=>{g.status='completed';});this.changed(ctx);}
        else {this.update(id,ctx,g=>{g.status='awaiting_review';});this.changed(ctx);void this.track(id,this.prepare(id,ctx)).catch(error=>{if (!this.disposed && this.get(id,ctx).value.status==='awaiting_review') {this.update(id,ctx,g=>{g.status='paused';g.error=errorText(error);});this.changed(ctx);}});}
      }
    }finally {this.pumping.delete(id);}
  }
  private async memberOutput(id:string,attemptId:string,message:MemberOutput,ctx:PluginContext): Promise<void> {
    if (this.disposed) return;
    const active=this.get(id,ctx).value.attempts.find(attempt=>attempt.id===attemptId);
    if(active?.memberId&&(!this.roster(ctx).owns(this.roster(ctx).get(active.memberId,ctx),attemptId,active.generation)||message.protocol!==2||message.memberId!==active.memberId||message.generation!==active.generation||message.attemptId!==attemptId))return;
    if (!this.get(id,ctx).value.attempts.some(attempt=>attempt.id===attemptId && attempt.status==='running')) return;
    if (message.type==='settled') {await this.finish(id,attemptId,message,ctx);return;}
    if (message.type==='failed') {await this.fail(id,attemptId,message.error,ctx);return;}
    if(message.type==='received'||message.type==='context'){this.changed(ctx);return;}
    if(message.type==='usage'){await this.usage(id,attemptId,message.entryId,message.tokens,{...ctx,origin:'plugin'});return;}
    if(message.type==='native.check'){try{this.admitMemberChecks(id,attemptId,ctx,message);}catch(error){await this.fail(id,attemptId,error instanceof Error?error:new Error(String(error)),ctx);}return;}
    if(message.type==='started'){if(active?.memberId){const member=this.roster(ctx).get(active.memberId,ctx),entries=this.roster(ctx).history(active.memberId,ctx).entries;const entry=entries.find(raw=>raw&&typeof raw==='object'&&'id' in raw&&raw.id===message.entryId) as {type?:string;message?:{role?:string;content?:unknown}}|undefined;if(!entry||entry.type!=='message'||entry.message?.role!=='user'||digest(visibleText(entry.message.content))!==active.startPromptDigest||message.promptDigest!==active.startPromptDigest)throw new CapabilityError('SOURCE_UNAVAILABLE','成员首条原生任务未对账');this.registerChild(member.sessionId,member.sessionFile,active.cwd,ctx,join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,member.id));this.roster(ctx).update(member.id,ctx,m=>{m.state='running';if(m.provisioning)m.provisioning.firstEntryId=message.entryId;});this.deliverPending(id,attemptId,ctx);}return;}
    if (message.type==='ready') {if(active?.memberId)this.roster(ctx).update(active.memberId,ctx,member=>{member.sessionId=message.sessionId;member.sessionFile=message.sessionFile;member.cwd=active.cwd;member.modelId=active.modelId;member.thinkingLevel=active.thinkingLevel;});this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId);if (attempt) {attempt.sessionId=message.sessionId;attempt.sessionFile=message.sessionFile;}});this.deliverPending(id,attemptId,ctx);this.changed(ctx);}
    if (message.type==='processed') {
      const key=`message:${id}:${message.messageId}`;this.store(ctx).transaction(()=>{const saved=this.store(ctx).get<MemberMessage>(key);if (saved && saved.value.attemptId===attemptId && saved.value.deliveredAt && !saved.value.processedAt) {saved.value.processedAt=now();this.store(ctx).put(key,saved.value,saved.revision);}});this.changed(ctx);
    }
    if (message.type==='event') ctx.emit('swarm.member-event',{v:1,graphId:id,attemptId,memberId:active?.memberId,generation:active?.generation,event:message.event});
    if(message.type==='expert.adopted'){this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId)!;attempt.expertAdoptions=[...(attempt.expertAdoptions||[]),message.adoption];});this.changed(ctx);}
    if (message.type==='request') {
      try {
        if(message.action==='lease.check'){if(active?.resourceReservationId)await this.runtimeRequest(ctx,'resource.check',{reservationId:active.resourceReservationId});this.fence(this.get(id,ctx).value,ctx);this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,result:{valid:true}});return;}
        if(message.action==='handoff.read'){if(!active?.requiredHandoff)throw new CapabilityError('SOURCE_UNAVAILABLE','本尝试没有必读交接');this.fence(this.get(id,ctx).value,ctx);const result=readHandoff(this.store(ctx),id,active.requiredHandoff,message.input.offset,message.input.maxChars);this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,result});return;}
        if (!['send','shared.read','shared.write','expert.adopt','expert.confirm'].includes(message.action)) throw new Error('成员协作操作未获允许');
        const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId)!;
        const graph=this.get(id,ctx).value;if(graph.executionStyle==='team'&&(message.action==='shared.read'||message.action==='shared.write'||message.action==='send'&&message.input.to!=='parent'))throw new Error('Team 成员只能与主 Agent 通信');
        let result:unknown;
        if(message.action==='expert.confirm'){if(!ctx.requestWithContext)throw new CapabilityError('CAPABILITY_UNAVAILABLE','宿主没有可信成员原史接续');result=await ctx.requestWithContext('expert','adopt.confirm',message.input,this.memberContext(attempt,graph,ctx),1500);this.memberContext(attempt,graph,ctx);const response=object(result);if(graph.schemaVersion===3){if(Array.isArray(response.dependencyRefs))this.bindDependencies(id,attempt.id,response.dependencyRefs as CapabilityDependency[],[],ctx);result={...response,sourceFence:this.get(id,ctx).value.attempts.find(a=>a.id===attempt.id)!.sourceFence};}}
        else if(message.action==='expert.adopt'){
          const frozen=object(attempt.expert);if(frozen.unavailable)throw new Error('Expert 插件当前不可用');
          const chosen=(Array.isArray(frozen.experts)?frozen.experts:[]).map(object).find(expert=>expert.id===text(message.input.id));if(!chosen)throw new Error('方法不在成员冻结目录中');
          const input={catalogHash:frozen.hash,id:chosen.id,memberId:attempt.memberId||attempt.id,attemptId:attempt.id};if(graph.schemaVersion===3){if(!ctx.requestWithContext)throw new CapabilityError('CAPABILITY_UNAVAILABLE','宿主没有可信成员原史接续');result=await ctx.requestWithContext('expert','adopt.frozen',input,this.memberContext(attempt,graph,ctx),1500);}else result=await ctx.request('expert','adopt.frozen',input,1500);if(graph.schemaVersion===3)this.memberContext(attempt,graph,ctx);const response=object(result);if(graph.schemaVersion===3){const dependencies=Array.isArray(response.dependencyRefs)?response.dependencyRefs as CapabilityDependency[]:[{capability:'expert' as const,id:String(chosen.id),version:Number(chosen.version),hash:String(chosen.hash),relation:'adopted' as const}];this.bindDependencies(id,attempt.id,dependencies,[],ctx);result={...response,sourceFence:this.get(id,ctx).value.attempts.find(a=>a.id===attempt.id)!.sourceFence};}
        }else if(message.action==='send'&&message.input.to==='parent'&&attempt.memberId){ctx.emit('swarm.member-request',{v:1,graphId:id,memberId:attempt.memberId,attemptId,runId:graph.runId,body:text(message.input.body)});result={saved:true};}
        else result=await this.dispatch(message.action,{...message.input,graphId:id,from:attempt.taskId,taskId:attempt.taskId,attemptId},{...ctx,origin:'plugin'});
        this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,result});
      }catch (error) {this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,error:errorText(error)});}
    }
    if (message.type==='confirm') {
      const accepted=await this.confirm(message.title,message.message,attemptId,ctx);
      this.members.get(attemptId)?.handle.send({v:1,type:'confirm.response',requestId:message.requestId,accepted});
    }
  }
  private confirm(title:string,message:string,attemptId:string,ctx:PluginContext): Promise<boolean> {
    const id=randomUUID();return new Promise(resolveConfirm=>{
      const graphId=this.members.get(attemptId)?.graphId;if(graphId)this.confirmationOwners.set(id,graphId);
      const complete=(accepted:boolean)=>{clearTimeout(timer);this.confirmations.delete(id);this.confirmationOwners.delete(id);resolveConfirm(accepted);if(!this.disposed)this.changed(ctx);};
      const timer=setTimeout(()=>complete(false),60000);this.confirmations.set(id,complete);
      if(this.nativeConfirm)void this.nativeConfirm(title,message).then(value=>this.confirmations.get(id)?.(value),()=>this.confirmations.get(id)?.(false));
      else {ctx.emit('swarm.confirmation',{id,attemptId,title,message});this.changed(ctx);}
    });
  }
  private async finish(id:string,attemptId:string,result:Extract<MemberOutput,{type:'settled'}>,ctx:PluginContext): Promise<void> {
    if (this.disposed || this.finishing.has(attemptId)) return;
    const original=this.get(id,ctx).value;const attempt=original.attempts.find(a=>a.id===attemptId);const task=original.tasks.find(t=>t.currentAttempt===attemptId);
    if (!attempt || !task || attempt.status!=='running' || task.status!=='running') throw new ConflictError('结果不属于当前执行尝试');
    this.finishing.add(attemptId);
    try {
      if(attempt.memberId||original.schemaVersion===3){const handle=this.members.get(attemptId)?.handle;if(original.schemaVersion===3&&!handle?.closed)throw new CapabilityError('OPERATION_UNKNOWN','成员缺少受管退出收据');if(handle?.closed){const receipt=await handle.closed;if(receipt.status!=='terminated'||receipt.exitCode!==undefined&&receipt.exitCode!==0)throw new CapabilityError('OPERATION_UNKNOWN','成员尚无正常退出收据');this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.exitReceipt=receipt;});}}
      if(this.get(id,ctx).value.attempts.find(a=>a.id===attemptId)?.status!=='running')throw new CancelledError();
      let commit:string|undefined;
      if (original.baseline && attempt.mode==='write') {
        await this.git(id,attempt.cwd,['diff','--check'],ctx);
        if (await this.git(id,attempt.cwd,['status','--porcelain'],ctx)) {
          // Worktree contains only this attempt and frozen dependency commits; stage scoped changes only.
          for (const scope of attempt.writeScopes) await this.git(id,attempt.cwd,['add','--',scope],ctx);
          if (await this.git(id,attempt.cwd,['diff','--cached','--name-only'],ctx)) {await this.git(id,attempt.cwd,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','commit','-m',`Swarm ${task.title}`],ctx);commit=await this.git(id,attempt.cwd,['rev-parse','HEAD'],ctx);}
          if (await this.git(id,attempt.cwd,['status','--porcelain'],ctx)) throw new Error('成员产生写入范围外改动，保留现场并停止整合');
        }
      }
      if (this.disposed) return;checkCancelled(this.signal(id,ctx));
      if(original.schemaVersion===3){if(attempt.memberId&&!this.roster(ctx).get(attempt.memberId,ctx).provisioning?.firstEntryId)throw new CapabilityError('SOURCE_UNAVAILABLE','成员没有首条原生任务对账收据');this.registerChild(result.sessionId||attempt.sessionId,result.sessionFile||attempt.sessionFile,attempt.cwd,ctx,attempt.memberId?join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,attempt.memberId):join(ctx.dataDir,'swarm-sessions',id,attemptId));}
      if(attempt.requiredHandoff){const file=result.sessionFile||attempt.sessionFile,sessionId=result.sessionId||attempt.sessionId;this.registerChild(sessionId,file,attempt.cwd,ctx,attempt.memberId?join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,attempt.memberId):join(ctx.dataDir,'swarm-sessions',id,attemptId));const receipt=verifyHandoffRead(this.store(ctx),nativeBranch(file!),original,attempt,sessionId!);this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.handoffRead=receipt;});}
      if(attempt.resourceReservationId){await this.runtimeRequest(ctx,'resource.check',{reservationId:attempt.resourceReservationId});await this.runtimeRequest(ctx,'resource.release',{reservationId:attempt.resourceReservationId});}
      if(original.budget){const budget=await new Budget(this.store(ctx)).release(this.get(id,ctx).value.budget!,attempt.budgetReservationId,ctx);this.update(id,ctx,g=>{g.budget=budget;});}
      this.update(id,ctx,g=>{const a=g.attempts.find(x=>x.id===attemptId)!;const t=g.tasks.find(x=>x.currentAttempt===attemptId);if (!t || a.status!=='running') throw new ConflictError('执行尝试已被中断');a.status='completed';a.trialTerminalOutcome='completed';a.finishedAt=now();a.summary=result.summary.slice(0,100000);a.sessionId=result.sessionId||a.sessionId;a.sessionFile=result.sessionFile||a.sessionFile;a.commit=commit;if(g.schemaVersion===3){this.fence(g,ctx);this.artifacts(ctx).collect(g,a,ctx);}t.status='completed';t.resultRevision=a.resultRevision;});
      await this.observeMemberTrial(id,attemptId,'completed',ctx);
      if(original.executionStyle==='team')ctx.emit('team.result',{v:1,graphId:id,taskId:task.id,attemptId,runId:original.runId,mode:task.mode,sessionId:result.sessionId||attempt.sessionId,sessionFile:result.sessionFile||attempt.sessionFile});
      if(attempt.memberId)this.roster(ctx).release(attempt.memberId,attemptId,ctx);
      this.members.delete(attemptId);this.changed(ctx);void this.track(id,this.pump(id,ctx));if(attempt.memberId)setImmediate(()=>void this.wakeOrDeliver(attempt.memberId!,ctx).catch(()=>{}));
    }catch (error) {if(!this.signal(id,ctx).aborted)await this.fail(id,attemptId,error instanceof Error?error:new Error(String(error)),ctx);}finally {this.finishing.delete(attemptId);}
  }
  private async releaseAttemptReservations(id:string,attemptId:string,ctx:PluginContext):Promise<void> {
    const key=`${ctx.dataDir}:${id}:${attemptId}`,pending=this.releasingAttempts.get(key);if(pending)return pending;
    const run=(async()=>{const graph=this.get(id,ctx).value,attempt=graph.attempts.find(a=>a.id===attemptId);if(!attempt||attempt.reservationsReleased||attempt.exitReceipt?.status!=='terminated'||this.operations(ctx).list(id).some(op=>op.attemptId===attemptId&&['dispatched','unknown'].includes(op.status)))return;
      if(attempt.resourceReservationId)await this.runtimeRequest(ctx,'resource.release',{reservationId:attempt.resourceReservationId});
      if(graph.budget&&attempt.budgetReservationId){const budget=await new Budget(this.store(ctx)).release(graph.budget,attempt.budgetReservationId,ctx);this.update(id,ctx,g=>{g.budget=budget;});}
      this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attemptId)!.reservationsReleased=true;});
    })();this.releasingAttempts.set(key,run);try{await run;}finally{this.releasingAttempts.delete(key);}
  }
  private async fail(id:string,attemptId:string,rawError:string|Error,ctx:PluginContext,unknown=false,noChild=false):Promise<void> {
    const error=errorText(rawError),publicError=normalizeCapabilityError(rawError);if(this.disposed)return;const active=this.get(id,ctx).value.attempts.find(attempt=>attempt.id===attemptId);if(!active||active.status!=='running')return;
    this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId)!;attempt.status=unknown?'unknown':'failed';attempt.trialTerminalOutcome=unknown?'unknown':'failed';attempt.error=error;attempt.finishedAt=now();const task=g.tasks.find(t=>t.currentAttempt===attemptId);if(task)task.status=unknown?'unknown':'blocked';g.status='paused';g.error=error;g.pauseReason={code:unknown?'OPERATION_UNKNOWN':publicError.code,message:error};});
    let receipt:StopObject;
    if(noChild&&!active.childCreationStarted&&!this.members.has(attemptId)){receipt={id:attemptId,kind:'member',status:'terminated',detail:'启动失败，未创建成员进程'};if(active.memberId)this.roster(ctx).update(active.memberId,ctx,m=>{if(m.attemptId===attemptId){m.state='paused';m.stopReceipt=receipt;m.reason=error;}});}
    else if(active.memberId)receipt=(await this.interruptMember(active.memberId,ctx)).stopReceipt||{id:attemptId,kind:'member',status:'unknown'};
    else {receipt=await this.members.get(attemptId)?.handle.stop()||{id:attemptId,kind:'member',status:'unknown'};if(receipt.status==='terminated')this.members.delete(attemptId);}
    this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId)!;if(attempt.exitReceipt?.status==='terminated')receipt=attempt.exitReceipt;attempt.exitReceipt=receipt;if(receipt.status!=='terminated'){attempt.status='unknown';const task=g.tasks.find(t=>t.currentAttempt===attemptId);if(task)task.status='unknown';g.pauseReason={code:'OPERATION_UNKNOWN',message:error};}});
    if(receipt.status==='terminated')await this.releaseAttemptReservations(id,attemptId,ctx);
    await this.observeMemberTrial(id,attemptId,unknown||receipt.status!=='terminated'?'unknown':'failed',ctx);
    this.changed(ctx);
  }
  private sendMessage(id:string,input:JsonObject,ctx:PluginContext): MemberMessage {
    const graph=this.get(id,ctx).value;const to=text(input.to,'收件人',100);
    if(graph.collaborationVersion===2){const task=graph.tasks.find(item=>item.id===to);if(!task?.memberId)throw new Error('收件任务不存在');const sender=typeof input.from==='string'?graph.tasks.find(item=>item.id===input.from):undefined;const message=this.roster(ctx).enqueue(task.memberId,input,ctx,sender?.title||(ctx.origin==='user'?'你':'主 Agent'),sender?.memberId);void this.wakeOrDeliver(task.memberId,ctx).catch(error=>ctx.notify(errorText(error),'warning'));this.changed(ctx);return message;}if (!graph.tasks.some(t=>t.id===to)&&!(graph.executionStyle==='team'&&to==='parent')) throw new Error('收件任务不存在');
    const message:MemberMessage={id:randomUUID(),graphId:id,from:typeof input.from==='string'?input.from:'coordinator',to,body:text(input.body || input.text,'消息'),createdAt:now()};
    this.store(ctx).put(`message:${id}:${message.id}`,message,null);
    const attempt=graph.tasks.find(t=>t.id===to)?.currentAttempt;if (attempt) this.deliverPending(id,attempt,ctx);if(to==='parent')ctx.emit('team.message',{v:1,runId:graph.runId,message});this.changed(ctx);return message;
  }
  private deliverPending(id:string,attemptId:string,ctx:PluginContext): void {
    const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId);const member=this.members.get(attemptId);if (!attempt || !member || !attempt.sessionId) return;
    if(attempt.memberId){this.roster(ctx).recover(attempt.memberId,ctx);const teammate=this.roster(ctx).get(attempt.memberId,ctx);for(const message of this.roster(ctx).messages(teammate.id,ctx))if(!message.processedAt)member.handle.send({v:2,type:'steer',messageId:message.id,text:message.body,bodyDigest:message.bodyDigest,memberId:teammate.id,attemptId,generation:teammate.generation});return;}
    for (const doc of this.store(ctx).list<MemberMessage>(`message:${id}:`)) {
      if (doc.value.to!==attempt.taskId || doc.value.processedAt || (doc.value.deliveredAt && doc.value.attemptId===attemptId)) continue;
      // A delivery receipt is durable before IPC. A crash preserves uncertainty; do not redeliver
      // to the same attempt. Explicit resume can deliver it to a new attempt.
      doc.value.deliveredAt=now();doc.value.attemptId=attemptId;this.store(ctx).put(doc.key,doc.value,doc.revision);
      member.handle.send({v:1,type:'steer',messageId:doc.value.id,text:doc.value.body});
    }
  }
  private async objectiveCheck(id:string,cwd:string,check:Check,ctx:PluginContext): Promise<CheckResult> {
    assertCheckPolicy({...this.get(id,ctx).value,checks:[check]},ctx);
    let exitCode:number|null=0;let output='';
    try {const result=await managedCommand(check.command,check.args,cwd,this.signal(id,ctx),ctx,id,'check',operation=>this.own(id,operation),512*1024);output=result.stdout+result.stderr;exitCode=result.exitCode;if(result.cancelled)return {command:check.command,args:check.args,exitCode,output:output.slice(-20000),at:now(),cancelled:true};}
    catch (raw) {const error=raw as {code?:number;stdout?:string;stderr?:string;message?:string};exitCode=typeof error.code==='number'?error.code:1;output=(error.stdout||'')+(error.stderr||'')+(error.message||'');}
    return {command:check.command,args:check.args,exitCode,output:output.slice(-20000),at:now()};
  }
  private async reviewer(graph:Graph,cwd:string,ctx:PluginContext,kind:'reviewer'|'verifier'='reviewer'): Promise<Omit<Review,'at'>> {
    checkCancelled(this.signal(graph.id,ctx));this.fence(graph,ctx);const id=randomUUID();let budgetReservation:string|undefined;if(graph.budget){const r=await new Budget(this.store(ctx)).reserve(graph.budget,graph.id,kind,id,ctx);budgetReservation=r.reservationId;this.update(graph.id,ctx,g=>{g.budget=r.budget;});}const resultVersions=Object.fromEntries(graph.tasks.map(task=>[task.id,task.resultRevision]));const start:MemberStart={sourceFence:graph.sourceFence,candidateDigest:graph.integration?.candidateDigest,verificationKind:kind,v:1,type:'start',graphId:graph.id,taskId:kind==='verifier'?'independent-verifier':'independent-review',attemptId:id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir||ctx.agentDir||agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',graph.id,id),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,mode:'read',writeScopes:[],permissionMode:graph.permissionMode,temporaryWriteRoot:graph.temporaryWriteRoot,reviewResult:true,resultVersions,prompt:`你是${kind==='verifier'?'独立目标验证者，未参与实现或前次审核':'独立成果审查者，未参与实现'}。冻结候选：${graph.integration?.candidateDigest||'legacy'}；合同：${JSON.stringify(graph.contract)}。审查目标与各成果，必要时用 read/grep/find/ls 只读原文件。没有 Bash、wc 或 Git 命令；不要调用它们，不修改或派生，不使用消息和共享材料。宿主检查记录见下方，按实际记录判断；不将空记录当作已执行检查，无需重跑命令。不能只凭成员自评批准。完成后调用 swarm_review_result({approved:true|false,findings:"查阅的事实、检查证据和具体问题",taskIds:["受影响任务ID"]}) 提交不可变结论；拒绝时必须明确受影响任务，不要让无关任务返工；不能归因时taskIds为空，宿主将暂停。说明文字不算提交。目标：${graph.goal}\n成果：${JSON.stringify(graph.tasks.map(t=>({id:t.id,title:t.title,prompt:t.requirementVersions?.at(-1)?.prompt||t.prompt,resultRevision:t.resultRevision,result:graph.attempts.find(a=>a.id===t.currentAttempt)?.summary})))}\n用户补充约束：${JSON.stringify(graph.tasks.flatMap(task=>task.memberId?this.roster(ctx).messages(task.memberId,ctx).filter(message=>(message.contextGraphId||message.graphId)===graph.id&&message.from==='你'&&(message.contextKind||message.kind)==='constraint'&&!!message.processedAt&&(message.contextTaskId||graph.attempts.find(attempt=>attempt.id===message.attemptId)?.taskId)===task.id):[]))}\n宿主客观检查证据：${JSON.stringify(graph.integration?.checks || [])}`};
    if(graph.audit)start.prompt+=`\n目标控制器提供的审核材料（需要独立核验，不视为模型执行证明）：${JSON.stringify(graph.auditEvidence)}`;
    this.update(graph.id,ctx,g=>{g.reviewAttempts=[...(g.reviewAttempts||[]),{attemptId:id,cwd,status:'running',startedAt:now()}];});
    return new Promise((resolveResult,reject)=>{
      let done=false,settling=false,terminalDigest:string|undefined;let handle:MemberHandle;
      const signal=this.signal(graph.id,ctx);const abort=()=>finish(new CancelledError());
      const finish=(error?:Error,value?:Omit<Review,'at'>)=>{if (done) return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);this.members.delete(id);if(!this.disposed)this.update(graph.id,ctx,g=>{const attempt=g.reviewAttempts?.find(item=>item.attemptId===id);if(attempt){attempt.status=error?(signal.aborted?'unknown':'failed'):'completed';attempt.finishedAt=now();attempt.error=error?.message;attempt.sessionId=value?.sessionId||attempt.sessionId;attempt.sessionFile=value?.sessionFile||attempt.sessionFile;}});if (error) {void handle?.stop();reject(error);}else resolveResult(value!);};
      const timer=setTimeout(()=>finish(new Error('独立复核超时，成果已保留')),120000);
      signal.addEventListener('abort',abort,{once:true});
      try {handle=this.launcher(start,message=>{
        if(done)return;
        // Reviewers have no roster member; the attempt id gives the host a stable native-entry usage key.
        if(message.type==='usage'&&!done&&this.get(graph.id,ctx).value.reviewAttempts?.some(attempt=>attempt.attemptId===id&&attempt.status==='running'))void this.usage(graph.id,id,message.entryId,message.tokens,{...ctx,origin:'plugin'}).catch(error=>finish(error instanceof Error?error:new Error(String(error))));
        if(message.type==='ready'&&!done)this.update(graph.id,ctx,g=>{const attempt=g.reviewAttempts?.find(item=>item.attemptId===id);if(attempt){attempt.sessionId=message.sessionId;attempt.sessionFile=message.sessionFile;}});
        if (message.type==='settled') {if(settling){if(terminalDigest!==digest(message.summary))finish(new CapabilityError('VERSION_CONFLICT','独立复核终态冲突'));return;}terminalDigest=digest(message.summary);try {const result=object(JSON.parse(message.summary));if (typeof result.approved!=='boolean'||typeof result.findings!=='string') throw new Error('独立复核未提供结构化判断');const taskIds=result.taskIds===undefined?undefined:strings(result.taskIds);if(taskIds?.some(taskId=>!Object.hasOwn(resultVersions,taskId)))throw new Error('独立复核引用了不存在的任务');if(graph.schemaVersion===3&&result.resultVersions===undefined)throw new CapabilityError('VALIDATION_ERROR','缺少复核成果版本绑定');if(result.resultVersions!==undefined){const versions=object(result.resultVersions);if(Object.keys(versions).length!==Object.keys(resultVersions).length||Object.entries(resultVersions).some(([key,version])=>versions[key]!==version))throw new Error('独立复核对应的成果版本不匹配');}if(graph.schemaVersion===3&&result.candidateDigest!==start.candidateDigest)throw new CapabilityError('VERSION_CONFLICT','复核候选摘要不匹配');settling=true;const adopt=async()=>{if(graph.schemaVersion===3&&!handle.closed)throw new CapabilityError('OPERATION_UNKNOWN','独立复核缺少受管退出收据');if(handle.closed){const receipt=await handle.closed;if(receipt.status!=='terminated'||receipt.exitCode!==undefined&&receipt.exitCode!==0)throw new CapabilityError('OPERATION_UNKNOWN','独立复核未可靠退出');}this.fence(this.get(graph.id,ctx).value,ctx);if(graph.schemaVersion===3&&this.artifacts(ctx).candidate(this.get(graph.id,ctx).value)!==start.candidateDigest)throw new CapabilityError('VERSION_CONFLICT','候选在复核期间变化');if(graph.schemaVersion===3)this.registerChild(message.sessionId||this.get(graph.id,ctx).value.reviewAttempts?.find(a=>a.attemptId===id)?.sessionId,message.sessionFile||this.get(graph.id,ctx).value.reviewAttempts?.find(a=>a.attemptId===id)?.sessionFile,cwd,ctx,start.sessionDir);if(graph.budget){const budget=await new Budget(this.store(ctx)).release(this.get(graph.id,ctx).value.budget!,budgetReservation,ctx);this.update(graph.id,ctx,g=>{g.budget=budget;});}finish(undefined,{approved:result.approved as boolean,findings:text(result.findings,'复核结论'),taskIds,resultVersions,candidateDigest:start.candidateDigest,kind,attemptId:id,sessionId:message.sessionId,sessionFile:message.sessionFile});};void adopt().catch(error=>finish(error instanceof Error?error:new Error(String(error))));}catch (error) {finish(new Error(errorText(error)));}}
        if (message.type==='failed') finish(new Error(message.error));
        if (message.type==='confirm') handle.send({v:1,type:'confirm.response',requestId:message.requestId,accepted:false});
      },()=>{if (!done&&!settling) finish(new Error('独立复核进程中断'));});this.memberOwned(graph.id,id,handle,ctx);if(!done)this.members.set(id,{handle,graphId:graph.id,context:ctx});}
      catch (error) {finish(new Error(errorText(error)));}
    });
  }
  private async prepare(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed || this.preparing.has(id)) return;
    this.preparing.add(id);
    try {await this.prepareCandidate(id,ctx);}catch (error) {
      if (!this.disposed && ['awaiting_review','ready'].includes(this.get(id,ctx).value.status)) {this.update(id,ctx,g=>{g.status='paused';g.error=errorText(error);const e=normalizeCapabilityError(error);g.pauseReason={code:e.code,message:e.error};if(g.integration?.verification)g.integration.verification.status=e.code==='VERSION_CONFLICT'||e.code==='SOURCE_UNAVAILABLE'?'stale':'failed';});this.changed(ctx);}
      throw error;
    }finally {this.preparing.delete(id);}
  }
  private async prepareCandidate(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed) return;checkCancelled(this.signal(id,ctx));
    let graph=this.get(id,ctx).value;assertCheckPolicy(graph,ctx);
    if (!graph.tasks.every(taskSettled)) throw new Error('所有成果完成后才能整合复核');
    if (graph.status==='integrated' || graph.status==='ready') return;
    if(graph.schemaVersion!==3&&graph.executionStyle==='team'&&!graph.tasks.some(task=>task.mode==='write'&&!graph.integratedTaskIds?.includes(task.id))){this.update(id,ctx,g=>{g.status='completed';});this.changed(ctx);return;}
    this.update(id,ctx,g=>{g.status='awaiting_review';});
    let cwd=ctx.projectDir;
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      const integration=join(ctx.policy?.temporaryWriteRoot||ctx.dataDir,'swarm-workspaces',ctx.projectId,id,`integration-${graph.reworkRound}-${randomUUID().slice(0,8)}`);assertTemporaryArtifactPath(integration,ctx.policy?.temporaryWriteRoot);mkdirSync(resolve(integration,'..'),{recursive:true,mode:0o700});
      cwd=join(integration,graph.baseline.projectRelative);
      this.update(id,ctx,g=>{g.integration={cwd,checks:[]};});this.changed(ctx);
      await this.git(id,graph.baseline.repoRoot,['worktree','add','--detach',integration,graph.baseline.head],ctx);
      if (this.disposed) return;checkCancelled(this.signal(id,ctx));
      const visited=new Set<string>();const ordered:Task[]=[];const visit=(t:Task)=>{if (visited.has(t.id)) return;t.dependencies.forEach(dep=>visit(graph.tasks.find(item=>item.id===dep)!));visited.add(t.id);ordered.push(t);};graph.tasks.forEach(visit);
      // Publish integration cwd before merging, so conflicts have a visible retained location.
      this.update(id,ctx,g=>{g.integration={cwd,checks:[]};});this.changed(ctx);
      for (const task of ordered) {const commit=graph.attempts.find(a=>a.id===task.currentAttempt)?.commit;if (commit&&!graph.integratedTaskIds?.includes(task.id)) await this.git(id,integration,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit],ctx);}
    }
    if(graph.schemaVersion===3&&!graph.baseline&&graph.tasks.some(t=>t.mode==='write'))cwd=this.artifacts(ctx).composite(graph,ctx);
    const checks=graph.baseline && graph.tasks.some(t=>t.mode==='write') ? [{command:'git',args:['diff','--check',graph.baseline.head]},...graph.checks] : graph.checks;
    if (!checks.length && !graph.contract?.checks.length && graph.tasks.some(t=>t.mode==='write')) throw new Error('非 Git 写入需要提供客观 checks，成果已保留');
    const validatedHead=graph.baseline ? await this.git(id,cwd,['rev-parse','HEAD'],ctx) : undefined;
    this.update(id,ctx,g=>{g.integration={cwd,head:validatedHead,checks:[]};});
    this.fence(this.get(id,ctx).value,ctx);
    if(graph.schemaVersion===3){this.artifacts(ctx).collectExternal(this.get(id,ctx).value,ctx);const current=this.get(id,ctx).value,candidateDigest=this.artifacts(ctx).candidate(current);this.update(id,ctx,g=>{g.integration!.candidateDigest=candidateDigest;});this.verification({id:randomUUID(),graphId:id,level:graph.contract!.verification,status:'checking',candidateDigest,contractDigest:digest(graph.contract),checks:[],at:now()},ctx);}
    for (const check of checks) {
      const result=await this.objectiveCheck(id,cwd,check,ctx);if (this.disposed) return;this.update(id,ctx,g=>{g.integration!.checks.push(result);});
      if(result.cancelled||this.signal(id,ctx).aborted)return;
      if (result.exitCode!==0) throw new Error(`客观检查失败：${check.command} ${check.args.join(' ')}`);
      if (this.get(id,ctx).value.status!=='awaiting_review') return;
    }
    graph=this.get(id,ctx).value;
    if(graph.schemaVersion===3){
      const staged=cwd;
      for(const spec of graph.contract!.checks){const result=spec.kind==='command'?await this.objectiveCheck(id,staged,{command:spec.command!,args:spec.argv||[]},ctx):declarativeCheck(spec,staged,ctx);this.update(id,ctx,g=>{g.integration!.checks.push(result);});if(result.exitCode!==0){const v=this.get(id,ctx).value.integration!.verification!;this.verification({...v,status:'failed',checks:this.get(id,ctx).value.integration!.checks,findings:result.output},ctx);throw new CapabilityError('VALIDATION_ERROR',`客观检查失败：${spec.id}`);}}
      graph=this.get(id,ctx).value;this.fence(graph,ctx);if(this.operations(ctx).list(id).some(o=>o.status==='unknown'||o.status==='dispatched'))throw new CapabilityError('OPERATION_UNKNOWN','仍有未核对外部操作');
      if(graph.contract!.verification==='V0'){this.verification({...graph.integration!.verification!,status:'passed',checks:graph.integration!.checks},ctx);this.update(id,ctx,g=>{g.status='ready';});this.changed(ctx);if(graph.executionStyle!=='team')await this.integrate(id,ctx);return;}
      this.verification({...graph.integration!.verification!,status:'reviewing',checks:graph.integration!.checks},ctx);
    }
    const review=await this.reviewer(this.get(id,ctx).value,cwd,ctx);
    if (this.disposed) return;
    if (this.get(id,ctx).value.status!=='awaiting_review') return;
    this.update(id,ctx,g=>{const receipt={...review,at:now()};g.integration!.review=receipt;g.reviews=[...(g.reviews||[]),receipt];g.status=review.approved?'ready':'paused';if (!review.approved) g.error=review.findings;});this.changed(ctx);
    if(graph.schemaVersion===3)this.verification({...this.get(id,ctx).value.integration!.verification!,status:review.approved?'passed':'failed',modelJudged:true,reviewer:{...review,at:now()},findings:review.findings},ctx);
    if (!review.approved) {
      graph=this.get(id,ctx).value;
      if(!review.taskIds?.length){this.update(id,ctx,g=>{g.error=`复核未明确受影响任务；成果保留，等待调整方法：${review.findings}`;});this.changed(ctx);return;}
      await this.applyRework(id,review.taskIds,review.findings,ctx);void this.track(id,this.pump(id,ctx));return;
    }
    if(graph.schemaVersion===3&&graph.contract!.verification==='V2'){
      this.verification({...this.get(id,ctx).value.integration!.verification!,status:'verifying'},ctx);
      for(const check of graph.checks){const result=await this.objectiveCheck(id,cwd,check,ctx);if(result.exitCode!==0)throw new CapabilityError('VALIDATION_ERROR','独立目标oracle失败');}
      const verifier=await this.reviewer(this.get(id,ctx).value,cwd,ctx,'verifier');this.update(id,ctx,g=>{g.integration!.verifier={...verifier,at:now()};});this.verification({...this.get(id,ctx).value.integration!.verification!,status:verifier.approved?'passed':'failed',verifier:{...verifier,at:now()},findings:verifier.findings},ctx);if(!verifier.approved){this.pauseError(id,new CapabilityError('VALIDATION_ERROR',verifier.findings),ctx);return;}
    }
    if(graph.executionStyle!=='team')await this.integrate(id,ctx);
  }
  private async claimRepair(graph:Graph,taskIds:string[],reason:string,ctx:PluginContext):Promise<void> {
    const affected=new Set(taskIds);let grew=true;while(grew){grew=false;for(const task of graph.tasks)if(!affected.has(task.id)&&task.dependencies.some(dep=>affected.has(dep))){affected.add(task.id);grew=true;}}
    const block=(message:string):never=>{this.update(graph.id,ctx,g=>{for(const item of g.tasks)if(affected.has(item.id))item.status='blocked';g.status='paused';g.error=message;g.pauseReason={code:'BUDGET_EXHAUSTED',message};});this.changed(ctx);throw new CapabilityError('BUDGET_EXHAUSTED',message);};
    if(graph.reworkRound>=2||graph.tasks.some(t=>affected.has(t.id)&&t.rework>=2))block('任务图或逻辑步骤已达 2 轮修复上限');
    const logical=graph.tasks.filter(t=>affected.has(t.id)).map(t=>t.logicalStepId||`${graph.workflowId||'team'}:${t.id}`),counts=new Map<string,number>();
    if(ctx.policy&&graph.schemaVersion!==3){for(const task of graph.tasks)if(affected.has(task.id)){const r=object(await ctx.request('runtime','task.repair.claim',{goalId:graph.goalId??ctx.policy.goalId,logicalStepId:task.logicalStepId||`${graph.workflowId||'team'}:${task.id}`,reason}));if(r.allowed!==true)block('宿主修复额度已用尽或未授权');counts.set(task.id,Number(r.count));}}
    else if(graph.schemaVersion===3){const receipt=object(await this.runtimeRequest(ctx,'task.repair.claimBatch',{goalId:graph.goalId??ctx.policy?.goalId,graphId:graph.id,waveId:`${graph.id}:${graph.reworkRound+1}`,logicalStepIds:logical,reason}));if(receipt.allowed!==true)block('宿主修复额度已用尽或未授权');const admitted=object(receipt.counts);for(const task of graph.tasks)if(affected.has(task.id)){const count=admitted[task.logicalStepId||`${graph.workflowId||'team'}:${task.id}`];if(!Number.isInteger(count)||Number(count)>2)block('宿主修复额度回执无效');counts.set(task.id,Number(count));}}
    else for(const task of graph.tasks)if(affected.has(task.id))counts.set(task.id,task.rework+1);
    this.update(graph.id,ctx,g=>{for(const task of g.tasks)if(counts.has(task.id))task.rework=Math.max(task.rework,counts.get(task.id)!);});
  }
  private async applyRework(id:string,taskIds:string[],reason:string,ctx:PluginContext,changes?:JsonObject,allowUnknown=false):Promise<Graph> {
    const original=this.get(id,ctx).value;assertCheckPolicy(original,ctx);if(!taskIds.length||taskIds.some(taskId=>!original.tasks.some(t=>t.id===taskId)))throw new CapabilityError('VALIDATION_ERROR','返工任务不存在');if(original.schemaVersion===3&&!changes){const fp=failureFingerprint(original,taskIds,'review',reason,this.artifacts(ctx).latest(id).filter(a=>taskIds.includes(a.taskId)).map(a=>a.digest));if(original.failureFingerprints?.includes(fp)){this.pauseError(id,new CapabilityError('BUDGET_EXHAUSTED','相同失败证据且产物无变化，停止无进展返工'),ctx);return this.get(id,ctx).value;}this.update(id,ctx,g=>{g.failureFingerprints=[...(g.failureFingerprints||[]),fp];});}if(currentUnknown(original)&&!allowUnknown)throw new Error('未知副作用不能自动修复');await this.claimRepair(original,taskIds,reason,ctx);
    return this.update(id,ctx,g=>{
      assertCheckPolicy(g,ctx);
      if(taskIds.some(taskId=>!g.tasks.some(task=>task.id===taskId)))throw new Error('返工任务不存在');
      const affected=new Set(taskIds);let grew=true;while(grew){grew=false;for(const task of g.tasks)if(!affected.has(task.id)&&task.dependencies.some(dep=>affected.has(dep))){affected.add(task.id);grew=true;}}
      g.reworkRound++;for(const task of g.tasks)if(affected.has(task.id)){
        task.originalPrompt??=task.prompt;task.requirementVersions??=[{version:1,prompt:task.prompt,at:g.createdAt}];
        const last=task.requirementVersions.at(-1)!;const adjustment=changes?.[task.id];
        task.requirementVersions.push({version:last.version+1,prompt:typeof adjustment==='string'?text(adjustment,'返工要求'):`${last.prompt}\n第 ${g.reworkRound} 轮定向返工：${reason}`,reason,automatic:typeof adjustment!=='string',at:now()});
        task.status='pending';task.currentAttempt=undefined;if(g.workflowId)task.workflowHeld=true;
      }g.status='running';g.error=undefined;g.integration=undefined;
    });
  }
  private async rework(id:string,input:JsonObject,ctx:PluginContext):Promise<Graph> {
    if(ctx.origin!=='user')throw new Error('调整返工方法必须由用户发起');const graph=this.get(id,ctx).value;
    if(graph.status!=='paused')throw new Error('暂停并检查后才能调整返工方法');
    if(this.execution(id).operations.size||this.execution(id).activities.size)throw new Error('后台尚未到安全边界');
    const taskIds=strings(input.taskIds);if(!taskIds.length)throw new Error('明确选择受影响任务');
    if(input.revision!==undefined&&input.revision!==this.get(id,ctx).revision)throw new ConflictError();
    if(currentUnknown(graph)&&input.confirmUnknown!==true)throw new Error('检查未知副作用后需 confirmUnknown:true');
    this.executions.delete(id);await this.applyRework(id,taskIds,text(input.reason,'调整依据'),ctx,input.prompts?object(input.prompts):undefined,input.confirmUnknown===true);for(const task of this.get(id,ctx).value.tasks)if(task.status==='pending'&&task.memberId){const member=this.roster(ctx).get(task.memberId,ctx);if(member.state==='paused'&&member.stopReceipt?.status==='terminated'&&!this.members.has(member.attemptId||''))this.roster(ctx).update(member.id,ctx,m=>{m.state='idle';m.attemptId=undefined;});}this.changed(ctx);void this.track(id,this.pump(id,ctx));return this.get(id,ctx).value;
  }
  private async integrate(id:string,ctx:PluginContext): Promise<void> {
    const graph=this.get(id,ctx).value;if (graph.status==='integrated') return;
    this.fence(graph,ctx);if(graph.schemaVersion===3&&graph.integration?.candidateDigest!==this.artifacts(ctx).candidate(graph))throw new CapabilityError('VERSION_CONFLICT','候选摘要已变化，需要重新验收');
    if (graph.status!=='ready' || (graph.schemaVersion===3?graph.integration?.verification?.status!=='passed':!graph.integration?.review?.approved) || graph.integration!.checks.some(c=>c.exitCode!==0)) throw new Error('任务图尚未就绪或未满足当前合同的验证要求，不能整合');
    if(this.operations(ctx).list(id).some(o=>['dispatched','unknown'].includes(o.status)))throw new CapabilityError('OPERATION_UNKNOWN','未知操作阻止整合');
    let applyReservation:string|undefined;if(graph.schemaVersion===3&&graph.tasks.some(t=>t.mode==='write')){const r=object(await this.runtimeRequest(ctx,'resource.reserve',{graphId:id,taskId:'integration',attemptId:`apply:${graph.integration!.candidateDigest}`,ownerRuntime:this.runtime,generation:1,resources:graph.contract!.resources.filter(r=>r.access==='write').map(r=>({...r,key:r.kind==='path'?resolve(ctx.projectDir,r.key):r.key}))}));applyReservation=text(r.reservationId);this.update(id,ctx,g=>{g.integration!.applyReservationId=applyReservation;});}
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      let currentBranch:string|undefined;try {currentBranch=await this.git(id,graph.baseline.repoRoot,['symbolic-ref','HEAD'],ctx);}catch {checkCancelled(this.signal(id,ctx));}
      if (currentBranch!==graph.baseline.branch || await this.git(id,graph.baseline.repoRoot,['rev-parse','HEAD'],ctx)!==graph.baseline.head || await this.git(id,graph.baseline.repoRoot,['status','--porcelain'],ctx)) {this.update(id,ctx,g=>{g.status='paused';g.error='原项目基线或工作区已变化；整合成果保留，未覆盖用户改动';});this.changed(ctx);return;}
      const integrationHead=await this.git(id,graph.integration!.cwd,['rev-parse','HEAD'],ctx);
      if (integrationHead!==graph.integration!.head) throw new Error('整合提交在验证期间变化，需重新运行客观检查和复核');
      if (await this.git(id,graph.integration!.cwd,['status','--porcelain'],ctx)) throw new Error('整合工作区在验证后发生未提交变化');
      if(applyReservation)await this.runtimeRequest(ctx,'resource.check',{reservationId:applyReservation});this.fence(this.get(id,ctx).value,ctx);await this.git(id,graph.baseline.repoRoot,['merge','--ff-only',integrationHead],ctx);this.update(id,ctx,g=>{g.integration!.head=integrationHead;});
    }
    if(graph.schemaVersion===3&&!graph.baseline&&graph.tasks.some(t=>t.mode==='write'))await this.artifacts(ctx).apply(graph,ctx,async()=>{checkCancelled(this.signal(id,ctx));this.fence(this.get(id,ctx).value,ctx);if(applyReservation)await this.runtimeRequest(ctx,'resource.check',{reservationId:applyReservation});});
    checkCancelled(this.signal(id,ctx));this.update(id,ctx,g=>{this.fence(g,ctx);if(g.status!=='ready')throw new CancelledError();g.status='integrated';g.error=undefined;g.integratedTaskIds=g.tasks.filter(task=>task.status==='completed').map(task=>task.id);if(g.baseline&&g.integration?.head)g.baseline={...g.baseline,head:g.integration.head};});if(applyReservation)await this.runtimeRequest(ctx,'resource.release',{reservationId:applyReservation});ctx.appendEntry('friend-pi:swarm-integrated',{graphId:id,integration:graph.integration?.cwd});this.changed(ctx);
  }
  async dispose(): Promise<void> {
    if(this.disposed)return;
    for(const timer of this.resourceRetries.values())clearTimeout(timer);this.resourceRetries.clear();
    await Promise.allSettled([...this.executions.values()].flatMap(run=>run.context?this.roster(run.context).list(run.context).filter(member=>member.state==='running').map(member=>this.interruptMember(member.id,run.context!)):[]));
    await Promise.allSettled([...this.executions].map(async([id,run])=>{const active=run.operations.size||run.activities.size||(run.context&&['running','awaiting_review','ready','stopping'].includes(this.get(id,run.context).value.status));if(active&&run.context&&this.get(id,run.context).value.status!=='integrated')await this.stop(id,run.context,true);else {run.abort.abort();await Promise.allSettled([...run.operations.values()].map(operation=>operation.stop()));}}));
    // A claimed attempt can be waiting on Expert or worktree creation before its handle exists.
    // Persist its uncertainty as well, rather than leaving a live-PID orphan after /new.
    for (const store of this.stores.values()) for (const doc of store.list<Graph>('graph:')) {
      let changed=false;
      for (const attempt of doc.value.attempts) if (attempt.status==='running' && attempt.ownerRuntime===this.runtime) {attempt.status='unknown';attempt.error='会话关闭；启动或工具执行可能已发生，需显式接续';const task=doc.value.tasks.find(item=>item.currentAttempt===attempt.id);if (task) task.status='unknown';changed=true;}
      if (changed) {doc.value.status='paused';doc.value.error='会话关闭，未自动重放成员执行';store.put(doc.key,doc.value,doc.revision);}
    }
    for(const timer of this.trialRetries.values())clearTimeout(timer);this.trialRetries.clear();await Promise.allSettled([...this.trialObserving.values()]);for(const timer of this.trialRetries.values())clearTimeout(timer);this.trialRetries.clear();await Promise.allSettled([...this.releasingAttempts.values()]);
    for(const timer of this.leaseHeartbeats.values())clearInterval(timer);this.leaseHeartbeats.clear();for(const ledger of this.nativeTaskLedgers.values())ledger.dispose();this.nativeTaskLedgers.clear();for(const service of this.nativeServices.values())service.dispose();this.nativeServices.clear();this.disposed=true;this.members.clear();for (const resolver of this.confirmations.values()) resolver(false);for (const store of this.stores.values()) store.close();this.stores.clear();this.executions.clear();
  }
}

const extension:ExtensionFactory=pi=>{
  const controller=new SwarmController();
  const workflow=new DynamicWorkflowController(controller);
  let currentContext:ExtensionContext|undefined,closed=false,pendingAdvance=false,draining:Promise<void>|undefined;
  const fresh=():PluginContext|undefined=>{if(closed||!currentContext)return;const ctx=makeContext(pi,currentContext,'plugin');return ctx.executionMode||ctx.policy?ctx:{...ctx,executionMode:'swarm'};};
  const scheduleAdvance=()=>{
    if(closed||!currentContext)return;pendingAdvance=true;if(draining)return;
    draining=Promise.resolve().then(async()=>{while(pendingAdvance&&!closed){pendingAdvance=false;const ctx=fresh();if(!ctx||ctx.executionMode!=='swarm'||ctx.policy?.planMode)continue;try{await workflow.advance(ctx);}catch(error){if(!closed)ctx.notify(`流程推进暂停：${errorText(error)}`,'warning');}}}).finally(()=>{draining=undefined;if(pendingAdvance&&!closed)scheduleAdvance();});
  };
  pi.on('session_start',(_event,ctx)=>{currentContext=ctx;controller.setConfirmationHandler((title,message)=>ctx.ui.confirm(title,message));});
  pi.on('before_agent_start',(_event,ctx)=>{currentContext=ctx;});
  const offWorkflowEvents=pi.events.on('friend-pi:v1:event',raw=>{if(closed||!raw||typeof raw!=='object')return;const event=object(raw);if(!currentContext||event.sessionId!==currentContext.sessionManager.getSessionId())return;const data=event.data&&typeof event.data==='object'?object(event.data):{};if(event.pluginEvent==='swarm.changed'||event.pluginEvent==='swarm.process'&&data.action==='closed')scheduleAdvance();});
  pi.on('session_shutdown',()=>{closed=true;pendingAdvance=false;currentContext=undefined;offWorkflowEvents();});
  registerPlugin(pi,'swarm',{snapshot:ctx=>controller.snapshot(ctx),dispatch:(action,input,ctx)=>controller.dispatch(action,input,ctx),dispose:async()=>{await draining;await workflow.dispose();await controller.dispose();}},'Swarm：成果任务图、隔离成员、消息、共享材料与独立复核',{
    projectToolResult:projectSwarmToolResult,
    actionEnum:['plan.validate','resume.preview','handoff.read','artifact.list','artifact.read','budget.read','search','operation.prepare','operation.reconcile','create','start','snapshot','pause','stop','resume','prepare','integrate','rework','configure','append','update_task','send','shared.read','shared.write','shared.readVersion','shared.conflicts','member.create','member.list','member.history','member.send','member.interrupt','member.resume'],
    toolDescription:`真实 Swarm 协调工具。调用格式始终是 {"action":"合法动作","input":{...}}；所有动作数据必须放 input 对象，不能把 graphId、goal、tasks 放顶层。不要调用不存在的 status 或自行声称成员执行。
仅在用户已选择 Swarm 后组织协作，不推荐或自动切换模式。先 plan.validate {goal,reason,strategy:"direct"|"collaboration",tasks,maxWorkers?,checks?,risk?,contract?,budget?} 确定性核对草案；direct 传 tasks:[]，主 Agent 直接完成但保留必要客观检查/独立复核；collaboration 传1–64任务，经依赖、权限、冲突、预算检查后create/start自动执行。reason说明分工依据，不编造时间/费用。plan.validate只读，不创建图、不预占预算；create/start重新验证。
恢复预览：resume.preview {graphId} 只读显示keep/redo/check与绑定；resume可传previewBinding，过期会拒绝并返回新预览。unknown仍需用户明确确认；不能自动重放。snapshot tasks[].waiting显示依赖/成员/并发/资源/预算等待，安全的局部资源占用不阻塞独立任务。handoff.read {graphId,attemptId,offset,maxChars?}可核对不可变交接版本；完整约束不可截断，超8000字的必读引用须受控完整读取后才能执行。
队友动作：member.create {name,description?}；member.list {}；member.history {memberId}；member.send {memberId,body,messageId?,generation?}；member.interrupt {memberId,generation?}；member.resume {memberId,confirmUnknown?}。任务可携带 memberId 或 memberName 复用当前聊天队友。队友 idle 不是成果完成。成员只读讨论中的修改建议由你创建新尝试，不重放旧工具。
1. create 的 input={goal,tasks:[{id,title,prompt,dependencies:[],mode:"read"|"write",writeScopes:["."]}],maxWorkers?,checks?:[{command,args:[]}]}。必须明确每个任务的 mode；只读分析任务用 mode:"read"，不能省略后变成写入。需要自动规划且不提供 tasks 时明确传 automatic:true。返回 Graph.id 是完整 UUID，created 只代表计划保存，不代表成员已执行。
2. 从 create 返回值复制完整 Graph.id 到 input.graphId，不截断、不使用 task.id。例：start {"action":"start","input":{"graphId":"完整 Graph.id"}}。启动后 snapshot {"action":"snapshot","input":{}} 查询；在返回 graphs 中用 id 匹配该图并读取其 status，不存在 action:"status"。
3. pause、stop、prepare、integrate 的 input 都必须有 graphId；resume 必须有 graphId，未知副作用时还需用户明确 confirmUnknown:true，模型不能代替用户确认。prepare 返回合同要求的准备与验证状态，再用 snapshot 查询实际记录；调用本身不代表独立复核已经执行，重复 prepare 不会同时开启复核。integrate 仅整合满足当前合同验证要求的 ready 图。
4. configure input={graphId,maxWorkers:1..16}，只在空闲修改并发。send input={graphId,to:"任务 id",body:"消息"}。shared.read input={graphId,name}；shared.write input={graphId,name,content,expectedRevision}，新材料 expectedRevision:0，更新使用读取到的 revision。
5. 已创建实际协作图时，只有 snapshot 返回的目标 graphs[].status === "integrated" 才可报告该协作图完成；pending/running/awaiting_review/created/paused/stopped 均不是完成。遇到错误报告真实状态，不编造两名成员、自检或验收。原项目有未提交改动时，不 stash/reset/clean；写入阻塞应保留改动，只读任务仍可用。`,
  });
  registerPlugin(pi,'team',{
    snapshot:ctx=>{const snapshot=controller.snapshot(ctx) as {graphs:Graph[]};return {...snapshot,graphs:snapshot.graphs.filter(graph=>graph.executionStyle==='team')};},
    dispatch:(action,input,ctx)=>controller.dispatch(`team.${action}`,input,ctx),
  },'Team：主代理委派与成果判断',{
    actionEnum:['delegate','list','result','send','stop','prepare','integrate'],
    toolDescription:'Team 主代理委派工具，格式 {action,input}。delegate input={prompt,title?,mode:"read"|"write",taskId?,dependencies?:[],writeScopes?:[],modelId?,thinkingLevel?,checks?}，或 tasks:[完整任务]；默认只读、模型继承。每轮共用一个可追加的任务组。list/result 查询实际结果；send input={to:任务ID,body}；stop 停止本轮成员。只读成果返回主代理判断；写入必须通过检查与独立复核达到 ready，再由主代理明确 integrate。Single/计划模式不可启动；子代理只能与主代理通信，不递归派生。',
  });
  registerPlugin(pi,'workflow',{
    snapshot:ctx=>workflow.snapshot(ctx),
    dispatch:async(action,input,ctx)=>{const native=ctx.executionMode||ctx.policy?ctx:{...ctx,executionMode:'swarm' as const};const result=await workflow.dispatch(action,input,native);if(['create','start','resume','revise'].includes(action))scheduleAdvance();return result;},
  },'Workflow：Swarm 结构化动态流程',{
    actionEnum:['resume.preview','artifact.list','artifact.read','budget.read','search','operation.prepare','operation.reconcile','create','start','snapshot','list','status','pause','stop','resume','append','revise','template.save','template.list','template.read'],
    toolDescription:'仅 Swarm 执行的有界结构化流程，格式 {action,input}。create input={definition:{v:1,title,goal,nodes:[{id,title,prompt,mode:"read"|"write",dependencies:[],writeScopes:[],modelId?,thinkingLevel?,when?,retryWhen?,maxRetries?:0|1|2,codePaths?:[]}],maxWorkers?:1..16,parameters?}}，或 {templateId}；自然语言生成计划再存此结构，不执行任意脚本。start/status/resume/pause/stop/revise使用完整workflowId；resume.preview {workflowId}只读展示保留/重做/待核对、定义revision及输入/成果/代码摘要，不修改水位或重试次数；resume传previewBinding，过期会拒绝并提供新预览。append input={workflowId,nodes:[新增节点]}。串并行、条件和有限修复由同一Swarm任务图自动推进；节点累计最多64，恢复只复用仍有效成果；未知副作用不得自动重放。写入通过客观检查和独立复核后整合。template.save input={templateId,definition} 保存不可变模板版本。',
  });
};
export default extension;
