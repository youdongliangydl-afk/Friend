import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueueMessages} from '../apps/desktop/src/renderer/QueueMessages.js';
import type {QueuedInput} from '../apps/desktop/src/message-queue.js';

type Queue = Parameters<typeof QueueMessages>[0]['queue'];
const render = (queue:Queue,menuId?:string)=>renderToStaticMarkup(React.createElement(QueueMessages,{queue,ui:{menuId},act:async()=>({}),setUi(){}}));
const item = (state:QueuedInput['state']='queued'):QueuedInput=>({id:'pending',revision:1,state,text:'继续分析原问题',attachments:[],mode:'single',planMode:false,createdAt:'2026-10-12T00:00:00.000Z'});

test('empty queues stay hidden even when shutdown left the queue paused',()=>{
 assert.equal(render(undefined),'');
 for(const paused of [false,true]){
  const queue={paused,items:[]};
  assert.equal(render(queue),'');
  assert.deepEqual(queue,{paused,items:[]});
 }
});

test('real queued messages retain their paused state and resume control',()=>{
 for(const paused of [false,true]){
  const html=render({paused,items:[item()]});
  assert.match(html,/1 条排队消息/);assert.match(html,/继续分析原问题/);assert.match(html,/↪ 引导/);
  if(paused){assert.match(html,/已暂停/);assert.match(html,/>恢复排队<\/button>/);}
  else assert.doesNotMatch(html,/已暂停|恢复排队/);
 }
});

test('unknown deliveries remain visible for reconciliation without an automatic resend control',()=>{
 const html=render({paused:true,items:[item('unknown')]},'pending');
 assert.match(html,/发送状态待确认/);assert.match(html,/已暂停/);assert.match(html,/>恢复排队<\/button>/);
 assert.match(html,/<button disabled="">编辑消息<\/button>/);assert.doesNotMatch(html,/↪ 引导/);
 assert.match(html,/删除排队消息 继续分析原问题/);assert.match(html,/在独立会话中打开/);
});

test('ordinary queued input never claims that it detached and will restore the Goal',()=>{
 const html=render({paused:false,items:[item()]});
 assert.match(html,/继续分析原问题/);assert.doesNotMatch(html,/队列完成后恢复原目标|queue-return/);
});

test('legacy suspended goal metadata does not invent a paused queue or duplicate the GoalBar',()=>{
 for(const paused of [false,true])assert.equal(render({paused,items:[],suspendedGoal:{objective:'完成原目标'}}),'');
});
