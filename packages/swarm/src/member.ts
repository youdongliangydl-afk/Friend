/** Standalone native-Pi worker. Pi remains the only owner of its loop and JSONL history. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { installFixtureProvider } from '@friend-pi/core';
import { guardMember } from './guard.js';
import type { MemberInput, MemberOutput, MemberStart } from './types.js';

let session: AgentSession | undefined;
let started = false;
let stopped = false;
let shutdown = false;
const confirmations = new Map<string,(value:boolean)=>void>();
const pendingMessages = new Set<string>();
const requests = new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function output(message: MemberOutput): void { if (process.connected) process.send?.(message); }
function request(action:'send'|'shared.read'|'shared.write',input:Record<string,unknown>):Promise<unknown> {
  if (stopped || !process.connected) return Promise.reject(new Error('协调者连接已结束'));
  const requestId=randomUUID();return new Promise((resolveResult,reject)=>{
    const timer=setTimeout(()=>{requests.delete(requestId);reject(new Error('协作请求超时'));},60000);
    requests.set(requestId,{resolve:resolveResult,reject,timer});output({v:1,type:'request',requestId,action,input});
  });
}
const collaboration:ExtensionFactory=pi=>{
  pi.registerTool({name:'swarm_message',label:'Swarm 成员消息',description:'向同一任务图中的另一个任务发消息。仅协作，不派生任务。',parameters:Type.Object({to:Type.String(),body:Type.String()}),async execute(_id,params) {const result=await request('send',params);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  pi.registerTool({name:'swarm_shared',label:'Swarm 共享材料',description:'读取或使用版本 CAS 更新同一任务图的共享材料。更新须提供读取到的 revision，新建为 0。',parameters:Type.Object({action:Type.Union([Type.Literal('read'),Type.Literal('write')]),name:Type.String(),content:Type.Optional(Type.String()),expectedRevision:Type.Optional(Type.Number())}),async execute(_id,params) {const result=await request(params.action==='read'?'shared.read':'shared.write',params);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
};
function stopRequests():void {for (const pending of requests.values()) {clearTimeout(pending.timer);pending.reject(new Error('成员已停止'));}requests.clear();}
async function disposeSession():Promise<void> {
  if (shutdown) return;shutdown=true;stopRequests();
  if (session) {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
}
function confirm(title:string,message:string): Promise<boolean> {
  const requestId = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => { confirmations.delete(requestId); resolve(false); },60000);
    confirmations.set(requestId,value => {clearTimeout(timer);confirmations.delete(requestId);resolve(value);});
    output({v:1,type:'confirm',requestId,title,message});
  });
}
async function run(start:MemberStart): Promise<void> {
  mkdirSync(start.agentDir,{recursive:true,mode:0o700}); mkdirSync(start.sessionDir,{recursive:true,mode:0o700});
  const runtime = await ModelRuntime.create({authPath:join(start.agentDir,'auth.json'),modelsPath:join(start.agentDir,'models.json'),allowModelNetwork:false});
  if (process.env.FRIEND_PI_TEST_PROVIDER==='1') await installFixtureProvider(runtime);
  const slash = start.modelId?.indexOf('/') ?? -1;
  if (slash < 1) throw new Error('成员缺少冻结的模型配置');
  const model = runtime.getModel(start.modelId!.slice(0,slash),start.modelId!.slice(slash+1));
  if (!model) throw new Error(`成员模型不可用：${start.modelId}`);
  const expert = start.expert && typeof start.expert === 'object' ? start.expert as Record<string,unknown> : undefined;
  const allowed=start.mode === 'read' ? ['read','grep','find','ls'] : ['read','write','edit','bash'];
  const scope=Array.isArray(expert?.toolScope) ? expert.toolScope as unknown[] : undefined;
  const tools=scope ? allowed.filter(tool=>scope.includes(tool)) : allowed;
  const settings = SettingsManager.inMemory({extensions:[],packages:[],defaultTools:tools});
  const skillPaths=Array.isArray(expert?.skillPaths) ? expert.skillPaths.filter((path):path is string=>typeof path==='string') : [];
  const loader = new DefaultResourceLoader({cwd:start.cwd,agentDir:start.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,additionalSkillPaths:skillPaths,extensionFactories:[guardMember(start,confirm),collaboration]});
  await loader.reload();
  const created = await createAgentSession({cwd:start.cwd,agentDir:start.agentDir,modelRuntime:runtime,model,thinkingLevel:(start.thinkingLevel || 'medium') as 'medium',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(start.cwd,start.sessionDir),tools:[...tools,'swarm_message','swarm_shared']});
  session = created.session;
  session.subscribe(event => {
    // Raw transcript lives in Pi JSONL, never copied to Swarm records.
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'agent_settled') output({v:1,type:'event',event});
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = Array.isArray(event.message.content) ? event.message.content.map(p => p.type === 'text' ? p.text : '').join('\n') : String(event.message.content);
      for (const id of pendingMessages) if (content.includes(`[swarm-message:${id}]`)) {pendingMessages.delete(id);output({v:1,type:'processed',messageId:id});}
    }
  });
  await session.bindExtensions({mode:'rpc',abortHandler:()=>void session?.abort(),onError:error=>output({v:1,type:'failed',error:error.error})});
  output({v:1,type:'ready',sessionId:session.sessionId,sessionFile:session.sessionFile});
  if (stopped) {await session.abort();throw new Error('成员启动期间已停止');}
  const prompt = `${expert?.prompt || ''}\n${start.prompt}`;
  await session.prompt(prompt,{expandPromptTemplates:false});
  // prompt resolves when Pi is idle; session's agent_settled event is emitted before completion.
  if (stopped) throw new Error('成员已停止，现场保留，需要显式接续');
  const last = [...session.messages].reverse().find(message => message.role === 'assistant');
  if (last && 'stopReason' in last && (last.stopReason === 'error' || last.stopReason === 'aborted')) throw new Error('errorMessage' in last ? String(last.errorMessage) : '成员未正常结束');
  output({v:1,type:'settled',summary:session.getLastAssistantText() || '',sessionId:session.sessionId,sessionFile:session.sessionFile});
  await disposeSession();process.disconnect?.();
}
process.on('message',(raw:MemberInput) => {
  if (!raw || raw.v !== 1) return;
  if (raw.type === 'start' && !started) {
    started = true;
    void run(raw).catch(async error => {output({v:1,type:'failed',error:error instanceof Error ? error.message : String(error)});await disposeSession();process.disconnect?.();process.exitCode=1;});
  } else if (raw.type === 'stop') {stopped=true;stopRequests();for (const resolve of confirmations.values()) resolve(false);void session?.abort();}
  else if (raw.type === 'confirm.response') confirmations.get(raw.requestId)?.(raw.accepted);
  else if (raw.type === 'request.response') {const pending=requests.get(raw.requestId);if (pending) {clearTimeout(pending.timer);requests.delete(raw.requestId);if (raw.error) pending.reject(new Error(raw.error));else pending.resolve(raw.result);}}
  else if (raw.type === 'steer' && session) {
    pendingMessages.add(raw.messageId);
    void session.steer(`[swarm-message:${raw.messageId}]\n${raw.text}`).catch(error=>output({v:1,type:'failed',error:String(error)}));
  }
});
process.on('disconnect',() => {stopped=true;stopRequests();for (const resolve of confirmations.values()) resolve(false);void session?.abort();});
