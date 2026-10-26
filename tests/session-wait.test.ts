import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {sessionWait,sessionWaits,sessionWaitColors,sessionWaitLabels,type WaitActivity} from '../apps/desktop/src/renderer/session-wait.js';
import {ProjectSidebar,sidebarSessions,type ProjectSidebarProps} from '../apps/desktop/src/renderer/ProjectSidebar.js';

type TestActivity=WaitActivity&{unseen:boolean};
const card=(kind:string,sessionId='s',activityKind:'dialog'|'running'='dialog'):TestActivity=>({sessionId,kind:activityKind,status:'waiting',unseen:false,...(activityKind==='dialog'?{dialog:{id:kind,kind:kind as any,title:'请处理'}}:{})});
const running=(sessionId='s'):TestActivity=>({sessionId,kind:'running',status:'running',unseen:false});

test('permission and confirmation cards derive the confirm state before any answer card',()=>{
 const wait=sessionWait({id:'s',status:'running'},[card('confirm'),card('questionBatch')]);
 assert.equal(wait?.kind,'confirm');assert.equal(wait.label,'待确认');assert.equal(wait.detail,'权限或确认卡等待你处理');
 assert.deepEqual(wait?.tone,sessionWaitColors.confirm);
 assert.equal(sessionWait({id:'s'},[card('confirm')])?.kind,'confirm');
 assert.equal(sessionWait({id:'s'},[card('confirm')])?.label,sessionWaitLabels.confirm);
});
test('question, input, select and editor cards all derive the answer state',()=>{
 for(const kind of ['questionBatch','input','select','editor'])assert.equal(sessionWait({id:'s'},[card(kind)])?.kind,'question',kind);
 assert.equal(sessionWait({id:'s'},[card('questionBatch')])?.label,'待回答');
 assert.equal(sessionWait({id:'s'},[card('questionBatch')])?.kind,'question');
});
test('a proposed plan is a review state that outranks a running indicator',()=>{
 assert.equal(sessionWait({id:'s',status:'running',planStatus:'proposed'},[])?.kind,'review');
 assert.equal(sessionWait({id:'s',status:'running',planStatus:'proposed'},[])?.label,'待审核');
 assert.equal(sessionWait({id:'s',status:'running',planStatus:'proposed'},[running()])?.kind,'review');
 assert.equal(sessionWait({id:'s',status:'running',planStatus:'proposed'},[card('questionBatch')])?.kind,'question');
 // awaiting_review is a Swarm graph state, not a plan approval: it must not claim a plan is waiting.
 assert.equal(sessionWait({id:'s',status:'awaiting_review'},[])?.kind,'running');
});
test('running snapshots and running activities show the progress state',()=>{
 for(const status of ['running','rebuilding','stopping'])assert.equal(sessionWait({id:'s',status},[])?.kind,'running',status);
 assert.equal(sessionWait({id:'s',status:'idle'},[running()])?.kind,'running');
 assert.equal(sessionWait({id:'s',status:'running'},[card('confirm')])?.kind,'confirm');
 assert.equal(sessionWait({id:'s',status:'running'},[])?.label,'进行中');
});
test('idle, completed and failed snapshots have no waiting pill and other sessions are ignored',()=>{
 for(const status of ['idle','completed','failed','stopped','unread_completed','unread_failed'])assert.equal(sessionWait({id:'s',status},[]),undefined,status);
 assert.deepEqual(sessionWait({id:'s',status:'running'},[card('confirm','other'),running('other')]),sessionWait({id:'s',status:'running'},[]));
 assert.equal(sessionWait({id:'s',status:'idle'},[card('confirm','other')]),undefined);
});
test('a projected awaiting_user snapshot without card details falls back to confirm',()=>{
 assert.equal(sessionWait({id:'s',status:'awaiting_user'},[])?.kind,'confirm');
});
test('sessionWaits derives only the waiting sessions without mutating its inputs',()=>{
 const sessions=[{id:'a',status:'idle'},{id:'b',status:'running'},{id:'c',status:'running',planStatus:'proposed'},{id:'d',status:'completed'},{id:'e',status:'idle'}];
 const activities=[card('confirm','a'),running('b'),card('input','d')];
 const snapshot=JSON.stringify({sessions,activities});
 const waits=sessionWaits(sessions,activities);
 assert.deepEqual(Object.keys(waits).sort(),['a','b','c','d']);
 assert.equal(waits.a.kind,'confirm');assert.equal(waits.b.kind,'running');assert.equal(waits.c.kind,'review');assert.equal(waits.d.kind,'question');assert.equal(waits.e,undefined);
 assert.equal(JSON.stringify({sessions,activities}),snapshot);
});

const projects=[{id:'p',name:'项目',path:'/project'}];
const sessions=[{id:'confirm',projectId:'p',name:'等待确认',path:'/a.jsonl',updatedAt:'2026-10-01T00:00:00Z',status:'running'},{id:'review',projectId:'p',name:'等待计划',path:'/b.jsonl',updatedAt:'2026-10-01T00:00:00Z',status:'running',planStatus:'proposed'},{id:'question',projectId:'p',name:'等待回答',path:'/c.jsonl',updatedAt:'2026-10-01T00:00:00Z',status:'awaiting_user'},{id:'running',projectId:'p',name:'执行中',path:'/d.jsonl',updatedAt:'2026-10-01T00:00:00Z',status:'running'},{id:'idle',projectId:'p',name:'空闲',path:'/e.jsonl',updatedAt:'2026-10-01T00:00:00Z',status:'idle'}];
const activities=[card('confirm','confirm'),card('questionBatch','question'),running('running')];
const render=(overrides:Partial<ProjectSidebarProps>={})=>renderToStaticMarkup(React.createElement(ProjectSidebar,{projects,sessions:sidebarSessions(sessions,activities),wait:sessionWaits(sessions,activities),onProject(){},onSession(){},onMenu(){},onReorder(){},onNewSession(){},onReorderSessions(){},...overrides}));
const row=(markup:string,name:string)=>markup.slice(markup.indexOf('title="'+name+'"'),markup.indexOf('</li>',markup.indexOf('title="'+name+'"')));

test('the sidebar renders one waiting pill per waiting session and keeps the status dot',()=>{
 const markup=render();
 assert.match(row(markup,'等待确认'),/class="session-wait wait-confirm" data-wait="confirm" role="img" aria-label="在等你：待确认" title="权限或确认卡等待你处理"/);
 assert.match(row(markup,'等待计划'),/class="session-wait wait-review"[^>]*aria-label="在等你：待审核"/);
 assert.match(row(markup,'等待回答'),/class="session-wait wait-question"[^>]*aria-label="在等你：待回答"/);
 assert.match(row(markup,'执行中'),/class="session-wait wait-running"[^>]*aria-label="在等你：进行中"/);
 assert.doesNotMatch(row(markup,'空闲'),/session-wait/);
 assert.match(row(markup,'执行中'),/role="img" aria-label="正在执行"/);
 const tone=sessionWaitColors.question;
 assert.match(row(markup,'等待回答'),new RegExp('background:'+tone.background.replace('#','#')+';color:'+tone.color));
});
test('a sidebar without a wait map keeps its previous markup',()=>{
 const markup=render({wait:undefined});
 assert.doesNotMatch(markup,/session-wait/);
 assert.match(markup,/title="等待确认"/);
});
