import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const correctionHelpers=source.slice(source.indexOf('const correctionPauseReason'),source.indexOf('function freshCorrection'))+source.slice(source.indexOf('function skipRuntimeWake'),source.indexOf('function runtimeWakeAllowed'));
const compiled=transformSync(correctionHelpers+source.slice(source.indexOf('async function admitQueuedInput'),source.indexOf('function imageIdentity')),{loader:'ts',target:'node24'}).code;
/** Production admission with deterministic asynchronous host boundaries. */
async function restore(options:{status?:string;focused?:any;tasks?:any[];graphs?:any[];originalRun?:boolean;cancelAtModel?:boolean;correctedGoal?:boolean}={}){
 const held={id:'A',revision:4,sourceRunId:'run-A',objective:'original',modelId:'provider/A',thinkingLevel:'off',mode:'single',planMode:false};
 let marker:any=held,focus=options.focused;const resumed:string[]=[],q={paused:false,items:[]},errors:string[]=[],branch:any[]=options.correctedGoal?[{type:'custom',customType:'friend-pi.swarm.correction.v1',data:{v:1,runId:'run-A'}}]:[];let modelChanges=0;
 const ctx:any={inputQueue:{snapshot:()=>q,store:{get:()=>marker?{value:marker}:undefined,put:()=>{},remove:()=>{marker=undefined;}},pause:(value:boolean)=>{q.paused=value;}},disposed:false,queueDriving:false,queueRestoring:undefined,stopping:false,swarmCorrectionPending:false,queueEpoch:0,queueResumeAuthorised:false,lifecycleStatus:options.status||'completed',runId:options.originalRun?'run-A':'run-B',executionMode:'swarm',planMode:false,runRequiresSwarm:true,settledRunId:'run-B',cancelRequested:false,authorityNotice:'',activeGraphIds:new Set(),runGraphIds:new Set(),baselineGraphIds:new Set(),swarmGraphs:new Map((options.graphs||[]).map((g:any)=>[g.id,g])),enabled:[],process:{env:{}},session:{isIdle:true,sessionId:'session',model:{provider:'provider',id:'B'},thinkingLevel:'off',sessionManager:{getBranch:()=>[]},setModel:async(model:any)=>{modelChanges++;await Promise.resolve();ctx.session.model=model;if(options.cancelAtModel&&modelChanges===1){ctx.queueEpoch++;marker=undefined;ctx.runId='manual-run';ctx.executionMode='team';}},setThinkingLevel:()=>{}},services:{safeObjects:()=>true,currentGoal:()=>focus,context:()=>({}),tasks:{list:()=>options.tasks||[]},goals:{read:()=>({id:'A',revision:4,status:'paused',sourceRunId:'run-A',sessionId:'session',mode:'single'}),store:{put:(_key:string,id:string)=>{focus={id,status:'paused'};}}},dispatch:async(_action:string,input:any)=>{resumed.push(input.goalId);}},swarmBusy:()=>false,finiteJobs:()=>false,suspensionKey:()=>'',changeTracker:{settle:async()=>{},flush:async()=>{},ensure:async()=>{}},selectedModel:(id:string)=>({provider:id.split('/')[0],id:id.split('/')[1]}),ownedEntries:(rows:any)=>rows,object:(x:any)=>x||{},requestPlugin:async()=>({graphs:[]}),queueChanged:()=>{},publish:()=>{},cancelQueueResume:()=>{marker=undefined;}};
 ctx.foregroundOpen=true;ctx.session.sessionManager={getBranch:()=>branch,appendCustomEntry:(customType:string,data:unknown)=>branch.push({type:'custom',customType,data})};
 ctx.services.generation=()=>0;ctx.services.goals.setState=(status:string,_context:unknown,error:string)=>{focus={...focus,status,error};};
 ctx.publicError=(error:unknown)=>String(error);ctx.publish=(type:string,value:any)=>{if(type==='notice'&&value.level==='error')errors.push(value.message);};
 vm.createContext(ctx);vm.runInContext(compiled,ctx);await ctx.admitQueuedInput();assert.deepEqual(errors,[],`Admission published an unexpected error: ${errors.join('\n')}`);return {ctx,q,resumed,goal:focus,branch,marker};
}
test('queued Goal restoration requires successful independent work, including task and graph state',async()=>{
 for(const options of [{status:'paused'},{status:'failed'},{focused:{id:'B',status:'blocked'}},{tasks:[{runId:'run-B',status:'blocked'}]},{graphs:[{id:'g',runId:'run-B',status:'paused'}]}]){const x=await restore(options);assert.deepEqual(x.resumed,[]);assert.equal(x.q.paused,true);assert.equal(x.ctx.runId,'run-B');}
 const success=await restore();assert.deepEqual(success.resumed,['A']);assert.equal(success.ctx.runId,'run-A');
});
test('deleting B before claim permits A unfinished steps to resume; cancelled model changes cannot install A identity',async()=>{
 const removed=await restore({originalRun:true,tasks:[{runId:'run-A',status:'pending'}],graphs:[{id:'original',runId:'run-A',status:'pending'}]});assert.deepEqual(removed.resumed,['A']);
 const cancelled=await restore({cancelAtModel:true});assert.deepEqual(cancelled.resumed,[]);assert.equal(cancelled.ctx.runId,'manual-run');assert.equal(cancelled.ctx.executionMode,'team');assert.equal(cancelled.ctx.session.model.id,'B');
});
test('a corrected original Goal restores paused with its reason and a NOT_RUN receipt instead of silently running',async()=>{
 const restored=await restore({correctedGoal:true});assert.deepEqual(restored.resumed,[]);assert.equal(restored.ctx.runId,'run-A');assert.equal(restored.ctx.lifecycleStatus,'paused');assert.equal(restored.ctx.foregroundOpen,false);
 assert.equal(restored.goal.id,'A');assert.equal(restored.goal.status,'paused');assert.match(restored.goal.error,/用户明确接续/);assert.equal(restored.marker,undefined);assert.equal(restored.q.paused,false);assert.deepEqual(restored.q.items,[]);
 const receipts=restored.branch.filter(entry=>entry.customType==='friend-pi.runtime-wake.skipped');assert.equal(receipts.length,1);assert.equal(receipts[0].data.eventId,'queue-resume:A:4');assert.equal(receipts[0].data.runId,'run-A');assert.equal(receipts[0].data.status,'not-run');assert.equal(receipts[0].data.reason,'correction-verification-only');
});
