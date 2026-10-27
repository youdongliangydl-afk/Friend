import test from 'node:test';
import assert from 'node:assert/strict';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {Harness,MemoryStorage,createRegistry,type EntryRecord} from '@earendil-works/pi-durable';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {installFixtureProvider} from '../src/index.js';
import {durablePiEntries} from '../src/durable-plugin-host.js';

/**
 * Proves the swap is possible at all: Pi Durable's own harness drives a model turn through the
 * `ModelRuntime` this project already owns (it implements pi-ai's `Models`), using the explicit
 * offline fixture provider. No real model and no network are involved.
 */
test('pi-durable harness runs a turn on the existing ModelRuntime and the offline fixture provider',async()=>{
  const runtime=await ModelRuntime.create({allowModelNetwork:false});
  const model=await installFixtureProvider(runtime);
  assert.ok(model,'the offline fixture provider is registered');
  assert.equal(model.provider,'friend-fixture');

  const harness=await Harness.open(new MemoryStorage(),{models:runtime,registry:createRegistry()},BACKGROUND_CONTEXT);
  try{
    const root=await harness.root(BACKGROUND_CONTEXT,{agent:{model:{provider:'friend-fixture',modelId:'offline'}}});
    const submission=await root.submit({type:'input',content:'hello from the durable backend'},BACKGROUND_CONTEXT);
    const settled=await submission.wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status,'done','the run settles instead of hanging');

    const page=await root.entries({},100,undefined,BACKGROUND_CONTEXT);
    const items=page.items as readonly EntryRecord[];
    const kinds=items.map(entry=>entry.kind);
    assert.ok(kinds.includes('pi.user'),'the submitted input is stored');
    assert.ok(kinds.includes('pi.assistant'),'the model answer is stored');
    for(const entry of items) assert.ok(Array.isArray(entry.model)&&entry.model.length>0,'each entry carries its model messages');

    // Durable scans newest-first. History consumers expect chronological order, so the adapter has
    // to reverse; asserting the direction here keeps that contract from being assumed wrongly.
    assert.equal(items[0]?.kind,'pi.assistant','entries come back newest-first');
    const chronological=durablePiEntries([...items].reverse());
    assert.equal(chronological[0]?.type,'message');
    assert.equal((chronological[0]?.message as {role:string}).role,'user');
    assert.deepEqual(chronological.map(entry=>entry.parentId),[null,null]);
  }finally{await harness.close(BACKGROUND_CONTEXT);}
});
