import { randomUUID } from 'node:crypto';
import { mkdirSync,existsSync,readFileSync,realpathSync,openSync,closeSync } from 'node:fs';
import { join,resolve,relative,extname } from 'node:path';
import { createAgentSession,createBashToolDefinition,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,createEventBus,initTheme,type AgentSession,type ExtensionUIContext,type ExtensionFactory,type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { shellEnvironment,dataDirectory,object,text,visibleText,historyItems,requestPlugin,atomicWrite,installFixtureProvider,RecordStore,projectIdentity,digest,isSessionDeleted,makeContext,type ExecutionMode,type HostPolicy,parsePermissionMode,permissionDecision,toolPermissionRequest,temporaryPermission,temporaryPermissionMatches,type PermissionMode,type PermissionRequest } from '@friend-pi/core';
import {Type} from 'typebox';
import {RuntimeController} from './runtime-controller.js';
import {PlanStore} from './plan-store.js';
import {projectMessages,projectTeammateMessages,projectTraceSystems,traceJSON} from './message-projection.js';
import {RunChangesTracker,projectRunChanges,RUN_CHANGES_TYPE} from './run-changes.js';
import {SessionMetricRecorder,projectSessionMonitor,SESSION_METRIC_TYPE} from './session-monitor.js';
import type { ImageContent } from '@earendil-works/pi-ai';
import {guardDesktopModelRequests} from '@friend-pi/core';
import {requireReadyModel,configuredModelMetadata} from './model-readiness.js';
import { createProviderRuntime,providerMetadata,saveProviderConfiguration } from './provider-settings.js';

const dataDir=dataDirectory();const root=resolve(process.env.FRIEND_PI_ROOT || process.cwd());const cwd=resolve(process.env.FRIEND_PI_PROJECT || process.cwd());
const temporaryWriteRoot=process.env.FRIEND_PI_TEMPORARY_WRITE_ROOT?realpathSync(process.env.FRIEND_PI_TEMPORARY_WRITE_ROOT):undefined;
if(temporaryWriteRoot)process.env.FRIEND_PI_TEMPORARY_WRITE_ROOT=temporaryWriteRoot;
const agentDir=join(dataDir,'pi');mkdirSync(agentDir,{recursive:true,mode:0o700});
// Advertise the actual SDK directory before loading native plugins. Their public
// ExtensionContext has no SDK agentDir field, and inherited shell Pi paths may differ.
process.env.FRIEND_PI_AGENT_DIR=agentDir;
const plugins=['swarm','expert','memory','topic-rebuild'];
let enabled=process.env.FRIEND_PI_PLUGINS?JSON.parse(process.env.FRIEND_PI_PLUGINS) as string[]:plugins;
let changeTracker:RunChangesTracker|undefined;let session:AgentSession;let runtime:ModelRuntime;const bus=createEventBus();let runId:string|undefined;let runRequiresSwarm:boolean|undefined;let disposed=false;let swarmRunning=false;let planMode=process.env.FRIEND_PI_PLAN_MODE==='1';let permissionMode:PermissionMode=process.env.FRIEND_PI_PERMISSION_MODE?parsePermissionMode(process.env.FRIEND_PI_PERMISSION_MODE):'auto';let executionMode:ExecutionMode=['team','swarm'].includes(process.env.FRIEND_PI_MODE||'')?process.env.FRIEND_PI_MODE as ExecutionMode:'single';let lifecycleStatus=process.env.FRIEND_PI_STATUS||'idle';let cancelRequested=false;let permissionEpoch=0;const activeGraphIds=new Set<string>();const runGraphIds=new Set<string>();const baselineGraphIds=new Set<string>();const pendingSwarmGraphIds=new Set<string>();const swarmGraphs=new Map<string,Record<string,unknown>>();let runStartedAt=0;let foregroundOpen=false;let authorityNotice='';let statusBeforeCompaction:string|undefined;let settledRunId:string|undefined;
const dialogs=new Map<string,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>;terminalRequestId?:string}>();
const businessStore=new RecordStore('plans',dataDir);let plans:PlanStore;let policyRevision=0;let modelInFlight=false;let auditRunning=false;let workflowRunning=false;let teammateRunning=false;const neutralToolIds=new Set<string>();const roleDeliveryErrors=new Map<string,string>();const workflowStatuses=new Map<string,string>();
const services=new RuntimeController(dataDir,{publish:(event,data)=>{publish(event==='runtime.process'?'plugin':event,event==='runtime.process'?{v:1,pluginEvent:event,data}:data);if(session&&!disposed)publish('state',current());},busy:()=>swarmBusy(),mode:()=>executionMode,planMode:()=>planMode,runId:()=>runId,modelId:()=>session?.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:()=>session?.thinkingLevel||'off',haltExecution:async origin=>{const stop=()=>handle('stop',{keepGoalState:true}).then(()=>{}).catch(error=>publish('notice',{level:'error',message:publicError(error)}));if(origin==='user')await stop();else setImmediate(()=>void stop());},sendWake:async frame=>{await new Promise<void>(done=>setImmediate(done));if(stopping||disposed||frame.generation!==services.generation()||frame.goalId&&services.currentGoal()?.status!=='active'&&services.currentGoal()?.status!=='waiting')return;await ensureModelReady();const input:PendingInput={id:randomUUID(),text:frame.message,combinedLength:frame.message.length,combinedHash:digest(frame.message),imageHash:imageIdentity([]),expectsStart:true,automatic:true,memberContinuation:frame.id.startsWith('member-request:'),runId};pendingInputs.push(input);session.sessionManager.appendCustomEntry('friend-pi.runtime-wake',{v:1,eventId:frame.id,generation:frame.generation,goalId:frame.goalId});try{await session.prompt(frame.message,{expandPromptTemplates:false});}finally{const position=pendingInputs.indexOf(input);if(position>=0)pendingInputs.splice(position,1);}},prepareWake:async frame=>{if(memberBudgetWait())throw new Error(memberBudgetWait());if(disposed||stopping)throw new Error('执行已停止');if(!runId){runId=frame.runId||randomUUID();process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();captureRunPolicy(frame.id.startsWith('member-request:')?false:undefined);}const goal=services.currentGoal();if(frame.id.startsWith('resume:')&&goal)captureRunPolicy(goal.mode==='swarm'&&!planMode);await changeTracker?.ensure(runId);foregroundOpen=true;cancelRequested=false;lifecycleStatus='running';policyRevision++;await applyAssignedRole();await ensureModelReady();}});
function runtimeState(){try{return services.snapshot();}catch{return undefined;}}
function finiteJobs(){try{return services.jobs.hasFinite(services.context(),runId);}catch{return false;}}
async function applyAssignedRole(forNewRun=false){if(!enabled.includes('expert'))return;const snap=object(await requestPlugin(bus,'expert','role.snapshot',{},1000));const selection=snap.selection&&typeof snap.selection==='object'?object(snap.selection):{};const current=snap.current&&typeof snap.current==='object'?object(snap.current):undefined,phase=snap.phase&&typeof snap.phase==='object'?object(snap.phase):{};const sameRun=!forNewRun&&phase.runId===runId;const role=sameRun?current:(Array.isArray(snap.roles)?snap.roles.map(object):[]).find(item=>item.id===selection.id);if(role?.modelId&&(!sameRun||role.modelSource!=='inherited')){const id=String(role.modelId);if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,id);else if(!runtime.hasConfiguredAuth(selectedModel(id).provider))throw new Error('角色指定模型未配置认证');if(`${session.model?.provider}/${session.model?.id}`!==id)await session.setModel(selectedModel(id));}if(role?.thinkingLevel&&(!sameRun||role.thinkingSource!=='inherited')){if(!session.getAvailableThinkingLevels().includes(String(role.thinkingLevel) as ThinkingLevel))throw new Error('角色指定思考等级不可用');session.setThinkingLevel(String(role.thinkingLevel) as ThinkingLevel);}}
interface PendingInput {id:string;text:string;combinedLength:number;combinedHash:string;imageHash:string;expectsStart:boolean;automatic?:boolean;memberContinuation?:boolean;nativeMessage?:unknown;runId?:string}
const pendingInputs:PendingInput[]=[];let startedInputId:string|undefined;let stopping=false;
function imageIdentity(images:readonly unknown[]){return digest(JSON.stringify(images.map(raw=>{const image=object(raw);return [image.mimeType,image.data];})));}
function output(message:unknown,flushed?:()=>void){if(process.connected){if(flushed)process.send?.(message,flushed);else process.send?.(message);}else flushed?.();}
function publish(type:string,data:unknown){if(type==='state'&&!object(data).isRunning&&!disposed&&!['active','waiting','verifying'].includes(services.currentGoal()?.status||''))void changeTracker?.settle(runId,lifecycleStatus,session?.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id).catch(error=>publish('notice',{level:'warning',message:publicError(error)}));output({type:'event',event:{type,sessionId:session?.sessionId,runId,data}});}
function dialog(kind:string,title:string,input:Record<string,unknown>={},timeout=60000,terminalRequestId?:string):Promise<unknown>{
  const id=randomUUID();return new Promise(resolveResult=>{const timer=setTimeout(()=>{dialogs.delete(id);resolveResult(undefined);publish('dialog.closed',{id});},timeout);dialogs.set(id,{resolve:resolveResult,timer,terminalRequestId});publish('dialog',{id,kind,title,...input});});
}
const busyGraphStatuses=new Set(['running','awaiting_review','ready','stopping']);
const swarmExecutionActions=new Set(['start','resume','prepare','review','integrate','rework']);
function memberBudgetWait(){const goal=services.currentGoal();return goal?.tokenBudget!==undefined&&(!goal.usageAvailable||goal.tokens>=goal.tokenBudget)?'目标预算耗尽或使用量不可核实，补充已保存，请先处理预算':undefined;}
function rootExecutionBusy(){return swarmRunning||auditRunning||workflowRunning||pendingSwarmGraphIds.size>0;}
function swarmBusy(){return rootExecutionBusy()||teammateRunning;}
function captureRunPolicy(requiresSwarm=executionMode==='swarm'&&!planMode){runRequiresSwarm=requiresSwarm;session.sessionManager.appendCustomEntry('friend-pi.run.policy.v1',{v:1,runId,mode:executionMode,planMode,requiresSwarm});}
let missingModelId:string|undefined;
function current(){const entries=session.sessionManager.getBranch(),sdkStats=session.getSessionStats(),context=sdkStats.contextUsage;return {monitor:projectSessionMonitor(session.sessionManager.getEntries(),sdkStats,context),sessionId:session.sessionId,messages:projectMessages(entries),changes:projectRunChanges(entries),traceSystems:projectTraceSystems(entries),receipts:entries.filter(entry=>entry.type==='custom'&&/friend-pi\.(?:memory|expert)/.test(entry.customType)),plan:plans?.current(),lifecycleStatus,isRunning:!session.isIdle||swarmBusy()||finiteJobs()||stopping,runtime:runtimeState(),navigationLocked:!session.isIdle||swarmBusy()||stopping,permissionEpoch,planMode,permissionMode,executionMode,modelId:missingModelId||(session.model?`${session.model.provider}/${session.model.id}`:undefined),thinkingLevel:session.thinkingLevel,thinkingLevels:session.getAvailableThinkingLevels(),plugins:enabled,context,sessionFile:session.sessionFile,runId};}
function swarmAuthority():{status:string;message?:string}|undefined {
  const required=runRequiresSwarm===true&&!!runId;
  const ids=new Set([...activeGraphIds,...(required?runGraphIds:[])]);
  const graphs=[...ids].map(id=>swarmGraphs.get(id));
  if(rootExecutionBusy())return {status:graphs.some(graph=>graph?.status==='awaiting_review')?'awaiting_review':'running'};
  if(!ids.size)return required?{status:'failed',message:'Swarm 本轮没有实际任务图和成员执行，不能认定协作已完成。请检查工具过程后显式继续。'}:undefined;
  if(graphs.some(graph=>!graph))return {status:'failed',message:'Swarm 本轮任务图记录缺失，无法确认成果已整合。'};
  if(graphs.some(graph=>graph!.status==='failed'))return {status:'failed',message:'Swarm 本轮存在失败任务图；成果尚未全部整合，请查看任务图。'};
  if(graphs.some(graph=>graph!.status==='paused'))return {status:graphs.some(graph=>Array.isArray(graph!.tasks)&&graph!.tasks.some(task=>object(task).status==='unknown'))?'interrupted':'paused',message:'Swarm 本轮任务图已暂停；请检查保留成果和工具副作用后显式接续。'};
  if(graphs.some(graph=>graph!.status==='stopped'))return {status:'stopped'};
  if(graphs.every(graph=>graph!.status==='integrated'||graph!.executionStyle==='team'&&graph!.status==='completed'))return {status:'completed'};
  return {status:'failed',message:'Swarm 本轮任务图尚未启动或完成整合，不能认定协作已完成。请查看任务图并显式启动或接续。'};
}
function publishAuthorityNotice(authority=swarmAuthority()){
  if(!authority?.message){if(authority?.status==='completed'&&authorityNotice){authorityNotice='';publish('notice',{level:'info',message:'Swarm 成果已通过检查与独立复核并完成整合。'});}return;}
  const fingerprint=JSON.stringify([runId,authority.status,authority.message,[...runGraphIds,...activeGraphIds].map(id=>[id,swarmGraphs.get(id)?.status])]);
  if(fingerprint===authorityNotice)return;authorityNotice=fingerprint;
  publish('notice',{level:authority.status==='failed'?'error':'warning',message:authority.message});
}
function settledStatus(){
  const last=[...session.messages].reverse().find(message=>message.role==='assistant');
  const authority=swarmAuthority();if(!cancelRequested&&runId&&roleDeliveryErrors.has(runId))return 'failed';if(finiteJobs()&&!cancelRequested)return 'running';if(cancelRequested)return authority?.status==='interrupted'||authority?.status==='paused'?authority.status:'stopped';return authority?.status|| (last?.stopReason==='error'?'failed':last?.stopReason==='aborted'?'stopped':'completed');
}
async function ensureModelReady(){if(missingModelId)throw new Error('历史型号不可用，请重新配置并通过连接测试');if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,session.model?`${session.model.provider}/${session.model.id}`:'');}
async function modelState(){return process.env.FRIEND_PI_DESKTOP_MANAGED==='1'?await configuredModelMetadata(runtime,dataDir):providerMetadata(runtime);}
function selectedModel(id:string){const slash=id.indexOf('/');const model=runtime.getModel(id.slice(0,slash),id.slice(slash+1));if(slash<1||!model)throw new Error('型号不可用，请重新选择');return model;}
const terminalRequests=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>;phase:'transport'|'waiting'|'admitted';cleanup():void}>();
function cancelTerminalRequest(id:string,error:Error){const pending=terminalRequests.get(id);if(!pending)return;terminalRequests.delete(id);pending.cleanup();for(const [key,dialog] of dialogs)if(dialog.terminalRequestId===id){clearTimeout(dialog.timer);dialogs.delete(key);dialog.resolve(undefined);publish('dialog.closed',{id:key});}output({type:'terminal.cancel',id});pending.reject(error);}
function terminalDeadline(id:string,delay:number){return setTimeout(()=>cancelTerminalRequest(id,new Error('终端操作超时，未自动重放')),delay);}
function cancelTerminalRequests(){for(const id of [...terminalRequests.keys()])cancelTerminalRequest(id,new Error('终端请求已中断，未自动重放'));}
function terminalRequest(method:string,input:Record<string,unknown>,signal?:AbortSignal){const id=randomUUID();return new Promise<unknown>((resolve,reject)=>{
 if(signal?.aborted){reject(new Error('终端请求已中断，未自动重放'));return;}
 const abort=()=>cancelTerminalRequest(id,new Error('终端请求已中断，未自动重放'));
 const pending={resolve,reject,timer:terminalDeadline(id,20000),phase:'transport' as const,cleanup(){clearTimeout(this.timer);signal?.removeEventListener('abort',abort);}};
 terminalRequests.set(id,pending);signal?.addEventListener('abort',abort,{once:true});output({type:'terminal.request',id,method,input,planMode});
});}
function guard():ExtensionFactory{return pi=>{
  pi.registerTool({name:'friend_terminal',label:'服务终端',description:'启动需要保持运行的服务终端，列出或读取输出。input/read/stop 必须提供当前 authorityEpoch；用户接管后不可控制。',parameters:Type.Object({action:Type.Union(['create','list','read','input','stop'].map(value=>Type.Literal(value))),id:Type.Optional(Type.String()),name:Type.Optional(Type.String()),command:Type.Optional(Type.String()),data:Type.Optional(Type.String()),authorityEpoch:Type.Optional(Type.Number())}),async execute(_id,input,signal){if(planMode&&!['list','read'].includes(input.action))throw new Error('计划模式只允许读取已有服务终端');const result=await terminalRequest(input.action,input,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const offPolicy=pi.events.on('friend-pi:v1:policy',raw=>{const request=object(raw);if(request.v!==1||typeof request.reply!=='function'||session&&request.sessionId!==session.sessionId)return;const active=[...services.activeTools(),...services.unknownActivities(),...services.unsettledJobs()];const admissions=services.jobs.pendingCount(String(request.sessionId));const members=[...swarmGraphs.values()].flatMap(graph=>[...(Array.isArray(graph.attempts)?graph.attempts:[]),...(Array.isArray(graph.reviewAttempts)?graph.reviewAttempts:[])].map(object)).filter(attempt=>attempt.status==='running').length;const policy:HostPolicy={v:1,revision:policyRevision,runId,stage:'main',canSwitchRole:!modelInFlight&&!teammateRunning&&active.length===0&&members===0&&admissions===0,unsettledTools:active.length+members+admissions+(teammateRunning?1:0)+(modelInFlight?1:0),tools:pi.getAllTools().map(tool=>tool.name),writeScopes:planMode?[]:['.'],executionMode,planMode,permissionMode,temporaryWriteRoot,executionStopped:stopping||cancelRequested||!!memberBudgetWait(),executionWaitReason:memberBudgetWait(),modelId:session?.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session?.thinkingLevel,goalId:services.currentGoal()&&['active','waiting','verifying'].includes(services.currentGoal()!.status)?services.currentGoal()!.id:undefined};(request.reply as (value:HostPolicy)=>void)(policy);});
  pi.on('session_shutdown',()=>offPolicy());
  pi.registerTool({name:'friend_plan',label:'提交计划',description:'只读规划完成后提交可供用户批准的计划；模型不能批准或启动。',parameters:Type.Object({action:Type.Union([Type.Literal('submit'),Type.Literal('read')]),body:Type.Optional(Type.String())}),async execute(_id,input){const result=input.action==='read'?plans.current():plans.submit(text(input.body,'计划'),{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});publish('state',current());return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  pi.on('context_with_system',event=>{
    const systems=event.messages.filter(message=>message.role==='system');
    const prompt=systems.map(message=>traceJSON(message)).join('\n');
    const native=session.sessionManager.getBranch().findLast(entry=>entry.type==='message'&&entry.message.role==='system');
    if(native?.type==='message'&&prompt===traceJSON(native.message))return;
    const prior=session.sessionManager.getBranch().findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.trace.system.v1'&&object(entry.data).runId===runId);
    if(prompt&&(!prior||digest(prompt)!==object(object(prior).data).hash))session.sessionManager.appendCustomEntry('friend-pi.trace.system.v1',{v:1,runId,text:prompt.slice(0,65536),hash:digest(prompt),truncated:prompt.length>65536});
  });
  pi.on('before_agent_start',event=>{
    // Public Pi input hooks identify the submitted prompt before Pi appends image
    // normalization hints. Bind its next new native user object, never an old
    // history entry or another input with the same empty text.
    startedInputId=pendingInputs.find(input=>input.expectsStart&&!input.nativeMessage&&input.combinedHash===digest(event.prompt)&&input.imageHash===imageIdentity(event.images||[]))?.id;
    const memberContinuation=pendingInputs.find(input=>input.id===startedInputId)?.memberContinuation;
    const instructions=memberContinuation?'当前是队友补充讨论的后续处理。先读取该成员的原生历史，解释结果；只有需要改变成果时才建立新的受控任务和完整检查、复核。不要重跑已完成任务。':planMode?'当前是计划模式。使用 read、ls、find、grep 只读探索，给出目标、步骤、依赖、成果和客观验证；用 friend_plan submit 提交完整计划给用户批准。不要修改项目、运行 shell 或启动协作成员。':executionMode==='team'?'当前是 Team 模式。需要委派时用 friend_team delegate。子成员只与你通信；读取成果直接返回，写入须隔离、检查和独立复核，之后由你决定 integrate。可以沿用当前模型与思考等级。':executionMode==='swarm'?'请用 friend_swarm create/start 工具自主拆分并执行以下目标，跟踪任务并独立复核；不要只给方案。':'';
    const workspaceInstructions=temporaryWriteRoot?`你正在临时会话中工作。所有任务产物默认写入当前会话目录 ${temporaryWriteRoot}。修改此目录外的文件必须先获得用户逐次批准；权限策略不能免除该要求。无法确认写入范围的命令会申请批准。`:'';
    return instructions||workspaceInstructions?{systemPrompt:`${event.systemPrompt}\n\n${instructions}\n${workspaceInstructions}`}:undefined;
  });
  pi.on('tool_call',async(event,ctx)=>{
    const input=object(event.input);if(stopping)return {block:true,reason:'正在停止，未开始的工具已取消'};
    if(planMode){
      const readActions=new Set(['list','snapshot','search','read','get','versions','history.search','history.read','history.around']);
      if(!['read','ls','find','grep'].includes(event.toolName)&&!(event.toolName==='friend_plan'&&['submit','read'].includes(String(input.action)))&&!(event.toolName.startsWith('friend_')&&readActions.has(String(input.action))))return {block:true,reason:'计划模式只允许读取、搜索和提交计划，批准后再执行。'};
    }
    const request=toolPermissionRequest(event.toolName,input,Boolean(temporaryWriteRoot))||(temporaryWriteRoot&&event.toolName==='bash'?{operation:'执行命令',message:String(input.command||''),autoEligible:false}:undefined);
    if(request&&!await approvePermission(request))return {block:true,reason:'用户未批准该操作'};
    await changeTracker?.captureTool(event.toolName,input).catch(error=>publish('notice',{level:'warning',message:publicError(error)}));
  });
};}
async function approvePermission(request:PermissionRequest,terminalRequestId?:string){
  if(terminalRequestId&&!terminalRequests.has(terminalRequestId))return false;
  request=temporaryPermission(request,temporaryWriteRoot,cwd);
  if(stopping||disposed)return false;const epoch=permissionEpoch,mode=permissionMode,decision=permissionDecision(mode,request);
  const approved=decision==='allow'||Boolean(await dialog('confirm','确认'+request.operation,{message:request.message},60000,terminalRequestId));
  if(stopping||disposed||terminalRequestId&&!terminalRequests.has(terminalRequestId)||epoch!==permissionEpoch||!temporaryPermissionMatches(request,temporaryWriteRoot,cwd))return false;
  session.sessionManager.appendCustomEntry('friend-pi.permission.decision',{v:1,mode,operation:request.operation,messageHash:digest(request.message),approved,source:decision==='allow'?'automatic':'user',policyRevision});return approved;
}
async function bind(){
  const base=session.extensionRunner.getUIContext();
  const ui:ExtensionUIContext={...base,
    select:async(title,options,opts)=>await dialog('select',title,{options},opts?.timeout) as string|undefined,
    confirm:async(title,message,opts)=>Boolean(await dialog('confirm',title,{message},opts?.timeout)),
    input:async(title,placeholder,opts)=>await dialog('input',title,{placeholder},opts?.timeout) as string|undefined,
    editor:async(title,prefill)=>await dialog('editor',title,{prefill}) as string|undefined,
    notify:(message,level)=>publish('notice',{message,level}),
    setStatus:(key,value)=>publish('notice',{message:value||'',key}),
    setWorkingMessage:message=>publish('notice',{message}),
    custom:async()=>{throw new Error('终端专属界面不能在桌面客户端显示');},
  };
  await session.bindExtensions({uiContext:ui,mode:'rpc',abortHandler:()=>void session.abort(),shutdownHandler:()=>void shutdown(),onError:error=>publish('notice',{level:'error',message:error.error})});
}
async function initialize(){
  initTheme('light',false);
  runtime=await createProviderRuntime(dataDir);
  let model=process.env.FRIEND_PI_TEST_PROVIDER==='1'?await installFixtureProvider(runtime):undefined;
  if(process.env.FRIEND_PI_MODEL){const slash=process.env.FRIEND_PI_MODEL.indexOf('/');const requested=runtime.getModel(process.env.FRIEND_PI_MODEL.slice(0,slash),process.env.FRIEND_PI_MODEL.slice(slash+1));if(requested)model=requested;else if(process.env.FRIEND_PI_DESKTOP_MANAGED!=='1')model=selectedModel(process.env.FRIEND_PI_MODEL);else {missingModelId=process.env.FRIEND_PI_MODEL;process.env.FRIEND_PI_DESKTOP_MODEL_UNAVAILABLE='1';}}
  if(!model)model=(await runtime.getAvailable())[0]||runtime.getModels().find(item=>item.provider==='deepseek')||runtime.getModels()[0];
  guardDesktopModelRequests(runtime,dataDir);
  const settings=SettingsManager.inMemory({...(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'?{cacheWarming:'off' as const}:{}),extensions:enabled.map(name=>join(root,'packages',name,'dist','index.js')),packages:[],defaultTools:['read','bash','edit','write','ls','find','grep'],compaction:{enabled:true,...(process.env.FRIEND_PI_TEST_PROVIDER==='1'?{keepRecentTokens:512,reserveTokens:2048}:{})}});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:false,noSkills:false,noPromptTemplates:false,noThemes:true,eventBus:bus,extensionFactories:[guard(),services.extension(),services.jobs.extension()]});
  await loader.reload({resolveProjectTrust:async()=>true});
  const priorFile=process.env.FRIEND_PI_SESSION_FILE;
  if(priorFile){if(!existsSync(priorFile))throw new Error('原始会话历史缺失，未创建替代历史');const raw=readFileSync(priorFile,'utf8');if(!raw.trim())throw new Error('原始历史为空，不能恢复');const entries=raw.trim().split('\n').map(line=>JSON.parse(line));if(entries[0]?.type!=='session'||typeof entries[0].id!=='string')throw new Error('原始历史头部无效，未创建替代历史');const known=new Set<string>();for(const entry of entries.slice(1)){if(!entry||typeof entry.type!=='string'||typeof entry.id!=='string'||!entry.id||known.has(entry.id)||typeof entry.timestamp!=='string'||!Number.isFinite(Date.parse(entry.timestamp))||entry.parentId!==null&&(typeof entry.parentId!=='string'||!known.has(entry.parentId))||entry.type==='message'&&(!entry.message||typeof entry.message.role!=='string'))throw new Error('原始历史条目损坏，索引保留，未创建替代历史');known.add(entry.id);}}
  const manager=priorFile?SessionManager.open(priorFile):SessionManager.create(cwd,join(dataDir,'sessions'));
  if(!priorFile){const file=manager.getSessionFile();if(!file)throw new Error('新会话原史路径不可用');closeSync(openSync(file,'wx',0o600));manager.setSessionFile(file);}
  if(!priorFile)manager.appendCustomEntry('friend-pi.session.created',{v:1,desktopId:process.env.FRIEND_PI_DESKTOP_SESSION_ID,createdAt:new Date().toISOString()});
  if(process.env.FRIEND_PI_PI_SESSION_ID&&manager.getSessionId()!==process.env.FRIEND_PI_PI_SESSION_ID)throw new Error('原始历史会话身份不匹配');
  if(priorFile&&projectIdentity(manager.getCwd())!==projectIdentity(cwd))throw new Error('原始历史项目身份不匹配');
  if(isSessionDeleted(dataDir,manager.getSessionId()))throw new Error('会话已删除');
  if(priorFile){const branch=manager.getBranch();const latestUser=projectMessages(branch).findLast(message=>message.role==='user');runId=latestUser?.runId;const latestPolicy=branch.findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.run.policy.v1'&&object(entry.data).v===1&&typeof object(entry.data).runId==='string'&&!!object(entry.data).runId&&typeof object(entry.data).requiresSwarm==='boolean');if(latestPolicy?.type==='custom'&&branch.indexOf(latestPolicy)>branch.findIndex(entry=>entry.id===latestUser?.id))runId=String(object(latestPolicy.data).runId);if(!runId&&latestUser){const userIndex=branch.findIndex(entry=>entry.id===latestUser.id);const receipt=branch.slice(userIndex+1).findLast(entry=>entry.type==='custom'&&/friend-pi\.(memory\.usage|expert\.(run|adoption))/.test(entry.customType)&&typeof object(entry.data).runId==='string');if(receipt?.type==='custom')runId=String(object(receipt.data).runId);}if(runId){process.env.FRIEND_PI_RUN_ID=runId;settledRunId=runId;}}
  plans=new PlanStore(businessStore,projectIdentity(cwd),manager.getSessionId());
  const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager:settings,sessionManager:manager,customTools:[createBashToolDefinition(cwd,{spawnHook:ctx=>({...ctx,env:shellEnvironment(ctx.env)})}) as ToolDefinition]});session=created.session;
  changeTracker=new RunChangesTracker(cwd,projectIdentity(cwd),dataDir,session.sessionId,summary=>{session.sessionManager.appendCustomEntry(RUN_CHANGES_TYPE,summary);publish('state',current());},()=>projectRunChanges(session.sessionManager.getBranch()));
  if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'){const originalStream=session.agent.streamFunction;session.agent.streamFunction=async(model,context,options)=>originalStream(await requireReadyModel(runtime,dataDir,`${model.provider}/${model.id}`),context,options);}
  if(created.extensionsResult.errors.length)throw new Error(created.extensionsResult.errors.map(error=>error.error).join('; '));
  let liveSequence=0;let liveStreamId="";const metricRecorder=new SessionMetricRecorder();let metricMessage:unknown;
  session.subscribe(event=>{
    if(event.type==='message_end'&&event.message.role==='assistant')metricMessage=event.message;
    const metric=metricRecorder.observe(event),measuredMessage=metricMessage;
    if(metric&&measuredMessage)queueMicrotask(()=>{if(disposed)return;const entry=session.sessionManager.getEntries().find(e=>e.type==='message'&&e.message===measuredMessage);if(entry){session.sessionManager.appendCustomEntry(SESSION_METRIC_TYPE,{...metric,entryId:entry.id});publish('state',current());}});
    if(event.type==='agent_start')changeTracker?.reopen(runId);
    if(event.type==='message_start'&&event.message.role==='assistant')liveStreamId="stream-"+session.sessionId+"-"+(++liveSequence);
    if(['message_start','message_update','message_end'].includes(event.type))publish('stream',{streamId:liveStreamId,event});
    if(event.type==='message_start'&&event.message.role==='assistant')modelInFlight=true;if(event.type==='message_end'&&event.message.role==='assistant'||event.type==='agent_settled')modelInFlight=false;
    publish('pi',event);
    if(event.type==='tool_execution_start'){if(event.toolName==='friend_expert'&&/^role\.(snapshot|read|versions|assign|switch)$/.test(String(object(event.args).action)))neutralToolIds.add(event.toolCallId);else policyRevision++;services.beginTool(event.toolCallId,event.toolName,event.args);}
    if(event.type==='tool_execution_end'){if(!neutralToolIds.delete(event.toolCallId))policyRevision++;services.endTool(event.toolCallId);}
    if(event.type==='message_end'&&event.message.role==='assistant'){const usage=event.message.usage;services.account(usage?usage.totalTokens:undefined,`main:${event.message.timestamp}:${digest(event.message.content)}`);if(services.currentGoal()?.status==='paused'&&services.currentGoal()?.error?.includes('令牌'))void session.abort();}
    if(event.type==='message_start'&&event.message.role==='user'){
      const nativeMessage=event.message;const nativeText=visibleText(nativeMessage.content);
      const started=pendingInputs.find(input=>input.id===startedInputId);startedInputId=undefined;
      // Queued steering/follow-up inputs do not run before_agent_start. They are
      // delivered unchanged by Pi, so require both complete text and image hashes.
      const input=started||pendingInputs.find(input=>!input.expectsStart&&!input.nativeMessage&&input.combinedHash===digest(nativeText)&&input.imageHash===imageIdentity(typeof nativeMessage.content==='string'?[]:nativeMessage.content.filter(part=>part.type==='image')));
      if(input&&digest(nativeText.slice(0,input.combinedLength))===input.combinedHash)input.nativeMessage=nativeMessage;
    }
    if(event.type==='message_end'&&event.message.role==='user'){const nativeMessage=event.message;queueMicrotask(()=>{if(disposed)return;const entry=session.sessionManager.getBranch().find(e=>e.type==='message'&&e.message===nativeMessage);const position=pendingInputs.findIndex(input=>input.nativeMessage===nativeMessage);if(!entry||position<0)return;const input=pendingInputs[position];if(digest(visibleText(nativeMessage.content).slice(0,input.text.length))!==digest(input.text))return;session.sessionManager.appendCustomEntry(input.automatic?'friend-pi.runtime-wake.input':'friend-pi.input.v1',{entryId:entry.id,textEnd:input.text.length,hash:digest(input.text),runId:input.runId});pendingInputs.splice(position,1);publish('state',current());});}
    if(event.type==='agent_settled'&&!disposed){
      settledRunId=runId;lifecycleStatus=settledStatus();
      foregroundOpen=rootExecutionBusy();
      if(planMode){const last=[...session.messages].reverse().find(m=>m.role==='assistant');const body=last?visibleText(last.content):'';if(body&&(!plans.current()||Date.parse(plans.current()!.createdAt)<runStartedAt))plans.submit(body,{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});}
      services.settled(lifecycleStatus);
      if(swarmAuthority()?.message)publishAuthorityNotice();
      else if(lifecycleStatus==='failed'){
        const last=[...session.messages].reverse().find(message=>message.role==='assistant');
        publish('notice',{level:'error',message:publicError(roleDeliveryErrors.get(runId||'')||last?.errorMessage||'模型执行未完成')});
      }
    }
    if(event.type==='compaction_start'&&event.reason==='manual'){
      statusBeforeCompaction=lifecycleStatus;lifecycleStatus='rebuilding';
    }
    if(event.type==='compaction_end'&&statusBeforeCompaction){
      // Pi may execute deferred compaction after its public agent_settled event.
      // Never restore a captured "running" status over that completed run.
      lifecycleStatus=runId&&settledRunId===runId?settledStatus():statusBeforeCompaction;
      statusBeforeCompaction=undefined;
    }
    if(event.type==='message_end'){const ended=event.message,streamId=liveStreamId;queueMicrotask(()=>{if(disposed)return;const entry=session.sessionManager.getBranch().find(e=>e.type==='message'&&e.message===ended);if(ended.role==='assistant'&&entry)publish('stream.committed',{streamId,entryId:entry.id});publish('state',current());});}else if(['agent_settled','compaction_start','compaction_end'].includes(event.type))publish('state',current());
  });
  bus.on('friend-pi:v1:event',raw=>{
    publish('plugin',raw);
    if(!raw||typeof raw!=='object')return;
    const event=object(raw);
    if(event.pluginEvent==='expert.role.delivery'){const data=object(event.data);if(data.approved===false&&typeof data.runId==='string'){roleDeliveryErrors.set(data.runId,String(data.error||'角色交付合同未通过'));services.goals.deliveryFailure(services.context(),data,services.generation());}else if(typeof data.runId==='string')roleDeliveryErrors.delete(data.runId);return;}
    if(event.pluginEvent==='swarm.member-usage'){const data=object(event.data);services.account(typeof data.tokens==='number'?data.tokens:undefined,'member:'+String(data.memberId)+':'+String(data.entryId));return;}
    if(event.pluginEvent==='swarm.member-supplement'){const data=object(event.data);session.sessionManager.appendCustomEntry('friend-pi.swarm.supplement',{v:1,memberId:data.memberId,messageId:data.messageId,graphId:data.graphId});return;}
    if(event.pluginEvent==='swarm.member-request'){const data=object(event.data);services.enqueue('member-request:'+String(data.attemptId)+':'+digest(data.body),'队友提出补充讨论或返工建议。请读取 friend_swarm member.history 判断；如需修改，创建新的受控任务尝试并重新检查、复核。队友：'+String(data.memberId)+'；建议：'+String(data.body),{generation:services.generation(),runId});return;}
    if(event.pluginEvent==='swarm.member-event'){const data=object(event.data),native=object(data.event);if(!data.memberId&&native.type==='message_end'){const message=object(native.message),graph=swarmGraphs.get(String(data.graphId)),goal=services.currentGoal();if(message.role==='assistant'&&goal&&(graph?.goalId===goal.id||graph?.runId===goal.sourceRunId)){const usage=message.usage?object(message.usage):undefined;services.account(typeof usage?.totalTokens==='number'?usage.totalTokens:undefined,`member:${data.attemptId}:${message.timestamp}:${digest(message.content)}`);}}return;}
    if(event.pluginEvent==='team.result'){services.teamResult(object(event.data));return;}
    if(event.pluginEvent==='workflow.changed'){
      const data=object(event.data),wasRunning=workflowRunning;
      // Controllers publish both per-workflow changes and full snapshots.
      if(Array.isArray(data.workflows)){workflowStatuses.clear();for(const raw of data.workflows){const flow=object(raw);if(typeof flow.id==='string')workflowStatuses.set(flow.id,String(flow.status));}}
      else if(typeof data.workflowId==='string')workflowStatuses.set(data.workflowId,String(data.status));
      workflowRunning=[...workflowStatuses.values()].some(status=>['running','waiting_review'].includes(status));
      if(wasRunning&&!workflowRunning&&!stopping&&session.isIdle&&!rootExecutionBusy()){lifecycleStatus=settledStatus();foregroundOpen=finiteJobs();publishAuthorityNotice();}
      publish('state',current());return;
    }
    if(event.pluginEvent==='swarm.process'&&object(event.data).action==='closed'){void services.drain();return;}
    if(event.pluginEvent!=='swarm.changed'||!event.data||typeof event.data!=='object')return;
    const snapshot=object(event.data);teammateRunning=Array.isArray(snapshot.teammates)&&snapshot.teammates.map(object).some(member=>['running','stopping'].includes(String(member.state)));services.observeSwarm(snapshot);
    const graphs=Array.isArray(snapshot.graphs)?snapshot.graphs.map(object):[];
    for(const graph of graphs){
      const id=String(graph.id);swarmGraphs.set(id,graph);if(graph.audit===true)continue;
      // A snapshot is not evidence of execution. Relate new graphs to the open
      // foreground run, and old graphs only to an actual execution transition.
      if(foregroundOpen&&!baselineGraphIds.has(id)&&Date.parse(String(graph.createdAt))>=runStartedAt)runGraphIds.add(id);
      if(busyGraphStatuses.has(String(graph.status))&&(activeGraphIds.has(id)||pendingSwarmGraphIds.has(id)||foregroundOpen&&Date.parse(String(graph.updatedAt))>=runStartedAt))activeGraphIds.add(id);
    }
    auditRunning=graphs.some(graph=>graph.audit===true&&busyGraphStatuses.has(String(graph.status)));swarmRunning=[...activeGraphIds].some(id=>busyGraphStatuses.has(String(swarmGraphs.get(id)?.status)));
    if(!disposed){
      const authority=swarmAuthority();
      if(rootExecutionBusy())lifecycleStatus=authority?.status||'running';
      else if(!session.isStreaming&&activeGraphIds.size){lifecycleStatus=authority?.status||lifecycleStatus;foregroundOpen=false;publishAuthorityNotice(authority);}
    }
    publish('state',current());
  });
  await bind();const restoredGoal=services.currentGoal();if(!runId&&restoredGoal?.sourceRunId){runId=restoredGoal.sourceRunId;process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.parse(restoredGoal.createdAt);settledRunId=runId;}
  const policy=session.sessionManager.getBranch().findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.run.policy.v1'&&object(entry.data).v===1&&object(entry.data).runId===runId&&typeof object(entry.data).requiresSwarm==='boolean');
  if(policy?.type==='custom')runRequiresSwarm=object(policy.data).requiresSwarm as boolean;
  else if(runId&&restoredGoal&&restoredGoal.sourceRunId===runId)runRequiresSwarm=restoredGoal.mode==='swarm'&&!planMode;
  if(runId&&enabled.includes('swarm')&&(runRequiresSwarm===true||restoredGoal?.sourceRunId===runId)){
    // A cold controller need not emit swarm.changed. Restore only this run's
    // authority evidence, retaining a matching Goal's stricter ownership; reading a snapshot must not start or replay work.
    const snapshot=object(await requestPlugin(bus,'swarm','snapshot',{},1000));
    for(const raw of Array.isArray(snapshot.graphs)?snapshot.graphs:[]){const graph=object(raw);if(graph.sessionId!==session.sessionId||graph.runId!==runId||restoredGoal&&restoredGoal.sourceRunId===runId&&graph.goalId!==restoredGoal.id)continue;const id=String(graph.id);swarmGraphs.set(id,graph);if(graph.audit!==true)runGraphIds.add(id);}
  }
  await services.restore();if(enabled.includes('topic-rebuild')&&process.env.FRIEND_PI_CONTEXT_MODE)await requestPlugin(bus,'topic-rebuild','settings',{mode:process.env.FRIEND_PI_CONTEXT_MODE},1000,'user');output({type:'ready',state:current(),...await modelState(),piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit});
}
function readAttachment(path:string):{text?:string;image?:ImageContent}{
  const absolute=realpathSync(path);const bytes=readFileSync(absolute);if(bytes.length>10*1024*1024)throw new Error('附件超过 10 MiB，请缩小后再发送');
  const extension=extname(absolute).toLowerCase();const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  if(mime[extension]){if(!session.model?.input.includes('image'))throw new Error('当前型号不支持图片');return {image:{type:'image',data:bytes.toString('base64'),mimeType:mime[extension]}};}
  if(bytes.includes(0))throw new Error('附件不是可读取的文本或图片');return {text:`\n附件 ${absolute}：\n${bytes.toString('utf8')}`};
}
async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  if(disposed&&method!=='shutdown')throw new Error('会话已结束');
  if(session&&isSessionDeleted(dataDir,session.sessionId)&&method!=='shutdown')throw new Error('会话已删除');
  if(method==='state'){if(session.isIdle&&!swarmBusy()&&!finiteJobs()&&!stopping&&!['active','waiting','verifying'].includes(services.currentGoal()?.status||'')){await changeTracker?.settle(runId,lifecycleStatus,session.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id);await changeTracker?.flush();}return {...current(),...await modelState()};}
  if(method==='plan.read')return plans.current();
  if(method==='plan.revise'){if(!session.isIdle||swarmBusy()||stopping)throw new Error('请等待当前任务停止');return plans.submit(text(input.body,'计划'),{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});}
  if(method==='plan.approve'||method==='plan.reject'){
    if(!session.isIdle||swarmBusy()||stopping)throw new Error('请等待当前任务停止');
    if(method==='plan.approve'&&missingModelId)throw new Error('历史型号不可用，请重新配置并通过连接测试');
    if(method==='plan.approve'&&process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,session.model?`${session.model.provider}/${session.model.id}`:'');
    if(method==='plan.approve'){await applyAssignedRole(true);await ensureModelReady();}
    const plan=plans.decide(method==='plan.approve'?'approve':'reject',input,{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});session.sessionManager.appendCustomEntry('friend-pi.plan.decision',{plan,origin:'user'});
    if(method==='plan.reject'){planMode=false;publish('state',current());return current();}
    return await handle('send',{text:`执行用户已批准的计划，保持计划范围及检查标准。\n${plan.body}`,mode:plan.mode,planMode:false,runId:input.runId});
  }
  if(method==='send'){
    if(missingModelId)throw new Error('历史型号不可用，请重新配置并通过连接测试');
    if(stopping)throw new Error('正在停止，请等待终止回执');
    if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,session.model?`${session.model.provider}/${session.model.id}`:'');
    const prompt=typeof input.text==='string'?input.text:'';const attachments=Array.isArray(input.attachments)?input.attachments.map(raw=>readAttachment(text(object(raw).path))):[];if(prompt.trim()||!attachments.length)text(input.text,'消息');else if(input.text!==undefined&&typeof input.text!=='string')throw new Error('消息需要文本');
    const combined=prompt+attachments.map(item=>item.text||'').join('');if(Buffer.byteLength(combined)>128*1024)throw new Error('消息与文本附件过大，请分批发送');
    if(!session.model||!runtime.hasConfiguredAuth(session.model.provider))throw new Error('请先在模型设置配置供应商');
    const mode:ExecutionMode=['team','swarm'].includes(String(input.mode))?input.mode as ExecutionMode:'single';if(mode!=='single'&&!enabled.includes('swarm'))throw new Error('Swarm 插件已关闭');
    const goal=services.currentGoal();if(goal&&['active','waiting','verifying'].includes(goal.status)&&mode!==goal.mode)throw new Error('先暂停目标，再切换执行模式');
    const nextPlan=input.planMode===true;
    if((!session.isIdle||swarmBusy())&&(nextPlan!==planMode||mode!==executionMode))throw new Error('请先停止当前执行，再切换计划或协作方式');
    if(session.isIdle&&!swarmBusy()){await applyAssignedRole(true);await ensureModelReady();
      // Capture IDs before opening the run, so historical/manual unstarted graphs
      // cannot satisfy (or invalidate) this run's completion authority.
      const snapshot=enabled.includes('swarm')?object(await requestPlugin(bus,'swarm','snapshot',{},1000)):{};
      baselineGraphIds.clear();for(const graph of Array.isArray(snapshot.graphs)?snapshot.graphs:[])baselineGraphIds.add(String(object(graph).id));
      planMode=nextPlan;executionMode=mode;policyRevision++;runId=typeof input.runId==='string'?input.runId:randomUUID();process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();foregroundOpen=true;captureRunPolicy();await changeTracker?.begin(runId);
      activeGraphIds.clear();runGraphIds.clear();cancelRequested=false;authorityNotice='';
    }
    await applyAssignedRole();await ensureModelReady();lifecycleStatus='running';
    const images=attachments.flatMap(item=>item.image?[item.image]:[]);
    const inputRecord:PendingInput={id:randomUUID(),text:prompt,combinedLength:combined.length,combinedHash:digest(combined),imageHash:imageIdentity(images),expectsStart:session.isIdle,runId};pendingInputs.push(inputRecord);
    void session.prompt(combined,{images,streamingBehavior:input.inputMode==='steer'?'steer':'followUp'}).then(()=>{if(inputRecord.expectsStart){const position=pendingInputs.findIndex(input=>input.id===inputRecord.id);if(position>=0)pendingInputs.splice(position,1);}publish('state',current());}).catch(error=>{const position=pendingInputs.findIndex(input=>input.id===inputRecord.id);if(position>=0)pendingInputs.splice(position,1);foregroundOpen=rootExecutionBusy();lifecycleStatus='failed';publish('notice',{level:'error',message:publicError(error)});publish('state',current());});
    return {accepted:true,sessionId:session.sessionId,runId};
  }
  if(method==='runtime'){const action=text(input.action);if(['goal.create','goal.resume','goal.complete'].includes(action)){await applyAssignedRole(action==='goal.create');await ensureModelReady();}if(action==='goal.create'&&session.isIdle&&!swarmBusy()){const prior=services.currentGoal();if(prior&&['active','waiting','verifying'].includes(prior.status))throw new Error('当前已有运行目标');runId=randomUUID();process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();foregroundOpen=true;captureRunPolicy();await changeTracker?.begin(runId);baselineGraphIds.clear();for(const id of swarmGraphs.keys())baselineGraphIds.add(id);activeGraphIds.clear();runGraphIds.clear();cancelRequested=false;policyRevision++;}const result=await services.dispatch(action,object(input.input||{}),services.context('user'));if(!['snapshot','read','list','status','logs'].includes(action.split('.').at(-1)!))publish('state',current());return result;}
  if(method==='workflow.generate'){if(executionMode!=='swarm'||planMode||!session.isIdle)throw new Error('请在闲置 Swarm 执行模式生成工作流');await ensureModelReady();const result=await services.context('user').complete('只返回JSON，结构为 {v:1,title,goal,maxWorkers:4,nodes:[{id,title,prompt,dependencies:[],mode:"read"或"write",writeScopes:[最窄实际目录]}]}; 写入节点writeScopes非空，读取节点可省略。至多64节点，无脚本，条件用结构化谓词。目标：'+text(input.prompt),{maxTokens:6000});const body=result.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');return requestPlugin(bus,'workflow','create',{definition:object(JSON.parse(body))},1000,'user');}
  if(method==='stop'){
    cancelRequested=true;permissionEpoch++;stopping=true;cancelTerminalRequests();lifecycleStatus='stopping';publish('state',current());
    for(const [id,pending] of dialogs){clearTimeout(pending.timer);pending.resolve(undefined);publish('dialog.closed',{id});}dialogs.clear();
    try{const foregroundStop=session.abort();const runtimeStop=input.keepGoalState===true?Promise.resolve():services.stop();
    if(enabled.includes('swarm')){const workflows=object(await requestPlugin(bus,'workflow','snapshot',{},1000,'user'));for(const flow of Array.isArray(workflows.workflows)?workflows.workflows.map(object):[])if(['running','waiting_review'].includes(String(flow.status)))await requestPlugin(bus,'workflow','stop',{workflowId:flow.id},20000,'user');}
    if(!session.isIdle||swarmBusy()){cancelRequested=true;stopping=true;lifecycleStatus='stopping';publish('state',current());}
    await runtimeStop;
    if(enabled.includes('swarm')){const snapshot=object(await requestPlugin(bus,'swarm','snapshot',{},1000));for(const raw of Array.isArray(snapshot.graphs)?snapshot.graphs:[]){const graph=object(raw);if((activeGraphIds.has(String(graph.id))||pendingSwarmGraphIds.has(String(graph.id))||graph.audit===true||graph.runId===runId)&&(busyGraphStatuses.has(String(graph.status))||[...(Array.isArray(graph.attempts)?graph.attempts:[]),...(Array.isArray(graph.reviewAttempts)?graph.reviewAttempts:[])].some(raw=>['running','unknown'].includes(String(object(raw).status)))))await requestPlugin(bus,'swarm','stop',{graphId:graph.id},20000,'user');}await requestPlugin(bus,'swarm','stop.members',{},20000,'user');}
    statusBeforeCompaction=undefined;session.abortCompaction();await foregroundStop;const authority=swarmAuthority();lifecycleStatus=authority?.status==='interrupted'||authority?.status==='paused'?authority.status:'stopped';}catch(error){lifecycleStatus='interrupted';throw error;}finally{pendingInputs.length=0;stopping=false;publish('state',current());}return current();
  }
  if(method==='permission.confirm')return approvePermission({operation:text(input.operation),message:text(input.message),autoEligible:input.autoEligible===true,requireExplicit:input.requireExplicit===true,writePath:typeof input.writePath==='string'?input.writePath:undefined},typeof input.terminalRequestId==='string'?input.terminalRequestId:undefined);
  if(method==='configure'){
    if(!session.isIdle||swarmBusy()||stopping)throw new Error('请等待当前执行停止，再修改配置');
    const nextPermission=input.permissionMode===undefined?permissionMode:parsePermissionMode(input.permissionMode);
    if(nextPermission!==permissionMode&&(services.jobs.pendingCount(session.sessionId)>0||dialogs.size>0))throw new Error('请先结束待批准的命令，再切换权限策略');
    if(input.executionMode!==undefined){const goal=services.currentGoal();if(goal&&['active','waiting','verifying'].includes(goal.status)&&input.executionMode!==goal.mode)throw new Error('先暂停目标，再切换执行模式');if(!['single','team','swarm'].includes(String(input.executionMode)))throw new Error('协作方式无效');if(input.executionMode!=='single'&&!enabled.includes('swarm'))throw new Error('协作需要启用Swarm插件');executionMode=input.executionMode as ExecutionMode;policyRevision++;}
    const nextModel=typeof input.modelId==='string'&&input.modelId?selectedModel(input.modelId):session.model;const supported=providerMetadata(runtime).models.find(model=>model.id===(nextModel?`${nextModel.provider}/${nextModel.id}`:''))?.thinkingLevels||['off'];if(input.thinkingLevel&&!supported.includes(String(input.thinkingLevel)))throw new Error('当前模型不支持此思考等级');if(input.plugins!==undefined&&(!Array.isArray(input.plugins)||input.plugins.some(name=>!plugins.includes(String(name)))))throw new Error('插件无效');const nextPlugins=Array.isArray(input.plugins)?input.plugins.map(String):enabled;if(input.contextMode&&!['native','infinite'].includes(String(input.contextMode)))throw new Error('上下文模式无效');if(input.contextMode==='infinite'&&!nextPlugins.includes('topic-rebuild'))throw new Error('无限上下文需要启用 Topic & ReBuild');
    if(nextPermission!==permissionMode){permissionMode=nextPermission;permissionEpoch++;policyRevision++;session.sessionManager.appendCustomEntry('friend-pi.permission.configured',{v:1,mode:permissionMode,origin:'user'});}
    if(input.modelId){await session.setModel(selectedModel(text(input.modelId)));missingModelId=undefined;delete process.env.FRIEND_PI_DESKTOP_MODEL_UNAVAILABLE;}
    if(input.thinkingLevel){const level=text(input.thinkingLevel);if(!session.getAvailableThinkingLevels().includes(level as ThinkingLevel))throw new Error('当前模型不支持此思考等级');session.setThinkingLevel(level as ThinkingLevel);}
    if(Array.isArray(input.plugins)){
      const next=input.plugins.map(String);if(next.some(name=>!plugins.includes(name)))throw new Error('插件无效');
      if(JSON.stringify(enabled)!==JSON.stringify(next)){enabled=next;session.settingsManager.setExtensionPaths(next.map(name=>join(root,'packages',name,'dist','index.js')));await session.reload();await bind();}
    }
    if(input.contextMode){if(!['native','infinite'].includes(String(input.contextMode)))throw new Error('上下文模式无效');if(!enabled.includes('topic-rebuild')&&input.contextMode==='infinite')throw new Error('无限上下文需要启用 Topic & ReBuild');if(enabled.includes('topic-rebuild'))await requestPlugin(bus,'topic-rebuild','settings',{mode:input.contextMode},1000,'user');process.env.FRIEND_PI_CONTEXT_MODE=String(input.contextMode);}
    return current();
  }
  if(method==='plugin'){
    const plugin=text(input.plugin);if(!enabled.includes(plugin)&&!(['team','workflow'].includes(plugin)&&enabled.includes('swarm')))throw new Error('插件不可用，当前会话已关闭它');const action=text(input.action);if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'&&['prepare','start','resume','delegate','review','integrate','rework','validate','validation.run','generate','reflect','learn','member.resume'].includes(action))await requireReadyModel(runtime,dataDir,missingModelId||(session.model?`${session.model.provider}/${session.model.id}`:''));const args=object(input.input||{});if(plugin==='swarm'&&action==='member.resume'&&!stopping){const goal=services.currentGoal();if(goal?.tokenBudget!==undefined&&(!goal.usageAvailable||goal.tokens>=goal.tokenBudget))throw new Error('目标预算耗尽或使用量不可核实，请先处理预算');const admission=object(await requestPlugin(bus,'swarm','member.history',{memberId:args.memberId},1000,'user'));const member=object(admission.member);if(!['idle','paused'].includes(String(member.state))||member.state==='paused'&&object(member.stopReceipt).status!=='terminated')throw new Error('成员尚无明确退出收据');cancelRequested=false;}
    if(['team','workflow','swarm'].includes(plugin)&&['delegate','start','resume'].includes(action)&&(!runId||plugin==='workflow'&&action==='start'&&session.isIdle&&!swarmBusy()&&!finiteJobs()&&!stopping)){
      await applyAssignedRole(true);await ensureModelReady();const snapshot=object(await requestPlugin(bus,'swarm','snapshot',{},1000));
      baselineGraphIds.clear();for(const graph of Array.isArray(snapshot.graphs)?snapshot.graphs:[])baselineGraphIds.add(String(object(graph).id));
      activeGraphIds.clear();runGraphIds.clear();authorityNotice='';runId=randomUUID();process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();foregroundOpen=true;cancelRequested=false;policyRevision++;captureRunPolicy();await changeTracker?.begin(runId);
    }
    if(['team','workflow','swarm'].includes(plugin)&&['delegate','start','resume'].includes(action)&&runId){await changeTracker?.ensure(runId);changeTracker?.reopen(runId);}
    const graphId=['swarm','team'].includes(plugin)&&swarmExecutionActions.has(action)&&typeof args.graphId==='string'?args.graphId:undefined;
    if(graphId)pendingSwarmGraphIds.add(graphId);
    try{if(stopping&&!['stop','snapshot','list','read','status','result','logs','member.history','member.list','member.send','member.interrupt'].includes(action))throw new Error('正在停止，不能开始新操作');let result=await requestPlugin(bus,plugin,action,args,120000,'user');if(plugin==='swarm'&&action==='member.history'){const history=object(result);result={...history,inbox:history.messages,messages:projectTeammateMessages(Array.isArray(history.entries)?history.entries:[],Array.isArray(history.messages)?history.messages:[],String(object(history.member).name))};delete (result as Record<string,unknown>).entries;}if(result&&typeof result==='object'&&'id' in result&&['team','workflow','swarm'].includes(plugin)&&['start','resume','delegate'].includes(action)){const id=plugin==='workflow'?object(result).graphId:object(result).id;if(typeof id==='string'){activeGraphIds.add(id);if(plugin==='workflow')runGraphIds.add(id);}swarmRunning=[...activeGraphIds].some(key=>busyGraphStatuses.has(String(swarmGraphs.get(key)?.status)));publish('state',current());}return result;}
    finally{if(graphId){pendingSwarmGraphIds.delete(graphId);swarmRunning=[...activeGraphIds].some(id=>busyGraphStatuses.has(String(swarmGraphs.get(id)?.status)));if(!session.isStreaming&&activeGraphIds.has(graphId)){lifecycleStatus=settledStatus();publishAuthorityNotice();}publish('state',current());}}
  }
  if(method==='dialog.respond'){
    const pending=dialogs.get(text(input.id));if(!pending)throw new Error('交互已结束');clearTimeout(pending.timer);dialogs.delete(String(input.id));pending.resolve(input.cancelled?undefined:input.confirmed!==undefined?Boolean(input.confirmed):input.value);return {ok:true};
  }
  if(method==='provider.save'||method==='provider.refresh'){
    if(!session.isIdle||swarmBusy())throw new Error('请先停止当前执行，再修改供应商配置');
    const provider=method==='provider.save'?await saveProviderConfiguration(runtime,dataDir,input):typeof input.provider==='string'?input.provider:undefined;await runtime.refresh({allowNetwork:false});
    if(method==='provider.save'&&process.env.FRIEND_PI_DESKTOP_MANAGED!=='1'){await session.setModel(selectedModel(String(provider)+'/'+text(input.modelId)));}else if(session.model){const latest=runtime.getModel(session.model.provider,session.model.id);if(latest)await session.setModel(latest);}
    return {...current(),...await modelState()};
  }
  if(method==='rename'){session.setSessionName(text(input.name,'名称',200));return current();}
  if(method==='shutdown'){await shutdown();return {ok:true};}
  throw new Error(`未知操作：${method}`);
}
function publicError(error:unknown):string{return (error instanceof Error?error.message:String(error)).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[密钥已隐藏]');}
async function shutdown(){if(disposed)return;if(session)services.beforeQuit();cancelTerminalRequests();if(session&&!session.isIdle||swarmBusy())lifecycleStatus='interrupted';disposed=true;for(const pending of dialogs.values()){clearTimeout(pending.timer);pending.resolve(undefined);}dialogs.clear();session?.abortCompaction();await session?.abort();await changeTracker?.settle(runId,lifecycleStatus,session?.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id);await changeTracker?.flush();if(session)await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session?.dispose();services.dispose();businessStore.close();bus.clear();}
process.on('message',raw=>{if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.type==='terminal.waiting'||request.type==='terminal.admitted'){const id=String(request.id),pending=terminalRequests.get(id);if(pending&&(request.type==='terminal.admitted'&&pending.phase!=='admitted'||request.type==='terminal.waiting'&&pending.phase==='transport')){clearTimeout(pending.timer);pending.phase=request.type==='terminal.waiting'?'waiting':'admitted';pending.timer=terminalDeadline(id,pending.phase==='waiting'?125000:25000);}return;}if(request.type==='terminal.response'){const pending=terminalRequests.get(String(request.id));if(pending){pending.cleanup();terminalRequests.delete(String(request.id));request.error?pending.reject(new Error(String(request.error))):pending.resolve(request.result);}return;}if(request.type!=='request')return;void handle(text(request.method),object(request.input||{})).then(result=>{output({type:'response',id:request.id,result},request.method==='shutdown'?()=>process.disconnect?.():undefined);}).catch(error=>output({type:'response',id:request.id,error:publicError(error)}));});
process.on('disconnect',()=>{void shutdown();});
async function initializeSupervised(){if(process.env.FRIEND_PI_SUPERVISED==='1')await new Promise<void>(resolveReady=>{const ready=(raw:unknown)=>{if(raw&&typeof raw==='object'&&object(raw).type==='supervisor.ready'){process.off('message',ready);resolveReady();}};process.on('message',ready);output({type:'supervisor.await'});});await initialize();}
void initializeSupervised().catch(error=>{output({type:'fatal',error:publicError(error)});process.exitCode=1;setImmediate(()=>process.disconnect?.());});
