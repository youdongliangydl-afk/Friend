import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ModelRuntime,SessionManager,initTheme} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {RecordStore,LearningBudget,SourcePolicy,CapabilityError,digest,visibleText,historyItems,type PluginContext,type HostEvalRequest,type HostEvaluationSuite,type ExpertScenario} from '../packages/core/src/index.js';
import {createExpertEvaluationHost} from '../apps/desktop/src/expert-evaluation-host.js';
import type {RegisteredEvaluationSuite} from '../apps/desktop/src/expert-evaluation-cases.js';

interface FixtureOptions {toolFirst?:boolean;stopReason?:'length'|'error'}
interface HostOperation {
 requestHash:string;sessionId?:string;nativeFile?:string;safeContinuation?:boolean;providerOperationIds?:string[];
}
const scenarios:ExpertScenario[]=['code-development','code-repair','source-research','structured-delivery'];

async function fixture(options:FixtureOptions={}){
 const dir=mkdtempSync(join(tmpdir(),'friend-sdk-evaluation-')),projectDir=join(dir,'project'),dataDir=join(dir,'data');mkdirSync(projectDir);initTheme('light',false);
 const store=new RecordStore('runtime',dataDir),policy=new SourcePolicy(store),budget=new LearningBudget(store),bodies=new Map([['baseline:1','Stable fixture method'],['candidate:1','Candidate fixture method']]);
 const baseline={id:'baseline',version:1,hash:digest(bodies.get('baseline:1'))},candidate={id:'candidate',version:1,hash:digest(bodies.get('candidate:1'))};
 for(const ref of [baseline,candidate])policy.publishDependency({capability:'expert',projectId:'project',...ref,valid:true});
 const providerId='evaluation-fixture-'+randomUUID().slice(0,8),runtime=await ModelRuntime.create({authPath:join(dataDir,'pi','auth.json'),modelsPath:join(dataDir,'pi','models.json'),allowModelNetwork:false});
 const provider=fauxProvider({provider:providerId,models:[{id:'offline',name:'Test-only SDK evaluation',input:['text'],reasoning:false,contextWindow:32000,maxTokens:2048}]});
 let calls=0,sourceAvailable=true,route='https://evaluation-fixture.invalid/stable',afterFirst:(()=>void|Promise<void>)|undefined;
 const prompts:string[]=[],providerUsers:string[][]=[],methodReads:{id:string;version:number}[]=[],role={id:'implementer',effectiveTools:['read','write'],effectiveWriteScopes:['.'],responsibility:'Complete only the registered task.'};
 const originalGetModel=runtime.getModel.bind(runtime);runtime.getModel=(providerId,modelId)=>{const model=originalGetModel(providerId,modelId);return model?{...model,baseUrl:route}:undefined;};
 function hostRead<T>(key:string){const hostStore=new RecordStore('expert-evaluation-host',dataDir);try{return hostStore.get<T>(key)?.value;}finally{hostStore.close();}}
 function operation(request:HostEvalRequest){const value=hostRead<HostOperation>(`operation:project:${request.operationId}`);assert.ok(value);return value;}
 function registered(suite:HostEvaluationSuite):RegisteredEvaluationSuite{
  const saved=hostRead<{registered:RegisteredEvaluationSuite}>(`suite:project:${suite.suiteId}`);assert.ok(saved);return saved.registered;
 }
 // Test-only oracle reads the private persisted suite after the host freezes its nonce.
 // Production SDK context receives the public task/materials, never this expected output.
 const respond:Parameters<typeof provider.setResponses>[0][number]=async context=>{
  calls++;provider.appendResponses([respond]);const users=context.messages.filter(message=>message.role==='user').map(message=>visibleText(message.content)),prompt=users[0];prompts.push(prompt);providerUsers.push(users);
  const hostStore=new RecordStore('expert-evaluation-host',dataDir);let examples:RegisteredEvaluationSuite['validation'];try{examples=hostStore.list<{registered:RegisteredEvaluationSuite}>('suite:project:').flatMap(row=>[...row.value.registered.validation,...row.value.registered.release]);}finally{hostStore.close();}
  const example=examples.find(example=>prompt.startsWith(example.prompt));assert.ok(example,'actual SDK receives a task from its persisted random suite');
  const check=example.checks[0],answer=check.kind==='code-exact'?{code:check.expected}:check.expected;
  if(calls===1)await afterFirst?.();
  if(options.toolFirst&&!context.messages.some(message=>message.role==='toolResult'))return fauxAssistantMessage(fauxToolCall('write',{path:'result.json',content:JSON.stringify(answer)}),{stopReason:'toolUse'});
  return fauxAssistantMessage(JSON.stringify(answer),options.stopReason?{stopReason:options.stopReason,...(options.stopReason==='error'?{errorMessage:'intentional unknown provider fixture'}:{})}:{});
 };
 provider.setResponses([respond]);runtime.registerNativeProvider(provider.provider);await runtime.setRuntimeApiKey(providerId,'explicit-test-only-key');
 const ctx:PluginContext={origin:'plugin',dataDir,agentDir:join(dataDir,'pi'),projectDir,projectId:'project',sessionId:'parent',runId:'run',modelId:providerId+'/offline',thinkingLevel:'off',executionMode:'single',policy:{v:1,revision:1,runId:'run',stage:'settled',canSwitchRole:true,unsettledTools:0,tools:['read','write'],writeScopes:['.'],executionMode:'single',planMode:false},isIdle:()=>true,history:()=>[],readSource:ref=>{
  const registry=new RecordStore('sessions',dataDir);try{const source=registry.get<{path:string}>(ref.sessionId);assert.ok(source);const entry=historyItems(SessionManager.open(source.value.path).getEntries()).find(entry=>entry.id===ref.entryId);assert.ok(entry);return entry;}finally{registry.close();}
 },readCheck:ref=>policy.readCheck(ref,'project'),complete:async()=>{throw new Error('SDK evaluator must not bypass public Pi with ctx.complete');},request:async(plugin,action,input={})=>{
  assert.equal(plugin,'expert');if(action==='role.snapshot')return {current:role};if(action==='snapshot')return {};
  assert.equal(action,'skill.read');const ref={id:String(input.id),version:Number(input.version)};methodReads.push(ref);const body=bodies.get(`${ref.id}:${ref.version}`);if(!sourceAvailable||body===undefined)throw new CapabilityError('SOURCE_UNAVAILABLE','fixture original method source withdrawn');return {...ref,body,contentHash:digest(body),status:ref.id==='baseline'?'validated':'trial',evidence:[]};
 },emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 const host=createExpertEvaluationHost({context:()=>ctx,runtime,canAdmit:()=>true});
 async function catalog(scenario:ExpertScenario,tools=options.toolFirst?['write']:[]){const suite=await host.catalog({scenario,baseline,candidate,modelId:ctx.modelId!,thinkingLevel:'off',tools});assert.ok(suite);return suite;}
 async function request(scenario:ExpertScenario,limit=64){
  const suite=await catalog(scenario),account=budget.create({projectId:'project',sourceRunId:'run',maxCalls:limit}),example=suite.validation[0];
  const request:HostEvalRequest={v:1,operationId:'operation-'+scenario,budgetId:account.budgetId,sourceRunId:'run',suiteId:suite.suiteId,suiteHash:suite.suiteHash,phase:'validation',caseId:example.id,taskRef:example.taskRef,repetition:0,side:'baseline',method:{...baseline,body:bodies.get('baseline:1')!},baseline,candidate,modelId:ctx.modelId!,thinkingLevel:'off',tools:options.toolFirst?['write']:[],environmentHash:suite.environmentHash,checkerHash:suite.checkerHash,promptHash:suite.promptHash,roleHash:suite.roleHash,materialsHash:suite.materialsHash,timeoutMs:10000};return request;
 }
 function checkCount(){const checks=new RecordStore('checks',dataDir);try{return checks.list('check:').length;}finally{checks.close();}}
 return {dir,ctx,host,request,catalog,registered,operation,budget,policy,store,baseline,candidate,role,methodReads,checkCount,calls:()=>calls,prompts,providerUsers,onFirst(callback:()=>void|Promise<void>){afterFirst=callback;},withdrawSource(){sourceAvailable=false;},changeRoute(){route='https://evaluation-fixture.invalid/changed';},close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('four registered scenarios run public Pi sessions with exact methods, authoritative checks and native refs',async()=>{
 const f=await fixture();try{
  for(const scenario of scenarios){
   const request=await f.request(scenario),result=await f.host.advance(request);assert.equal(result.status,'completed');assert.ok(result.checks.length>0&&result.checks.every(check=>check.passed));assert.ok(result.nativeEvidence.length);assert.equal(result.usage.providerRequests,1);assert.ok(result.usage.totalTokens!>0);assert.equal(f.budget.read(request.budgetId).calls,1);assert.equal(result.timing.queueWaitKnown,false);
   for(const check of result.checks){const receipt=f.policy.readCheck(check.ref!,'project');assert.equal(receipt.passed,true);assert.equal(receipt.ref.producerRunId,request.operationId);assert.equal(receipt.ref.taskId,request.operationId);}
   for(const source of result.nativeEvidence)assert.ok(f.ctx.readSource(source));
   const before=f.calls();assert.deepEqual(await f.host.advance(request),result);assert.deepEqual(await f.host.read({operationId:request.operationId}),result);assert.equal(f.calls(),before);
   await assert.rejects(f.host.advance({...request,method:{...request.method,body:'tampered'}}),/operationId/);
  }
  assert.equal(f.calls(),4);assert.ok(f.methodReads.length>=8);assert.ok(f.methodReads.every(ref=>ref.version===1&&['baseline','candidate'].includes(ref.id)));
 }finally{f.close();}
});

test('one-to-two provider budget continues the same native session without replaying its first request',async()=>{
 const f=await fixture({toolFirst:true});try{
  const request=await f.request('structured-delivery',1),first=await f.host.advance(request,{queuedAt:new Date(Date.now()-20).toISOString()});assert.equal(first.status,'waiting');assert.match(first.reason||'',/预算/);assert.equal(f.calls(),1);assert.equal(first.usage.providerRequests,1);assert.equal(first.checks.length,0);assert.equal(f.checkCount(),0);assert.ok(first.nativeEvidence.length);
  const initial=f.operation(request),prefix=readFileSync(initial.nativeFile!,'utf8'),receipt=structuredClone(f.budget.readCall(request.budgetId,`${request.operationId}:provider:0`));assert.equal(initial.safeContinuation,true);assert.equal(receipt!.state,'complete');
  assert.deepEqual(await f.host.advance(request),first);assert.equal(f.calls(),1);f.budget.increaseLimit(request.budgetId,2);
  const completed=await f.host.advance(request);assert.equal(completed.status,'completed');assert.ok(completed.checks.every(check=>check.passed));assert.equal(completed.usage.providerRequests,2);assert.equal(f.calls(),2);assert.equal(f.budget.read(request.budgetId).calls,2);
  const final=f.operation(request);assert.equal(final.sessionId,initial.sessionId);assert.equal(final.nativeFile,initial.nativeFile);assert.ok(readFileSync(final.nativeFile!,'utf8').startsWith(prefix));assert.deepEqual(f.budget.readCall(request.budgetId,`${request.operationId}:provider:0`),receipt);assert.equal(f.budget.readCall(request.budgetId,`${request.operationId}:provider:1`)!.state,'complete');
  assert.equal(f.providerUsers[1].length,2);assert.equal(f.providerUsers[1][0],f.providerUsers[0][0]);assert.match(f.providerUsers[1][1],/继续同一冻结任务/);assert.equal(completed.timing.admittedAt,first.timing.admittedAt);assert.equal(completed.timing.queueWaitKnown,true);assert.ok(completed.timing.queueWaitMs>=0);
  assert.deepEqual(await f.host.advance(request),completed);assert.equal(f.calls(),2);
 }finally{f.close();}
});

test('a length result retains known usage but registers no check and never automatically reruns',async()=>{
 const f=await fixture({stopReason:'length'});try{
  const request=await f.request('code-development'),result=await f.host.advance(request);assert.equal(result.status,'waiting');assert.match(result.reason||'',/length/);assert.equal(result.usage.unknown,false);assert.ok(result.usage.totalTokens!>0);assert.equal(result.checks.length,0);assert.equal(f.checkCount(),0);
  const receipt=f.budget.readCall(request.budgetId,`${request.operationId}:provider:0`)!;assert.equal(receipt.state,'failed');assert.equal(receipt.response?.stopReason,'length');assert.equal(receipt.response?.complete,false);assert.equal(f.operation(request).safeContinuation,false);
  assert.deepEqual(await f.host.advance(request),result);assert.deepEqual(await f.host.read({operationId:request.operationId}),result);assert.equal(f.calls(),1);assert.equal(f.budget.read(request.budgetId).calls,1);
 }finally{f.close();}
});

test('an unknown provider result remains non-replayable with its original usage uncertainty',async()=>{
 const f=await fixture({stopReason:'error'});try{
  const request=await f.request('code-repair'),result=await f.host.advance(request);assert.equal(result.status,'unknown');assert.equal(result.usage.unknown,true);assert.equal(result.usage.totalTokens,null);assert.equal(result.checks.length,0);assert.equal(f.checkCount(),0);assert.equal(f.operation(request).safeContinuation,false);
  assert.deepEqual(await f.host.advance(request),result);assert.deepEqual(await f.host.read({operationId:request.operationId}),result);assert.equal(f.calls(),1);assert.equal(f.budget.read(request.budgetId).calls,1);
 }finally{f.close();}
});

for(const change of ['source','role','parent-policy','route'] as const)test(`a ${change} change before a second SDK request prevents any additional provider request`,async()=>{
 const f=await fixture({toolFirst:true});try{
  const request=await f.request('structured-delivery');f.onFirst(()=>{if(change==='source')f.withdrawSource();else if(change==='role')f.role.responsibility='Changed role contract';else if(change==='parent-policy')f.ctx.policy!.tools=['read'];else f.changeRoute();});
  const result=await f.host.advance(request);assert.equal(result.status,'waiting');assert.equal(f.calls(),1);assert.equal(f.budget.read(request.budgetId).calls,1);assert.equal(result.checks.length,0);assert.equal(f.checkCount(),0);assert.equal(f.operation(request).safeContinuation,false);assert.match(result.reason||'',/来源|方法|角色|权限|路由|环境|source withdrawn/);
  assert.deepEqual(await f.host.advance(request),result);assert.equal(f.calls(),1);
 }finally{f.close();}
});

test('source revocation before admission and insufficient role write scope send no provider request',async()=>{
 const f=await fixture();try{
  const request=await f.request('code-development');f.policy.publishDependency({capability:'expert',projectId:'project',...request.candidate,valid:false});await assert.rejects(f.host.advance(request),/来源|依赖/);assert.equal(f.calls(),0);
  f.role.effectiveWriteScopes=['src'];const suite=await f.host.catalog({scenario:'structured-delivery',baseline:f.baseline,candidate:f.candidate,modelId:f.ctx.modelId!,thinkingLevel:'off',tools:['write']});assert.equal(suite,undefined);f.role.effectiveWriteScopes=['.'];f.ctx.policy!.writeScopes=['src'];assert.equal(await f.host.catalog({scenario:'structured-delivery',baseline:f.baseline,candidate:f.candidate,modelId:f.ctx.modelId!,thinkingLevel:'off',tools:['write']}),undefined);assert.equal(f.calls(),0);
 }finally{f.close();}
});

test('catalog hides random expected answers and persists four independent positive contracts per scenario',async()=>{
 const f=await fixture();try{
  for(const scenario of scenarios){
   const suite=await f.catalog(scenario),again=await f.catalog(scenario),registered=f.registered(suite);assert.deepEqual(again,suite);assert.match(registered.nonce,/^[a-f0-9]{32}$/);assert.notEqual(registered.nonce,'public-initial-template-v2');
   for(const example of [...suite.validation,...suite.release])assert.deepEqual(Object.keys(example).sort(),['critical','families','id','inputHash','kind','taskRef']);
   const publicJson=JSON.stringify(suite);assert.equal(publicJson.includes(registered.nonce),false,'public case families must not disclose the private nonce used to construct hidden answers');for(const forbidden of ['expected','nonce','materials','prompt'])assert.equal(publicJson.includes(`"${forbidden}"`),false);
   const positives=[...registered.validation,...registered.release].filter(example=>example.kind==='positive');assert.equal(positives.length,4);assert.equal(new Set(positives.flatMap(example=>example.checks.map(check=>check.id))).size,4);assert.equal(new Set(positives.flatMap(example=>example.families)).size,4);
   const expected=positives.map(example=>JSON.stringify(example.checks[0].expected));if(scenario==='code-development'){assert.match(expected[0],/a\+b/);assert.match(expected[1],/Math\.min/);assert.match(expected[2],/new Set/);assert.match(expected[3],/trim/);}else if(scenario==='code-repair'){assert.match(expected[0],/value\*/);assert.match(expected[1],/<=/);assert.match(expected[2],/b===0\?null/);assert.match(expected[3],/a===b/);}else if(scenario==='source-research'){for(const [index,key] of ['sampleSize','groups','days','failures'].entries())assert.ok(expected[index].includes(key));}else{for(const [index,key] of ['total','project','rank','delivery'].entries())assert.ok(expected[index].includes(key));}
  }
  assert.equal(f.calls(),0);
 }finally{f.close();}
});
