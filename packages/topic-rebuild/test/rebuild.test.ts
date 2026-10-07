import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionBeforeCompactEvent, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { RebuildController, type WorkingField } from '../src/index.js';
import { historyItems, type HistoryItem, type PluginContext } from '../../core/src/index.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-rebuild-'));
  const originals:Record<string,unknown>[]=[]; const canonical:Record<string,unknown>[]=[];
  let idle=true; let compactCalls=0;
  function add(id:string,role:string,content:string) {
    const entry={id,parentId:canonical.at(-1)?.id||null,type:'message',timestamp:new Date().toISOString(),message:{role,content:[{type:'text',text:content}]}};
    originals.push(entry); canonical.push(entry);
  }
  add('u1','user','实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
  add('a1','assistant','决定采用SQLite WAL。');
  add('u2','user','现在讨论UI颜色，选择蓝色侧栏。');
  add('a2','assistant','已确认蓝色侧栏。');
  add('u3','user','下一步回到数据库：修复服务端事务，完成后检查原始文件。');
  add('a3','assistant','事务修复已完成，等待完整验证。');
  const events:{event:string;data:unknown}[]=[];
  const ctx:PluginContext={
    dataDir:dir,projectDir:dir,projectId:'project-a',sessionId:'session-a',origin:'user',
    isIdle:()=>idle,history:()=>historyItems(canonical),
    readSource(source) { if(this.projectId!=='project-a' || source.sessionId!=='session-a') throw new Error('来源不属于当前项目');const item=historyItems(originals).find(item=>item.id===source.entryId);if(!item) throw new Error('来源已丢失');return item; },
    complete:async()=>JSON.stringify({goal:{text:'修复数据库事务并检查原始文件',sourceEntryIds:['u3']},constraints:[],decisions:[{text:'采用SQLite WAL',sourceEntryIds:['a1']}],unfinished:[{text:'完整验证尚未完成',sourceEntryIds:['u3','a3']}],topics:[{label:'数据库',summary:'数据库事务需要完整验证。',sourceEntryIds:['u3','a3']}]}),
    request:async()=>{throw new Error('Memory not installed');},emit:(event,data)=>events.push({event,data}),notify:()=>{},
    appendEntry:(customType,data)=>{canonical.push({id:`custom-${canonical.length}`,parentId:canonical.at(-1)?.id||null,type:'custom',customType,data,timestamp:new Date().toISOString()});},
  };
  const create=()=>new RebuildController({entries:()=>canonical,compact:()=>{compactCalls++;},contextWindow:()=>32000});
  const event=(signal:AbortSignal=new AbortController().signal)=>({
    type:'session_before_compact',branchEntries:[...canonical],reason:'manual',willRetry:false,signal,
    preparation:{firstKeptEntryId:'u3',tokensBefore:12000,settings:{enabled:true,reserveTokens:1024,keepRecentTokens:2048},messagesToSummarize:[],turnPrefixMessages:[],isSplitTurn:false,fileOps:{read:new Set(),edited:new Set()}},
  } as unknown as SessionBeforeCompactEvent);
  const appendDraft=(draft:SessionBoundaryDraft)=>{assert.equal(draft.type,'custom');if(draft.type==='custom') ctx.appendEntry(draft.customType,draft.data);};
  const appendCompaction=(result:{summary:string;firstKeptEntryId:string;details?:unknown})=>{
    const entry={id:`compact-${canonical.length}`,parentId:canonical.at(-1)?.id||null,type:'compaction',timestamp:new Date().toISOString(),...result};canonical.push(entry);return entry;
  };
  return {dir,ctx,originals,canonical,events,add,event,create,appendDraft,appendCompaction,compactCalls:()=>compactCalls,setIdle:(value:boolean)=>{idle=value;},cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('checkpoint adoption requires a canonical custom entry and retains early constraints',()=>{
  const f=fixture();const c=f.create();
  try {
    const draft=c.checkpointDraft(f.ctx)!;assert.equal(c.snapshot(f.ctx).field,undefined);
    f.appendDraft(draft);const field=c.confirmCanonical(f.ctx)!;
    assert.equal(field.revision,1);assert.equal(field.coveredThroughId,'a3');
    assert.match(field.constraints.map(point=>point.text).join('\n'),/保留用户原始文件/);
    assert.equal(c.checkpointDraft(f.ctx),undefined);
    f.add('u4','user','仅检查事务结果，暂不修改UI。');f.add('a4','assistant','开始检查。');
    const next=c.checkpointDraft(f.ctx)!;f.appendDraft(next);const updated=c.confirmCanonical(f.ctx)!;
    assert.equal(updated.revision,2);assert.match(updated.constraints.map(point=>point.text).join('\n'),/不要并行/);
  } finally {c.dispose();f.cleanup();}
});
test('context settings are user-owned and source reads enforce current project access',async()=>{
  const f=fixture();const c=f.create();
  try {
    await assert.rejects(c.dispatch('settings',{enabled:false},{...f.ctx,origin:'agent'}),/用户/);
    await assert.rejects(c.dispatch('settings',{enabled:false},{...f.ctx,origin:'plugin'}),/用户/);
    assert.equal(c.snapshot(f.ctx).enabled,true);
    await c.dispatch('settings',{enabled:false},f.ctx);assert.equal(c.snapshot(f.ctx).enabled,false);
    await assert.rejects(c.dispatch('history.read',{id:'u1',sessionId:'foreign-session'},f.ctx),/来源不属于当前项目/);
    await assert.rejects(c.dispatch('history.read',{id:'u1'},{...f.ctx,projectId:'other-project'}),/来源不属于当前项目/);
    await assert.rejects(c.dispatch('history.read',{id:'../../auth.json'},f.ctx),/来源已丢失/);
    const original=await c.dispatch('history.read',{id:'u1'},f.ctx) as {item:HistoryItem};assert.match(original.item.text,/用户原始文件/);
  }finally{c.dispose();f.cleanup();}
});
test('source suppression ignores other projects and requires body identity for cloned short IDs',()=>{
  const f=fixture();const c=f.create();
  try {
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);c.confirmCanonical(f.ctx);
    c.memoryInvalidated({projectId:'other-project',ids:['other'],sources:[{sessionId:'session-a',entryId:'u1'}]},f.ctx);assert.equal(c.snapshot(f.ctx).invalidated,false);
    c.memoryInvalidated({projectId:'project-a',ids:['old'],sources:[{sessionId:'session-a',entryId:'u1'}]},f.ctx);
    const clone={...f.ctx,sessionId:'cloned-session',readSource:(source:{sessionId:string;entryId:string})=>{const item=historyItems(f.originals).find(item=>item.id===source.entryId);if(!item)throw new Error('missing');return item;}};
    const cloned=c.checkpointDraft(clone)!;assert.equal(cloned.type,'custom');if(cloned.type==='custom'){const field=cloned.data as WorkingField;assert.equal(field.constraints.some(point=>point.sources.some(source=>source.entryId==='u1')),false);}
    const different={...clone,sessionId:'unrelated-session',history:()=>[{id:'u1',parentId:null,type:'message',role:'user',timestamp:'new',text:'必须采用另一条有效约束。'}],readSource:()=>({id:'u1',parentId:null,type:'message',role:'user',timestamp:'new',text:'必须采用另一条有效约束。'})};
    const unrelated=c.checkpointDraft(different)!;assert.equal(unrelated.type,'custom');if(unrelated.type==='custom')assert.match((unrelated.data as WorkingField).constraints[0].text,/有效约束/);
  }finally{c.dispose();f.cleanup();}
});
test('canonical user correction survives compaction, later checkpoints and cold reconstruction',async()=>{
  const f=fixture();let c=f.create();
  try {
    f.add('old-colour','user','必须使用蓝色侧栏。');const before=c.checkpointDraft(f.ctx)!;f.appendDraft(before);c.confirmCanonical(f.ctx);
    f.add('colour-correction','user','更正：不再使用蓝色侧栏，必须改为绿色侧栏。');
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'更正侧栏颜色',sourceEntryIds:['colour-correction']},constraints:[{text:'必须使用蓝色侧栏。',sourceEntryIds:['old-colour']},{text:'必须改为绿色侧栏。',sourceEntryIds:['colour-correction']}],decisions:[],unfinished:[],topics:[],supersededSources:[{entryId:'old-colour',byEntryId:'colour-correction'}]});
    const compacted=await c.beforeCompact(f.event(),f.ctx);assert.ok(compacted?.compaction);f.appendCompaction(compacted.compaction);const adopted=c.confirmCanonical(f.ctx)!;
    assert.equal(adopted.constraints.some(point=>point.sources.every(source=>source.entryId==='old-colour')),false);assert.equal(adopted.supersededSources?.[0].source.entryId,'old-colour');
    f.add('continued-work','user','继续检查，务必保留现有文件。');const checkpoint=c.checkpointDraft(f.ctx)!;f.appendDraft(checkpoint);const updated=c.confirmCanonical(f.ctx)!;assert.equal(updated.constraints.some(point=>point.sources.every(source=>source.entryId==='old-colour')),false);assert.match(updated.constraints.map(point=>point.text).join('\n'),/绿色/);assert.match(updated.constraints.map(point=>point.text).join('\n'),/保留用户原始文件/);
    c.dispose();c=f.create();const restored=c.snapshot(f.ctx).field as WorkingField;assert.equal(restored.supersededSources?.[0].source.entryId,'old-colour');
    f.add('after-cold','user','不要丢失用户约束。');const coldCheckpoint=c.checkpointDraft(f.ctx)!;f.appendDraft(coldCheckpoint);const coldField=c.confirmCanonical(f.ctx)!;assert.equal(coldField.constraints.some(point=>point.sources.every(source=>source.entryId==='old-colour')),false);
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'继续检查用户约束',sourceEntryIds:['after-cold']},constraints:[{text:'必须使用蓝色侧栏。',sourceEntryIds:['old-colour']}],decisions:[],unfinished:[],topics:[]});
    const again=await c.beforeCompact(f.event(),f.ctx);assert.ok(again?.compaction);f.appendCompaction(again.compaction);const repeated=c.confirmCanonical(f.ctx)!;assert.equal(repeated.constraints.some(point=>point.sources.every(source=>source.entryId==='old-colour')),false);assert.equal(repeated.supersededSources?.length,1);
  }finally{c.dispose();f.cleanup();}
});

test('native compaction preserves retained tail and early rules, recent other-topic sources',async()=>{
  const f=fixture();const c=f.create();
  try {
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);c.confirmCanonical(f.ctx);
    const before=c.snapshot(f.ctx).field as WorkingField;
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);
    assert.equal(result.compaction.firstKeptEntryId,'u3');
    assert.match(result.compaction.summary,/保留用户原始文件/);
    assert.match(result.compaction.summary,/不要并行写入数据库/);
    assert.match(result.compaction.summary,/蓝色侧栏/);assert.match(result.compaction.summary,/session-a\/u2/);
    assert.equal((c.snapshot(f.ctx).field as WorkingField).revision,before.revision);
    f.appendCompaction(result.compaction);const applied=c.confirmCanonical(f.ctx)!;
    assert.equal(applied.revision,before.revision+1);assert.equal(applied.compactedThroughId,'a2');
    assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'applied');
  } finally {c.dispose();f.cleanup();}
});

test('identical summaries adopt by unique operation identity, not summary or event entry',async()=>{
  const f=fixture();const c=f.create();
  try {
    const first=await c.beforeCompact(f.event(),f.ctx);assert.ok(first?.compaction);
    f.appendCompaction(first.compaction);const field1=c.confirmCanonical(f.ctx)!;
    const second=await c.beforeCompact(f.event(),f.ctx);assert.ok(second?.compaction);
    assert.equal(first.compaction.summary,second.compaction.summary);
    const secondEntry=f.appendCompaction(second.compaction);const field2=c.confirmCanonical(f.ctx)!;
    assert.notEqual(field1.operationId,field2.operationId);
    assert.equal(field2.operationId,(secondEntry.details as {friendPiRebuild:WorkingField}).friendPiRebuild.operationId);
    assert.equal(field2.revision,field1.revision+1);
  } finally {c.dispose();f.cleanup();}
});

test('provider success without canonical save cannot advance coverage; failure preserves previous field',async()=>{
  const f=fixture();const c=f.create();
  try {
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);c.confirmCanonical(f.ctx);
    const previous=c.snapshot(f.ctx).field as WorkingField;
    const candidate=await c.beforeCompact(f.event(),f.ctx);assert.ok(candidate?.compaction);
    assert.equal(c.confirmCanonical(f.ctx),undefined);
    c.compactFailed(f.ctx,'fake journal write failed');
    assert.equal((c.snapshot(f.ctx).field as WorkingField).operationId,previous.operationId);
    assert.equal((c.snapshot(f.ctx).field as WorkingField).coveredThroughId,previous.coveredThroughId);
    assert.match((c.snapshot(f.ctx).status as {error:string}).error,/journal/);
  } finally {c.dispose();f.cleanup();}
});

test('new inputs during asynchronous rebuilding stay outside the captured watermark and inside Pi tail',async()=>{
  const f=fixture();const c=f.create();let finish!:()=>void;let started!:()=>void;
  const start=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{finish=resolve;});
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{started();await gate;return complete(...args);};
    const rebuilding=c.beforeCompact(f.event(),f.ctx);await start;
    f.add('new-user','user','新增硬约束：输出必须为中文。');f.add('new-reply','assistant','收到新增要求。');
    finish();const result=await rebuilding;assert.ok(result?.compaction);
    assert.equal(result.compaction.firstKeptEntryId,'u3');
    f.appendCompaction(result.compaction);const field=c.confirmCanonical(f.ctx)!;
    assert.equal(field.coveredThroughId,'a3');
    assert.equal(field.sources.some(source=>source.entryId==='new-user'),false);
    const kept=f.canonical.slice(f.canonical.findIndex(entry=>entry.id===result.compaction!.firstKeptEntryId));
    assert.equal(kept.some(entry=>entry.id==='new-user'),true);
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);const next=c.confirmCanonical(f.ctx)!;
    assert.match(next.constraints.map(point=>point.text).join('\n'),/输出必须为中文/);
  } finally {finish();c.dispose();f.cleanup();}
});

test('a changed or missing captured origin falls back without advancing the field',async()=>{
  const f=fixture();const c=f.create();
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{
      const output=await complete(...args);(f.originals[0]!.message as {content:{text:string}[]}).content[0]!.text='原始内容被改写';return output;
    };
    assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    assert.equal(c.snapshot(f.ctx).field,undefined);
    assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'fallback');
  } finally {c.dispose();f.cleanup();}
});

test('memory invalidation survives restart and cannot be cleared by a shallow checkpoint',async()=>{
  const f=fixture();let c=f.create();
  try {
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);c.confirmCanonical(f.ctx);
    c.memoryInvalidated({ids:['memory-old'],revision:2,reason:'corrected'},f.ctx);
    assert.equal(c.snapshot(f.ctx).invalidated,true);c.dispose();c=f.create();
    assert.equal(c.snapshot(f.ctx).invalidated,true);
    f.add('u4','user','继续验证事务。');assert.equal(c.checkpointDraft(f.ctx),undefined);
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'继续验证事务',sourceEntryIds:['u4']},constraints:[],decisions:[],unfinished:[],topics:[]});
    c.settled(f.ctx);assert.equal(f.compactCalls(),1);
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);
    f.appendCompaction(result.compaction);c.confirmCanonical(f.ctx);
    assert.equal(c.snapshot(f.ctx).invalidated,false);
  } finally {c.dispose();f.cleanup();}
});

test('cancel, missing model, malformed output and insufficient budget fall back to Pi',async()=>{
  const f=fixture();let c=f.create();
  try {
    const signal=new AbortController();signal.abort();assert.equal(await c.beforeCompact(f.event(signal.signal),f.ctx),undefined);
    f.ctx.complete=async()=>{throw new Error('请先配置模型');};assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    f.ctx.complete=async()=>'{invalid json';assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    c.dispose();c=new RebuildController({entries:()=>f.canonical,contextWindow:()=>500});
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'数据库事务',sourceEntryIds:['u3']},constraints:[],decisions:[],unfinished:[],topics:[]});
    assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    assert.equal(c.snapshot(f.ctx).field,undefined);
  } finally {c.dispose();f.cleanup();}
});

test('history search/read/around return original entries with project boundaries and hashed index',async()=>{
  const f=fixture();const c=f.create();
  try {
    const hits=await c.dispatch('history.search',{query:'数据库'},f.ctx) as {source:{entryId:string};item:HistoryItem}[];
    assert.equal(hits.some(hit=>hit.source.entryId==='u1'),true);
    const short=await c.dispatch('history.search',{query:'蓝'},f.ctx) as unknown[];assert.equal(short.length>0,true);
    const read=await c.dispatch('history.read',{id:'u1'},f.ctx) as {item:HistoryItem};assert.match(read.item.text,/保留用户原始文件/);
    const around=await c.dispatch('history.around',{id:'u2',radius:1},f.ctx) as {item:HistoryItem}[];
    assert.deepEqual(around.map(row=>row.item.id),['a1','u2','a2']);
    const other={...f.ctx,projectId:'project-b',history:()=>[]};
    assert.deepEqual(await c.dispatch('history.search',{query:'数据库'},other),[]);
    await assert.rejects(c.dispatch('history.read',{id:'u1'},other),/不属于/);
    const db=new DatabaseSync(join(f.dir,'plugins.sqlite'));
    const terms=db.prepare('SELECT terms FROM rebuild_history_search').all().map(row=>String(row.terms));
    assert.equal(terms.some(value=>value.includes('数据库')),false);assert.match(terms[0]!,/[a-f0-9]{64}/);db.close();
  } finally {c.dispose();f.cleanup();}
});

test('standalone operation has no Memory dependency; manual request requires actual bound idle compact',async()=>{
  const f=fixture();const c=f.create();
  try {
    assert.equal(await c.recall(f.ctx),undefined);
    await c.dispatch('rebuild',{},f.ctx);assert.equal(f.compactCalls(),1);
    await assert.rejects(c.dispatch('rebuild',{},f.ctx),/已在进行/);
    c.compactFailed(f.ctx,'cancelled');f.setIdle(false);
    await assert.rejects(c.dispatch('rebuild',{},f.ctx),/等待/);
    const unbound=new RebuildController();f.setIdle(true);
    await assert.rejects(unbound.dispatch('rebuild',{},f.ctx),/未绑定/);unbound.dispose();
  } finally {c.dispose();f.cleanup();}
});

test('temporary recall excludes candidates, stays out of persistent summary, and drops stale results',async()=>{
  const f=fixture();const c=f.create();
  try {
    f.ctx.request=async(_plugin,_action,input)=>{assert.equal(input?.match,'any');return [{id:'m1',revision:1,status:'active',enabled:true,content:'有效项目方法'},{id:'m2',revision:1,status:'candidate',enabled:true,content:'未经验证猜测'}];};
    const recalled=await c.recall(f.ctx);assert.match(recalled!,/有效项目方法/);assert.doesNotMatch(recalled!,/未经验证/);
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);assert.doesNotMatch(result.compaction.summary,/有效项目方法/);
    f.ctx.request=async()=>{c.memoryInvalidated({ids:['m1']},f.ctx);return [{id:'m1',revision:1,status:'active',enabled:true,content:'过时版本'}];};
    assert.equal(await c.recall(f.ctx),undefined);
  } finally {c.dispose();f.cleanup();}
});

test('rejected boundary drafts clear pending at real settlement instead of keeping the UI busy',async()=>{
  const f=fixture();const c=f.create();
  try {
    assert.ok(c.checkpointDraft(f.ctx));
    assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'awaiting-adoption');
    c.settled(f.ctx);
    assert.equal(c.snapshot(f.ctx).field,undefined);
    assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'fallback');
    assert.equal((c.snapshot(f.ctx).status as {pendingOperationId?:string}).pendingOperationId,undefined);
    await c.dispatch('rebuild',{},f.ctx);assert.equal(f.compactCalls(),1);
  } finally {c.dispose();f.cleanup();}
});

test('disabled rebuilding preserves history lookup and avoids model or optional Memory calls',async()=>{
  const f=fixture();const c=f.create();let calls=0;
  try {
    f.ctx.complete=async()=>{calls++;throw new Error('must not call');};
    f.ctx.request=async()=>{calls++;throw new Error('must not call');};
    await c.dispatch('settings',{enabled:false},f.ctx);
    assert.equal(c.checkpointDraft(f.ctx),undefined);
    assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    assert.equal(await c.recall(f.ctx),undefined);assert.equal(calls,0);
    const read=await c.dispatch('history.read',{id:'u1'},f.ctx) as {item:HistoryItem};assert.match(read.item.text,/必须保留/);
  } finally {c.dispose();f.cleanup();}
});

test('mixed Latin/CJK originals generate separate hashed tokens instead of one swallowed run',async()=>{
  const f=fixture();const c=f.create();
  try {
    f.add('u4','user','SQLite事务WAL写入 APIメモリ SQL고객정보');
    const chinese=await c.dispatch('history.search',{query:'事务 WAL'},f.ctx) as {source:{entryId:string}}[];
    assert.equal(chinese[0]?.source.entryId,'u4');
    const japanese=await c.dispatch('history.search',{query:'メモリ API'},f.ctx) as {source:{entryId:string}}[];
    assert.equal(japanese[0]?.source.entryId,'u4');
    const korean=await c.dispatch('history.search',{query:'고객 SQL'},f.ctx) as {source:{entryId:string}}[];
    assert.equal(korean[0]?.source.entryId,'u4');
    const other={...f.ctx,projectId:'project-b',history:()=>[]};
    assert.deepEqual(await c.dispatch('history.search',{query:'事务 WAL'},other),[]);
  } finally {c.dispose();f.cleanup();}
});
