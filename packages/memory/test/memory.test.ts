import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryController, searchTokens, type MemoryRecord } from '../src/index.js';
import type { HistoryItem, PluginContext } from '../../core/src/index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'friend-pi-memory-'));
  const entries: HistoryItem[] = [
    {id:'user1',parentId:null,type:'message',timestamp:new Date().toISOString(),role:'user',text:'这次服务端采用 WAL，数据库写操作需要串行。请先验证结果。'},
    {id:'reply1',parentId:'user1',type:'message',timestamp:new Date().toISOString(),role:'assistant',text:'已运行客观检查。'},
  ];
  const events: {event:string;data:unknown}[] = [];
  let idle = true;
  const ctx: PluginContext = {
    dataDir:dir,projectDir:dir,projectId:'project-a',sessionId:'session-a',origin:'user',
    isIdle:() => idle,history:() => entries,
    readSource(source) { const item = source.sessionId === 'session-a' ? entries.find(item => item.id === source.entryId) : undefined; if (!item) throw new Error('来源不存在'); return item; },
    complete:async prompt => prompt.includes('项目经验提取器') ? JSON.stringify({memories:[{title:'数据库写入',content:'服务端数据库写操作需要串行',kind:'experience',sourceEntryIds:['user1','reply1']}]}) : JSON.stringify({method:{title:'串行写入方法',content:'先使用WAL，再按顺序写入，检查事务结果。仅适用本项目。',sourceMemoryIds:[]}}),
    request:async () => { throw new Error('expert unavailable'); },
    emit:(event,data) => events.push({event,data}),notify:() => {},appendEntry:() => {},
  };
  return {dir,ctx,entries,events,setIdle:(value:boolean) => {idle=value;},cleanup:() => rmSync(dir,{recursive:true,force:true})};
}

test('Chinese bigrams and safe FTS queries handle short text and punctuation',async () => {
  const f = fixture(); const c = new MemoryController();
  try {
    assert.deepEqual(searchTokens('服务端 SQLite 24'),['服务','务端','sqlite','24']);
    assert.deepEqual(searchTokens('SQLite事务WAL写入 APIメモリ SQL고객정보'),['sqlite','事务','wal','写入','api','メモ','モリ','sql','고객','객정','정보']);
    const record = await c.dispatch('save',{content:'服务端使用 SQLite；参数 "100%_safe" 要保留',explicitRemember:true},f.ctx) as MemoryRecord;
    assert.equal(c.search({query:'服务端'},f.ctx)[0]?.id,record.id);
    assert.equal(c.search({query:'服'},f.ctx)[0]?.id,record.id);
    assert.equal(c.search({query:'100%_safe'},f.ctx)[0]?.id,record.id);
    assert.deepEqual(c.search({query:'" OR *'},f.ctx),[]);
    assert.deepEqual(c.search({query:'%'},f.ctx).map(record => record.id),[record.id]);
  } finally { await c.dispose(); f.cleanup(); }
});

test('project memory is isolated, ungrounded model personal writes are rejected',async () => {
  const f = fixture(); const c = new MemoryController();
  try {
    await c.dispatch('save',{content:'项目A使用SQLite',explicitRemember:true},f.ctx);
    const other = {...f.ctx,projectId:'project-b'};
    assert.deepEqual(c.search({query:'SQLite'},other),[]);
    await assert.rejects(c.dispatch('save',{content:'偏好中文',kind:'preference',scope:'personal'},f.ctx),/自动学习|原始来源/);
    const personal = await c.dispatch('save',{content:'我偏好中文解释',kind:'preference',scope:'personal',explicitRemember:true},f.ctx) as MemoryRecord;
    assert.equal(c.search({query:'中文'},other)[0]?.id,personal.id);
    await assert.rejects(c.dispatch('read',{id:((c.snapshot(f.ctx).memories as MemoryRecord[]).find(record => record.scope === 'project'))?.id},other),/不属于/);
  } finally { await c.dispose(); f.cleanup(); }
});

test('model extraction is a candidate and duplicate source summaries add no evidence',async () => {
  const f = fixture(); const c = new MemoryController();
  try {
    const refs = [{sessionId:'session-a',entryId:'user1'},{sessionId:'session-a',entryId:'user1'}];
    const first = await c.dispatch('save',{content:'模型提取的数据库经验',sources:refs},f.ctx) as MemoryRecord;
    const repeat = await c.dispatch('save',{content:'模型提取的数据库经验',sources:refs},f.ctx) as MemoryRecord;
    assert.equal(first.status,'candidate'); assert.equal(first.sources.length,1); assert.equal(repeat.id,first.id);
    assert.deepEqual(c.search({query:'数据库'},f.ctx),[]);
    assert.equal(c.search({query:'数据库',includeCandidates:true},f.ctx).length,1);
    const accepted = await c.dispatch('accept',{id:first.id,revision:1},f.ctx) as MemoryRecord;
    assert.equal(accepted.status,'active'); assert.equal(accepted.confirmedBy,'user');
    await assert.rejects(c.dispatch('save',{content:'虚构来源',sources:[{sessionId:'session-a',entryId:'unknown'}]},f.ctx),/来源不存在/);
  } finally { await c.dispose(); f.cleanup(); }
});

test('correction uses CAS and invalidates descendants before the next context',async () => {
  const f = fixture(); const c = new MemoryController();
  try {
    const parent = await c.dispatch('save',{content:'错误：数据库并行写入',explicitRemember:true,sources:[{sessionId:'session-a',entryId:'user1'}]},f.ctx) as MemoryRecord;
    const child = await c.dispatch('save',{content:'从并行写入派生的错误方法',kind:'experience',parentIds:[parent.id],sources:parent.sources},f.ctx) as MemoryRecord;
    const corrected = await c.dispatch('update',{id:parent.id,revision:1,content:'数据库写入必须串行'},f.ctx) as MemoryRecord;
    assert.equal(corrected.revision,2);
    await assert.rejects(c.dispatch('update',{id:parent.id,revision:1,content:'另一个版本'},f.ctx),{name:'ConflictError'});
    const invalidated = await c.dispatch('read',{id:child.id},f.ctx) as MemoryRecord;
    assert.equal(invalidated.status,'invalidated'); assert.equal(invalidated.enabled,false);
    assert.equal((f.events.find(item => item.event === 'memory.invalidated')?.data as {reason:string}).reason,'corrected');
    await assert.rejects(c.dispatch('accept',{id:child.id,revision:invalidated.revision},f.ctx),/来源无效/);
    const sourceRead = await c.dispatch('read',{id:parent.id,revision:parent.revision,source:true},f.ctx) as {originals:{item:HistoryItem}[]};
    assert.equal(sourceRead.originals[0]?.item.id,'user1');
    const exported = await c.dispatch('export',{id:parent.id},f.ctx) as {path:string};
    assert.match(readFileSync(exported.path,'utf8'),/数据库写入必须串行/);
  } finally { await c.dispose(); f.cleanup(); }
});

test('forget deletes descendants and versions, suppression survives a cold restart',async () => {
  const f = fixture(); let c = new MemoryController();
  try {
    const parent = await c.dispatch('save',{content:'服务端数据库写操作需要串行',explicitRemember:true,sources:[{sessionId:'session-a',entryId:'user1'}]},f.ctx) as MemoryRecord;
    const child = await c.dispatch('save',{content:'旧派生方法',kind:'experience',parentIds:[parent.id],sources:parent.sources},f.ctx) as MemoryRecord;
    await c.dispatch('forget',{id:parent.id,revision:1},f.ctx);
    await assert.rejects(c.dispatch('read',{id:child.id},f.ctx),/不存在/);
    await c.dispose(); c = new MemoryController();
    f.ctx.complete = async () => JSON.stringify({memories:[{title:'再次摘要',content:'换一种说法：写入应串行',kind:'experience',sourceEntryIds:['user1']}]});
    await c.dispatch('learning.run',{},f.ctx); await c.whenIdle(f.ctx);
    assert.equal((c.snapshot(f.ctx).candidates as MemoryRecord[]).length,0);
    assert.equal((c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);
    const jobs = (c.snapshot(f.ctx).learning as {jobs:{state:string}[]}).jobs;
    assert.equal(jobs[0]?.state,'completed');
  } finally { await c.dispose(); f.cleanup(); }
});

test('disabled memory stays disabled after automatic relearning and cold restart',async () => {
  const f = fixture(); let c = new MemoryController();
  try {
    const memory = await c.dispatch('save',{content:'服务端数据库写操作需要串行',explicitRemember:true,sources:[{sessionId:'session-a',entryId:'user1'}]},f.ctx) as MemoryRecord;
    await c.dispatch('toggle',{id:memory.id,revision:memory.revision,enabled:false},f.ctx);
    await c.dispose(); c = new MemoryController();
    f.ctx.complete = async () => JSON.stringify({memories:[{title:'重复学习',content:'服务端数据库写操作需要串行',kind:'experience',sourceEntryIds:['user1']}]});
    await c.dispatch('learning.run',{},f.ctx); await c.whenIdle(f.ctx);
    assert.deepEqual(c.search({query:'数据库'},f.ctx),[]);
    assert.equal((c.snapshot(f.ctx).candidates as MemoryRecord[]).length,0);
  } finally { await c.dispose(); f.cleanup(); }
});

test('independent Memory extraction publishes experience with one call and never submits Expert',async () => {
  const f = fixture(); const c = new MemoryController(); let calls = 0;
  try {
    f.entries.push({id:'verified1',parentId:'reply1',type:'message',timestamp:new Date().toISOString(),role:'toolResult',text:'服务端数据库写操作串行验证通过。'});
    f.ctx.complete = async prompt => {
      calls++;
      if (prompt.includes('项目经验提取器')) return JSON.stringify({memories:[{title:'数据库写入',content:'服务端数据库写操作需要串行',kind:'experience',sourceEntryIds:['verified1']}]});
      const candidate = (c.snapshot(f.ctx).memories as MemoryRecord[]).find(record => record.kind === 'experience')!;
      return JSON.stringify({method:{title:'事务写入检查',content:'仅本项目：顺序写入，并检查事务完整性。',sourceMemoryIds:[candidate.id]}});
    };
    await c.settled(f.ctx); await c.whenIdle(f.ctx);
    const candidates = c.snapshot(f.ctx).candidates as MemoryRecord[];
    assert.equal(candidates.length,0); assert.equal(calls,1);assert.equal((c.snapshot(f.ctx).memories as MemoryRecord[])[0]?.confirmedBy,'system');
    assert.ok(!(c.snapshot(f.ctx).memories as MemoryRecord[]).some(record=>record.kind==='method'));
    assert.equal(candidates.every(record => record.status === 'candidate'),true);
    await c.settled(f.ctx); await c.whenIdle(f.ctx); assert.equal(calls,1);
  } finally { await c.dispose(); f.cleanup(); }
});

test('pause aborts owned learning but foreground input does not preempt it',async () => {
  const f = fixture(); const c = new MemoryController(); let started!:() => void;
  let start = new Promise<void>(resolve => {started=resolve;});let finish!:(value:string)=>void;
  try {
    f.ctx.complete = async (_prompt,options) => {
      started();
      return new Promise<string>((resolve,reject) => {finish=resolve; options?.signal?.addEventListener('abort',() => reject(new Error('aborted')),{once:true}); });
    };
    await c.dispatch('learning.run',{},f.ctx); const run = c.whenIdle(f.ctx); await start;
    await c.dispatch('learning.pause',{},f.ctx); await run;
    let job = (c.snapshot(f.ctx).learning as {jobs:{state:string;attempts:number}[]}).jobs[0]!;
    assert.equal(job.state,'queued'); assert.equal(job.attempts,0);
    start = new Promise<void>(resolve => {started=resolve;});
    await c.dispatch('learning.resume',{},f.ctx); const second = c.whenIdle(f.ctx); await start;
    f.setIdle(false); c.foregroundStarted(); await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal((c.snapshot(f.ctx).learning as {jobs:{state:string}[]}).jobs[0]?.state,'running');finish(JSON.stringify({memories:[]}));await second;
    job = (c.snapshot(f.ctx).learning as {jobs:{state:string;attempts:number}[]}).jobs[0]!;
    assert.equal(job.state,'completed'); assert.equal(job.attempts,0);
  } finally { await c.dispose(); f.cleanup(); }
});

test('failed background work stops after two retries and reports a durable failure',async () => {
  const f = fixture(); const c = new MemoryController(); let calls=0;const clock=Date.now;let elapsed=0;Date.now=()=>clock()+elapsed;
  try {
    f.ctx.complete = async () => { calls++; throw new Error('fake provider failed'); };
    await c.dispatch('learning.run',{},f.ctx); await c.whenIdle(f.ctx);
    for(let i=0;i<2;i++){elapsed+=10000;await c.whenIdle(f.ctx);}
    const job = (c.snapshot(f.ctx).learning as {jobs:{state:string;attempts:number;error:string}[]}).jobs[0]!;
    assert.equal(calls,3); assert.equal(job.state,'failed'); assert.equal(job.attempts,3); assert.match(job.error,/fake provider/);
    assert.equal((c.snapshot(f.ctx).candidates as MemoryRecord[]).length,0);
  } finally { Date.now=clock;await c.dispose(); f.cleanup(); }
});

test('an agent cannot self-confirm by accept, update or explicitRemember',async () => {
  const f = fixture(); const c = new MemoryController();
  try {
    const agent = {...f.ctx,origin:'agent' as const};
    for(const action of ['learning.run','learning.pause','learning.resume','learning.settings','learning.retry'])await assert.rejects(c.dispatch(action,{},agent),/用户操作/);
    const negative={...agent,history:()=>[{id:'negative',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'请不要记住我的个人偏好。'}]};
    await assert.rejects(c.dispatch('save',{scope:'personal',kind:'preference',content:'未经请求的偏好',explicitRemember:true},negative),/自动学习|原始来源/);
    const candidate = await c.dispatch('save',{content:'未经验证的结果',explicitRemember:true},agent) as MemoryRecord;
    assert.equal(candidate.status,'candidate');
    await assert.rejects(c.dispatch('accept',{id:candidate.id,revision:1},agent),/用户确认/);
    const updated = await c.dispatch('update',{id:candidate.id,revision:1,content:'模型自己改写'},agent) as MemoryRecord;
    assert.equal(updated.status,'candidate'); assert.equal(updated.confirmedBy,undefined);
    const active=await c.dispatch('save',{content:'用户已确认的原始事实',explicitRemember:true},f.ctx) as MemoryRecord;
    const changedActive=await c.dispatch('update',{id:active.id,revision:active.revision,content:'模型对事实的新改写'},agent) as MemoryRecord;
    assert.equal(changedActive.status,'candidate');assert.equal(changedActive.confirmedBy,undefined);
    assert.deepEqual(c.search({query:'模型对事实'},f.ctx),[]);
    await assert.rejects(c.dispatch('save',{content:'模型猜测个人偏好',scope:'personal',kind:'preference',explicitRemember:true},agent),/自动学习|原始来源/);
  } finally { await c.dispose(); f.cleanup(); }
});

test('independent controllers atomically serialize learning and do not recover a live owner',async () => {
  const f = fixture(); const first = new MemoryController(); const second = new MemoryController();
  let started!:() => void; const start = new Promise<void>(resolve => {started=resolve;});
  let finish!:() => void; const release = new Promise<void>(resolve => {finish=resolve;});
  let secondCalls = 0;
  try {
    f.ctx.complete = async () => { started(); await release; return JSON.stringify({memories:[]}); };
    await first.dispatch('learning.run',{},f.ctx); const running = first.whenIdle(f.ctx); await start;
    assert.equal((second.snapshot(f.ctx).learning as {jobs:{state:string}[]}).jobs[0]?.state,'running');
    const other = {...f.ctx,projectId:'project-b',complete:async () => {secondCalls++; return JSON.stringify({memories:[]}); }};
    await second.dispatch('learning.run',{},other); await second.whenIdle(other);
    assert.equal(secondCalls,0);
    finish(); await running; await second.whenIdle(other);
    assert.equal(secondCalls,1);
  } finally { finish(); await first.dispose(); await second.dispose(); f.cleanup(); }
});

test('ranked any-term search recalls project memory from a longer user goal',async () => {
  const f=fixture();const c=new MemoryController();
  try {
    const record=await c.dispatch('save',{content:'SQLite事务写入必须串行',explicitRemember:true},f.ctx) as MemoryRecord;
    assert.deepEqual(c.search({query:'请检查数据库的事务并说明结果'},f.ctx),[]);
    assert.equal(c.search({query:'请检查数据库的事务并说明结果',match:'any'},f.ctx)[0]?.id,record.id);
    assert.deepEqual(c.search({query:'请检查数据库的事务并说明结果',match:'any'},{...f.ctx,projectId:'project-b'}),[]);
  } finally {await c.dispose();f.cleanup();}
});
