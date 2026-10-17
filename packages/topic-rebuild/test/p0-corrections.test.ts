import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { RebuildController, type WorkingField } from '../src/index.js';
import { MemoryController } from '../../memory/src/index.js';
import {
  historyItems, sourceFactRefs, readSourceSpan, type HistoryItem, type PluginContext, type SourceRef,
} from '../../core/src/index.js';

/**
 * P0 §5.4 R01/R02: fact-level correction must survive ordinary checkpoints,
 * compaction and cold rebuild, and must agree with Memory's same-subject
 * invalidation. This file reuses the fixture shape of rebuild.test.ts: a real
 * RebuildController backed by canonical session entries and a fake provider
 * PluginContext, plus (for the cross-plugin case) a real MemoryController that
 * shares the same tmpdir and fake provider context.
 */
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-p0-corrections-'));
  const entries:Record<string,unknown>[]=[];
  const events:{event:string;data:unknown}[]=[];
  let compactCalls=0;
  const append=(entry:Record<string,unknown>)=>entries.push(entry);
  function add(id:string,role:string,content:string){
    append({id,parentId:entries.at(-1)?.id||null,type:'message',timestamp:new Date().toISOString(),message:{role,content:[{type:'text',text:content}]}});
  }
  const items=()=>historyItems(entries);
  const readSource=(source:SourceRef):HistoryItem=>{
    if(source.sessionId!=='session-a')throw new Error('来源不属于当前项目');
    const item=items().find(item=>item.id===source.entryId);
    if(!item)throw new Error('来源已丢失');
    readSourceSpan(item,source);
    return item;
  };
  const ctx:PluginContext={
    dataDir:dir,projectDir:dir,projectId:'project-a',sessionId:'session-a',origin:'user',
    isIdle:()=>true,history:items,readSource,
    complete:async()=>JSON.stringify({goal:{text:'整理数据库配置',sourceEntryIds:['u1']},constraints:[],decisions:[],unfinished:[],topics:[]}),
    request:async()=>{throw new Error('Memory not installed');},emit:(event,data)=>events.push({event,data}),notify:()=>{},
    appendEntry:(customType,data)=>append({id:`custom-${entries.length}`,parentId:entries.at(-1)?.id||null,type:'custom',customType,data,timestamp:new Date().toISOString()}),
  };
  const create=()=>{
    const controller=new RebuildController({entries:()=>entries,compact:()=>{compactCalls++;},contextWindow:()=>32000});
    void controller.dispatch('settings',{mode:'infinite'},ctx);
    return controller;
  };
  const adopt=(controller:RebuildController,context:PluginContext=ctx)=>{
    const draft=controller.checkpointDraft(context);
    assert.ok(draft,'expected a canonical checkpoint draft');
    assert.equal(draft.type,'custom');
    if(draft.type==='custom')context.appendEntry!(draft.customType,draft.data);
    const field=controller.confirmCanonical(context);
    assert.ok(field,'expected the checkpoint to be adopted');
    return field;
  };
  const event=(firstKeptEntryId:string,signal:AbortSignal=new AbortController().signal)=>({
    type:'session_before_compact',branchEntries:[...entries],reason:'manual',willRetry:false,signal,
    preparation:{firstKeptEntryId,tokensBefore:12000,settings:{enabled:true,reserveTokens:1024,keepRecentTokens:2048},messagesToSummarize:[],turnPrefixMessages:[],isSplitTurn:false,fileOps:{read:new Set(),edited:new Set()}},
  } as unknown as SessionBeforeCompactEvent);
  const appendCompaction=(result:{summary:string;firstKeptEntryId:string;details?:unknown})=>{
    const entry={id:`compact-${entries.length}`,parentId:entries.at(-1)?.id||null,type:'compaction',timestamp:new Date().toISOString(),...result};
    append(entry);return entry;
  };
  const constraintTexts=(field:WorkingField)=>field.constraints.map(point=>point.text).join('\n');
  return {dir,ctx,entries,items,events,add,create,adopt,event,appendCompaction,constraintTexts,compactCalls:()=>compactCalls,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}

test('R01/R02 ordinary checkpoint correction supersedes only the addressed fact',()=>{
  const f=fixture();const c=f.create();
  try{
    f.add('u1','user','数据库必须使用 SQLite，必须使用 UTF-8 编码。');
    const initial=f.adopt(c);
    assert.match(f.constraintTexts(initial),/数据库必须使用 SQLite/);
    assert.match(f.constraintTexts(initial),/UTF-8/);
    const entry=f.items().find(item=>item.id==='u1')!;
    const facts=sourceFactRefs(entry,'session-a');
    assert.equal(facts.length,2,'the message carries two independently addressable facts');

    // Ordinary checkpoint (not compaction): a unique correction of the database
    // constraint must retire exactly that fact and keep the UTF-8 sibling.
    f.add('u2','user','更正：数据库必须改为 PostgreSQL。');
    const field=f.adopt(c);
    assert.equal(f.compactCalls(),0,'ordinary checkpoint path is deterministic and needs no compaction');
    assert.equal(field.supersededSources?.length,1);
    assert.equal(field.supersededSources![0]!.source.factId,facts[0]!.factId,'only the database fact is superseded');
    assert.equal(field.supersededSources![0]!.source.entryId,'u1');
    assert.ok(field.supersededSources![0]!.source.end!<entry.text.length,'retirement is a fact slice, not the whole message');
    assert.equal(field.supersededSources![0]!.by.entryId,'u2');
    assert.equal(field.supersededSources![0]!.by.factId,sourceFactRefs(f.items().find(item=>item.id==='u2')!,'session-a')[0]!.factId);
    assert.doesNotMatch(f.constraintTexts(field),/SQLite/,'the corrected backend value is no longer an effective constraint');
    assert.match(f.constraintTexts(field),/UTF-8/,'the sibling encoding constraint is retained');
    assert.match(f.constraintTexts(field),/PostgreSQL/);
    assert.equal(field.conflicts?.length??0,0);
  }finally{c.dispose();f.cleanup();}
});

test('R02 corrected fact stays retired through compaction, later checkpoints and cold rebuild',async()=>{
  const f=fixture();let c=f.create();
  try{
    f.add('u1','user','数据库必须使用 SQLite，必须使用 UTF-8 编码。');
    f.adopt(c);
    const entry=f.items().find(item=>item.id==='u1')!;
    const facts=sourceFactRefs(entry,'session-a');

    // Path 1: ordinary checkpoint establishes the correction ledger.
    f.add('u2','user','更正：数据库必须改为 PostgreSQL。');
    let field=f.adopt(c);
    assert.equal(field.supersededSources?.length,1);
    assert.doesNotMatch(f.constraintTexts(field),/SQLite/);

    // Path 2: a later canonical compaction whose provider output tries to bring
    // the old fact back must still filter it through the same ledger.
    f.ctx.complete=async()=>JSON.stringify({
      goal:{text:'迁移数据库配置',sourceEntryIds:['u2']},
      constraints:[
        {text:readSourceSpan(f.items().find(item=>item.id==='u1')!,facts[0]!),sourceFactIds:[facts[0]!.factId]},
        {text:readSourceSpan(f.items().find(item=>item.id==='u1')!,facts[1]!),sourceFactIds:[facts[1]!.factId]},
      ],decisions:[],unfinished:[],topics:[],
    });
    const result=await c.beforeCompact(f.event('u2'),f.ctx);
    assert.ok(result?.compaction,'compaction preparation succeeds');
    f.appendCompaction(result.compaction);
    c.dispose();c=f.create(); // cold-start reconciliation of the canonical compaction
    field=(await c.confirmCanonicalAsync(f.ctx))!;
    assert.ok(field,'canonical compaction is adopted after cold start');
    assert.equal(field.supersededSources?.length,1,'one corrected fact, no duplicated ledger entries');
    assert.doesNotMatch(f.constraintTexts(field),/SQLite/);
    assert.match(f.constraintTexts(field),/UTF-8/);

    // Path 3: subsequent ordinary checkpoint keeps the fact-level retirement.
    f.add('u3','user','继续检查，务必保留现有文件。');
    const next=f.adopt(c);
    assert.equal(next.supersededSources?.length,1);
    assert.doesNotMatch(f.constraintTexts(next),/SQLite/);
    assert.match(f.constraintTexts(next),/UTF-8/);
    assert.match(f.constraintTexts(next),/保留现有文件/,'a later unrelated constraint is kept');

    // Path 4: cold rebuild from canonical entries alone.
    c.dispose();c=f.create();
    const restored=c.snapshot(f.ctx).field as WorkingField;
    assert.equal(restored.supersededSources?.length,1);
    assert.equal(restored.supersededSources![0]!.source.factId,facts[0]!.factId);
    f.add('u4','user','最后复核，不要丢失编码约束。');
    const cold=f.adopt(c);
    assert.doesNotMatch(f.constraintTexts(cold),/SQLite/);
    assert.match(f.constraintTexts(cold),/UTF-8/);
  }finally{c.dispose();f.cleanup();}
});

test('R02 explicit sourceFactId correction addresses one fact even without a deterministic marker verb',async()=>{
  const f=fixture();const c=f.create();
  try{
    f.add('u1','user','数据库必须使用 SQLite，必须使用 UTF-8 编码。');
    f.adopt(c);
    const entry=f.items().find(item=>item.id==='u1')!;
    const facts=sourceFactRefs(entry,'session-a');
    // "改用" is a natural correction wording; the deterministic settlement
    // marker table only knows 改为/改成/不再/取消/不用. The explicit factId in a
    // model-proposed supersede must therefore localize the exact fact on its own.
    f.add('u2','user','更正：数据库改用 PostgreSQL。');
    const correctionFacts=sourceFactRefs(f.items().find(item=>item.id==='u2')!,'session-a');
    f.ctx.complete=async()=>JSON.stringify({
      goal:{text:'迁移数据库后端',sourceEntryIds:['u2']},
      constraints:[],
      supersededSources:[{entryId:'u1',factId:facts[0]!.factId,byEntryId:'u2',byFactId:correctionFacts[0]!.factId}],
      decisions:[],unfinished:[],topics:[],
    });
    const result=await c.beforeCompact(f.event('u2'),f.ctx);
    assert.ok(result?.compaction);
    f.appendCompaction(result.compaction);
    const field=(await c.confirmCanonicalAsync(f.ctx))!;
    assert.equal(field.supersededSources?.length,1,'one precise fact is superseded');
    assert.equal(field.supersededSources![0]!.source.factId,facts[0]!.factId);
    assert.ok(field.supersededSources![0]!.source.end!<entry.text.length,'multi-fact message is not retired as a whole');
    assert.doesNotMatch(f.constraintTexts(field),/SQLite/);
    assert.match(f.constraintTexts(field),/UTF-8/,'sibling constraint from the same message survives');
  }finally{c.dispose();f.cleanup();}
});

test('R02 ambiguous correction supersedes nothing and keeps the conflict notice',()=>{
  const f=fixture();const c=f.create();
  try{
    f.add('u1','user','配置必须使用 YAML。');
    f.add('u2','user','配置必须保留注释。');
    const initial=f.adopt(c);
    assert.equal(initial.constraints.length,2);
    assert.equal(initial.conflicts?.length??0,0);

    f.add('u3','user','更正：配置改为 TOML。');
    const field=f.adopt(c);
    assert.equal(field.supersededSources?.length??0,0,'an ambiguous correction must not pick a fact');
    assert.ok((field.conflicts?.length??0)>=2,'both candidate facts are surfaced as conflicts');
    assert.ok(field.conflicts!.every(conflict=>/等待明确指定/.test(conflict.reason)));
    assert.doesNotMatch(f.constraintTexts(field),/YAML/);
    assert.doesNotMatch(f.constraintTexts(field),/注释/);
    const snapshot=c.snapshot(f.ctx).field as WorkingField;
    assert.ok((snapshot.conflicts?.length??0)>=2,'conflict notice survives into the working field view');
  }finally{c.dispose();f.cleanup();}
});

test('R01 Memory same-subject correction and Topic invalidation agree on the addressed fact',async()=>{
  const f=fixture(),previousRole=process.env.FRIEND_PI_LEARNING_ROLE;
  process.env.FRIEND_PI_LEARNING_ROLE='producer';
  const memory=new MemoryController();
  try{
    f.add('u1','user','数据库必须使用 SQLite，必须使用 UTF-8 编码。');
    f.add('a1','assistant','开始迁移。');
    const entry=f.items().find(item=>item.id==='u1')!;
    const facts=sourceFactRefs(entry,'session-a');
    assert.equal(facts.length,2);

    // A real MemoryController shares this tmpdir and the same fake history.
    const memoryCtx:PluginContext={...f.ctx,runId:'foreground-1',modelId:'fixture/offline'};
    const save=(input:Record<string,unknown>)=>memory.dispatch('save',{explicitRemember:true,...input},memoryCtx) as Promise<{id:string;revision:number;status:string;subject?:string;content:string}>;
    const dbRecord=await save({title:'数据库引擎',content:readSourceSpan(entry,facts[0]!),kind:'fact',scope:'project',subject:'database.configuration',sources:[facts[0]]});
    // The sibling constraint is a different fact and deliberately gets its own
    // subject: single-cardinality same-subject retirement is what Memory's own
    // subject/conflict tests cover; here the sibling source must stay valid so
    // Topic keeps the encoding constraint.
    const encodingRecord=await save({title:'编码',content:readSourceSpan(entry,facts[1]!),kind:'fact',scope:'project',subject:'file.encoding',sources:[facts[1]]});
    assert.equal(dbRecord.subject,'database.configuration');
    assert.equal(encodingRecord.subject,'file.encoding');
    assert.equal(dbRecord.status,'active');

    // The user correction moves the database fact to PostgreSQL; Memory records
    // the invalidation for exactly the corrected fact's source slice.
    const updated=await memory.dispatch('update',{id:dbRecord.id,revision:dbRecord.revision,content:'数据库必须使用 PostgreSQL。'},memoryCtx) as {id:string;revision:number;status:string;content:string};
    assert.equal(updated.status,'active');
    assert.match(updated.content,/PostgreSQL/);
    const invalidation=await memory.dispatch('invalidation.snapshot',{},memoryCtx) as {epoch:number;ids:string[];sources:SourceRef[]};
    assert.deepEqual(invalidation.ids,[dbRecord.id],'only the corrected Memory record is invalidated');
    assert.equal(invalidation.sources.length,1);
    assert.equal(invalidation.sources[0]!.factId,facts[0]!.factId,'invalidation carries the corrected fact slice');
    const selection=await memory.dispatch('select',{query:'数据库 编码',limit:4},memoryCtx) as {records:{id:string;content:string;status:string}[];epoch:number};
    assert.ok(selection.records.some(record=>record.id===dbRecord.id&&record.content.includes('PostgreSQL')),'Memory select now exposes the corrected value');
    assert.equal(selection.records.some(record=>record.content.includes('SQLite')),false);

    // Topic adopts the initial field, then the Memory invalidation drives the
    // same fact-level correction without retiring the sibling constraint.
    const c=f.create();
    // The topic controller reads Memory through the versioned plugin requests.
    f.ctx.request=async(plugin,action,input)=>{
      if(plugin==='memory')return memory.dispatch(action,input as Record<string,unknown>,memoryCtx);
      throw new Error('Memory not installed');
    };
    try{
      const initial=f.adopt(c);
      assert.match(f.constraintTexts(initial),/SQLite/);
      f.ctx.complete=async()=>JSON.stringify({
        goal:{text:'迁移数据库配置',sourceEntryIds:['u1']},
        constraints:[
          {text:readSourceSpan(entry,facts[0]!),sourceFactIds:[facts[0]!.factId]},
          {text:readSourceSpan(entry,facts[1]!),sourceFactIds:[facts[1]!.factId]},
        ],decisions:[],unfinished:[],topics:[],
      });
      const result=await c.beforeCompact(f.event('a1'),f.ctx);
      assert.ok(result?.compaction,'Memory invalidation is reconciled during compaction preparation');
      f.appendCompaction(result.compaction);
      const field=(await c.confirmCanonicalAsync(f.ctx))!;
      assert.ok(field,'the rebuilt field is adopted after re-validating Memory revisions');
      assert.doesNotMatch(f.constraintTexts(field),/SQLite/,'the corrected database fact is the only retired constraint');
      assert.match(f.constraintTexts(field),/UTF-8/,'the sibling encoding constraint remains effective');
      assert.equal(field.conflicts?.length??0,0);
      assert.ok(field.memoryRefs.some(ref=>ref.id===dbRecord.id&&ref.revision===updated.revision));
      const snapshot=c.snapshot(f.ctx).field as WorkingField;
      assert.doesNotMatch(f.constraintTexts(snapshot),/SQLite/);
    }finally{c.dispose();}
  }finally{
    await memory.dispose();
    if(previousRole===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=previousRole;
    f.cleanup();
  }
});
