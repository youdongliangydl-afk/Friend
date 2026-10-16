import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
function fixture(){
  const callbacks=source.slice(source.indexOf('  const commitState='),source.indexOf('  const refresh='));
  const navigation=source.slice(source.indexOf('  const openSession=async'),source.indexOf('  useEffect(()=>{if(!requestedSession'));
  const calls:any[]=[],errors:string[]=[];let resolve!:(value:any)=>void,reject!:(error:Error)=>void;
  const ctx:any={useCallback:(fn:any)=>fn,EMPTY:{projects:[],sessions:[],models:[],providers:[]},stateRef:{current:{revision:10,current:{sessionId:'old',messages:['old history']}}},navigationState:{current:undefined},navigationEpoch:{current:0},lastSubmitted:{current:null},submissionSettled:()=>false,
    setState(value:any){ctx.visible=value;},setNavigating(value:boolean){ctx.navigating=value;},setLocalRunning(){},setNotice(){},setMaterial(){},restoreDialogs(){},deferredDialogs:{current:new Set()},notice:null,navigating:false,sending:false,sessionId:'old',sendLock:{current:false},allocationLock:{current:false},migratingDraft:{current:false},errorText:String,report:(message:string)=>errors.push(message),window:{friendPi:{request(method:string,input:any){calls.push({method,input});return new Promise((done,fail)=>{resolve=done;reject=fail;});}}}};
  ctx.visible=ctx.stateRef.current;vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(callbacks+navigation+'\nglobalThis.receive=applyState;globalThis.open=openSession;globalThis.traverse=traverseSession;'),ctx);
  return {ctx,calls,errors,resolve(value:any){resolve(value);},reject(error:Error){reject(error);}};
}
test('session navigation keeps the previous history until the response and applies the newest buffered snapshot once',async()=>{
  const f=fixture(),pending=f.ctx.open('new');assert.equal(f.ctx.navigating,true);
  f.ctx.receive({revision:12,current:{sessionId:'new',messages:['complete new history']}});f.ctx.receive({revision:11,current:{sessionId:'old',messages:[]}});
  assert.equal(f.ctx.visible.current.sessionId,'old');assert.deepEqual(f.ctx.visible.current.messages,['old history']);
  f.resolve({revision:13,current:{sessionId:'new',messages:['complete new history','latest message']}});await pending;
  assert.equal(f.ctx.visible.current.sessionId,'new');assert.equal(f.ctx.visible.current.messages.length,2);assert.equal(f.ctx.navigating,false);assert.equal(f.ctx.navigationState.current,undefined);
  assert.deepEqual(f.calls.map(call=>call.method),['session.open'],'navigation must not trigger a redundant app.state model refresh');
  f.ctx.receive({revision:12,current:{sessionId:'old',messages:[]}});assert.equal(f.ctx.visible.current.sessionId,'new');
});
test('failed navigation preserves the visible session, releases the transition and accepts later updates',async()=>{
  const f=fixture(),pending=f.ctx.open('missing');f.reject(new Error('could not open'));await pending;
  assert.equal(f.ctx.visible.current.sessionId,'old');assert.equal(f.ctx.navigating,false);assert.deepEqual(f.errors,['Error: could not open']);
  f.ctx.receive({revision:11,current:{sessionId:'old',messages:['still intact']}});assert.equal(f.ctx.visible.current.messages[0],'still intact');
});
test('history traversal buffers early state broadcasts and clicking the selected session makes no request',async()=>{
  const f=fixture();await f.ctx.open('old');assert.equal(f.calls.length,0);const pending=f.ctx.traverse(-1);
  f.ctx.receive({revision:14,current:{sessionId:'previous',messages:['history']}});assert.equal(f.ctx.visible.current.sessionId,'old');f.resolve({revision:13,current:{sessionId:'previous',messages:[]}});await pending;
  assert.equal(f.ctx.visible.current.messages[0],'history');assert.deepEqual(f.calls.map(call=>call.method),['navigation.go']);
});
