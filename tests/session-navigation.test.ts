import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionNavigation} from '../apps/desktop/src/session-navigation.js';
import {orderedSessions,validateSessionOrder} from '../apps/desktop/src/session-order.js';

test('navigation traversal preserves empty-project routes and truncates future only on a new visit',()=>{
 const history=new SessionNavigation({projectId:'empty',sessionId:null}),all=()=>true;
 history.visit({projectId:'empty',sessionId:'a'});history.visit({projectId:'b',sessionId:'b'});
 const b=history.target(-1,all)!;assert.deepEqual(b.route,{projectId:'empty',sessionId:'a'});assert.equal(history.commit(b),true);
 const empty=history.target(-1,all)!;assert.deepEqual(empty.route,{projectId:'empty',sessionId:null});history.commit(empty);
 assert.equal(history.target(-1,all),undefined);assert.equal(history.target(1,all)?.route.sessionId,'a');
 history.visit({projectId:'empty',sessionId:null});assert.equal(history.target(1,all)?.route.sessionId,'a');
 history.visit({projectId:'c',sessionId:'c'});assert.equal(history.target(1,all),undefined);assert.equal(history.commit(b),false);
});
test('failed or deleted navigation targets do not move the cursor and stale targets cannot select a new entry',()=>{
 const history=new SessionNavigation({projectId:'p',sessionId:'a'});history.visit({projectId:'p',sessionId:'deleted'});history.visit({projectId:'p',sessionId:'c'});
 const prior=history.target(-1,route=>route.sessionId!=='deleted')!;assert.equal(prior.route.sessionId,'a');assert.equal(history.target(1,()=>true),undefined);
 // A failed host lookup never commits the target.
 assert.equal(history.target(-1,route=>route.sessionId!=='deleted')?.id,prior.id);history.commit(prior);
 const stale=history.target(1,()=>true)!;history.visit({projectId:'p',sessionId:'new'});assert.equal(history.commit(stale),false);
});
test('session ordering persists manual positions across activity updates and rejects incomplete or foreign scopes',()=>{
 const records=[{id:'a',projectId:'p',updatedAt:'1'},{id:'b',projectId:'p',updatedAt:'2'},{id:'foreign',projectId:'q',updatedAt:'3'}];
 assert.deepEqual(orderedSessions(records.slice(0,2)).map(x=>x.id),['b','a']);
 const order=validateSessionOrder(records,'p',['a','b']);assert.deepEqual(orderedSessions([{...records[1],updatedAt:'9'},records[0]],order).map(x=>x.id),['a','b']);
 assert.deepEqual(orderedSessions([...records.slice(0,2),{id:'new',projectId:'p',updatedAt:'3'}],order).map(x=>x.id),['new','a','b']);
 for(const ids of [['a'],['a','a'],['a','foreign'],['a',2],['a','b','deleted']])assert.throws(()=>validateSessionOrder(records,'p',ids),/列表已变化/);
 assert.throws(()=>validateSessionOrder(records,undefined,[]),/项目无效/);
});
