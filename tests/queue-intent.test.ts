import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
test('an unacknowledged queue submission reconciles by intent even after the task becomes idle',async()=>{
const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
const start=source.indexOf('  const send=async()=>{');
const end=source.indexOf('  const selectProject=',start);
const send=stripTypeScriptTypes(source.slice(start,end)+'\nglobalThis.send=send;');
const helper=stripTypeScriptTypes(readFileSync('apps/desktop/src/renderer/queue-intent.ts','utf8').replaceAll('export function','function'));
const local=new Map<string,string>(),requests:any[]=[];
const ctx:any={errorText:(e:unknown)=>String(e),crypto:webcrypto,localStorage:{getItem:(key:string)=>local.get(key)||null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)},sendLock:{current:false},allocationLock:{current:false},navigating:false,migratingDraft:{current:false},draftRef:{current:'queued B, retained after lost add reply'},attachmentsRef:{current:[]},activeSession:{archived:false},selectedModel:{ready:true},setSending:()=>{},setSubmissionRevision:()=>{},setNotice:()=>{},sessionId:'native',ownerKey:'native',attachments:[],lastSubmitted:{},navigationEpoch:{current:1},running:false,state:{current:{sessionId:'native',isRunning:false,queue:{items:[]}}},setLocalRunning:()=>{},setTools:()=>{},setLive:()=>{},followScroll:{},window:{friendPi:{request:async(method:string,input:any)=>{requests.push({method,input});return {};}}},mode:'single',planMode:false,permissionMode:'auto',permissionExplicit:true,ownerRef:{current:'native'},setDraft:()=>{},setAttachments:()=>{},setDraftOwner:()=>{},report:()=>{}};
ctx.applyState=()=>{};vm.createContext(ctx);vm.runInContext(helper,ctx);vm.runInContext(send,ctx);
// Add reply was lost, and B has already been consumed. Its client intent remains.
const intent=ctx.queueIntent('native',{text:ctx.draftRef.current,attachments:[],mode:'single',planMode:false});
await ctx.send();
assert.equal(requests.length,1);assert.equal(requests[0].method,'session.queue');assert.equal(requests[0].input.intentId,intent.id);
assert.equal(local.has(intent.key),false,'acknowledged intent is cleared after reconciliation');
requests.length=0;ctx.state.current.sideDraft={text:ctx.draftRef.current};let loseReply=true;
ctx.window.friendPi.request=async(method:string,input:any)=>{requests.push({method,input});if(loseReply){loseReply=false;throw new Error('reply lost after durable enqueue');}return {};};
await ctx.send();ctx.state.current.sideDraft=undefined;await ctx.send();
assert.deepEqual(requests.map(r=>r.method),['session.queue','session.queue']);assert.equal(requests[0].input.fromSideDraft,true);assert.equal(requests[1].input.fromSideDraft,false);assert.equal(requests[0].input.intentId,requests[1].input.intentId);

});
test('pending first-session submission rejects stale draft and send actions without retaining submitted text',async()=>{
 const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
 const send=source.slice(source.indexOf('  const send=async()=>{'),source.indexOf('  const selectProject='));
 const actionStart=source.indexOf('  const composerAction=async(action:ComposerAction)=>{');
 const action=source.slice(actionStart,source.indexOf("    else if(action.type==='queueUi')",actionStart))+'\n  };';
 const local=new Map<string,string>(),requests:any[]=[];let release!:()=>void;
 const pending=new Promise<void>(resolve=>release=resolve);
 const ctx:any={errorText:String,EMPTY:{},crypto:webcrypto,localStorage:{getItem:(key:string)=>local.get(key)||null,setItem:(key:string,value:string)=>local.set(key,value),removeItem:(key:string)=>local.delete(key)},sendLock:{current:false},allocationLock:{current:false},navigating:false,migratingDraft:{current:false},draftRef:{current:'first A'},attachmentsRef:{current:[]},activeSession:{archived:false},activeMemberRef:{current:null},selectedModel:{ready:true},selectedModelId:'fixture',pendingThinking:'off',projectId:'',setSending:()=>{},setSubmissionRevision:()=>{},setNotice:()=>{},sessionId:'',ownerKey:'temporary',attachments:[],lastSubmitted:{},navigationEpoch:{current:1},running:false,state:{current:{queue:{items:[]}}},setState:()=>{},setLocalRunning:()=>{},setTools:()=>{},setLive:()=>{},followScroll:{},mode:'single',planMode:false,permissionMode:'auto',permissionExplicit:true,ownerRef:{current:'temporary'},setDraft:(text:string)=>{ctx.draftRef.current=text;},setAttachments:()=>{},setDraftOwner:()=>{},report:(e:string)=>{throw Error(e);},window:{friendPi:{request:async(method:string,input:any)=>{requests.push({method,input});if(method==='session.new'){await pending;return {current:{sessionId:'native'}};}return {};}}}};
 let completions=0;ctx.setSubmissionRevision=()=>{completions++;};
 ctx.applyState=()=>{};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(readFileSync('apps/desktop/src/renderer/queue-intent.ts','utf8').replaceAll('export function','function')),ctx);
 vm.runInContext(stripTypeScriptTypes(send+action+'\nglobalThis.send=send;globalThis.action=composerAction;'),ctx);
 const submitted=ctx.send();
 await ctx.action({type:'draft',sessionId:'',epoch:1,value:'first A followed by B'});
 const materialStart=source.indexOf('const add=(event:Event)=>{');
 const material=source.slice(materialStart,source.indexOf(";window.addEventListener('friend-pi:file-open'",materialStart));
 let blockedMaterial=false;ctx.report=()=>{blockedMaterial=true;};
 vm.runInContext(stripTypeScriptTypes(material+';globalThis.addMaterial=add;'),ctx);
 ctx.addMaterial({detail:{text:'material queued during ACK'}});assert.equal(blockedMaterial,true);
 await ctx.send();assert.equal(ctx.draftRef.current,'first A');assert.equal(requests.length,1);assert.equal(completions,0,'a busy rejection must not release the active submission');
 release();await submitted;
 assert.equal(requests[1].method,'session.send');assert.equal(requests[1].input.text,'first A');assert.equal(ctx.draftRef.current,'');assert.equal(JSON.parse(local.get('friend-pi.draft.v1:native')!).text,'');
 ctx.sessionId='native';ctx.ownerKey='native';ctx.ownerRef.current='native';ctx.running=true;
 await ctx.action({type:'draft',sessionId:'native',epoch:1,value:'new B'});await ctx.send();
 assert.equal(requests[2].method,'session.queue');assert.equal(requests[2].input.text,'new B');assert.equal(requests.length,3);
 const completed=completions;ctx.selectedModel.ready=false;ctx.draftRef.current='blocked by changed readiness';await ctx.send();assert.equal(completions,completed+1,'host preflight rejection completes the forwarded action');assert.equal(requests.length,3);assert.equal(ctx.draftRef.current,'blocked by changed readiness');
});
test('native composer holds a local submission lock until the host publishes its completion',async()=>{
 const source=readFileSync('apps/desktop/src/renderer/SessionComposer.tsx','utf8');
 const callbackStart=source.indexOf('onSnapshot(next=>{')+'onSnapshot('.length;
 const callback=source.slice(callbackStart,source.indexOf(');},[]);',callbackStart));
 const actionStart=source.indexOf('  const action=async(input:ComposerAction)=>{',callbackStart);
 const action=source.slice(actionStart,source.indexOf('  return snapshot?',actionStart));
 const bridge:any[]=[],stored:any[]=[];
 const initial={sessionId:'native',epoch:1,revision:1,submissionRevision:0,draft:'A',attachments:[],sending:false,ready:true,archived:false,navigating:false,token:'bound'};
 const ctx:any={latest:{current:initial},localDraft:{current:null},localQueueUi:{current:null},pending:{current:false},revision:{current:1},submitting:{current:null},localStorage:{setItem:(...args:any[])=>stored.push(args)},setSnapshot:(next:any)=>{ctx.latest.current=next;},window:{friendComposer:{action:async(input:any)=>{bridge.push(input);return {ok:true};}}}};
 ctx.applyState=()=>{};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes('globalThis.snapshot='+callback+';\n'+action+'globalThis.action=action;'),ctx);
 const nativeAction=ctx.action;ctx.action=(input:any)=>nativeAction({sessionId:ctx.latest.current.sessionId,epoch:ctx.latest.current.epoch,...input});
 await ctx.action({type:'send',text:'A'});
 await ctx.action({type:'draft',value:'A followed by B'});
 assert.equal(bridge.length,1);assert.equal(stored.length,0);assert.equal(ctx.latest.current.draft,'A');assert.equal(ctx.latest.current.sending,true);
 // The IPC reply acknowledges dispatch only. An older idle snapshot must not unlock input.
 ctx.snapshot({...initial,revision:2});assert.equal(ctx.latest.current.sending,true);
 ctx.snapshot({...initial,revision:3,sending:true});
 ctx.snapshot({...initial,revision:4,submissionRevision:1,draft:''});
 assert.equal(ctx.latest.current.sending,false);assert.equal(ctx.latest.current.draft,'');
 await ctx.action({type:'draft',value:'new B'});assert.equal(ctx.latest.current.draft,'new B');
 await ctx.action({type:'send',text:'new B'});
 ctx.snapshot({...initial,revision:5,submissionRevision:2,draft:'new B',notice:'request failed'});
 assert.equal(ctx.latest.current.sending,false);assert.equal(ctx.latest.current.draft,'new B');
 for(const patch of [{draft:''},{ready:false},{archived:true},{navigating:true}]){
  ctx.latest.current={...initial,...patch};const count:number=bridge.length;
  await ctx.action({type:'send',text:ctx.latest.current.draft});
  assert.equal(bridge.length,count);assert.equal(ctx.submitting.current,null);assert.equal(ctx.latest.current.sending,false);
 }
 let rejectOld!:(error:Error)=>void;ctx.latest.current={...initial};
 ctx.window.friendComposer.action=()=>new Promise((_,reject)=>rejectOld=reject);
 const old=ctx.action({type:'send',text:'A'}).catch(()=>{});
 ctx.snapshot({...initial,sessionId:'new-owner',epoch:2,revision:6});
 ctx.window.friendComposer.action=async()=>({ok:true});await ctx.action({type:'send',text:'new-owner message'});
 const ticket=ctx.submitting.current;rejectOld(Error('late old-owner IPC failure'));await old;
 assert.equal(ctx.submitting.current,ticket);assert.equal(ctx.latest.current.sending,true,'old errors cannot unlock a newer owner submission');
});
