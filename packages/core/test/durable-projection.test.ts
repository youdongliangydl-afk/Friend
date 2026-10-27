import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {durableHistoryItems,historyTypeOf,INPUT_BOUNDARY_KIND,RUNTIME_WAKE_KIND} from '../src/durable-projection.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

test('durable projection keeps the HistoryItem contract the three provenance lines read',()=>{
  const items=durableHistoryItems([
    {id:'1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'帮我改一下这个 bug'}],timestamp:1700000000000}]},
    {id:'2',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'我先读文件'}],timestamp:1700000001000}]},
    {id:'3',kind:'pi.tool-result',model:[{role:'toolResult',toolName:'read',content:[{type:'text',text:'file body'}],timestamp:1700000002000}]},
    {id:'4',kind:'pi.compaction',data:{summary:'早前上下文摘要',timestamp:'2026-10-27T00:00:00.000Z'}},
  ]);
  assert.deepEqual(items.map(item=>item.type),['message','message','message','compaction']);
  assert.deepEqual(items.map(item=>item.role),['user','assistant','toolResult',undefined]);
  assert.equal(items[0].text,'帮我改一下这个 bug');
  assert.equal(items[2].toolName,'read');
  assert.equal(items[0].timestamp,new Date(1700000000000).toISOString());
  assert.equal(items[3].text,'早前上下文摘要');
  assert.equal(items[3].timestamp,'2026-10-27T00:00:00.000Z');
});

test('parentId is explicitly null for every projected row, never a guess',()=>{
  const items=durableHistoryItems([
    {id:'a',kind:'pi.user',model:[{role:'user',content:'x',timestamp:1}]},
    {id:'b',kind:'pi.assistant',model:[{role:'assistant',content:'y',timestamp:2}]},
  ]);
  assert.deepEqual(items.map(item=>item.parentId),[null,null]);
});

test('input boundary only yields userText when the recorded digest still matches',()=>{
  const verified='已核验的用户原文';
  const good=[
    {id:'u1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:verified}],timestamp:1}]},
    {id:'b1',kind:INPUT_BOUNDARY_KIND,data:{entryId:'u1',textEnd:verified.length,hash:sha(verified)}},
  ];
  assert.equal(durableHistoryItems(good)[0].userText,verified);

  const tampered=[
    {id:'u1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'被改过的原文'}],timestamp:1}]},
    {id:'b1',kind:INPUT_BOUNDARY_KIND,data:{entryId:'u1',textEnd:verified.length,hash:sha(verified)}},
  ];
  assert.equal(durableHistoryItems(tampered)[0].userText,undefined);
});

test('runtime wake entries report role custom only when the digest matches current text',()=>{
  const body='自动续跑输入';
  const matched=durableHistoryItems([
    {id:'w1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:body}],timestamp:1}]},
    {id:'m1',kind:RUNTIME_WAKE_KIND,data:{entryId:'w1',hash:sha(body)}},
  ]);
  assert.equal(matched[0].role,'custom');

  const drifted=durableHistoryItems([
    {id:'w1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'后来变了'}],timestamp:1}]},
    {id:'m1',kind:RUNTIME_WAKE_KIND,data:{entryId:'w1',hash:sha(body)}},
  ]);
  assert.equal(drifted[0].role,'user');
});

test('unknown kinds fall back to custom and expose sourceKind when the payload carries it',()=>{
  assert.equal(historyTypeOf('pi.reset'),'custom');
  assert.equal(historyTypeOf('friend-pi.memory.adoption'),'custom');
  assert.equal(historyTypeOf('pi.system'),'message');
  const [item]=durableHistoryItems([{id:'x',kind:'friend-pi.expert.adoption',data:{text:'采用记录',sourceKind:'expert',timestamp:'2026-01-01T00:00:00.000Z'}}]);
  assert.equal(item.type,'custom');
  assert.equal(item.text,'采用记录');
  assert.equal(item.sourceKind,'expert');
  assert.equal(item.role,undefined);
});

test('an entry with no model and no text payload projects to an empty row instead of throwing',()=>{
  const [item]=durableHistoryItems([{id:'e',kind:'app.bookkeeping'}]);
  assert.deepEqual(item,{id:'e',parentId:null,type:'custom',timestamp:'',text:'',userText:undefined,role:undefined});
});
