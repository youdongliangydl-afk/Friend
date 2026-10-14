import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionComposer,type ComposerSnapshot} from '../apps/desktop/src/renderer/SessionComposer.js';
import {submissionSettled} from '../apps/desktop/src/renderer/submission-state.js';

function fixture(){
 const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8'),begin=source.indexOf('  const applyState=useCallback('),end=source.indexOf('\n  const refresh=',begin);
 assert.ok(begin>=0&&end>begin);const initial={revision:1,current:{sessionId:'session',runId:'old',isRunning:false,lifecycleStatus:'completed'}};
 const ctx:any={EMPTY:{},stateRef:{current:initial},state:initial,localRunning:true,lastSubmitted:{current:{sessionId:'session',previousRunId:'old',accepted:false}},submissionSettled,useCallback:(callback:unknown)=>callback,setState:(state:unknown)=>{ctx.state=state;},setLocalRunning:(value:boolean)=>{ctx.localRunning=value;}};
 vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(source.slice(begin,end)+'\nglobalThis.applyState=applyState;'),ctx);return ctx;
}
const composer:ComposerSnapshot={sessionId:'session',epoch:1,draft:'next',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:false,permissionMode:'auto',permissionExplicit:true,mode:'swarm',plugins:['swarm'],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'准备就绪'};
test('actual applyState clears an unacknowledged native command indicator and unlocks composer modes',()=>{
 const f=fixture();f.applyState({revision:2,current:{sessionId:'session',runId:'command',isRunning:false,lifecycleStatus:'completed'}});
 assert.equal(f.lastSubmitted.current.accepted,false);assert.equal(f.localRunning,false);
 const html=renderToStaticMarkup(React.createElement(SessionComposer,{value:{...composer,running:f.localRunning||f.state.current.isRunning},action:async()=>{}}));
 assert.doesNotMatch(html,/aria-label="停止当前任务"/);for(const button of html.match(/<button\b[^>]*data-agent-mode="[^"]+"[^>]*>/g)||[])assert.doesNotMatch(button,/disabled=/);
});
test('actual applyState keeps old-run terminal and other-session states from releasing a new submission',()=>{
 for(const patch of [{sessionId:'session',runId:'old'},{sessionId:'other',runId:'command'}]){
  const f=fixture();f.applyState({revision:2,current:{...patch,isRunning:false,lifecycleStatus:'completed'}});assert.equal(f.localRunning,true);
 }
 const f=fixture();f.lastSubmitted.current.runId='command';f.applyState({revision:2,current:{sessionId:'session',runId:'unrelated',isRunning:false,lifecycleStatus:'completed'}});assert.equal(f.localRunning,true);
});
test('actual applyState preserves busy queued work and rejects an older terminal revision',()=>{
 const f=fixture();f.applyState({revision:3,current:{sessionId:'session',runId:'command',isRunning:true,lifecycleStatus:'completed'}});assert.equal(f.localRunning,true);
 f.applyState({revision:2,current:{sessionId:'session',runId:'command',isRunning:false,lifecycleStatus:'completed'}});assert.equal(f.localRunning,true);assert.equal(f.state.current.isRunning,true);
 f.applyState({revision:4,current:{sessionId:'session',runId:'command',isRunning:false,lifecycleStatus:'stopped'}});assert.equal(f.localRunning,false);
});
test('actual send finally reconciles a fast command terminal before the dispatch acknowledgement',async()=>{
 for(const throughEvent of [true,false]){
  const f=fixture(),stored=new Map<string,string>();let acknowledge!:(value:unknown)=>void;
  Object.assign(f,{sendLock:{current:false},allocationLock:{current:false},navigating:false,migratingDraft:{current:false},draftRef:{current:'/swarm snapshot'},attachmentsRef:{current:[]},activeSession:{archived:false},selectedModel:{ready:true},sessionId:'session',ownerKey:'session',attachments:[],navigationEpoch:{current:1},running:false,mode:'swarm',planMode:false,permissionMode:'auto',permissionExplicit:true,ownerRef:{current:'session'},followScroll:{},hasQueueIntent:()=>false,setSending:()=>{},setSubmissionRevision:()=>{},setNotice:()=>{},setTools:()=>{},setLive:()=>{},setDraft:()=>{},setAttachments:()=>{},setDraftOwner:()=>{},report:(message:string)=>assert.fail(message),localStorage:{setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)},window:{friendPi:{request:()=>new Promise(done=>{acknowledge=done;})}}});
  const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8'),begin=source.indexOf('  const send=async()=>{'),end=source.indexOf('  const selectProject=',begin);
  vm.runInContext(stripTypeScriptTypes(source.slice(begin,end)+'\nglobalThis.send=send;'),f);const sending=f.send();
  const terminal={revision:2,current:{sessionId:'session',runId:'command',isRunning:false,lifecycleStatus:'completed'}};
  assert.equal(f.lastSubmitted.current.accepted,false);if(throughEvent)f.applyState(terminal);else f.stateRef.current=terminal;
  acknowledge({runId:'command'});await sending;assert.equal(f.localRunning,false);assert.equal(f.lastSubmitted.current.accepted,true);assert.equal(f.lastSubmitted.current.runId,'command');
 }
});

test('successful session recovery clears its stale error while failed recovery keeps the new failure visible',async()=>{
 const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
 for(const [name,endMarker] of [['newSession','  const selectedModelId='],['openSession','  const traverseSession='],['traverseSession','  useEffect(()=>{if(!requestedSession']] as const)for(const outcome of ['success','failure','new-warning']){
  const oldNotice={message:'old initialization timeout',error:true},newNotice={...oldNotice};
  const ctx:any={navigating:false,sending:false,allocationLock:{current:false},migratingDraft:{current:false},sendLock:{current:false},navigationEpoch:{current:0},deferredDialogs:{current:new Map()},projectId:'project',pendingModel:'model',permissionMode:'auto',ownerKey:'pending',notice:oldNotice,errorText:(error:Error)=>error.message,setNavigating:(value:boolean)=>{ctx.navigating=value;},setNotice:(value:any)=>{ctx.notice=typeof value==='function'?value(ctx.notice):value;},setDraftOwner:()=>{},applyState:()=>{},restoreDialogs:()=>{},setMaterial:()=>{},report:(message:string)=>{ctx.notice={message,error:true};}};
  const attempt=async()=>{if(outcome==='failure'){ctx.notice={message:'current recovery failed',error:true};throw Error('current recovery failed');}if(outcome==='new-warning')ctx.notice=newNotice;return {createdSessionId:'session',current:{sessionId:'session'}};};
  ctx.invoke=attempt;ctx.window={friendPi:{request:attempt}};vm.createContext(ctx);
  const begin=source.indexOf('  const '+name+'=async'),end=source.indexOf(endMarker,begin);assert.ok(begin>=0&&end>begin);
  vm.runInContext(stripTypeScriptTypes(source.slice(begin,end)+'\nglobalThis.recover='+name+';'),ctx);
  await ctx.recover(name==='traverseSession'?1:'session');
  if(outcome==='failure')assert.deepEqual(ctx.notice,{message:'current recovery failed',error:true});
  else assert.equal(ctx.notice,outcome==='new-warning'?newNotice:null,name+' clears only the old notice, preserving even a new notice with identical text');
  assert.equal(ctx.navigating,false);
 }
});
