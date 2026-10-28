import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {openNodeSqliteStorage} from '@earendil-works/pi-durable/storage/sqlite/node';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {createBus,installFixtureProvider} from '../src/index.js';
import {openDurableSession} from '../src/durable-session.js';
import {openDurableReadOnly} from '../src/durable-readonly.js';

async function durableSessionFile(){
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-readonly-'));
  const file=join(dir,'session.sqlite');
  const runtime=await ModelRuntime.create({allowModelNetwork:false});
  await installFixtureProvider(runtime);
  const storage=await openNodeSqliteStorage(file);
  const harness=await Harness.open(storage,{models:runtime,registry:createRegistry()},BACKGROUND_CONTEXT);
  const root=await harness.root(BACKGROUND_CONTEXT,{agent:{model:{provider:'friend-fixture',modelId:'offline'}}});
  await (await root.submit({type:'input',content:'readonly source'},BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  return {dir,file,runtime,harness};
}

test('another session can be read while its writer still owns the storage',async()=>{
  const {dir,file,harness}=await durableSessionFile();
  try{
    // The writer harness is still open: this is the case that matters, because provenance reads
    // happen while the peer session is running, not after it closes.
    const reader=openDurableReadOnly(file);
    try{
      const entries=reader.entries();
      assert.ok(entries.length>=2,'entries are readable through a read-only connection');
      const roles=entries.map(entry=>(entry.message as {role?:string} | undefined)?.role);
      assert.ok(roles.includes('user'),'the peer user input is visible');
      assert.ok(roles.includes('assistant'),'the peer answer is visible');
      assert.deepEqual(entries.map(entry=>entry.parentId),entries.map(()=>null),'no fabricated parent links');
      assert.ok(reader.schemaVersion>=1,'the file reports its own schema version');
    }finally{reader.close();}
  }finally{await harness.close(BACKGROUND_CONTEXT);rmSync(dir,{recursive:true,force:true});}
});

test('a custom marker written by the peer keeps its customType when read across sessions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-readonly2-'));
  const file=join(dir,'session.sqlite');
  try{
    const runtime=await ModelRuntime.create({allowModelNetwork:false});
    await installFixtureProvider(runtime);
    const session=await openDurableSession({
      cwd:dir,
      storage:await openNodeSqliteStorage(file),
      models:runtime,
      registry:createRegistry(),
      bus:createBus(),
      confirm:async()=>true,
      notify:()=>undefined,
      agent:{model:{provider:'friend-fixture',modelId:'offline'}},
    });
    await session.sessionManager.appendCustomEntry('friend-pi.expert.run',{v:1,runId:'r-peer'});

    const reader=openDurableReadOnly(file);
    try{
      const marker=reader.entries().find(entry=>entry.customType==='friend-pi.expert.run');
      assert.ok(marker,'the peer marker is readable across sessions');
      assert.equal(marker?.type,'custom');
      assert.deepEqual(marker?.data,{v:1,runId:'r-peer'});
    }finally{reader.close();}
    await session.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a missing or foreign file is refused instead of read as empty history',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-readonly3-'));
  try{
    assert.throws(()=>openDurableReadOnly(join(dir,'absent.sqlite')),/不是可读的|no such table|unable to open/i);
    const other=join(dir,'other.sqlite');
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(other);
    db.exec('CREATE TABLE unrelated (x INTEGER)');
    db.close();
    assert.throws(()=>openDurableReadOnly(other),/不是可读的 Pi Durable 存储/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
