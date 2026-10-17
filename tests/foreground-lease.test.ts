import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordStore } from '../packages/core/src/index.js';
import {
  FOREGROUND_LEASE_TTL_MS, FOREGROUND_LEASE_VERSION,
  foregroundBusy, readForegroundLeases, writeForegroundLease,
} from '../apps/desktop/src/foreground-lease.js';

const NOW = 1_700_000_000_000;
const DEAD_PID = 2147483647;

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-foreground-lease-'));
  const store=new RecordStore('runtime',dir);
  return {dir,store,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('v2 lease writes the versioned contract and reads back normalized',()=>{
  const f=fixture();try{
    assert.equal(FOREGROUND_LEASE_VERSION,2);
    const lease=writeForegroundLease(f.store,{pid:process.pid,sessionId:'session-a',runId:'run-1',active:true},NOW);
    assert.deepEqual(lease,{v:2,kind:'foreground',sessionId:'session-a',pid:process.pid,runId:'run-1',active:true,heartbeatAt:new Date(NOW).toISOString(),expiresAt:NOW+FOREGROUND_LEASE_TTL_MS});
    const stored=f.store.get<Record<string,unknown>>('foreground:session-a')!.value;
    assert.deepEqual(stored,lease);
    const leases=readForegroundLeases(f.store,NOW);
    assert.equal(leases.length,1);assert.deepEqual(leases[0],lease);
    assert.equal(foregroundBusy(f.store,NOW),true);
  }finally{f.close();}
});

test('v1 rows written by the previous worker remain readable',()=>{
  const f=fixture();try{
    f.store.put('foreground:legacy',{pid:process.pid,active:true,runId:'legacy-run',expiresAt:NOW+5000});
    const leases=readForegroundLeases(f.store,NOW);
    assert.equal(leases.length,1);
    assert.deepEqual(leases[0],{v:2,kind:'foreground',pid:process.pid,sessionId:'legacy',runId:'legacy-run',active:true,heartbeatAt:new Date(NOW+5000-FOREGROUND_LEASE_TTL_MS).toISOString(),expiresAt:NOW+5000});
    assert.equal(foregroundBusy(f.store,NOW),true);
    // V1 without runId also normalizes.
    f.store.put('foreground:legacy-2',{pid:process.pid,active:false,expiresAt:NOW+5000});
    const both=readForegroundLeases(f.store,NOW);assert.equal(both.length,2);assert.equal(both.find(item=>item.sessionId==='legacy-2')!.runId,undefined);
  }finally{f.close();}
});

test('expired leases are ignored by both readers and busy checks',()=>{
  const f=fixture();try{
    writeForegroundLease(f.store,{pid:process.pid,sessionId:'stale-v2',active:true},NOW);
    f.store.put('foreground:stale-v1',{pid:process.pid,active:true,expiresAt:NOW+1});
    assert.deepEqual(readForegroundLeases(f.store,NOW+FOREGROUND_LEASE_TTL_MS),[]);
    assert.equal(foregroundBusy(f.store,NOW+FOREGROUND_LEASE_TTL_MS),false);
    assert.equal(readForegroundLeases(f.store,NOW).length,2);
    assert.equal(foregroundBusy(f.store,NOW),true);
  }finally{f.close();}
});

test('an inactive lease never blocks the learning host',()=>{
  const f=fixture();try{
    writeForegroundLease(f.store,{pid:process.pid,sessionId:'idle-session',active:false},NOW);
    assert.equal(foregroundBusy(f.store,NOW),false);
    assert.equal(readForegroundLeases(f.store,NOW).length,1);
    f.store.put('foreground:legacy-idle',{pid:process.pid,active:false,runId:'r',expiresAt:NOW+1000});
    assert.equal(foregroundBusy(f.store,NOW),false);
  }finally{f.close();}
});

test('an active lease from a dead process never blocks a cross-process reader',()=>{
  const f=fixture();try{
    writeForegroundLease(f.store,{pid:DEAD_PID,sessionId:'dead-session',runId:'dead',active:true},NOW);
    assert.equal(readForegroundLeases(f.store,NOW).length,1);
    assert.equal(foregroundBusy(f.store,NOW),false);
    // The current process is alive and therefore does block.
    writeForegroundLease(f.store,{pid:process.pid,sessionId:'live-session',runId:'live',active:true},NOW);
    assert.equal(foregroundBusy(f.store,NOW),true);
  }finally{f.close();}
});

test('a 5s heartbeat refresh extends the lease past its original expiry',()=>{
  const f=fixture();try{
    const first=writeForegroundLease(f.store,{pid:process.pid,sessionId:'heartbeat',active:true},NOW);
    const refreshed=writeForegroundLease(f.store,{pid:process.pid,sessionId:'heartbeat',runId:'run-2',active:true},NOW+5000);
    assert.equal(refreshed.heartbeatAt,new Date(NOW+5000).toISOString());
    assert.equal(refreshed.expiresAt,first.expiresAt+5000);
    // One row per session: refresh replaces, never accumulates.
    assert.equal(readForegroundLeases(f.store,NOW+5000).length,1);
    // The original expiry would have passed; the refreshed lease still blocks.
    assert.equal(foregroundBusy(f.store,NOW+FOREGROUND_LEASE_TTL_MS+1),true);
    assert.equal(foregroundBusy(f.store,refreshed.expiresAt),false);
  }finally{f.close();}
});

test('multiple sessions: one live lease is enough, stale or dead ones are ignored',()=>{
  const f=fixture();try{
    writeForegroundLease(f.store,{pid:DEAD_PID,sessionId:'dead',active:true},NOW);
    f.store.put('foreground:stale',{pid:process.pid,active:true,expiresAt:NOW-100});
    assert.equal(foregroundBusy(f.store,NOW),false);
    writeForegroundLease(f.store,{pid:process.pid,sessionId:'alive-b',active:true},NOW);
    writeForegroundLease(f.store,{pid:process.pid,sessionId:'alive-a',active:true},NOW);
    assert.equal(foregroundBusy(f.store,NOW),true);
    // Dead-PID leases are readable metadata; only foregroundBusy applies liveness.
    assert.deepEqual(readForegroundLeases(f.store,NOW).map(item=>item.sessionId),['alive-a','alive-b','dead']);
  }finally{f.close();}
});

test('malformed or unknown-version rows are ignored instead of blocking work',()=>{
  const f=fixture();try{
    f.store.put('foreground:broken',{});
    f.store.put('foreground:bad-pid',{v:2,kind:'foreground',pid:'not-a-number',sessionId:'bad-pid',active:true,expiresAt:NOW+1000});
    f.store.put('foreground:bad-expiry',{v:2,kind:'foreground',pid:process.pid,sessionId:'bad-expiry',active:true,expiresAt:'soon'});
    f.store.put('foreground:future',{v:99,kind:'foreground',pid:process.pid,sessionId:'future',active:true,expiresAt:NOW+1000});
    f.store.put('foreground:not-object','text-row');
    assert.deepEqual(readForegroundLeases(f.store,NOW),[]);
    assert.equal(foregroundBusy(f.store,NOW),false);
  }finally{f.close();}
});

test('write validation rejects unusable leases before they can block a host',()=>{
  const f=fixture();try{
    assert.throws(()=>writeForegroundLease(f.store,{pid:0,sessionId:'s',active:true}),/pid/);
    assert.throws(()=>writeForegroundLease(f.store,{pid:1.5,sessionId:'s',active:true}),/pid/);
    assert.throws(()=>writeForegroundLease(f.store,{pid:process.pid,sessionId:'',active:true}),/sessionId/);
    assert.throws(()=>writeForegroundLease(f.store,{pid:process.pid,sessionId:'s',active:'yes' as unknown as boolean}),/active/);
    assert.throws(()=>writeForegroundLease(f.store,{pid:process.pid,sessionId:'s',active:true,runId:7 as unknown as string}),/runId/);
  }finally{f.close();}
});
