import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {AgentSession} from '@earendil-works/pi-coding-agent';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const Session:any=AgentSession;
test('public Pi preflight cannot start after stop and handled input has a durable receipt',async()=>{
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const start=source.indexOf('preflightResult:result=>{',source.indexOf('void session.prompt(combined'));assert.ok(start>=0,'user input preflight must be found');const end=source.indexOf('}}).then',start);
const callback='('+source.slice(start+'preflightResult:'.length,end+1)+')';
const guardStart=source.indexOf('const assertSendOwned=',source.indexOf("  if(method==='send'){")),guardEnd=source.indexOf('\n',guardStart);assert.ok(guardStart>=0&&guardEnd>guardStart);
const pauseStart=source.indexOf('const pauseUnstartedGoal=',guardStart),pauseEnd=source.indexOf('\n',pauseStart);assert.ok(pauseStart>=0&&pauseEnd>pauseStart,'the actual unstarted Goal helper must be found');
const pausedGoals:string[]=[],cancelledGoals:string[]=[],notices:any[]=[];
const callbackContext:any={submittedGoal:undefined,goal:undefined,services:{currentGoal:()=>callbackContext.goal,context:()=>({}),goals:{setState:(status:string)=>{pausedGoals.push(callbackContext.goal.id);callbackContext.goal={...callbackContext.goal,status};}},cancelGoalWake:(id:string)=>cancelledGoals.push(id)},publish:(type:string,data:any)=>notices.push({type,data}),approvedExecution:undefined,attachments:[],sendEpoch:0,queueEpoch:0,stopping:false,disposed:false,inputRecord:{id:'input',runId:'B'},startedInputId:undefined};
vm.createContext(callbackContext);const preflight=vm.runInContext(stripTypeScriptTypes(source.slice(guardStart,guardEnd)+'\n'+source.slice(pauseStart,pauseEnd)+'\n'+callback),callbackContext);
let release!:(value:any)=>void;let reached!:()=>void;const handlerReached=new Promise<void>(resolve=>{reached=resolve;});const inputGate=new Promise<any>(resolve=>{release=resolve;});const events:string[]=[];
const pi:any={_isAgentRunActive:false,_compactionAbortController:undefined,_isEmittingAgentSettled:false,_baseSystemPromptOptions:{selectedTools:[]},promptTemplates:[],_pendingNextTurnMessages:[],_pendingToolNames:new Set(),model:{provider:'fake',id:'fake'},_modelRuntime:{hasConfiguredAuth:()=>true},_extensionRunner:{emitBeforeAgentStart:async()=>({systemPromptOptions:{selectedTools:[]},messages:[]})},_runInputHandlers:async()=>{reached();return await inputGate;},_expandSkillCommand:(text:string)=>text,_flushPendingBashMessages(){},_flushPendingCustomMessages(){},_findLastAssistantMessage(){},getActiveToolNames:()=>[],_normalizePromptImages:async()=>({images:[],hints:[]}),_preparePromptAndToolLoadout(){},_recordSelection(){},agent:{abort:()=>events.push('agent.abort'),prompt:async()=>events.push('unexpected agent.prompt')},_handlePostAgentRun:async()=>false,_runBeforeSettleBoundary:async()=>false,_emitAgentSettled:async()=>{pi._isAgentRunActive=false;},abortRetry(){},abortCompaction(){},abortBranchSummary(){},get isStreaming(){return this._isAgentRunActive;},get isIdle(){return !this._isAgentRunActive;},_runAgentPrompt:Session.prototype._runAgentPrompt,waitForIdle:Session.prototype.waitForIdle};
const sending=Session.prototype.prompt.call(pi,'queued task',{preflightResult:preflight});const rejected=assert.rejects(sending,/消息交付已取消/);
await handlerReached;callbackContext.queueEpoch++;await Session.prototype.abort.call(pi);events.push('stop resolved');release({text:'queued task',images:[]});await rejected;
assert.deepEqual(events,['agent.abort','stop resolved']);

const receipts:any[]=[];let delivered=false;const record={id:'command-input',runId:'C'};
Object.assign(callbackContext,{sendEpoch:2,queueEpoch:2,inputRecord:record,queued:{id:'queue-command'},combined:'/goal read',session:{sessionManager:{appendCustomEntry:(type:string,data:any)=>receipts.push({type,data})},isIdle:true},inputQueue:{delivered:(id:string,runId:string)=>{delivered=id==='queue-command'&&runId==='C';}},pendingInputs:[record],swarmBusy:()=>false,finiteJobs:()=>false,foregroundOpen:true,lifecycleStatus:'running',queueChanged:()=>{},digest:()=> 'memory-hash'});
preflight('handled');assert.equal(delivered,true);assert.equal(receipts[0].data.handled,true);assert.equal(callbackContext.pendingInputs.length,0);assert.equal(callbackContext.lifecycleStatus,'completed');assert.deepEqual(pausedGoals,[],'ordinary handled input does not change Goal metadata');

const goal={id:'submitted-goal',objective:'Original submitted objective',status:'active'};
const prepareGoal=()=>{const record={id:'goal-input',runId:'D'};Object.assign(callbackContext,{submittedGoal:{...goal},goal:{...goal},inputRecord:record,queued:undefined,pendingInputs:[record],sendEpoch:3,queueEpoch:3});return record;};
prepareGoal();preflight('handled');assert.deepEqual(pausedGoals,['submitted-goal']);assert.deepEqual(cancelledGoals,['submitted-goal']);assert.equal(callbackContext.goal.status,'paused');assert.equal(notices.at(-1).type,'notice');assert.match(notices.at(-1).data.message,/首轮输入已被扩展处理/);
for(const change of ['objective','identity','started','epoch']){
 const record:any=prepareGoal();if(change==='objective')callbackContext.goal.objective='Newer user objective';if(change==='identity')callbackContext.goal.id='replacement-goal';if(change==='started')record.preflightStarted=true;if(change==='epoch')callbackContext.queueEpoch++;
 if(change==='epoch')assert.throws(()=>preflight('handled'),/消息交付已取消/);else preflight('handled');
 assert.equal(callbackContext.goal.status,'active',change+' cannot pause newer or already started Goal execution');assert.deepEqual(pausedGoals,['submitted-goal']);assert.deepEqual(cancelledGoals,['submitted-goal']);
}

});
