import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,peekLearningJob,type MemoryRecord,type LearningJob} from '../src/index.js';
import {RecordStore,SourcePolicy,LearningBudget,learningRequestHash,CapabilityError,digest,readSourceSpan,type PluginContext,type HistoryItem,type ArtifactRef,type EvidenceReceipt} from '../../core/src/index.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-capability-')),items:HistoryItem[]=[{id:'user1',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'今后我偏好中文解释。'}];
 const previous=process.env.FRIEND_PI_LEARNING_ROLE;process.env.FRIEND_PI_LEARNING_ROLE='producer';
 let calls=0,requests=0;const journal:{type:string;data:any}[]=[];
 const ctx:PluginContext={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'foreground-1',modelId:'fixture/offline',isIdle:()=>false,history:()=>items,readSource:source=>{const item=items.find(item=>item.id===source.entryId);if(!item)throw new Error('来源不存在');readSourceSpan(item,source);return item;},complete:async()=>{calls++;return '{"memories":[]}';},request:async()=>{requests++;throw new Error('not installed');},emit:()=>{},notify:()=>{},appendEntry:(type,data)=>journal.push({type,data:structuredClone(data)})};
 const c=new MemoryController();return {dir,ctx,items,c,journal,calls:()=>calls,requests:()=>requests,close:async()=>{await c.dispose();if(previous===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=previous;rmSync(dir,{recursive:true,force:true});}};
}
async function drain(c:MemoryController,ctx:PluginContext){for(let i=0;i<80;i++){const job=peekLearningJob(ctx.dataDir);if(!job)break;await c.executeLearningJob(job.id,ctx);}}
const save=(c:MemoryController,ctx:PluginContext,input:Record<string,unknown>)=>c.dispatch('save',{explicitRemember:true,...input},ctx) as Promise<MemoryRecord>;

test('weighted title/alias FTS, exact literals and explanations keep projects isolated (03-05,08)',async()=>{
 const f=fixture();try{
  const target=await save(f.c,f.ctx,{title:'差旅报销失败',content:'发票重复导致退回',aliases:['费用报销','Reimburse.API','src/Expense.ts']});
  await save(f.c,f.ctx,{title:'普通记录',content:'差旅报销失败 '.repeat(30)});
  assert.equal(f.c.search({query:'差旅报销失败'},f.ctx)[0].id,target.id);
  assert.equal(f.c.search({query:'费用报销'},f.ctx)[0].id,target.id);
  assert.equal(f.c.search({query:'ＲＥＩＭＢＵＲＳＥ.api'},f.ctx)[0].id,target.id);
  assert.equal(f.c.search({query:'src/Expense.ts'},f.ctx)[0].id,target.id);
  assert.deepEqual(f.c.search({query:'报账新词'},f.ctx),[]);
  const explained=await f.c.dispatch('search.explain',{query:'费用报销'},f.ctx) as any;
  assert.ok(explained.matches[0].fields.aliases.length);assert.equal(explained.ruleVersion,2);
  assert.deepEqual(f.c.search({query:'费用报销'},{...f.ctx,projectId:'another'}),[]);
  await assert.rejects(f.c.dispatch('search.explain',{queryId:explained.queryId},{...f.ctx,projectId:'another'}),{code:'PERMISSION_DENIED'});
  assert.equal((await f.c.dispatch('read',{id:target.id},f.ctx) as MemoryRecord).hash,digest(target.content));
 }finally{await f.close();}
});

test('whole semantic records keep the condition beyond character 1001; excluded bodies only expose directory (06-07)',async()=>{
 const f=fixture();try{
  const content='部署说明。'+'步骤内容'.repeat(260)+'仅测试环境适用，禁止生产执行。';
  const record=await save(f.c,f.ctx,{title:'部署',content,conditions:['仅测试环境适用']});f.items[0].text='部署说明';f.c.beginRun(f.ctx);
  const recalled=f.c.recall(f.ctx)!;assert.ok(recalled.content.includes('禁止生产执行'));assert.equal(recalled.receipt.records[0].sentSliceHash,digest(content));assert.equal(recalled.receipt.records[0].fullLength,content.length);
  const small=await f.c.dispatch('select',{query:'部署',budget:100},f.ctx) as any;assert.equal(small.records.length,0);assert.equal(small.directory[0].id,record.id);assert.equal(small.omitted[0].bodyRead,false);
  f.c.observeContext([{content:recalled.content}],f.ctx);assert.equal((f.c.usage(f.ctx).receipts as any[])[0].stage,'injected-to-context');
  assert.ok(!(f.c.usage(f.ctx).receipts as any[]).some(r=>r.stage==='request-prepared'));
 }finally{await f.close();}
});

test('paged reads return exact UTF16 slices and complete conditions and reject stale revisions (06,19,30)',async()=>{
 const f=fixture();try{
  const content=('第一节保留中文和😀。\n第二节仅测试环境适用。\n').repeat(700),record=await save(f.c,f.ctx,{content,conditions:['仅测试环境适用']});let cursor:number|undefined=0,reconstructed='';
  while(cursor!==undefined){const page=await f.c.dispatch('read.range',{id:record.id,revision:record.revision,cursor,maxChars:1000},f.ctx) as any;assert.equal(page.sentSliceHash,digest(page.content));assert.deepEqual(page.conditions,['仅测试环境适用']);assert.ok(page.content.length<=1000);reconstructed+=page.content;cursor=page.nextCursor;}
  assert.equal(reconstructed,content);
  await f.c.dispatch('update',{id:record.id,expectedRevision:1,content:'新版本'},f.ctx);
  await assert.rejects(f.c.dispatch('read.range',{id:record.id,revision:1},f.ctx),{name:'ConflictError'});
  const ref={sessionId:'s',entryId:'user1',start:2,end:5,hash:digest(f.items[0].text.slice(2,5))};const original=await f.c.dispatch('source.read',{source:ref},f.ctx) as any;assert.equal(original.text,f.items[0].text.slice(2,5));assert.equal(original.fullLength,3);
 }finally{await f.close();}
});

test('operation IDs reuse original results, reject changed payload and CAS conflict is atomic (19-20)',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'原始事实',operationId:'save-1'});assert.equal((await save(f.c,f.ctx,{content:'原始事实',operationId:'save-1'})).id,record.id);
  await assert.rejects(save(f.c,f.ctx,{content:'不同内容',operationId:'save-1'}),{code:'VERSION_CONFLICT'});
  const input={id:record.id,expectedRevision:1,patch:{content:'更正事实',aliases:['事实别名']},operationId:'edit-1'};
  const updated=await f.c.dispatch('update',input,f.ctx) as MemoryRecord;assert.equal(updated.revision,2);assert.deepEqual(await f.c.dispatch('update',input,f.ctx),updated);
  await assert.rejects(f.c.dispatch('update',{...input,operationId:'edit-2'},f.ctx),{name:'ConflictError'});
  assert.equal((await f.c.dispatch('operation.get',{operationId:'edit-1'},f.ctx) as any).state,'committed');
  await assert.rejects(f.c.dispatch('save',{content:'错误',aliases:'alias'},f.ctx),{code:'VALIDATION_ERROR'});
  await assert.rejects(f.c.dispatch('save',{content:'错误',sources:[{sessionId:'s',entryId:'user1',start:'0',end:2}]},f.ctx),/范围/);
 }finally{await f.close();}
});

test('effective time filters recall while reviewAfter only marks review due (27)',async()=>{
 const f=fixture();try{
  await save(f.c,f.ctx,{title:'期限',content:'已经过期',validTo:'2020-01-01'});await save(f.c,f.ctx,{title:'期限',content:'尚未开始',validFrom:'2100-01-01'});
  const due=await save(f.c,f.ctx,{title:'期限',content:'待复核事实',reviewAfter:'2020-01-01'});assert.deepEqual(f.c.search({query:'期限'},f.ctx).map(r=>r.id),[due.id]);
  const explain=await f.c.dispatch('search.explain',{query:'期限'},f.ctx) as any;assert.equal(explain.matches[0].reviewDue,true);assert.equal(explain.excluded.filter((v:any)=>v.reason==='validity').length,2);
  assert.equal((await f.c.dispatch('read',{id:due.id},f.ctx) as MemoryRecord).confirmedAt,due.confirmedAt);
 }finally{await f.close();}
});

test('managed Markdown detects drift, rebuilds and never imports edits; forget removes body files (25)',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{title:'投影',content:'数据库权威正文'}),root=join(f.dir,'memory-views','project-p'),path=join(root,'records',record.id+'.md');assert.ok(existsSync(join(root,'manifest.json')));
  chmodSync(path,0o600);writeFileSync(path,'恶意外部修改');const state=await f.c.dispatch('projection.status',{},f.ctx) as any[];assert.ok(state.some(item=>item.state==='projection-drift-rebuilt'));assert.match(readFileSync(path,'utf8'),/数据库权威正文/);assert.deepEqual(f.c.search({query:'恶意外部修改'},f.ctx),[]);
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));manifest.epoch=0;chmodSync(join(root,'manifest.json'),0o600);writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest));await f.c.dispatch('projection.status',{},f.ctx);assert.ok(JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')).epoch>0);
  await f.c.dispatch('forget',{id:record.id,expectedRevision:record.revision},f.ctx);assert.ok(!existsSync(path));assert.ok(!readFileSync(join(root,'MEMORY.md'),'utf8').includes(record.content));
 }finally{await f.close();}
});

test('forget hides body in usage/operations and cold native receipt restore preserves only minimal metadata (15,26)',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'唯一敏感记忆正文',operationId:'private-save'});f.items[0].text='唯一敏感';f.c.beginRun(f.ctx);const recalled=f.c.recall(f.ctx)!;f.c.observeContext([{content:recalled.content}],f.ctx);const entries=f.journal.map(item=>({type:'custom',customType:item.type,data:item.data}));
  await f.c.dispatch('forget',{id:record.id,expectedRevision:record.revision,operationId:'forget-1'},f.ctx);
  assert.ok(!JSON.stringify(f.c.usage(f.ctx)).includes(record.content));assert.ok(!JSON.stringify(await f.c.dispatch('operation.get',{operationId:'private-save'},f.ctx)).includes(record.content));
  f.c.restoreUsage(entries,f.ctx);assert.ok(!JSON.stringify(f.c.usage(f.ctx)).includes(record.content));assert.ok(entries.some(e=>JSON.stringify(e).includes(record.content)),'Pi historical receipt is immutable');
 }finally{await f.close();}
});

test('independent learning covers 81 entries and the complete oversized entry without rescanning (01,24)',async()=>{
 const f=fixture();try{
  f.items.splice(0);for(let i=0;i<81;i++)f.items.push({id:'entry-'+i,parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'当前任务样本 '+i});
  f.items.push({id:'oversized',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:('长段落，完整范围。\n').repeat(6000)});
  await f.c.settled(f.ctx);const before=(f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[];assert.ok(before.length>=3);assert.ok(before.every(job=>job.budgetId&&job.sourceRunId==='foreground-1'&&job.stage==='extract'));
  await drain(f.c,f.ctx);const jobs=(f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[];assert.ok(jobs.every(job=>job.state==='completed'));assert.equal(jobs.flatMap(job=>job.coveredRanges||[]).reduce((sum,source)=>sum+source.end!-source.start!,0),f.items.reduce((sum,item)=>sum+item.text.length,0));
  const calls=f.calls();await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.equal(f.calls(),calls);assert.equal(f.requests(),0);
 }finally{await f.close();}
});

test('unknown remote learning result is durable and cannot be replayed by retry (21)',async()=>{
 const f=fixture();let calls=0;try{
  f.ctx.complete=async()=>{calls++;throw new CapabilityError('OPERATION_UNKNOWN','供应商状态未知');};await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!;const result=await f.c.executeLearningJob(job.id,f.ctx);assert.equal(result.job?.state,'operation_unknown');assert.equal(result.job?.attempts,0);assert.equal(peekLearningJob(f.dir),undefined);
  await assert.rejects(f.c.dispatch('learning.retry',{jobId:job.id},f.ctx),{code:'OPERATION_UNKNOWN'});await drain(f.c,f.ctx);assert.equal(calls,1);
 }finally{await f.close();}
});

test('confirmed length-limited extraction fails once without covering sources, publishing or replaying after restart',async()=>{
 const f=fixture(),operations:string[]=[];let cold:MemoryController|undefined;try{
  f.ctx.complete=async(_prompt,options)=>{operations.push(options!.operationId!);throw new CapabilityError('VALIDATION_ERROR','已接收不完整响应',{response:{stopReason:'length',received:true,complete:false}});};
  await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!,result=await f.c.executeLearningJob(job.id,f.ctx);
  assert.equal(result.job?.state,'failed');assert.equal(result.job?.attempts,0);assert.equal(result.job?.stage,'extract');assert.equal(result.job?.operationId,job.operationId);assert.equal(result.job?.nextAttemptAt,undefined);assert.match(result.job?.error||'',/length.*不完整/);
  assert.deepEqual(result.job?.coveredRanges,[]);assert.deepEqual(result.job?.pendingRanges,job.sourceRanges);assert.deepEqual(result.job?.memoryIds,[]);assert.equal(result.job?.proposals,undefined);assert.equal(result.job?.modelOperations?.length,1);assert.equal(peekLearningJob(f.dir),undefined);
  const store=new RecordStore('memory',f.dir);try{assert.equal(store.get('cursor:p:s'),undefined);}finally{store.close();}assert.deepEqual(f.c.snapshot(f.ctx).memories,[]);
  await f.c.dispose();cold=new MemoryController();await cold.settled(f.ctx);await drain(cold,f.ctx);assert.equal(operations.length,1);const saved=((cold.snapshot(f.ctx).learning as any).jobs as LearningJob[]);assert.equal(saved.length,1);assert.equal(saved[0].state,'failed');assert.deepEqual(saved[0].pendingRanges,job.sourceRanges);assert.deepEqual(cold.snapshot(f.ctx).memories,[]);
 }finally{await cold?.dispose();await f.close();}
});

test('ordinary extract schema failures still receive at most three attempts with distinct operations',async()=>{
 const f=fixture(),originalNow=Date.now,operations:string[]=[];let time=originalNow();Date.now=()=>time;
 try{f.ctx.complete=async(_prompt,options)=>{operations.push(options!.operationId!);return '{"unexpected":true}';};await f.c.settled(f.ctx);const first=peekLearningJob(f.dir)!;
  for(let attempt=1;attempt<=3;attempt++){const result=await f.c.executeLearningJob(first.id,f.ctx);assert.equal(result.job?.attempts,attempt);assert.equal(result.job?.state,attempt===3?'failed':'queued');time+=31000;}
  await drain(f.c,f.ctx);assert.equal(operations.length,3);assert.equal(new Set(operations).size,3);assert.equal(peekLearningJob(f.dir),undefined);assert.deepEqual(f.c.snapshot(f.ctx).memories,[]);
 }finally{Date.now=originalNow;await f.close();}
});

test('typed learning request VERSION_CONFLICT is terminal without a new operation or cursor after restart',async()=>{
 const f=fixture(),operations:string[]=[];let cold:MemoryController|undefined;try{f.ctx.complete=async(_prompt,options)=>{operations.push(options!.operationId!);throw new CapabilityError('VERSION_CONFLICT','调用幂等键与实际模型配置或请求参数不匹配');};await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!,result=await f.c.executeLearningJob(job.id,f.ctx);
  assert.equal(result.job?.state,'failed');assert.equal(result.job?.attempts,0);assert.equal(result.job?.nextAttemptAt,undefined);assert.equal(result.job?.operationId,job.operationId);assert.equal(result.job?.stage,'extract');assert.deepEqual(result.job?.sources,job.sources);assert.deepEqual(result.job?.pendingRanges,job.sourceRanges);assert.deepEqual(result.job?.coveredRanges,[]);assert.equal(result.job?.modelOperations?.length,1);assert.match(result.job?.error||'',/VERSION_CONFLICT/);assert.equal(peekLearningJob(f.dir),undefined);
  await f.c.dispose();cold=new MemoryController();await cold.settled(f.ctx);await drain(cold,f.ctx);assert.equal(operations.length,1);assert.deepEqual(cold.snapshot(f.ctx).memories,[]);const store=new RecordStore('memory',f.dir);try{assert.equal(store.get('cursor:p:s'),undefined);}finally{store.close();}
 }finally{await cold?.dispose();await f.close();}
});

for(const state of ['dispatched','unknown'] as const)test(`cold learning ${state} operation with changed model config keeps original canonical call and unread ranges`,async()=>{
 const f=fixture();let cold:MemoryController|undefined,dispatches=0,completeCalls=0;try{
  const model={provider:'fixture',id:'offline',baseUrl:'https://old.invalid/v1',api:'openai-completions'};let configuredModel=model;f.ctx.complete=async(prompt,options)=>{completeCalls++;const store=new RecordStore('runtime',f.dir),budgets=new LearningBudget(store);try{const input={budgetId:options!.budgetId!,operationId:options!.operationId!,callId:options!.callId,stage:options!.stage,promptHash:digest(prompt),requestHash:learningRequestHash(configuredModel,'off',options!.maxTokens!,options!.stage,digest(prompt))};const call=budgets.begin(input);dispatches++;if(state==='unknown')budgets.finish({budgetId:input.budgetId,operationId:input.operationId,callId:call.callId,state:'unknown'});throw new CapabilityError('OPERATION_UNKNOWN','已发出的调用结果未知',{callId:call.callId});}finally{store.close();}};
  await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!;if(state==='dispatched'){const partial={...job.sources[0],end:3,hash:digest(f.items[0].text.slice(0,3))},store=new RecordStore('memory',f.dir);store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify({...job,pendingRanges:[partial]}),job.id);store.close();}
  const initial=await f.c.executeLearningJob(job.id,f.ctx),checkpoint=initial.job!;assert.equal(checkpoint.state,'operation_unknown');assert.equal(checkpoint.attempts,0);await f.c.dispose();configuredModel={...model,baseUrl:'https://changed.invalid/v1'};const restore=new RecordStore('memory',f.dir);restore.db.prepare("UPDATE memory_jobs SET state='running',json=? WHERE id=?").run(JSON.stringify({...checkpoint,state:'running',owner:{instance:'terminated',pid:2147483647,heartbeatAt:new Date(0).toISOString(),token:'terminated'}}),job.id);restore.close();cold=new MemoryController();const recovered=peekLearningJob(f.dir)!;assert.equal(recovered.id,job.id);const result=await cold.executeLearningJob(job.id,f.ctx);
  assert.equal(result.job?.state,'operation_unknown');assert.equal(result.job?.attempts,0);assert.equal(result.job?.nextAttemptAt,undefined);assert.deepEqual(result.job?.modelOperations,checkpoint.modelOperations);assert.deepEqual(result.job?.callIds,checkpoint.callIds);assert.deepEqual(result.job?.sources,job.sources);assert.deepEqual(result.job?.pendingRanges,state==='dispatched'?checkpoint.pendingRanges:job.sourceRanges);assert.deepEqual(result.job?.coveredRanges,[]);assert.equal(dispatches,1);assert.equal(completeCalls,1);assert.equal(peekLearningJob(f.dir),undefined);await cold.settled(f.ctx);await drain(cold,f.ctx);assert.equal(completeCalls,1);assert.deepEqual(cold.snapshot(f.ctx).memories,[]);
  const ledger=new RecordStore('runtime',f.dir);try{const budgets=new LearningBudget(ledger),operation=checkpoint.modelOperations![0],call=budgets.readCall(job.budgetId!,operation.operationId)!;assert.equal(call.callId,checkpoint.callIds![0]);assert.equal(call.state,state);assert.equal(budgets.read(job.budgetId!).calls,1);assert.equal(ledger.get('cursor:p:s'),undefined);}finally{ledger.close();}
 }finally{await cold?.dispose();await f.close();}
});

for(const state of ['dispatched','unknown','complete'] as const)test(`compact ${state} checkpoint fences changed title material or resumes a confirmed result without dispatching again`,async()=>{
 const f=fixture();let cold:MemoryController|undefined,compactDispatches=0,checkpoint:LearningJob|undefined;try{
  const parents:MemoryRecord[]=[];for(let i=0;i<3;i++)parents.push(await save(f.c,f.ctx,{title:'父事实 '+i,content:'完整事实 '+i,subject:'compact-recovery'}));
  f.ctx.complete=async(prompt,options)=>{const store=new RecordStore('runtime',f.dir),budgets=new LearningBudget(store);try{const input={budgetId:options!.budgetId!,operationId:options!.operationId!,callId:options!.callId,stage:options!.stage,promptHash:digest(prompt),requestHash:learningRequestHash({provider:'fixture',id:'offline'},'off',options!.maxTokens!,options!.stage,digest(prompt))},call=budgets.begin(input);if(call.result!==undefined)return call.result;
    if(options!.stage!=='compact'){const result='{"memories":[]}';budgets.finish({budgetId:input.budgetId,operationId:input.operationId,callId:call.callId,result,tokens:0,state:'complete'});return result;}
    compactDispatches++;if(!checkpoint)checkpoint=JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json));if(state!=='dispatched')budgets.finish({budgetId:input.budgetId,operationId:input.operationId,callId:call.callId,...(state==='complete'?{result:'{"memory":null}',tokens:0}:{}),state:state==='complete'?'complete':'unknown'});throw new CapabilityError('OPERATION_UNKNOWN','模拟 compact 派发后进程中断',{callId:call.callId});
   }finally{store.close();}};
  await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!;for(let step=0;step<3;step++)await f.c.executeLearningJob(job.id,f.ctx);const store=new RecordStore('memory',f.dir),ready=JSON.parse(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json)) as LearningJob;assert.equal(ready.stage,'compact');if(state!=='complete'){ready.pendingRanges=[{...ready.sources[0],end:3,hash:digest(f.items[0].text.slice(0,3))}];store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify(ready),ready.id);}store.close();await f.c.executeLearningJob(job.id,f.ctx);assert.equal(compactDispatches,1);assert.ok(checkpoint);
  if(state!=='complete'){const updated=await f.c.dispatch('update',{id:parents[0].id,revision:parents[0].revision,title:'公开修改标题',aliases:['新别名']},f.ctx) as MemoryRecord;assert.equal(updated.content,parents[0].content);assert.equal(updated.title,'公开修改标题');}
  await f.c.dispose();const restore=new RecordStore('memory',f.dir);restore.db.prepare("UPDATE memory_jobs SET state='running',json=? WHERE id=?").run(JSON.stringify({...checkpoint,state:'running',owner:{instance:'dead-compact',pid:2147483647,heartbeatAt:new Date(0).toISOString(),token:'dead-compact'}}),job.id);restore.close();cold=new MemoryController();assert.equal(peekLearningJob(f.dir)?.id,job.id);const result=await cold.executeLearningJob(job.id,f.ctx);assert.equal(compactDispatches,1);
  const verify=new RecordStore('memory',f.dir);try{if(state==='complete'){assert.equal(result.job?.state,'completed');assert.deepEqual(verify.get<{entryIds:string[]}>('cursor:p:s')?.value.entryIds,['user1']);}else{assert.equal(result.job?.state,'operation_unknown');assert.equal(result.job?.attempts,0);assert.deepEqual(result.job?.modelOperations,checkpoint.modelOperations);assert.deepEqual(result.job?.callIds,checkpoint.callIds);assert.deepEqual(result.job?.sources,checkpoint.sources);assert.deepEqual(result.job?.pendingRanges,checkpoint.pendingRanges);assert.deepEqual(result.job?.coveredRanges,[]);assert.equal(verify.get('cursor:p:s'),undefined);assert.equal(peekLearningJob(f.dir),undefined);await cold.settled(f.ctx);await drain(cold,f.ctx);assert.equal(compactDispatches,1);}}finally{verify.close();}
 }finally{await cold?.dispose();await f.close();}
});

test('length-limited artifact-only extraction retains the observed unread ranges without partial publication',async()=>{
 const f=fixture();let calls=0;try{f.items.splice(0);const body='Observed artifact fact: SQLite uses WAL.',path=join(f.dir,'length-artifact.txt');writeFileSync(path,body);
  const artifact:ArtifactRef={artifactId:'length-artifact',version:1,sha256:digest(body),mediaType:'text/plain',ranges:[{unit:'utf16',value:`0:${body.length}`}]},receipt:EvidenceReceipt={v:1,receiptId:'length-observation',projectId:'p',sessionId:'s',runId:'foreground-1',stage:'tool-read',sources:[],artifacts:[artifact],dependencies:[],observer:{kind:'foreground',runId:'foreground-1'},contentHash:digest(body),visibleRanges:[[0,body.length]],at:new Date().toISOString()};
  const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref:artifact,projectId:'p',path,observations:[receipt],valid:true});host.close();f.ctx.observedArtifacts=()=>[{artifact,receipt}];f.ctx.readArtifact=async ref=>({artifact:ref,text:body,fullLength:body.length,visibleRanges:[[0,body.length]],receipt});f.ctx.complete=async()=>{calls++;throw new CapabilityError('VALIDATION_ERROR','已确认输出截断',{response:{stopReason:'length',received:true,complete:false}});};
  await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!,result=await f.c.executeLearningJob(job.id,f.ctx);assert.equal(result.job?.state,'failed');assert.deepEqual(result.job?.pendingArtifacts,job.observedArtifacts);assert.deepEqual(result.job?.coveredArtifacts,undefined);assert.deepEqual(result.job?.coveredRanges,[]);assert.deepEqual(result.job?.memoryIds,[]);assert.equal(peekLearningJob(f.dir),undefined);await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.equal(calls,1);assert.deepEqual(f.c.snapshot(f.ctx).memories,[]);
 }finally{await f.close();}
});

for(const code of ['VERSION_CONFLICT','OPERATION_UNKNOWN'] as const)test(`${code} retains full or existing partial artifact ranges without rescheduling`,async()=>{
 const f=fixture();try{f.items.splice(0);const body='Observed unread artifact ranges.',path=join(f.dir,'identity-artifact.txt');writeFileSync(path,body);const artifact:ArtifactRef={artifactId:'identity-artifact',version:1,sha256:digest(body),mediaType:'text/plain',ranges:[{unit:'utf16',value:`0:${body.length}`}]},receipt:EvidenceReceipt={v:1,receiptId:'identity-observation',projectId:'p',sessionId:'s',runId:'foreground-1',stage:'tool-read',sources:[],artifacts:[artifact],dependencies:[],observer:{kind:'foreground',runId:'foreground-1'},contentHash:digest(body),visibleRanges:[[0,body.length]],at:new Date().toISOString()};const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref:artifact,projectId:'p',path,observations:[receipt],valid:true});host.close();f.ctx.observedArtifacts=()=>[{artifact,receipt}];f.ctx.readArtifact=async ref=>({artifact:ref,text:body,fullLength:body.length,visibleRanges:[[0,body.length]],receipt});f.ctx.complete=async()=>{throw new CapabilityError(code,'请求身份冲突或原结果未知');};
  await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!,expected=code==='OPERATION_UNKNOWN'?job.observedArtifacts!.map(item=>({...item,ranges:[[2,8]] as [number,number][]})):job.observedArtifacts!;if(code==='OPERATION_UNKNOWN'){const store=new RecordStore('memory',f.dir);store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify({...job,pendingArtifacts:expected}),job.id);store.close();}const result=await f.c.executeLearningJob(job.id,f.ctx);assert.equal(result.job?.state,code==='VERSION_CONFLICT'?'failed':'operation_unknown');assert.equal(result.job?.attempts,0);assert.equal(result.job?.nextAttemptAt,undefined);assert.deepEqual(result.job?.pendingArtifacts,expected);assert.equal(result.job?.coveredArtifacts,undefined);assert.equal(peekLearningJob(f.dir),undefined);assert.deepEqual(f.c.snapshot(f.ctx).memories,[]);
 }finally{await f.close();}
});

test('source policy fences a late response even with Memory absent when policy changed (16-17)',async()=>{
 const f=fixture();let release!:(value:string)=>void,started!:()=>void;const began=new Promise<void>(r=>started=r);try{
  f.ctx.complete=async()=>{started();return new Promise<string>(r=>release=r);};await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!;const running=f.c.executeLearningJob(job.id,f.ctx);await began;
  const host=new RecordStore('host',f.dir);new SourcePolicy(host).invalidate({sessionId:'s',reason:'禁止所有能力学习',key:'host-ban'});host.close();release('{"memories":[]}');const result=await running;assert.ok(['invalidated','queued'].includes(result.job!.state));assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);
  const fresh=new RecordStore('independent-expert',f.dir);assert.throws(()=>new SourcePolicy(fresh).capture({projectId:'p',sources:[{sessionId:'s',entryId:'user1'}]}),{code:'SOURCE_UNAVAILABLE'});fresh.close();
 }finally{release?.('{"memories":[]}');await f.close();}
});

test('artifact evidence requires registered observation and cannot claim unobserved PDF/Excel ranges (11-12)',async()=>{
 const f=fixture();try{
  const path=join(f.dir,'attachment.txt');writeFileSync(path,'visible first page only');const ref:ArtifactRef={artifactId:'a',version:1,sha256:digest('visible first page only'),mediaType:'text/plain',ranges:[{unit:'utf16',value:'0:10'}]};
  const observer={kind:'parser' as const,runId:'parser-run'},receipt:EvidenceReceipt={v:1,receiptId:'receipt-1',projectId:'p',sessionId:'s',runId:'parser-run',stage:'tool-read',sources:[],artifacts:[ref],dependencies:[],observer,contentHash:digest('visible fi'),fullLength:23,visibleRanges:[[0,10]],at:new Date().toISOString()};
  const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref,projectId:'p',path,observations:[receipt],valid:true});host.close();
  const evidence={kind:'artifact',artifact:ref,observationReceiptId:'receipt-1',observer,observedAt:new Date().toISOString()};const record=await save(f.c,f.ctx,{content:'实际观察第一页片段',evidence:[evidence]});assert.equal(record.evidence![0].kind,'artifact');
  await assert.rejects(save(f.c,f.ctx,{content:'未观察内容',evidence:[{...evidence,observationReceiptId:'missing'}]}),{code:'SOURCE_UNAVAILABLE'});
  await assert.rejects(save(f.c,f.ctx,{content:'伪称前台已读',evidence:[{...evidence,observer:{kind:'foreground',runId:'front'}}]}),{code:'SOURCE_UNAVAILABLE'});
  assert.equal((record.evidence![0] as any).observer.kind,'parser');
 }finally{await f.close();}
});

test('legacy methods and distill checkpoints migrate read-only and never call Expert (28)',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'旧方法'});await f.c.settled(f.ctx);const job=peekLearningJob(f.dir)!;const store=new RecordStore('memory',f.dir);store.db.prepare('UPDATE memory_records SET json=? WHERE id=?').run(JSON.stringify({...record,kind:'method',schemaVersion:undefined}),record.id);store.db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(JSON.stringify({...job,stage:'distill'}),job.id);store.db.prepare('DELETE FROM memory_migrations WHERE version=2').run();store.close();await f.c.dispose();
  const migrated=new MemoryController();try{const read=await migrated.dispatch('read',{id:record.id},f.ctx) as MemoryRecord;assert.equal(read.kind,'method');assert.equal(read.legacy,true);assert.deepEqual(migrated.search({query:'旧方法'},f.ctx),[]);await assert.rejects(migrated.dispatch('update',{id:record.id,revision:record.revision,content:'修改'},f.ctx),{code:'VALIDATION_ERROR'});assert.equal(((migrated.snapshot(f.ctx).learning as any).jobs as LearningJob[])[0].state,'cancelled');assert.ok(readdirSync(join(f.dir,'memory-migration-backups')).length>=2);assert.equal(f.requests(),0);}finally{await migrated.dispose();}
 }finally{await f.close();}
});

test('forgotten Memory dependency stays revoked for an optional consumer after reopening (29)',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'依赖事实'}),dep={capability:'memory' as const,id:record.id,version:record.revision,hash:record.hash,relation:'derived-from' as const};const host=new RecordStore('consumer',f.dir),policy=new SourcePolicy(host),fence=policy.capture({projectId:'p',sources:[],dependencies:[dep]});host.close();
  await f.c.dispatch('forget',{id:record.id,revision:record.revision},f.ctx);
  const cold=new RecordStore('consumer',f.dir);assert.throws(()=>new SourcePolicy(cold).assert(fence),{code:'SOURCE_UNAVAILABLE'});cold.close();assert.ok((f.c.invalidationSnapshot(f.ctx).ids as string[]).includes(record.id));
 }finally{await f.close();}
});

test('reenabling a source-backed record restores recall and only publishes its new version',async()=>{
 const f=fixture();let cold:MemoryController|undefined;try{
  f.items[0].text='数据库使用 SQLite。';const record=await save(f.c,f.ctx,{title:'数据库',content:f.items[0].text,sources:[{sessionId:'s',entryId:'user1'}]}),host=new RecordStore('consumer',f.dir),policy=new SourcePolicy(host);
  try{
   const oldFence=policy.capture({projectId:'p',sources:[],dependencies:[{capability:'memory',id:record.id,version:record.revision,hash:record.hash,relation:'derived-from'}]});
   const disabled=await f.c.dispatch('toggle',{id:record.id,expectedRevision:record.revision,enabled:false},f.ctx) as MemoryRecord;assert.deepEqual(f.c.search({query:'SQLite'},f.ctx),[]);assert.throws(()=>policy.assert(oldFence),{code:'SOURCE_UNAVAILABLE'});
   await f.c.dispose();cold=new MemoryController();const enabled=await cold.dispatch('toggle',{id:record.id,expectedRevision:disabled.revision,enabled:true},f.ctx) as MemoryRecord;
   assert.deepEqual(enabled.sources,record.sources);assert.equal(enabled.status,'active');assert.equal(cold.search({query:'SQLite'},f.ctx)[0]?.id,record.id);assert.equal((cold.select({query:'SQLite'},f.ctx).records as MemoryRecord[])[0]?.id,record.id);
   assert.doesNotThrow(()=>policy.capture({projectId:'p',sources:enabled.sources,dependencies:[{capability:'memory',id:enabled.id,version:enabled.revision,hash:enabled.hash,relation:'derived-from'}]}));assert.throws(()=>policy.assert(oldFence),{code:'SOURCE_UNAVAILABLE'});
  }finally{host.close();}
 }finally{await cold?.dispose();await f.close();}
});

test('reenabling one record cannot lift a shared source forgotten, corrected or disabled by another record',async()=>{
 for(const action of ['forget','update','toggle'] as const){const f=fixture();try{
  f.items[0].text='SQLite 数据库写入需要串行。';const sources=[{sessionId:'s',entryId:'user1'}],target=await save(f.c,f.ctx,{content:'SQLite 数据库写入需要串行。',sources}),other=await save(f.c,f.ctx,{content:'SQLite 写入串行检查',sources});
  const disabled=await f.c.dispatch('toggle',{id:target.id,expectedRevision:target.revision,enabled:false},f.ctx) as MemoryRecord;
  await f.c.dispatch(action,{id:other.id,expectedRevision:other.revision,...(action==='update'?{content:'新声明：PostgreSQL 写入串行检查'}:action==='toggle'?{enabled:false}:{})},f.ctx);
  await f.c.dispatch('toggle',{id:target.id,expectedRevision:disabled.revision,enabled:true},f.ctx);assert.ok(!f.c.search({query:'SQLite'},f.ctx).some(record=>record.id===target.id),action);
 }finally{await f.close();}}
});

test('legacy disabled markers can be restored but a host source withdrawal cannot be reversed',async()=>{
 const f=fixture();try{
  f.items[0].text='SQLite 数据库需要串行写入。';const record=await save(f.c,f.ctx,{content:f.items[0].text,sources:[{sessionId:'s',entryId:'user1'}]}),disabled=await f.c.dispatch('toggle',{id:record.id,expectedRevision:record.revision,enabled:false},f.ctx) as MemoryRecord;
  const store=new RecordStore('memory',f.dir);try{
   store.remove(`disabled-record:${record.id}`);store.db.prepare('INSERT INTO memory_suppression VALUES(?,?,?,?,?)').run('p','content',digest(record.content.toLowerCase()),'disabled',new Date().toISOString());
   for(const source of record.sources){if(source.factId)store.db.prepare('INSERT INTO memory_suppression VALUES(?,?,?,?,?)').run('p','fact',source.factId,'disabled',new Date().toISOString());store.db.prepare('INSERT INTO memory_suppression VALUES(?,?,?,?,?)').run('p','fragment',digest([source.entryId,source.start,source.end,source.hash]),'disabled',new Date().toISOString());store.put(`retired-source:p:${digest(`${source.sessionId}:${source.entryId}:${source.start??''}:${source.end??''}:${source.hash??''}`)}`,{v:1,source,reason:'disabled'});}
  }finally{store.close();}
  const enabled=await f.c.dispatch('toggle',{id:record.id,expectedRevision:disabled.revision,enabled:true},f.ctx) as MemoryRecord;assert.equal(f.c.search({query:'SQLite'},f.ctx)[0]?.id,record.id);
  const again=await f.c.dispatch('toggle',{id:record.id,expectedRevision:enabled.revision,enabled:false},f.ctx) as MemoryRecord,host=new RecordStore('host',f.dir);try{new SourcePolicy(host).invalidate({sources:record.sources,reason:'用户禁止此来源',key:'host-source-withdrawn'});}finally{host.close();}
  await assert.rejects(f.c.dispatch('toggle',{id:record.id,expectedRevision:again.revision,enabled:true},f.ctx),{code:'SOURCE_UNAVAILABLE'});assert.deepEqual(f.c.search({query:'SQLite'},f.ctx),[]);assert.equal((await f.c.dispatch('read',{id:record.id},f.ctx) as MemoryRecord).enabled,false);
 }finally{await f.close();}
});

test('reenabling a personal record restores only its exact cross-project source grant',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'用户偏好中文解释',scope:'personal',kind:'preference',sources:[{sessionId:'s',entryId:'user1'}]}),host=new RecordStore('host',f.dir);try{
   const policy=new SourcePolicy(host),disabled=await f.c.dispatch('toggle',{id:record.id,expectedRevision:record.revision,enabled:false},f.ctx) as MemoryRecord;assert.equal(policy.canReadPersonalSource(record.sources[0]),false);
   const enabled=await f.c.dispatch('toggle',{id:record.id,expectedRevision:disabled.revision,enabled:true},f.ctx) as MemoryRecord;assert.equal(policy.canReadPersonalSource(enabled.sources[0]),true);assert.equal(policy.canReadPersonalSource({sessionId:'s',entryId:'user1'}),false);assert.equal(f.c.search({query:'中文'},{...f.ctx,projectId:'other'})[0]?.id,record.id);
   assert.doesNotThrow(()=>policy.capture({projectId:'other',sources:[],dependencies:[{capability:'memory',id:enabled.id,version:enabled.revision,hash:enabled.hash,relation:'derived-from'}]}));
  }finally{host.close();}
 }finally{await f.close();}
});

test('a unique quote in the first of two ranges from one 26k entry publishes with exact source offsets',async()=>{
 const f=fixture();try{
  const fact='SQLite uses WAL for this database.';f.items[0].text=fact+'\n'+'填充'.repeat(13000);let calls=0;
  f.ctx.complete=async prompt=>{calls++;const material=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));assert.equal(material.length,2);assert.ok(material[0].text.includes(fact));assert.ok(!material[1].text.includes(fact));const id=material[0].id;return JSON.stringify({memories:[{title:'数据库日志',content:fact,kind:'fact',sourceEntryIds:[id],sourceQuotes:{[id]:fact}}]});};
  await f.c.settled(f.ctx);await drain(f.c,f.ctx);const records=f.c.snapshot(f.ctx).memories as MemoryRecord[];assert.equal(records.length,1);assert.equal(records[0].status,'active');assert.equal(records[0].content,fact);assert.equal(calls,1);
  assert.deepEqual(records[0].sources.map(({factId,...source})=>source),[{sessionId:'s',entryId:'user1',start:0,end:fact.length,hash:digest(fact)}]);assert.equal(readSourceSpan(f.ctx.readSource(records[0].sources[0]),records[0].sources[0]),fact);
  const jobs=(f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[];assert.equal(jobs[0].state,'completed');assert.equal(jobs[0].coveredRanges!.reduce((sum,source)=>sum+source.end!-source.start!,0),f.items[0].text.length);
 }finally{await f.close();}
});

test('canonical normalization cannot activate a Chinese fact after removing its only supporting clause',async()=>{
 const f=fixture();try{
  const source='本项目规则：归档文件名必须使用中文前缀“验收”。仅确认这条规则，不修改文件；后台系统负责整理记忆，无需调用记忆写入工具。',fact=source.slice(0,24);
  assert.equal(source.length,60);assert.equal(fact,'本项目规则：归档文件名必须使用中文前缀“验收”。');f.items[0].id='480eec2b';f.items[0].text=source;
  const assistant='已按只读方式检索当前项目记忆（关键词「归档文件名 中文前缀 验收」及目录查询）：**返回空**，现有记忆中尚无此规则的记录。';f.items.push({id:'0aef9bda',parentId:'480eec2b',type:'message',role:'assistant',timestamp:new Date().toISOString(),text:assistant});
  const content='本项目规则：归档文件名必须使用中文前缀“验收”。该规则由用户在当前会话中明确陈述，尚未在本项目文件或现存记忆中找到对应的书面来源。适用条件为归档文件名命名场景；本条规则本身不涉及修改文件，后台系统负责整理记忆，无需调用记忆写入工具。';
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'归档文件名必须使用中文前缀“验收”',content,kind:'fact',conditions:['归档文件名命名时'],subject:'归档文件名命名规则',sourceEntryIds:['480eec2b','0aef9bda'],sourceQuotes:{'480eec2b':source,'0aef9bda':assistant}}]});
  await f.c.settled(f.ctx);await drain(f.c,f.ctx);const active=f.c.snapshot(f.ctx).memories as MemoryRecord[];
  assert.equal(active.length,1,'the model body cannot borrow remaining instructions after its canonical support was removed');assert.equal(active[0].content,fact);assert.equal(active[0].status,'active');
  assert.deepEqual(active[0].sources.map(({factId,...ref})=>ref),[{sessionId:'s',entryId:'480eec2b',start:0,end:24,hash:digest(fact)}]);
  const original=await f.c.dispatch('read',{id:active[0].id,source:true},f.ctx) as any;assert.equal(original.originals.length,1);assert.equal(original.originals[0].item.text,fact);
  assert.ok(!(f.c.snapshot(f.ctx).candidates as MemoryRecord[]).some(record=>record.content===content));const job=((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[])[0];assert.equal(job.diagnostics?.reflection?.discarded,1);assert.equal(job.state,'completed');
 }finally{await f.close();}
});

test('Chinese facts need matching quoted text even without ASCII literals, while supported Chinese declarations publish',async()=>{
 const f=fixture();try{
  const fact='本项目规则：归档文件名必须使用中文前缀“验收”。',instructions='仅确认这条规则，不修改文件；后台系统负责整理记忆，无需调用记忆写入工具。';f.items[0].text=fact+instructions;
  const unsupported='归档文件名必须使用中文前缀“验收”。';assert.equal((unsupported.match(/[A-Za-z][A-Za-z0-9_.-]{2,}|\b\d+(?:\.\d+)+\b/g)||[]).length,0);
  f.items.push({id:'assistant-echo',parentId:'user1',type:'message',role:'assistant',timestamp:new Date().toISOString(),text:unsupported});
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'仅指令引文',content:unsupported,kind:'fact',sourceEntryIds:['user1','assistant-echo'],sourceQuotes:{user1:instructions,'assistant-echo':unsupported}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const active=f.c.snapshot(f.ctx).memories as MemoryRecord[];assert.equal(active.length,1);assert.equal(active[0].content,fact);const candidate=(f.c.snapshot(f.ctx).candidates as MemoryRecord[]).find(record=>record.title==='仅指令引文')!;assert.ok(candidate);assert.equal(candidate.status,'candidate');assert.match(candidate.invalidatedReason||'',/来源片段.*事实正文/);assert.ok(candidate.sources.filter(ref=>ref.entryId==='user1').every(ref=>ref.start!>=24));assert.ok(candidate.sources.some(ref=>ref.entryId==='assistant-echo'),'assistant echo does not supply user authority');
  const declaration='归档资料保存在项目目录。';f.items.push({id:'independent-chinese',parentId:'user1',type:'message',role:'user',timestamp:new Date().toISOString(),text:declaration});
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'归档资料位置',content:declaration,kind:'fact',sourceEntryIds:['independent-chinese'],sourceQuotes:{'independent-chinese':declaration}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const supported=(f.c.snapshot(f.ctx).memories as MemoryRecord[]).find(record=>record.content===declaration)!;assert.ok(supported);assert.equal(supported.status,'active');assert.equal(readSourceSpan(f.ctx.readSource(supported.sources[0]),supported.sources[0]),declaration);
 }finally{await f.close();}
});

test('an ASCII instruction anchor cannot preserve a Chinese canonical claim whose source was removed',async()=>{
 const f=fixture();try{
  const fact='本项目规则：归档文件名必须使用中文前缀“验收”。',source=fact+'仅确认这条规则，不修改 README 文件；后台系统负责整理归档记忆。';f.items[0].text=source;
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'归档与文档',content:fact+'后台系统负责整理归档记忆，不修改 README 文件。',kind:'fact',sourceEntryIds:['user1'],sourceQuotes:{user1:source}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const active=f.c.snapshot(f.ctx).memories as MemoryRecord[];assert.equal(active.length,1);assert.equal(active[0].content,fact);assert.equal(active[0].sources.length,1);assert.equal(readSourceSpan(f.ctx.readSource(active[0].sources[0]),active[0].sources[0]),fact);assert.equal((f.c.snapshot(f.ctx).candidates as MemoryRecord[]).length,0);
 }finally{await f.close();}
});

test('a direct instruction quote with an ASCII anchor cannot authorize an unquoted Chinese fact',async()=>{
 const f=fixture();try{
  const fact='本项目规则：归档文件名必须使用中文前缀“验收”。',instructions='仅确认这条规则，不修改 README 文件；后台系统负责整理归档记忆。';f.items[0].text=fact+instructions;
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'遗漏事实引文',content:'归档文件名必须使用中文前缀“验收”。README',kind:'fact',sourceEntryIds:['user1'],sourceQuotes:{user1:instructions}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const active=f.c.snapshot(f.ctx).memories as MemoryRecord[];assert.equal(active.length,1);assert.equal(active[0].content,fact);const candidate=(f.c.snapshot(f.ctx).candidates as MemoryRecord[]).find(record=>record.title==='遗漏事实引文')!;assert.ok(candidate);assert.equal(candidate.status,'candidate');assert.match(candidate.invalidatedReason||'',/来源片段.*事实正文/);
  f.items.push({id:'supported-summary',parentId:'user1',type:'message',role:'user',timestamp:new Date().toISOString(),text:'数据库必须使用 PostgreSQL。'});f.ctx.complete=async()=>JSON.stringify({memories:[{title:'数据库',content:'数据库使用 PostgreSQL',kind:'fact',sourceEntryIds:['supported-summary'],sourceQuotes:{'supported-summary':'数据库必须使用 PostgreSQL。'}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.ok((f.c.snapshot(f.ctx).memories as MemoryRecord[]).some(record=>record.content==='数据库使用 PostgreSQL'));
 }finally{await f.close();}
});

test('ordinary preferences need independent native entries; personal grants expose only exact supported span (08-10)',async()=>{
 const f=fixture();try{
  f.items[0].text='中文解释便于我理解。';f.ctx.complete=async()=>JSON.stringify({memories:[{title:'说明语言',content:'用户喜欢中文说明',kind:'preference',subject:'language',sourceEntryIds:['user1'],sourceQuotes:{user1:f.items[0].text}}]});
  await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);
  f.items.push({id:'user2',parentId:'user1',type:'message',role:'user',timestamp:new Date().toISOString(),text:'采用中文说明更便于阅读。'});
  f.ctx.complete=async()=>JSON.stringify({memories:[{title:'说明语言',content:'用户喜欢中文说明',kind:'preference',subject:'language',sourceEntryIds:['user2'],sourceQuotes:{user2:f.items[1].text}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const personal=(f.c.snapshot(f.ctx).memories as MemoryRecord[])[0];assert.equal(personal.scope,'personal');assert.equal(personal.sources.length,2);
  const host=new RecordStore('host',f.dir),policy=new SourcePolicy(host);assert.equal(policy.canReadPersonalSource(personal.sources[0]),true);assert.equal(policy.canReadPersonalSource({sessionId:'s',entryId:'user1'}),false);host.close();
  assert.equal(f.c.search({query:'中文'},{...f.ctx,projectId:'another'})[0].id,personal.id);
 }finally{await f.close();}
});

test('conflicting subject evidence stops automatic use and explicit scope forget preserves the other scope (14-15)',async()=>{
 const f=fixture();try{
  const project=await save(f.c,f.ctx,{title:'数据库',subject:'database',content:'数据库使用 SQLite'});await save(f.c,f.ctx,{content:'用户偏好中文',kind:'preference',scope:'personal'});
  f.items[0].text='数据库必须使用 PostgreSQL。';f.ctx.complete=async()=>JSON.stringify({memories:[{title:'数据库',subject:'database',content:'数据库使用 PostgreSQL',kind:'fact',sourceEntryIds:['user1'],sourceQuotes:{user1:f.items[0].text}}]});await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  assert.ok(!(f.c.select({query:'数据库'},f.ctx).records as MemoryRecord[]).some(record=>record.id===project.id));
  await f.c.dispatch('forget',{scope:{type:'project',projectId:'p'},operationId:'forget-project'},f.ctx);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,1);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[])[0].scope,'personal');
 }finally{await f.close();}
});

test('invalidations emit only after the durable write commits and another connection can write (13,19)',async()=>{
 const f=fixture();try{
  const observed:string[]=[];f.ctx.emit=(event)=>{if(event!=='memory.invalidated')return;const other=new RecordStore('event-observer',f.dir);try{other.put('event',{seen:true});observed.push(event);}finally{other.close();}};
  const record=await save(f.c,f.ctx,{content:'原始事实'});await f.c.dispatch('update',{id:record.id,revision:record.revision,content:'更正事实'},f.ctx);assert.deepEqual(observed,['memory.invalidated']);
 }finally{await f.close();}
});

test('artifact ranges not actually observed are rejected and source reads journal only tool-observed ranges (11-12,26,30)',async()=>{
 const f=fixture();try{
  const path=join(f.dir,'pages.txt');writeFileSync(path,'page 1\npage 2');const ref:ArtifactRef={artifactId:'pages',version:1,sha256:digest('page 1\npage 2'),mediaType:'text/plain',ranges:[{unit:'page',value:'1'}]},observer={kind:'learning-worker' as const,runId:'learning-1'};
  const receipt:EvidenceReceipt={v:1,receiptId:'page1',projectId:'p',sessionId:'s',runId:'learning-1',stage:'tool-read',sources:[],artifacts:[ref],dependencies:[],observer,contentHash:digest('page 1'),visibleRanges:[[0,6]],at:new Date().toISOString()};const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref,projectId:'p',path,observations:[receipt],valid:true});host.close();
  await assert.rejects(save(f.c,f.ctx,{content:'未见第二页',evidence:[{kind:'artifact',artifact:{...ref,ranges:[{unit:'page',value:'2'}]},observationReceiptId:'page1',observer}]}),{code:'SOURCE_UNAVAILABLE'});
  const source={sessionId:'s',entryId:'user1',start:2,end:5,hash:digest(f.items[0].text.slice(2,5))};const result=await f.c.dispatch('source.read',{source},f.ctx);assert.equal((f.c.usage(f.ctx).sourceReceipts as any[]).length,0);f.c.observeToolResult({role:'toolResult',toolName:'friend_memory',details:result},f.ctx);const used=(f.c.usage(f.ctx).sourceReceipts as EvidenceReceipt[])[0];assert.deepEqual(used.visibleRanges,[[0,3]]);assert.equal(used.stage,'tool-read');assert.equal(used.observer!.kind,'foreground');
 }finally{await f.close();}
});

test('missing remaining evidence cannot keep a deleted-source record effective (18)',async()=>{
 const f=fixture();try{
  f.items[0].text='实际观察 SQLite。';f.items.push({id:'user2',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'另一条消息与数据库无关。'});
  const record=await save(f.c,f.ctx,{content:'SQLite 已验证',sources:[{sessionId:'s',entryId:'user1'},{sessionId:'other',entryId:'user2'}]});await f.c.dispatch('source.deleted',{sessionId:'s'},f.ctx);assert.equal((await f.c.dispatch('read',{id:record.id},f.ctx) as MemoryRecord).status,'invalidated');assert.deepEqual(f.c.search({query:'SQLite'},f.ctx),[]);
 }finally{await f.close();}
});

test('artifact-only learning reads only observed text and records exact artifact support without fabricated Pi entries (01,11-12)',async()=>{
 const f=fixture();try{
  f.items.splice(0);const body='SQLite transaction check passed.\nUNSEEN_POSTGRESQL_PAGE_2';const visible='SQLite transaction check passed.';const path=join(f.dir,'artifact-only.txt');writeFileSync(path,body);
  const artifact:ArtifactRef={artifactId:'standalone',version:1,sha256:digest(body),mediaType:'text/plain',ranges:[{unit:'utf16',value:`0:${visible.length}`}]},observer={kind:'foreground' as const,runId:'foreground-1'};
  const receipt:EvidenceReceipt={v:1,receiptId:'observed-only',projectId:'p',sessionId:'s',runId:'foreground-1',stage:'request-prepared',sources:[],artifacts:[artifact],dependencies:[],observer,contentHash:digest(visible),fullLength:body.length,visibleRanges:[[0,visible.length]],at:new Date().toISOString()};
  const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref:artifact,projectId:'p',path,observations:[receipt],valid:true});host.close();
  (f.ctx as any).observedArtifacts=()=>[{artifact,receipt}];const reads:[number,number][]=[];f.ctx.readArtifact=async(ref,options={})=>{const start=options.cursor||0,end=Math.min(body.length,start+(options.maxChars||8000));reads.push([start,end]);return {artifact:ref,text:body.slice(start,end),fullLength:body.length,visibleRanges:[[start,end]],nextCursor:end<body.length?end:undefined,receipt};};
  let calls=0;f.ctx.complete=async prompt=>{calls++;assert.ok(!prompt.includes('UNSEEN_POSTGRESQL'));const material=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));return JSON.stringify({memories:[{title:'事务检查',content:'SQLite transaction check passed.',kind:'fact',sourceEntryIds:[material[0].id],sourceQuotes:{[material[0].id]:visible}}]});};
  await f.c.settled(f.ctx);await drain(f.c,f.ctx);const records=f.c.snapshot(f.ctx).memories as MemoryRecord[];assert.equal(records.length,1);assert.equal(records[0].sources.length,0);assert.equal(records[0].evidence![0].kind,'artifact');assert.deepEqual(records[0].evidence![0].visibleRanges,[[0,visible.length]]);assert.equal(calls,1);assert.ok(reads.every(([a,b])=>a>=0&&b<=visible.length));
  const job=((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[])[0];assert.equal(job.coveredArtifacts?.[0].artifact.artifactId,'standalone');assert.equal(job.sourceRunId,'foreground-1');assert.equal(f.requests(),0);
 }finally{await f.close();}
});

test('parser-only saved artifacts and images without text never become automatic facts (10-12)',async()=>{
 const f=fixture();try{
  f.items.splice(0);const body='image bytes',path=join(f.dir,'image.bin');writeFileSync(path,body);const artifact:ArtifactRef={artifactId:'image',version:1,sha256:digest(body),mediaType:'image/png',ranges:[{unit:'bytes',value:'0:11'}]};const parser={kind:'parser' as const,runId:'parser'};
  const receipt:EvidenceReceipt={v:1,receiptId:'parser-only',projectId:'p',sessionId:'s',runId:'parser',stage:'saved',sources:[],artifacts:[artifact],dependencies:[],observer:parser,contentHash:digest(body),visibleRanges:[[0,11]],at:new Date().toISOString()};(f.ctx as any).observedArtifacts=()=>[{artifact,receipt}];await f.c.settled(f.ctx);assert.equal(((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[]).length,0);
  const observed={...receipt,receiptId:'image-visible',stage:'tool-read' as const,observer:{kind:'foreground' as const,runId:'foreground-1'}};const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref:artifact,projectId:'p',path,observations:[observed],valid:true});host.close();(f.ctx as any).observedArtifacts=()=>[{artifact,receipt:observed}];f.ctx.readArtifact=async()=>{throw new CapabilityError('CAPABILITY_UNAVAILABLE','没有文字正文');};await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.equal(f.calls(),0);assert.equal(((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[])[0].state,'invalidated');assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);
 }finally{await f.close();}
});

test('optional compaction keeps original claims, conditions, validity and support, and rejects invented text',async()=>{
 for(const invented of [false,true]){const f=fixture();try{
  const originals=[] as MemoryRecord[];for(let i=0;i<3;i++)originals.push(await save(f.c,f.ctx,{title:'受管经验'+i,subject:'same-subject',content:'原始事实 '+i+'。',conditions:['仅当前测试环境'],validTo:'2099-01-01'}));
  let compactCalls=0;f.ctx.complete=async prompt=>{if(!prompt.startsWith('整理冗余'))return '{"memories":[]}';compactCalls++;return JSON.stringify({memory:{title:'合并经验',content:originals.map(r=>r.content).join('\n\n')+(invented?'这项变更在所有环境都安全。':''),conditions:['仅当前测试环境']}});};await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const active=f.c.snapshot(f.ctx).memories as MemoryRecord[];
  if(!invented){const merged=active.find(r=>r.title==='合并经验')!;assert.ok(merged);assert.equal(merged.status,'active');assert.equal(merged.parentIds.length,3);assert.equal(merged.validTo,'2099-01-01T00:00:00.000Z');assert.deepEqual(merged.conditions,['仅当前测试环境']);assert.ok(originals.every(original=>active.find(r=>r.id===original.id)?.status==='inactive'));}
  else{assert.ok(!active.some(r=>r.title==='合并经验'));assert.ok(originals.every(original=>active.find(r=>r.id===original.id)?.status==='active'));}
  assert.equal(compactCalls,1);assert.equal(f.requests(),0);
 }finally{await f.close();}}
});

test('personal dependencies are available across projects without publishing project facts globally',async()=>{
 const f=fixture();try{const personal=await save(f.c,f.ctx,{content:'稳定偏好中文',kind:'preference',scope:'personal'}),project=await save(f.c,f.ctx,{content:'本项目事实'});const host=new RecordStore('host',f.dir),policy=new SourcePolicy(host);
  assert.doesNotThrow(()=>policy.capture({projectId:'another',sources:[],dependencies:[{capability:'memory',id:personal.id,version:personal.revision,hash:personal.hash,relation:'adopted'}]}));
  assert.throws(()=>policy.capture({projectId:'another',sources:[],dependencies:[{capability:'memory',id:project.id,version:project.revision,hash:project.hash,relation:'adopted'}]}),{code:'SOURCE_UNAVAILABLE'});host.close();
 }finally{await f.close();}
});

test('artifact forgetting suppresses only the exact observed fact span and artifact deletion withdraws remaining facts',async()=>{
 const f=fixture();try{
  f.items.splice(0);const first='SQLite first fact.',second='WAL second fact.',body=first+'\n'+second,path=join(f.dir,'artifact-forget.txt');writeFileSync(path,body);
  const artifact:ArtifactRef={artifactId:'forget-artifact',version:1,sha256:digest(body),mediaType:'text/plain',ranges:[{unit:'utf16',value:`0:${body.length}`}]};
  const receipt=(id:string,run:string):EvidenceReceipt=>({v:1,receiptId:id,projectId:'p',sessionId:'s',runId:run,stage:'tool-read',sources:[],artifacts:[artifact],dependencies:[],observer:{kind:'foreground',runId:run},contentHash:digest(body),visibleRanges:[[0,body.length]],at:new Date().toISOString()});
  const firstReceipt=receipt('before-forget','foreground-1');let observed=firstReceipt;const register=()=>{const host=new RecordStore('host',f.dir);new SourcePolicy(host).registerArtifact({ref:artifact,projectId:'p',path,observations:[firstReceipt,observed],valid:true});host.close();};register();(f.ctx as any).observedArtifacts=()=>[{artifact,receipt:observed}];
  f.ctx.readArtifact=async(ref,options={})=>{const start=options.cursor||0,end=Math.min(body.length,start+(options.maxChars||8000));return {artifact:ref,text:body.slice(start,end),fullLength:body.length,visibleRanges:[[start,end]],receipt:observed};};
  f.ctx.complete=async prompt=>{const material=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)),id=material[0].id;return JSON.stringify({memories:[{title:'第一事实',content:first,kind:'fact',sourceEntryIds:[id],sourceQuotes:{[id]:first}},{title:'第二事实',content:second,kind:'fact',sourceEntryIds:[id],sourceQuotes:{[id]:second}}]});};await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  const memory=f.c.search({query:'SQLite'},f.ctx)[0];assert.ok(memory);await f.c.dispatch('forget',{id:memory.id,revision:memory.revision},f.ctx);
  observed=receipt('after-forget','foreground-2');register();await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.deepEqual(f.c.search({query:'SQLite'},f.ctx),[]);assert.equal(f.c.search({query:'WAL'},f.ctx).length,1);
  await f.c.dispatch('source.deleted',{artifact},f.ctx);assert.deepEqual(f.c.search({query:'WAL'},f.ctx),[]);
 }finally{await f.close();}
});


test('legacy binaries can read migrated records but their database writes fail closed',async()=>{
 const f=fixture();try{const record=await save(f.c,f.ctx,{content:'升级后的正文'});const old=new DatabaseSync(join(f.dir,'plugins.sqlite'));try{assert.equal((JSON.parse(String(old.prepare('SELECT json FROM memory_records WHERE id=?').get(record.id)!.json)) as MemoryRecord).content,record.content);assert.throws(()=>old.prepare('UPDATE memory_records SET enabled=0 WHERE id=?').run(record.id),/friend_pi_writer_version|no such function|schema/i);assert.throws(()=>old.prepare("INSERT INTO documents(namespace,key,revision,json) VALUES('memory','old-writer',1,'{}')").run(),/friend_pi_writer_version|no such function|schema/i);}finally{old.close();}}finally{await f.close();}
});


test('forget also scrubs managed migration backups and crash staging files',async()=>{
 const f=fixture();try{const record=await save(f.c,f.ctx,{content:'忘记后备份不得保留正文',operationId:'backup-source'}),backupRoot=join(f.dir,'memory-migration-backups'),backup=join(backupRoot,'manual-snapshot.sqlite');const store=new RecordStore('memory',f.dir);store.db.prepare('VACUUM INTO ?').run(backup);store.close();
  const stage=join(f.dir,'memory-views','.project-p-crashed-staging');mkdirSync(stage,{recursive:true});writeFileSync(join(stage,'partial.md'),record.content);
  await f.c.dispatch('forget',{id:record.id,revision:record.revision},f.ctx);const snapshot=new DatabaseSync(backup);try{assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM memory_records WHERE id=?').get(record.id)!.count,0);assert.ok(!String(snapshot.prepare('SELECT json FROM memory_operations WHERE operation_id=?').get('backup-source')?.json).includes(record.content));}finally{snapshot.close();}assert.ok(!existsSync(stage));
 }finally{await f.close();}
});

test('Memory tool results and managed Markdown views cannot become independent learning evidence',async()=>{
 const f=fixture();try{
  const record=await save(f.c,f.ctx,{content:'既有事实'});f.items.splice(0);f.items.push({id:'memory-tool',parentId:null,type:'message',role:'toolResult',timestamp:new Date().toISOString(),text:JSON.stringify(record)});f.items.push({id:'memory-view',parentId:null,type:'message',role:'toolResult',timestamp:new Date().toISOString(),text:readFileSync(join(f.dir,'memory-views','project-p','records',record.id+'.md'),'utf8')});await f.c.settled(f.ctx);await drain(f.c,f.ctx);assert.equal(f.calls(),0);assert.equal(((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[]).length,0);
 }finally{await f.close();}
});

test('Expert tool results and managed projections cannot enter independent Memory extraction',async()=>{
 const f=fixture();try{
  const base:HistoryItem={id:'expert-tool',parentId:null,type:'message',role:'toolResult',timestamp:new Date().toISOString(),text:'项目数据库必须使用 SQLite。'};
  f.items.splice(0,1,{...base,toolName:'friend_expert'},{...base,id:'expert-projection',role:'assistant',sourceKind:'expert-projection'},{...base,id:'expert-view',text:`---\nid: expert-fact\nversion: 1\nhash: ${digest(base.text)}\nproject: p\n---\n${base.text}`});
  await f.c.settled(f.ctx);await drain(f.c,f.ctx);
  assert.equal(f.calls(),0);assert.equal(((f.c.snapshot(f.ctx).learning as any).jobs as LearningJob[]).length,0);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);
 }finally{await f.close();}
});
