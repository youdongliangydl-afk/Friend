import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,memorySemanticDigest,type MemoryRecord,type MemoryFeedback} from '../src/index.js';
import {CapabilityError,ConflictError,RecordStore,SourcePolicy,digest,readSourceSpan,type HistoryItem,type PluginContext} from '../../core/src/index.js';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-context-')),items:HistoryItem[]=[{id:'u',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'来自可信用户的长期事实。'}];let c=new MemoryController(),calls=0;
 const ctx:PluginContext={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'r',isIdle:()=>false,history:()=>items,readSource:source=>{const item=items.find(item=>item.id===source.entryId);if(!item)throw new CapabilityError('SOURCE_UNAVAILABLE','missing');readSourceSpan(item,source);return item;},complete:async()=>{calls++;throw new Error('Retrieval must not call a model');},request:async()=>{throw new Error('No other plugins installed');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 return {dir,items,ctx,get c(){return c;},calls:()=>calls,save:(input:Record<string,unknown>,context=ctx)=>c.dispatch('save',{explicitRemember:true,...input},context) as Promise<MemoryRecord>,cold:async()=>{await c.dispose();c=new MemoryController();},close:async()=>{await c.dispose();rmSync(dir,{recursive:true,force:true});}};
}
const context={goal:'排查中文界面',scenario:'桌面设置',entities:['Cedar']};

test('Chinese task context augments local BM25 candidates; exact aliases and path/code literals stay first',async()=>{
 const f=fixture();try{
  const cli=await f.save({title:'终端断线经验',content:'连接失败时检查终端连接配置。'}),desktop=await f.save({title:'中文界面经验',content:'连接失败时检查桌面设置。',aliases:['Cedar窗口']});
  assert.equal(f.c.search({query:'连接失败',taskContext:context},f.ctx)[0].id,desktop.id);
  assert.equal(f.c.search({query:'Cedar窗口',taskContext:{goal:'终端配置'}},f.ctx)[0].id,desktop.id);
  assert.ok(f.c.search({taskContext:{goal:'终端配置'}},f.ctx).some(record=>record.id===cli.id));
  const exact=await f.save({title:'路径检查',content:'修复 src/view.ts 的 parseConfig 错误。'});
  await f.save({title:'窗口桌面中文界面',content:'src/view.tsx 的 parseConfigFallback 属于桌面设置。'});
  assert.equal(f.c.search({query:'src/view.ts',taskContext:context},f.ctx)[0].id,exact.id);
  assert.equal(f.c.search({query:'parseConfig',taskContext:context},f.ctx)[0].id,exact.id);
  const absolute=await f.save({title:'绝对路径检查',content:'修复 /opt/config.ts 的问题。'});await f.save({title:'桌面设置路径',content:'桌面设置使用 /opt/config.tsx。'});assert.equal(f.c.search({query:'/opt/config.ts',taskContext:context},f.ctx)[0].id,absolute.id);
  assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('selected semantic identity binds all conditions, dates and scope; directory and pages preserve full digest',async()=>{
 const f=fixture();try{
  const conditions=Array.from({length:14},(_,i)=>`条件 ${i}：只在指定测试环境生效`),content='完整事实。'.repeat(80);f.items[0].text=content;
  const record=await f.save({title:'完整条件',content,conditions,sources:[{sessionId:'s',entryId:'u'}],validFrom:'2020-01-01',validTo:'2099-01-01'});
  const selected=f.c.select({query:record.id,budget:{directory:10000,body:5000}},f.ctx) as any,full=selected.records[0];
  assert.deepEqual(full.conditions,conditions);assert.equal(full.semanticDigest,digest({id:full.id,revision:full.revision,content,conditions,validFrom:'2020-01-01T00:00:00.000Z',validTo:'2099-01-01T00:00:00.000Z',scope:'project'}));
  assert.equal(Object.isFrozen(full),true);assert.equal(Object.isFrozen(full.conditions),true);assert.equal(Object.isFrozen(full.sources[0]),true);
  const directory=selected.directory[0];assert.equal('content' in directory,false);assert.deepEqual(directory.sources,full.sources);assert.equal(directory.semanticDigest,full.semanticDigest);assert.deepEqual(directory.conditions,conditions);
  const page=await f.c.dispatch('read.range',{id:record.id,revision:record.revision,maxChars:300},f.ctx) as any;assert.equal(page.hash,digest(content));assert.equal(page.semanticDigest,full.semanticDigest);assert.equal(page.sentSliceHash,digest(page.content));assert.equal(page.bodyComplete,false);assert.deepEqual(page.conditions,conditions);
  const original=await f.c.dispatch('source.read',{source:page.sources[0]}, {...f.ctx,origin:'agent'}) as any;assert.equal(original.text,content);
  for(const patch of [{conditions:[...conditions,'最后新增限定']},{validFrom:null},{validTo:null},{scope:'personal' as const},{revision:2},{content:content+'更正'}])assert.notEqual(memorySemanticDigest({...record,...patch}),record.semanticDigest);
  const tiny=f.c.select({query:record.id,budget:{directory:10000,body:10}},f.ctx) as any;assert.equal(tiny.records.length,0);assert.equal(tiny.omitted[0].reason,'body-budget');assert.deepEqual(tiny.directory[0].conditions,conditions);
  const noDates=await f.save({content:'没有有效时间边界。'});assert.equal(noDates.validFrom,null);assert.equal(noDates.validTo,null);
 }finally{await f.close();}
});

test('trusted feedback is normalized, revision checked, idempotent and ranking applies only in that task context',async()=>{
 const f=fixture();try{
  const a=await f.save({title:'甲记录',content:'故障排查使用第一种方案。'}),b=await f.save({title:'乙记录',content:'故障排查使用第二种方案。'});
  const taskContext={goal:'  故障排查  ',scenario:'DESKTOP',entities:['Cedar','Cedar','Alpha']};
  const input={id:a.id,revision:a.revision,kind:'relevant',taskContext,operationId:'feedback-a'};
  const before=await f.c.dispatch('read',{id:a.id},f.ctx),value=await f.c.dispatch('feedback',input,f.ctx) as MemoryFeedback;
  assert.deepEqual(value.taskContext,{goal:'故障排查',scenario:'desktop',entities:['alpha','cedar']});assert.equal(value.contextKey,digest(value.taskContext));assert.equal(value.reviewQueued,false);
  assert.deepEqual(await f.c.dispatch('feedback',input,f.ctx),value);await assert.rejects(f.c.dispatch('feedback',{...input,kind:'irrelevant'},f.ctx),{code:'VERSION_CONFLICT'});
  assert.deepEqual(await f.c.dispatch('read',{id:a.id},f.ctx),before);
  const normalized={goal:'故障排查',scenario:'desktop',entities:['Alpha','Cedar']};assert.equal(f.c.search({query:'故障排查',taskContext:normalized},f.ctx)[0].id,a.id);
  const explain=await f.c.dispatch('search.explain',{query:'故障排查',taskContext:{...normalized,scenario:'terminal'}},f.ctx) as any;assert.ok(explain.matches.every((m:any)=>m.feedback===null));
  const noContext=await f.c.dispatch('search.explain',{query:'故障排查'},f.ctx) as any;assert.ok(noContext.matches.every((m:any)=>m.feedback===null));
  await f.c.dispatch('feedback',{id:b.id,revision:b.revision,kind:'irrelevant',taskContext:normalized},f.ctx);
  assert.equal(f.c.search({query:'故障排查',taskContext:normalized},f.ctx)[0].id,a.id);
  await f.cold();assert.equal((f.c.snapshot(f.ctx).feedback as MemoryFeedback[]).length,2);assert.equal(f.calls(),0);
 }finally{await f.close();}
});

test('feedback rejects model-origin, forged origin, stale revision, and foreign project records',async()=>{
 const f=fixture();try{
  const record=await f.save({content:'有效事实'}),input={id:record.id,revision:record.revision,kind:'relevant',taskContext:context};
  await assert.rejects(f.c.dispatch('feedback',input,{...f.ctx,origin:'agent'}),{code:'PERMISSION_DENIED'});
  await assert.rejects(f.c.dispatch('feedback',{...input,origin:'user'}, {...f.ctx,origin:'agent'}),{code:'PERMISSION_DENIED'});
  await assert.rejects(f.c.dispatch('feedback',{...input,revision:2},f.ctx),ConflictError);
  await assert.rejects(f.c.dispatch('feedback',{...input,kind:'invented'},f.ctx),{code:'VALIDATION_ERROR'});
  await assert.rejects(f.c.dispatch('feedback',{...input,taskContext:{goal:'x',projectId:'foreign'}},f.ctx),{code:'VALIDATION_ERROR'});
  await assert.rejects(f.c.dispatch('feedback',input,{...f.ctx,projectId:'foreign'}));
  assert.deepEqual(f.c.snapshot(f.ctx).feedback,[]);
 }finally{await f.close();}
});

test('outdated queues review metadata only; personal feedback stays in its submitting project',async()=>{
 const f=fixture();try{
  const record=await f.save({kind:'preference',scope:'personal',content:'请长期记住，我希望解释时使用中文。'}),before=await f.c.dispatch('read',{id:record.id},f.ctx);
  const result=await f.c.dispatch('feedback',{id:record.id,revision:record.revision,kind:'outdated',taskContext:context,operationId:'review'},f.ctx) as MemoryFeedback;
  assert.equal(result.reviewQueued,true);assert.deepEqual(await f.c.dispatch('read',{id:record.id},f.ctx),before);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,1);
  const other={...f.ctx,projectId:'other'};assert.deepEqual(f.c.snapshot(other).feedback,[]);await assert.rejects(f.c.dispatch('operation.get',{operationId:'review'},other),{code:'PERMISSION_DENIED'});
  const explain=await f.c.dispatch('search.explain',{query:record.id,taskContext:context},other) as any;assert.equal(explain.matches[0].feedback,null);
  await f.cold();assert.equal((f.c.snapshot(f.ctx).feedback as MemoryFeedback[])[0].reviewQueued,true);
 }finally{await f.close();}
});

test('corrected, expired and forgotten records cannot be revived by contextual feedback',async()=>{
 const f=fixture();try{
  const record=await f.save({content:'Cedar 的端口是 1111。'}),input={id:record.id,revision:record.revision,kind:'relevant',taskContext:context,operationId:'remember-feedback'};
  await f.c.dispatch('feedback',input,f.ctx);const revised=await f.c.dispatch('update',{id:record.id,revision:record.revision,content:'Cedar 的端口更正为 2222。'},f.ctx) as MemoryRecord;
  assert.deepEqual(f.c.snapshot(f.ctx).feedback,[]);await assert.rejects(f.c.dispatch('feedback',{...input,operationId:'stale-feedback'},f.ctx),ConflictError);
  const selected=f.c.select({query:'Cedar',taskContext:context},f.ctx) as any;assert.equal(selected.records[0].revision,revised.revision);assert.equal(selected.records[0].content,revised.content);
  const expired=await f.save({content:'Cedar 的过期事实。',validTo:'2000-01-01'});await assert.rejects(f.c.dispatch('feedback',{id:expired.id,revision:expired.revision,kind:'relevant',taskContext:context},f.ctx),{code:'SOURCE_UNAVAILABLE'});
  assert.ok(!f.c.search({query:'Cedar',taskContext:context},f.ctx).some(record=>record.id===expired.id));
  await f.c.dispatch('feedback',{...input,revision:revised.revision,operationId:'new-feedback'},f.ctx);
  await f.c.dispatch('forget',{id:revised.id,revision:revised.revision},f.ctx);assert.deepEqual(f.c.snapshot(f.ctx).feedback,[]);assert.deepEqual(f.c.search({query:'Cedar',taskContext:context},f.ctx),[]);
  const operation=await f.c.dispatch('operation.get',{operationId:'new-feedback'},f.ctx) as any;assert.equal(operation.result.bodyRemoved,true);assert.equal(operation.result.taskContext,undefined);
  await assert.rejects(f.c.dispatch('feedback',{...input,revision:revised.revision,operationId:'forgotten-feedback'},f.ctx));
  const store=new RecordStore('memory',f.dir);try{assert.equal(store.list('feedback:').length,0);}finally{store.close();}
 }finally{await f.close();}
});


test('source-only changes invalidate frozen dependencies and descendants without retiring either original source',async()=>{
 const f=fixture();try{
  const body='部署前请检查配置。';f.items[0].text=body;f.items.push({...f.items[0],id:'source-b'});
  const events:{name:string;value:any}[]=[];f.ctx.emit=(name,value)=>{events.push({name,value});};
  const record=await f.save({content:body,sources:[{sessionId:'s',entryId:'u'}]});
  const child=await f.save({content:'部署后检查派生结果。',parentIds:[record.id],sources:record.sources});
  const independent=await f.save({content:'独立检查部署配置。',sources:record.sources});
  const host=new RecordStore('source-change-consumer',f.dir),policy=new SourcePolicy(host);
  try{
   const dependency={capability:'memory' as const,id:record.id,version:record.revision,hash:record.hash,relation:'derived-from' as const};
   const frozen=policy.capture({projectId:'p',sources:record.sources,dependencies:[dependency]}),raw=policy.capture({projectId:'p',sources:record.sources}),epoch=Number(f.c.snapshot(f.ctx).epoch);
   const changed=await f.c.dispatch('update',{id:record.id,revision:record.revision,sources:[{sessionId:'s',entryId:'source-b'}]},f.ctx) as MemoryRecord;
   assert.equal(changed.content,body);assert.equal(changed.revision,2);assert.equal(changed.sources[0].entryId,'source-b');assert.equal(changed.status,'active');
   const invalidation=f.c.invalidationSnapshot(f.ctx) as any;assert.equal(invalidation.epoch,epoch+1);assert.ok(invalidation.ids.includes(record.id));assert.ok(invalidation.ids.includes(child.id));assert.deepEqual(invalidation.sources,[]);
   const event=events.find(event=>event.name==='memory.invalidated')!.value;assert.equal(event.reason,'sources-changed');assert.deepEqual(event.sources,[]);
   assert.throws(()=>policy.assert(frozen),{code:'SOURCE_UNAVAILABLE'});assert.doesNotThrow(()=>policy.assert(raw));
   assert.equal((await f.c.dispatch('read',{id:child.id},f.ctx) as MemoryRecord).status,'invalidated');
   assert.equal((await f.c.dispatch('read',{id:independent.id},f.ctx) as MemoryRecord).status,'active');
   const agent={...f.ctx,origin:'agent' as const};assert.equal((await f.c.dispatch('source.read',{source:record.sources[0]},agent) as any).text,body);assert.equal((await f.c.dispatch('source.read',{source:changed.sources[0]},agent) as any).text,body);
   assert.ok(f.c.search({query:'部署'},agent).some(value=>value.id===record.id));assert.ok(!f.c.search({query:'部署'},agent).some(value=>value.id===child.id));
   const store=new RecordStore('memory',f.dir);try{assert.equal(store.list('retired-source:').length,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_suppression').get()!.n,0);}finally{store.close();}
   await f.cold();assert.equal(Number(f.c.snapshot(f.ctx).epoch),epoch+1);assert.ok((f.c.invalidationSnapshot(f.ctx).ids as string[]).includes(record.id));
  }finally{host.close();}
 }finally{await f.close();}
});

test('equivalent source references reordered or relabelled do not invalidate descendants or advance the invalidation epoch',async()=>{
 const f=fixture();try{
  f.items[0].text='部署前请检查配置。';f.items.push({...f.items[0],id:'source-b'});
  const record=await f.save({content:f.items[0].text,sources:[{sessionId:'s',entryId:'u'},{sessionId:'s',entryId:'source-b'}]}),child=await f.save({content:'相关部署检查。',parentIds:[record.id]});
  const epoch=f.c.snapshot(f.ctx).epoch,events:string[]=[];f.ctx.emit=name=>{events.push(name);};
  const changed=await f.c.dispatch('update',{id:record.id,revision:record.revision,sources:[...record.sources].reverse().map(source=>({...source,label:'new display label'}))},f.ctx) as MemoryRecord;
  assert.equal(changed.revision,2);assert.equal(f.c.snapshot(f.ctx).epoch,epoch);assert.ok(!events.includes('memory.invalidated'));assert.equal((await f.c.dispatch('read',{id:child.id},f.ctx) as MemoryRecord).status,'active');
 }finally{await f.close();}
});
