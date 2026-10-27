import test from 'node:test';
import assert from 'node:assert/strict';
import {importIsLossless,piEntriesToDurableDrafts,piEntryToDurableDraft} from '../src/durable-import.js';
import {durablePiEntries} from '../src/durable-plugin-host.js';

test('messages map by role so provenance keeps working after the import',()=>{
  assert.deepEqual(piEntryToDurableDraft({type:'message',message:{role:'user',content:'hi'}}),{kind:'pi.user',model:[{role:'user',content:'hi'}]});
  assert.equal(piEntryToDurableDraft({type:'message',message:{role:'assistant',content:'ok'}})?.kind,'pi.assistant');
  assert.equal(piEntryToDurableDraft({type:'message',message:{role:'toolResult',content:'x'}})?.kind,'pi.tool-result');
  assert.equal(piEntryToDurableDraft({type:'message',message:{role:'unknown'}}),undefined,'an unknown role is refused, not guessed');
});

test('custom markers keep their customType as the durable kind',()=>{
  assert.deepEqual(piEntryToDurableDraft({type:'custom',customType:'friend-pi.expert.run',data:{v:1,runId:'r'}}),{kind:'friend-pi.expert.run',data:{v:1,runId:'r'}});
  assert.equal(piEntryToDurableDraft({type:'custom'}),undefined,'a custom row without customType is refused');
});

test('custom_message keeps its payload under data because durable has one payload channel',()=>{
  assert.deepEqual(
    piEntryToDurableDraft({type:'custom_message',customType:'friend-pi.goal-wake',content:'及时继续',details:{v:1}}),
    {kind:'friend-pi.goal-wake',data:{content:'及时继续',details:{v:1}}},
  );
});

test('compaction and branch summary survive, and the summary is counted separately',()=>{
  assert.deepEqual(piEntryToDurableDraft({type:'compaction',summary:'早前摘要'}),{kind:'pi.compaction',data:{summary:'早前摘要'}});
  const result=piEntriesToDurableDrafts([
    {type:'compaction',summary:'a'},
    {type:'branch_summary',summary:'b'},
  ]);
  assert.equal(result.branchSummaries,1,'branch summary has no durable equivalent and is reported');
  assert.equal(result.skipped.length,0);
  assert.deepEqual(result.drafts.map(draft=>draft.kind),['pi.compaction','friend-pi.branch-summary']);
});

test('unknown rows are skipped and reported rather than silently dropped',()=>{
  const result=piEntriesToDurableDrafts([
    {type:'message',message:{role:'user',content:'a'}},
    {type:'something_new',id:'x1'},
    {type:'message',message:{role:'user',content:'b'}},
  ]);
  assert.equal(result.drafts.length,2,'the importable rows are still converted');
  assert.deepEqual(result.skipped,[{index:1,type:'something_new',id:'x1'}]);
  assert.equal(importIsLossless(result),false,'a skip makes the import lossy');
});

test('duplicate ids are reported so the gate can refuse instead of corrupting references',()=>{
  const result=piEntriesToDurableDrafts([
    {id:'e1',type:'message',message:{role:'user',content:'a'}},
    {id:'e1',type:'message',message:{role:'user',content:'b'}},
  ]);
  assert.deepEqual(result.duplicateIds,['e1']);
  assert.equal(importIsLossless(result),false);
});

test('a clean transcript reports a lossless import',()=>{
  const result=piEntriesToDurableDrafts([
    {id:'1',type:'message',message:{role:'user',content:'a'}},
    {id:'2',type:'message',message:{role:'assistant',content:'b'}},
    {id:'3',type:'custom',customType:'friend-pi.input.v1',data:{entryId:'1',textEnd:1,hash:'h'}},
  ]);
  assert.equal(importIsLossless(result),true);
  assert.equal(result.drafts.length,3);
});

test('imported drafts project back to the same Pi entry shape they came from',()=>{
  const source=[
    {id:'1',type:'message',message:{role:'user',content:[{type:'text',text:'原话'}],timestamp:1700000000000}},
    {id:'2',type:'custom',customType:'friend-pi.expert.run',data:{v:1,runId:'r'}},
  ];
  const {drafts}=piEntriesToDurableDrafts(source);
  const projected=durablePiEntries(drafts.map((draft,index)=>({
    id:String(index+1),
    kind:draft.kind,
    ...(draft.model===undefined?{}:{model:draft.model}),
    ...(draft.data===undefined?{}:{data:draft.data}),
  })));
  assert.deepEqual(projected.map(entry=>entry.type),['message','custom']);
  assert.equal(projected[1].customType,'friend-pi.expert.run','the marker survives a full round trip');
  assert.deepEqual(projected[1].data,{v:1,runId:'r'});
});
