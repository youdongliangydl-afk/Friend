import {questionBatch,questionAnswers,type QuestionBatchDialog,type QuestionBatchResult} from './question-batch.js';
import {createDocumentReader} from './document-reader.js';
const documentReader=createDocumentReader();
import {createExternalCapabilities,nativeMcpResourceTools} from './external-capabilities.js';
const documentAttachments=new Map<string,string>();
import {captureDocumentInput,validateCapturedInput} from './attachment-input.js';
import {documentTools} from './document-tools.js';
import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,writeFileSync,existsSync,readFileSync,realpathSync,openSync,closeSync } from 'node:fs';
import { join,resolve,relative } from 'node:path';
import { createAgentSession,createBashToolDefinition,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,createEventBus,initTheme,type AgentSession,type ExtensionUIContext,type ExtensionFactory,type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { SourcePolicy,sourceFactRefs,isDerivedCapabilityInput,modelTokenUsage,type ArtifactRef,type EvidenceReceipt,shellEnvironment,dataDirectory,object,text,visibleText,historyItems,requestPlugin,atomicWrite,installFixtureProvider,RecordStore,projectIdentity,digest,isSessionDeleted,makeContext,type ExecutionMode,type HostPolicy,parsePermissionMode,permissionDecision,toolPermissionRequest,temporaryPermission,temporaryPermissionMatches,type PermissionMode,type PermissionRequest,type WakeFrame } from '@friend-pi/core';
import {Type} from 'typebox';
import {RuntimeController} from './runtime-controller.js';
import {PlanStore} from './plan-store.js';
import {MessageQueue,type InputPayload,type QueuedInput} from './message-queue.js';
import {TODO_TYPE,SIDECHAT_TYPE,todoItems,projectTodo,ownedEntries,stableForkLeaf} from './task-todo.js';
import {providerSystems,projectMessages,projectTeammateMessages,projectTraceSystems,traceJSON} from './message-projection.js';
import {RunChangesTracker,projectRunChanges,RUN_CHANGES_TYPE} from './run-changes.js';
import {SessionMetricRecorder,projectSessionMonitor,SESSION_METRIC_TYPE} from './session-monitor.js';
import {guardDesktopModelRequests,customInstructionsExtension} from '@friend-pi/core';
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
const dialogs=new Map<string,{resolve:(value:unknown)=>void;timer?:ReturnType<typeof setTimeout>;terminalRequestId?:string;batch?:QuestionBatchDialog;cleanup?():void}>();
const foregroundStore=new RecordStore('runtime',dataDir),artifactStore=new RecordStore('artifacts',dataDir);
function recordForeground(force?:boolean){if(disposed||!session)return;foregroundStore.put(`foreground:${session.sessionId}`,{pid:process.pid,active:force??(!session.isIdle||modelInFlight||rootExecutionBusy()),runId,expiresAt:Date.now()+15000});}
const foregroundPulse=setInterval(()=>recordForeground(),5000);foregroundPulse.unref();
const businessStore=new RecordStore('plans',dataDir);let plans:PlanStore;let policyRevision=0;let modelInFlight=false;let auditRunning=false;let workflowRunning=false;let teammateRunning=false;const neutralToolIds=new Set<string>();const roleDeliveryErrors=new Map<string,string>();const workflowStatuses=new Map<string,string>();
const external=createExternalCapabilities({dataDir,cwd,confirm:request=>approvePermission(request),publish:()=>{if(session&&!disposed)publish('state',current());}});
const services=new RuntimeController(dataDir,{admitUserInput:admitQueuedInput,publish:(event,data)=>{publish(event==='runtime.process'?'plugin':event,event==='runtime.process'?{v:1,pluginEvent:event,data}:data);if(session&&!disposed)publish('state',current());},busy:()=>swarmBusy(),mode:()=>executionMode,planMode:()=>planMode,runId:()=>runId,modelId:()=>session?.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:()=>session?.thinkingLevel||'off',haltExecution:async origin=>{const stop=()=>handle('stop',{keepGoalState:true}).then(()=>{}).catch(error=>publish('notice',{level:'error',message:publicError(error)}));if(origin==='user')await stop();else setImmediate(()=>void stop());},sendWake:sendRuntimeWake,prepareWake:prepareRuntimeWake});
function runtimeState(){try{return services.snapshot();}catch{return undefined;}}
function finiteJobs(){try{return services.jobs.hasFinite(services.context(),runId);}catch{return false;}}
async function applyAssignedRole(forNewRun=false){if(!enabled.includes('expert'))return;const snap=object(await requestPlugin(bus,'expert','role.snapshot',{},1000));const selection=snap.selection&&typeof snap.selection==='object'?object(snap.selection):{};const current=snap.current&&typeof snap.current==='object'?object(snap.current):undefined,phase=snap.phase&&typeof snap.phase==='object'?object(snap.phase):{};const sameRun=!forNewRun&&phase.runId===runId;const role=sameRun?current:(Array.isArray(snap.roles)?snap.roles.map(object):[]).find(item=>item.id===selection.id);if(role?.modelId&&(!sameRun||role.modelSource!=='inherited')){const id=String(role.modelId);if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,id);else if(!runtime.hasConfiguredAuth(selectedModel(id).provider))throw new Error('角色指定模型未配置认证');if(`${session.model?.provider}/${session.model?.id}`!==id)await session.setModel(selectedModel(id));}if(role?.thinkingLevel&&(!sameRun||role.thinkingSource!=='inherited')){if(!session.getAvailableThinkingLevels().includes(String(role.thinkingLevel) as ThinkingLevel))throw new Error('角色指定思考等级不可用');session.setThinkingLevel(String(role.thinkingLevel) as ThinkingLevel);}}
interface PendingInput {background?:boolean;attachmentMetadata?:Record<string,unknown>[];queueId?:string;id:string;text:string;combinedLength:number;combinedHash:string;imageHash:string;expectsStart:boolean;preflightStarted?:boolean;automatic?:boolean;memberContinuation?:boolean;nativeMessage?:unknown;runId?:string}
const pendingInputs:PendingInput[]=[];let startedInputId:string|undefined;let stopping=false;
let authorisedCorrectionResume:{runId:string;generation:number}|undefined;
const correctionPauseReason='只读协作核验已保留；原目标需用户明确接续，未自动重放执行';
function correctedRun(owner=runId){return !!owner&&session.sessionManager.getBranch().some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.swarm.correction.v1'&&object(entry.data).runId===owner);}
function freshCorrection(frame:WakeFrame){return correctionEligibleRun===frame.runId&&correctionEligibleGeneration===frame.generation;}
function skipRuntimeWake(frame:Pick<WakeFrame,'id'|'generation'|'runId'>,reason:string){
 if(!session.sessionManager.getBranch().some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.runtime-wake.skipped'&&object(entry.data).eventId===frame.id))session.sessionManager.appendCustomEntry('friend-pi.runtime-wake.skipped',{v:1,eventId:frame.id,generation:frame.generation,runId:frame.runId,status:'not-run',reason});
}
function runtimeWakeAllowed(frame:WakeFrame){
 const initial=frame.id.startsWith('swarm-correction:'),owner=frame.runId||runId;
 if(initial?freshCorrection(frame):!correctedRun(owner)||authorisedCorrectionResume&&authorisedCorrectionResume.runId===owner&&authorisedCorrectionResume.generation===frame.generation)return true;
 // A read-only verification must not turn a member/goal/job result into renewed execution.
 skipRuntimeWake({...frame,runId:owner},initial?'stale-correction':'correction-verification-only');
 const goal=services.currentGoal();if(goal&&goal.sourceRunId===owner&&['active','waiting'].includes(goal.status)){services.goals.setState('paused',services.context(),correctionPauseReason);lifecycleStatus='paused';foregroundOpen=false;publish('state',current());}
 return false;
}
async function prepareRuntimeWake(frame:WakeFrame){
 const correction=frame.id.startsWith('swarm-correction:'),wakeGeneration=frame.generation,wakeEpoch=queueEpoch;
 if(!runtimeWakeAllowed(frame))return;
 let wakeRunId=frame.runId||runId;
 const owns=()=>!disposed&&!stopping&&(!correction||!cancelRequested)&&wakeEpoch===queueEpoch&&wakeGeneration===services.generation()&&(!wakeRunId||wakeRunId===runId);
 const assertOwned=()=>{if(!owns())throw new Error('接续已取消');};
 try{
  assertOwned();if(memberBudgetWait())throw new Error(memberBudgetWait());
  if(!runId){runId=wakeRunId||randomUUID();wakeRunId=runId;process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();captureRunPolicy(frame.id.startsWith('member-request:')?false:undefined);}
  const goal=services.currentGoal();if(frame.id.startsWith('resume:')&&goal)captureRunPolicy(goal.mode==='swarm'&&!planMode);
  await changeTracker?.ensure(runId);assertOwned();
  foregroundOpen=true;cancelRequested=false;lifecycleStatus='running';policyRevision++;
  await applyAssignedRole();assertOwned();await ensureModelReady();assertOwned();
 }catch(error){if(correction&&owns()){swarmCorrectionPending=false;swarmCorrectionActive=false;lifecycleStatus='failed';}throw error;}
}
async function sendRuntimeWake(frame:WakeFrame){
 const correction=frame.id.startsWith('swarm-correction:'),wakeEpoch=queueEpoch;
 if(!runtimeWakeAllowed(frame))return;
 const owns=()=>!disposed&&!stopping&&!cancelRequested&&wakeEpoch===queueEpoch&&frame.generation===services.generation()&&(!frame.runId||frame.runId===runId);
 let input:PendingInput|undefined,started=false;
 try{
  await new Promise<void>(done=>setImmediate(done));if(!owns()||frame.goalId&&services.currentGoal()?.status!=='active'&&services.currentGoal()?.status!=='waiting')return;
  await ensureModelReady();if(!owns())return;
  if(correction){swarmCorrectionPending=false;swarmCorrectionActive=true;}
  input={id:randomUUID(),text:frame.message,combinedLength:frame.message.length,combinedHash:digest(frame.message),imageHash:imageIdentity([]),expectsStart:true,automatic:true,background:correction,memberContinuation:frame.id.startsWith('member-request:'),runId};pendingInputs.push(input);
  session.sessionManager.appendCustomEntry('friend-pi.runtime-wake',{v:1,eventId:frame.id,generation:frame.generation,goalId:frame.goalId});
  await session.prompt(frame.message,{expandPromptTemplates:false,preflightResult:result=>{if(!owns())throw new Error('接续已取消');if(result==='started')started=true;}});
 }catch(error){if(correction&&owns()){swarmCorrectionPending=false;swarmCorrectionActive=false;lifecycleStatus='failed';publish('state',current());}throw error;
 }finally{
  if(input){const position=pendingInputs.indexOf(input);if(position>=0)pendingInputs.splice(position,1);}
  if(correction&&owns()){swarmCorrectionPending=false;swarmCorrectionActive=false;if(!started){lifecycleStatus=settledStatus();publishAuthorityNotice();publish('state',current());}}
 }
}
let inputQueue:MessageQueue;let queueDriving=false;let queueEpoch=0;let queueResumeAuthorised=false;let queueRestoring:Promise<boolean>|undefined;
interface GoalSuspension {id:string;revision:number;sourceRunId?:string;objective:string;mode:ExecutionMode;planMode:boolean;modelId:string;thinkingLevel:ThinkingLevel}
const suspensionKey=()=>`suspension:${session.sessionId}`;
function cancelQueueResume(){inputQueue?.store.remove(suspensionKey());}
function queueState(){if(!inputQueue)return undefined;const value=inputQueue.snapshot(),suspended=inputQueue.store.get<GoalSuspension>(suspensionKey())?.value;return {...value,suspendedGoal:suspended?{objective:suspended.objective}:undefined};}
function queueChanged(){publish('state',current());if(!disposed)setImmediate(()=>void services.drain());}
async function admitQueuedInput():Promise<boolean>{
 if(!inputQueue||disposed||queueDriving||stopping)return queueDriving;
 if(swarmCorrectionPending)return false;
 const snapshot=inputQueue.snapshot(),suspended=inputQueue.store.get<GoalSuspension>(suspensionKey())?.value;
 if(snapshot.paused)return !!suspended;
 if(!session.isIdle||swarmBusy()||finiteJobs()||!services.safeObjects()||lifecycleStatus==='rebuilding')return snapshot.items.length>0;
 queueDriving=true;
 try{
  const admissionEpoch=queueEpoch;const head=snapshot.items[0];
  if(head){
   if(head.state!=='queued')return true;
   if(!queueResumeAuthorised&&['failed','interrupted','stopped','paused'].includes(lifecycleStatus)){inputQueue.pause(true);queueChanged();return true;}
   const focused=services.currentGoal();if(focused&&['completed','stopped'].includes(focused.status))services.goals.store.remove(`focus:${session.sessionId}`);
   if(suspended&&focused&&['active','waiting','verifying'].includes(focused.status)){cancelQueueResume();inputQueue.pause(true);publish('notice',{level:'warning',message:'新目标已取代原目标的自动恢复，请处理当前目标后恢复队列'});queueChanged();return true;}
   const held=services.suspendForQueuedInput();if(held)inputQueue.store.put(suspensionKey(),{...held,mode:executionMode,planMode,modelId:`${session.model!.provider}/${session.model!.id}`,thinkingLevel:session.thinkingLevel} satisfies GoalSuspension);
   await changeTracker?.settle(runId,lifecycleStatus,session.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id);await changeTracker?.flush();
   const latest=inputQueue.snapshot();if(admissionEpoch!==queueEpoch||latest.paused||stopping||latest.items[0]?.id!==head.id||latest.items[0]?.revision!==head.revision)return true;
   const item=inputQueue.claim(head.id,head.revision,randomUUID());queueResumeAuthorised=false;queueChanged();
   queueRestoring=handle('send',{payload:item,queueId:item.id,admissionEpoch,runId:item.runId,mode:item.mode,planMode:item.planMode}).then(()=>true);try{await queueRestoring;}catch(error){inputQueue.failed(item.id);queueChanged();throw error;}finally{queueRestoring=undefined;}return true;
  }
  if(suspended){
   const goal=services.goals.read(suspended.id,services.context());
   if(goal.status!=='paused'||goal.revision!==suspended.revision||!suspended.sourceRunId){cancelQueueResume();return false;}
   const focused=services.currentGoal();
   const incompleteGoal=focused&&focused.id!==goal.id&&!['completed','stopped'].includes(focused.status);
   const independentRun=runId!==suspended.sourceRunId;
   const incompleteTask=independentRun&&services.tasks.list(services.context()).some(task=>task.runId===runId&&task.status!=='completed');
   const incompleteGraph=independentRun&&[...swarmGraphs.values()].some(graph=>graph.runId===runId&&graph.audit!==true&&!['integrated','completed'].includes(String(graph.status)));
   if(incompleteGoal||incompleteTask||incompleteGraph||independentRun&&!queueResumeAuthorised&&lifecycleStatus!=='completed'){inputQueue.pause(true);queueChanged();return true;}
   if(goal.tokenBudget!==undefined&&(!goal.usageAvailable||goal.tokens>=goal.tokenBudget))throw new Error('原目标预算需要处理，未自动恢复');
   if(goal.sessionId!==session.sessionId)throw new Error('原目标不属于当前会话');
   const valid=()=>{const marker=inputQueue.store.get<GoalSuspension>(suspensionKey())?.value,currentGoal=services.goals.read(goal.id,services.context());return admissionEpoch===queueEpoch&&!stopping&&!disposed&&!inputQueue.snapshot().paused&&!inputQueue.snapshot().items.length&&marker?.id===goal.id&&marker.revision===goal.revision&&currentGoal.status==='paused'&&currentGoal.revision===goal.revision;};
   queueRestoring=(async()=>{
   await changeTracker?.settle(runId,lifecycleStatus,session.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id);await changeTracker?.flush();
   const snapshot=enabled.includes('swarm')?object(await requestPlugin(bus,'swarm','snapshot',{},1000)):{};
   await changeTracker?.ensure(suspended.sourceRunId!);
   if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,suspended.modelId);
   if(!valid())return true;
   const previousModel=session.model,previousThinking=session.thinkingLevel;
   await session.setModel(selectedModel(suspended.modelId));
   // Manual mutations wait for this restoration to retire. If cancelled during
   // the SDK's async model change, restore B before applying the user's change.
   if(!valid()){if(previousModel)await session.setModel(previousModel);session.setThinkingLevel(previousThinking);return true;}
   session.setThinkingLevel(suspended.thinkingLevel);executionMode=suspended.mode;planMode=suspended.planMode;
   runId=suspended.sourceRunId;process.env.FRIEND_PI_RUN_ID=runId;settledRunId=runId;cancelRequested=false;authorityNotice='';activeGraphIds.clear();runGraphIds.clear();baselineGraphIds.clear();
   const nativePolicy=ownedEntries(session.sessionManager.getBranch()).findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.run.policy.v1'&&object(entry.data).runId===runId);
   runRequiresSwarm=nativePolicy?.type==='custom'?object(nativePolicy.data).requiresSwarm===true:goal.mode==='swarm';
   for(const raw of Array.isArray(snapshot.graphs)?snapshot.graphs:[]){const graph=object(raw);if(graph.sessionId===session.sessionId&&graph.runId===runId&&graph.audit!==true){swarmGraphs.set(String(graph.id),graph);runGraphIds.add(String(graph.id));}}
   services.goals.store.put(`focus:${session.sessionId}`,goal.id);
   if(correctedRun(runId)){skipRuntimeWake({id:`queue-resume:${goal.id}:${goal.revision}`,generation:services.generation(),runId},'correction-verification-only');services.goals.setState('paused',services.context(),correctionPauseReason);cancelQueueResume();queueResumeAuthorised=false;lifecycleStatus='paused';foregroundOpen=false;queueChanged();return false;}
   await services.dispatch('goal.resume',{goalId:goal.id},services.context('user'));cancelQueueResume();queueResumeAuthorised=false;lifecycleStatus='running';queueChanged();return false;
   })();try{return await queueRestoring;}finally{queueRestoring=undefined;}
  }
  return false;
 }catch(error){inputQueue.pause(true);publish('notice',{level:'error',message:publicError(error)});publish('state',current());return true;}finally{queueDriving=false;}
}
function imageIdentity(images:readonly unknown[]){return digest(JSON.stringify(images.map(raw=>{const image=object(raw);return [image.mimeType,image.data];})));}
function output(message:unknown,flushed?:()=>void){if(process.connected){if(flushed)process.send?.(message,flushed);else process.send?.(message);}else flushed?.();}
function publish(type:string,data:unknown){if(type==='state'&&!object(data).isRunning&&!disposed&&!['active','waiting','verifying'].includes(services.currentGoal()?.status||''))void changeTracker?.settle(runId,lifecycleStatus,session?.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id).catch(error=>publish('notice',{level:'warning',message:publicError(error)}));output({type:'event',event:{type,sessionId:session?.sessionId,runId,data}});}
function dialog(kind:string,title:string,input:Record<string,unknown>={},timeout=60000,terminalRequestId?:string):Promise<unknown>{
  const id=randomUUID();return new Promise(resolveResult=>{const timer=setTimeout(()=>{dialogs.delete(id);resolveResult(undefined);publish('dialog.closed',{id});},timeout);dialogs.set(id,{resolve:resolveResult,timer,terminalRequestId});publish('dialog',{id,kind,title,...input,expiresAt:Date.now()+timeout});});
}
const busyGraphStatuses=new Set(['running','awaiting_review','ready','stopping']);
const swarmExecutionActions=new Set(['start','resume','prepare','review','integrate','rework']);
function memberBudgetWait(){const goal=services.currentGoal();return goal?.tokenBudget!==undefined&&(!goal.usageAvailable||goal.tokens>=goal.tokenBudget)?'目标预算耗尽或使用量不可核实，补充已保存，请先处理预算':undefined;}
function rootExecutionBusy(){return swarmRunning||auditRunning||workflowRunning||pendingSwarmGraphIds.size>0||swarmCorrectionPending||swarmCorrectionActive;}
function swarmBusy(){return rootExecutionBusy()||teammateRunning;}
function captureRunPolicy(requiresSwarm=executionMode==='swarm'&&!planMode){runRequiresSwarm=requiresSwarm;session.sessionManager.appendCustomEntry('friend-pi.run.policy.v1',{v:1,runId,mode:executionMode,planMode,requiresSwarm});}
let missingModelId:string|undefined;
let correctionEligibleRun:string|undefined,correctionEligibleGeneration:number|undefined,swarmCorrectionPending=false,swarmCorrectionActive=false;
function correctMissingSwarm(){
 const last=[...session.messages].reverse().find(message=>message.role==='assistant');
 const goal=services.currentGoal();
 if(!runId||correctionEligibleRun!==runId||correctionEligibleGeneration!==services.generation()||runRequiresSwarm!==true||executionMode!=='swarm'||planMode||cancelRequested||stopping||disposed||rootExecutionBusy()||runGraphIds.size||activeGraphIds.size||finiteJobs()||!services.safeObjects()||memberBudgetWait()||roleDeliveryErrors.has(runId)||last?.stopReason!=='stop'||goal&&(!['active','waiting'].includes(goal.status)||goal.waitFor==='user-acceptance'))return false;
 if(session.sessionManager.getBranch().some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.swarm.correction.v1'&&object(entry.data).runId===runId))return false;
 const id='swarm-correction:'+runId,generation=services.generation();
 session.sessionManager.appendCustomEntry('friend-pi.swarm.correction.v1',{v:1,runId,generation,id});
 swarmCorrectionPending=true;
 const added=services.enqueue(id,'用户已选择 Swarm。本轮尚未建立任务图，请在后台补全协作核验，不要求用户处理。不要重放已完成工具或修改文件。使用 friend_swarm create，明确 checks:[]，所有 tasks.mode="read"，不提供 contract，创建最小只读图核验当前已有成果与原用户目标；随后 start。若成果有缺口，如实报告，不把核验等同于已完成原目标。不要运行命令、修改目标或重新执行写入。',{generation,runId});
 if(!added){swarmCorrectionPending=false;return false;}return true;
}
function current(){const entries=session.sessionManager.getBranch(),owned=ownedEntries(entries),sdkStats=session.getSessionStats(),context=sdkStats.contextUsage;return {todo:projectTodo(entries,runId),queue:queueState(),sideDraft:inputQueue?.store.get<InputPayload>(`draft:${session.sessionId}`)?.value,monitor:projectSessionMonitor(session.sessionManager.getEntries(),sdkStats,context),sessionId:session.sessionId,messages:projectMessages(entries),changes:projectRunChanges(owned),traceSystems:projectTraceSystems(entries),receipts:entries.filter(entry=>entry.type==='custom'&&/friend-pi\.(?:memory|expert|attachments)/.test(entry.customType)),plan:plans?.current(),lifecycleStatus,isRunning:!session.isIdle||swarmBusy()||finiteJobs()||stopping,runtime:runtimeState(),navigationLocked:!session.isIdle||swarmBusy()||stopping,permissionEpoch,planMode,permissionMode,executionMode,modelId:missingModelId||(session.model?`${session.model.provider}/${session.model.id}`:undefined),thinkingLevel:session.thinkingLevel,thinkingLevels:session.getAvailableThinkingLevels(),plugins:enabled,context,sessionFile:session.sessionFile,runId};}
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
async function registerAttachmentArtifact(path:string,image=false,expectedHash?:string){
 const projectId=projectIdentity(cwd),cacheKey=expectedHash?`source-version:${digest([projectId,path,expectedHash])}`:undefined,cached=cacheKey?artifactStore.get<{ref:ArtifactRef}>(cacheKey)?.value:undefined;if(cached){try{const policy=new SourcePolicy(artifactStore),record=policy.artifact(cached.ref,projectId);policy.registerArtifact({...record,owners:[...new Set([...(record.owners||[]),session.sessionId])]});return cached.ref;}catch{/* Explicit new attachment input must be checked again if its old grant was withdrawn. */}}const bytes=readFileSync(path),sha256=createHash('sha256').update(bytes).digest('hex'),artifactId=digest([projectId,realpathSync(path)]),key=`head:${projectId}:${artifactId}`,old=artifactStore.get<{ref:ArtifactRef}>(key)?.value;if(old?.ref.sha256===sha256){try{const policy=new SourcePolicy(artifactStore),record=policy.artifact(old.ref,projectId);policy.registerArtifact({...record,owners:[...new Set([...(record.owners||[]),session.sessionId])]});if(cacheKey)artifactStore.put(cacheKey,{ref:old.ref});return old.ref;}catch{/* A new authorized source receives a new version instead of reviving a withdrawn owner. */}}
 const document=image?undefined:await documentReader.read(path);if(expectedHash&&(image?digest(bytes.toString('base64'))!==expectedHash:document?.hash!==expectedHash&&document?.legacyHash!==expectedHash)||createHash('sha256').update(readFileSync(path)).digest('hex')!==sha256)throw new Error('附件在登记快照时变化，需重新检查');const ref:ArtifactRef={artifactId,version:(old?.ref.version||0)+1,sha256,mediaType:image?'image/'+path.split('.').at(-1):document?.kind==='pdf'?'application/pdf':document?.kind==='csv'?'text/csv':document?.kind==='text'?'text/plain':'application/vnd.openxmlformats-officedocument.'+document?.kind};const snapshotPath=join(dataDir,'artifact-versions',artifactId,`${ref.version}-${sha256}`);mkdirSync(join(dataDir,'artifact-versions',artifactId),{recursive:true,mode:0o700});if(!existsSync(snapshotPath))writeFileSync(snapshotPath,bytes,{flag:'wx',mode:0o400});new SourcePolicy(artifactStore).registerArtifact({ref,projectId,path:snapshotPath,observations:[],valid:true,text:document?.text,owners:[session.sessionId]});artifactStore.put(key,{ref});if(cacheKey)artifactStore.put(cacheKey,{ref});return ref;
}
async function captureCapabilityInput(input:Record<string,unknown>){const payload=await captureDocumentInput(input,documentReader.read);for(const attachment of payload.attachments)await registerAttachmentArtifact(attachment.path,attachment.image!==undefined,attachment.hash);return payload;}
const pendingArtifactObservations=new Map<string,EvidenceReceipt>();
function selectArtifactObservation(receipt:EvidenceReceipt){const policy=new SourcePolicy(artifactStore);for(const ref of receipt.artifacts||[]){const record=policy.artifact(ref,receipt.projectId);policy.registerArtifact({...record,observations:[...record.observations,receipt]});}pendingArtifactObservations.set(receipt.receiptId,receipt);session.sessionManager.appendCustomEntry('friend-pi.artifact.observation.v1',receipt);}
/** Exact native text reached Pi's prepared-context hook. This is not a final wire or comprehension claim. */
function observePreparedArtifacts(messages:readonly unknown[]){const hashes=new Set(messages.flatMap(raw=>{if(!raw||typeof raw!=='object'||!('content' in raw))return [];return [digest(visibleText(raw.content))];}));for(const [id,selected] of pendingArtifactObservations){if(selected.sessionId!==session.sessionId){pendingArtifactObservations.delete(id);continue;}if(!selected.sources.some(source=>source.hash&&hashes.has(source.hash)))continue;const receipt:EvidenceReceipt={...selected,receiptId:randomUUID(),stage:'injected-to-context',omittedReason:'Observed at Pi context_with_system hook; later provider transforms and model comprehension are not observed.',at:new Date().toISOString()};const policy=new SourcePolicy(artifactStore);try{for(const source of receipt.sources)policy.assertSource(source);for(const ref of receipt.artifacts||[]){const record=policy.artifact(ref,receipt.projectId);policy.registerArtifact({...record,observations:[...record.observations,receipt]});}session.sessionManager.appendCustomEntry('friend-pi.artifact.observation.v1',receipt);}catch{/* Withdrawn sources cannot be promoted. */}pendingArtifactObservations.delete(id);}}
function observeInlineAttachments(metadata:unknown[],observedRunId:string,matched:boolean,entryId:string,nativeText:string){if(!matched)return;for(const raw of metadata){const item=object(raw);if(item.delivery!=='inline'||typeof item.path!=='string'||typeof item.hash!=='string')continue;const frozen=artifactStore.get<{ref:ArtifactRef}>(`source-version:${digest([projectIdentity(cwd),item.path,item.hash])}`)?.value;if(!frozen)continue;const policy=new SourcePolicy(artifactStore),record=policy.artifact(frozen.ref,projectIdentity(cwd));if(record.text===undefined)continue;const ref={...frozen.ref,ranges:[{unit:'utf16' as const,value:`0:${record.text.length}`}]},receipt:EvidenceReceipt={v:1,receiptId:randomUUID(),projectId:projectIdentity(cwd),sessionId:session.sessionId,runId:observedRunId,stage:'selected',sources:[{sessionId:session.sessionId,entryId,hash:digest(nativeText)}],artifacts:[ref],dependencies:[],observer:{kind:'foreground',runId:observedRunId,modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined},contentHash:digest(record.text),fullLength:record.text.length,visibleRanges:[[0,record.text.length]],at:new Date().toISOString()};selectArtifactObservation(receipt);}}
async function observeDocumentTool(toolCallId:string,result:unknown){
 const raw=object(result),details=object(raw.details||{});if(typeof details.path!=='string'||typeof details.hash!=='string')return;const payload=JSON.parse(visibleText(raw.content)),page=object(payload.page);if(typeof page.text!=='string'||typeof page.sectionId!=='string'||typeof page.offset!=='number')return;
 const entry=session.sessionManager.getBranch().find(item=>item.type==='message'&&item.message.role==='toolResult'&&item.message.toolCallId===toolCallId);if(!entry||entry.type!=='message'||entry.message.role!=='toolResult')return;
 const document=await documentReader.read(details.path);if(document.hash!==details.hash)return;const section=document.sections.find(item=>item.id===page.sectionId);if(!section||section.text.slice(page.offset,page.offset+page.text.length)!==page.text)return;let offset=0;for(const part of document.sections){const header=`## ${part.title}${part.hidden?'（'+part.hidden+'）':''}\n`;if(part.id===section.id){offset+=header.length+page.offset;break;}offset+=header.length+part.text.length+2;}
 const reference=await registerAttachmentArtifact(details.path,false,details.hash),policy=new SourcePolicy(artifactStore),record=policy.artifact(reference,projectIdentity(cwd)),ref={...reference,ranges:[{unit:'utf16' as const,value:`${offset}:${offset+page.text.length}`}]},source={sessionId:session.sessionId,entryId:entry.id,hash:digest(visibleText(entry.message.content))},observedRun=runId||session.sessionId,receipt:EvidenceReceipt={v:1,receiptId:randomUUID(),projectId:projectIdentity(cwd),sessionId:session.sessionId,runId:observedRun,stage:'selected',sources:[source],artifacts:[ref],dependencies:[],observer:{kind:'foreground',runId:observedRun,modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined},contentHash:digest(page.text),fullLength:document.text.length,visibleRanges:[[offset,offset+page.text.length]],at:new Date().toISOString()};selectArtifactObservation(receipt);
}
async function enqueueExpertTrace(){
 if(disposed||!runId||!enabled.includes('expert'))return;
 const observedRunId=runId,observedSessionId=session.sessionId;
 const branch=session.sessionManager.getBranch(),start=branch.findLastIndex(entry=>entry.type==='custom'&&entry.customType==='friend-pi.input.v1'&&object(entry.data).runId===observedRunId),marker=start>=0?object(object(branch[start]).data):{},sourceStart=typeof marker.entryId==='string'?branch.findIndex(entry=>entry.id===marker.entryId):branch.findLastIndex(entry=>entry.type==='message'&&entry.message.role==='user');
 const items=historyItems(branch.slice(Math.max(0,sourceStart))).filter(item=>['user','toolResult'].includes(item.role||'')&&!isDerivedCapabilityInput(item));
 const snapshot=services.snapshot(),tasks=snapshot.tasks.filter(task=>task.runId===observedRunId||snapshot.goal?.sourceRunId===observedRunId&&task.goalId===snapshot.goal?.id),checks=tasks.flatMap(task=>task.checkRefs||[]);
 const lastAssistant=session.messages.findLast(message=>message.role==='assistant'),incomplete=cancelRequested||lastAssistant?.stopReason==='aborted'||lastAssistant?.stopReason==='error'||['stopped','interrupted','paused'].includes(lifecycleStatus);
 const status=incomplete?undefined:tasks.some(task=>['repair','blocked'].includes(task.status))?'failed':lifecycleStatus==='completed'?'completed':lifecycleStatus==='failed'?'failed':undefined;
 const outcome=incomplete?(cancelRequested||lastAssistant?.stopReason==='aborted'?'cancelled':'unknown'):status;
 if(outcome)try{await requestPlugin(bus,'expert','trial.observe',{runId:observedRunId,checks,outcome,key:`settled:${observedRunId}:${digest([outcome,checks])}`},3000);}catch(error){if(!disposed)publish('notice',{level:'warning',message:'专家试用等待核对：'+publicError(error)});}
 if(!status||disposed||runId!==observedRunId||session.sessionId!==observedSessionId)return;
 const evidence:unknown[]=items.flatMap(item=>sourceFactRefs(item,session.sessionId).map(source=>({kind:'pi',projectId:projectIdentity(cwd),source})));for(const check of checks)evidence.push({kind:'check',projectId:projectIdentity(cwd),check});
 const version=parseInt(digest([observedRunId,tasks.map(task=>[task.id,task.revision]),items.map(item=>[item.id,digest(item.text)])]).slice(0,10),16);
 try{await requestPlugin(bus,'expert','taskTraceReady',{runId:observedRunId,taskResultVersion:version,taskResult:{status,tasks:tasks.map(task=>({id:task.id,status:task.status,result:task.result,checkRefs:task.checkRefs})),goal:snapshot.goal?{id:snapshot.goal.id,status:snapshot.goal.status}:undefined},evidence},3000);}catch(error){if(!disposed)publish('notice',{level:'warning',message:'专家学习未入队：'+publicError(error)});}
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
function requestQuestions(input:unknown,toolCallId:string,signal?:AbortSignal):Promise<QuestionBatchResult>{
 const batch=questionBatch(input),request:QuestionBatchDialog={...batch,id:randomUUID(),kind:'questionBatch',generation:questionGeneration,runId,toolCallId,createdAt:Date.now(),sequence:++questionSequence};
 return new Promise(resolveResult=>{const finish=(value:unknown)=>{signal?.removeEventListener('abort',abort);resolveResult({...batch,status:value?'answered':stopping||disposed||signal?.aborted?'interrupted':'cancelled',...(value?{answers:value as QuestionBatchResult['answers']}:{})});};
 const abort=()=>{const pending=dialogs.get(request.id);if(pending){dialogs.delete(request.id);finish(undefined);publish('dialog.closed',{id:request.id});}};
 if(signal?.aborted||stopping||disposed){finish(undefined);return;}dialogs.set(request.id,{resolve:finish,batch:request,cleanup:()=>signal?.removeEventListener('abort',abort)});signal?.addEventListener('abort',abort,{once:true});publish('dialog',request);
 });
}
const questionGeneration=randomUUID();let questionSequence=0;
function guard():ExtensionFactory{return pi=>{
 pi.registerTool({name:'friend_questions',label:'向用户提问',description:'需要用户澄清或选择时，主助手把相关问题合为一组。支持single/multiple/text；逐题填写、复核后一次提交。required必须明确，选项用稳定id/label。不要用默认选项代替用户回答；取消时没有部分答案。',parameters:Type.Object({v:Type.Literal(1),title:Type.String(),questions:Type.Array(Type.Object({id:Type.String(),type:Type.Union(['single','multiple','text'].map(value=>Type.Literal(value))),title:Type.String(),description:Type.Optional(Type.String()),required:Type.Boolean(),options:Type.Optional(Type.Array(Type.Object({id:Type.String(),label:Type.String()}))),allowOther:Type.Optional(Type.Boolean())}),{minItems:1,maxItems:12})}),async execute(id,input,signal){const result=await requestQuestions(input,id,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});

  pi.registerTool({name:'friend_terminal',label:'服务终端',description:'启动需要保持运行的服务终端，列出或读取输出。input/read/stop 必须提供当前 authorityEpoch；用户接管后不可控制。',parameters:Type.Object({action:Type.Union(['create','list','read','input','stop'].map(value=>Type.Literal(value))),id:Type.Optional(Type.String()),name:Type.Optional(Type.String()),command:Type.Optional(Type.String()),data:Type.Optional(Type.String()),authorityEpoch:Type.Optional(Type.Number())}),async execute(_id,input,signal){if(planMode&&!['list','read'].includes(input.action))throw new Error('计划模式只允许读取已有服务终端');const result=await terminalRequest(input.action,input,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  const offPolicy=pi.events.on('friend-pi:v1:policy',raw=>{const request=object(raw);if(request.v!==1||typeof request.reply!=='function'||session&&request.sessionId!==session.sessionId)return;const active=[...services.activeTools(),...services.unknownActivities(),...services.unsettledJobs()];const admissions=services.jobs.pendingCount(String(request.sessionId));const members=[...swarmGraphs.values()].flatMap(graph=>[...(Array.isArray(graph.attempts)?graph.attempts:[]),...(Array.isArray(graph.reviewAttempts)?graph.reviewAttempts:[])].map(object)).filter(attempt=>attempt.status==='running').length;const policy:HostPolicy={v:1,revision:policyRevision,runId,stage:'main',canSwitchRole:!modelInFlight&&!teammateRunning&&active.length===0&&members===0&&admissions===0,unsettledTools:active.length+members+admissions+(teammateRunning?1:0)+(modelInFlight?1:0),tools:pi.getAllTools().map(tool=>tool.name),writeScopes:planMode?[]:['.'],executionMode,planMode,permissionMode,temporaryWriteRoot,executionStopped:stopping||cancelRequested||!!memberBudgetWait(),executionWaitReason:memberBudgetWait(),modelId:session?.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session?.thinkingLevel,goalId:services.currentGoal()&&['active','waiting','verifying'].includes(services.currentGoal()!.status)?services.currentGoal()!.id:undefined};(request.reply as (value:HostPolicy)=>void)(policy);});
  pi.on('session_shutdown',()=>offPolicy());
  pi.registerTool({name:'friend_todo',label:'任务待办',description:'维护本轮可见 Todo 清单。read 读取，update 提交完整 items=[{content,status:pending|in_progress|completed}]。多步骤任务开始时规划，执行变化后更新；勾选不代表验收通过。',parameters:Type.Object({action:Type.Union([Type.Literal('read'),Type.Literal('update')]),items:Type.Optional(Type.Array(Type.Object({content:Type.String(),status:Type.Union(['pending','in_progress','completed'].map(value=>Type.Literal(value)))})))}),async execute(_id,input){if(!runId)throw new Error('尚未开始本轮任务');if(input.action==='update')session.sessionManager.appendCustomEntry(TODO_TYPE,{v:1,runId,items:todoItems(input.items)});publish('state',current());const result=projectTodo(session.sessionManager.getBranch(),runId)||null;return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  pi.registerTool({name:'friend_plan',label:'提交计划',description:'只读规划完成后提交可供用户批准的计划；模型不能批准或启动。',parameters:Type.Object({action:Type.Union([Type.Literal('submit'),Type.Literal('read')]),body:Type.Optional(Type.String())}),async execute(_id,input){const result=input.action==='read'?(plans.current()??null):plans.submit(text(input.body,'计划'),{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});publish('state',current());return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}});
  pi.on('context_with_system',event=>{
    observePreparedArtifacts(event.messages);
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
    const currentTodo=projectTodo(session.sessionManager.getBranch(),runId);
    const todoInstruction='需要用户确认需求或选择时，使用 friend_questions 将相关问题合为一组；等待正式回答，不推断未提交的选项。多步骤工作请用 friend_todo update 保存完整待办清单并及时更新状态；简单任务无需维护 Todo 清单。'+(currentTodo?'当前清单：'+JSON.stringify(currentTodo.items):'');
    const instructions=memberContinuation?'当前是队友补充讨论的后续处理。先读取该成员的原生历史，解释结果；只有需要改变成果时才建立新的受控任务和完整检查、复核。不要重跑已完成任务。':planMode?'当前是计划模式。使用 read、ls、find、grep 只读探索，给出目标、步骤、依赖、成果和客观验证；用 friend_plan submit 提交完整计划给用户批准。不要修改项目、运行 shell 或启动协作成员。':executionMode==='team'?'当前是 Team 模式。需要委派时用 friend_team delegate。子成员只与你通信；读取成果直接返回，写入须隔离、检查和独立复核，之后由你决定 integrate。可以沿用当前模型与思考等级。':executionMode==='swarm'?'用户已明确选择 Swarm，不能因任务简单而自行改为 Single；只读或简单任务也须建立并启动最小协作图。当前是 Swarm 模式。请用 friend_swarm create/start 工具根据用户在对话中说明的工作目标，自主生成任务、依赖、成员安排与验证方式，并启动后台执行，跟踪成果并按验证等级复核；不要只给方案或要求用户填写任务页表单、JSON、命令或令牌预算。需要动态阶段时自行用 friend_workflow create/start，长期目标与后台命令按需使用 friend_goal、friend_jobs 原生工具管理。只有目标本身缺少必要业务信息时才用 friend_questions 澄清。继续遵守计划模式、权限审批、隔离写入与用户停止；不要重复启动已有执行。':'';
    const workspaceInstructions=temporaryWriteRoot?`你正在临时会话中工作。所有任务产物默认写入当前会话目录 ${temporaryWriteRoot}。修改此目录外的文件必须先获得用户逐次批准；权限策略不能免除该要求。无法确认写入范围的命令会申请批准。`:'';
    const branchInstructions=session.sessionManager.getBranch().some(entry=>entry.type==='custom'&&entry.customType===SIDECHAT_TYPE&&object(entry.data).v===1)?'当前是独立分支会话。分叉点以前继承的消息仅作历史背景，旧 user 请求不是本分支待办；本轮只执行本分支最新提交的请求。父任务状态若无真实证据则未知，不要推断完成或失败，不要仅因继承历史而继续或重放父会话命令。':'';
    return instructions||workspaceInstructions||todoInstruction||branchInstructions?{systemPrompt:`${event.systemPrompt}\n\n${instructions}\n${workspaceInstructions}\n${todoInstruction}\n${branchInstructions}`}:undefined;
  });
  pi.on('tool_call',async(event,ctx)=>{
    const input=object(event.input);if(stopping)return {block:true,reason:'正在停止，未开始的工具已取消'};
    if(swarmCorrectionActive){
      if(event.toolName==='friend_swarm'){
        const data=object(input.input),tasks=Array.isArray(data.tasks)?data.tasks.map(object):[];
        if(input.action==='create'&&(!tasks.length||tasks.some(task=>task.mode!=='read')||!Array.isArray(data.checks)||data.checks.length||data.contract!==undefined))return {block:true,reason:'协作核验只能创建 read 任务和 checks:[]，不能重放写入或命令'};
        if(!['create','start','snapshot','result','member.history','member.list','prepare','review','integrate'].includes(String(input.action)))return {block:true,reason:'协作核验只补全当前只读任务图'};
        if(input.action!=='create'&&data.graphId&&!runGraphIds.has(String(data.graphId)))return {block:true,reason:'协作核验不能启动或修改其他轮次的任务图'};
      }else if(!['read','ls','grep','find','read_document','friend_todo'].includes(event.toolName))return {block:true,reason:'协作核验只允许读取现有成果，不重放写入、命令或目标操作'};
    }
    if(planMode){
      const readActions=new Set(['list','snapshot','search','read','get','versions','history.search','history.read','history.around']);
      if(event.toolName!=='friend_questions'&&event.toolName!=='friend_todo'&&![...nativeMcpResourceTools,'read','ls','find','grep','read_document','web_search','web_fetch'].includes(event.toolName)&&!(event.toolName==='friend_plan'&&['submit','read'].includes(String(input.action)))&&!(event.toolName.startsWith('friend_')&&readActions.has(String(input.action))))return {block:true,reason:'计划模式只允许读取、搜索和提交计划，批准后再执行。'};
    }
    const request=(event.toolName==='friend_questions'||event.toolName.startsWith('mcp__')||[...nativeMcpResourceTools,'web_fetch','web_search','read_document'].includes(event.toolName)?undefined:toolPermissionRequest(event.toolName,input,Boolean(temporaryWriteRoot)))||(temporaryWriteRoot&&event.toolName==='bash'?{operation:'执行命令',message:String(input.command||''),autoEligible:false}:undefined);
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
  process.env.PI_CODING_AGENT_DIR=agentDir;
  initTheme('light',false);
  runtime=await createProviderRuntime(dataDir);
  let model=process.env.FRIEND_PI_TEST_PROVIDER==='1'?await installFixtureProvider(runtime):undefined;
  if(process.env.FRIEND_PI_MODEL){const slash=process.env.FRIEND_PI_MODEL.indexOf('/');const requested=runtime.getModel(process.env.FRIEND_PI_MODEL.slice(0,slash),process.env.FRIEND_PI_MODEL.slice(slash+1));if(requested)model=requested;else if(process.env.FRIEND_PI_DESKTOP_MANAGED!=='1')model=selectedModel(process.env.FRIEND_PI_MODEL);else {missingModelId=process.env.FRIEND_PI_MODEL;process.env.FRIEND_PI_DESKTOP_MODEL_UNAVAILABLE='1';}}
  if(!model)model=(await runtime.getAvailable())[0]||runtime.getModels().find(item=>item.provider==='deepseek')||runtime.getModels()[0];
  guardDesktopModelRequests(runtime,dataDir);
  const settings=SettingsManager.inMemory({...(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'?{cacheWarming:'off' as const}:{}),extensions:enabled.map(name=>join(root,'packages',name,'dist','index.js')),packages:[],defaultTools:['read','bash','edit','write','ls','find','grep'],compaction:{enabled:true,...(process.env.FRIEND_PI_TEST_PROVIDER==='1'?{keepRecentTokens:512,reserveTokens:2048}:{})}});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:false,noSkills:false,noPromptTemplates:false,noThemes:true,eventBus:bus,extensionFactories:[customInstructionsExtension(dataDir),guard(),services.extension(),services.jobs.extension(),documentTools(cwd,documentAttachments,documentReader.read),external.extensionFactory]});
  await loader.reload({resolveProjectTrust:async()=>true});
  const priorFile=process.env.FRIEND_PI_SESSION_FILE;
  if(priorFile){if(!existsSync(priorFile))throw new Error('原始会话历史缺失，未创建替代历史');const raw=readFileSync(priorFile,'utf8');if(!raw.trim())throw new Error('原始历史为空，不能恢复');const entries=raw.trim().split('\n').map(line=>JSON.parse(line));if(entries[0]?.type!=='session'||typeof entries[0].id!=='string')throw new Error('原始历史头部无效，未创建替代历史');const known=new Set<string>();for(const entry of entries.slice(1)){if(!entry||typeof entry.type!=='string'||typeof entry.id!=='string'||!entry.id||known.has(entry.id)||typeof entry.timestamp!=='string'||!Number.isFinite(Date.parse(entry.timestamp))||entry.parentId!==null&&(typeof entry.parentId!=='string'||!known.has(entry.parentId))||entry.type==='message'&&(!entry.message||typeof entry.message.role!=='string'))throw new Error('原始历史条目损坏，索引保留，未创建替代历史');known.add(entry.id);}}
  const manager=priorFile?SessionManager.open(priorFile):SessionManager.create(cwd,join(dataDir,'sessions'));
  for(const entry of manager.getBranch())if(entry.type==='custom'&&entry.customType==='friend-pi.attachments.v1'&&object(entry.data).stage==='started')for(const raw of Array.isArray(object(entry.data).attachments)?object(entry.data).attachments as unknown[]:[]){const item=object(raw);if(typeof item.path==='string'&&typeof item.hash==='string')documentAttachments.set(item.path,item.hash);}
  if(!priorFile){const file=manager.getSessionFile();if(!file)throw new Error('新会话原史路径不可用');closeSync(openSync(file,'wx',0o600));manager.setSessionFile(file);}
  if(!priorFile)manager.appendCustomEntry('friend-pi.session.created',{v:1,desktopId:process.env.FRIEND_PI_DESKTOP_SESSION_ID,createdAt:new Date().toISOString()});
  if(process.env.FRIEND_PI_PI_SESSION_ID&&manager.getSessionId()!==process.env.FRIEND_PI_PI_SESSION_ID)throw new Error('原始历史会话身份不匹配');
  if(priorFile&&projectIdentity(manager.getCwd())!==projectIdentity(cwd))throw new Error('原始历史项目身份不匹配');
  if(isSessionDeleted(dataDir,manager.getSessionId()))throw new Error('会话已删除');
  inputQueue=new MessageQueue(manager.getSessionId(),dataDir);for(const entry of ownedEntries(manager.getBranch()))if(entry.type==='custom'&&entry.customType==='friend-pi.input.v1'){const receipt=object(entry.data);if(typeof receipt.queueId==='string'&&typeof receipt.runId==='string')inputQueue.delivered(receipt.queueId,receipt.runId);}
  inputQueue.recover();
  if(priorFile){const branch=ownedEntries(manager.getBranch());const latestUser=projectMessages(branch).findLast(message=>message.role==='user');runId=latestUser?.runId;const latestPolicy=branch.findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.run.policy.v1'&&object(entry.data).v===1&&typeof object(entry.data).runId==='string'&&!!object(entry.data).runId&&typeof object(entry.data).requiresSwarm==='boolean');if(latestPolicy?.type==='custom'&&branch.indexOf(latestPolicy)>branch.findIndex(entry=>entry.id===latestUser?.id))runId=String(object(latestPolicy.data).runId);if(!runId&&latestUser){const userIndex=branch.findIndex(entry=>entry.id===latestUser.id);const receipt=branch.slice(userIndex+1).findLast(entry=>entry.type==='custom'&&/friend-pi\.(memory\.usage|expert\.(run|adoption))/.test(entry.customType)&&typeof object(entry.data).runId==='string');if(receipt?.type==='custom')runId=String(object(receipt.data).runId);}if(runId){process.env.FRIEND_PI_RUN_ID=runId;settledRunId=runId;}}
  if(inputQueue.store.get(`suspension:${manager.getSessionId()}`))inputQueue.pause(true);
  plans=new PlanStore(businessStore,projectIdentity(cwd),manager.getSessionId());
  const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager:settings,sessionManager:manager,customTools:[createBashToolDefinition(cwd,{spawnHook:ctx=>({...ctx,env:shellEnvironment(ctx.env)})}) as ToolDefinition]});session=created.session;
  const previousPayload=session.agent.onPayload;
  session.agent.onPayload=async(payload,model)=>{
    const transformed=await previousPayload?.(payload,model),actual=object(transformed??payload);
    const systems=providerSystems(actual);
    if(systems.length){const text=traceJSON(systems),hash=digest(text),prior=session.sessionManager.getBranch().findLast(entry=>entry.type==='custom'&&entry.customType==='friend-pi.trace.system.v1'&&object(entry.data).runId===runId&&object(entry.data).phase==='provider-payload');if(!prior||prior.type!=='custom'||object(prior.data).hash!==hash)session.sessionManager.appendCustomEntry('friend-pi.trace.system.v1',{v:1,runId,phase:'provider-payload',modelId:`${model.provider}/${model.id}`,text:text.slice(0,65536),hash,truncated:text.length>65536});}
    return transformed;
  };
  changeTracker=new RunChangesTracker(cwd,projectIdentity(cwd),dataDir,session.sessionId,summary=>{session.sessionManager.appendCustomEntry(RUN_CHANGES_TYPE,summary);publish('state',current());},()=>projectRunChanges(session.sessionManager.getBranch()));
  if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'){const originalStream=session.agent.streamFunction;session.agent.streamFunction=async(model,context,options)=>originalStream(await requireReadyModel(runtime,dataDir,`${model.provider}/${model.id}`),context,options);}
  if(created.extensionsResult.errors.length)throw new Error(created.extensionsResult.errors.map(error=>error.error).join('; '));
  let liveSequence=0;let liveStreamId="";const metricRecorder=new SessionMetricRecorder();let metricMessage:unknown;
  session.subscribe(event=>{
    if(event.type==='message_end'&&event.message.role==='assistant')metricMessage=event.message;
    const metric=metricRecorder.observe(event),measuredMessage=metricMessage;
    if(metric&&measuredMessage)queueMicrotask(()=>{if(disposed)return;const entry=session.sessionManager.getEntries().find(e=>e.type==='message'&&e.message===measuredMessage);if(entry){session.sessionManager.appendCustomEntry(SESSION_METRIC_TYPE,{...metric,entryId:entry.id});publish('state',current());}});
    if(event.type==='agent_start'){recordForeground(true);changeTracker?.reopen(runId);}
    if(event.type==='message_start'&&event.message.role==='assistant')liveStreamId="stream-"+session.sessionId+"-"+(++liveSequence);
    if(['message_start','message_update','message_end'].includes(event.type))publish('stream',{streamId:liveStreamId,event});
    if(event.type==='message_start'&&event.message.role==='assistant')modelInFlight=true;if(event.type==='message_end'&&event.message.role==='assistant'||event.type==='agent_settled')modelInFlight=false;
    publish('pi',event);
    if(event.type==='tool_execution_start'){if(event.toolName==='friend_todo'||event.toolName==='friend_expert'&&/^role\.(snapshot|read|versions|assign|switch)$/.test(String(object(event.args).action)))neutralToolIds.add(event.toolCallId);else policyRevision++;services.beginTool(event.toolCallId,event.toolName,event.args);}
    if(event.type==='tool_execution_end'){if(event.toolName==='read_document'&&!event.isError)queueMicrotask(()=>{void observeDocumentTool(event.toolCallId,event.result).catch(error=>publish('notice',{level:'warning',message:'文档观察收据未登记：'+publicError(error)}));});if(!neutralToolIds.delete(event.toolCallId))policyRevision++;services.endTool(event.toolCallId);}
    if(event.type==='message_end'&&event.message.role==='assistant'){const usage=event.message.usage;services.account(modelTokenUsage(usage),`main:${event.message.timestamp}:${digest(event.message.content)}`);if(services.currentGoal()?.status==='paused'&&services.currentGoal()?.error?.includes('令牌'))void session.abort();}
    if(event.type==='message_start'&&event.message.role==='user'){
      const nativeMessage=event.message;const nativeText=visibleText(nativeMessage.content);
      const started=pendingInputs.find(input=>input.id===startedInputId);startedInputId=undefined;
      // Queued steering/follow-up inputs do not run before_agent_start. They are
      // delivered unchanged by Pi, so require both complete text and image hashes.
      const input=started||pendingInputs.find(input=>!input.expectsStart&&!input.nativeMessage&&input.combinedHash===digest(nativeText)&&input.imageHash===imageIdentity(typeof nativeMessage.content==='string'?[]:nativeMessage.content.filter(part=>part.type==='image')));
      if(input&&(input.preflightStarted||digest(nativeText.slice(0,input.combinedLength))===input.combinedHash))input.nativeMessage=nativeMessage;
    }
    if(event.type==='message_end'&&event.message.role==='user'){const nativeMessage=event.message;queueMicrotask(()=>{if(disposed)return;const entry=session.sessionManager.getBranch().find(e=>e.type==='message'&&e.message===nativeMessage);const position=pendingInputs.findIndex(input=>input.nativeMessage===nativeMessage);if(!entry||position<0)return;const input=pendingInputs[position],nativeText=visibleText(nativeMessage.content),exact=digest(nativeText.slice(0,input.text.length))===digest(input.text);if(!exact&&!input.preflightStarted)return;const deliveredText=exact?input.text:nativeText;session.sessionManager.appendCustomEntry(input.automatic?'friend-pi.runtime-wake.input':'friend-pi.input.v1',{entryId:entry.id,textEnd:deliveredText.length,hash:digest(deliveredText),runId:input.runId,...(input.background?{background:true}:{}),...(input.queueId?{queueId:input.queueId}:{})});if(input.attachmentMetadata?.length){const matched=digest(nativeText.slice(0,input.combinedLength))===input.combinedHash&&input.imageHash===imageIdentity(typeof nativeMessage.content==='string'?[]:nativeMessage.content.filter(part=>part.type==='image'));session.sessionManager.appendCustomEntry('friend-pi.attachments.v1',{v:1,runId:input.runId,stage:matched?'started':'unverified',entryId:entry.id,attachments:input.attachmentMetadata});observeInlineAttachments(input.attachmentMetadata,input.runId||runId||session.sessionId,matched,entry.id,nativeText);}if(input.queueId)inputQueue.delivered(input.queueId,input.runId);pendingInputs.splice(position,1);publish('state',current());});}
    if(event.type==='agent_settled'&&!disposed){
      swarmCorrectionActive=false;const correcting=correctMissingSwarm();
      settledRunId=runId;lifecycleStatus=correcting?'running':settledStatus();recordForeground(rootExecutionBusy());
      foregroundOpen=rootExecutionBusy();
      if(planMode){const last=[...session.messages].reverse().find(m=>m.role==='assistant');const body=last?visibleText(last.content):'';if(body&&(!plans.current()||Date.parse(plans.current()!.createdAt)<runStartedAt))plans.submit(body,{modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,mode:executionMode,permissionMode});}
      services.settled(lifecycleStatus);setImmediate(()=>{if(disposed)return;if(!correcting)void enqueueExpertTrace();void services.drain();});
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
    if(disposed)return;
    publish('plugin',raw);
    if(!raw||typeof raw!=='object')return;
    const event=object(raw);
    if(event.pluginEvent==='expert.role.delivery'){const data=object(event.data);if(data.approved===false&&typeof data.runId==='string'){roleDeliveryErrors.set(data.runId,String(data.error||'角色交付合同未通过'));services.goals.deliveryFailure(services.context(),data,services.generation());}else if(typeof data.runId==='string')roleDeliveryErrors.delete(data.runId);return;}
    if(event.pluginEvent==='runtime.model-usage'){const data=object(event.data);services.account(typeof data.tokens==='number'?data.tokens:undefined,'aux:'+String(data.callId),typeof data.runId==='string'?data.runId:runId);return;}
    if(event.pluginEvent==='swarm.member-usage'){const data=object(event.data);services.account(typeof data.tokens==='number'?data.tokens:undefined,'member:'+String(data.memberId)+':'+String(data.entryId),typeof data.runId==='string'?data.runId:runId);return;}
    if(event.pluginEvent==='swarm.member-supplement'){const data=object(event.data);session.sessionManager.appendCustomEntry('friend-pi.swarm.supplement',{v:1,memberId:data.memberId,messageId:data.messageId,graphId:data.graphId});return;}
    if(event.pluginEvent==='swarm.member-request'){
      const data=object(event.data),graph=swarmGraphs.get(String(data.graphId)),sourceRun=typeof graph?.runId==='string'?graph.runId:undefined;
      const frame={id:'member-request:'+String(data.attemptId)+':'+digest(data.body),generation:services.generation(),runId:sourceRun,message:'队友提出补充讨论或返工建议。请读取 friend_swarm member.history 判断；如需修改，创建新的受控任务尝试并重新检查、复核。队友：'+String(data.memberId)+'；建议：'+String(data.body),createdAt:new Date().toISOString()};
      if(!graph||graph.sessionId!==session.sessionId||!sourceRun||![sourceRun,runId].includes(String(data.runId))||cancelRequested||stopping){skipRuntimeWake(frame,'stale-member-source');return;}
      if(correctedRun(sourceRun)){skipRuntimeWake(frame,sourceRun===runId?'correction-member-source':'stale-member-source');return;}
      if(data.runId!==runId){skipRuntimeWake(frame,'stale-member-source');return;}
      services.enqueue(frame.id,frame.message,{generation:frame.generation,runId});return;
    }
    if(event.pluginEvent==='swarm.member-event'){const data=object(event.data),native=object(data.event);if(!data.memberId&&native.type==='message_end'){const message=object(native.message),graph=swarmGraphs.get(String(data.graphId)),goal=services.currentGoal();if(message.role==='assistant'&&goal&&(graph?.goalId===goal.id||graph?.runId===goal.sourceRunId)){const usage=message.usage?object(message.usage):undefined;services.account(modelTokenUsage(usage),`member:${data.attemptId}:${message.timestamp}:${digest(message.content)}`);}}return;}
    if(event.pluginEvent==='team.result'){services.teamResult(object(event.data));return;}
    if(event.pluginEvent==='workflow.changed'){
      const data=object(event.data),wasRunning=workflowRunning;
      // Controllers publish both per-workflow changes and full snapshots.
      if(Array.isArray(data.workflows)){workflowStatuses.clear();for(const raw of data.workflows){const flow=object(raw);if(typeof flow.id==='string')workflowStatuses.set(flow.id,String(flow.status));}}
      else if(typeof data.workflowId==='string')workflowStatuses.set(data.workflowId,String(data.status));
      workflowRunning=[...workflowStatuses.values()].some(status=>['running','waiting_review'].includes(status));
      if(wasRunning&&!workflowRunning&&!stopping&&session.isIdle&&!rootExecutionBusy()){lifecycleStatus=settledStatus();foregroundOpen=finiteJobs();publishAuthorityNotice();}
      queueChanged();return;
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
    // Member process exit can precede review/integration. Recheck queued input
    // after the committed graph snapshot has updated every busy flag.
    queueChanged();
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

async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  if(method==='external.call'||method==='runtime'&&input.action==='external.call'){const args=object(input.input||{}),action=method==='external.call'?String(input.action):String(args.action);if(['snapshot','mcp.status'].includes(action)&&(!session.isIdle||swarmBusy()||stopping))return external.snapshot();if(!['snapshot','mcp.status'].includes(action)&&(!session.isIdle||swarmBusy()||stopping))throw new Error('请等待当前会话执行结束，再配置或测试外部能力');return external.call(action,object(method==='external.call'?input.input:args.input));}
  if(method==='reference.commands'){const query=String(input.query||'').toLowerCase();return {items:[...session.extensionRunner.getRegisteredCommands().map(command=>({id:'command:'+command.name,label:command.name+' · '+command.description,kind:'命令',insert:'/'+command.name})),...session.resourceLoader.getSkills().skills.map(skill=>({id:'skill:'+skill.name,label:skill.name+' · '+skill.description,kind:'Skill',insert:'/skill:'+skill.name}))].filter(item=>item.label.toLowerCase().includes(query)||item.insert.slice(1).toLowerCase().includes(query)).slice(0,60)};}
  if(disposed&&method!=='shutdown')throw new Error('会话已结束');
  if(session&&isSessionDeleted(dataDir,session.sessionId)&&method!=='shutdown')throw new Error('会话已删除');
  if(method==='send'&&!input.queueId){queueEpoch++;cancelQueueResume();}
  const mutation=['stop','configure','send','provider.refresh','provider.save','plan.approve','plan.reject'].includes(method)||method==='queue'&&input.action!=='list'||method==='runtime'&&!/^(snapshot|.*\.(read|list|status|logs))$/.test(String(input.action))||method==='plugin'&&!/^(snapshot|read|list|status|.*\.(read|list|history))$/.test(String(input.action));
  if(queueRestoring&&mutation){queueEpoch++;await queueRestoring.catch(()=>true);}

  if(method==='queue'){
    const action=String(input.action),id=String(input.id||''),revision=Number(input.revision);
    if(action==='add'){
      const intentId=typeof input.intentId==='string'?text(input.intentId,'消息提交标识',80):undefined,identity=digest({text:input.text,attachments:Array.isArray(input.attachments)?input.attachments.map(raw=>object(raw).path):[],mode:input.mode,planMode:input.planMode});
      if(intentId&&inputQueue.accepted(intentId,identity))return queueState();
      if(input.fromSideDraft===true)await handle('draft.update',input);
      const payload=input.fromSideDraft===true?inputQueue.store.get<InputPayload>(`draft:${session.sessionId}`)?.value:await captureCapabilityInput(input);if(!payload)throw new Error('分支草稿不存在');
      if(payload.attachments.some(item=>item.image)&&!session.model?.input.includes('image'))throw new Error('当前型号不支持图片');
      inputQueue.store.transaction(()=>{inputQueue.add(payload,intentId,identity);if(input.fromSideDraft===true)inputQueue.store.remove(`draft:${session.sessionId}`);});
    }
    else if(action==='pause'){queueEpoch++;queueResumeAuthorised=false;inputQueue.pause(true);}
    else if(action==='resume'){if(services.unknownActivities().length||services.jobs.hasUnknown(services.context()))throw new Error('请先处理未知执行现场');queueEpoch++;queueResumeAuthorised=true;inputQueue.pause(false);}
    else if(action==='edit')inputQueue.edit(id,revision);
    else if(action==='save')inputQueue.edit(id,revision,typeof input.text==='string'?input.text:text(input.text,'消息',128*1024));
    else if(action==='cancelEdit')inputQueue.cancelEdit(id,revision);
    else if(action==='remove')inputQueue.remove(id,revision);
    else if(action==='steer'){
      if(queueDriving||stopping||lifecycleStatus==='rebuilding')throw new Error('请等待当前执行状态稳定');
      if(!session.isStreaming&&(swarmBusy()||finiteJobs()))throw new Error('协作仍在执行，暂不能引导主 Agent');
      const item=inputQueue.claim(id,revision,runId&&session.isStreaming?runId:randomUUID());
      try{await handle('send',{queueId:item.id,admissionEpoch:queueEpoch,runId:item.runId,inputMode:'steer',mode:item.mode,planMode:item.planMode});}catch(error){inputQueue.failed(item.id);throw error;}
    }
    else if(action==='move.prepare'){const leaf=stableForkLeaf(session.sessionManager.getBranch());if(!leaf)throw new Error('尚无可继承的上下文');return inputQueue.moving(id,revision,text(input.targetId),leaf);}
    else if(action==='move.inspect'){const item=inputQueue.read(id);if(item.targetId!==input.targetId||!['moving','unknown'].includes(item.state))throw new Error('分支会话交接身份不匹配');return item;}
    else if(action==='move.failed'){const item=inputQueue.snapshot().items.find(row=>row.id===id);if(item&&item.targetId===input.targetId&&['moving','unknown'].includes(item.state))inputQueue.unknown(id);}
    else if(action==='move.commit'){if(inputQueue.snapshot().items.some(item=>item.id===id))inputQueue.moved(id,text(input.targetId));}
    else if(action==='move.cancel')inputQueue.release(id,text(input.targetId));
    else if(action!=='list')throw new Error('未知排队操作');
    queueChanged();return queueState();
  }
  if(method==='sidechat.fork'){
    const leafId=typeof input.leafId==='string'?input.leafId:stableForkLeaf(session.sessionManager.getBranch()),file=session.sessionFile;if(!leafId||!file)throw new Error('尚无可继承的已提交上下文');
    const key=typeof input.targetId==='string'?`sidechat-fork:${session.sessionId}:${input.targetId}`:undefined,identity={leafId,cwd:text(input.cwd),sessionDir:text(input.sessionDir)};
    const saved=key?inputQueue.store.get<{identity:typeof identity;result:{path:string;piSessionId:string}}>(key)?.value:undefined;
    if(saved){if(digest(saved.identity)!==digest(identity))throw new Error('分支会话分叉身份已变化');return saved.result;}
    const childManager=SessionManager.open(file,identity.sessionDir,identity.cwd);
    const path=childManager.createBranchedSession(leafId);if(!path)throw new Error('无法创建分支会话');
    childManager.appendCustomEntry(SIDECHAT_TYPE,{v:1,sourceSessionId:session.sessionId,leafId});
    const result={path,piSessionId:childManager.getSessionId()};if(key)inputQueue.store.put(key,{identity,result});return result;
  }
  if(method==='draft.install'){
    const payload=object(input.payload),transferId=typeof payload.id==='string'?payload.id:undefined,key=`draft:${session.sessionId}`,receipt=transferId?`draft-install:${session.sessionId}:${transferId}`:undefined,hash=digest({text:payload.text,attachments:payload.attachments,mode:payload.mode,planMode:payload.planMode}),installed=receipt?inputQueue.store.get<{hash:string}>(receipt)?.value:undefined;
    if(installed&&installed.hash!==hash)throw new Error('分支草稿交接内容已变化');
    if(!installed)inputQueue.store.transaction(()=>{if(!inputQueue.store.get(key)){validateCapturedInput(payload as unknown as InputPayload);inputQueue.store.put(key,{...payload,submissionId:randomUUID()});}if(receipt)inputQueue.store.put(receipt,{hash});});return current();
  }
  if(method==='draft.read')return inputQueue.store.get<InputPayload>(`draft:${session.sessionId}`)?.value||null;
  if(method==='draft.update'){
    const key=`draft:${session.sessionId}`,old=inputQueue.store.get<InputPayload>(key)?.value;if(!old)throw new Error('分支草稿不存在');
    if(typeof input.removePath==='string')inputQueue.store.put(key,{...old,attachments:old.attachments.filter(a=>a.path!==input.removePath)});
    else{
      if(typeof input.text!=='string'||Buffer.byteLength(input.text)>128*1024)throw new Error('草稿内容无效');let attachments=old.attachments;
      if(Array.isArray(input.attachments)){
        const requested=input.attachments.map(raw=>object(raw)),paths=requested.map(raw=>text(raw.path)),retained=old.attachments.filter(a=>paths.includes(a.path));
        for(const item of requested){const frozen=retained.find(a=>a.path===item.path);if(frozen&&Object.hasOwn(frozen,'sourceBytes')&&item.hash&&item.hash!==frozen.hash)throw new Error('附件与分支草稿快照不同，请移除后重新添加');}
        const added=requested.filter(item=>!old.attachments.some(a=>a.path===item.path));
        attachments=[...retained,...(added.length?(await captureCapabilityInput({text:input.text+retained.map(a=>a.text||'').join(''),attachments:added})).attachments:[])];
      }
      if(input.mode!==undefined&&!['single','team','swarm'].includes(String(input.mode)))throw new Error('协作方式无效');
      const next={...old,text:input.text,attachments,...(input.mode===undefined?{}:{mode:input.mode as InputPayload['mode']}),...(input.planMode===undefined?{}:{planMode:input.planMode===true})};validateCapturedInput(next);
      if(digest(inputQueue.store.get(key)?.value??null)!==digest(old))throw new Error('分支草稿已变化，请重试');inputQueue.store.put(key,next);
    }return current();
  }
  if(method==='draft.send'){
    const key=`draft:${session.sessionId}`,payload=inputQueue.store.get<InputPayload&{submissionId?:string}>(key)?.value;
    if(!payload){if(inputQueue.store.get(`draft-consumed:${session.sessionId}`))return current();throw new Error('分支草稿不存在');}
    validateCapturedInput(payload);
    const intentId='draft:'+String(payload.submissionId||digest(payload)),identity=digest(payload);
    inputQueue.store.transaction(()=>{if(!inputQueue.accepted(intentId,identity))inputQueue.add(payload,intentId,identity);inputQueue.store.remove(key);inputQueue.store.put(`draft-consumed:${session.sessionId}`,{intentId});});queueChanged();return current();
  }
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
    const sendEpoch=queueEpoch;
    if(missingModelId)throw new Error('历史型号不可用，请重新配置并通过连接测试');
    if(stopping)throw new Error('正在停止，请等待终止回执');
    if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')await requireReadyModel(runtime,dataDir,session.model?`${session.model.provider}/${session.model.id}`:'');
    const queued=typeof input.queueId==='string'?inputQueue.read(input.queueId):undefined;if(queued&&(queued.state!=='dispatching'||queued.runId!==input.runId))throw new Error('排队消息交付身份不匹配');
    const payload=queued||await captureCapabilityInput(input),prompt=payload.text,attachments=payload.attachments;
    if(sendEpoch!==queueEpoch||stopping||disposed)throw new Error('消息交付已取消');
    for(const attachment of attachments){documentAttachments.set(attachment.path,attachment.hash);try{await registerAttachmentArtifact(attachment.path,attachment.image!==undefined,attachment.hash);}catch(error){if(!queued)throw error;session.sessionManager.appendCustomEntry('friend-pi.artifact.registration.unavailable',{runId,sourceHash:attachment.hash,pathHash:digest(attachment.path),reason:'legacy-frozen-input-has-no-byte-snapshot'});}}
    if(attachments.length)session.sessionManager.appendCustomEntry('friend-pi.attachments.v1',{v:1,runId:typeof input.runId==='string'?input.runId:runId,stage:'prepared',attachments:attachments.map(({text,image,...metadata})=>({...metadata,image:!!image}))});if(attachments.some(item=>item.image)&&!session.model?.input.includes('image'))throw new Error('当前型号不支持图片');
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
      activeGraphIds.clear();runGraphIds.clear();cancelRequested=false;authorityNotice='';correctionEligibleRun=runRequiresSwarm?runId:undefined;correctionEligibleGeneration=services.generation();swarmCorrectionPending=false;swarmCorrectionActive=false;
    }
    await applyAssignedRole();await ensureModelReady();lifecycleStatus='running';
    const images=attachments.flatMap(item=>item.image?[item.image]:[]);
    if(queued&&(input.admissionEpoch!==queueEpoch||stopping))throw new Error('消息交付已取消');
    const inputRecord:PendingInput={attachmentMetadata:attachments.map(({text,image,...metadata})=>({...metadata,image:!!image})),id:randomUUID(),queueId:queued?.id,text:prompt,combinedLength:combined.length,combinedHash:digest(combined),imageHash:imageIdentity(images),expectsStart:session.isIdle,runId};pendingInputs.push(inputRecord);
    if(queued)inputQueue.handoff(queued.id);
    // Native commands can request approval before emitting any agent event.
    publish('state',current());
    void session.prompt(combined,{images,streamingBehavior:input.inputMode==='steer'?'steer':'followUp',preflightResult:result=>{
      if(sendEpoch!==queueEpoch||stopping||disposed)throw new Error('消息交付已取消');
      if(result==='started'){inputRecord.preflightStarted=true;startedInputId=inputRecord.id;}
      if(result==='handled'){
        if(queued){session.sessionManager.appendCustomEntry('friend-pi.input.v1',{v:1,queueId:queued.id,runId:inputRecord.runId,handled:true,hash:digest(combined)});inputQueue.delivered(queued.id,inputRecord.runId);}
        const position=pendingInputs.indexOf(inputRecord);if(position>=0)pendingInputs.splice(position,1);if(session.isIdle&&!swarmBusy()&&!finiteJobs()){foregroundOpen=false;lifecycleStatus='completed';}queueChanged();
      }
    }}).then(()=>{if(inputRecord.expectsStart){const position=pendingInputs.findIndex(input=>input.id===inputRecord.id);if(position>=0)pendingInputs.splice(position,1);}publish('state',current());}).catch(error=>{const position=pendingInputs.findIndex(input=>input.id===inputRecord.id);if(position>=0)pendingInputs.splice(position,1);if(inputRecord.queueId)inputQueue.failed(inputRecord.queueId);if(sendEpoch===queueEpoch&&!disposed){foregroundOpen=rootExecutionBusy();lifecycleStatus='failed';publish('notice',{level:'error',message:publicError(error)});}publish('state',current());});
    return {accepted:true,sessionId:session.sessionId,runId};
  }
  if(method==='runtime'){const action=text(input.action);if(['goal.pause','goal.stop','goal.create','goal.resume'].includes(action)){queueEpoch++;cancelQueueResume();}if(['goal.create','goal.resume','goal.complete'].includes(action)){await applyAssignedRole(action==='goal.create');await ensureModelReady();}if(action==='goal.create'&&session.isIdle&&!swarmBusy()){const prior=services.currentGoal();if(prior&&['active','waiting','verifying'].includes(prior.status))throw new Error('当前已有运行目标');runId=randomUUID();process.env.FRIEND_PI_RUN_ID=runId;runStartedAt=Date.now();foregroundOpen=true;captureRunPolicy();await changeTracker?.begin(runId);baselineGraphIds.clear();for(const id of swarmGraphs.keys())baselineGraphIds.add(id);activeGraphIds.clear();runGraphIds.clear();cancelRequested=false;policyRevision++;}const previousAuthorisation=authorisedCorrectionResume;
    if(action==='goal.resume'){const goalId=object(input.input||{}).goalId,goal=typeof goalId==='string'?services.goals.read(goalId,services.context()):services.currentGoal();if(goal?.sourceRunId===runId&&correctedRun(runId))authorisedCorrectionResume={runId:runId!,generation:services.generation()+1};}
    let result:unknown;try{result=await services.dispatch(action,object(input.input||{}),services.context('user'));}catch(error){authorisedCorrectionResume=previousAuthorisation;throw error;}
    if(!['snapshot','read','list','status','logs'].includes(action.split('.').at(-1)!))publish('state',current());return result;}
  if(method==='workflow.generate'){if(executionMode!=='swarm'||planMode||!session.isIdle)throw new Error('请在闲置 Swarm 执行模式生成工作流');await ensureModelReady();const result=await services.context('user').complete('只返回JSON，结构为 {v:1,title,goal,maxWorkers:4,nodes:[{id,title,prompt,dependencies:[],mode:"read"或"write",writeScopes:[最窄实际目录]}]}; 写入节点writeScopes非空，读取节点可省略。至多64节点，无脚本，条件用结构化谓词。目标：'+text(input.prompt),{maxTokens:6000});const body=result.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');return requestPlugin(bus,'workflow','create',{definition:object(JSON.parse(body))},1000,'user');}
  if(method==='stop'){
    queueEpoch++;queueResumeAuthorised=false;inputQueue.pause(true);cancelQueueResume();session.clearQueue();for(const item of inputQueue.snapshot().items)if(item.state==='dispatching')inputQueue.failed(item.id);
    cancelRequested=true;correctionEligibleRun=undefined;authorisedCorrectionResume=undefined;swarmCorrectionPending=false;swarmCorrectionActive=false;permissionEpoch++;stopping=true;cancelTerminalRequests();lifecycleStatus='stopping';publish('state',current());
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
    queueEpoch++;cancelQueueResume();
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
    const pending=dialogs.get(text(input.id));if(!pending)throw new Error('交互已结束');
    if(pending.batch){const batch=pending.batch;if(input.v!==1||input.generation!==batch.generation||input.runId!==batch.runId||runId!==batch.runId||stopping||disposed)throw new Error('问题所属运行已失效');const first=[...dialogs.values()].find(item=>item.batch);if(first!==pending)throw new Error('请先处理前一组问题');const answers=input.cancelled===true?undefined:questionAnswers(batch,input.answers);dialogs.delete(batch.id);pending.cleanup?.();pending.resolve(answers);publish('dialog.closed',{id:batch.id,questionReceipt:{generation:batch.generation,runId:batch.runId,status:input.cancelled===true?'cancelled':'answered'}});return {ok:true,status:input.cancelled===true?'cancelled':'answered'};}
    clearTimeout(pending.timer);dialogs.delete(String(input.id));pending.resolve(input.cancelled?undefined:input.confirmed!==undefined?Boolean(input.confirmed):input.value);return {ok:true};
  }
  if(method==='provider.save'||method==='provider.refresh'){
    if(!session.isIdle||swarmBusy())throw new Error('请先停止当前执行，再修改供应商配置');
    const provider=method==='provider.save'?await saveProviderConfiguration(runtime,dataDir,input):typeof input.provider==='string'?input.provider:undefined;await runtime.refresh({allowNetwork:false});
    if(method==='provider.save'&&process.env.FRIEND_PI_DESKTOP_MANAGED!=='1'){await session.setModel(selectedModel(String(provider)+'/'+text(input.modelId)));}else if(session.model){const latest=runtime.getModel(session.model.provider,session.model.id);if(latest)await session.setModel(latest);}
    return {...current(),...await modelState()};
  }
  if(method==='rename'){session.setSessionName(text(input.name,'名称',200));return current();}
  if(method==='shutdown'){inputQueue?.pause(true);await shutdown();return {ok:true};}
  throw new Error(`未知操作：${method}`);
}
function publicError(error:unknown):string{return (error instanceof Error?error.message:String(error)).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[密钥已隐藏]');}
async function shutdown(){await external.dispose();if(disposed)return;correctionEligibleRun=undefined;swarmCorrectionPending=false;swarmCorrectionActive=false;if(session)services.beforeQuit();cancelTerminalRequests();if(session&&!session.isIdle||swarmBusy())lifecycleStatus='interrupted';disposed=true;for(const pending of dialogs.values()){clearTimeout(pending.timer);pending.resolve(undefined);}dialogs.clear();session?.abortCompaction();await session?.abort();await changeTracker?.settle(runId,lifecycleStatus,session?.sessionManager.getBranch().findLast(entry=>entry.type==='message')?.id);await changeTracker?.flush();if(session)await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session?.dispose();inputQueue?.dispose();services.dispose();clearInterval(foregroundPulse);if(session)foregroundStore.remove(`foreground:${session.sessionId}`);foregroundStore.close();artifactStore.close();businessStore.close();bus.clear();}
process.on('message',raw=>{if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.type==='terminal.waiting'||request.type==='terminal.admitted'){const id=String(request.id),pending=terminalRequests.get(id);if(pending&&(request.type==='terminal.admitted'&&pending.phase!=='admitted'||request.type==='terminal.waiting'&&pending.phase==='transport')){clearTimeout(pending.timer);pending.phase=request.type==='terminal.waiting'?'waiting':'admitted';pending.timer=terminalDeadline(id,pending.phase==='waiting'?125000:25000);}return;}if(request.type==='terminal.response'){const pending=terminalRequests.get(String(request.id));if(pending){pending.cleanup();terminalRequests.delete(String(request.id));request.error?pending.reject(new Error(String(request.error))):pending.resolve(request.result);}return;}if(request.type!=='request')return;void handle(text(request.method),object(request.input||{})).then(result=>{output({type:'response',id:request.id,result},request.method==='shutdown'?()=>process.disconnect?.():undefined);}).catch(error=>output({type:'response',id:request.id,error:publicError(error)}));});
process.on('disconnect',()=>{void shutdown();});
async function initializeSupervised(){if(process.env.FRIEND_PI_SUPERVISED==='1')await new Promise<void>(resolveReady=>{const ready=(raw:unknown)=>{if(raw&&typeof raw==='object'&&object(raw).type==='supervisor.ready'){process.off('message',ready);resolveReady();}};process.on('message',ready);output({type:'supervisor.await'});});await initialize();}
void initializeSupervised().catch(error=>{output({type:'fatal',error:publicError(error)});process.exitCode=1;setImmediate(()=>process.disconnect?.());});
