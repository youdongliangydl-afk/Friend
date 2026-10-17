import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {approvedPlanPrompt,recoverPlanInputs} from '../apps/desktop/src/plan-input.js';
import {RecordStore,digest} from '@friend-pi/core';
import {PlanStore,type PlanExecution} from '../apps/desktop/src/plan-store.js';
import {projectPlanContext,PLAN_CONTEXT_TYPE} from '../apps/desktop/src/plan-context.js';
import {projectMessages} from '../apps/desktop/src/message-projection.js';
import {projectTimeline} from '../apps/desktop/src/renderer/timeline.js';
import {nextDialog} from '../apps/desktop/src/renderer/dialog-queue.js';
import {BatchQuestionCard,questionDraftKey} from '../apps/desktop/src/renderer/BatchQuestionCard.js';
import {PlanPreview} from '../apps/desktop/src/renderer/plan-preview.js';
import type {QuestionBatchDialog} from '../apps/desktop/src/question-batch.js';

const config={modelId:'fixture/model',thinkingLevel:'off',mode:'single' as const,permissionMode:'auto' as const};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'friend-plan-mode-')),store=new RecordStore('plans',dir),plans=new PlanStore(store,'project','session');return {store,plans,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}

test('legacy plans remain readable but cannot authorize execution; revised versions supersede old decisions',()=>{
 const f=fixture();try{
  const plan=f.plans.submit('Read only.',config);delete plan.submission;f.store.put('plan:project:session',plan);
  assert.equal(f.plans.current()?.body,plan.body);assert.throws(()=>f.plans.decide('approve',{...plan},config),/提交来源/);
  f.plans.supersede();assert.throws(()=>f.plans.decide('approve',{...plan},config),/版本已变化/);
  const revised=f.plans.submit('Read and verify.',config,{v:1,via:'tool',runId:'planning',toolCallId:'submit'});
  assert.equal(revised.revision,plan.revision+1);assert.throws(()=>f.plans.decide('approve',{...plan},config),/版本已变化/);
  assert.throws(()=>f.plans.decide('approve',{...revised},{...config,permissionMode:'ask'}),/配置已变化/);
  assert.equal(f.plans.approve({...revised},config,'execute').plan.hash,revised.hash);
 }finally{f.close();}
});

test('request context replaces stale projections, preserves tool adjacency and freezes the approved document',()=>{
 const f=fixture();try{
  const plan=f.plans.submit('APPROVED_DOCUMENT',config),execution=f.plans.approve({...plan},config,'execute');
  const messages:any[]=[{role:'system',content:'base',timestamp:1},{role:'user',content:'original task',timestamp:2},{role:'assistant',content:[{type:'toolCall',name:'read',id:'read-call',arguments:{path:'README.md'}}],timestamp:3},{role:'toolResult',toolName:'read',toolCallId:'read-call',content:[{type:'text',text:'result'}],isError:false,timestamp:4}];
  const first=projectPlanContext(messages,{planMode:false,current:plan,execution});
  f.plans.supersede();const revised=f.plans.submit('UNAPPROVED_REVISION',config);
  const second=projectPlanContext(first,{planMode:false,current:revised,execution});
  const contexts=second.filter(message=>message.role==='custom'&&message.customType===PLAN_CONTEXT_TYPE);
  assert.equal(contexts.length,1);assert.match(String((contexts[0] as {content:unknown}).content),/APPROVED_DOCUMENT/);assert.doesNotMatch(String((contexts[0] as {content:unknown}).content),/UNAPPROVED_REVISION/);
  assert.deepEqual(second.slice(-2),messages.slice(-2));assert.equal(second.at(-3)?.role,'user');assert.equal(messages.length,4);
  const planning=projectPlanContext(messages,{planMode:true,current:{...revised,status:'superseded'}});
  assert.match(String((planning[1] as {content:unknown}).content),/待修订的上一版/);assert.match(String((planning[1] as {content:unknown}).content),/friend_questions/);
  const empty=projectPlanContext(messages,{planMode:true});assert.match(String((empty[1] as {content:unknown}).content),/尚未提交正式计划/);
 }finally{f.close();}
});

test('execution receipts bind one run, retain terminal outcomes and never replay on recovery',()=>{
 const f=fixture();try{
  const plan=f.plans.submit('Read and write once.',config),execution=f.plans.approve({...plan},config,'run');
  assert.equal(f.plans.executionForRun('other'),undefined);assert.equal(f.plans.executionForRun('run')?.id,execution.id);
  f.plans.updateExecution(execution,'started',{nativeEntryId:'native-user'});f.plans.recover();
  assert.equal(f.plans.executionForRun('run')?.status,'interrupted');assert.equal(f.plans.executionForRun('run')?.nativeEntryId,'native-user');
  f.plans.updateExecution(execution,'started');assert.equal(f.plans.executionForRun('run')?.status,'interrupted');
 }finally{f.close();}
});

test('approval input is rendered as a short system event while native content remains intact',()=>{
 const text='host instruction with plan identity';
 const entries=[{type:'message',id:'native',message:{role:'user',content:[{type:'text',text}],timestamp:1}},{type:'custom',customType:'friend-pi.runtime-wake.input',data:{entryId:'native',hash:digest(text),textEnd:text.length,runId:'run',planExecutionId:'execution'}}];
 const projected=projectMessages(entries);assert.equal(projected[0].role,'automatic');assert.equal(projected[0].text,text);assert.equal(projected[0].senderLabel,'系统');
 assert.deepEqual(projectTimeline(projected,null,[],false)[0].parts,[{kind:'text',text:'计划已批准，开始执行'}]);
 entries[1].data!.hash='tampered';const invalid=projectMessages(entries);assert.equal(invalid[0].role,'user');assert.equal(invalid[0].displayText,undefined);
});

const question:QuestionBatchDialog={v:1,id:'question',kind:'questionBatch',generation:'generation',runId:'run',toolCallId:'call',createdAt:1,sequence:1,title:'书的类别',questions:[{id:'category',type:'single',title:'选择类别',required:true,options:[{id:'history',label:'历史'},{id:'literature',label:'文学'}]}]};
test('foreground dialogs serialize permission and clarification; a deferred form retains its answers',()=>{
 const permission={id:'permission',kind:'confirm' as const,title:'确认写入'};
 assert.equal(nextDialog([question,permission])?.id,'permission');assert.equal(nextDialog([question,permission],true),undefined);assert.equal(nextDialog([question])?.id,question.id);
 const drafts=new Map([[questionDraftKey(question),{answers:{category:{questionId:'category',optionIds:['history']}},step:0,review:false,collapsed:false,other:[]}]]);
 const render=()=>renderToStaticMarkup(React.createElement(BatchQuestionCard,{dialog:question,drafts,respond:async()=>{},onDefer:()=>{}}));
 assert.match(render(),/稍后回答/);assert.match(render(),/checked=""/);assert.match(render(),/取消整组/);
 assert.match(render(),/checked=""/,'remounting the same deferred native request restores its draft');
 const html=renderToStaticMarkup(React.createElement(PlanPreview,{body:'legacy',disabled:false,requiresResubmission:true,onRead(){},onApprove(){},onRevise(){},onReject(){}}));assert.match(html,/旧计划需重新提交/);assert.match(html,/disabled=""/);
});

test('actual worker approval branch is single-flight and stop during preparation cannot start a prompt',async()=>{
 const f=fixture();try{
  let release:()=>void=()=>{},entered:()=>void=()=>{};const preparing=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);
  let starts=0;const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8'),start=source.indexOf("  if(method==='plan.approve'){"),end=source.indexOf("  if(method==='plan.reject'){",start);
  assert.ok(start>0&&end>start);
  const context:any={plans:f.plans,approvedPlanPrompt,queueEpoch:0,disposed:false,stopping:false,missingModelId:undefined,planApproval:undefined,permissionEpoch:0,permissionMode:'auto',executionMode:'single',runId:'planning',session:{isIdle:true,model:{provider:'fixture',id:'model'},thinkingLevel:'off',sessionManager:{appendCustomEntry(){}}},process:{env:{}},swarmBusy:()=>false,cancelQueueResume(){},async applyAssignedRole(){entered();await barrier;},async ensureModelReady(){},randomUUID:()=> 'execute',publicError:String,current:()=>({}),publish(){},async handle(_method:string,_input:unknown,_execution:PlanExecution){starts++;return {accepted:true};}};
  const body=ts.transpileModule(`async function approve(input:Record<string,unknown>){const method='plan.approve';${source.slice(start,end)}}`,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText;
  vm.runInNewContext(body,context);const plan=f.plans.submit('One execution.',config);
  const first=context.approve({...plan}),duplicate=context.approve({...plan});await preparing;context.queueEpoch++;release();
  const results=await Promise.allSettled([first,duplicate]);assert.ok(results.every(result=>result.status==='rejected'));assert.equal(starts,0);assert.equal(f.plans.current()?.status,'proposed');
  context.applyAssignedRole=async()=>{};const accepted=await Promise.all([context.approve({...plan}),context.approve({...plan})]);assert.equal(starts,1);assert.deepEqual(accepted[0],accepted[1]);
  await context.approve({...plan});assert.equal(starts,1,'a receipt retry cannot execute twice');
  const next=f.plans.submit('Next version.',config);context.session.sessionManager.appendCustomEntry=()=>{throw new Error('native history unavailable');};
  await assert.rejects(context.approve({...next}),/native history unavailable/);assert.equal(f.plans.execution(next)?.status,'failed');assert.equal(starts,1);
 }finally{f.close();}
});


test('startup restores a missing host input attribution without copying or replaying native history',()=>{
 const f=fixture();try{
  const plan=f.plans.submit('Execute once.',config),execution=f.plans.approve({...plan},config,'crashed-run'),manager=SessionManager.inMemory('/project');
  manager.appendCustomEntry('friend-pi.plan.decision',{executionId:execution.id,runId:execution.runId});
  manager.appendCustomEntry('friend-pi.run.policy.v1',{v:1,runId:execution.runId});
  manager.appendMessage({role:'user',content:approvedPlanPrompt(execution),timestamp:1});
  recoverPlanInputs(manager,f.plans);recoverPlanInputs(manager,f.plans);
  const entries=manager.getBranch();assert.equal(entries.filter(entry=>entry.type==='message').length,1);
  assert.equal(entries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.runtime-wake.input').length,1);
  assert.equal(f.plans.executionForRun(execution.runId)?.status,'interrupted');
  const messages=projectMessages(entries);assert.equal(messages[0].role,'automatic');assert.equal(messages[0].displayText,'计划执行已中断，未自动重放');
 }finally{f.close();}
});


test('desktop approval cannot cross a stop or worker replacement while model readiness is pending',{timeout:5000},async()=>{
 const source=readFileSync('apps/desktop/src/main.ts','utf8'),start=source.indexOf("  if(method.startsWith('plan.')){");
 assert.ok(start>0);const stop=source.indexOf("\n  if(method==='session.stop')",start);assert.ok(stop>start);const block=source.slice(start,stop);
 let release:()=>void=()=>{},entered:()=>void=()=>{};const prepared=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);
 let requests=0;const worker={record:{id:'desktop'},state:{permissionEpoch:1,runId:'planning',modelId:'fixture/model'}};
 const context:any={worker,workers:new Map([['desktop',worker]]),randomUUID:()=> 'execute',dataDir:'/tmp',async getProviderRuntime(){return {};},async requireReadyModel(){entered();await barrier;},async request(){requests++;return {};},object:(value:unknown)=>value,persistWorker(){},publishState(){}};
 const body=ts.transpileModule(`async function approve(input:Record<string,unknown>){const method='plan.approve';${block}}`,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText;vm.runInNewContext(body,context);
 const approval=context.approve({});await prepared;worker.state.permissionEpoch++;release();await assert.rejects(approval,/已取消/);assert.equal(requests,0);
});
