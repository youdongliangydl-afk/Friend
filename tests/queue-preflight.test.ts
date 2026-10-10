import test from 'node:test';
import {readFileSync} from 'node:fs';
import {AgentSession} from '@earendil-works/pi-coding-agent';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const Session:any=AgentSession;
test('public Pi preflight cannot start after stop and handled input has a durable receipt',async()=>{
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const start=source.indexOf('preflightResult:result=>{');const end=source.indexOf('}}).then',start);
const callback='('+source.slice(start+'preflightResult:'.length,end+1)+')';
const callbackContext:any={attachments:[],sendEpoch:0,queueEpoch:0,stopping:false,disposed:false,inputRecord:{id:'input',runId:'B'},startedInputId:undefined};
vm.createContext(callbackContext);const preflight=vm.runInContext(callback,callbackContext);
let release!:(value:any)=>void;let reached!:()=>void;const handlerReached=new Promise<void>(resolve=>{reached=resolve;});const inputGate=new Promise<any>(resolve=>{release=resolve;});const events:string[]=[];
const pi:any={_isAgentRunActive:false,_compactionAbortController:undefined,_isEmittingAgentSettled:false,_baseSystemPromptOptions:{selectedTools:[]},promptTemplates:[],_pendingNextTurnMessages:[],_pendingToolNames:new Set(),model:{provider:'fake',id:'fake'},_modelRuntime:{hasConfiguredAuth:()=>true},_extensionRunner:{emitBeforeAgentStart:async()=>({systemPromptOptions:{selectedTools:[]},messages:[]})},_runInputHandlers:async()=>{reached();return await inputGate;},_expandSkillCommand:(text:string)=>text,_flushPendingBashMessages(){},_flushPendingCustomMessages(){},_findLastAssistantMessage(){},getActiveToolNames:()=>[],_normalizePromptImages:async()=>({images:[],hints:[]}),_preparePromptAndToolLoadout(){},_recordSelection(){},agent:{abort:()=>events.push('agent.abort'),prompt:async()=>events.push('unexpected agent.prompt')},_handlePostAgentRun:async()=>false,_runBeforeSettleBoundary:async()=>false,_emitAgentSettled:async()=>{pi._isAgentRunActive=false;},abortRetry(){},abortCompaction(){},abortBranchSummary(){},get isStreaming(){return this._isAgentRunActive;},get isIdle(){return !this._isAgentRunActive;},_runAgentPrompt:Session.prototype._runAgentPrompt,waitForIdle:Session.prototype.waitForIdle};
const sending=Session.prototype.prompt.call(pi,'queued task',{preflightResult:preflight});const rejected=assert.rejects(sending,/消息交付已取消/);
await handlerReached;callbackContext.queueEpoch++;await Session.prototype.abort.call(pi);events.push('stop resolved');release({text:'queued task',images:[]});await rejected;
assert.deepEqual(events,['agent.abort','stop resolved']);

const receipts:any[]=[];let delivered=false;const record={id:'command-input',runId:'C'};
Object.assign(callbackContext,{sendEpoch:2,queueEpoch:2,inputRecord:record,queued:{id:'queue-command'},combined:'/goal read',session:{sessionManager:{appendCustomEntry:(type:string,data:any)=>receipts.push({type,data})},isIdle:true},inputQueue:{delivered:(id:string,runId:string)=>{delivered=id==='queue-command'&&runId==='C';}},pendingInputs:[record],swarmBusy:()=>false,finiteJobs:()=>false,foregroundOpen:true,lifecycleStatus:'running',queueChanged:()=>{},digest:()=> 'memory-hash'});
preflight('handled');assert.equal(delivered,true);assert.equal(receipts[0].data.handled,true);assert.equal(callbackContext.pendingInputs.length,0);assert.equal(callbackContext.lifecycleStatus,'completed');

});
