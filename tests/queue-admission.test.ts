import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const compiled=transformSync(source.slice(source.indexOf('async function admitQueuedInput'),source.indexOf('function imageIdentity')),{loader:'ts',target:'node24'}).code;
/** Production admission with deterministic asynchronous host boundaries. */
async function restore(options:{status?:string;focused?:any;tasks?:any[];graphs?:any[];originalRun?:boolean;cancelAtModel?:boolean}={}){
 const held={id:'A',revision:4,sourceRunId:'run-A',objective:'original',modelId:'provider/A',thinkingLevel:'off',mode:'single',planMode:false};
 let marker:any=held,focus=options.focused;const resumed:string[]=[],q={paused:false,items:[]};let modelChanges=0;
 const ctx:any={inputQueue:{snapshot:()=>q,store:{get:()=>marker?{value:marker}:undefined,put:()=>{},remove:()=>{marker=undefined;}},pause:(value:boolean)=>{q.paused=value;}},disposed:false,queueDriving:false,queueRestoring:undefined,stopping:false,swarmCorrectionPending:false,queueEpoch:0,queueResumeAuthorised:false,lifecycleStatus:options.status||'completed',runId:options.originalRun?'run-A':'run-B',executionMode:'swarm',planMode:false,runRequiresSwarm:true,settledRunId:'run-B',cancelRequested:false,authorityNotice:'',activeGraphIds:new Set(),runGraphIds:new Set(),baselineGraphIds:new Set(),swarmGraphs:new Map((options.graphs||[]).map((g:any)=>[g.id,g])),enabled:[],process:{env:{}},session:{isIdle:true,sessionId:'session',model:{provider:'provider',id:'B'},thinkingLevel:'off',sessionManager:{getBranch:()=>[]},setModel:async(model:any)=>{modelChanges++;await Promise.resolve();ctx.session.model=model;if(options.cancelAtModel&&modelChanges===1){ctx.queueEpoch++;marker=undefined;ctx.runId='manual-run';ctx.executionMode='team';}},setThinkingLevel:()=>{}},services:{safeObjects:()=>true,currentGoal:()=>focus,context:()=>({}),tasks:{list:()=>options.tasks||[]},goals:{read:()=>({id:'A',revision:4,status:'paused',sourceRunId:'run-A',sessionId:'session',mode:'single'}),store:{put:(_key:string,id:string)=>{focus={id,status:'paused'};}}},dispatch:async(_action:string,input:any)=>{resumed.push(input.goalId);}},swarmBusy:()=>false,finiteJobs:()=>false,suspensionKey:()=>'',changeTracker:{settle:async()=>{},flush:async()=>{},ensure:async()=>{}},selectedModel:(id:string)=>({provider:id.split('/')[0],id:id.split('/')[1]}),ownedEntries:(rows:any)=>rows,object:(x:any)=>x||{},requestPlugin:async()=>({graphs:[]}),queueChanged:()=>{},publish:()=>{},cancelQueueResume:()=>{marker=undefined;}};
 vm.createContext(ctx);vm.runInContext(compiled,ctx);await ctx.admitQueuedInput();return {ctx,q,resumed};
}
test('queued Goal restoration requires successful independent work, including task and graph state',async()=>{
 for(const options of [{status:'paused'},{status:'failed'},{focused:{id:'B',status:'blocked'}},{tasks:[{runId:'run-B',status:'blocked'}]},{graphs:[{id:'g',runId:'run-B',status:'paused'}]}]){const x=await restore(options);assert.deepEqual(x.resumed,[]);assert.equal(x.q.paused,true);assert.equal(x.ctx.runId,'run-B');}
 const success=await restore();assert.deepEqual(success.resumed,['A']);assert.equal(success.ctx.runId,'run-A');
});
test('deleting B before claim permits A unfinished steps to resume; cancelled model changes cannot install A identity',async()=>{
 const removed=await restore({originalRun:true,tasks:[{runId:'run-A',status:'pending'}],graphs:[{id:'original',runId:'run-A',status:'pending'}]});assert.deepEqual(removed.resumed,['A']);
 const cancelled=await restore({cancelAtModel:true});assert.deepEqual(cancelled.resumed,[]);assert.equal(cancelled.ctx.runId,'manual-run');assert.equal(cancelled.ctx.executionMode,'team');assert.equal(cancelled.ctx.session.model.id,'B');
});
