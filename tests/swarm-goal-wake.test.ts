import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventBus,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {RuntimeController} from '../apps/desktop/src/runtime-controller.js';

const flush=()=>new Promise<void>(done=>setImmediate(done));
function fixture(mode:'single'|'swarm'='swarm'){
 const root=mkdtempSync(join(tmpdir(),'friend-swarm-wake-'));mkdirSync(join(root,'project'));
 const previous={data:process.env.FRIEND_PI_DATA_DIR,run:process.env.FRIEND_PI_RUN_ID};process.env.FRIEND_PI_DATA_DIR=join(root,'data');process.env.FRIEND_PI_RUN_ID='run';
 const hooks=new Map<string,Function>(),bus=createEventBus(),sent:unknown[]=[];let idle=false,busy=true,plan=false,prepare:()=>Promise<void>=async()=>{},admit:()=>Promise<boolean>|boolean=()=>false,retireContext=()=>{},staleReads=0,closed=false;const jobShutdown:Function[]=[];
 const controller=new RuntimeController(join(root,'data'),{admitUserInput:()=>admit(),publish:()=>{},busy:()=>busy,mode:()=>mode,planMode:()=>plan,runId:()=> 'run',modelId:()=>undefined,thinkingLevel:()=> 'off',prepareWake:()=>prepare(),sendWake:frame=>{assert.equal(busy,false);sent.push(frame);}});
 const pi={events:bus,on:(name:string,handler:Function)=>{hooks.set(name,handler);},registerTool:()=>{},registerCommand:()=>{},getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
 const bind=()=>{let stale=false;retireContext=()=>{stale=true;};controller.extension()(pi);hooks.get('session_start')!({},{cwd:join(root,'project'),get sessionManager(){if(stale){staleReads++;throw new Error('stale Pi extension context');}return {getSessionId:()=> 'native',getSessionFile:()=>undefined,getEntries:()=>[],getBranch:()=>[]};},isIdle:()=>{if(stale){staleReads++;throw new Error('stale Pi extension context');}return idle;},model:undefined,ui:{notify:()=>{}}});};bind();
 const ctx={...controller.context('user'),executionMode:mode},goal=controller.goals.create({objective:'Inspect two members'},ctx,controller.generation());
 const graph={id:'graph',sessionId:ctx.sessionId,runId:ctx.runId,goalId:goal.id,status:'running',tasks:[{id:'writer',title:'Writer',mode:'read',status:'running',currentAttempt:'attempt',resultRevision:1}],attempts:[{id:'attempt',mode:'read',status:'running',summary:'actual evidence'}]};
 return {controller,ctx,goal,graph,sent,bind,async startJobs(){const starts:Function[]=[];await controller.jobs.extension()({...pi,on:(name:string,handler:Function)=>{if(name==='session_start')starts.push(handler);if(name==='session_shutdown')jobShutdown.push(handler);}} as unknown as ExtensionAPI);for(const start of starts)await start({reason:'startup'},{cwd:ctx.projectDir,sessionManager:{getSessionId:()=>ctx.sessionId},ui:{},hasUI:false});},get staleReads(){return staleReads;},shutdown(reason='reload'){hooks.get('session_shutdown')!({reason});retireContext();},dispose(){controller.dispose();closed=true;retireContext();},setIdle(value:boolean){idle=value;},setBusy(value:boolean){busy=value;},setPlan(value:boolean){plan=value;},setPrepare(value:()=>Promise<void>){prepare=value;},setAdmit(value:()=>Promise<boolean>|boolean){admit=value;},async close(){for(const shutdown of jobShutdown)await shutdown({reason:'quit'},{});if(!closed)controller.dispose();bus.clear();if(previous.data===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=previous.data;if(previous.run===undefined)delete process.env.FRIEND_PI_RUN_ID;else process.env.FRIEND_PI_RUN_ID=previous.run;await flush();if(jobShutdown.length)process.once('exit',()=>rmSync(root,{recursive:true,force:true}));else rmSync(root,{recursive:true,force:true});}};
}
test('stale composer goal controls cannot pause, stop, verify or accept the current replacement goal',async()=>{
 const f=fixture('single');try{for(const operation of ['pause','stop','complete','accept'])await assert.rejects(f.controller.dispatch('goal.'+operation,{goalId:'old-goal'},f.ctx),/当前目标已变化/);assert.equal(f.controller.currentGoal()?.id,f.goal.id);assert.equal(f.controller.currentGoal()?.status,'active');assert.equal(f.sent.length,0);}finally{await f.close();}
});
test('integrated Swarm wakes matching graph, native task, logical step and ledger waits exactly once',async()=>{
 for(const kind of ['graph','native-task','logical-step','ledger']){const f=fixture();try{
  f.controller.observeSwarm({graphs:[f.graph]});const ledger=f.controller.tasks.list(f.ctx,f.goal.id)[0];
  const waitFor=kind==='graph'?f.graph.id:kind==='native-task'?'writer':kind==='logical-step'?ledger.logicalStepId:ledger.id;
  f.controller.goals.update({progress:'Members running',continuation:{kind:'wait',taskId:waitFor}},f.ctx);f.controller.settled('running');
  const complete={...f.graph,status:'integrated',tasks:f.graph.tasks.map(task=>({...task,status:'completed'}))};
  f.controller.observeSwarm({graphs:[complete]});f.setBusy(false);f.setIdle(true);await flush();await flush();
  assert.equal(f.controller.currentGoal()?.status,'active');assert.equal(f.controller.tasks.list(f.ctx,f.goal.id)[0].status,'completed');assert.equal(f.sent.length,1);assert.match((f.sent[0] as {message:string}).message,/已整合/);assert.doesNotMatch((f.sent[0] as {message:string}).message,/已通过检查与独立复核/);
  f.controller.observeSwarm({graphs:[complete]});await flush();assert.equal(f.sent.length,1);
 }finally{await f.close();}}
});

test('Single acceptance pause and public resume delivers a wake and requires fresh objective verification',async()=>{
 const f=fixture('single');try{
  await f.startJobs();f.setIdle(true);f.setBusy(false);f.controller.goals.noteWrite(f.ctx,'write');
  const task=await f.controller.dispatch('task.create',{title:'Check delivery',mode:'write',checks:[{command:process.execPath,args:['-e','process.exit(0)']}]},f.ctx) as {id:string};
  await f.controller.dispatch('task.verify',{id:task.id,result:'Actual objective check'},f.ctx);f.controller.goals.update({progress:'Saved output'},f.ctx);
  const waiting=await f.controller.dispatch('goal.complete',{},f.ctx) as {id:string;revision:number;waitFor:string;acceptance:{binding:string};writeEpoch:number};assert.equal(waiting.waitFor,'user-acceptance');
  await f.controller.dispatch('goal.pause',{},f.ctx);const resumed=await f.controller.dispatch('goal.resume',{},f.ctx) as {status:string;waitFor?:string;acceptance?:unknown;writeEpoch:number};
  assert.equal(resumed.status,'active');assert.equal(resumed.waitFor,undefined);assert.equal(resumed.acceptance,undefined);assert.equal(resumed.writeEpoch,waiting.writeEpoch+1);
  await f.controller.drain();await flush();assert.equal(f.sent.length,1,'resume is eligible and actually sends the native wake');
  await assert.rejects(f.controller.dispatch('goal.accept',{goalId:waiting.id,expectedRevision:waiting.revision,candidateDigest:waiting.acceptance.binding},f.ctx),{code:'VERSION_CONFLICT'});
  await assert.rejects(f.controller.dispatch('goal.complete',{},f.ctx),/实际通过的客观检查/);
  await f.controller.dispatch('task.verify',{id:task.id,result:'Fresh check after resume'},f.ctx);
  const fresh=await f.controller.dispatch('goal.complete',{},f.ctx) as typeof waiting;assert.equal(fresh.waitFor,'user-acceptance');assert.notEqual(fresh.acceptance.binding,waiting.acceptance.binding);
  const accepted=await f.controller.dispatch('goal.accept',{goalId:fresh.id,expectedRevision:fresh.revision,candidateDigest:fresh.acceptance.binding},f.ctx) as {status:string};assert.equal(accepted.status,'completed');
 }finally{await f.close();}
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

test('queue suspension detaches the old Goal without stopping steps or accepting another run writes',async()=>{
 const f=fixture();try{f.setIdle(true);f.setBusy(false);const task=f.controller.tasks.create({title:'Old goal step'},f.ctx,f.goal.id);const held=f.controller.suspendForQueuedInput();assert.equal(held?.id,f.goal.id);assert.equal(f.controller.currentGoal(),undefined);assert.equal(f.controller.goals.read(f.goal.id,f.ctx).status,'paused');assert.equal(f.controller.tasks.read(task.id,f.ctx).status,'pending');const other={...f.ctx,origin:'agent' as const,runId:'queued-run'};await assert.rejects(f.controller.dispatch('task.start',{id:task.id},other),/当前执行/);await assert.rejects(f.controller.dispatch('goal.update',{goalId:f.goal.id,progress:'foreign write'},other),/当前执行/);f.controller.account(500,'foreign','queued-run');assert.equal(f.controller.goals.read(f.goal.id,f.ctx).tokens,0);}finally{await f.close();}
});

test('goal completion respects controller-owned optional review and keeps legacy/required audits',async()=>{
 for(const policy of ['none','required','legacy','unversioned','foreign','unfinished','unchecked']){const f=fixture();try{
  f.setIdle(true);f.setBusy(false);
  f.controller.goals.update({progress:'已检查实际成果和当前任务记录'},f.ctx);
  const complete={...f.graph,status:policy==='unfinished'?'running':policy==='unchecked'?'completed':'integrated',tasks:f.graph.tasks.map(task=>({...task,status:'completed'})),...(policy==='legacy'?{}:{executionPolicy:{...(policy==='unversioned'?{}:{v:1}),review:policy==='required'?'required':'none'}}),...(policy==='foreign'?{goalId:'another-goal'}:{})};
  if(!['unfinished','unchecked','foreign'].includes(policy))f.controller.observeSwarm({graphs:[complete]});
  let audits=0;const ctx={...f.ctx,request:async(_plugin:string,action:string)=>{if(action==='snapshot')return {graphs:[complete]};if(action==='audit'){audits++;return {approved:true,independent:true,findings:'actual independent review',source:{sessionId:'reviewer'}};}throw new Error('Unexpected request '+action);}};
  const result=await f.controller.dispatch('goal.complete',{review:'none'},ctx) as {status:string;audit:{independent?:boolean;reviewStatus?:string}};
  assert.equal(result.status,['unfinished','unchecked'].includes(policy)?'blocked':'completed');assert.equal(audits,['none','unfinished','unchecked'].includes(policy)?0:1,policy);
  if(policy==='none'){assert.equal(result.audit.independent,false);assert.equal(result.audit.reviewStatus,'not_requested');}
 }finally{await f.close();}}
});

test('historical completed read-only Team keeps its native audit without waiving new graph checks',async()=>{
 for(const scenario of ['legacy-read','legacy-write','new-policy','schema-three','pending-task']){const f=fixture();try{
  f.setIdle(true);f.setBusy(false);f.controller.goals.update({progress:'实际读取已完成'},f.ctx);
  const complete={...f.graph,status:'completed',executionStyle:'team',tasks:f.graph.tasks.map(task=>({...task,mode:scenario==='legacy-write'?'write':'read',status:scenario==='pending-task'?'running':'completed'})),...(scenario==='new-policy'?{executionPolicy:{v:1,review:'none'}}:scenario==='schema-three'?{schemaVersion:3}:{})};
  let audits=0;const ctx={...f.ctx,request:async(_plugin:string,action:string)=>{if(action==='snapshot')return {graphs:[complete]};if(action==='audit'){audits++;return {approved:true,independent:true,findings:'历史 Team 独立审核',source:{sessionId:'native-reviewer'}};}throw new Error('Unexpected '+action);}};
  const result=await f.controller.dispatch('goal.complete',{},ctx) as {status:string;audit:{independent?:boolean}};
  assert.equal(result.status,scenario==='legacy-read'?'completed':'blocked',scenario);assert.equal(audits,scenario==='legacy-read'?1:0,scenario);
  if(scenario==='legacy-read')assert.equal(result.audit.independent,true);
 }finally{await f.close();}}
});

test('canonical V0 read-only Team delivery reaches Goal review while check and artifact contracts stay fenced',async()=>{
 for(const scenario of ['required','none','V1','V2','artifact','contract-check','graph-check','deferred','missing-contract','pending','write']){const f=fixture();try{
  f.setIdle(true);f.setBusy(false);f.controller.goals.update({progress:'Actual read-only member completed'},f.ctx);
  const complete={...f.graph,status:'completed',schemaVersion:3,executionStyle:'team',deferPreparation:scenario==='deferred',checks:scenario==='graph-check'?[{id:'check'}]:[],contract:scenario==='missing-contract'?undefined:{version:1,verification:['V1','V2'].includes(scenario)?scenario:'V0',risk:'low',artifacts:scenario==='artifact'?[{id:'output'}]:[],checks:scenario==='contract-check'?[{id:'oracle'}]:[]},executionPolicy:{v:1,review:scenario==='none'?'none':'required'},tasks:f.graph.tasks.map(task=>({...task,mode:scenario==='write'?'write':'read',status:scenario==='pending'?'running':'completed'}))};
  let audits=0;const ctx={...f.ctx,request:async(_plugin:string,action:string)=>{if(action==='snapshot')return {graphs:[complete]};if(action==='audit'){audits++;return {approved:true,independent:true,findings:'Independent read-only review',source:{sessionId:'native-reviewer'}};}throw new Error('Unexpected '+action);}};
  const result=await f.controller.dispatch('goal.complete',{},ctx) as {status:string;audit:{independent?:boolean;reviewStatus?:string}};
  const eligible=['required','none'].includes(scenario);assert.equal(result.status,eligible?'completed':'blocked',scenario);assert.equal(audits,scenario==='required'?1:0,scenario);
  if(eligible)assert.equal(result.audit.independent,scenario==='required');
 }finally{await f.close();}}
});

test('delayed drains after quit, reload and disposal never access retired Pi context or stores',async()=>{
 for(const reason of ['quit','reload','dispose']){const f=fixture();try{
  f.setIdle(true);f.setBusy(false);const delayed=new Promise<void>((done,reject)=>setImmediate(()=>{f.controller.drain().then(done,reject);}));
  if(reason==='dispose')f.dispose();else f.shutdown(reason);await delayed;
  assert.doesNotThrow(()=>f.controller.observeSwarm({graphs:[f.graph]}));assert.doesNotThrow(()=>f.controller.teamResult({attemptId:'attempt',runId:'run'}));
  assert.equal(f.staleReads,0,reason);assert.equal(f.sent.length,0,reason);
 }finally{await f.close();}}
});

test('reload fences old admission and preparation, preserving unsent wake exactly once',async()=>{
 for(const boundary of ['admission','prepare'])for(const rejectOld of [false,true])for(const rebindFirst of [false,true]){const f=fixture();try{
  f.setBusy(false);let release!:()=>void,fail!:(error:Error)=>void;
  const gate=new Promise<void>((done,reject)=>{release=done;fail=reject;});
  if(boundary==='admission')f.setAdmit(async()=>{await gate;return false;});else f.setPrepare(()=>gate);
  f.controller.enqueue('reload-wake','retained continuation',{goalId:f.goal.id});f.setIdle(true);
  const old=f.controller.drain();await flush();f.shutdown();if(rebindFirst)f.bind();f.setAdmit(()=>false);f.setPrepare(async()=>{});
  if(rejectOld)fail(new Error('retired preparation failed'));else release();await old;if(!rebindFirst){assert.equal(f.sent.length,0);f.bind();}await flush();await flush();
  assert.equal(f.staleReads,0);assert.equal(f.controller.currentGoal()?.status,'active','old catch must not pause current Goal');
  assert.equal(f.sent.length,1,`${boundary}/${rejectOld}`);assert.equal(f.controller.snapshot().pendingWakes.length,0);
  assert.equal(f.controller.enqueue('reload-wake','duplicate'),false,'reload retains delivery dedup');
 }finally{await f.close();}}
});

test('quit during an asynchronous wake cannot send or touch disposed stores',async()=>{
 for(const boundary of ['admission','prepare']){const f=fixture();try{
  f.setBusy(false);let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
  if(boundary==='admission')f.setAdmit(async()=>{await gate;return false;});else f.setPrepare(()=>gate);
  f.controller.enqueue('quit-wake','cancelled continuation',{goalId:f.goal.id});f.setIdle(true);
  const old=f.controller.drain();await flush();f.shutdown('quit');f.dispose();release();await old;await flush();
  assert.equal(f.staleReads,0);assert.equal(f.sent.length,0);
 }finally{await f.close();}}
});
