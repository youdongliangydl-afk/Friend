import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync,existsSync,readdirSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,peekLearningJob,type MemoryRecord,type LearningJob} from '../src/index.js';
import {RecordStore,SourcePolicy,CapabilityError,digest,readSourceSpan,type PluginContext,type HistoryItem,type ArtifactRef,type EvidenceReceipt} from '../../core/src/index.js';

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
