import {randomUUID} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createEventBus,type ExtensionAPI,type ExtensionFactory,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {RecordStore,object,text,type JsonObject,type PluginContext,type AcceptanceCheck,type CheckEvidence} from '@friend-pi/core';
// The retained upstream package is consumed through its factory/event contract.
// @ts-expect-error Upstream distributes compiled JavaScript without declarations.
import originalBackend from '../../../third-party/pi-background-tasks/dist/src/extension.js';

export interface ProcessJob {
 id:string;projectId:string;sessionId:string;runId?:string;goalId?:string;generation:number;name:string;command:string;
 kind:'task'|'service';origin:'user'|'agent'|'plugin';notify:boolean;autoContinue:boolean;
 status:string;pid?:number;outputPath?:string;exitCode?:number|null;error?:string;startedAt:string;finishedAt?:string;
}
interface BackendResponse {ok:boolean;result?:JsonObject;error?:{message?:string}|string}
export function assertProcessCommand(command:string,planMode:boolean){
 if(planMode)throw new Error('计划模式不能启动后台命令');
 const normalized=command.replace(/[\"']/g,'');
 if(/(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:pi|codex|claude|gemini|traex)(?:\s|$)|(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:node|tsx|npx|bun)\s+[^;&|]*\/(?:pi|pi-coding-agent)\/(?:dist\/)?(?:cli|index)\.[cm]?js(?:\s|$)/i.test(normalized))throw new Error('代理派发请使用 Team 或 Swarm，不能通过后台命令绕过模式');
 if(/(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot)(?:\s|$)|\bgit\s+(?:reset\s+--hard|clean\b|push\b|branch\s+-[dD])|\b(?:npm|pnpm|yarn)\s+publish\b/i.test(normalized))throw new Error('后台命令不执行关键破坏性操作，请走前台确认路径');
 if(/\b[A-Za-z0-9_]*(?:api[-_]?key|access[-_]?token|secret|password)\s*=|\bsk-[A-Za-z0-9_-]{12,}/i.test(normalized))throw new Error('不要在命令中包含认证信息');
}
export function redactJobOutput(value:string){return value.replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[隐藏]').replace(/\bBearer\s+[A-Za-z0-9._-]+/gi,'Bearer [隐藏]');}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;

export class ProcessJobs {
 readonly store:RecordStore;private readonly backendBus=createEventBus();private ready=false;private disposed=false;
 private readonly pending=new Map<string,Set<Promise<unknown>>>();private readonly cancelledRuns=new Map<string,number>();private readonly latestGenerations=new Map<string,number>();private readonly ownedPids=new Set<number>();
 private readonly terminalWaiters=new Map<string,Set<(job:ProcessJob)=>void>>();
 constructor(readonly dataDir:string,readonly onTerminal:(job:ProcessJob)=>void,readonly emit:(event:string,data:unknown)=>void,private readonly backendFactory:ExtensionFactory=originalBackend){
  this.store=new RecordStore('process-jobs',dataDir);
  this.backendBus.on('friend-pi:process-ownership:v1',raw=>{const task=object(raw);const pid=Number(task.pid);if(Number.isSafeInteger(pid)&&pid>1&&!this.ownedPids.has(pid)){this.ownedPids.add(pid);this.emit('runtime.process',{action:'started',pid,groupOwned:process.platform!=='win32'});}});
  this.backendBus.on('pi-background-tasks:terminal:v1',raw=>void this.terminal(raw).catch(error=>this.emit('jobs.error',{message:String(error)})));
 }
 recover(ctx:PluginContext){for(const row of this.store.list<ProcessJob>('job:'))if(row.value.sessionId===ctx.sessionId&&row.value.status==='running')this.store.put(row.key,{...row.value,status:'unknown',error:'旧宿主已结束，未重放命令；保留日志与现场'});}
 extension():ExtensionFactory{return async pi=>{
  process.env.PI_BG_FEATURES='process';process.env.PI_BG_DOCK_SHORTCUT='off';process.env.PI_BG_DISABLE_UPDATE_CHECK='1';
  const facade={...pi,events:this.backendBus,registerTool:()=>{},registerCommand:()=>{},registerShortcut:()=>{},registerMessageRenderer:()=>{},
   // Own the presentation and wake path; the backend never starts model turns.
   sendMessage:()=>{},
   on:(event:string,handler:(event:unknown,ctx:ExtensionContext)=>unknown)=>{
    if(event==='session_start')pi.on('session_start',async(e,ctx)=>{await handler(e,{...ctx,ui:{...ctx.ui,setStatus:()=>{},notify:()=>{},setWidget:()=>{},setWorkingMessage:()=>{}}});this.ready=true;});
    else if(event==='session_shutdown')pi.on('session_shutdown',async(e,ctx)=>{this.ready=false;await handler(e,ctx);});
   },
  } as unknown as ExtensionAPI;
  await this.backendFactory(facade);
 };}
 private async request(operation:string,payload:JsonObject={}):Promise<JsonObject>{
  if(this.disposed||!this.ready)throw new Error('后台命令服务尚未就绪');
  const id=randomUUID();return await new Promise((yes,no)=>{const off=this.backendBus.on('pi-background-tasks:response:v1',raw=>{const frame=object(raw);if(frame.request_id!==id)return;clearTimeout(timer);off();const response=frame as unknown as BackendResponse;response.ok?yes(response.result||{}):no(new Error(typeof response.error==='string'?response.error:response.error?.message||'后台命令失败'));});const timer=setTimeout(()=>{off();no(new Error('后台命令后端超时'));},30000);this.backendBus.emit('pi-background-tasks:request:v1',{schema_version:'pi-background-tasks.extension-request.v1',request_id:id,operation,payload});});
 }
 private key(ctx:PluginContext,id:string){return `job:${ctx.projectId}:${id}`;}
 list(ctx:PluginContext){return this.store.list<ProcessJob>(`job:${ctx.projectId}:`).map(row=>row.value).filter(job=>job.sessionId===ctx.sessionId);}
 read(id:string,ctx:PluginContext){const row=this.store.get<ProcessJob>(this.key(ctx,id));if(!row||row.value.sessionId!==ctx.sessionId)throw new Error('后台任务不属于当前会话');return row.value;}
 pendingCount(sessionId:string){return [...this.pending].filter(([key])=>key.startsWith(sessionId+':')).reduce((count,[,set])=>count+set.size,0);}
 hasFinite(ctx:PluginContext,runId?:string){return this.pendingCount(ctx.sessionId)>0|| this.list(ctx).some(job=>job.kind==='task'&&job.status==='running'&&(!runId||job.runId===runId));}
 hasUnknown(ctx:PluginContext){return this.list(ctx).some(job=>job.status==='unknown');}
 private runKey(ctx:PluginContext){return `${ctx.sessionId}:${ctx.runId||''}`;}
 async start(input:JsonObject,ctx:PluginContext,generation:number){
  if(ctx.origin!=='user'&&ctx.policy?.executionStopped)throw new Error('本轮已停止，不能启动迟到后台任务');
  const key=this.runKey(ctx);this.latestGenerations.set(key,Math.max(generation,this.latestGenerations.get(key)??-1));if(generation<=(this.cancelledRuns.get(key)??-1))throw new Error('本轮已停止，不能启动迟到后台任务');
  const admission=this.admit(input,ctx,generation);const set=this.pending.get(key)||new Set();set.add(admission);this.pending.set(key,set);
  try{return await admission;}finally{set.delete(admission);if(!set.size)this.pending.delete(key);}
 }
 private async admit(input:JsonObject,ctx:PluginContext,generation:number){
  const command=text(input.command,'后台命令',16000);assertProcessCommand(command,ctx.policy?.planMode===true);

  const kind=input.kind==='service'?'service':'task';const origin=ctx.origin||'agent';const raw=await this.request('run',{name:text(input.name||command.slice(0,80),'任务名称',200),command,isAgent:false,timeoutSeconds:Math.max(1,Math.min(86400,Number(input.timeoutSeconds)|| (kind==='service'?86400:3600))),notifyOnCompletion:false,triggerOnCompletion:false});
  const job:ProcessJob={id:text(raw.id),projectId:ctx.projectId,sessionId:ctx.sessionId,runId:ctx.runId,goalId:ctx.policy?.goalId,generation,name:String(raw.name),command,kind,origin,notify:input.notify!==false,autoContinue:kind==='task'&&(typeof input.autoContinue==='boolean'?input.autoContinue:origin==='agent'),status:'running',pid:typeof raw.pid==='number'?raw.pid:undefined,outputPath:typeof raw.outputPath==='string'?resolve(ctx.projectDir,raw.outputPath):undefined,startedAt:new Date(Number(raw.startTime)||Date.now()).toISOString()};
  this.store.put(this.key(ctx,job.id),job,null);ctx.appendEntry('friend-pi.job.started',{jobId:job.id,kind,runId:job.runId});ctx.emit('jobs.changed',this.list(ctx));
  if(raw.status==='running'&&job.pid&&!this.ownedPids.has(job.pid)){this.ownedPids.add(job.pid);this.emit('runtime.process',{action:'started',pid:job.pid,groupOwned:process.platform!=='win32'});}
  if(job.kind==='task'&&generation<=(this.cancelledRuns.get(this.runKey(ctx))??-1))await this.kill(job.id,ctx);
  // A tiny process can finish before its controller-side admission was persisted.
  const snapshot=await this.request('status',{taskId:job.id});const latest=Array.isArray(snapshot.tasks)?snapshot.tasks.map(object).find(item=>item.id===job.id):undefined;
  if(latest&&latest.status!=='running')await this.terminal({task:latest});
  return this.read(job.id,ctx);
 }
 private async terminal(raw:unknown){
  const task=object(object(raw).task);const pid=Number(task.pid);if(this.ownedPids.delete(pid))this.emit('runtime.process',{action:'closed',pid,groupOwned:process.platform!=='win32'});const row=this.store.list<ProcessJob>('job:').find(row=>row.value.id===task.id);if(!row)return;
  if(!['running'].includes(row.value.status))return;
  const job:ProcessJob={...row.value,status:String(task.status),exitCode:typeof task.exitCode==='number'?task.exitCode:null,error:typeof task.error==='string'?task.error:undefined,finishedAt:new Date(Number(task.endTime)||Date.now()).toISOString()};
  this.store.put(row.key,job);if(job.pid&&this.ownedPids.delete(job.pid))this.emit('runtime.process',{action:'closed',pid:job.pid,groupOwned:process.platform!=='win32'});
  for(const resolve of this.terminalWaiters.get(job.id)||[])resolve(job);this.terminalWaiters.delete(job.id);
  this.emit('jobs.changed',{sessionId:job.sessionId,job});this.onTerminal(job);
 }
 async logs(id:string,maxBytes:number,ctx:PluginContext){const job=this.read(id,ctx);const limit=Math.max(1,Math.min(65536,maxBytes||12000));
  if(job.status!=='running'&&job.outputPath&&existsSync(job.outputPath)){const bytes=readFileSync(job.outputPath);return {job,text:redactJobOutput(bytes.subarray(Math.max(0,bytes.length-limit)).toString('utf8')),truncated:bytes.length>limit};}
  const result=await this.request('logs',{taskId:id,maxBytes:limit,tail:true});return {...result,text:redactJobOutput(String(result.text||'')),job};
 }
 async kill(id:string,ctx:PluginContext){const job=this.read(id,ctx);if(job.status==='unknown')throw new Error('旧进程身份未经确认，不能按旧 PID 终止或重跑');if(job.status!=='running')return job;await this.request('kill',{taskId:id});const raw=await this.request('status',{taskId:id});const task=Array.isArray(raw.tasks)?raw.tasks.map(object).find(row=>row.id===id):undefined;if(task)await this.terminal({task});return this.read(id,ctx);}
 async stopRun(ctx:PluginContext,runId?:string){const target={...ctx,runId:runId||ctx.runId};this.cancelledRuns.set(this.runKey(target),this.latestGenerations.get(this.runKey(target))??0);await Promise.allSettled([...(this.pending.get(this.runKey(target))||[])]);for(const job of this.list(ctx))if(job.status==='running'&&job.kind==='task'&&(!runId||job.runId===runId))await this.kill(job.id,ctx);}
 async check(check:AcceptanceCheck,ctx:PluginContext,generation:number):Promise<Omit<CheckEvidence,'at'|'hash'>>{
  const job=await this.start({name:`检查 ${check.command}`,command:[check.command,...check.args].map(quote).join(' '),kind:'task',autoContinue:false,notify:false,timeoutSeconds:120},ctx,generation);
  let terminal=job;if(job.status==='running')terminal=await new Promise<ProcessJob>(resolveResult=>{const waiters=this.terminalWaiters.get(job.id)||new Set();waiters.add(resolveResult);this.terminalWaiters.set(job.id,waiters);const latest=this.read(job.id,ctx);if(latest.status!=='running'){waiters.delete(resolveResult);if(!waiters.size)this.terminalWaiters.delete(job.id);resolveResult(latest);}});
  const logs=await this.logs(job.id,65536,ctx);return {...check,exitCode:terminal.status==='completed'?terminal.exitCode??0:terminal.exitCode??null,output:String(logs.text||'')};
 }
 confirmUnknown(id:string,evidence:string,ctx:PluginContext){if(ctx.origin!=='user')throw new Error('未知现场只能由用户检查');const job=this.read(id,ctx);if(job.status!=='unknown')throw new Error('任务状态已经变化');const next={...job,status:'interrupted',error:'用户已检查旧现场；未重放命令',recovery:{evidence,at:new Date().toISOString()}};this.store.put(this.key(ctx,id),next);return next;}
 async dispatch(action:string,input:JsonObject,ctx:PluginContext,generation:number){
  if(['read','list','snapshot','status'].includes(action))return input.id?this.read(text(input.id),ctx):this.list(ctx);
  if(action==='logs')return this.logs(text(input.id),Number(input.maxBytes),ctx);
  if(action==='run'||action==='start')return this.start(input,ctx,generation);
  if(action==='kill'||action==='stop')return this.kill(text(input.id),ctx);
  throw new Error('未知后台任务操作');
 }
 dispose(){this.disposed=true;for(const [id,waiters] of this.terminalWaiters){const row=this.store.list<ProcessJob>('job:').find(row=>row.value.id===id);if(row)for(const done of waiters)done({...row.value,status:'unknown',error:'宿主结束，检查未完成'});}this.terminalWaiters.clear();this.backendBus.clear();this.store.close();}
}
