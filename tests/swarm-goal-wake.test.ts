import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventBus,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {RuntimeController} from '../apps/desktop/src/runtime-controller.js';

const flush=()=>new Promise<void>(done=>setImmediate(done));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'friend-swarm-wake-'));mkdirSync(join(root,'project'));
 const previous={data:process.env.FRIEND_PI_DATA_DIR,run:process.env.FRIEND_PI_RUN_ID};process.env.FRIEND_PI_DATA_DIR=join(root,'data');process.env.FRIEND_PI_RUN_ID='run';
 const hooks=new Map<string,Function>(),bus=createEventBus(),sent:unknown[]=[];let idle=false,busy=true,plan=false,prepare:()=>Promise<void>=async()=>{};
 const controller=new RuntimeController(join(root,'data'),{publish:()=>{},busy:()=>busy,mode:()=> 'swarm',planMode:()=>plan,runId:()=> 'run',modelId:()=>undefined,thinkingLevel:()=> 'off',prepareWake:()=>prepare(),sendWake:frame=>{assert.equal(busy,false);sent.push(frame);}});
 const pi={events:bus,on:(name:string,handler:Function)=>{hooks.set(name,handler);},registerTool:()=>{},registerCommand:()=>{},getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
 controller.extension()(pi);hooks.get('session_start')!({},{cwd:join(root,'project'),sessionManager:{getSessionId:()=> 'native',getSessionFile:()=>undefined},isIdle:()=>idle,model:undefined,ui:{notify:()=>{}}});
 const ctx={...controller.context('user'),executionMode:'swarm' as const},goal=controller.goals.create({objective:'Inspect two members'},ctx,controller.generation());
 const graph={id:'graph',sessionId:ctx.sessionId,runId:ctx.runId,goalId:goal.id,status:'running',tasks:[{id:'writer',title:'Writer',mode:'read',status:'running',currentAttempt:'attempt',resultRevision:1}],attempts:[{id:'attempt',mode:'read',status:'running',summary:'actual evidence'}]};
 return {controller,ctx,goal,graph,sent,setIdle(value:boolean){idle=value;},setBusy(value:boolean){busy=value;},setPlan(value:boolean){plan=value;},setPrepare(value:()=>Promise<void>){prepare=value;},async close(){controller.dispose();bus.clear();if(previous.data===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=previous.data;if(previous.run===undefined)delete process.env.FRIEND_PI_RUN_ID;else process.env.FRIEND_PI_RUN_ID=previous.run;await flush();rmSync(root,{recursive:true,force:true});}};
}
test('integrated Swarm wakes matching graph, native task, logical step and ledger waits exactly once',async()=>{
 for(const kind of ['graph','native-task','logical-step','ledger']){const f=fixture();try{
  f.controller.observeSwarm({graphs:[f.graph]});const ledger=f.controller.tasks.list(f.ctx,f.goal.id)[0];
  const waitFor=kind==='graph'?f.graph.id:kind==='native-task'?'writer':kind==='logical-step'?ledger.logicalStepId:ledger.id;
  f.controller.goals.update({progress:'Members running',continuation:{kind:'wait',taskId:waitFor}},f.ctx);f.controller.settled('running');
  const complete={...f.graph,status:'integrated',tasks:f.graph.tasks.map(task=>({...task,status:'completed'}))};
  f.controller.observeSwarm({graphs:[complete]});f.setBusy(false);f.setIdle(true);await flush();await flush();
  assert.equal(f.controller.currentGoal()?.status,'active');assert.equal(f.controller.tasks.list(f.ctx,f.goal.id)[0].status,'completed');assert.equal(f.sent.length,1);
  f.controller.observeSwarm({graphs:[complete]});await flush();assert.equal(f.sent.length,1);
 }finally{await f.close();}}
});
test('foreign, interrupted, unrelated, cold and unconfirmed Swarm evidence cannot resume a Goal',async()=>{
 for(const scenario of ['session','goal','run','audit','paused','stopped','unknown','other-wait','cold','unknown-activity','plan']){const f=fixture();try{
  if(scenario!=='cold')f.controller.observeSwarm({graphs:[f.graph]});
  f.controller.goals.update({progress:'Waiting',continuation:{kind:'wait',taskId:scenario==='other-wait'?'other-job':'writer'}},f.ctx);
  if(scenario==='stopped')await f.controller.stop();if(scenario==='paused')f.controller.goals.setState('paused',f.ctx);
  if(scenario==='unknown-activity')f.controller.store.put('activity:native:unknown',{sessionId:'native',id:'unknown',tool:'write',sideEffect:true,status:'unknown',runId:'run'});
  if(scenario==='plan')f.setPlan(true);
  const complete={...f.graph,status:scenario==='unknown'?'paused':'integrated',tasks:f.graph.tasks.map(task=>({...task,status:'completed'})),...(scenario==='session'?{sessionId:'foreign'}:scenario==='goal'?{goalId:'foreign'}:scenario==='run'?{runId:'foreign'}:scenario==='audit'?{audit:true}:{})};
  f.controller.observeSwarm({graphs:[complete]});f.setBusy(false);f.setIdle(true);await flush();await flush();assert.equal(f.sent.length,0,scenario);
 }finally{await f.close();}}
});
test('a late wait after integration still receives the pending wake; stop fences an admitted wake',async()=>{
 for(const stop of [false,true]){const f=fixture();try{
  f.controller.observeSwarm({graphs:[f.graph]});f.controller.observeSwarm({graphs:[{...f.graph,status:'integrated',tasks:f.graph.tasks.map(task=>({...task,status:'completed'}))}]});
  f.setBusy(false);await flush();assert.equal(f.sent.length,0,'model is still busy');
  f.controller.goals.update({progress:'Late wait',continuation:{kind:'wait',taskId:'writer'}},f.ctx);
  let release!:()=>void;if(stop)f.setPrepare(()=>new Promise<void>(done=>{release=done;}));
  f.setIdle(true);f.controller.settled('completed');await flush();
  if(stop){await f.controller.stop();release();await flush();assert.equal(f.sent.length,0);}else assert.equal(f.sent.length,1);
 }finally{await f.close();}}
});
