import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RecordStore,requireSchemaWriter,LearningBudget,SourcePolicy} from '../src/index.js';

test('writer upgrade fences old documents and tables without a metadata downgrade reopening them',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-writer-v4-')),store=new RecordStore('memory',dir);
 let legacy:DatabaseSync|undefined;
 try{
  store.db.exec('CREATE TABLE memory_jobs(id TEXT PRIMARY KEY,json TEXT)');
  requireSchemaWriter(store,'memory',3,['memory_jobs']);
  // A later table fence may be newer than both the metadata and early document fences.
  store.db.exec("DROP TRIGGER friend_memory_jobs_writer_delete;CREATE TRIGGER friend_memory_jobs_writer_delete BEFORE DELETE ON memory_jobs BEGIN SELECT CASE WHEN friend_pi_writer_version()<4 THEN RAISE(ABORT,'Friend data requires a newer writer') END; END;");
  requireSchemaWriter(store,'memory',3,['memory_jobs']);
  requireSchemaWriter(store,'memory',4,['memory_jobs']);
  store.put('job',{proposalLedger:[]});
  legacy=new DatabaseSync(join(dir,'plugins.sqlite'));legacy.function('friend_pi_writer_version',()=>3);
  assert.throws(()=>legacy!.prepare("UPDATE documents SET json='{}' WHERE namespace='memory'").run(),/newer writer/);
  assert.throws(()=>legacy!.prepare("INSERT INTO memory_jobs VALUES('old','{}')").run(),/newer writer/);
  requireSchemaWriter(store,'memory',3,['memory_jobs']);
  assert.throws(()=>legacy!.prepare("DELETE FROM documents WHERE namespace='memory'").run(),/newer writer/);
  store.put('job',{proposalLedger:[{id:'saved'}]});
  const row=store.db.prepare("SELECT json FROM documents WHERE namespace='schema-policy' AND key='memory'").get();
  assert.equal(JSON.parse(String(row?.json)).minWriter,4);
  assert.equal(store.get<{proposalLedger:unknown[]}>('job')?.value.proposalLedger.length,1);
 }finally{legacy?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('an explicit budget increase preserves cumulative calls and unknown receipts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-budget-increase-')),store=new RecordStore('runtime',dir);
 try{const ledger=new LearningBudget(store),budget=ledger.create({projectId:'p',sourceRunId:'r',maxCalls:1}),call=ledger.begin({budgetId:budget.budgetId,operationId:'uncertain',promptHash:'a'});ledger.finish({budgetId:budget.budgetId,operationId:'uncertain',callId:call.callId,state:'unknown'});assert.throws(()=>ledger.begin({budgetId:budget.budgetId,operationId:'next',promptHash:'b'}));const next=ledger.increaseLimit(budget.budgetId,2);assert.equal(next.calls,1);assert.equal(next.usageUnknown,true);assert.equal(ledger.readCall(budget.budgetId,'uncertain')?.state,'unknown');assert.throws(()=>ledger.increaseLimit(budget.budgetId,1));assert.equal(ledger.increaseLimit(budget.budgetId,2).calls,1);ledger.begin({budgetId:budget.budgetId,operationId:'new',promptHash:'b'});assert.equal(ledger.read(budget.budgetId).calls,2);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
});


test('an expired source fence renews only with unchanged authority and cannot revive withdrawn dependencies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-fence-renew-')),store=new RecordStore('runtime',dir),originalNow=Date.now;
 try{const policy=new SourcePolicy(store),dependency={capability:'expert' as const,projectId:'p',id:'method',version:1,hash:'hash',valid:true};policy.publishDependency(dependency);const fence=policy.capture({projectId:'p',sources:[],dependencies:[{...dependency,relation:'adopted'}]});Date.now=()=>originalNow()+3*60*60*1000;assert.throws(()=>policy.assert(fence),/过期/);const renewed=policy.renew(fence);assert.notEqual(renewed.id,fence.id);assert.deepEqual(renewed.states,fence.states);policy.assert(renewed);assert.throws(()=>policy.renew({...fence,policyEpoch:999}),/不匹配/);policy.publishDependency({...dependency,valid:false});assert.throws(()=>policy.renew(fence),/撤回|变化|不可用/);}finally{Date.now=originalNow;store.close();rmSync(dir,{recursive:true,force:true});}
});
