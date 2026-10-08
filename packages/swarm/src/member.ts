/** Standalone native-Pi worker. Pi remains the only owner of its loop and JSONL history. */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { installFixtureProvider,object,digest,requireReadyModel,dataDirectory,guardDesktopModelRequests } from '@friend-pi/core';
import { guardMember } from './guard.js';
import {memberRole,roleInstructions,validateMemberDelivery} from './member-role.js';
import type { MemberInput, MemberOutput, MemberStart } from './types.js';

let session: AgentSession | undefined;
let started = false;
let stopped = false;
let shutdown = false;
const confirmations = new Map<string,(value:boolean)=>void>();
const pendingMessages = new Set<string>();
const requests = new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
function output(message: MemberOutput): void { if (process.connected) process.send?.(message); }
function request(action:'send'|'shared.read'|'shared.write'|'expert.adopt',input:Record<string,unknown>):Promise<unknown> {
  if (stopped || !process.connected) return Promise.reject(new Error('协调者连接已结束'));
  const requestId=randomUUID();return new Promise((resolveResult,reject)=>{
    const timer=setTimeout(()=>{requests.delete(requestId);reject(new Error('协作请求超时'));},60000);
    requests.set(requestId,{resolve:resolveResult,reject,timer});output({v:1,type:'request',requestId,action,input});
  });
}
function collaboration(start:MemberStart,expert:Record<string,unknown>|undefined):ExtensionFactory{return pi=>{
  if(start.executionStyle==='team')pi.registerTool({name:'team_message',label:'向主 Agent 发消息',description:'仅向本次委派的主 Agent 报告或澄清；不能联系同级成员或派生。',parameters:Type.Object({body:Type.String()}),async execute(_id,params){const result=await request('send',{to:'parent',body:params.body});return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  else {
  pi.registerTool({name:'swarm_message',label:'Swarm 成员消息',description:'向同一任务图中的另一个任务发消息。仅协作，不派生任务。',parameters:Type.Object({to:Type.String(),body:Type.String()}),async execute(_id,params) {const result=await request('send',params);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const bases=new Map<string,{revision:number;digest:string}>();
  pi.registerTool({name:'swarm_shared',label:'Swarm 共享材料',description:'读取或使用版本 CAS 更新同一任务图的共享材料。更新须提供读取到的 revision，新建为 0。工具保留已读版本和摘要，竞争时自动三方合并；不能判断的约束冲突会保留材料。',parameters:Type.Object({action:Type.Union([Type.Literal('read'),Type.Literal('write')]),name:Type.String(),content:Type.Optional(Type.String()),expectedRevision:Type.Optional(Type.Number()),operationId:Type.Optional(Type.String())}),async execute(id,params) {const base=bases.get(params.name);const input=params.action==='write'?{...params,operationId:params.operationId||`${start.attemptId}:${id}`,...(base&&params.expectedRevision===base.revision?{baseRevision:base.revision,baseDigest:base.digest}: {})}:params;const result=await request(params.action==='read'?'shared.read':'shared.write',input);if(result&&typeof result==='object'){const row=object(result);const revision=Number(row.revision??row.version);if(Number.isInteger(revision)&&typeof row.digest==='string')bases.set(params.name,{revision,digest:row.digest});}return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  }
  if(expert&&!expert.unavailable){
    const catalog=(Array.isArray(expert.experts)?expert.experts:[]).map(object);const adopted=new Set(Array.isArray(expert.adoptedIds)?expert.adoptedIds.map(String):[]),useReceipts=new Map<string,Record<string,unknown>>();
    pi.registerTool({name:'friend_expert',label:'采用冻结专家方法',description:'仅可使用当前成员已冻结的专家。采用后工具范围立即按交集收紧，新版本不影响本次执行。',parameters:Type.Object({action:Type.Literal('use'),input:Type.Object({id:Type.String()},{additionalProperties:false})},{additionalProperties:false}),async execute(_id,params){
      const frozen=catalog.find(item=>item.id===params.input.id);if(!frozen)throw new Error('专家不在本次成员冻结目录中');
      const response=object(await request('expert.adopt',{id:params.input.id}));if(response.id!==frozen.id||response.version!==frozen.version||response.hash!==frozen.hash)throw new Error('成员采用版本与已冻结方法不匹配');
      adopted.add(String(frozen.id));const scopes=catalog.filter(item=>adopted.has(String(item.id))).map(item=>Array.isArray(item.tools)?item.tools.map(String):[]).filter(scope=>scope.length);if(Array.isArray(expert.toolScope))scopes.unshift(expert.toolScope.map(String));
      const scope=scopes.length?scopes[0].filter(tool=>scopes.every(item=>item.includes(tool))):undefined;expert.toolScope=scope;expert.adoptedIds=[...adopted];
      const prior=useReceipts.get(params.input.id);const adoption=prior||{...object(response.adoption),runId:start.attemptId,taskId:start.taskId,graphId:start.graphId,toolScope:scope};if(!prior){pi.appendEntry('friend-pi.expert.adoption',adoption);useReceipts.set(params.input.id,adoption);output({v:1,type:'expert.adopted',adoption,toolScope:scope});}
      return {content:[{type:'text',text:String(response.prompt)}],details:{adoption,toolScope:scope}};
    }});
  }
};}
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
  if (start.reviewResult && start.mode!=='read') throw new Error('独立复核只能使用只读成员');
  mkdirSync(start.agentDir,{recursive:true,mode:0o700}); mkdirSync(start.sessionDir,{recursive:true,mode:0o700});
  const runtime = await ModelRuntime.create({authPath:join(start.agentDir,'auth.json'),modelsPath:join(start.agentDir,'models.json'),allowModelNetwork:false});
  if (process.env.FRIEND_PI_TEST_PROVIDER==='1') await installFixtureProvider(runtime);
  const slash = start.modelId?.indexOf('/') ?? -1;
  if (slash < 1) throw new Error('成员缺少冻结的模型配置');
  let model = runtime.getModel(start.modelId!.slice(0,slash),start.modelId!.slice(slash+1));
  if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')model=await requireReadyModel(runtime,dataDirectory(),start.modelId!);
  if (!model) throw new Error(`成员模型不可用：${start.modelId}`);
  if(process.env.FRIEND_PI_TEST_PROVIDER!=='1'&&!(await runtime.getAvailable()).some(available=>available.provider===model.provider&&available.id===model.id))throw new Error('成员冻结的模型没有可用的已配置凭据');
  const expert = start.expert && typeof start.expert === 'object' ? start.expert as Record<string,unknown> : undefined;
  const role=memberRole(expert);
  const allowed=start.mode === 'read' ? ['read','grep','find','ls'] : ['read','write','edit','bash'];
  const scope=Array.isArray(expert?.toolScope) ? expert.toolScope as unknown[] : undefined;
  const scoped=scope ? allowed.filter(tool=>scope.includes(tool)) : allowed;const parent=start.parentTools?scoped.filter(tool=>start.parentTools!.includes(tool)):scoped;const roleTools=role&&Array.isArray(role.effectiveTools)?role.effectiveTools:undefined;const tools=roleTools?parent.filter(tool=>roleTools.includes(tool)):parent;
  let reviewSubmission:Readonly<{approved:boolean;findings:string;taskIds?:string[];resultVersions?:Record<string,number>}>|undefined;
  let reviewConflict=false;
  const rawReviewArguments=new Map<string,unknown>();
  const review:ExtensionFactory=pi=>{
    // Pi's argument validation may coerce primitive values. Preserve this tool's
    // original model arguments through its public finalized-message event.
    pi.on('message_end',event=>{if(event.message.role==='assistant')for(const part of event.message.content)if(part.type==='toolCall'&&part.name==='swarm_review_result')rawReviewArguments.set(part.id,structuredClone(part.arguments));});
    pi.on('tool_call',event=>{if(!['read','grep','find','ls','swarm_review_result'].includes(event.toolName))return {block:true,reason:'独立复核只开放 read/grep/find/ls 和 swarm_review_result'};});
    pi.on('before_agent_start',event=>({systemPrompt:`${event.systemPrompt}\n你是独立只读复核器。可用文件工具只有 read、grep、find、ls；没有 Bash、wc、Git 命令、写入工具、消息或共享材料工具。使用宿主已执行的客观检查证据，不要求重跑命令。完成审查后必须且只能用 swarm_review_result 提交 approved 布尔值及 findings 事实；助手文字不算提交。提交后不得改写判断。`}));
    pi.registerTool({name:'swarm_review_result',label:'提交独立复核结论',description:'提交一次不可变独立复核结论。拒绝时用taskIds指向受影响任务；无法归因用空数组让宿主暂停。approved 必须是布尔值，findings 必须说明事实与证据；助手文字不作为结论。',parameters:Type.Object({approved:Type.Boolean(),findings:Type.String({minLength:1,maxLength:100000}),taskIds:Type.Optional(Type.Array(Type.String()))},{additionalProperties:false}),async execute(id,_params){
      const raw=rawReviewArguments.get(id);rawReviewArguments.delete(id);const params=raw && typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:undefined;
      if(!params||Object.keys(params).some(key=>!['approved','findings','taskIds'].includes(key))||typeof params.approved!=='boolean'||typeof params.findings!=='string'||!params.findings.trim()||params.findings.length>100000||(params.taskIds!==undefined&&(!Array.isArray(params.taskIds)||params.taskIds.some(id=>typeof id!=='string'||(start.resultVersions&&!Object.hasOwn(start.resultVersions,id)))))){if(reviewSubmission)reviewConflict=true;throw new Error('复核原始提交需要布尔判断、非空事实和有效任务标识，不能转换字段类型');}
      const submission={approved:params.approved,findings:params.findings,...(params.taskIds===undefined?{}:{taskIds:[...new Set(params.taskIds as string[])]}),...(start.resultVersions?{resultVersions:start.resultVersions}:{})};
      if(reviewSubmission && digest(reviewSubmission)!==digest(submission)){reviewConflict=true;throw new Error('独立复核结论冲突；已提交结论不可改写，成果保留');}
      if(reviewConflict)throw new Error('独立复核已出现冲突，需重新复核');
      reviewSubmission ??= Object.freeze(submission);
      return {content:[{type:'text',text:'复核结论已提交；将等 Pi 本次运行真正结束后采用。'}],details:{accepted:true}};
    }});
  };
  const coordinationTools=start.reviewResult?['swarm_review_result']:[...(start.executionStyle==='team'?['team_message']:['swarm_message','swarm_shared']),...(expert&&!expert.unavailable?['friend_expert']:[])];
  guardDesktopModelRequests(runtime,dataDirectory());
  const settings = SettingsManager.inMemory({...(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'?{cacheWarming:'off' as const}:{}),extensions:[],packages:[],defaultTools:tools});
  const skillPaths=Array.isArray(expert?.skillPaths) ? expert.skillPaths.filter((path):path is string=>typeof path==='string') : [];
  const loader = new DefaultResourceLoader({cwd:start.cwd,agentDir:start.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,additionalSkillPaths:skillPaths,extensionFactories:[guardMember(start,confirm),start.reviewResult?review:collaboration(start,expert)]});
  await loader.reload();
  const created = await createAgentSession({cwd:start.cwd,agentDir:start.agentDir,modelRuntime:runtime,model,thinkingLevel:(start.thinkingLevel || 'medium') as 'medium',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(start.cwd,start.sessionDir),tools:[...tools,...coordinationTools]});
  session = created.session;
  if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'){const originalStream=session.agent.streamFunction;session.agent.streamFunction=async(model,context,options)=>originalStream(await requireReadyModel(runtime,dataDirectory(),`${model.provider}/${model.id}`),context,options);}
  if(start.thinkingLevel&&!session.getAvailableThinkingLevels().includes(start.thinkingLevel as 'medium'))throw new Error('成员冻结的思考等级不受当前模型支持');
  if(expert&&!start.reviewResult){
    session.sessionManager.appendCustomEntry('friend-pi.expert.run',{v:1,runId:start.attemptId,graphId:start.graphId,taskId:start.taskId,frozen:expert});
    for(const raw of Array.isArray(expert.experts)?expert.experts:[]){const item=object(raw);if(!Array.isArray(expert.adoptedIds)||!expert.adoptedIds.includes(item.id))continue;const adoption={v:1,runId:start.attemptId,graphId:start.graphId,taskId:start.taskId,mode:'selected',id:item.id,version:item.version,hash:item.hash,snapshotHash:expert.hash,skills:(Array.isArray(item.skillContents)?item.skillContents:[]).map(raw=>{const skill=object(raw);return {path:skill.path,hash:skill.hash};}),toolScope:expert.toolScope};session.sessionManager.appendCustomEntry('friend-pi.expert.adoption',adoption);output({v:1,type:'expert.adopted',adoption,toolScope:Array.isArray(expert.toolScope)?expert.toolScope.map(String):undefined});}
  }
  let settled=false;
  session.subscribe(event => {
    // Raw transcript lives in Pi JSONL, never copied to Swarm records.
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'agent_settled') output({v:1,type:'event',event});
    if (event.type === 'agent_settled') settled=true;
    if (event.type === 'message_start' && event.message.role === 'user') {
      const content = Array.isArray(event.message.content) ? event.message.content.map(p => p.type === 'text' ? p.text : '').join('\n') : String(event.message.content);
      for (const id of pendingMessages) if (content.includes(`[swarm-message:${id}]`)) {pendingMessages.delete(id);output({v:1,type:'processed',messageId:id});}
    }
  });
  await session.bindExtensions({mode:'rpc',abortHandler:()=>void session?.abort(),onError:error=>output({v:1,type:'failed',error:error.error})});
  output({v:1,type:'ready',sessionId:session.sessionId,sessionFile:session.sessionFile});
  if (stopped) {await session.abort();throw new Error('成员启动期间已停止');}
  const prompt = `${roleInstructions(role)}\n${expert?.prompt || ''}\n${start.prompt}`;
  await session.prompt(prompt,{expandPromptTemplates:false});
  // prompt resolves when Pi is idle; session's agent_settled event is emitted before completion.
  if (stopped) throw new Error('成员已停止，现场保留，需要显式接续');
  const last = [...session.messages].reverse().find(message => message.role === 'assistant');
  if (last && 'stopReason' in last && (last.stopReason === 'error' || last.stopReason === 'aborted')) throw new Error('errorMessage' in last ? String(last.errorMessage) : '成员未正常结束');
  if (!settled || !session.isIdle) throw new Error('Pi 成员尚未达到真正结束边界');
  if(start.reviewResult && (reviewConflict || !reviewSubmission))throw new Error(reviewConflict?'独立复核提交冲突，成果已保留':'独立复核未通过 swarm_review_result 提交结论，成果已保留');
  const summary=start.reviewResult?JSON.stringify(reviewSubmission):session.getLastAssistantText() || '';if(!start.reviewResult)validateMemberDelivery(role,summary);
  output({v:1,type:'settled',summary,sessionId:session.sessionId,sessionFile:session.sessionFile});
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
