import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MessageQueue,captureInput} from '../apps/desktop/src/message-queue.js';
import {TODO_TYPE,SIDECHAT_TYPE,projectTodo,todoItems,stableForkLeaf} from '../apps/desktop/src/task-todo.js';
import {toolPermissionRequest} from '../packages/core/src/permissions.js';
import {TaskLedger} from '../packages/core/src/runtime.js';

test('Todo is run-owned native metadata, never inherited active state or inferred completion',()=>{
 const update=(runId:string)=>({type:'custom',customType:TODO_TYPE,data:{v:1,runId,items:[{content:'Read',status:'in_progress'}]}});
 const entries=[{type:'message',id:'user',message:{role:'user',content:'request'}},update('one')];
 assert.equal(projectTodo(entries,'two'),undefined);assert.equal(projectTodo(entries,'one')?.items[0].status,'in_progress');
 assert.equal(projectTodo([...entries,{type:'custom',customType:SIDECHAT_TYPE,data:{v:1}}],'one'),undefined);
 assert.throws(()=>todoItems([{content:'a',status:'pending'},{content:'a',status:'completed'}]),/重复/);
 assert.throws(()=>todoItems([{content:'a',status:'verified'}]),/状态/);
 assert.equal(toolPermissionRequest('friend_todo',{action:'update'},true),undefined);assert.ok(toolPermissionRequest('friend_todo',{action:'execute'},true));
});
test('side chat forks only complete tool chains and omits an incomplete parallel group',()=>{
 const user={type:'message',id:'user',message:{role:'user',content:'task'}},call={type:'message',id:'call',message:{role:'assistant',content:[{type:'toolCall',id:'a'},{type:'toolCall',id:'b'}]}},a={type:'message',id:'a',message:{role:'toolResult',toolCallId:'a'}},b={type:'message',id:'b',message:{role:'toolResult',toolCallId:'b'}};
 assert.equal(stableForkLeaf([user,call,a,{type:'custom',id:'receipt'}]),'user');assert.equal(stableForkLeaf([user,call,a,b]),'b');
});
test('queue preserves immutable attachment payload, revisions, edit leases and fail-closed recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-queue-unit-')),file=join(dir,'source.txt');writeFileSync(file,'original');let queue=new MessageQueue('native',dir);
 try{
  const item=queue.add(captureInput({text:'one',attachments:[{path:file}]}));writeFileSync(file,'changed');assert.match(queue.read(item.id).attachments[0].text!,/original/);
  queue.edit(item.id,item.revision);assert.equal(queue.read(item.id).state,'editing');assert.throws(()=>queue.claim(item.id,item.revision,'run'),/变化/);
  queue.edit(item.id,2,'revised');assert.equal(queue.read(item.id).attachments[0].hash,item.attachments[0].hash);
  queue.claim(item.id,3,'run');assert.throws(()=>queue.remove(item.id,4),/交付/);assert.throws(()=>queue.release(item.id,'child'),/身份/);
  queue.dispose();queue=new MessageQueue('native',dir);queue.recover();assert.equal(queue.snapshot().paused,true);assert.equal(queue.read(item.id).state,'unknown');
  queue.delivered(item.id,'foreign');assert.equal(queue.snapshot().items.length,1);queue.delivered(item.id,'run');assert.equal(queue.snapshot().items.length,0);
 }finally{queue.dispose();rmSync(dir,{recursive:true,force:true});}
});
test('moving an item commits only to its reserved child and never unlocks another dispatch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-queue-move-')),queue=new MessageQueue('s',dir);try{const item=queue.add(captureInput({text:'draft'}));queue.moving(item.id,1,'child');assert.throws(()=>queue.moved(item.id,'other'),/身份/);assert.throws(()=>queue.release(item.id,'other'),/身份/);queue.release(item.id,'child');assert.equal(queue.read(item.id).state,'queued');queue.moving(item.id,3,'child');queue.moved(item.id,'child');assert.equal(queue.snapshot().items.length,0);}finally{queue.dispose();rmSync(dir,{recursive:true,force:true});}
});
test('independent runs cannot reuse another run task or its repair budget',()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-task-runs-')),ledger=new TaskLedger(dir);try{const ctx:any={projectId:'p',sessionId:'s',runId:'one',emit:()=>{},appendEntry:()=>{}},input={title:'Read config',mode:'read'};const first=ledger.create(input,ctx);ledger.claimRepair({logicalStepId:first.logicalStepId},ctx);const other={...ctx,runId:'two'},second=ledger.create(input,other);assert.notEqual(first.id,second.id);assert.equal(second.repairCount,0);assert.equal(ledger.create(input,ctx).id,first.id);assert.equal(ledger.repairCount(first.logicalStepId,ctx),1);ledger.stop(other);assert.equal(ledger.read(first.id,ctx).status,'pending');assert.equal(ledger.read(second.id,other).status,'stopped');}finally{ledger.dispose();rmSync(dir,{recursive:true,force:true});}
});
