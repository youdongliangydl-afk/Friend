import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SessionBeforeCompactEvent, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { RebuildController, type WorkingField } from '../src/index.js';
import { historyItems, sourceFactRefs, digest, RecordStore, type HistoryItem, type PluginContext } from '../../core/src/index.js';

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
  const create=(infinite=true)=>{const controller=new RebuildController({entries:()=>canonical,compact:()=>{compactCalls++;},contextWindow:()=>32000});if(infinite)void controller.dispatch('settings',{mode:'infinite'},ctx);return controller;};
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
    c.memoryInvalidated({v:2,projectId:'project-a',ids:['old'],reason:'corrected',sources:[sourceFactRefs(historyItems(f.originals)[0]!,'session-a')[1]!]},f.ctx);
    const clone={...f.ctx,sessionId:'cloned-session',readSource:(source:{sessionId:string;entryId:string})=>{const item=historyItems(f.originals).find(item=>item.id===source.entryId);if(!item)throw new Error('missing');return item;}};
    const cloned=c.checkpointDraft(clone)!;assert.equal(cloned.type,'custom');if(cloned.type==='custom'){const field=cloned.data as WorkingField;assert.equal(field.constraints.some(point=>point.text.includes('必须保留用户原始文件')),false);assert.ok(field.constraints.some(point=>point.text.includes('不要并行写入数据库')));}
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
    const signal=new AbortController();signal.abort();assert.deepEqual(await c.beforeCompact(f.event(signal.signal),f.ctx),{cancel:true});
    f.ctx.complete=async()=>{throw new Error('请先配置模型');};assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    f.ctx.complete=async()=>'{invalid json';assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    c.dispose();c=new RebuildController({entries:()=>f.canonical,contextWindow:()=>500});await c.dispatch('settings',{mode:'infinite'},f.ctx);
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

test('compact selects memory once and records exact revision/hash/source without normal-turn recall',async()=>{
  const f=fixture();const c=f.create();let selections=0;let completions=0;
  const source=sourceFactRefs(historyItems(f.originals)[0]!,'session-a')[1]!;
  const semantic={id:'m1',revision:7,content:'有效项目方法',conditions:['仅适用于本项目','验证通过后适用'],validFrom:null,validTo:null,scope:'project'};
  const record={...semantic,hash:digest(semantic.content),semanticDigest:digest(semantic),sources:[source],status:'active',enabled:true};
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(prompt,options)=>{completions++;assert.match(prompt,/有效项目方法/);return complete(prompt,options);};
    f.ctx.request=async(_plugin,action)=>{if(action==='invalidation.snapshot')return {projectId:'project-a',epoch:0,ids:[],sources:[]};if(action==='select'){selections++;return {records:[record],epoch:0};}if(action==='read')return record;throw new Error('unexpected action');};
    assert.equal(await c.recall(f.ctx),undefined);assert.equal(selections,0);
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);
    assert.equal(selections,1);assert.equal(completions,1);
    f.appendCompaction(result.compaction);const field=c.confirmCanonical(f.ctx)!;
    assert.deepEqual(field.memoryRefs,[{id:'m1',revision:7,hash:record.hash,sources:[source],conditions:record.conditions,validFrom:null,validTo:null,scope:'project',semanticDigest:record.semanticDigest}]);
    assert.doesNotMatch(result.compaction.summary,/有效项目方法/);
  }finally{c.dispose();f.cleanup();}
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

test('native is the default and legacy enabled never opts into infinite context',async()=>{
  const f=fixture();let c=f.create(false);let calls=0;
  try {
    f.ctx.complete=async()=>{calls++;throw new Error('unexpected model call');};f.ctx.request=async()=>{calls++;throw new Error('unexpected Memory call');};
    assert.equal(c.snapshot(f.ctx).mode,'native');assert.equal(c.checkpointDraft(f.ctx),undefined);assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);
    assert.deepEqual(await c.prepareDraft(f.ctx),{prepared:false});assert.equal(calls,0);
    const store=new RecordStore('topic-rebuild',f.dir);store.put('settings:project-a',{enabled:true});store.close();c.dispose();c=f.create(false);
    assert.equal(c.snapshot(f.ctx).mode,'native');assert.equal(c.checkpointDraft(f.ctx),undefined);assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);assert.equal(calls,0);
    await c.dispatch('settings',{mode:'infinite'},f.ctx);assert.equal(c.snapshot(f.ctx).mode,'infinite');assert.ok(c.checkpointDraft(f.ctx));
  }finally{c.dispose();f.cleanup();}
});

test('correcting one fact preserves an unrelated constraint in the same message across cold start',async()=>{
  const f=fixture();let c=f.create();
  try {
    f.add('two-facts','user','数据库必须使用 SQLite，必须保留 UTF-8 中文字段。');
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);c.confirmCanonical(f.ctx);
    const facts=sourceFactRefs(historyItems(f.originals).find(item=>item.id==='two-facts')!,'session-a');assert.equal(facts.length,2);
    c.memoryInvalidated({v:2,projectId:'project-a',ids:['db'],reason:'corrected',sources:[facts[0]]},f.ctx);
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'检查数据库和中文字段',sourceEntryIds:['two-facts']},constraints:[{text:'数据库必须使用 SQLite，',sourceFactIds:[facts[0]!.factId]},{text:'必须保留 UTF-8 中文字段。',sourceFactIds:[facts[1]!.factId]}],decisions:[],unfinished:[],topics:[]});
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);f.appendCompaction(result.compaction);const adopted=c.confirmCanonical(f.ctx)!;
    assert.equal(adopted.constraints.some(point=>point.text.includes('SQLite')),false);assert.ok(adopted.constraints.some(point=>point.text.includes('UTF-8')));
    c.dispose();c=f.create();f.add('later','user','继续验证，不要破坏项目文件。');const next=c.checkpointDraft(f.ctx)!;f.appendDraft(next);const cold=c.confirmCanonical(f.ctx)!;
    assert.equal(cold.constraints.some(point=>point.text.includes('数据库必须使用 SQLite')),false);assert.ok(cold.constraints.some(point=>point.text.includes('UTF-8')));
  }finally{c.dispose();f.cleanup();}
});

test('explicit conversational correction replaces its addressed fact at the settlement boundary',()=>{
  const f=fixture();const c=f.create();
  try {
    f.add('two-facts','user','数据库必须使用 SQLite，必须保留 UTF-8 中文字段。');const first=c.checkpointDraft(f.ctx)!;f.appendDraft(first);c.confirmCanonical(f.ctx);
    f.add('db-correction','user','更正：数据库必须改为 PostgreSQL。');const corrected=c.checkpointDraft(f.ctx)!;f.appendDraft(corrected);const field=c.confirmCanonical(f.ctx)!;
    assert.equal(field.constraints.some(point=>point.text.includes('数据库必须使用 SQLite')),false);assert.ok(field.constraints.some(point=>point.text.includes('UTF-8')));assert.ok(field.constraints.some(point=>point.text.includes('PostgreSQL')));
    assert.ok(field.constraints.some(point=>point.text.includes('不要并行写入数据库')),'backend correction must not retire the write safety rule');
  }finally{c.dispose();f.cleanup();}
});

test('legacy whole-entry invalidation never retires unrelated original facts',async()=>{
  const f=fixture();const c=f.create();
  try {
    f.add('two-facts','user','数据库必须使用 SQLite，必须保留 UTF-8 中文字段。');
    c.memoryInvalidated({projectId:'project-a',ids:['legacy'],reason:'corrected',sources:[{sessionId:'session-a',entryId:'two-facts'}]},f.ctx);
    f.ctx.complete=async()=>JSON.stringify({goal:{text:'检查中文字段',sourceEntryIds:['two-facts']},constraints:[],decisions:[],unfinished:[],topics:[]});
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);f.appendCompaction(result.compaction);const field=c.confirmCanonical(f.ctx)!;
    assert.ok(field.constraints.some(point=>point.text.includes('UTF-8')));assert.ok(field.constraints.some(point=>point.text.includes('SQLite')));
  }finally{c.dispose();f.cleanup();}
});

test('background draft stays out of Pi history and canonical coverage, then matching compact reuses it',async()=>{
  const f=fixture();const c=f.create();let models=0;
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{models++;return complete(...args);};
    const count=f.canonical.length;const prepared=await c.prepareDraft(f.ctx);assert.equal(prepared.prepared,true);assert.equal(models,1);
    assert.deepEqual(await c.prepareDraft(f.ctx),{prepared:false,operationId:prepared.operationId});assert.equal(models,1,'unchanged original history does not request another draft');
    assert.equal(f.canonical.length,count);assert.equal(c.snapshot(f.ctx).field,undefined);assert.equal(c.confirmCanonical(f.ctx),undefined);
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);assert.equal(models,1,'compact may reuse an exactly matching derived draft');
    assert.equal(c.snapshot(f.ctx).field,undefined);f.appendCompaction(result.compaction);const field=c.confirmCanonical(f.ctx)!;assert.ok(field.operationId);assert.notEqual(field.operationId,prepared.operationId);
  }finally{c.dispose();f.cleanup();}
});

test('a changed draft model or source requires fresh foreground preparation without awaiting a queue',async()=>{
  const f=fixture();const c=f.create();let calls=0;
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{calls++;return complete(...args);};await c.prepareDraft(f.ctx);assert.equal(calls,1);
    const result=await c.beforeCompact(f.event(),{...f.ctx,modelId:'new/model'});assert.ok(result?.compaction);assert.equal(calls,2);
  }finally{c.dispose();f.cleanup();}
});

test('persisted cross-process memory epoch fences canonical adoption even without a local event',async()=>{
  const f=fixture();const c=f.create();
  try {
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);
    const runtime=new RecordStore('runtime',f.dir);runtime.put('memory-source-epoch:project-a',{v:1,epoch:1});runtime.close();
    f.appendCompaction(result.compaction);assert.equal(c.confirmCanonical(f.ctx),undefined);assert.equal(c.snapshot(f.ctx).field,undefined);
    assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'fallback');
  }finally{c.dispose();f.cleanup();}
});

test('deleted session tombstone rejects a late prepared result and never advances canonical history',async()=>{
  const f=fixture();const c=f.create();
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{const result=await complete(...args);const sessions=new RecordStore('sessions',f.dir);sessions.put('tombstone:session-a',{deleted:true});sessions.close();return result;};
    assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);assert.equal(c.confirmCanonical(f.ctx),undefined);assert.equal(c.snapshot(f.ctx).field,undefined);
    assert.deepEqual(await c.prepareDraft(f.ctx),{prepared:false});
  }finally{c.dispose();f.cleanup();}
});

test('cancellation during the provider request returns cancel without emitting a fallback',async()=>{
  const f=fixture();const c=f.create();const abort=new AbortController();let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  try {
    f.ctx.complete=async(_prompt,options)=>{started();await new Promise((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});throw new Error('unreachable');};
    const pending=c.beforeCompact(f.event(abort.signal),f.ctx);await ready;abort.abort();assert.deepEqual(await pending,{cancel:true});
    assert.equal(f.events.some(event=>event.event==='topic-rebuild.fallback'),false);assert.equal(c.snapshot(f.ctx).field,undefined);
  }finally{abort.abort();c.dispose();f.cleanup();}
});

test('cold restart reconciles a real canonical save made before the adoption callback',async()=>{
  const f=fixture();let c=f.create();
  try {
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);const entry=f.appendCompaction(result.compaction);c.dispose();c=f.create();
    const field=c.confirmCanonical(f.ctx)!;assert.ok(field);assert.equal((c.snapshot(f.ctx).status as {phase:string}).phase,'applied');
    const store=new RecordStore('topic-rebuild',f.dir);const operation=store.get<{state:string;canonicalEntryId:string}>(`operation:project-a:session-a:${field.operationId}`)!.value;
    assert.equal(operation.state,'adopted');assert.equal(operation.canonicalEntryId,entry.id);store.close();
  }finally{c.dispose();f.cleanup();}
});

test('progress requests preserve original goal through ten compactions and cold recovery',async()=>{
  const f=fixture();let c=f.create();let calls=0;
  try {
    const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{calls++;return complete(...args);};
    for(let round=0;round<10;round++){
      f.add(`progress-${round}`,'user',round%2?'现在进度怎么样？':'还剩什么，继续完成。');
      const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);
      const old=(c.snapshot(f.ctx).field as WorkingField|undefined)?.revision||0;
      f.appendCompaction(result.compaction);const field=c.confirmCanonical(f.ctx)!;
      assert.equal(field.revision,old+1);assert.equal(field.goal.text,'实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
      assert.equal(field.goal.sources[0]!.entryId,'u1');assert.equal(field.currentRequest?.sources[0]!.entryId,`progress-${round}`);
      assert.ok(field.constraints.some(point=>point.text.includes('保留用户原始文件')));
      assert.equal(field.goalStatus,'active');
      if(round===4){c.dispose();c=f.create();}
    }
    assert.equal(calls,10);const timeline=await c.dispatch('timeline',{},f.ctx) as {goal:{text:string};currentRequest:{text:string};status:string;preservedFacts:unknown[]}[];
    assert.equal(timeline.length,10);assert.equal(timeline.at(-1)!.status,'adopted');assert.ok(timeline.at(-1)!.preservedFacts.length);
  }finally{c.dispose();f.cleanup();}
});

test('explicit replacement and cancellation change goal identity while command mentions do not',()=>{
  const f=fixture();const c=f.create();
  const adopt=()=>{const draft=c.checkpointDraft(f.ctx)!;assert.ok(draft);f.appendDraft(draft);return c.confirmCanonical(f.ctx)!;};
  try {
    assert.equal(adopt().goal.text,'实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
    f.add('mention','user','实现取消当前任务按钮，保留界面布局。');assert.equal(adopt().goal.text,'实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
    f.add('replace','user','新任务：实现日志查看器。');let field=adopt();assert.equal(field.goal.text,'新任务：实现日志查看器。');assert.equal(field.goalStatus,'active');
    f.add('status','user','进度如何？');field=adopt();assert.equal(field.goal.sources[0]!.entryId,'replace');assert.equal(field.currentRequest?.text,'进度如何？');
    f.add('cancel','user','取消当前任务。');field=adopt();assert.equal(field.goalStatus,'cancelled');assert.equal(field.goal.sources[0]!.entryId,'replace');
    f.add('status2','user','停止后状态如何？');assert.equal(adopt().goalStatus,'cancelled');
    f.add('restart','user','改做配置编辑器。');assert.equal(adopt().goalStatus,'active');
  }finally{c.dispose();f.cleanup();}
});

test('long entry tail and cross-page constraints survive bounded incremental preparation',async()=>{
  const f=fixture();let c=f.create();const prompts:string[]=[];
  try {
    const cross='必须保留跨页约束。';const long='x'.repeat(2994)+'。'+cross+'\n'+'y'.repeat(10000)+'。\n必须保留长条目尾部约束。';
    f.add('oversized','user',long);
    f.ctx.complete=async prompt=>{prompts.push(prompt);return JSON.stringify({constraints:[],decisions:[],unfinished:[],topics:[]});};
    const first=await c.beforeCompact(f.event(),f.ctx);assert.ok(first?.compaction);const prepared=(first.compaction.details as {friendPiRebuild:WorkingField}).friendPiRebuild;
    assert.equal(prepared.coverage?.complete,false);assert.ok(prepared.coverage!.pending.some(range=>range.entryId==='oversized'));
    assert.ok(prepared.constraints.some(point=>point.text.includes('长条目尾部约束')));assert.notEqual(prepared.coveredThroughId,'oversized');
    const firstInput=JSON.parse(prompts[0]!.split('原始条目：')[1]!) as {id:string;text:string}[];
    assert.ok(firstInput.filter(item=>item.id==='oversized').reduce((sum,item)=>sum+item.text.length,0)<=6000);
    assert.equal(c.snapshot(f.ctx).field,undefined,'unadopted preparation never advances coverage');
    f.appendCompaction(first.compaction);c.confirmCanonical(f.ctx);c.dispose();c=f.create();
    for(let page=0;page<3;page++){
      const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);f.appendCompaction(result.compaction);c.confirmCanonical(f.ctx);
    }
    const final=c.snapshot(f.ctx).field as WorkingField;
    assert.equal(final.coverage?.complete,true);assert.equal(final.coveredThroughId,'oversized');
    assert.ok(final.constraints.some(point=>point.text===cross));assert.ok(final.constraints.some(point=>point.text.includes('长条目尾部约束')));
    const laterInput=JSON.parse(prompts[1]!.split('原始条目：')[1]!) as {id:string;text:string}[];
    assert.equal(laterInput.some(item=>item.id==='u1'),false,'already adopted old entries are not resent');
    assert.ok(prompts[1]!.includes('保留用户原始文件'),'early constraint remains as source-backed field');
    const database=new DatabaseSync(join(f.dir,'plugins.sqlite'));const stored=JSON.stringify(database.prepare("SELECT json FROM documents WHERE namespace='topic-rebuild'").all());database.close();assert.equal(stored.includes(long),false);
  }finally{c.dispose();f.cleanup();}
});

test('explicit new task or cancel during asynchronous compaction rejects stale goal even after restart',async()=>{
  for(const input of ['新任务：实现日志查看器。','取消当前任务。']){
    const f=fixture();let c=f.create();let finish!:()=>void;let started!:()=>void;
    const ready=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{finish=resolve;});
    try {
      const complete=f.ctx.complete;f.ctx.complete=async(...args)=>{started();await gate;return complete(...args);};
      const pending=c.beforeCompact(f.event(),f.ctx);await ready;f.add('new-intent','user',input);finish();assert.equal(await pending,undefined);
      c.dispose();c=f.create();assert.equal(c.snapshot(f.ctx).field,undefined);
      const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);const field=c.confirmCanonical(f.ctx)!;
      assert.equal(field.goalStatus,input.startsWith('取消')?'cancelled':'active');if(input.startsWith('新任务'))assert.equal(field.goal.sources[0]!.entryId,'new-intent');
    }finally{finish();c.dispose();f.cleanup();}
  }
});

test('optional runtime goal needs matching native receipt and literal trusted user provenance',async()=>{
  const f=fixture();const c=f.create();
  try {
    const objective='下一步回到数据库：修复服务端事务，完成后检查原始文件。';
    const goal={id:'goal-a',revision:1,projectId:'project-a',sessionId:'session-a',origin:'user',status:'active',objective};
    f.ctx.request=async(plugin)=>{if(plugin==='runtime')return goal;throw new Error('not installed');};
    const rejected=await c.beforeCompact(f.event(),f.ctx);assert.ok(rejected?.compaction);assert.equal((rejected.compaction.details as {friendPiRebuild:WorkingField}).friendPiRebuild.goal.text,'实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
    c.compactFailed(f.ctx,'not adopted');f.ctx.appendEntry('friend-pi.goal.receipt',{goalId:'goal-a',revision:1,status:'active'});
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);const field=(result.compaction.details as {friendPiRebuild:WorkingField}).friendPiRebuild;
    assert.equal(field.goal.text,objective);assert.equal(field.goal.sources[0]!.entryId,'u3');
    f.ctx.appendEntry('friend-pi.goal.receipt',{goalId:'goal-a',revision:2,status:'stopped'});f.appendCompaction(result.compaction);assert.equal(c.confirmCanonical(f.ctx),undefined);
    goal.origin='agent';const agent=await c.beforeCompact(f.event(),f.ctx);assert.ok(agent?.compaction);assert.equal((agent.compaction.details as {friendPiRebuild:WorkingField}).friendPiRebuild.goal.text,'实现数据库模块。必须保留用户原始文件，不要并行写入数据库。');
  }finally{c.dispose();f.cleanup();}
});

test('memory condition or source drift fences the same-content record during preparation',async()=>{
  for(const change of ['condition','source']){
    const f=fixture();const c=f.create();
    const semantic={id:'conditional',revision:2,content:'有效方法',conditions:['仅发布前'],validFrom:'2026-01-01T00:00:00Z',validTo:'2099-01-01T00:00:00Z',scope:'project'};
    const record={...semantic,hash:digest(semantic.content),semanticDigest:digest(semantic),sources:[sourceFactRefs(historyItems(f.originals)[0]!,'session-a')[1]!],status:'active',enabled:true};
    try {
      f.ctx.request=async(plugin,action)=>{if(plugin!=='memory')throw new Error('not installed');if(action==='invalidation.snapshot')return {epoch:0,ids:[],sources:[]};if(action==='select')return {records:[record],epoch:0};if(action==='read')return change==='condition'?{...record,conditions:['所有场景']}:{...record,sources:[]};throw new Error('unexpected');};
      const complete=f.ctx.complete;f.ctx.complete=async(prompt,...rest)=>{assert.match(prompt,/仅发布前/);assert.match(prompt,/2099-01-01/);return complete(prompt,...rest);};
      assert.equal(await c.beforeCompact(f.event(),f.ctx),undefined);assert.equal(c.snapshot(f.ctx).field,undefined);
    }finally{c.dispose();f.cleanup();}
  }
});

test('canonical checkpoints continue pending ranges without rereading adopted pages',()=>{
  const f=fixture();let c=f.create();
  try {
    f.add('long-checkpoint','user','z'.repeat(15000)+'。\n必须保留最后的限制。');
    const draft=c.checkpointDraft(f.ctx)!;assert.equal(draft.type,'custom');if(draft.type!=='custom')throw new Error('missing custom draft');
    const first=draft.data as WorkingField;assert.equal(first.coverage?.complete,false);
    const retry=c.checkpointDraft(f.ctx)!;if(retry.type!=='custom')throw new Error('missing custom retry');assert.deepEqual((retry.data as WorkingField).coverage,first.coverage);
    f.appendDraft(draft);c.confirmCanonical(f.ctx);c.dispose();c=f.create();
    for(let count=0;count<3;count++){const next=c.checkpointDraft(f.ctx);if(!next)break;f.appendDraft(next);c.confirmCanonical(f.ctx);}
    const final=c.snapshot(f.ctx).field as WorkingField;assert.equal(final.coverage?.complete,true);assert.ok(final.constraints.some(point=>point.text.includes('最后的限制')));assert.equal(c.checkpointDraft(f.ctx),undefined);
  }finally{c.dispose();f.cleanup();}
});

test('remaining global page budget still samples a long entry tail',async()=>{
  const f=fixture();const c=f.create();
  try {
    for(let n=0;n<6;n++)f.add(`large-tool-${n}`,'toolResult','x'.repeat(5500));
    f.add('late-long-user','user','y'.repeat(10000)+'。\n必须保留预算末尾约束。');
    f.ctx.complete=async prompt=>{
      const entries=JSON.parse(prompt.split('原始条目：')[1]!) as {id:string;text:string}[];
      assert.ok(entries.reduce((sum,item)=>sum+item.text.length,0)<=36000);
      const late=entries.filter(item=>item.id==='late-long-user');assert.equal(late.length,2);assert.match(late.at(-1)!.text,/预算末尾约束/);
      return JSON.stringify({constraints:[],decisions:[],unfinished:[],topics:[]});
    };
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);assert.match(result.compaction.summary,/预算末尾约束/);
  }finally{c.dispose();f.cleanup();}
});


test('multi-sentence task and current request retain every bounded subtask',async()=>{
  const f=fixture();const c=f.create();
  try {
    f.add('multi-task','user','新任务：实现日志查看器。增加按时间筛选。必须保留用户配置。');
    const first=c.checkpointDraft(f.ctx)!;f.appendDraft(first);const initial=c.confirmCanonical(f.ctx)!;
    assert.match(initial.goal.text,/实现日志查看器/);assert.match(initial.goal.text,/增加按时间筛选/);assert.equal(initial.goal.sources.length,3);
    f.add('status-with-detail','user','现在进展如何？请列出仍未完成的子任务。');
    const next=c.checkpointDraft(f.ctx)!;f.appendDraft(next);const current=c.confirmCanonical(f.ctx)!;
    assert.equal(current.goal.text,initial.goal.text);assert.match(current.currentRequest!.text,/请列出仍未完成的子任务/);
    const retired=initial.goal.sources[2]!;c.memoryInvalidated({projectId:'project-a',ids:['config'],sources:[retired]},f.ctx);
    const compacted=await c.beforeCompact(f.event(),f.ctx);assert.ok(compacted?.compaction);f.appendCompaction(compacted.compaction);const corrected=c.confirmCanonical(f.ctx)!;
    assert.match(corrected.goal.text,/增加按时间筛选/);assert.doesNotMatch(corrected.goal.text,/保留用户配置/);
  }finally{c.dispose();f.cleanup();}
});

test('checkpoint leaves unrepresented tool evidence pending through cold start and failed preparation',async()=>{
  const f=fixture();let c=f.create();let calls=0;
  try {
    f.originals.length=0;f.canonical.length=0;
    f.add('u1','user','分析部署失败。');f.add('deploy-tool','toolResult','Deployment failed: E902 in /srv/site/settings.toml');f.add('u3','assistant','继续核对。');
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);const checkpoint=c.confirmCanonical(f.ctx)!;
    assert.equal(checkpoint.coverage?.complete,false);assert.equal(checkpoint.coveredThroughId,'u1');assert.deepEqual(checkpoint.coverage?.toolRanges,[]);
    assert.ok(checkpoint.coverage!.pending.some(range=>range.entryId==='deploy-tool'&&range.start===0));
    assert.doesNotMatch(JSON.stringify(checkpoint),/E902|\/srv\/site\/settings.toml/,'checkpoint stores refs, not a second tool transcript');
    c.dispose();c=f.create();assert.equal(c.checkpointDraft(f.ctx),undefined,'tool-only pending ranges must not create empty checkpoint progress');
    const cold=c.snapshot(f.ctx).field as WorkingField;assert.deepEqual(cold.coverage,checkpoint.coverage);
    f.ctx.complete=async prompt=>{
      calls++;const entries=JSON.parse(prompt.split('原始条目：')[1]!) as {id:string;text:string}[];
      assert.equal(entries.filter(item=>item.id==='deploy-tool').length,1);assert.match(entries.find(item=>item.id==='deploy-tool')!.text,/E902.*\/srv\/site\/settings.toml/);
      return JSON.stringify({constraints:[],decisions:[{text:'Deployment failed: E902 in /srv/site/settings.toml',sourceEntryIds:['deploy-tool']}],unfinished:[],topics:[]});
    };
    const failed=await c.beforeCompact(f.event(),f.ctx);assert.ok(failed?.compaction);c.compactFailed(f.ctx,'simulated journal failure');
    assert.equal((c.snapshot(f.ctx).field as WorkingField).coverage?.complete,false);
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);assert.equal(calls,2);
    f.appendCompaction(result.compaction);const adopted=c.confirmCanonical(f.ctx)!;
    assert.equal(adopted.coverage?.complete,true);assert.equal(adopted.coverage?.toolRanges?.[0]?.entryId,'deploy-tool');assert.match(result.compaction.summary,/E902.*\/srv\/site\/settings.toml/);
    c.dispose();c=f.create();f.add('after-tool','user','进度如何？');const next=c.checkpointDraft(f.ctx)!;f.appendDraft(next);const after=c.confirmCanonical(f.ctx)!;
    assert.deepEqual(after.coverage?.toolRanges,adopted.coverage?.toolRanges);assert.ok(after.decisions.some(point=>point.text.includes('E902')));
    f.ctx.complete=async prompt=>{const entries=JSON.parse(prompt.split('原始条目：')[1]!) as {id:string}[];assert.equal(entries.some(item=>item.id==='deploy-tool'),false);assert.match(prompt.split('原始条目：')[0]!,/E902.*\/srv\/site\/settings.toml/);return JSON.stringify({constraints:[],decisions:[],unfinished:[],topics:[]});};
    assert.ok((await c.beforeCompact(f.event(),f.ctx))?.compaction);
  }finally{c.dispose();f.cleanup();}
});

test('legacy checkpoint tool coverage is conservatively reread after cold start',async()=>{
  const f=fixture();let c=f.create();
  try {
    f.originals.length=0;f.canonical.length=0;
    f.add('u1','user','分析部署失败。');f.add('legacy-tool','toolResult','E902 /srv/site/settings.toml');f.add('u3','assistant','继续核对。');
    const draft=c.checkpointDraft(f.ctx)!;f.appendDraft(draft);const checkpoint=c.confirmCanonical(f.ctx)!;
    // Reproduce the old persisted contract that claimed every entry was covered.
    const tool=historyItems(f.originals).find(item=>item.id==='legacy-tool')!;
    checkpoint.coverage!.ranges.push({sessionId:'session-a',entryId:tool.id,start:0,end:tool.text.length,hash:digest(tool.text)});
    checkpoint.coverage!.pending=[];checkpoint.coverage!.complete=true;delete checkpoint.coverage!.toolRanges;checkpoint.coveredThroughId='u3';
    c.dispose();c=f.create();
    f.ctx.complete=async prompt=>{const entries=JSON.parse(prompt.split('原始条目：')[1]!) as {id:string;text:string}[];assert.match(entries.find(item=>item.id==='legacy-tool')!.text,/E902.*\/srv\/site\/settings.toml/);return JSON.stringify({constraints:[],decisions:[],unfinished:[],topics:[]});};
    const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);f.appendCompaction(result.compaction);assert.equal(c.confirmCanonical(f.ctx)!.coverage!.toolRanges?.[0]?.entryId,'legacy-tool');
  }finally{c.dispose();f.cleanup();}
});

test('legacy cached draft cannot bypass tool rereading after cold restart',async()=>{
  for(const route of ['foreground','background']){
    const f=fixture();let c=f.create();let calls=0;
    try {
      f.add('cached-tool','toolResult','E902 /srv/site/settings.toml');
      f.ctx.complete=async prompt=>{calls++;const entries=JSON.parse(prompt.split('原始条目：')[1]!) as {id:string;text:string}[];assert.match(entries.find(item=>item.id==='cached-tool')!.text,/E902.*\/srv\/site\/settings.toml/);return JSON.stringify({constraints:[],decisions:[],unfinished:[],topics:[]});};
      assert.equal((await c.prepareDraft(f.ctx)).prepared,true);assert.equal(calls,1);
      const store=new RecordStore('topic-rebuild',f.dir),key='draft:project-a:session-a';const saved=store.get<{field:WorkingField;summary:string}>(key)!;
      delete saved.value.field.coverage!.toolRanges;saved.value.summary='Old summary omitted all tool evidence';store.put(key,saved.value,saved.revision);store.close();c.dispose();c=f.create();
      if(route==='background'){assert.equal((await c.prepareDraft(f.ctx)).prepared,true);assert.equal(calls,2);}
      const result=await c.beforeCompact(f.event(),f.ctx);assert.ok(result?.compaction);assert.equal(calls,2,'legacy cache must force exactly one fresh preparation');
      assert.doesNotMatch(result.compaction.summary,/Old summary omitted/);assert.equal(c.snapshot(f.ctx).field,undefined);
    }finally{c.dispose();f.cleanup();}
  }
});
