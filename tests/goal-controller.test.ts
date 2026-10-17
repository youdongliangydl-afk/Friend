import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventBus,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {RuntimeController} from '../apps/desktop/src/runtime-controller.js';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'friend-goal-controller-'));mkdirSync(join(root,'project'));
 const old={data:process.env.FRIEND_PI_DATA_DIR,run:process.env.FRIEND_PI_RUN_ID};process.env.FRIEND_PI_DATA_DIR=join(root,'data');process.env.FRIEND_PI_RUN_ID='run';
 const handlers=new Map<string,Function>(),tools=new Map<string,any>(),sent:any[]=[],bus=createEventBus();let idle=false,busy=false,plan=false,unknown=false,halt=0,prepare:()=>Promise<void>=async()=>{},admit:()=>boolean|Promise<boolean>=()=>false;
 const runtime=new RuntimeController(join(root,'data'),{publish:()=>{},unresolvedSideEffects:()=>unknown,busy:()=>busy,mode:()=> 'single',planMode:()=>plan,runId:()=>process.env.FRIEND_PI_RUN_ID,modelId:()=>undefined,thinkingLevel:()=> 'off',haltExecution:()=>{halt++;},prepareWake:()=>prepare(),admitUserInput:()=>admit()});
 const native={cwd:join(root,'project'),sessionManager:{getSessionId:()=> 'session',getSessionFile:()=>undefined,getEntries:()=>[],getBranch:()=>[]},isIdle:()=>idle,model:undefined,ui:{notify:()=>{}}};
 const pi={events:bus,on:(name:string,handler:Function)=>handlers.set(name,handler),registerTool:(tool:any)=>tools.set(tool.name,tool),registerCommand:()=>{},getThinkingLevel:()=> 'off',appendEntry:()=>{},sendMessage:(message:unknown,options:unknown)=>{sent.push({message,options});}} as unknown as ExtensionAPI;
 runtime.extension()(pi);handlers.get('session_start')!({},native);const ctx=runtime.context('user');const goal=runtime.goals.create({objective:'Finish the explicitly requested deliverable'},ctx,runtime.generation());
 return {runtime,ctx,goal,tools,sent,native,get halt(){return halt;},setIdle(value:boolean){idle=value;},setBusy(value:boolean){busy=value;},setUnknown(value:boolean){unknown=value;},setPlan(value:boolean){plan=value;},setPrepare(value:()=>Promise<void>){prepare=value;},setAdmit(value:()=>boolean|Promise<boolean>){admit=value;},async close(){runtime.dispose();bus.clear();if(old.data===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=old.data;if(old.run===undefined)delete process.env.FRIEND_PI_RUN_ID;else process.env.FRIEND_PI_RUN_ID=old.run;await flush();rmSync(root,{recursive:true,force:true});}};
}

test('model goal tools expose only explicit objective and canonical status',async()=>{const f=fixture();try{
 assert.equal(f.tools.has('friend_goal'),false);assert.deepEqual([...f.tools.keys()].filter(name=>name.includes('goal')).sort(),['create_goal','get_goal','update_goal']);
 assert.deepEqual(Object.keys(f.tools.get('create_goal').parameters.properties),['objective']);assert.deepEqual(Object.keys(f.tools.get('update_goal').parameters.properties),['status']);
 assert.match(f.tools.get('create_goal').description,/用户明确要求/);assert.match(f.tools.get('update_goal').description,/连续至少三轮/);
 await assert.rejects(f.runtime.dispatch('goal.update',{status:'complete'},{...f.ctx,origin:'agent',runId:'other-run'}),/当前执行/);
}finally{await f.close();}});

test('old model completion cannot complete an edited objective; reading the new goal renews its evidence binding',async()=>{const f=fixture();try{
 f.runtime.beginTurn({automatic:false});const agent={...f.ctx,origin:'agent' as const};
 await f.runtime.dispatch('goal.set',{objective:'New requirement received while streaming'},f.ctx);
 await assert.rejects(f.runtime.dispatch('goal.update',{status:'complete'},agent),{code:'VERSION_CONFLICT'});assert.equal(f.runtime.currentGoal()?.status,'active');
 await f.runtime.dispatch('goal.get',{},agent);f.runtime.account(500,'normal-accounting');
 await f.runtime.dispatch('goal.update',{status:'complete'},agent);assert.equal(f.runtime.currentGoal(),undefined);
}finally{await f.close();}});

test('clear and execution stop revoke late create_goal authority from the current turn',async()=>{for(const action of ['clear','stop']){const f=fixture();try{
 f.runtime.beginTurn({automatic:false});if(action==='clear')await f.runtime.dispatch('goal.clear',{},f.ctx);else await f.runtime.stop();
 await f.runtime.dispatch('goal.get',{}, {...f.ctx,origin:'agent'});
 await assert.rejects(f.runtime.dispatch('goal.create',{objective:'Late unauthorized resurrection',userRequested:true},{...f.ctx,origin:'agent'}),{code:'VERSION_CONFLICT'});
 assert.equal(f.runtime.currentGoal()?.status,action==='stop'?'paused':undefined);
}finally{await f.close();}}});

test('pause and clear cancel only goal wakes and do not halt execution, jobs, tasks or generation',async()=>{for(const action of ['pause','clear']){const f=fixture();try{
 const task=f.runtime.tasks.create({title:'Still running'},f.ctx,f.goal.id);f.runtime.tasks.start(task.id,f.ctx);let jobStops=0;f.runtime.jobs.stopRun=async()=>{jobStops++;};
 const generation=f.runtime.generation();f.runtime.enqueue('goal-frame','goal continuation',{goalId:f.goal.id});f.runtime.enqueue('independent-result','job completion',{runId:'run'});
 await f.runtime.dispatch(`goal.${action}`,{goalId:f.goal.id,expectedRevision:f.runtime.currentGoal()!.revision},f.ctx);
 assert.equal(f.runtime.generation(),generation);assert.equal(f.halt,0);assert.equal(jobStops,0);assert.equal(f.runtime.tasks.read(task.id,f.ctx).status,'running');
 assert.deepEqual(f.runtime.snapshot().pendingWakes.map(frame=>frame.id),['independent-result']);assert.equal(f.runtime.currentGoal()?.status,action==='pause'?'paused':undefined);
 assert.equal(f.runtime.enqueue('late-goal','late completion',{goalId:f.goal.id}),false);
}finally{await f.close();}}});

test('explicit execution Stop still stops jobs and tasks and pauses Goal',async()=>{const f=fixture();try{
 const task=f.runtime.tasks.create({title:'Stop task'},f.ctx,f.goal.id);f.runtime.tasks.start(task.id,f.ctx);let stops=0;f.runtime.jobs.stopRun=async()=>{stops++;};
 await f.runtime.stop();assert.equal(stops,1);assert.equal(f.runtime.tasks.read(task.id,f.ctx).status,'stopped');assert.equal(f.runtime.currentGoal()?.status,'paused');
}finally{await f.close();}});

test('goal user edit CAS is checked before wake cancellation and remains active',async()=>{const f=fixture();try{
 f.runtime.enqueue('pending','keep on conflict',{goalId:f.goal.id});await assert.rejects(f.runtime.dispatch('goal.set',{goalId:f.goal.id,expectedRevision:0,objective:'wrong'},f.ctx),{code:'VERSION_CONFLICT'});assert.equal(f.runtime.snapshot().pendingWakes.length,1);
 const result=f.runtime.setGoalForInput({goalId:f.goal.id,expectedRevision:f.runtime.currentGoal()!.revision,objective:'Revised explicit objective'},f.ctx);assert.equal(result.id,f.goal.id);assert.equal(result.status,'active');assert.equal(f.runtime.snapshot().pendingWakes.length,0);
 await assert.rejects(f.runtime.dispatch('goal.set',{objective:'Agent edit'},{...f.ctx,origin:'agent'}),/用户/);
}finally{await f.close();}});

test('three empty automatic turns block, while response and successful tool outcomes reset streak',async()=>{for(const reset of ['none','response','tool']){const f=fixture();try{
 const round=(kind='empty')=>{f.runtime.beginTurn({automatic:true});if(kind==='response')f.runtime.recordGoalResponse({text:'Actual progress'});if(kind==='tool')f.runtime.recordGoalToolOutcome({success:true});f.runtime.settled();};
 round();round();assert.equal(f.runtime.currentGoal()?.status,'active');if(reset!=='none')round(reset);round();assert.equal(f.runtime.currentGoal()?.status,reset==='none'?'blocked':'active');
 if(reset!=='none'){round();round();assert.equal(f.runtime.currentGoal()?.status,'blocked');}
}finally{await f.close();}}});

test('infrastructure unavailable requires three consecutive rounds without successful tools; normal failures do not qualify',async()=>{for(const scenario of ['unavailable','normal-failure','success']){const f=fixture();try{
 for(let i=0;i<3;i++){f.runtime.beginTurn({automatic:false});f.runtime.recordGoalToolOutcome({success:false,executionUnavailable:scenario!=='normal-failure'});if(scenario==='success')f.runtime.recordGoalToolOutcome({success:true});f.runtime.settled('failed');}
 assert.equal(f.runtime.currentGoal()?.status,scenario==='unavailable'?'blocked':'active');
}finally{await f.close();}}});

test('actual provider quota becomes usage_limited but observed usage alone never stops a goal',async()=>{const f=fixture();try{
 f.runtime.account(1_000_000,'usage');f.runtime.account(undefined,'unknown');assert.equal(f.runtime.currentGoal()?.status,'active');
 f.runtime.settled('usage_limited');assert.equal(f.runtime.currentGoal()?.status,'usage_limited');assert.equal(f.runtime.snapshot().pendingWakes.length,0);
}finally{await f.close();}});

test('Plan mode retains active goal while preventing admission; queued user input wins after preparation',async()=>{for(const scenario of ['plan','queued']){const f=fixture();try{
 let checks=0;f.setAdmit(()=>++checks>=2&&scenario==='queued');if(scenario==='plan')f.setPlan(true);
 f.runtime.enqueue('wake','continue',{goalId:f.goal.id});f.setIdle(true);await f.runtime.drain();await flush();
 assert.equal(f.runtime.currentGoal()?.status,'active');assert.equal(f.sent.length,0);
}finally{await f.close();}}});

test('revision change, pause, clear and run changes during prepare fence late goal frames',async()=>{for(const scenario of ['revision','pause','clear','run']){const f=fixture();try{
 let release!:()=>void;f.setPrepare(()=>new Promise<void>(resolve=>{release=resolve;}));f.runtime.enqueue('wake','old continuation',{goalId:f.goal.id});f.setIdle(true);const drain=f.runtime.drain();await flush();
 if(scenario==='revision')f.runtime.goals.update({progress:'Updated during preparation'},f.ctx);else if(scenario==='run')process.env.FRIEND_PI_RUN_ID='other';else await f.runtime.dispatch(`goal.${scenario}`,{goalId:f.goal.id},f.ctx);
 release();await drain;assert.equal(f.sent.length,0,scenario);
}finally{await f.close();}}});

test('automatic goal continuation is hidden native followUp and accounting before admission does not discard it',async()=>{const f=fixture();try{
 f.runtime.enqueue('wake','continue goal',{goalId:f.goal.id});f.runtime.account(50,'usage-before-delivery');f.setIdle(true);await f.runtime.drain();assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].message.customType,'friend-pi.goal-wake');assert.equal(f.sent[0].message.display,false);assert.deepEqual(f.sent[0].options,{triggerTurn:true,deliverAs:'followUp'});assert.equal(f.runtime.enqueue('wake','duplicate',{goalId:f.goal.id}),false);
}finally{await f.close();}});

test('unrelated blocked task does not block an active goal, while unsafe execution objects prevent completion',async()=>{const f=fixture();try{
 const task=f.runtime.tasks.create({title:'Unrelated failure'},f.ctx);f.runtime.tasks.fail(task.id,'Unrelated',f.ctx);f.runtime.settled();assert.equal(f.runtime.currentGoal()?.status,'active');
 f.setBusy(true);await assert.rejects(f.runtime.dispatch('goal.complete',{summary:'Cannot complete yet'},f.ctx),/收敛/);assert.equal(f.runtime.currentGoal()?.status,'active');
}finally{await f.close();}});


test('pausing a goal does not cancel an already preparing independent result',async()=>{const f=fixture();try{
 let release!:()=>void;f.setPrepare(()=>new Promise<void>(resolve=>{release=resolve;}));f.runtime.enqueue('independent','ordinary job result',{runId:'run'});f.setIdle(true);const pending=f.runtime.drain();await flush();
 await f.runtime.dispatch('goal.pause',{goalId:f.goal.id},f.ctx);release();await pending;assert.equal(f.sent.length,1);assert.equal(f.runtime.currentGoal()?.status,'paused');
}finally{await f.close();}});

test('three automatic wake preparation failures block without falsely recording a user pause',async()=>{const f=fixture();try{
 let attempts=0;f.setPrepare(async()=>{attempts++;throw new Error('Execution environment unavailable');});f.runtime.enqueue('prepare-failure','continue',{goalId:f.goal.id});f.setIdle(true);await f.runtime.drain();for(let i=0;i<8;i++)await flush();
 assert.equal(attempts,3);assert.equal(f.runtime.currentGoal()?.status,'blocked');assert.equal(f.sent.length,0);
}finally{await f.close();}});


test('unknown and completed wait objects cannot permanently suspend continuation',async()=>{const f=fixture();try{
 for(const id of ['future-task','user-response'])await assert.rejects(f.runtime.dispatch('goal.update',{continuation:{kind:'wait',taskId:id}},f.ctx),/实际执行对象/);
 const task=f.runtime.tasks.create({title:'Known running step'},f.ctx,f.goal.id);f.runtime.tasks.start(task.id,f.ctx);
 await f.runtime.dispatch('goal.update',{continuation:{kind:'wait',taskId:task.id}},f.ctx);f.runtime.settled();assert.equal(f.runtime.currentGoal()?.waitFor,task.id);assert.equal(f.runtime.snapshot().pendingWakes.length,0);
 f.runtime.tasks.fail(task.id,'No longer running',f.ctx,true);await assert.rejects(f.runtime.dispatch('goal.update',{continuation:{kind:'wait',taskId:task.id}},f.ctx),/实际执行对象/);
 f.runtime.settled();assert.equal(f.runtime.currentGoal()?.waitFor,undefined);assert.equal(f.runtime.currentGoal()?.status,'active');assert.equal(f.runtime.snapshot().pendingWakes.length,1);
}finally{await f.close();}});


test('unresolved plugin effects fence Goal restore, resume, complete and first-input creation',async()=>{const f=fixture();try{
 f.setUnknown(true);assert.equal(f.runtime.safeObjects(),false);
 await assert.rejects(f.runtime.dispatch('goal.update',{status:'complete'},{...f.ctx,origin:'agent'}),/收敛/);
 await f.runtime.dispatch('goal.pause',{},f.ctx);await assert.rejects(f.runtime.dispatch('goal.resume',{},f.ctx),/未知现场/);
 await assert.rejects(f.runtime.dispatch('goal.set',{status:'active'},f.ctx),/未知现场/);
 await f.runtime.dispatch('goal.clear',{},f.ctx);assert.throws(()=>f.runtime.setGoalForInput({objective:'New target'},f.ctx),/未知现场/);
 f.setUnknown(false);const goal=f.runtime.setGoalForInput({objective:'Reviewed side effects'},f.ctx);assert.equal(goal.status,'active');
}finally{await f.close();}});
