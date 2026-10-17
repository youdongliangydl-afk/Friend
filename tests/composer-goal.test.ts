import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {asObject,errorText} from '../apps/desktop/src/renderer/types.js';
import {goalDraftInput,unfinishedGoal} from '../apps/desktop/src/renderer/goal-model.js';
const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
const action=source.slice(source.indexOf('  const composerAction=async(action:ComposerAction)=>{'),source.indexOf('  useEffect(()=>{setMemberRoute',source.indexOf('  const composerAction=async')));
function fixture(){
 const requests:any[]=[],sends:any[]=[],goal={id:'g',revision:3,objective:'原目标',status:'paused'};
 const ctx:any={asObject,errorText,goalDraftInput,unfinishedGoal,activeMemberRef:{current:null},sessionId:'s',navigationEpoch:{current:3},sendLock:{current:false},goalActionLock:{current:false},composerConfiguration:{current:null},ownerKey:'s',ownerRef:{current:'s'},currentPlugins:[],planMode:false,mode:'single',setConfigurationBusy(value:boolean){ctx.configurationBusy=value;},setPlanMode(value:boolean){ctx.planMode=value;},setMode(value:string){ctx.mode=value;},applyState(value:any){ctx.stateRef.current=value;},report(){},goalDraftRef:{current:false},navigating:false,sending:false,running:false,activeSession:{archived:false},selectedModel:{ready:true},stateRef:{current:{current:{sessionId:'s',runtime:{goal}}}},draftRef:{current:''},composer:{current:null},viewRef:{current:{active:'conversation'}},setGoalDraft(value:boolean){ctx.goalDraft=value;},setDraft(value:string){ctx.draft=value;},setGoalReplacement(value:any){ctx.replacement=value;},setSubmissionRevision(){},setGoalOpen(value:any){ctx.editor=value;},send:async(input:any)=>{sends.push(input);},refresh:async()=>{},window:{friendPi:{request:async(method:string,input:any)=>{requests.push({method,input});}}}};
 vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(action+'\nglobalThis.act=composerAction;'),ctx);
 const act=(type:string,value?:unknown,text?:string)=>ctx.act({type,value,text,sessionId:'s',epoch:3});return {ctx,requests,sends,act,goal};
}
test('Goal button and slash command enter draft without creating a goal or changing execution configuration',async()=>{
 const f=fixture();await f.act('goal.draft',true);assert.equal(f.ctx.goalDraft,true);assert.equal(f.requests.length,0);assert.equal(f.sends.length,0);
 await f.act('goal.draft',false);await f.act('send',undefined,'/goal');assert.equal(f.ctx.goalDraft,true);assert.equal(f.ctx.draft,'');assert.equal(f.sends.length,0);
 await f.act('draft','/goal 复核项目');assert.equal(f.ctx.draft,'复核项目');assert.equal(f.requests.length,0);
});
test('plain send remains plain; Goal send binds the first user input without separate runtime wake',async()=>{
 const f=fixture();await f.act('send',undefined,'普通消息');assert.equal(f.sends.length,1);assert.equal(f.sends[0],undefined);
 f.ctx.stateRef.current.current.runtime.goal=null;await f.act('goal.draft',true);await f.act('send',undefined,'持续目标');assert.equal(f.sends[1].objective,'持续目标');assert.equal(f.requests.length,0);
 await f.act('send',undefined,'   ');assert.equal(f.sends.length,2);
});
test('unfinished replacement previews exact id/revision and retains the draft before confirmation',async()=>{
 const f=fixture();await f.act('goal.draft',true);await f.act('send',undefined,'新目标');assert.equal(f.sends.length,0);assert.equal(f.ctx.draft,'新目标');assert.equal(f.ctx.replacement.previous,'原目标');assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.replacement.goal)),{objective:'新目标',replace:true,expectedGoalId:'g',expectedRevision:3});assert.equal(f.requests.length,0);
 f.ctx.replacement=null;assert.equal(f.ctx.draft,'新目标');assert.equal(f.ctx.goalDraft,true);
});
test('Goal lifecycle mutations bind the current session and revision while a model turn is running',async()=>{
 const f=fixture();f.ctx.running=true;await f.act('goal',{action:'goal.set',input:{goalId:'g',expectedRevision:3,status:'paused'}});await f.act('goal',{action:'goal.clear',input:{goalId:'g',expectedRevision:3}});
 assert.deepEqual(f.requests.map(r=>[r.method,r.input.action]),[['runtime.call','goal.set'],['runtime.call','goal.clear']]);assert.equal(f.requests[0].input.sessionId,'s');assert.equal(f.requests.some(r=>r.method==='session.abort'),false);
 await assert.rejects(f.act('goal',{action:'goal.set',input:{goalId:'g',expectedRevision:2,status:'active'}}),/当前目标已变化/);
 await assert.rejects(f.ctx.act({type:'goal',sessionId:'other',epoch:3,value:{action:'goal.clear',input:{goalId:'g',expectedRevision:3}}}),/会话已切换/);
 f.ctx.activeSession.archived=true;await assert.rejects(f.act('goal',{action:'goal.clear',input:{goalId:'g',expectedRevision:3}}),/暂时不能修改/);
});
test('Goal command synchronous lock prevents duplicate mutation; failures release the lock',async()=>{
 const f=fixture();let reject!:(reason:Error)=>void;f.ctx.window.friendPi.request=()=>new Promise((_,no)=>reject=no);const input={action:'goal.set',input:{goalId:'g',expectedRevision:3,status:'paused'}};const first=f.act('goal',input);await assert.rejects(f.act('goal',input),/正在进行/);reject(new Error('连接失败'));await assert.rejects(first,/连接失败/);assert.equal(f.ctx.goalActionLock.current,false);
});

test('existing Plan toggle is acknowledged by the host before Goal resume can dispatch',async()=>{
 const f=fixture();let release!:(value:any)=>void;f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});if(method==='session.configure')return new Promise(done=>release=done);};
 const toggle=f.act('plan',true);assert.equal(f.ctx.configurationBusy,true);assert.equal(f.ctx.planMode,false);assert.equal(f.requests[0].method,'session.configure');assert.equal(f.requests[0].input.planMode,true);
 const resume=f.act('goal',{action:'goal.set',input:{goalId:'g',expectedRevision:3,status:'active'}});assert.equal(f.requests.length,1);
 release({current:{...f.ctx.stateRef.current.current,planMode:true}});await toggle;await resume;assert.equal(f.ctx.planMode,true);assert.equal(f.ctx.configurationBusy,false);assert.deepEqual(f.requests.map(r=>r.method),['session.configure','runtime.call']);
});
test('failed configuration leaves the visible Plan unchanged and cancels a waiting Goal resume',async()=>{
 const f=fixture();let reject!:(error:Error)=>void;f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});return new Promise((_,no)=>reject=no);};const toggle=f.act('plan',true);const resume=f.act('goal',{action:'goal.set',input:{goalId:'g',expectedRevision:3,status:'active'}});const rejected=assert.rejects(resume,/host refused/);reject(new Error('host refused'));await toggle;await rejected;assert.equal(f.ctx.planMode,false);assert.equal(f.requests.length,1);assert.equal(f.ctx.configurationBusy,false);
});
test('existing mode selection configures host and optional Swarm atomically while unallocated chats keep drafts',async()=>{
 const f=fixture();f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});return {current:{...f.ctx.stateRef.current.current,...input}};};await f.act('mode','team');assert.equal(f.requests.length,1);assert.equal(f.requests[0].input.executionMode,'team');assert.deepEqual(Array.from(f.requests[0].input.plugins),['swarm']);assert.equal(f.ctx.mode,'team');await f.act('mode','single');assert.equal(f.requests[1].input.executionMode,'single');assert.equal(f.requests[1].input.plugins,undefined);
 const empty=fixture();empty.ctx.sessionId=undefined;empty.ctx.stateRef.current.current=undefined;for(const [type,value] of [['plan',true],['mode','swarm']] as const)await empty.ctx.act({type,value,sessionId:'',epoch:3});assert.equal(empty.requests.length,0);assert.equal(empty.ctx.planMode,true);assert.equal(empty.ctx.mode,'swarm');
});
test('navigation while configuring cannot apply Plan or release Goal resume into another session',async()=>{
 const f=fixture();let release!:(value:any)=>void;f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});return new Promise(done=>release=done);};const toggle=f.act('plan',true);const resume=f.act('goal',{action:'goal.set',input:{goalId:'g',expectedRevision:3,status:'active'}});const rejected=assert.rejects(resume,/会话已切换/);f.ctx.navigationEpoch.current++;release({current:{...f.ctx.stateRef.current.current,planMode:true}});await toggle;await rejected;assert.equal(f.ctx.planMode,false);assert.equal(f.requests.length,1);
});
