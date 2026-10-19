import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,peekLearningJob,type MemoryRecord,type LearningJob} from '../src/index.js';
import type {HistoryItem,PluginContext} from '../../core/src/index.js';

/** P1/P2 integration acceptance through the public controller (kinds, lifecycle, Dream, review, pins, graph, explain, usage). */
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-p1p2-')),items:HistoryItem[]=[{id:'user1',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'开始 P1/P2 验收。'}];
 const previous=process.env.FRIEND_PI_LEARNING_ROLE;process.env.FRIEND_PI_LEARNING_ROLE='producer';
 let calls=0;const events:{event:string;data:any}[]=[];let c=new MemoryController();
 const ctx:PluginContext={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'run-1',modelId:'fixture/offline',isIdle:()=>false,history:()=>items,readSource:source=>{const item=items.find(item=>item.id===source.entryId);if(!item)throw new Error('来源不存在');return item;},complete:async()=>{calls++;return '{"memories":[]}'},request:async()=>{throw new Error('not installed');},emit:(event,data)=>events.push({event,data}),notify:()=>{},appendEntry:()=>{}};
 return {dir,items,ctx,events,calls:()=>calls,get now(){return c;},
  reply(proposals:unknown[]){ctx.complete=async()=>{calls++;return JSON.stringify({memories:proposals});};},
  push(id:string,text:string,role:'user'|'toolResult'='user'){items.push({id,parentId:items.at(-1)?.id??null,type:'message',role,timestamp:new Date().toISOString(),text});},
  cold:async()=>{await c.dispose();c=new MemoryController();},
  close:async()=>{await c.dispose();if(previous===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=previous;rmSync(dir,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
async function drain(c:MemoryController,ctx:PluginContext){for(let step=0;step<80;step++){const job=peekLearningJob(ctx.dataDir);if(!job)return;await c.executeLearningJob(job.id,ctx);}throw new Error('learning did not settle');}
const save=(f:Fixture,input:Record<string,unknown>)=>f.now.dispatch('save',{explicitRemember:true,...input},f.ctx) as Promise<MemoryRecord>;
const snapshot=(f:Fixture)=>f.now.snapshot(f.ctx) as any;

test('Dream profile proposals stay candidates even with confirmed parents or a claimed user origin',async()=>{
 const f=fixture();try{
  const a=await save(f,{kind:'preference',scope:'personal',content:'用户希望中文回答'});
  const b=await save(f,{kind:'preference',scope:'personal',content:'用户希望回答简短'});
  for(const origin of ['model','user']){
   const content=`未经确认的画像 ${origin}：所有项目禁用测试`;
   const result=await f.now.dispatch('dream.run',{proposals:[{kind:'profile',parentIds:[a.id,b.id],content,origin}]},{...f.ctx,origin:'plugin'}) as any;
   assert.equal(result.childIds.length,1);
   const child=await f.now.dispatch('read',{id:result.childIds[0]},f.ctx) as MemoryRecord;
   assert.equal(child.content,content);assert.equal(child.scope,'personal');assert.equal(child.status,'candidate');
   assert.equal(child.trust,'model_supported');assert.notEqual(child.confirmedBy,'user');
   for(const parent of [a,b])assert.equal((await f.now.dispatch('read',{id:parent.id},f.ctx) as MemoryRecord).status,'active');
  }
 }finally{await f.close();}
});

test('personal imports preserve scope and remain external candidates without lifting suppression',async()=>{
 const f=fixture();try{
  const prior=await save(f,{kind:'knowledge',scope:'personal',content:'跨项目知识：交付前核对来源'});
  await f.now.dispatch('forget',{id:prior.id,revision:prior.revision},f.ctx);
  const result=await f.now.dispatch('import',{records:[
   {kind:'knowledge',scope:'personal',content:prior.content,aliases:['来源核对'],validFrom:'2020-01-01T00:00:00.000Z'},
   {kind:'preference',scope:'personal',content:'用户偏好中文回答'},
  ]},f.ctx) as any;
  assert.deepEqual(result.skipped,[]);assert.equal(result.imported.length,2);
  const records=await Promise.all(result.imported.map((id:string)=>f.now.dispatch('read',{id},f.ctx))) as MemoryRecord[];
  for(const record of records){assert.equal(record.scope,'personal');assert.equal(record.status,'candidate');assert.equal(record.trust,'external_import');assert.notEqual(record.confirmedBy,'user');}
  assert.deepEqual(records[0].aliases,['来源核对']);assert.equal(records[0].validFrom,'2020-01-01T00:00:00.000Z');
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.dir,'plugins.sqlite'));
  try{assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM memory_suppression').get()!.n)>0);}finally{db.close();}
  assert.equal(f.now.search({query:prior.content},f.ctx).length,0);
 }finally{await f.close();}
});

test('deferred reviews reopen once due while future and resolved reviews stay closed',async()=>{
 const f=fixture();try{
  const past=new Date(Date.now()-86400000).toISOString();
  const records=await Promise.all(['到期','未来','已解决'].map(label=>save(f,{kind:'fact',content:`复审 ${label}`,expiresAt:past})));
  const queue=await f.now.dispatch('review.list',{},f.ctx) as any;
  const reviews=records.map(record=>queue.reviews.find((row:any)=>row.memory_id===record.id&&row.reason==='expired'));
  for(const row of reviews.slice(0,2))await f.now.dispatch('review.resolve',{id:row.id,action:'defer',notes:'稍后复核'},f.ctx);
  await f.now.dispatch('review.resolve',{id:reviews[2].id,action:'confirm'},f.ctx);
  assert.ok(!(await f.now.dispatch('review.list',{},f.ctx) as any).reviews.some((row:any)=>reviews.some(review=>review.id===row.id)));
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.dir,'plugins.sqlite'));
  try{db.function('friend_pi_writer_version',{deterministic:true},()=>6);db.prepare('UPDATE memory_reviews SET due_at=? WHERE id=?').run(past,reviews[0].id);}finally{db.close();}
  for(let scan=0;scan<2;scan++){
   const open=(await f.now.dispatch('review.list',{},f.ctx) as any).reviews;
   assert.equal(open.filter((row:any)=>row.id===reviews[0].id).length,1);
   assert.equal(open.find((row:any)=>row.id===reviews[0].id).notes,'稍后复核');
   assert.ok(!open.some((row:any)=>row.id===reviews[1].id||row.id===reviews[2].id));
  }
 }finally{await f.close();}
});

test('seven kinds enforce scope, TTL/review defaults and conditions',async()=>{
 const f=fixture();try{
  await assert.rejects(save(f,{kind:'profile',scope:'project',content:'用户画像'}),/范围/);
  await assert.rejects(save(f,{kind:'episode',scope:'project',content:'情节'}),/适用条件/);
  const profile=await save(f,{kind:'profile',scope:'personal',content:'用户偏好中文解释'});
  const episode=await save(f,{kind:'episode',content:'本轮完成记忆系统验收',conditions:['会话 s']});
  const task=await save(f,{kind:'task',content:'继续完成 Dream v2 验收',conditions:['会话 s','状态 open']});
  const knowledge=await save(f,{kind:'knowledge',content:'跨项目知识：先读目录再读正文'});
  const personalKnowledge=await save(f,{kind:'knowledge',scope:'personal',content:'跨项目知识：结论要带来源'});
  assert.equal(profile.kind,'profile');assert.equal(profile.scope,'personal');
  assert.equal(episode.kind,'episode');assert.equal(task.kind,'task');
  assert.equal(knowledge.scope,'project');assert.equal(personalKnowledge.scope,'personal');
  assert.ok(episode.expiresAt&&task.expiresAt,'episode/task carry TTL expires_at');
  assert.ok(episode.reviewAfter,'reviewAfter defaults are derived from kind policy');
  assert.ok(Date.parse(episode.expiresAt!)>Date.now());
  const kinds=new Set((snapshot(f).memories as MemoryRecord[]).map(record=>record.kind));
  for(const kind of ['profile','episode','task','knowledge'])assert.ok(kinds.has(kind as any),kind);
 }finally{await f.close();}
});

test('expired records stop recall and surface in the review queue',async()=>{
 const f=fixture();try{
  const past=new Date(Date.now()-86400000).toISOString();
  const record=await save(f,{kind:'fact',content:'已过期的事实：旧端口 8080',expiresAt:past});
  assert.equal(f.now.search({query:'旧端口'},f.ctx).length,0);
  await f.now.settled(f.ctx);
  const queue=await f.now.dispatch('review.list',{status:'open'},f.ctx) as any;
  assert.ok(queue.reviews.some((row:any)=>row.memory_id===record.id&&row.reason==='expired'));
  const resolved=await f.now.dispatch('review.resolve',{id:queue.reviews.find((row:any)=>row.memory_id===record.id).id,action:'confirm'},f.ctx) as any;
  assert.equal(resolved.review.status,'resolved');assert.equal(resolved.record.reviewAfter!==undefined,true);
  const still=await f.now.dispatch('review.list',{status:'open'},f.ctx) as any;
  assert.ok(!still.reviews.some((row:any)=>row.memory_id===record.id));
 }finally{await f.close();}
});

test('profile extraction without user authority stays a candidate while explicit user profile is active',async()=>{
 const f=fixture();try{
  f.items[0].text='我习惯用中文解释，回答尽量简洁。';f.reply([{type:'profile',title:'用户表达习惯',content:'用户习惯中文解释并偏好简洁回答',conditions:['长期'],sourceEntryIds:['user1'],sourceQuotes:{user1:'我习惯用中文解释，回答尽量简洁。'}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const generated=snapshot(f).candidates.find((record:MemoryRecord)=>record.kind==='profile');
  assert.ok(generated,'informational model profile variant is retained as candidate');
  assert.equal(generated.status,'candidate');
  const explicit=await save(f,{kind:'profile',scope:'personal',content:'用户长期偏好中文简洁解释'});
  assert.equal(explicit.status,'active');assert.equal(explicit.trust,'user_explicit');
 }finally{await f.close();}
});

test('learning publishes an episode kind with expansion TTL through the kind gate',async()=>{
 const f=fixture();try{
  const quote='记忆系统 P1 验收已完成，Dream 回滚可用性已确认。';
  f.items[0].text=quote;f.reply([{type:'episode',title:'P1 验收情节',content:'记忆系统 P1 验收完成，Dream 回滚已确认可用',conditions:['会话 s'],sourceEntryIds:['user1'],sourceQuotes:{user1:quote}}]);
  await f.now.settled(f.ctx);await drain(f.now,f.ctx);
  const episode=snapshot(f).memories.find((record:MemoryRecord)=>record.kind==='episode'&&record.content.includes('P1 验收')) as MemoryRecord|undefined;
  assert.ok(episode,'episode auto-published under standard');
  assert.equal(episode.status,'active');assert.ok(episode.expiresAt);assert.deepEqual(episode.conditions,['会话 s']);
 }finally{await f.close();}
});

test('working.capture seeds episode and task deterministically from a working field',async()=>{
 const f=fixture();try{
  f.push('goal-sub','目标：完成记忆 P1 验收。');f.push('constraint-sub','本项目必须保留 UTF-8 编码。');
  const ref=await f.now.dispatch('source.read',{source:{sessionId:'s',entryId:'goal-sub',start:0,end:5,hash:(await import('../../core/src/index.js')).digest('目标：完成')}},f.ctx).catch(()=>undefined);
  void ref;
  const entry=f.items[1]!;const field={goal:{text:'完成记忆 P1 验收',sources:[{sessionId:'s',entryId:'goal-sub',start:0,end:6,hash:(await import('../../core/src/index.js')).digest(entry.text.slice(0,6))}]},constraints:[{text:'保留 UTF-8 编码',sources:[{sessionId:'s',entryId:'constraint-sub',start:0,end:8,hash:(await import('../../core/src/index.js')).digest(f.items[2]!.text.slice(0,8))}]}],decisions:[],unfinished:[{text:'继续 Dream v2 验收',sources:[]}]};
  const captured=await f.now.dispatch('working.capture',{field},f.ctx) as any;
  assert.equal(captured.created.length,2,'episode and task seeds are created');
  const records=snapshot(f).memories as MemoryRecord[];
  const episode=records.find(record=>record.kind==='episode'),task=records.find(record=>record.kind==='task');
  assert.ok(episode&&task);assert.equal(episode!.status,'active');assert.equal(task!.status,'active');
  assert.ok(episode!.expiresAt&&task!.expiresAt);
  const again=await f.now.dispatch('working.capture',{field},f.ctx) as any;
  assert.deepEqual(again,{created:[],skipped:'already-captured'});
 }finally{await f.close();}
});

test('Dream archives expired records with audit lineage and rollback restores them',async()=>{
 const f=fixture();try{
  const past=new Date(Date.now()-86400000).toISOString();
  const expired=await save(f,{kind:'fact',content:'Dream 归档目标：旧配置值',expiresAt:past});
  const dry=await f.now.dispatch('dream.run',{dryRun:true},f.ctx) as any;
  assert.ok(Array.isArray(dry.plan.operations)&&dry.plan.operations.some((operation:any)=>operation.kind==='archive'));
  assert.equal((await f.now.dispatch('read',{id:expired.id},f.ctx) as MemoryRecord).status,'active','dry-run applies nothing');
  const applied=await f.now.dispatch('dream.run',{},f.ctx) as any;
  assert.ok(applied.consolidationId);assert.ok(applied.applied.includes('archive'));
  assert.equal((await f.now.dispatch('read',{id:expired.id},f.ctx) as MemoryRecord).status,'inactive');
  const consolidations=snapshot(f).consolidations as any[];
  assert.ok(consolidations.some(row=>row.id===applied.consolidationId));
  const rolled=await f.now.dispatch('consolidation.rollback',{consolidationId:applied.consolidationId},f.ctx) as any;
  assert.ok(rolled.restored.includes(expired.id));
  assert.equal((await f.now.dispatch('read',{id:expired.id},f.ctx) as MemoryRecord).status,'active');
  const second=await f.now.dispatch('consolidation.rollback',{consolidationId:applied.consolidationId},f.ctx) as any;
  assert.deepEqual(second,{restored:[],revoked:[]});
 }finally{await f.close();}
});

test('user merge/split/supersede keep lineage and stay rollback-capable',async()=>{
 const f=fixture();try{
  const left=await save(f,{kind:'experience',title:'串行写入 A',content:'写操作必须串行 A',conditions:['仅测试']});
  const right=await save(f,{kind:'experience',title:'串行写入 B',content:'写操作必须串行 B',conditions:['仅生产']});
  const merged=await f.now.dispatch('merge',{leftId:left.id,rightId:right.id,content:'写操作必须串行，测试与生产都要遵守'},f.ctx) as MemoryRecord;
  assert.equal(merged.status,'active');assert.deepEqual([...merged.parentIds].sort(),[left.id,right.id].sort());
  assert.equal((await f.now.dispatch('read',{id:left.id},f.ctx) as MemoryRecord).status,'inactive');
  f.push('split-a','规则一：先读目录。');f.push('split-b','规则二：再读正文。');
  const splitSources=[{sessionId:'s',entryId:'split-a'},{sessionId:'s',entryId:'split-b'}];
  const parent=await save(f,{kind:'knowledge',title:'双主张',content:'规则一：先读目录。规则二：再读正文。',sources:splitSources});
  const parts=await f.now.dispatch('split',{id:parent.id,parts:[{title:'规则一',content:'先读目录',sources:[splitSources[0]]},{title:'规则二',content:'再读正文',sources:[splitSources[1]]}]},f.ctx) as MemoryRecord[];
  assert.equal(parts.length,2);assert.ok(parts.every(part=>part.status==='active'));assert.ok(parts.every(part=>part.parentIds.includes(parent.id)));
  assert.equal((await f.now.dispatch('read',{id:parent.id},f.ctx) as MemoryRecord).status,'inactive');
  const old=await save(f,{kind:'fact',content:'旧值：端口 8080'});const next=await save(f,{kind:'fact',content:'新值：端口 9090'});
  const superseded=await f.now.dispatch('supersede',{oldId:old.id,newId:next.id},f.ctx) as any;
  assert.equal(superseded.superseded,old.id);assert.equal((await f.now.dispatch('read',{id:old.id},f.ctx) as MemoryRecord).status,'inactive');
 }finally{await f.close();}
});

test('import defaults to candidates with external trust and never bypasses recall gates',async()=>{
 const f=fixture();try{
  const imported=await f.now.dispatch('import',{records:[{kind:'fact',title:'导入事实',content:'导入的结论必须复核'}]},f.ctx) as any;
  assert.equal(imported.imported.length,1);
  const record=await f.now.dispatch('read',{id:imported.imported[0]},f.ctx) as MemoryRecord;
  assert.equal(record.status,'candidate');assert.equal(record.trust,'external_import');
  assert.equal(f.now.search({query:'导入的结论'},f.ctx).length,0);
 }finally{await f.close();}
});

test('pin/unpin uses the stable prefix budget and kind eligibility',async()=>{
 const f=fixture();try{
  const fact=await save(f,{kind:'fact',content:'置顶事实：部署目录是 /srv/friend'});
  const pinned=await f.now.dispatch('pin',{id:fact.id,revision:fact.revision},f.ctx) as MemoryRecord;
  assert.equal(pinned.pinned,true);assert.ok(pinned.pinnedAt);
  assert.equal((snapshot(f).pinned as any[]).length,1);
  f.push('query','部署目录在哪里', 'user');
  const recall=f.now.recall({...f.ctx,history:()=>f.items})!;
  assert.match(recall.content,/置顶记忆/);assert.match(recall.content,/\/srv\/friend/);
  const episode=await save(f,{kind:'episode',content:'不能置顶的情节',conditions:['会话 s']});
  await assert.rejects(f.now.dispatch('pin',{id:episode.id,revision:episode.revision},f.ctx),/不能置顶/);
  const unpinned=await f.now.dispatch('unpin',{id:fact.id},f.ctx) as MemoryRecord;
  assert.equal(unpinned.pinned,false);assert.equal((snapshot(f).pinned as any[]).length,0);
 }finally{await f.close();}
});

test('graph exposes lineage, subject and conflict edges',async()=>{
 const f=fixture();try{
  const parent=await save(f,{kind:'fact',subject:'project.db.engine',content:'数据库使用 SQLite'});
  const child=await save(f,{kind:'experience',parentIds:[parent.id],content:'SQLite 之下先验证 WAL'});
  const graph=await f.now.dispatch('graph',{rootId:parent.id},f.ctx) as any;
  assert.ok(graph.nodes.some((node:any)=>node.id===parent.id));assert.ok(graph.nodes.some((node:any)=>node.id===child.id));
  assert.ok(graph.edges.some((edge:any)=>edge.from===parent.id&&edge.to===child.id&&edge.kind==='derived-from'));
  const subjects=await f.now.dispatch('graph',{subjectKey:'project.db.engine'},f.ctx) as any;
  assert.ok(subjects.nodes.length>=1);
 }finally{await f.close();}
});

test('search.explain reports intent, features, reasons and zero-hit guidance',async()=>{
 const f=fixture();try{
  await save(f,{kind:'fact',content:'构建命令使用 npm run build'});
  const explain=await f.now.dispatch('search.explain',{query:'构建命令'},f.ctx) as any;
  assert.equal(explain.ruleVersion,3);assert.ok(explain.intent);
  assert.ok(explain.matches[0].features&&typeof explain.matches[0].features.bm25==='number');
  assert.ok(Array.isArray(explain.matches[0].reasons)&&explain.matches[0].reasons.length>0);
  const zero=await f.now.dispatch('search.explain',{query:'完全不存在的术语xyzzy'},f.ctx) as any;
  assert.equal(zero.matches.length,0);assert.match(String(zero.zeroHitGuidance),/零命中|关键词/);
 }finally{await f.close();}
});

test('usage and feedback backfill counters without changing record revisions',async()=>{
 const f=fixture();try{
  const record=await save(f,{kind:'fact',content:'用量回填事实：日志格式是 JSON'});
  f.push('q1','日志格式是什么');f.now.beginRun(f.ctx);const recall=f.now.recall(f.ctx)!;assert.ok(recall);f.now.observeContext([{content:recall.content}],f.ctx);
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(f.dir,'plugins.sqlite'),{readOnly:true});
  try{const row=db.prepare('SELECT use_count,last_used_at,revision FROM memory_records WHERE id=?').get(record.id) as {use_count:number;last_used_at:string|null;revision:number};
    assert.ok(Number(row.use_count)>=1);assert.ok(row.last_used_at);assert.equal(Number(row.revision),record.revision);
    const after=await f.now.dispatch('read',{id:record.id},f.ctx) as MemoryRecord;
    await f.now.dispatch('feedback',{id:record.id,revision:after.revision,kind:'relevant',taskContext:{goal:'日志格式'}},f.ctx);
    const scored=db.prepare('SELECT feedback_score FROM memory_records WHERE id=?').get(record.id) as {feedback_score:number};
    assert.ok(Number(scored.feedback_score)>0);
    assert.equal((await f.now.dispatch('read',{id:record.id},f.ctx) as MemoryRecord).revision,after.revision,'metadata backfill does not bump revision');
  }finally{db.close();}
 }finally{await f.close();}
});

test('dream consolidations remain visible in snapshot and learning jobs still complete',async()=>{
 const f=fixture();try{
  const past=new Date(Date.now()-86400000).toISOString();
  await save(f,{kind:'fact',content:'巩固可见性事实 A',expiresAt:past});
  await f.now.dispatch('dream.run',{},f.ctx);
  const jobs=snapshot(f).learning.jobs as LearningJob[];
  assert.ok(Array.isArray(jobs));
  assert.ok((snapshot(f).consolidations as any[]).length>=1);
  assert.equal(snapshot(f).schemaVersion,5);
 }finally{await f.close();}
});
