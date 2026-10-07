import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { agentDirectory, atomicWrite, ConflictError, digest, object, parseModelJson, RecordStore, registerPlugin, text } from '@friend-pi/core';
import type { JsonObject, PluginContext, PluginController, StoredDocument } from '@friend-pi/core';
import { contains, destructiveCommand } from './guard.js';
import type { Attempt, Baseline, Check, CheckResult, Graph, MemberHandle, MemberLauncher, MemberMessage, MemberOutput, MemberStart, SharedDocument, Task } from './types.js';
export type * from './types.js';

const runFile = promisify(execFile);
const now = () => new Date().toISOString();
const alive = (pid:number) => {try {process.kill(pid,0);return true;} catch {return false;}};
async function git(cwd:string,args:string[]): Promise<string> {
  const result = await runFile('git',args,{cwd,encoding:'utf8',maxBuffer:4*1024*1024,timeout:120000});
  return result.stdout.trim();
}
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
  const scopes=item.writeScopes === undefined ? ['.'] : strings(item.writeScopes);
  if (!scopes.length || scopes.some(path=>isAbsolute(path) || !contains('/scope',resolve('/scope',path)))) throw new Error('写入范围必须相对于成员工作区，不能越出工作区');
  return {id:item.id ? text(item.id,'任务标识',100) : `task-${index+1}`,title:text(item.title,'任务标题',500),prompt:text(item.prompt || item.title,'任务要求'),dependencies:item.dependencies === undefined ? [] : strings(item.dependencies),mode,expertId:item.expertId ? text(item.expertId,'专家标识',100):undefined,writeScopes:scopes,status:'pending',rework:0,resultRevision:0};
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
  const child=fork(worker,[],{cwd:start.cwd,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,FRIEND_PI_DATA_DIR:start.dataDir,FRIEND_PI_AGENT_DIR:start.agentDir,ELECTRON_RUN_AS_NODE:'1'},execArgv:[]});
  // Keep diagnostics bounded and never echo environment/configuration containing credentials.
  let diagnostics=''; child.stderr?.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-4000);});
  child.stdout?.resume();
  child.on('message',raw=>{if (raw && typeof raw==='object' && 'v' in raw && raw.v===1) output(raw as MemberOutput);});
  child.on('error',error=>output({v:1,type:'failed',error:error.message}));
  child.on('exit',(code)=>{if (code && diagnostics) output({v:1,type:'failed',error:`成员进程退出（${code}），请查阅保留的会话与工作区`});exited(code);});
  child.send(start);
  return {send:message=>{if (child.connected) child.send(message);},stop:()=>{if (child.connected) child.send({v:1,type:'stop'});const timer=setTimeout(()=>{if (child.exitCode === null) child.kill('SIGTERM');},5000);timer.unref();}};
}

/** Every entry point uses this controller. SQLite transactions serialize claims and revisions. */
export class SwarmController implements PluginController {
  private readonly stores=new Map<string,RecordStore>();
  private readonly runtime=randomUUID();
  private readonly members=new Map<string,{handle:MemberHandle;graphId:string;context:PluginContext}>();
  private readonly pumping=new Set<string>();
  private readonly finishing=new Set<string>();
  private readonly preparing=new Set<string>();
  private readonly confirmations=new Map<string,(accepted:boolean)=>void>();
  private nativeConfirm?: (title:string,message:string)=>Promise<boolean>;
  private disposed=false;
  constructor(private readonly launcher:MemberLauncher=productionLauncher) {}
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
      if (changed) {doc.value.status='paused';doc.value.error='检测到中断任务，尚未自动重放';store.put(doc.key,doc.value,doc.revision);}
    }
    return store;
  }
  private get(id:string,ctx:PluginContext): StoredDocument<Graph> {
    const doc=this.store(ctx).get<Graph>(graphKey(ctx.projectId,id));if (!doc || doc.value.sessionId!==ctx.sessionId) throw new Error('任务图不存在或不属于当前会话');return doc;
  }
  private update(id:string,ctx:PluginContext,change:(graph:Graph)=>void): Graph {
    return this.store(ctx).transaction(()=>{const doc=this.get(id,ctx);change(doc.value);doc.value.updatedAt=now();this.store(ctx).put(doc.key,doc.value,doc.revision);return doc.value;});
  }
  private changed(ctx:PluginContext): void {ctx.emit('swarm.changed',this.snapshot(ctx));}
  snapshot(ctx:PluginContext): unknown {
    const store=this.store(ctx);const graphs=store.list<Graph>(`graph:${ctx.projectId}:`).filter(doc=>doc.value.sessionId===ctx.sessionId).map(doc=>({...doc.value,revision:doc.revision}));
    const ids=new Set(graphs.map(graph=>graph.id));
    return {graphs,members:graphs.flatMap(graph=>graph.attempts.map(attempt=>({...attempt,graphId:graph.id}))),messages:store.list<MemberMessage>('message:').map(doc=>doc.value).filter(msg=>ids.has(msg.graphId)),shared:store.list<SharedDocument>('shared:').map(doc=>({...doc.value,revision:doc.revision})).filter(item=>ids.has(item.graphId)),confirmations:[...this.confirmations.keys()],status:graphs.some(graph=>graph.status==='running')?'running':'idle'};
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext): Promise<unknown> {
    if (action==='snapshot') return this.snapshot(ctx);
    if (action==='history') return {graphs:this.store(ctx).list<Graph>(`graph:${ctx.projectId}:`).map(doc=>({...doc.value,revision:doc.revision})),readOnly:true};
    if (action==='create') return this.create(input,ctx);
    if (action==='confirm') {if (ctx.origin && ctx.origin!=='user') throw new Error('关键确认必须来自用户');const resolver=this.confirmations.get(text(input.id));if (!resolver) throw new Error('确认请求已结束');resolver(input.accepted===true);return {accepted:input.accepted===true};}
    const id=text(input.graphId,'任务图标识',100);
    if (action==='start') {await this.start(id,input,ctx);return this.get(id,ctx).value;}
    if (action==='pause' || action==='stop') {
      this.update(id,ctx,graph=>{graph.status=action==='pause'?'paused':'stopped';for (const attempt of graph.attempts) if (attempt.status==='running') {attempt.status='unknown';attempt.error='用户中断；工具副作用未重放';const task=graph.tasks.find(t=>t.currentAttempt===attempt.id);if (task) task.status='unknown';}});
      for (const member of this.members.values()) if (member.graphId===id) member.handle.stop();this.changed(ctx);return this.get(id,ctx).value;
    }
    if (action==='resume') {
      const graph=this.get(id,ctx).value;
      if (graph.status==='integrated') throw new Error('已整合任务不能重新执行');
      if (graph.tasks.some(t=>t.status==='unknown') && (input.confirmUnknown!==true || (ctx.origin && ctx.origin!=='user'))) throw new Error('存在副作用未知的任务；请检查保留的会话和工作区，并由用户以 confirmUnknown:true 明确启动新尝试');
      this.update(id,ctx,g=>{for (const task of g.tasks) if (['unknown','blocked','cancelled'].includes(task.status)) {task.status='pending';task.currentAttempt=undefined;}g.error=undefined;});
      await this.start(id,input,ctx);return this.get(id,ctx).value;
    }
    if (action==='configure') return this.update(id,ctx,g=>{if (g.status==='running') throw new Error('并发配置在空闲边界修改');g.maxWorkers=number(input.maxWorkers,g.maxWorkers,1,16);});
    if (action==='send') return this.sendMessage(id,input,ctx);
    if (action==='shared.write') return this.writeShared(id,input,ctx);
    if (action==='shared.read') {this.get(id,ctx);const doc=this.store(ctx).get<SharedDocument>(`shared:${id}:${text(input.name)}`);return doc?{...doc.value,revision:doc.revision}:null;}
    if (action==='prepare' || action==='review') {await this.prepare(id,ctx);return this.get(id,ctx).value;}
    if (action==='integrate') {await this.integrate(id,ctx);return this.get(id,ctx).value;}
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
  private async baseline(projectDir:string): Promise<Baseline|undefined> {
    let repoRoot:string;try {repoRoot=await git(projectDir,['rev-parse','--show-toplevel']);}catch {return undefined;}
    const head=await git(repoRoot,['rev-parse','HEAD']);let branch:string|undefined;try {branch=await git(repoRoot,['symbolic-ref','HEAD']);}catch {}
    return {repoRoot,projectRelative:relative(realpathSync(repoRoot),realpathSync(projectDir)),head,branch};
  }
  private async start(id:string,input:JsonObject,ctx:PluginContext): Promise<void> {
    const current=this.get(id,ctx).value;if (current.status==='running') return;
    if (current.status==='integrated') throw new Error('任务已整合');
    if (current.tasks.some(task=>task.status==='unknown')) throw new Error('请通过 resume 明确接续中断任务');
    const baseline=current.baseline || await this.baseline(ctx.projectDir);
    if (baseline && current.tasks.some(task=>task.mode==='write')) {
      if (await git(baseline.repoRoot,['status','--porcelain'])) throw new Error('项目有未提交改动，暂不能启动隔离写入；保留这些改动后仍可使用 Single 或只读 Swarm');
      if (await git(baseline.repoRoot,['rev-parse','HEAD'])!==baseline.head) throw new Error('项目基线已变化，请创建新任务图；旧成果保留');
    }
    this.update(id,ctx,g=>{g.baseline=baseline;g.status='running';g.error=undefined;if (!g.attempts.length) {g.modelId=typeof input.modelId==='string'?input.modelId:ctx.modelId;g.thinkingLevel=thinkingLevel(input.thinkingLevel,ctx.thinkingLevel??g.thinkingLevel);g.agentDir=typeof input.agentDir==='string'?resolve(input.agentDir):(ctx.agentDir || agentDirectory());}});
    this.changed(ctx);void this.pump(id,ctx);
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
      claimed={id:randomUUID(),taskId:task.id,number:graph.attempts.filter(a=>a.taskId===task.id).length+1,resultRevision:task.resultRevision+1,status:'running',cwd:ctx.projectDir,mode:task.mode,ownerPid:process.pid,ownerRuntime:this.runtime,startedAt:now(),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,writeScopes:task.writeScopes};
      task.status='running';task.currentAttempt=claimed.id;graph.attempts.push(claimed);
    });return claimed!;
  }
  private async freezeExpert(task:Task,ctx:PluginContext): Promise<unknown> {
    try {return await ctx.request('expert','freeze',{expertId:task.expertId,goal:task.prompt,taskId:task.id},1500);}catch {return {id:'basic',version:1,prompt:`执行任务：${task.title}`};}
  }
  private dependencyCommits(graph:Graph,task:Task): string[] {
    const visited=new Set<string>();const commits:string[]=[];
    const visit=(id:string)=>{if (visited.has(id)) return;visited.add(id);const dep=graph.tasks.find(t=>t.id===id)!;dep.dependencies.forEach(visit);const attempt=graph.attempts.find(a=>a.id===dep.currentAttempt);if (attempt?.commit) commits.push(attempt.commit);};
    task.dependencies.forEach(visit);return [...new Set(commits)];
  }
  private async launch(id:string,attempt:Attempt,ctx:PluginContext): Promise<void> {
    let graph=this.get(id,ctx).value;const task=graph.tasks.find(t=>t.id===attempt.taskId)!;
    const expert=await this.freezeExpert(task,ctx);
    if (this.disposed) return;
    let cwd=ctx.projectDir;
    if (graph.baseline && task.mode==='write') {
      const worktree=join(ctx.dataDir,'swarm-workspaces',ctx.projectId,id,'attempts',attempt.id);mkdirSync(resolve(worktree,'..'),{recursive:true,mode:0o700});
      await git(graph.baseline.repoRoot,['worktree','add','--detach',worktree,graph.baseline.head]);
      if (this.disposed) return;
      for (const commit of this.dependencyCommits(graph,task)) await git(worktree,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit]);
      cwd=join(worktree,graph.baseline.projectRelative);
    }
    graph=this.update(id,ctx,g=>{const target=g.attempts.find(a=>a.id===attempt.id)!;target.cwd=cwd;target.expert=expert;});
    if (graph.status!=='running' || graph.attempts.find(a=>a.id===attempt.id)?.status!=='running') return;
    const dependencies=task.dependencies.map(dep=>{const previous=graph.attempts.find(a=>a.id===graph.tasks.find(t=>t.id===dep)?.currentAttempt);return {taskId:dep,summary:previous?.summary};});
    const start:MemberStart={v:1,type:'start',graphId:id,taskId:task.id,attemptId:attempt.id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir || ctx.agentDir || agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',id,attempt.id),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,prompt:`目标：${graph.goal}\n本次成果：${task.title}\n要求：${task.prompt}\n前置成果：${JSON.stringify(dependencies)}\n共享资料通过协调者提供，不能递归派生。`,expert,mode:task.mode,writeScopes:task.writeScopes};
    const handle=this.launcher(start,message=>void this.memberOutput(id,attempt.id,message,ctx),code=>{
      if (this.disposed) return;
      this.members.delete(attempt.id);const current=this.get(id,ctx).value.attempts.find(a=>a.id===attempt.id);
      if (current?.status==='running' && !this.finishing.has(attempt.id)) void this.fail(id,attempt.id,`成员进程退出，状态未知（${code ?? 'signal'}）`,ctx,true);
    });
    this.members.set(attempt.id,{handle,graphId:id,context:ctx});this.deliverPending(id,attempt.id,ctx);this.changed(ctx);
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
        try {await this.launch(id,attempt,ctx);}catch (error) {if (!this.disposed) await this.fail(id,attempt.id,errorText(error),ctx);break;}
      }
      if (this.disposed) return;
      const graph=this.get(id,ctx).value;
      if (graph.status==='running' && graph.tasks.every(t=>t.status==='completed')) {this.update(id,ctx,g=>{g.status='awaiting_review';});this.changed(ctx);void this.prepare(id,ctx).catch(error=>{if (!this.disposed && this.get(id,ctx).value.status==='awaiting_review') {this.update(id,ctx,g=>{g.status='paused';g.error=errorText(error);});this.changed(ctx);}});}
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
    if (message.type==='request') {
      try {
        if (!['send','shared.read','shared.write'].includes(message.action)) throw new Error('成员协作操作未获允许');
        const attempt=this.get(id,ctx).value.attempts.find(a=>a.id===attemptId)!;
        const result=await this.dispatch(message.action,{...message.input,graphId:id,from:attempt.taskId},{...ctx,origin:'plugin'});
        this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,result});
      }catch (error) {this.members.get(attemptId)?.handle.send({v:1,type:'request.response',requestId:message.requestId,error:errorText(error)});}
    }
    if (message.type==='confirm') {
      const accepted=await this.confirm(message.title,message.message,attemptId,ctx);
      this.members.get(attemptId)?.handle.send({v:1,type:'confirm.response',requestId:message.requestId,accepted});
    }
  }
  private confirm(title:string,message:string,attemptId:string,ctx:PluginContext): Promise<boolean> {
    if (this.nativeConfirm) return this.nativeConfirm(title,message);
    const id=randomUUID();return new Promise(resolveConfirm=>{
      const timer=setTimeout(()=>{this.confirmations.delete(id);resolveConfirm(false);this.changed(ctx);},60000);
      this.confirmations.set(id,accepted=>{clearTimeout(timer);this.confirmations.delete(id);resolveConfirm(accepted);this.changed(ctx);});
      ctx.emit('swarm.confirmation',{id,attemptId,title,message});this.changed(ctx);
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
        await git(attempt.cwd,['diff','--check']);
        if (await git(attempt.cwd,['status','--porcelain'])) {
          // Worktree contains only this attempt and frozen dependency commits; stage scoped changes only.
          for (const scope of attempt.writeScopes) await git(attempt.cwd,['add','--',scope]);
          if (await git(attempt.cwd,['diff','--cached','--name-only'])) {await git(attempt.cwd,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','commit','-m',`Swarm ${task.title}`]);commit=await git(attempt.cwd,['rev-parse','HEAD']);}
          if (await git(attempt.cwd,['status','--porcelain'])) throw new Error('成员产生写入范围外改动，保留现场并停止整合');
        }
      }
      if (this.disposed) return;
      this.update(id,ctx,g=>{const a=g.attempts.find(x=>x.id===attemptId)!;const t=g.tasks.find(x=>x.currentAttempt===attemptId);if (!t || a.status!=='running') throw new ConflictError('执行尝试已被中断');a.status='completed';a.finishedAt=now();a.summary=result.summary.slice(0,100000);a.sessionId=result.sessionId||a.sessionId;a.sessionFile=result.sessionFile||a.sessionFile;a.commit=commit;t.status='completed';t.resultRevision=a.resultRevision;});
      this.members.delete(attemptId);this.changed(ctx);void this.pump(id,ctx);
    }catch (error) {await this.fail(id,attemptId,errorText(error),ctx);}finally {this.finishing.delete(attemptId);}
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
  private writeShared(id:string,input:JsonObject,ctx:PluginContext): SharedDocument {
    this.get(id,ctx);const name=text(input.name,'资料名称',180);if (!/^[\p{L}\p{N}_ .-]+$/u.test(name) || name==='.' || name==='..') throw new Error('共享资料名称无效');
    const content=typeof input.content==='string' && input.content.length<=200000 ? input.content : text(input.content);
    const expected=input.expectedRevision===null ? null : number(input.expectedRevision,0,0,10000000);
    const key=`shared:${id}:${name}`;
    return this.store(ctx).transaction(()=>{
      const previous=this.store(ctx).get<SharedDocument>(key);if (expected===null ? !!previous : (previous?.revision || 0)!==expected) throw new ConflictError();
      const version=(previous?.revision || 0)+1;const file=join(ctx.dataDir,'swarm-shared',id,`${digest(name).slice(0,24)}.v${version}.md`);
      const document:SharedDocument={graphId:id,name,content,file,version,digest:digest(content),updatedAt:now()};
      // Immutable version file first, DB pointer second. Readers only see committed pointers.
      atomicWrite(file,content);this.store(ctx).put(key,document,previous?.revision ?? null);this.changed(ctx);return document;
    });
  }
  private async objectiveCheck(cwd:string,check:Check): Promise<CheckResult> {
    let exitCode:number|null=0;let output='';
    try {const result=await runFile(check.command,check.args,{cwd,encoding:'utf8',maxBuffer:512*1024,timeout:120000});output=result.stdout+result.stderr;}
    catch (raw) {const error=raw as {code?:number;stdout?:string;stderr?:string;message?:string};exitCode=typeof error.code==='number'?error.code:1;output=(error.stdout||'')+(error.stderr||'')+(error.message||'');}
    return {command:check.command,args:check.args,exitCode,output:output.slice(-20000),at:now()};
  }
  private async reviewer(graph:Graph,cwd:string,ctx:PluginContext): Promise<{approved:boolean;findings:string}> {
    const id=randomUUID();const start:MemberStart={v:1,type:'start',graphId:graph.id,taskId:'independent-review',attemptId:id,cwd,dataDir:ctx.dataDir,agentDir:graph.agentDir||ctx.agentDir||agentDirectory(),sessionDir:join(ctx.dataDir,'swarm-sessions',graph.id,id),modelId:graph.modelId,thinkingLevel:graph.thinkingLevel,mode:'read',writeScopes:[],prompt:`你是独立成果审查者，未参与实现。审查目标与各成果，必要时只读原文件。不能修改或派生。输出纯 JSON {"approved":true|false,"findings":"事实和具体问题"}，不能只凭成员自评批准。目标：${graph.goal}\n成果：${JSON.stringify(graph.tasks.map(t=>({id:t.id,title:t.title,prompt:t.prompt,result:graph.attempts.find(a=>a.id===t.currentAttempt)?.summary})))}\n客观检查：${JSON.stringify(graph.integration?.checks || [])}`};
    return new Promise((resolveResult,reject)=>{
      let done=false;let handle:MemberHandle;
      const finish=(error?:Error,value?:{approved:boolean;findings:string})=>{if (done) return;done=true;clearTimeout(timer);this.members.delete(id);if (error) {handle?.stop();reject(error);}else resolveResult(value!);};
      const timer=setTimeout(()=>finish(new Error('独立复核超时，成果已保留')),120000);
      try {handle=this.launcher(start,message=>{
        if (message.type==='settled') {try {const result=parseModelJson(message.summary);if (typeof result.approved!=='boolean') throw new Error('独立复核未提供明确判断');finish(undefined,{approved:result.approved,findings:text(result.findings,'复核结论')});}catch (error) {finish(new Error(errorText(error)));}}
        if (message.type==='failed') finish(new Error(message.error));
        if (message.type==='confirm') handle.send({v:1,type:'confirm.response',requestId:message.requestId,accepted:false});
      },()=>{if (!done) finish(new Error('独立复核进程中断'));});this.members.set(id,{handle,graphId:graph.id,context:ctx});}
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
    if (this.disposed) return;
    let graph=this.get(id,ctx).value;
    if (!graph.tasks.every(t=>t.status==='completed')) throw new Error('所有成果完成后才能整合复核');
    if (graph.status==='integrated' || graph.status==='ready') return;
    this.update(id,ctx,g=>{g.status='awaiting_review';});
    let cwd=ctx.projectDir;
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      const integration=join(ctx.dataDir,'swarm-workspaces',ctx.projectId,id,`integration-${graph.reworkRound}-${randomUUID().slice(0,8)}`);mkdirSync(resolve(integration,'..'),{recursive:true,mode:0o700});
      await git(graph.baseline.repoRoot,['worktree','add','--detach',integration,graph.baseline.head]);
      if (this.disposed) return;
      cwd=join(integration,graph.baseline.projectRelative);
      const visited=new Set<string>();const ordered:Task[]=[];const visit=(t:Task)=>{if (visited.has(t.id)) return;t.dependencies.forEach(dep=>visit(graph.tasks.find(item=>item.id===dep)!));visited.add(t.id);ordered.push(t);};graph.tasks.forEach(visit);
      // Publish integration cwd before merging, so conflicts have a visible retained location.
      this.update(id,ctx,g=>{g.integration={cwd,checks:[]};});this.changed(ctx);
      for (const task of ordered) {const commit=graph.attempts.find(a=>a.id===task.currentAttempt)?.commit;if (commit) await git(integration,['-c','user.name=Friend-Pi','-c','user.email=friend-pi@localhost','cherry-pick',commit]);}
    }
    const checks=graph.baseline && graph.tasks.some(t=>t.mode==='write') ? [{command:'git',args:['diff','--check',graph.baseline.head]},...graph.checks] : graph.checks;
    if (!checks.length && graph.tasks.some(t=>t.mode==='write')) throw new Error('非 Git 写入需要提供客观 checks，成果已保留');
    const validatedHead=graph.baseline ? await git(cwd,['rev-parse','HEAD']) : undefined;
    this.update(id,ctx,g=>{g.integration={cwd,head:validatedHead,checks:[]};});
    for (const check of checks) {
      const result=await this.objectiveCheck(cwd,check);if (this.disposed) return;this.update(id,ctx,g=>{g.integration!.checks.push(result);});
      if (result.exitCode!==0) throw new Error(`客观检查失败：${check.command} ${check.args.join(' ')}`);
      if (this.get(id,ctx).value.status!=='awaiting_review') return;
    }
    graph=this.get(id,ctx).value;const review=await this.reviewer(graph,cwd,ctx);
    if (this.disposed) return;
    if (this.get(id,ctx).value.status!=='awaiting_review') return;
    this.update(id,ctx,g=>{g.integration!.review={...review,attemptId:randomUUID(),at:now()};g.status=review.approved?'ready':'paused';if (!review.approved) g.error=review.findings;});this.changed(ctx);
    if (!review.approved) {
      graph=this.get(id,ctx).value;if (graph.reworkRound>=2) {this.update(id,ctx,g=>{g.error=`已达 2 轮自动返工上限：${review.findings}`;});return;}
      // Review directs a fresh attempt; dependent results must be regenerated as their baseline changed.
      this.update(id,ctx,g=>{g.reworkRound++;for (const task of g.tasks) {task.status='pending';task.currentAttempt=undefined;task.rework++;task.prompt+=`\n第 ${g.reworkRound} 轮复核返工：${review.findings}`;}g.status='running';});void this.pump(id,ctx);return;
    }
    await this.integrate(id,ctx);
  }
  private async integrate(id:string,ctx:PluginContext): Promise<void> {
    const graph=this.get(id,ctx).value;if (graph.status==='integrated') return;
    if (graph.status!=='ready' || !graph.integration?.review?.approved || graph.integration.checks.some(c=>c.exitCode!==0)) throw new Error('客观检查和独立复核通过后才能整合');
    if (graph.baseline && graph.tasks.some(t=>t.mode==='write')) {
      let currentBranch:string|undefined;try {currentBranch=await git(graph.baseline.repoRoot,['symbolic-ref','HEAD']);}catch {}
      if (currentBranch!==graph.baseline.branch || await git(graph.baseline.repoRoot,['rev-parse','HEAD'])!==graph.baseline.head || await git(graph.baseline.repoRoot,['status','--porcelain'])) {this.update(id,ctx,g=>{g.status='paused';g.error='原项目基线或工作区已变化；整合成果保留，未覆盖用户改动';});this.changed(ctx);return;}
      const integrationHead=await git(graph.integration.cwd,['rev-parse','HEAD']);
      if (integrationHead!==graph.integration.head) throw new Error('整合提交在验证期间变化，需重新运行客观检查和复核');
      if (await git(graph.integration.cwd,['status','--porcelain'])) throw new Error('整合工作区在验证后发生未提交变化');
      await git(graph.baseline.repoRoot,['merge','--ff-only',integrationHead]);this.update(id,ctx,g=>{g.integration!.head=integrationHead;});
    }
    this.update(id,ctx,g=>{g.status='integrated';g.error=undefined;});ctx.appendEntry('friend-pi:swarm-integrated',{graphId:id,integration:graph.integration?.cwd});this.changed(ctx);
  }
  async dispose(): Promise<void> {
    for (const member of this.members.values()) {member.handle.stop();try {this.update(member.graphId,member.context,g=>{g.status='paused';for (const attempt of g.attempts) if (attempt.status==='running' && attempt.ownerRuntime===this.runtime) {attempt.status='unknown';attempt.error='会话关闭；请检查副作用并显式接续';const task=g.tasks.find(t=>t.currentAttempt===attempt.id);if (task) task.status='unknown';}});}catch {}}
    // A claimed attempt can be waiting on Expert or worktree creation before its handle exists.
    // Persist its uncertainty as well, rather than leaving a live-PID orphan after /new.
    for (const store of this.stores.values()) for (const doc of store.list<Graph>('graph:')) {
      let changed=false;
      for (const attempt of doc.value.attempts) if (attempt.status==='running' && attempt.ownerRuntime===this.runtime) {attempt.status='unknown';attempt.error='会话关闭；启动或工具执行可能已发生，需显式接续';const task=doc.value.tasks.find(item=>item.currentAttempt===attempt.id);if (task) task.status='unknown';changed=true;}
      if (changed) {doc.value.status='paused';doc.value.error='会话关闭，未自动重放成员执行';store.put(doc.key,doc.value,doc.revision);}
    }
    this.disposed=true;this.members.clear();for (const resolver of this.confirmations.values()) resolver(false);for (const store of this.stores.values()) store.close();this.stores.clear();
  }
}

const extension:ExtensionFactory=pi=>{
  const controller=new SwarmController();
  pi.on('session_start',(_event,ctx)=>{controller.setConfirmationHandler((title,message)=>ctx.ui.confirm(title,message));});
  registerPlugin(pi,'swarm',controller,'Swarm：成果任务图、隔离成员、消息、共享材料与独立复核');
};
export default extension;
