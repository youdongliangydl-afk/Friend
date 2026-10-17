import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {transformSync} from 'esbuild';
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const parsed=ts.createSourceFile('sdk-worker.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const admission=parsed.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='admitQueuedInput');
assert.ok(admission,'production queue admission must remain available to exercise');
const compiled=transformSync(admission.getText(parsed),{loader:'ts',target:'node24'}).code;

/** Exercise the real asynchronous admission boundary with a controlled queue. */
async function admit(options:{goalStatus?:string;paused?:boolean;empty?:boolean;busy?:boolean;status?:string;authorised?:boolean;state?:string;race?:'revision'|'head'|'pause'|'stop'|'epoch';sendError?:boolean}={}){
 const goal={id:'original-goal',status:options.goalStatus||'active',revision:7,objective:'Keep the original objective'};
 const head={id:'user-A',revision:3,state:options.state||'queued',text:'Fresh user input',runId:'user-run',mode:'single',planMode:false};
 const queue={paused:options.paused||false,items:options.empty?[]:[head]};
 const claims:unknown[][]=[],sends:any[]=[],failures:string[]=[],errors:string[]=[];let invalidations=0,legacyClears=0;
 const context:any={disposed:false,queueDriving:false,stopping:false,swarmCorrectionPending:false,queueEpoch:0,queueResumeAuthorised:options.authorised||false,lifecycleStatus:options.status||'completed',runId:'original-run',queueRestoring:undefined,
  inputQueue:{snapshot:()=>queue,pause:(paused:boolean)=>{queue.paused=paused;},claim:(...args:unknown[])=>{claims.push(args);return {...queue.items[0],state:'dispatching'};},failed:(id:string)=>failures.push(id)},
  session:{isIdle:!options.busy,sessionManager:{getBranch:()=>[]}},swarmBusy:()=>false,finiteJobs:()=>false,
  services:{safeObjects:()=>true,currentGoal:()=>goal,suspendForQueuedInput:()=>{invalidations++;}},
  changeTracker:{settle:async()=>{await Promise.resolve();switch(options.race){case 'revision':queue.items[0]={...head,revision:4};break;case 'head':queue.items[0]={...head,id:'user-B'};break;case 'pause':queue.paused=true;break;case 'stop':context.stopping=true;break;case 'epoch':context.queueEpoch++;break;}},flush:async()=>{}},
  cancelQueueResume:()=>{legacyClears++;},randomUUID:()=> 'claim-token',queueChanged:()=>{},publicError:(error:Error)=>error.message,
  publish:(type:string,value:any)=>{if(type==='notice')errors.push(value.message);},current:()=>({}),
  handle:async(method:string,input:any)=>{sends.push({method,input});if(options.sendError)throw Error('controlled native send failure');},
 };
 vm.createContext(context);vm.runInContext(compiled,context);const admitted=await context.admitQueuedInput();
 return {admitted,goal,queue,claims,sends,failures,errors,invalidations,legacyClears,context};
}

test('queued user input is admitted before automatic continuation without changing Goal focus or status',async()=>{
 for(const goalStatus of ['active','paused','blocked','usage_limited']){
  const result=await admit({goalStatus});assert.equal(result.admitted,true);assert.equal(result.claims.length,1);assert.equal(result.sends.length,1);
  assert.equal(result.sends[0].method,'send');assert.equal(result.sends[0].input.payload.text,'Fresh user input');assert.equal(result.sends[0].input.queueId,'user-A');
  assert.deepEqual(result.goal,{id:'original-goal',status:goalStatus,revision:7,objective:'Keep the original objective'});
  assert.equal(result.invalidations,1,'invalidate pending automatic continuation before giving the user the turn');assert.deepEqual(result.errors,[]);
 }
});
test('queue admission does not claim edited, replaced or cancelled input after an asynchronous boundary',async()=>{
 for(const race of ['revision','head','pause','stop','epoch'] as const){const result=await admit({race});assert.equal(result.admitted,true,race);assert.deepEqual(result.claims,[],race);assert.deepEqual(result.sends,[],race);assert.equal(result.goal.id,'original-goal');assert.equal(result.goal.status,'active');assert.equal(result.context.queueDriving,false);}
});
test('busy, paused and uncertain user messages retain priority without being handed off',async()=>{
 for(const options of [{busy:true},{paused:true},{state:'unknown'},{state:'editing'}]){const result=await admit(options);assert.equal(result.admitted,true);assert.deepEqual(result.claims,[]);assert.deepEqual(result.sends,[]);}
 const empty=await admit({empty:true});assert.equal(empty.admitted,false);assert.equal(empty.legacyClears,1);assert.equal(empty.goal.id,'original-goal');assert.equal(empty.invalidations,0);
});
test('failed execution requires explicit queue resume; native send failure retains a paused recoverable queue',async()=>{
 for(const status of ['failed','interrupted','stopped','paused']){const held=await admit({status});assert.equal(held.queue.paused,true);assert.deepEqual(held.sends,[]);const resumed=await admit({status,authorised:true});assert.equal(resumed.sends.length,1);}
 const failed=await admit({sendError:true});assert.equal(failed.queue.paused,true);assert.deepEqual(failed.failures,['user-A']);assert.deepEqual(failed.errors,['controlled native send failure']);assert.equal(failed.goal.status,'active');assert.equal(failed.context.queueDriving,false);
});
