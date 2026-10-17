import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,peekLearningJob,type MemoryRecord,type LearningJob} from '../src/index.js';
import type {HistoryItem,PluginContext} from '../../core/src/index.js';

/** P0 acceptance: end-to-end through the public controller (blueprint §7.2). */
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-p0-acceptance-')),items:HistoryItem[]=[{id:'user1',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'开始独立验收。'}];
 const previous=process.env.FRIEND_PI_LEARNING_ROLE;process.env.FRIEND_PI_LEARNING_ROLE='producer';
 let calls=0;const events:{event:string;data:any}[]=[];let c=new MemoryController();
 const ctx:PluginContext={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'run-1',modelId:'fixture/offline',isIdle:()=>false,history:()=>items,readSource:source=>{const item=items.find(item=>item.id===source.entryId);if(!item)throw new Error('来源不存在');return item;},complete:async()=>{calls++;return '{"memories":[]}';},request:async()=>{throw new Error('not installed');},emit:(event,data)=>events.push({event,data}),notify:()=>{},appendEntry:()=>{}};
 return {dir,items,ctx,events,calls:()=>calls,get now(){return c;},
  reply(proposals:unknown[]){ctx.complete=async()=>{calls++;return JSON.stringify({memories:proposals});};},
  push(id:string,text:string){items.push({id,parentId:items.at(-1)?.id??null,type:'message',role:'user',timestamp:new Date().toISOString(),text});},
  cold:async()=>{await c.dispose();c=new MemoryController();},
  close:async()=>{await c.dispose();if(previous===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=previous;rmSync(dir,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
async function drain(c:MemoryController,ctx:PluginContext){for(let step=0;step<80;step++){const job=peekLearningJob(ctx.dataDir);if(!job)return;await c.executeLearningJob(job.id,ctx);}throw new Error('learning did not settle');}
const records=(c:MemoryController,ctx:PluginContext)=>c.snapshot(ctx) as unknown as {memories:MemoryRecord[];candidates:MemoryRecord[];conflicts:any[];autoPublish:{policy:{mode:string;version:number};stats:{autoPublished:number;revoked:number;corrected:number};audit:any[]}};

test('standard auto-publish records an auditable score/gates/rollbackToken and a user revoke suppresses revival',async()=>{
 const f=fixture();try{
  f.items[0].text='数据库必须使用 SQLite。';
  f.reply([{title:'数据库引擎',content:'数据库必须使用 SQLite',kind:'fact',subject:'project.db.engine',sourceEntryIds:['user1'],sourceQuotes:{user1:'数据库必须使用 SQLite。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const snapshot=records(f.now,f.ctx),active=snapshot.memories.find(record=>record.content==='数据库必须使用 SQLite');
  assert.ok(active,'user-verified subject fact is auto-published under a fresh-standard install');
  assert.equal(active.status,'active');assert.equal(active.autoPublished,true);assert.equal(active.trust,'source_verified');assert.equal(active.subjectKey,'project.db.engine');
  assert.equal(snapshot.autoPublish.policy.mode,'standard');
  const audit=snapshot.autoPublish.audit.filter(row=>row.memoryId===active.id&&row.action==='publish')[0];
  assert.ok(audit);assert.ok(audit.score>=70);assert.deepEqual(audit.gates.map((gate:any)=>gate.id),[1,2,3,4,5,6,7,8,9,10]);assert.match(audit.rollbackToken,/^[0-9a-f]{64}$/);
  const revoked=await f.now.dispatch('autoPublish.revoke',{ids:[active.id],reason:'验收回滚'},f.ctx) as {revoked:string[]};
  assert.deepEqual(revoked.revoked,[active.id]);
  const after=await f.now.dispatch('read',{id:active.id},f.ctx) as MemoryRecord;
  assert.equal(after.status,'inactive');assert.equal(after.enabled,false);assert.equal(after.autoPublished,false);
  assert.deepEqual(f.now.search({query:'SQLite'},f.ctx),[]);
  // A late/reworded extraction must not revive the revoked fact, even in a new session.
  f.push('relearn','数据库必须使用 SQLite。');
  f.ctx.sessionId='s2';f.reply([{title:'数据库引擎再次学习',content:'数据库必须使用 SQLite',kind:'fact',subject:'project.db.engine',sourceEntryIds:['relearn'],sourceQuotes:{relearn:'数据库必须使用 SQLite。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const revived=records(f.now,f.ctx);
  assert.ok(!revived.memories.some(record=>record.content.includes('SQLite')&&record.status==='active'));
  assert.ok(!revived.candidates.some(record=>record.content.includes('SQLite')));
  assert.equal((f.now.snapshot(f.ctx).autoPublish as any).stats.revoked,1);
 }finally{await f.close();}
});

test('conflict keeps the current value usable, isolates the new value, and keep_right resolves it',async()=>{
 const f=fixture();try{
  f.items[0].text='项目事实：订单数据库实际使用 SQLite。';f.reply([{title:'订单数据库 SQLite',content:'订单数据库实际使用 SQLite',kind:'fact',subject:'orders.database.engine',sourceEntryIds:['user1'],sourceQuotes:{user1:'订单数据库实际使用 SQLite。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const first=records(f.now,f.ctx).memories.find(record=>record.content==='订单数据库实际使用 SQLite')!;assert.ok(first);
  f.push('fact2','独立观察：订单数据库实际使用 PostgreSQL。');f.ctx.sessionId='s2';
  f.reply([{title:'订单数据库 PostgreSQL',content:'订单数据库实际使用 PostgreSQL',kind:'fact',subject:'orders.database.engine',sourceEntryIds:['fact2'],sourceQuotes:{fact2:'订单数据库实际使用 PostgreSQL。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const snapshot=records(f.now,f.ctx),current=snapshot.memories.find(record=>record.id===first.id)!,candidate=snapshot.candidates.find(record=>record.content==='订单数据库实际使用 PostgreSQL')!;
  assert.equal(current.status,'active','old value stays usable per blueprint §6.3');
  assert.deepEqual(current.conflictIds,[]);assert.equal(candidate.status,'candidate');assert.ok(candidate.conflictId);assert.equal(candidate.conflictState,'open');
  assert.equal(f.now.search({query:'PostgreSQL'},f.ctx).length,0);
  assert.equal(f.now.search({query:'SQLite'},f.ctx)[0]?.id,current.id);
  const list=await f.now.dispatch('conflict.list',{status:'open'},f.ctx) as {conflicts:any[]};
  assert.equal(list.conflicts.length,1);assert.equal(list.conflicts[0].subjectKey,'orders.database.engine');
  const resolved=await f.now.dispatch('conflict.resolve',{id:list.conflicts[0].id,resolution:'keep_right',expectedStatus:'open'},f.ctx) as {conflict:any;affectedRecordIds:string[]};
  assert.equal(resolved.conflict.status,'resolved');assert.equal(resolved.conflict.resolution,'keep_right');
  const final=records(f.now,f.ctx);
  assert.equal(final.memories.find(record=>record.id===candidate.id)?.status,'active');
  assert.equal(final.memories.find(record=>record.id===current.id)?.status,'inactive');
  assert.equal(f.now.search({query:'PostgreSQL'},f.ctx)[0]?.id,candidate.id);
  assert.equal(f.now.search({query:'SQLite'},f.ctx).length,0);
  assert.ok(f.events.some(event=>event.event==='memory.conflict.opened'));assert.ok(f.events.some(event=>event.event==='memory.conflict.resolved'));
 }finally{await f.close();}
});

test('conflict resolve both requires distinguishable conditions and neither retires both values',async()=>{
 const f=fixture();try{
  f.items[0].text='项目事实：测试环境的缓存使用 Redis。';f.reply([{title:'缓存 Redis',content:'测试环境的缓存使用 Redis',kind:'fact',subject:'cache.engine',conditions:['仅测试环境'],sourceEntryIds:['user1'],sourceQuotes:{user1:'测试环境的缓存使用 Redis。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  f.push('cache2','生产环境的缓存使用 Memcached。');f.ctx.sessionId='s2';
  f.reply([{title:'缓存 Memcached',content:'生产环境的缓存使用 Memcached',kind:'fact',subject:'cache.engine',conditions:['仅生产环境'],sourceEntryIds:['cache2'],sourceQuotes:{cache2:'生产环境的缓存使用 Memcached。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const open=(await f.now.dispatch('conflict.list',{status:'open'},f.ctx) as {conflicts:any[]}).conflicts;
  assert.equal(open.length,1);
  const both=await f.now.dispatch('conflict.resolve',{id:open[0].id,resolution:'both'},f.ctx) as {records:MemoryRecord[]};
  assert.equal(both.records.filter(record=>record.status==='active').length,2);
  const snapshot=records(f.now,f.ctx);
  assert.ok(snapshot.memories.filter(record=>record.subjectKey==='cache.engine'&&record.status==='active').every(record=>record.subjectCardinality==='multi'));
  // A second subject with equal (or missing) conditions cannot be combined.
  f.push('cache3','另一环境使用本地缓存。');f.ctx.sessionId='s3';
  f.reply([{title:'本地缓存',content:'另一环境使用本地缓存',kind:'fact',subject:'cache.engine',sourceEntryIds:['cache3'],sourceQuotes:{cache3:'另一环境使用本地缓存。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const nextOpen=(await f.now.dispatch('conflict.list',{status:'open'},f.ctx) as {conflicts:any[]}).conflicts[0];
  await assert.rejects(f.now.dispatch('conflict.resolve',{id:nextOpen.id,resolution:'both'},f.ctx),{code:'VALIDATION_ERROR'});
  const neither=await f.now.dispatch('conflict.resolve',{id:nextOpen.id,resolution:'neither'},f.ctx) as {records:MemoryRecord[]};
  assert.ok(neither.records.every(record=>record.status==='inactive'));
 }finally{await f.close();}
});

test('autoPublish settings switch modes with CAS and mode off keeps automatic proposals as candidates',async()=>{
 const f=fixture();try{
  const policy=(await f.now.dispatch('autoPublish.status',{},f.ctx) as any).policy;
  assert.equal(policy.mode,'standard');
  const off=await f.now.dispatch('autoPublish.settings',{mode:'off',expectedVersion:policy.version},f.ctx) as any;
  assert.equal(off.mode,'off');assert.equal(off.version,policy.version+1);
  await assert.rejects(f.now.dispatch('autoPublish.settings',{mode:'standard',expectedVersion:policy.version},f.ctx),{name:'ConflictError'});
  f.items[0].text='日志必须使用 UTF-8。';
  f.reply([{title:'日志编码',content:'日志必须使用 UTF-8',kind:'fact',subject:'project.log.encoding',sourceEntryIds:['user1'],sourceQuotes:{user1:'日志必须使用 UTF-8。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  let snapshot=records(f.now,f.ctx);
  assert.equal(snapshot.memories.length,0);assert.equal(snapshot.candidates.length,1);
  assert.equal(snapshot.autoPublish.audit.filter(row=>row.action==='publish').length,0);
  const standard=await f.now.dispatch('autoPublish.settings',{mode:'standard',expectedVersion:off.version},f.ctx) as any;
  assert.equal(standard.mode,'standard');
  f.push('log2','日志必须使用 UTF-8。');f.ctx.sessionId='s2';
  f.reply([{title:'日志编码二次',content:'日志必须使用 UTF-8',kind:'fact',subject:'project.log.encoding',sourceEntryIds:['log2'],sourceQuotes:{log2:'日志必须使用 UTF-8。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  snapshot=records(f.now,f.ctx);
  assert.ok(snapshot.memories.some(record=>record.content==='日志必须使用 UTF-8'&&record.status==='active'));
  assert.ok(f.events.some(event=>event.event==='memory.autopublish'&&(event.data as any).action==='settings'));
 }finally{await f.close();}
});

test('forgetting a value blocks a reworded (different bytes) learning proposal from reviving it',async()=>{
 const f=fixture();try{
  const original='数据库写操作必须串行执行，避免并发冲突。';
  f.items[0].text=original;f.reply([{title:'数据库写入',content:'数据库写操作必须串行执行',kind:'experience',sourceEntryIds:['user1'],sourceQuotes:{user1:original}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const active=records(f.now,f.ctx).memories.find(record=>record.content.includes('串行'))!;assert.ok(active);
  await f.now.dispatch('forget',{id:active.id,expectedRevision:active.revision},f.ctx);
  assert.equal(f.now.search({query:'串行'},f.ctx).length,0);
  // Same fact, different wording/citation shape (exact content hash no longer matches).
  f.push('rewrite','数据库写操作必须串行执行,避免并发冲突');f.ctx.sessionId='s2';
  f.reply([{title:'数据库写入改写',content:'数据库写操作必须串行执行,避免并发冲突',kind:'experience',sourceEntryIds:['rewrite'],sourceQuotes:{rewrite:'数据库写操作必须串行执行,避免并发冲突'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const snapshot=records(f.now,f.ctx);
  assert.ok(!snapshot.memories.some(record=>record.content.includes('串行')&&record.status==='active'),'exact bytes changed, must not reactivate');
  assert.ok(!snapshot.candidates.some(record=>record.content.includes('串行')),'suppression family rejects the paraphrase before it becomes a candidate');
 }finally{await f.close();}
});

test('revoking one auto-publish batch by protocolVersion/batchKey is idempotent and targeted',async()=>{
 const f=fixture();try{
  f.items[0].text='接口必须使用 camelCase。文件必须使用 UTF-8。';
  f.reply([
   {title:'接口命名',content:'接口必须使用 camelCase',kind:'fact',subject:'project.api.naming',sourceEntryIds:['user1'],sourceQuotes:{user1:'接口必须使用 camelCase。'}},
   {title:'文件编码',content:'文件必须使用 UTF-8',kind:'fact',subject:'project.file.encoding',sourceEntryIds:['user1'],sourceQuotes:{user1:'文件必须使用 UTF-8。'}},
  ]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const published=records(f.now,f.ctx).memories.filter(record=>record.autoPublished);
  assert.equal(published.length,2);
  const audit=records(f.now,f.ctx).autoPublish.audit.filter(row=>row.action==='publish');
  const batch=audit[0].batchKey;assert.ok(batch);assert.equal(audit[1].batchKey,batch);
  const first=await f.now.dispatch('autoPublish.revoke',{batchKey:batch},f.ctx) as {revoked:string[]};
  assert.equal(first.revoked.length,2);
  const second=await f.now.dispatch('autoPublish.revoke',{batchKey:batch},f.ctx) as {revoked:string[]};
  assert.deepEqual(second.revoked,[]);
  const snapshot=records(f.now,f.ctx);
  assert.equal(snapshot.memories.filter(record=>record.autoPublished&&record.status==='active').length,0);
  assert.equal(snapshot.autoPublish.stats.revoked,2);
 }finally{await f.close();}
});

test('a later user correction of an auto-published record revokes its auto flag and is audited as a correction',async()=>{
 const f=fixture();try{
  f.items[0].text='部署目录必须使用 /opt/app。';f.reply([{title:'部署目录',content:'部署目录必须使用 /opt/app',kind:'fact',subject:'project.deploy.dir',sourceEntryIds:['user1'],sourceQuotes:{user1:'部署目录必须使用 /opt/app。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const active=records(f.now,f.ctx).memories.find(record=>record.autoPublished)!;assert.ok(active);
  const updated=await f.now.dispatch('update',{id:active.id,expectedRevision:active.revision,content:'部署目录必须使用 /srv/app'},f.ctx) as MemoryRecord;
  assert.equal(updated.status,'active');assert.equal(updated.autoPublished,false);assert.equal(updated.trust,'user_explicit');
  const stats=records(f.now,f.ctx).autoPublish.stats;
  assert.equal(stats.corrected,1);
  const job=(f.now.snapshot(f.ctx).learning as {jobs:LearningJob[]}).jobs.find(job=>job.memoryIds.includes(active.id))!;
  assert.ok(job);
 }finally{await f.close();}
});
