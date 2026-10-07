import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { agentDirectory, ConflictError, digest, object, parseModelJson, RecordStore, registerPlugin, text } from '@friend-pi/core';
import type { JsonObject, PluginContext, PluginController, StoredDocument } from '@friend-pi/core';
import { contains, destructiveCommand } from './guard.js';
import type { Attempt, Baseline, Check, CheckResult, Graph, MemberHandle, MemberLauncher, MemberMessage, MemberOutput, MemberStart, Review, SharedDocument, Task,StopObject } from './types.js';
import {managedCommand,ownChild,checkCancelled,CancelledError} from './managed.js';
import {SharedMaterials} from './shared.js';
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
function strings(value:unknown): string[] {if (!Array.isArray(value) || value.some(x=>typeof x !== 'string')) throw new Error('必须提供字符串数组'); return value as string[];}
function graphKey(projectId:string,id:string): string {return `graph:${projectId}:${id}`;}
function taskSpec(raw:unknown,index:number): Task {
  const item=object(raw); const mode=item.mode === 'read' ? 'read' : 'write';
  if(item.mode!==undefined&&item.mode!=='read'&&item.mode!=='write')throw new Error('任务 mode 必须是 read 或 write');
  const scopes=item.writeScopes === undefined ? ['.'] : strings(item.writeScopes);
  if (!scopes.length || scopes.some(path=>isAbsolute(path) || !contains('/scope',resolve('/scope',path)))) throw new Error('写入范围必须相对于成员工作区，不能越出工作区');
  const prompt=text(item.prompt || item.title,'任务要求');return {id:item.id ? text(item.id,'任务标识',100) : `task-${index+1}`,title:text(item.title,'任务标题',500),prompt,originalPrompt:prompt,requirementVersions:[{version:1,prompt,at:now()}],dependencies:item.dependencies === undefined ? [] : strings(item.dependencies),mode,expertId:item.expertId ? text(item.expertId,'专家标识',100):undefined,writeScopes:scopes,status:'pending',rework:0,resultRevision:0};
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
function checkSpecs(input:unknown): Check[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('checks 必须是数组');
  return input.map(raw=>{const c=object(raw);const command=text(c.command,'检查程序',200);const args=c.args === undefined ? [] : strings(c.args); if (destructiveCommand([command,...args].join(' '))) throw new Error('验证检查不能包含破坏性或发布操作');return {command,args};});
}
function productionLauncher(start:MemberStart,output:(message:MemberOutput)=>void,exited:(code:number|null)=>void): MemberHandle {
  const worker=process.env.FRIEND_PI_MEMBER_WORKER || fileURLToPath(new URL('./member.js',import.meta.url));
  if (!existsSync(worker)) throw new Error(`Swarm 成员运行器不存在：${worker}；请构建或完整安装 Swarm 包`);
  const groupOwned=process.platform!=='win32';const child=fork(worker,[],{cwd:start.cwd,detached:groupOwned,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,FRIEND_PI_DATA_DIR:start.dataDir,FRIEND_PI_AGENT_DIR:start.agentDir,ELECTRON_RUN_AS_NODE:'1'},execArgv:[]});
  const owned=ownChild(child,start.attemptId,'member',groupOwned,()=>{},1000);
  // Keep diagnostics bounded and never echo environment/configuration containing credentials.
  let diagnostics=''; child.stderr?.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-4000);});
  child.stdout?.resume();
  child.on('message',raw=>{if (raw && typeof raw==='object' && 'v' in raw && raw.v===1) output(raw as MemberOutput);});
  child.on('error',error=>output({v:1,type:'failed',error:error.message}));
  child.on('exit',(code)=>{if (code && diagnostics) output({v:1,type:'failed',error:`成员进程退出（${code}），请查阅保留的会话与工作区`});exited(code);});
  try{child.send(start);}catch(error){void owned.stop();throw error;}
  return {pid:child.pid,groupOwned,closed:owned.ended,send:message=>{if (child.connected) child.send(message);},stop:()=>owned.stop(()=>{if(child.connected)child.send({v:1,type:'stop'});})};
}

interface Execution {abort:AbortController;operations:Map<string,{stop:()=>Promise<StopObject>;ended?:Promise<StopObject>}>;receipts:Map<string,StopObject>;activities:Set<Promise<unknown>>;stopping?:Promise<Graph>;context?:PluginContext}

/** Every entry point uses this controller. SQLite transactions serialize claims and revisions. */
export class SwarmController implements PluginController {
  private readonly stores=new Map<string,RecordStore>();
  private readonly runtime=randomUUID();
  private readonly members=new Map<string,{handle:MemberHandle;graphId:string;context:PluginContext}>();
  private readonly pumping=new Set<string>();
  private readonly finishing=new Set<string>();
  private readonly preparing=new Set<string>();
  private readonly executions=new Map<string,Execution>();
  private readonly confirmations=new Map<string,(accepted:boolean)=>void>();
  private readonly confirmationOwners=new Map<string,string>();
  private nativeConfirm?: (title:string,message:string)=>Promise<boolean>;
  private disposed=false;
  constructor(private readonly launcher:MemberLauncher=productionLauncher) {}
  private execution(id:string):Execution {let run=this.executions.get(id);if(!run){run={abort:new AbortController(),operations:new Map(),receipts:new Map(),activities:new Set()};this.executions.set(id,run);}return run;}
  private track<T>(id:string,promise:Promise<T>):Promise<T> {const run=this.execution(id);run.activities.add(promise);void promise.then(()=>run.activities.delete(promise),()=>run.activities.delete(promise));return promise;}
  private own(id:string,operation:{id:string;stop:()=>Promise<StopObject>;ended?:Promise<StopObject>}):void {const run=this.execution(id);run.operations.set(operation.id,operation);if(operation.ended)void operation.ended.then(receipt=>{run.receipts.set(operation.id,receipt);run.operations.delete(operation.id);});}
  private memberOwned(id:string,attemptId:string,handle:MemberHandle,ctx:PluginContext):void {
    this.own(id,{id:attemptId,ended:handle.closed,stop:async()=>await handle.stop()||{id:attemptId,kind:'member',status:'unknown',pid:handle.pid,detail:'成员适配器没有提供退出回执'}});
    const inform=(action:'started'|'closed')=>{if(handle.pid)try{ctx.emit('swarm.process',{v:1,graphId:id,operationId:attemptId,kind:'member',action,pid:handle.pid,groupOwned:!!handle.groupOwned});}catch{/* Retain local ownership even when a subscriber fails. */}};inform('started');
    if(handle.closed)void handle.closed.then(()=>inform('closed'));
  }
  private signal(id:string,ctx:PluginContext):AbortSignal {const run=this.execution(id);run.context=ctx;const signal=run.abort.signal;return ctx.signal?AbortSignal.any([signal,ctx.signal]):signal;}
  private async git(id:string,cwd:string,args:string[],ctx:PluginContext):Promise<string> {
    const result=await managedCommand('git',args,cwd,this.signal(id,ctx),ctx,id,'git',operation=>this.own(id,operation));
    if(result.cancelled)throw new CancelledError();if(result.exitCode!==0)throw new Error(`Git 操作失败：${args[0]}；${result.stderr.slice(-2000)}`);return result.stdout.trim();
  }
  private async stop(id:string,ctx:PluginContext,pause=false,reason?:string):Promise<Graph> {
    const run=this.execution(id);if(run.stopping)return run.stopping;
    const original=this.get(id,ctx).value,owner=original.executionOwner;if(owner&&owner.runtime!==this.runtime&&alive(owner.pid)&&(!['paused','stopped'].includes(original.status)||!original.stopReceipt?.objects.every(receipt=>receipt.status==='terminated')))throw new Error('任务仍由另一个存活运行时持有；请在原运行时停止，不能冒充已终止');
    run.stopping=(async()=>{
      const operationId=randomUUID(),requestedAt=now();
      this.update(id,ctx,g=>{if(g.status==='integrated')throw new Error('已整合成果不能停止');g.status='stopping';for(const attempt of g.attempts)if(attempt.status==='running'){attempt.status='unknown';attempt.error='用户中断；工具副作用未重放';const task=g.tasks.find(t=>t.currentAttempt===attempt.id);if(task)task.status='unknown';}for(const attempt of g.reviewAttempts||[])if(attempt.status==='running'){attempt.status='unknown';attempt.error='用户中断独立复核；结果未采用';}});this.changed(ctx);run.abort.abort();
      for(const [confirmationId,resolver] of this.confirmations)if(this.confirmationOwners.get(confirmationId)===id)resolver(false);
      const stopped=await Promise.allSettled([...run.operations.values()].map(operation=>operation.stop()));
      const receipts=stopped.map((result,index)=>result.status==='fulfilled'?result.value:{id:`stop-${index}`,kind:'activity' as const,status:'unknown' as const,detail:errorText(result.reason)});
      if(owner?.runtime!==this.runtime)receipts.push(...(original.stopReceipt?.objects.filter(receipt=>receipt.status==='unknown')||[]));
      for(const receipt of receipts)if(receipt.status==='terminated'||!receipt.pid){run.operations.delete(receipt.id);run.receipts.set(receipt.id,receipt);}
      let timer:ReturnType<typeof setTimeout>|undefined;
      const activities=await Promise.race([Promise.allSettled([...run.activities]).then(()=>true),new Promise<false>(done=>{timer=setTimeout(()=>done(false),5000);})]);if(timer)clearTimeout(timer);
      if(!activities)receipts.push({id:operationId,kind:'activity',status:'unknown',detail:'取消后仍有后台活动未到安全边界'});
      for(const [attemptId,member] of this.members)if(member.graphId===id)this.members.delete(attemptId);
      const graph=this.update(id,ctx,g=>{g.stopReceipt={operationId,requestedAt,finishedAt:now(),objects:receipts,unknownAttemptIds:g.attempts.filter(a=>a.status==='unknown').map(a=>a.id)};g.status=pause||receipts.some(receipt=>receipt.status==='unknown')?'paused':'stopped';g.error=receipts.some(receipt=>receipt.status==='unknown')?`停止尚无完整退出回执；现场保留，请检查后显式接续${reason?`；${reason}`:''}`:reason;});this.changed(ctx);return graph;
    })();return run.stopping;
  }
  setConfirmationHandler(handler:(title:string,message:string)=>Promise<boolean>): void {this.nativeConfirm=handler;}
  private store(ctx:PluginContext): RecordStore {
    let store=this.stores.get(ctx.dataDir);if (store) return store;
    store=new RecordStore('swarm',ctx.dataDir);this.stores.set(ctx.dataDir,store);
    // Crash recovery never replays tools. A live owner process retains authority over its attempts.
    for (const doc of store.list<Graph>('graph:')) {
      let changed=false;
      for (const attempt of doc.value.attempts) if (attempt.status==='running' && !alive(attempt.ownerPid)) {
        attempt.status='unknown';attempt.error='原成员进程已结束；副作用未知，需显式接续';
        const task=doc.value.tasks.find(t=>t.currentAttempt===attempt.id);if (task) task.status='unknown';changed=true;
      }
      for(const attempt of doc.value.reviewAttempts||[])if(attempt.status==='running'&&(!doc.value.executionOwner||!alive(doc.value.executionOwner.pid))){attempt.status='unknown';attempt.error='复核运行时已结束，结果未采用';changed=true;}
      if (changed) {doc.value.status='paused';doc.value.error='检测到中断任务，尚未自动重放';store.put(doc.key,doc.value,doc.revision);}
      else if(doc.value.status==='stopping'&&(!doc.value.executionOwner||!alive(doc.value.executionOwner.pid))){doc.value.status='paused';doc.value.error='停止期间原运行时中断，退出回执未知；现场保留，需检查后显式接续';doc.value.stopReceipt={operationId:randomUUID(),requestedAt:doc.value.updatedAt,finishedAt:now(),objects:[{id:'interrupted-stop',kind:'activity',status:'unknown',detail:doc.value.error}],unknownAttemptIds:doc.value.attempts.filter(attempt=>attempt.status==='unknown').map(attempt=>attempt.id)};store.put(doc.key,doc.value,doc.revision);}
    }
    for(const doc of store.list<import('./types.js').SharedConflict>('shared-conflict:'))if(doc.value.status==='pending'&&(!doc.value.ownerPid||!alive(doc.value.ownerPid))){doc.value.status='paused';doc.value.reason='合并运行时已结束；三方材料保留，未自动重放合并';store.put(doc.key,doc.value,doc.revision);}
    return store;
  }
  private get(id:string,ctx:PluginContext): StoredDocument<Graph> {
    const doc=this.store(ctx).get<Graph>(graphKey(ctx.projectId,id));if (!doc || doc.value.sessionId!==ctx.sessionId) throw new Error('任务图不存在或不属于当前会话');return doc;
  }
  private update(id:string,ctx:PluginContext,change:(graph:Graph)=>void): Graph {
    return this.store(ctx).transaction(()=>{const doc=this.get(id,ctx);change(doc.value);doc.value.updatedAt=now();this.store(ctx).put(doc.key,doc.value,doc.revision);return doc.value;});
  }
  private changed(ctx:PluginContext): void {try{ctx.emit('swarm.changed',this.snapshot(ctx));}catch{/* Durable records remain authoritative when a refresh subscriber fails. */}}
  snapshot(ctx:PluginContext): unknown {
    if(this.disposed)throw new Error('Swarm 已关闭');
    const store=this.store(ctx);const graphs=store.list<Graph>(`graph:${ctx.projectId}:`).filter(doc=>doc.value.sessionId===ctx.sessionId).map(doc=>({...doc.value,revision:doc.revision}));
    const ids=new Set(graphs.map(graph=>graph.id));
    return {graphs,members:graphs.flatMap(graph=>graph.attempts.map(attempt=>({...attempt,graphId:graph.id}))),messages:store.list<MemberMessage>('message:').map(doc=>doc.value).filter(msg=>ids.has(msg.graphId)),shared:store.list<SharedDocument>('shared:').map(doc=>({...doc.value,revision:doc.revision})).filter(item=>ids.has(item.graphId)),sharedConflicts:store.list('shared-conflict:').map(doc=>doc.value).filter(raw=>raw&&typeof raw==='object'&&'graphId' in raw&&ids.has(String(raw.graphId))),confirmations:[...this.confirmations.keys()],status:graphs.some(graph=>['running','stopping','awaiting_review','ready'].includes(graph.status))?'running':'idle'};
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext): Promise<unknown> {
    if(this.disposed)throw new Error('Swarm 已关闭');
    if (action==='snapshot') return this.snapshot(ctx);
    if (action==='history') return {graphs:this.store(ctx).list<Graph>(`graph:${ctx.projectId}:`).map(doc=>({...doc.value,revision:doc.revision})),readOnly:true};
    if (action==='create') return this.create(input,ctx);
    if (action==='confirm') {if (ctx.origin && ctx.origin!=='user') throw new Error('关键确认必须来自用户');const resolver=this.confirmations.get(text(input.id));if (!resolver) throw new Error('确认请求已结束');resolver(input.accepted===true);return {accepted:input.accepted===true};}
    const id=text(input.graphId,'任务图标识',100);
    if (action==='start') {await this.track(id,this.start(id,input,ctx));return this.get(id,ctx).value;}
    if (action==='pause' || action==='stop')return this.stop(id,ctx,action==='pause');
    if (action==='resume') {
      const graph=this.get(id,ctx).value;
      if(graph.status==='stopping'||this.execution(id).activities.size||this.execution(id).operations.size)throw new Error('停止尚未到安全边界，请等待退出收据');
      if (graph.status==='integrated') throw new Error('已整合任务不能重新执行');
      if (graph.tasks.some(t=>t.status==='unknown') && (input.confirmUnknown!==true || (ctx.origin && ctx.origin!=='user'))) throw new Error('存在副作用未知的任务；请检查保留的会话和工作区，并由用户以 confirmUnknown:true 明确启动新尝试');
      this.update(id,ctx,g=>{for (const task of g.tasks) if (['unknown','blocked','cancelled'].includes(task.status)) {task.status='pending';task.currentAttempt=undefined;}g.error=undefined;});
      this.executions.delete(id);await this.track(id,this.start(id,input,ctx));return this.get(id,ctx).value;
    }
    if (action==='configure') return this.update(id,ctx,g=>{if (['running','stopping','awaiting_review'].includes(g.status)) throw new Error('并发配置在空闲边界修改');g.maxWorkers=number(input.maxWorkers,g.maxWorkers,1,16);});
    if (action==='send') return this.sendMessage(id,input,ctx);
    if (action==='shared.write'){
      this.get(id,ctx);try{return await this.track(id,new SharedMaterials(this.store(ctx),()=>this.changed(ctx)).write(id,input,{...ctx,signal:this.signal(id,ctx)}));}
      catch(error){if(error instanceof ConflictError&&['running','awaiting_review'].includes(this.get(id,ctx).value.status))void this.stop(id,ctx,true,errorText(error)).catch(()=>{});throw error;}
    }
    if (action==='shared.read') {this.get(id,ctx);const doc=this.store(ctx).get<SharedDocument>(`shared:${id}:${text(input.name)}`);return doc?{...doc.value,revision:doc.revision}:null;}
    if(action==='shared.readVersion'){this.get(id,ctx);return new SharedMaterials(this.store(ctx),()=>this.changed(ctx)).version(id,text(input.name),number(input.revision,0,1,10000000));}
    if(action==='shared.conflicts'){this.get(id,ctx);return this.store(ctx).list(`shared-conflict:${id}:`).map(doc=>({...object(doc.value),revision:doc.revision}));}
    if(action==='rework')return this.rework(id,input,ctx);
    if (action==='prepare' || action==='review') {
      const graph=this.get(id,ctx).value;
      if(!graph.tasks.every(task=>task.status==='completed'))throw new Error('所有成果完成后才能整合复核');
      if(graph.status==='integrated'||graph.status==='ready'||this.preparing.has(id))return graph;
      // The native review may exceed the request bridge timeout. Return its retained state
      // immediately and keep completion/failure authority in the actual member lifecycle.
      void this.track(id,this.prepare(id,ctx)).catch(()=>{});this.changed(ctx);return this.get(id,ctx).value;
    }
    if (action==='integrate') {await this.track(id,this.integrate(id,ctx));return this.get(id,ctx).value;}
    throw new Error(`未知 Swarm 操作：${action}`);
  }
  private async create(input:JsonObject,ctx:PluginContext): Promise<Graph> {
    const goal=text(input.goal || input.text,'目标');let raw=input.tasks;
    if (raw===undefined) {
      const plan=parseModelJson(await ctx.complete(`把目标拆为可交付成果任务，输出纯 JSON {"tasks":[{"id":"task-1","title":"...","prompt":"...","dependencies":[],"mode":"read|write","writeScopes":["."]}]}。任务依赖必须是 DAG，避免多成员重复修改相同文件。可用单任务，禁止编造已完成工作。目标：${goal}`,{maxTokens:3000}));raw=plan.tasks;
    }
    if (!Array.isArray(raw) || raw.length<1 || raw.length>64) throw new Error('任务数必须在 1–64 之间');
    const tasks=raw.map(taskSpec);validateDAG(tasks);
    let checks=checkSpecs(input.checks);
    if (input.checks===undefined && existsSync(join(ctx.projectDir,'package.json'))) {try {const pkg=JSON.parse(readFileSync(join(ctx.projectDir,'package.json'),'utf8'));if (pkg.scripts?.test) checks=[{command:'npm',args:['test']}];}catch {}}
    const graph:Graph={id:randomUUID(),projectId:ctx.projectId,projectDir:ctx.projectDir,sessionId:ctx.sessionId,goal,status:'created',createdAt:now(),updatedAt:now(),tasks,attempts:[],maxWorkers:number(input.maxWorkers,4,1,16),reworkRound:0,modelId:ctx.modelId,thinkingLevel:thinkingLevel(input.thinkingLevel,ctx.thinkingLevel),checks};
    this.store(ctx).put(graphKey(ctx.projectId,graph.id),graph,null);ctx.appendEntry('friend-pi:swarm-created',{graphId:graph.id,goal});this.changed(ctx);return graph;
  }
  private async baseline(id:string,projectDir:string,ctx:PluginContext): Promise<Baseline|undefined> {
    let repoRoot:string;try {repoRoot=await this.git(id,projectDir,['rev-parse','--show-toplevel'],ctx);}catch(error) {checkCancelled(this.signal(id,ctx));return undefined;}
    const head=await this.git(id,repoRoot,['rev-parse','HEAD'],ctx);let branch:string|undefined;try {branch=await this.git(id,repoRoot,['symbolic-ref','HEAD'],ctx);}catch {checkCancelled(this.signal(id,ctx));}
    return {repoRoot,projectRelative:relative(realpathSync(repoRoot),realpathSync(projectDir)),head,branch};
  }
  private async start(id:string,input:JsonObject,ctx:PluginContext): Promise<void> {
    const current=this.get(id,ctx).value;if (current.status==='running') return;
    if(current.executionOwner&&current.executionOwner.runtime!==this.runtime&&alive(current.executionOwner.pid)&&(!['paused','stopped'].includes(current.status)||!current.stopReceipt?.objects.every(receipt=>receipt.status==='terminated')))throw new Error('前一运行时仍存活，不能并行接续其未知副作用');
    if(current.status==='stopping')throw new Error('正在停止，尚不能启动新尝试');checkCancelled(this.signal(id,ctx));
    if (current.status==='integrated') throw new Error('任务已整合');
    if (current.tasks.some(task=>task.status==='unknown')) throw new Error('请通过 resume 明确接续中断任务');
    const baseline=current.baseline || await this.baseline(id,ctx.projectDir,ctx);
    if (baseline && current.tasks.some(task=>task.mode==='write')) {
      if (await this.git(id,baseline.repoRoot,['status','--porcelain'],ctx)) throw new Error('项目有未提交改动，暂不能启动隔离写入；保留这些改动后仍可使用 Single 或只读 Swarm');
      if (await this.git(id,baseline.repoRoot,['rev-parse','HEAD'],ctx)!==baseline.head) throw new Error('项目基线已变化，请创建新任务图；旧成果保留');
    }
    const catalog=current.expertCatalog??await this.freezeExpert(undefined,ctx);checkCancelled(this.signal(id,ctx));
    for(const task of current.tasks)if(task.expertId&&!object(catalog).unavailable)this.taskExpert(task,catalog);
    this.update(id,ctx,g=>{g.baseline=baseline;g.expertCatalog=catalog;g.expertUnavailable=object(catalog).unavailable===true;g.runId=g.runId||ctx.runId||randomUUID();g.executionOwner={pid:process.pid,runtime:this.runtime};g.status='running';g.error=undefined;g.stopReceipt=undefined;if (!g.attempts.length) {g.modelId=typeof input.modelId==='string'?input.modelId:ctx.modelId;g.thinkingLevel=thinkingLevel(input.thinkingLevel,ctx.thinkingLevel??g.thinkingLevel);g.agentDir=typeof input.agentDir==='string'?resolve(input.agentDir):(ctx.agentDir || agentDirectory());}});
    this.changed(ctx);void this.track(id,this.pump(id,ctx));
  }
  /** Atomic claim is intentionally public for deterministic race verification. */
  claim(id:string,taskId:string,ctx:PluginContext): Attempt {
    let claimed:Attempt|undefined;
    this.update(id,ctx,graph=>{
      if (graph.status!=='running') throw new ConflictError('任务图未运行');
      const task=graph.tasks.find(t=>t.id===taskId);if (!task || task.status!=='pending') throw new ConflictError('任务已被领取或不可领取');
      if (task.dependencies.some(dep=>graph.tasks.find(t=>t.id===dep)?.status!=='completed')) throw new ConflictError('依赖尚未完成');
      if (graph.attempts.filter(a=>a.status==='running').length>=graph.maxWorkers) throw new ConflictError('成员并发已满');
      if (!graph.baseline && task.mode==='write' && graph.attempts.some(a=>a.status==='running' && a.mode==='write')) throw new ConflictError('非 Git 项目写入串行');
      claimed={id:randomUUID(),taskId:task.id,number:graph.attempts.filter(a=>a.taskId===task.id).length+1,resultRevision:task.resultRevision+1,requirementVersion:task.requirementVersions?.at(-1)?.version||1,status:'running',cwd:ctx.projectDir,mode:task.mode,ownerPid:process.pid,ownerRuntime:this.runtime,startedAt:now(),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,writeScopes:task.writeScopes};
      task.status='running';task.currentAttempt=claimed.id;graph.attempts.push(claimed);
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
    const visit=(id:string)=>{if (visited.has(id)) return;visited.add(id);const dep=graph.tasks.find(t=>t.id===id)!;dep.dependencies.forEach(visit);const attempt=graph.attempts.find(a=>a.id===dep.currentAttempt);if (attempt?.commit) commits.push(attempt.commit);};
    task.dependencies.forEach(visit);return [...new Set(commits)];
  }
  private async launch(id:string,attempt:Attempt,ctx:PluginContext): Promise<void> {
    let graph=this.get(id,ctx).value;const task=graph.tasks.find(t=>t.id===attempt.taskId)!;
    const expert=this.taskExpert(task,graph.expertCatalog||await this.freezeExpert(task,ctx));
    if (this.disposed) return;checkCancelled(this.signal(id,ctx));
    let cwd=ctx.projectDir;
    if (graph.baseline && task.mode==='write') {
      const worktree=join(ctx.dataDir,'swarm-workspaces',ctx.projectId,id,'attempts',attempt.id);mkdirSync(resolve(worktree,'..'),{recursive:true,mode:0o700});
      this.update(id,ctx,g=>{g.attempts.find(a=>a.id===attempt.id)!.cwd=join(worktree,graph.baseline!.projectRelative);});
      await this.git(id,graph.baseline.repoRoot,['worktree','add','--detach',worktree,graph.baseline.head],ctx);
      if (this.disposed) return;checkCancelled(this.signal(id,ctx));
      for (const commit of this.dependencyCommits(graph,task)) await this.git(id,worktree,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit],ctx);
      cwd=join(worktree,graph.baseline.projectRelative);
    }
    graph=this.update(id,ctx,g=>{const target=g.attempts.find(a=>a.id===attempt.id)!;target.cwd=cwd;target.expert=expert;});
    if (graph.status!=='running' || graph.attempts.find(a=>a.id===attempt.id)?.status!=='running') return;
    const dependencies=task.dependencies.map(dep=>{const previous=graph.attempts.find(a=>a.id===graph.tasks.find(t=>t.id===dep)?.currentAttempt);return {taskId:dep,summary:previous?.summary};});
    const requirements=task.requirementVersions?.at(-1)?.prompt||task.prompt;
    const start:MemberStart={v:1,type:'start',graphId:id,taskId:task.id,attemptId:attempt.id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir || ctx.agentDir || agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',id,attempt.id),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,prompt:`目标：${graph.goal}\n本次成果：${task.title}\n要求：${requirements}\n前置成果：${JSON.stringify(dependencies)}\n共享资料通过协调者提供，不能递归派生。`,expert,mode:task.mode,writeScopes:task.writeScopes};
    const handle=this.launcher(start,message=>void this.track(id,this.memberOutput(id,attempt.id,message,ctx)),code=>{
      if (this.disposed) return;
      this.members.delete(attempt.id);const current=this.get(id,ctx).value.attempts.find(a=>a.id===attempt.id);
      if (current?.status==='running' && !this.finishing.has(attempt.id)) void this.fail(id,attempt.id,`成员进程退出，状态未知（${code ?? 'signal'}）`,ctx,true);
    });
    this.members.set(attempt.id,{handle,graphId:id,context:ctx});this.memberOwned(id,attempt.id,handle,ctx);this.deliverPending(id,attempt.id,ctx);this.changed(ctx);
  }
  private async pump(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed || this.pumping.has(id)) return;this.pumping.add(id);
    try {
      while (!this.disposed && this.get(id,ctx).value.status==='running') {
        const graph=this.get(id,ctx).value;
        const running=graph.attempts.filter(a=>a.status==='running');
        const task=graph.tasks.find(t=>t.status==='pending' && t.dependencies.every(dep=>graph.tasks.find(d=>d.id===dep)?.status==='completed') && (graph.baseline || t.mode==='read' || !running.some(a=>a.mode==='write')));
        if (!task || running.length>=graph.maxWorkers) break;
        const attempt=this.claim(id,task.id,ctx);
        try {await this.launch(id,attempt,ctx);}catch (error) {if (!this.disposed&&!this.signal(id,ctx).aborted) await this.fail(id,attempt.id,errorText(error),ctx);break;}
      }
      if (this.disposed) return;
      const graph=this.get(id,ctx).value;
      if (graph.status==='running' && graph.tasks.every(t=>t.status==='completed')) {this.update(id,ctx,g=>{g.status='awaiting_review';});this.changed(ctx);void this.track(id,this.prepare(id,ctx)).catch(error=>{if (!this.disposed && this.get(id,ctx).value.status==='awaiting_review') {this.update(id,ctx,g=>{g.status='paused';g.error=errorText(error);});this.changed(ctx);}});}
    }finally {this.pumping.delete(id);}
  }
  private async memberOutput(id:string,attemptId:string,message:MemberOutput,ctx:PluginContext): Promise<void> {
    if (this.disposed) return;
    if (!this.get(id,ctx).value.attempts.some(attempt=>attempt.id===attemptId && attempt.status==='running')) return;
    if (message.type==='settled') {await this.finish(id,attemptId,message,ctx);return;}
    if (message.type==='failed') {await this.fail(id,attemptId,message.error,ctx);return;}
    if (message.type==='ready') {this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId);if (attempt) {attempt.sessionId=message.sessionId;attempt.sessionFile=message.sessionFile;}});this.deliverPending(id,attemptId,ctx);this.changed(ctx);}
    if (message.type==='processed') {
      const key=`message:${id}:${message.messageId}`;this.store(ctx).transaction(()=>{const saved=this.store(ctx).get<MemberMessage>(key);if (saved && saved.value.attemptId===attemptId && saved.value.deliveredAt && !saved.value.processedAt) {saved.value.processedAt=now();this.store(ctx).put(key,saved.value,saved.revision);}});this.changed(ctx);
    }
    if (message.type==='event') ctx.emit('swarm.member-event',{graphId:id,attemptId,event:message.event});
    if(message.type==='expert.adopted'){this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId)!;attempt.expertAdoptions=[...(attempt.expertAdoptions||[]),message.adoption];});this.changed(ctx);}
    if (message.type==='request') {
      try {
        if (!['send','shared.read','shared.write','expert.adopt'].includes(message.action)) throw new Error('成员协作操作未获允许');
        const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId)!;
        let result:unknown;
        if(message.action==='expert.adopt'){
          const frozen=object(attempt.expert);if(frozen.unavailable)throw new Error('Expert 插件当前不可用');
          const chosen=(Array.isArray(frozen.experts)?frozen.experts:[]).map(object).find(expert=>expert.id===text(message.input.id));if(!chosen)throw new Error('方法不在成员冻结目录中');
          result=await ctx.request('expert','adopt.frozen',{catalogHash:frozen.hash,id:chosen.id},1500);
        }else result=await this.dispatch(message.action,{...message.input,graphId:id,from:attempt.taskId,taskId:attempt.taskId,attemptId},{...ctx,origin:'plugin'});
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
      this.update(id,ctx,g=>{const a=g.attempts.find(x=>x.id===attemptId)!;const t=g.tasks.find(x=>x.currentAttempt===attemptId);if (!t || a.status!=='running') throw new ConflictError('执行尝试已被中断');a.status='completed';a.finishedAt=now();a.summary=result.summary.slice(0,100000);a.sessionId=result.sessionId||a.sessionId;a.sessionFile=result.sessionFile||a.sessionFile;a.commit=commit;t.status='completed';t.resultRevision=a.resultRevision;});
      this.members.delete(attemptId);this.changed(ctx);void this.track(id,this.pump(id,ctx));
    }catch (error) {if(!this.signal(id,ctx).aborted)await this.fail(id,attemptId,errorText(error),ctx);}finally {this.finishing.delete(attemptId);}
  }
  private async fail(id:string,attemptId:string,error:string,ctx:PluginContext,unknown=false): Promise<void> {
    if (this.disposed) return;
    this.update(id,ctx,g=>{const attempt=g.attempts.find(a=>a.id===attemptId);if (!attempt || attempt.status!=='running') return;attempt.status=unknown?'unknown':'failed';attempt.error=error;attempt.finishedAt=now();const task=g.tasks.find(t=>t.currentAttempt===attemptId);if (task) task.status=unknown?'unknown':'blocked';g.status='paused';g.error=error;});
    this.members.get(attemptId)?.handle.stop();this.members.delete(attemptId);this.changed(ctx);
  }
  private sendMessage(id:string,input:JsonObject,ctx:PluginContext): MemberMessage {
    const graph=this.get(id,ctx).value;const to=text(input.to,'收件人',100);if (!graph.tasks.some(t=>t.id===to)) throw new Error('收件任务不存在');
    const message:MemberMessage={id:randomUUID(),graphId:id,from:typeof input.from==='string'?input.from:'coordinator',to,body:text(input.body || input.text,'消息'),createdAt:now()};
    this.store(ctx).put(`message:${id}:${message.id}`,message,null);
    const attempt=graph.tasks.find(t=>t.id===to)?.currentAttempt;if (attempt) this.deliverPending(id,attempt,ctx);this.changed(ctx);return message;
  }
  private deliverPending(id:string,attemptId:string,ctx:PluginContext): void {
    const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId);const member=this.members.get(attemptId);if (!attempt || !member || !attempt.sessionId) return;
    for (const doc of this.store(ctx).list<MemberMessage>(`message:${id}:`)) {
      if (doc.value.to!==attempt.taskId || doc.value.processedAt || (doc.value.deliveredAt && doc.value.attemptId===attemptId)) continue;
      // A delivery receipt is durable before IPC. A crash preserves uncertainty; do not redeliver
      // to the same attempt. Explicit resume can deliver it to a new attempt.
      doc.value.deliveredAt=now();doc.value.attemptId=attemptId;this.store(ctx).put(doc.key,doc.value,doc.revision);
      member.handle.send({v:1,type:'steer',messageId:doc.value.id,text:doc.value.body});
    }
  }
  private async objectiveCheck(id:string,cwd:string,check:Check,ctx:PluginContext): Promise<CheckResult> {
    let exitCode:number|null=0;let output='';
    try {const result=await managedCommand(check.command,check.args,cwd,this.signal(id,ctx),ctx,id,'check',operation=>this.own(id,operation),512*1024);output=result.stdout+result.stderr;exitCode=result.exitCode;if(result.cancelled)return {command:check.command,args:check.args,exitCode,output:output.slice(-20000),at:now(),cancelled:true};}
    catch (raw) {const error=raw as {code?:number;stdout?:string;stderr?:string;message?:string};exitCode=typeof error.code==='number'?error.code:1;output=(error.stdout||'')+(error.stderr||'')+(error.message||'');}
    return {command:check.command,args:check.args,exitCode,output:output.slice(-20000),at:now()};
  }
  private async reviewer(graph:Graph,cwd:string,ctx:PluginContext): Promise<Omit<Review,'at'>> {
    checkCancelled(this.signal(graph.id,ctx));const id=randomUUID();const resultVersions=Object.fromEntries(graph.tasks.map(task=>[task.id,task.resultRevision]));const start:MemberStart={v:1,type:'start',graphId:graph.id,taskId:'independent-review',attemptId:id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir||ctx.agentDir||agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',graph.id,id),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,mode:'read',writeScopes:[],reviewResult:true,resultVersions,prompt:`你是独立成果审查者，未参与实现。审查目标与各成果，必要时用 read/grep/find/ls 只读原文件。没有 Bash、wc 或 Git 命令；不要调用它们，不修改或派生，不使用消息和共享材料。宿主客观检查已经实际执行，直接使用下方证据，无需重跑。不能只凭成员自评批准。完成后调用 swarm_review_result({approved:true|false,findings:"查阅的事实、检查证据和具体问题",taskIds:["受影响任务ID"]}) 提交不可变结论；拒绝时必须明确受影响任务，不要让无关任务返工；不能归因时taskIds为空，宿主将暂停。说明文字不算提交。目标：${graph.goal}\n成果：${JSON.stringify(graph.tasks.map(t=>({id:t.id,title:t.title,prompt:t.requirementVersions?.at(-1)?.prompt||t.prompt,resultRevision:t.resultRevision,result:graph.attempts.find(a=>a.id===t.currentAttempt)?.summary})))}\n宿主客观检查证据：${JSON.stringify(graph.integration?.checks || [])}`};
    this.update(graph.id,ctx,g=>{g.reviewAttempts=[...(g.reviewAttempts||[]),{attemptId:id,cwd,status:'running',startedAt:now()}];});
    return new Promise((resolveResult,reject)=>{
      let done=false;let handle:MemberHandle;
      const signal=this.signal(graph.id,ctx);const abort=()=>finish(new CancelledError());
      const finish=(error?:Error,value?:Omit<Review,'at'>)=>{if (done) return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);this.members.delete(id);if(!this.disposed)this.update(graph.id,ctx,g=>{const attempt=g.reviewAttempts?.find(item=>item.attemptId===id);if(attempt){attempt.status=error?(signal.aborted?'unknown':'failed'):'completed';attempt.finishedAt=now();attempt.error=error?.message;attempt.sessionId=value?.sessionId||attempt.sessionId;attempt.sessionFile=value?.sessionFile||attempt.sessionFile;}});if (error) {void handle?.stop();reject(error);}else resolveResult(value!);};
      const timer=setTimeout(()=>finish(new Error('独立复核超时，成果已保留')),120000);
      signal.addEventListener('abort',abort,{once:true});
      try {handle=this.launcher(start,message=>{
        if(message.type==='ready'&&!done)this.update(graph.id,ctx,g=>{const attempt=g.reviewAttempts?.find(item=>item.attemptId===id);if(attempt){attempt.sessionId=message.sessionId;attempt.sessionFile=message.sessionFile;}});
        if (message.type==='settled') {try {const result=object(JSON.parse(message.summary));if (typeof result.approved!=='boolean'||typeof result.findings!=='string') throw new Error('独立复核未提供结构化判断');const taskIds=result.taskIds===undefined?undefined:strings(result.taskIds);if(taskIds?.some(taskId=>!Object.hasOwn(resultVersions,taskId)))throw new Error('独立复核引用了不存在的任务');if(result.resultVersions!==undefined){const versions=object(result.resultVersions);if(Object.keys(versions).length!==Object.keys(resultVersions).length||Object.entries(resultVersions).some(([key,version])=>versions[key]!==version))throw new Error('独立复核对应的成果版本不匹配');}finish(undefined,{approved:result.approved,findings:text(result.findings,'复核结论'),taskIds,resultVersions,attemptId:id,sessionId:message.sessionId,sessionFile:message.sessionFile});}catch (error) {finish(new Error(errorText(error)));}}
        if (message.type==='failed') finish(new Error(message.error));
        if (message.type==='confirm') handle.send({v:1,type:'confirm.response',requestId:message.requestId,accepted:false});
      },()=>{if (!done) finish(new Error('独立复核进程中断'));});this.memberOwned(graph.id,id,handle,ctx);if(!done)this.members.set(id,{handle,graphId:graph.id,context:ctx});}
      catch (error) {finish(new Error(errorText(error)));}
    });
  }
  private async prepare(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed || this.preparing.has(id)) return;
    this.preparing.add(id);
    try {await this.prepareCandidate(id,ctx);}catch (error) {
      if (!this.disposed && ['awaiting_review','ready'].includes(this.get(id,ctx).value.status)) {this.update(id,ctx,g=>{g.status='paused';g.error=errorText(error);});this.changed(ctx);}
      throw error;
    }finally {this.preparing.delete(id);}
  }
  private async prepareCandidate(id:string,ctx:PluginContext): Promise<void> {
    if (this.disposed) return;checkCancelled(this.signal(id,ctx));
    let graph=this.get(id,ctx).value;
    if (!graph.tasks.every(t=>t.status==='completed')) throw new Error('所有成果完成后才能整合复核');
    if (graph.status==='integrated' || graph.status==='ready') return;
    this.update(id,ctx,g=>{g.status='awaiting_review';});
    let cwd=ctx.projectDir;
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      const integration=join(ctx.dataDir,'swarm-workspaces',ctx.projectId,id,`integration-${graph.reworkRound}-${randomUUID().slice(0,8)}`);mkdirSync(resolve(integration,'..'),{recursive:true,mode:0o700});
      cwd=join(integration,graph.baseline.projectRelative);
      this.update(id,ctx,g=>{g.integration={cwd,checks:[]};});this.changed(ctx);
      await this.git(id,graph.baseline.repoRoot,['worktree','add','--detach',integration,graph.baseline.head],ctx);
      if (this.disposed) return;checkCancelled(this.signal(id,ctx));
      const visited=new Set<string>();const ordered:Task[]=[];const visit=(t:Task)=>{if (visited.has(t.id)) return;t.dependencies.forEach(dep=>visit(graph.tasks.find(item=>item.id===dep)!));visited.add(t.id);ordered.push(t);};graph.tasks.forEach(visit);
      // Publish integration cwd before merging, so conflicts have a visible retained location.
      this.update(id,ctx,g=>{g.integration={cwd,checks:[]};});this.changed(ctx);
      for (const task of ordered) {const commit=graph.attempts.find(a=>a.id===task.currentAttempt)?.commit;if (commit) await this.git(id,integration,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit],ctx);}
    }
    const checks=graph.baseline && graph.tasks.some(t=>t.mode==='write') ? [{command:'git',args:['diff','--check',graph.baseline.head]},...graph.checks] : graph.checks;
    if (!checks.length && graph.tasks.some(t=>t.mode==='write')) throw new Error('非 Git 写入需要提供客观 checks，成果已保留');
    const validatedHead=graph.baseline ? await this.git(id,cwd,['rev-parse','HEAD'],ctx) : undefined;
    this.update(id,ctx,g=>{g.integration={cwd,head:validatedHead,checks:[]};});
    for (const check of checks) {
      const result=await this.objectiveCheck(id,cwd,check,ctx);if (this.disposed) return;this.update(id,ctx,g=>{g.integration!.checks.push(result);});
      if(result.cancelled||this.signal(id,ctx).aborted)return;
      if (result.exitCode!==0) throw new Error(`客观检查失败：${check.command} ${check.args.join(' ')}`);
      if (this.get(id,ctx).value.status!=='awaiting_review') return;
    }
    graph=this.get(id,ctx).value;const review=await this.reviewer(graph,cwd,ctx);
    if (this.disposed) return;
    if (this.get(id,ctx).value.status!=='awaiting_review') return;
    this.update(id,ctx,g=>{const receipt={...review,at:now()};g.integration!.review=receipt;g.reviews=[...(g.reviews||[]),receipt];g.status=review.approved?'ready':'paused';if (!review.approved) g.error=review.findings;});this.changed(ctx);
    if (!review.approved) {
      graph=this.get(id,ctx).value;if (graph.reworkRound>=2) {this.update(id,ctx,g=>{g.error=`已达 2 轮自动返工上限：${review.findings}`;});return;}
      if(!review.taskIds?.length){this.update(id,ctx,g=>{g.error=`复核未明确受影响任务；成果保留，等待调整方法：${review.findings}`;});this.changed(ctx);return;}
      this.applyRework(id,review.taskIds,review.findings,ctx);void this.track(id,this.pump(id,ctx));return;
    }
    await this.integrate(id,ctx);
  }
  private applyRework(id:string,taskIds:string[],reason:string,ctx:PluginContext,changes?:JsonObject):Graph {
    return this.update(id,ctx,g=>{
      if(taskIds.some(taskId=>!g.tasks.some(task=>task.id===taskId)))throw new Error('返工任务不存在');
      const affected=new Set(taskIds);let grew=true;while(grew){grew=false;for(const task of g.tasks)if(!affected.has(task.id)&&task.dependencies.some(dep=>affected.has(dep))){affected.add(task.id);grew=true;}}
      g.reworkRound++;for(const task of g.tasks)if(affected.has(task.id)){
        task.originalPrompt??=task.prompt;task.requirementVersions??=[{version:1,prompt:task.prompt,at:g.createdAt}];
        const last=task.requirementVersions.at(-1)!;const adjustment=changes?.[task.id];
        task.requirementVersions.push({version:last.version+1,prompt:typeof adjustment==='string'?text(adjustment,'返工要求'):`${last.prompt}\n第 ${g.reworkRound} 轮定向返工：${reason}`,reason,at:now()});
        task.status='pending';task.currentAttempt=undefined;task.rework++;
      }g.status='running';g.error=undefined;g.integration=undefined;
    });
  }
  private async rework(id:string,input:JsonObject,ctx:PluginContext):Promise<Graph> {
    if(ctx.origin!=='user')throw new Error('调整返工方法必须由用户发起');const graph=this.get(id,ctx).value;
    if(graph.status!=='paused')throw new Error('暂停并检查后才能调整返工方法');
    if(this.execution(id).operations.size||this.execution(id).activities.size)throw new Error('后台尚未到安全边界');
    const taskIds=strings(input.taskIds);if(!taskIds.length)throw new Error('明确选择受影响任务');
    if(input.revision!==undefined&&input.revision!==this.get(id,ctx).revision)throw new ConflictError();
    if(graph.attempts.some(attempt=>attempt.status==='unknown')&&input.confirmUnknown!==true)throw new Error('检查未知副作用后需 confirmUnknown:true');
    this.executions.delete(id);this.applyRework(id,taskIds,text(input.reason,'调整依据'),ctx,input.prompts?object(input.prompts):undefined);this.changed(ctx);void this.track(id,this.pump(id,ctx));return this.get(id,ctx).value;
  }
  private async integrate(id:string,ctx:PluginContext): Promise<void> {
    const graph=this.get(id,ctx).value;if (graph.status==='integrated') return;
    if (graph.status!=='ready' || !graph.integration?.review?.approved || graph.integration.checks.some(c=>c.exitCode!==0)) throw new Error('客观检查和独立复核通过后才能整合');
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      let currentBranch:string|undefined;try {currentBranch=await this.git(id,graph.baseline.repoRoot,['symbolic-ref','HEAD'],ctx);}catch {checkCancelled(this.signal(id,ctx));}
      if (currentBranch!==graph.baseline.branch || await this.git(id,graph.baseline.repoRoot,['rev-parse','HEAD'],ctx)!==graph.baseline.head || await this.git(id,graph.baseline.repoRoot,['status','--porcelain'],ctx)) {this.update(id,ctx,g=>{g.status='paused';g.error='原项目基线或工作区已变化；整合成果保留，未覆盖用户改动';});this.changed(ctx);return;}
      const integrationHead=await this.git(id,graph.integration.cwd,['rev-parse','HEAD'],ctx);
      if (integrationHead!==graph.integration.head) throw new Error('整合提交在验证期间变化，需重新运行客观检查和复核');
      if (await this.git(id,graph.integration.cwd,['status','--porcelain'],ctx)) throw new Error('整合工作区在验证后发生未提交变化');
      await this.git(id,graph.baseline.repoRoot,['merge','--ff-only',integrationHead],ctx);this.update(id,ctx,g=>{g.integration!.head=integrationHead;});
    }
    checkCancelled(this.signal(id,ctx));this.update(id,ctx,g=>{if(g.status!=='ready')throw new CancelledError();g.status='integrated';g.error=undefined;});ctx.appendEntry('friend-pi:swarm-integrated',{graphId:id,integration:graph.integration?.cwd});this.changed(ctx);
  }
  async dispose(): Promise<void> {
    if(this.disposed)return;
    await Promise.allSettled([...this.executions].map(async([id,run])=>{const active=run.operations.size||run.activities.size||(run.context&&['running','awaiting_review','ready','stopping'].includes(this.get(id,run.context).value.status));if(active&&run.context&&this.get(id,run.context).value.status!=='integrated')await this.stop(id,run.context,true);else {run.abort.abort();await Promise.allSettled([...run.operations.values()].map(operation=>operation.stop()));}}));
    // A claimed attempt can be waiting on Expert or worktree creation before its handle exists.
    // Persist its uncertainty as well, rather than leaving a live-PID orphan after /new.
    for (const store of this.stores.values()) for (const doc of store.list<Graph>('graph:')) {
      let changed=false;
      for (const attempt of doc.value.attempts) if (attempt.status==='running' && attempt.ownerRuntime===this.runtime) {attempt.status='unknown';attempt.error='会话关闭；启动或工具执行可能已发生，需显式接续';const task=doc.value.tasks.find(item=>item.currentAttempt===attempt.id);if (task) task.status='unknown';changed=true;}
      if (changed) {doc.value.status='paused';doc.value.error='会话关闭，未自动重放成员执行';store.put(doc.key,doc.value,doc.revision);}
    }
    this.disposed=true;this.members.clear();for (const resolver of this.confirmations.values()) resolver(false);for (const store of this.stores.values()) store.close();this.stores.clear();this.executions.clear();
  }
}

const extension:ExtensionFactory=pi=>{
  const controller=new SwarmController();
  pi.on('session_start',(_event,ctx)=>{controller.setConfirmationHandler((title,message)=>ctx.ui.confirm(title,message));});
  registerPlugin(pi,'swarm',controller,'Swarm：成果任务图、隔离成员、消息、共享材料与独立复核',{
    actionEnum:['create','start','snapshot','pause','stop','resume','prepare','integrate','rework','configure','send','shared.read','shared.write','shared.readVersion','shared.conflicts'],
    toolDescription:`真实 Swarm 协调工具。调用格式始终是 {"action":"合法动作","input":{...}}；所有动作数据必须放 input 对象，不能把 graphId、goal、tasks 放顶层。不要调用不存在的 status、update_task 或自行声称成员执行。
1. create 的 input={goal,tasks:[{id,title,prompt,dependencies:[],mode:"read"|"write",writeScopes:["."]}],maxWorkers?,checks?:[{command,args:[]}]}。必须明确每个任务的 mode；只读分析任务用 mode:"read"，不能省略后变成写入。需要自动规划且不提供 tasks 时明确传 automatic:true。返回 Graph.id 是完整 UUID，created 只代表计划保存，不代表成员已执行。
2. 从 create 返回值复制完整 Graph.id 到 input.graphId，不截断、不使用 task.id。例：start {"action":"start","input":{"graphId":"完整 Graph.id"}}。启动后 snapshot {"action":"snapshot","input":{}} 查询；在返回 graphs 中用 id 匹配该图并读取其 status，不存在 action:"status"。
3. pause、stop、prepare、integrate 的 input 都必须有 graphId；resume 必须有 graphId，未知副作用时还需用户明确 confirmUnknown:true，模型不能代替用户确认。prepare 仅对全部任务 completed 的图启动异步复核，立即返回保留的状态，再用 snapshot 查询；重复 prepare 不会同时开启复核。integrate 仅对已通过检查/复核的 ready 图整合。
4. configure input={graphId,maxWorkers:1..16}，只在空闲修改并发。send input={graphId,to:"任务 id",body:"消息"}。shared.read input={graphId,name}；shared.write input={graphId,name,content,expectedRevision}，新材料 expectedRevision:0，更新使用读取到的 revision。
5. 只有 snapshot 返回的目标 graphs[].status === "integrated" 才可报告 Swarm 完成；pending/running/awaiting_review/created/paused/stopped 均不是完成。遇到错误报告真实状态，不编造两名成员、自检或验收。原项目有未提交改动时，不 stash/reset/clean；写入阻塞应保留改动，只读任务仍可用。`,
  });
};
export default extension;
