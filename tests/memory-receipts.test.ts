import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {memoryInjectionView,memoryReceiptStages,memorySourceText} from '../apps/desktop/src/renderer/memory-receipts.js';

const record=(id:string,extra:Record<string,unknown>={})=>({id,revision:2,hash:`h-${id}`,title:`标题 ${id}`,content:`正文 ${id}`,sources:[{sessionId:'s',entryId:'e1'}],conditions:['条件'],sentSliceHash:`h-${id}`,...extra});
const usage=(stage:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({id:`entry-${stage}`,type:'custom',customType:'friend-pi.memory.usage:v1',data:{v:1,operationId:'op-1',projectId:'p',sessionId:'s',runId:'run-1',at:'2026-01-01T00:00:00.000Z',channel:'context-recall',stage,records:[],directory:[],omitted:[],budget:{unit:'characters',limit:12000,used:0},...extra}});

test('usage receipts dedupe one record across stages and merge them into a single turn',()=>{
 const receipts=[
  usage('prepared',{records:[record('m1'),record('m2')]}),
  usage('injected-to-context',{records:[record('m1')]}),
  usage('request-prepared',{records:[record('m1')]}),
  usage('response-observed',{records:[record('m1')]}),
 ];
 const view=memoryInjectionView(receipts,'run-1');
 assert.equal(view.recorded,true);assert.equal(view.receiptCount,4);assert.equal(view.turns.length,1);
 const turn=view.turns[0];
 assert.equal(turn.runId,'run-1');assert.equal(turn.current,true);assert.equal(turn.receipts,4);assert.deepEqual(turn.operations,['op-1']);
 assert.equal(turn.injected.length,1);assert.equal(turn.injected[0].id,'m1');assert.equal(turn.injected[0].revision,2);assert.equal(turn.injected[0].hash,'h-m1');
 assert.deepEqual(turn.injected[0].stages,['prepared','injected-to-context','request-prepared','response-observed']);
 assert.deepEqual(turn.injected[0].sources,[{sessionId:'s',entryId:'e1'}]);assert.deepEqual(turn.injected[0].conditions,['条件']);
 assert.equal(turn.unused.length,1);assert.equal(turn.unused[0].id,'m2');assert.equal(turn.unused[0].label,'选中未注入');
 assert.match(turn.budget,/本轮正文预算：已用 0 字符 \/ 上限 12000 字符/);
 assert.equal(view.counts.injected,1);assert.equal(view.counts.unused,1);
 assert.deepEqual(memoryReceiptStages(turn.injected[0].stages).map(stage=>stage.label),['已选中','已进入上下文','已进入请求准备','响应已观察']);
 assert.equal(memorySourceText({sessionId:'s',entryId:'e1'}),'s · e1');
});

test('turns merge by runId, keep runs separate and never invent a turn for a missing run id',()=>{
 const receipts=[
  usage('prepared',{runId:'run-1',at:'2026-01-01T00:00:00.000Z',records:[record('m1')]}),
  usage('injected-to-context',{runId:'run-2',at:'2026-01-02T00:00:00.000Z',records:[record('m1')]}),
  usage('prepared',{runId:'unrecorded',records:[record('m9')]}),
  usage('prepared',{runId:undefined,records:[record('m9')]}),
 ];
 const view=memoryInjectionView(receipts,'run-1');
 assert.equal(view.turns.length,3);
 const byRun=(runId:string)=>view.turns.find(turn=>turn.runId===runId)!;
 assert.equal(view.turns[0].runId,'run-2');assert.equal(byRun('run-1').current,true);assert.equal(byRun('').current,false);
 assert.equal(byRun('').label,'轮次未记录');assert.equal(byRun('').receipts,2);assert.equal(byRun('run-2').receipts,1);
 assert.equal(byRun('run-2').injected.length,1);assert.equal(byRun('run-1').unused.length,1);
 assert.equal(byRun('').unused[0].id,'m9');
 assert.equal(memoryInjectionView([], 'run-1').turns.length,0);
});

test('catalog pointers, injected bodies and unused selections stay distinct',()=>{
 const receipts=[usage('injected-to-context',{
  records:[record('m1')],
  directory:[{id:'m1',revision:2,hash:'h-m1',title:'标题 m1',sources:[],conditions:[]},{id:'m2',revision:1,hash:'h2',title:'目录标题',sources:[],conditions:[]}],
  omitted:[{id:'m3',reason:'body-budget',readRef:{revision:4}},{id:'m4',reason:'unknown-reason'}],
 })];
 const turn=memoryInjectionView(receipts,'run-1').turns[0];
 assert.equal(turn.injected[0].catalog,true);assert.equal(turn.injected[0].label,'正文注入');
 assert.equal(turn.catalog.length,1);assert.equal(turn.catalog[0].id,'m2');assert.equal(turn.catalog[0].revision,1);assert.equal(turn.catalog[0].label,'目录指针');
 assert.match(turn.catalog[0].reason,/仅目录可见/);
 assert.equal(turn.unused.length,2);assert.equal(turn.unused.every(entry=>entry.label==='未入选'),true);
 assert.ok(turn.unused.some(entry=>entry.id==='m3'&&entry.revision===4&&entry.reason.includes('正文与完整条件超出预算')));
 assert.ok(turn.unused.some(entry=>entry.id==='m4'&&entry.reason==='unknown-reason'));
 assert.equal(turn.unknown.length,0);
});

test('unknown stages never count as injection while expert receipts and malformed payloads are ignored or reported',()=>{
 const receipts=[
  usage('mystery',{records:[record('m5')]}),
  {id:'x',type:'custom',customType:'friend-pi.expert.adoption',data:{runId:'run-1',stage:'request-prepared',records:[record('foreign')]}},
  {id:'y',type:'custom',customType:'friend-pi.memory.usage:v1',data:{v:1,runId:'run-1',stage:'injected-to-context',records:'not-an-array',directory:[{id:'m6',revision:1,hash:'h6'}],budget:{unit:'characters',limit:null,used:0}}},
  {id:'z',type:'custom',customType:'friend-pi.memory.usage:v1',data:{}},
 ];
 const view=memoryInjectionView(receipts,'run-1');
 assert.equal(view.recorded,true);assert.equal(view.receiptCount,2);
 const turn=view.turns[0];
 assert.equal(turn.injected.length,0);assert.equal(turn.catalog.length,1);assert.equal(turn.catalog[0].id,'m6');
 assert.equal(turn.unknown.length,1);assert.equal(turn.unknown[0].id,'m5');assert.equal(turn.unknown[0].label,'阶段未记录');
 assert.match(turn.note,/阶段未记录/);
 assert.ok(view.warnings.some(warning=>warning.includes('格式未知')));
 assert.ok(view.warnings.some(warning=>warning.includes('缺少数据体')));
 assert.equal([...turn.injected,...turn.catalog,...turn.unused,...turn.unknown].some(entry=>entry.id==='foreign'),false);
 assert.equal(view.reason,'');assert.equal(memoryInjectionView([{customType:'friend-pi.expert.run',data:{stage:'x'}}]).recorded,false);
 assert.match(memoryInjectionView([]).reason,/没有收据不代表没有相关记忆/);
});

test('the receipt panel renders turn groups and an honest empty state without promoting pointers',async()=>{
 const compiled=await build({entryPoints:[fileURLToPath(new URL('../apps/desktop/src/renderer/MemoryReceipts.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react/jsx-runtime'],loader:{'.css':'empty'}});
 const module={exports:{} as {MemoryReceipts:ComponentType<{receipts:unknown;runId?:string;title?:string}>}};
 new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const receipts=[usage('injected-to-context',{records:[record('m1')],directory:[{id:'m2',revision:1,hash:'h2',title:'目录标题'}]})];
 const markup=renderToStaticMarkup(createElement(module.exports.MemoryReceipts,{receipts,runId:'run-1'}));
 for(const text of ['本轮注入了哪些记忆','本轮','正文注入','目录指针','未使用','正文预算','注入回执只证明记录被送入上下文或请求','标题 m1','来源：s · e1','v2'])assert.ok(markup.includes(text),text);
 assert.match(markup,/不证明模型采用/);
 const empty=renderToStaticMarkup(createElement(module.exports.MemoryReceipts,{receipts:[]}));
 assert.match(empty,/尚无记忆注入回执/);assert.match(empty,/没有收据不代表没有相关记忆/);
});
