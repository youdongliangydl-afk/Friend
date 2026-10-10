import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CapabilityError,LearningBudget,acquireLearningLease,releaseLearningLease,digest,type PluginContext,type JsonObject} from '@friend-pi/core';
import {ExpertController,peekExpertLearningJob,wakeExpertLearningJobs,type ExpertLearningJob} from '../src/index.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'expert-length-')),controller=new ExpertController(dir),budget=new LearningBudget(controller.store),lease=acquireLearningLease(controller.store,randomUUID())!,body='Check input encoding before importing CSV.',sourceText='The actual CSV import failed because its input encoding was not checked.',source={sessionId:'s',entryId:'source',hash:digest(sourceText)},evidence=[{kind:'pi',projectId:'p',source}],operations:string[]=[],response={received:true,complete:false,stopReason:'length',maxTokens:512,usage:{input:20,output:512,totalTokens:532}};
 let mode:'length'|'ledger-length'|'paired'|'schema'|'proposal'='length';
 const ctx:PluginContext={origin:'plugin',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'actual-run',modelId:'fake/fixed',thinkingLevel:'off',isIdle:()=>true,history:()=>[{id:'source',type:'message',role:'user',text:sourceText,parentId:null,timestamp:'2026-10-10'}],readSource:()=>({id:'source',type:'message',role:'user',text:sourceText,parentId:null,timestamp:'2026-10-10'}),complete:async(prompt,options)=>{
  const operationId=options!.operationId!,budgetId=options!.budgetId!,call=budget.begin({budgetId,operationId,callId:options!.callId,stage:options!.stage,promptHash:digest(prompt)});operations.push(operationId);
  if(mode==='length'||mode==='ledger-length'){budget.finish({budgetId,operationId,callId:call.callId,state:'failed',tokens:532,response});throw new CapabilityError('VALIDATION_ERROR','Confirmed response reached its output limit.',mode==='length'?{response}:undefined);}
  const output=mode==='schema'?'not valid JSON':mode==='proposal'?JSON.stringify({title:'Forged base',applicability:'CSV',body,baseSkillId:'seed.planner.1',baseVersion:1}):JSON.stringify({ok:prompt.includes(body)});budget.finish({budgetId,operationId,callId:call.callId,state:'complete',tokens:4,result:output});return output;
 },request:async()=>undefined,emit:()=>{},notify:()=>{},appendEntry:()=>undefined};
 controller.snapshot(ctx);
 async function extract(){return await controller.dispatch('taskTraceReady',{runId:ctx.runId,taskResultVersion:1,taskResult:{status:'failed'},evidence},ctx) as {jobId:string};}
 async function validation(){
  const user={...ctx,origin:'user' as const},candidate=await controller.dispatch('candidate.submit',{key:'candidate',skillBody:{title:'CSV input method',applicability:'CSV',body},evidence},user) as {id:string;revision:number;version:number},value=controller.skillCatalog.version(candidate.id,candidate.version,user),baseline=controller.skillCatalog.version('seed.implementer.1',1,user),cases=(phase:string)=>[{id:phase+'-a',kind:'positive',input:phase+' input encoding alpha',expected:{ok:true},families:[phase+'-alpha'],critical:true},{id:phase+'-b',kind:'positive',input:phase+' required columns beta',expected:{ok:true},families:[phase+'-beta'],critical:true},{id:phase+'-outside',kind:'negative',input:phase+' unrelated format gamma',expected:{ok:true},families:[phase+'-outside'],critical:true}],saved=await controller.dispatch('validation.manifest',{key:'manifest',manifest:{candidateId:candidate.id,candidateHash:value.contentHash,baseline:{id:baseline.id,version:1,hash:baseline.contentHash},trainFamilies:['actual-source'],validation:cases('validation'),release:cases('release'),modelId:'fake/fixed',thinkingLevel:'off',provider:'fake',tools:[],timeoutMs:1000,maxCalls:12,environmentHash:digest('environment'),checkerHash:digest('strict-json'),promptHash:digest('text-only')}},user) as {manifestHash:string};
  return await controller.dispatch('validation.schedule',{id:candidate.id,expectedRevision:candidate.revision,manifestHash:saved.manifestHash},user) as {jobId:string};
 }
 function read(id:string){return controller.store.get<ExpertLearningJob>('job:'+id)!.value;}
 async function step(id:string,target=controller){const job=read(id);ctx.learning={budgetId:job.budgetId,sourceRunId:job.sourceRunId,lease,canAdmit:()=>true};return (await target.executeLearningJob(id,ctx,{lease,budgetId:job.budgetId})).job;}
 return {dir,controller,budget,lease,ctx,response,operations,extract,validation,read,step,mode:(value:typeof mode)=>{mode=value;},close:()=>{releaseLearningLease(controller.store,lease);controller.dispose();rmSync(dir,{recursive:true,force:true});}};
}

for(const stage of ['extract','validation','release'] as const)test(`confirmed length stops ${stage} at its original cursor and never replays after repeated execution or restart`,async()=>{
 const f=fixture();try{
  const queued=stage==='extract'?await f.extract():await f.validation();
  if(stage==='release'){f.mode('paired');for(let i=0;i<6;i++)await f.step(queued.jobId);assert.equal(f.read(queued.jobId).stage,'release');f.mode('length');}
  const before=f.read(queued.jobId),callsBefore=f.operations.length,versionsBefore=f.controller.store.list('skill.version:').length,job=await f.step(queued.jobId);
  assert.equal(job.state,'failed');assert.equal(job.cursor,before.cursor);assert.equal(job.side,before.side);assert.equal(job.stage,stage);assert.equal(job.callSequence,before.callSequence);assert.equal(job.attempts,before.attempts);assert.equal(job.unknown,undefined);assert.equal(job.nextAttemptAt,undefined);assert.match(job.error!,/length.*未完成.*不自动重发/);assert.ok(job.pendingOperationId);assert.ok(job.pendingCallId);
  assert.deepEqual(job.incompleteResponse,{...f.response,operationId:job.pendingOperationId,callId:job.pendingCallId,uncovered:{stage,cursor:before.cursor,side:before.side}});assert.equal(f.budget.readCall(job.budgetId,job.pendingOperationId!)!.state,'failed');assert.equal(f.controller.store.list('skill.version:').length,versionsBefore);assert.equal(f.controller.store.get('evaluation:'+job.id),undefined);
  for(let i=0;i<4;i++)assert.equal((await f.step(job.id)).state,'failed');wakeExpertLearningJobs(f.dir);assert.equal(peekExpertLearningJob(f.dir),undefined);
  const reopened=new ExpertController(f.dir);try{assert.deepEqual((await f.step(job.id,reopened)).incompleteResponse,job.incompleteResponse);assert.equal((await reopened.dispatch('jobs.read',{id:job.id},f.ctx) as ExpertLearningJob).incompleteResponse?.stopReason,'length');}finally{reopened.dispose();}
  assert.equal(f.operations.length,callsBefore+1);assert.equal(new Set(f.operations).size,f.operations.length);assert.equal(f.budget.read(job.budgetId).calls,callsBefore+1);if(stage==='extract')assert.equal(job.candidateId,undefined);else assert.equal(f.controller.skillCatalog.head(job.candidateId!,f.ctx).status,'candidate');
 }finally{f.close();}
});

test('confirmed length in the durable call ledger stops even when the thrown error lacks response details',async()=>{const f=fixture();try{f.mode('ledger-length');const queued=await f.extract(),job=await f.step(queued.jobId);assert.equal(job.state,'failed');assert.equal(job.incompleteResponse?.stopReason,'length');assert.equal(job.callSequence,undefined);await f.step(job.id);assert.equal(f.operations.length,1);}finally{f.close();}});

test('cold recovery of a dispatched job with a confirmed length ledger preserves incomplete scope without replay',async()=>{const f=fixture();try{const queued=await f.extract(),job=await f.step(queued.jobId),row=f.controller.store.get<ExpertLearningJob>('job:'+job.id)!;f.controller.store.put(row.key,{...job,state:'running',lease:undefined,incompleteResponse:undefined,error:undefined},row.revision);const recovered=new ExpertController(f.dir);try{const saved=recovered.store.get<ExpertLearningJob>('job:'+job.id)!.value;assert.equal(saved.state,'failed');assert.equal(saved.unknown,undefined);assert.deepEqual(saved.incompleteResponse,job.incompleteResponse);await f.step(job.id,recovered);assert.equal(f.operations.length,1);}finally{recovered.dispose();}}finally{f.close();}});

for(const mode of ['schema','proposal'] as const)test(`ordinary ${mode} failure keeps three bounded, separately accounted attempts`,async()=>{const f=fixture();try{f.mode(mode);const queued=await f.extract();assert.equal((await f.step(queued.jobId)).state,'retryable');assert.equal((await f.step(queued.jobId)).state,'retryable');const job=await f.step(queued.jobId);assert.equal(job.state,'failed');assert.equal(job.attempts,3);assert.equal(job.incompleteResponse,undefined);assert.equal(job.candidateId,undefined);assert.equal(f.operations.length,3);assert.equal(new Set(f.operations).size,3);assert.equal(f.budget.read(job.budgetId).calls,3);await f.step(job.id);assert.equal(f.operations.length,3);}finally{f.close();}});
