import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SessionMetricRecorder,projectSessionMonitor,SESSION_METRIC_TYPE,type StepMetric} from '../apps/desktop/src/session-monitor.js';
import {SessionStats} from '../apps/desktop/src/renderer/SessionStats.js';
import {cachePercent,compactTokens,decodeSpeed,statsPanelPosition} from '../apps/desktop/src/renderer/stats-format.js';
const message=(id:string,role:string,parentId:string|null=null,durationMs?:number)=>({type:'message',id,parentId,message:{role,durationMs}});
const record=(metric:StepMetric)=>({type:'custom',customType:SESSION_METRIC_TYPE,data:metric});
test('decode TPS excludes recorded TTFT and retries remain one logical step',()=>{
 let clock=0;const recorder=new SessionMetricRecorder(()=>clock);
 recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});clock=800;
 const failed=recorder.observe({type:'message_end',message:{role:'assistant',stopReason:'error',usage:{output:0}}})!;
 assert.equal(recorder.observe({type:'turn_end'})?.closed,false);assert.equal(recorder.observe({type:'agent_end',willRetry:true})?.closed,false);
 const backingOff=recorder.observe({type:'auto_retry_start'})!;assert.equal(backingOff.closed,false);assert.equal(projectSessionMonitor([message('a1','assistant'),record({...backingOff,entryId:'a1'})],{},undefined).steps,0);
 clock=1000;recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});
 clock=2000;recorder.observe({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:''}});clock=2200;recorder.observe({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'reason'}});
 clock=5200;recorder.observe({type:'message_end',message:{role:'assistant',usage:{output:60}}});clock=9000;const success=recorder.observe({type:'turn_end'})!;
 assert.equal(success.stepId,failed.stepId);assert.equal(success.turnId,failed.turnId);assert.deepEqual([success.llmMs,success.ttftMs,success.decodeMs],[5200,2200,3000]);
 const stats=projectSessionMonitor([message('u','user'),message('a1','assistant','u'),record({...failed,entryId:'a1'}),message('a2','assistant','a1'),record({...success,entryId:'a2'})],{tokens:{input:10,output:60,cacheRead:90,cacheWrite:0}},undefined);
 assert.deepEqual([stats.turns,stats.steps,stats.llmMs,stats.ttftSteps],[1,1,5200,1]);assert.equal(decodeSpeed(stats.decodeTokens,stats.decodeMs),'20 tok/s');assert.equal(stats.tokens.total,160);
});
test('tool names are first tokens, queued input splits turns, and new executions do not reuse run identity',()=>{
 let clock=0;const recorder=new SessionMetricRecorder(()=>clock);recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});
 clock=50;recorder.observe({type:'message_update',assistantMessageEvent:{type:'toolcall_start',contentIndex:0,partial:{content:[{type:'toolCall',name:'read'}]}}});clock=150;
 const first=recorder.observe({type:'message_end',message:{role:'assistant',usage:{output:5}}})!;assert.equal(first.ttftMs,50);assert.equal(first.closed,false);clock=9999;const closed=recorder.observe({type:'turn_end'})!;assert.equal(closed.closed,true);assert.equal(closed.llmMs,150);
 recorder.observe({type:'turn_start'});recorder.observe({type:'message_start',message:{role:'user'}});clock=250;const queued=recorder.observe({type:'message_end',message:{role:'assistant'}})!;assert.notEqual(queued.turnId,first.turnId);assert.notEqual(queued.stepId,first.stepId);assert.equal(queued.decodeMs,undefined);
 recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});clock=300;const next=recorder.observe({type:'message_end',message:{role:'assistant'}})!;assert.notEqual(next.turnId,queued.turnId);
});
test('a retry after partial output excludes backoff and renewed first-token wait from decode TPS',()=>{
 let clock=0;const recorder=new SessionMetricRecorder(()=>clock);recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});
 clock=100;recorder.observe({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'partial'}});
 clock=200;const failed=recorder.observe({type:'message_end',message:{role:'assistant',stopReason:'error',usage:{output:20}}})!;
 recorder.observe({type:'turn_end'});recorder.observe({type:'agent_end',willRetry:true});recorder.observe({type:'auto_retry_start'});
 clock=1200;recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});
 clock=2200;recorder.observe({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'final response'}});
 clock=3200;recorder.observe({type:'message_end',message:{role:'assistant',usage:{output:100}}});const final=recorder.observe({type:'turn_end'})!;
 const stats=projectSessionMonitor([message('failed','assistant'),record({...failed,entryId:'failed'}),message('final','assistant','failed'),record({...final,entryId:'final'})],{tokens:{input:1000,output:120}},undefined);
 assert.equal(final.stepId,failed.stepId);assert.equal(final.turnId,failed.turnId);assert.deepEqual([stats.turns,stats.steps,stats.llmMs,stats.ttftMs,stats.decodeMs],[1,1,3200,2200,1000]);
 assert.equal(decodeSpeed(stats.decodeTokens,stats.decodeMs),'100 tok/s');assert.equal(stats.tokens.output,120,'native total retains usage of the failed attempt');
});
test('terminal errors and cancelled retry waits close one failed step without inventing decode timing',()=>{
 for(const cancelled of [false,true]){let clock=0;const recorder=new SessionMetricRecorder(()=>clock);recorder.observe({type:'agent_start'});recorder.observe({type:'turn_start'});clock=100;recorder.observe({type:'message_end',message:{role:'assistant',stopReason:'error',usage:{output:0}}});assert.equal(recorder.observe({type:'turn_end'})?.closed,false);
  let closed=recorder.observe({type:'agent_end',willRetry:cancelled})!;if(cancelled){assert.equal(closed.closed,false);recorder.observe({type:'auto_retry_start'});clock=500;closed=recorder.observe({type:'auto_retry_end',success:false})!;}
  const stats=projectSessionMonitor([message('a','assistant'),record({...closed,entryId:'a'})],{},undefined);assert.equal(stats.steps,1);assert.equal(stats.llmMs,100);assert.equal(stats.decodeMs,0);assert.equal(stats.ttftSteps,0);
 }
});
test('whole-history totals survive compaction and branches; missing context and legacy timing stay unknown',()=>{
 const entries=[message('u1','user'),message('a1','assistant','u1',2000),message('u2','user','a1'),message('a2','assistant','u2',3000),{type:'compaction',id:'compact',parentId:'a2'},message('a3','assistant','a1',4000),message('tool','toolResult','a3',500)];
 const stats=projectSessionMonitor(entries,{tokens:{input:12,output:14,cacheRead:30,cacheWrite:4,total:999999}},{tokens:null,contextWindow:10000,percent:80});
 assert.deepEqual([stats.turns,stats.steps,stats.legacySteps,stats.llmMs,stats.toolMs],[2,3,3,9000,500]);assert.equal(stats.tokens.total,60);assert.equal(stats.ttftSteps,0);assert.equal(decodeSpeed(stats.decodeTokens,stats.decodeMs),null);assert.equal(stats.context?.percent,null);
 assert.equal(projectSessionMonitor(entries,{tokens:stats.tokens},{tokens:300,contextWindow:1000}).context?.percent,30);assert.equal(projectSessionMonitor(entries,{tokens:stats.tokens},undefined).context,undefined);
});
test('cache share never rounds partial hits to 100 and display totals use source compact units',()=>{
 assert.equal(cachePercent(90,100),'90');assert.equal(cachePercent(9995,10000),'99.95');assert.equal(cachePercent(100,100),'100');assert.equal(cachePercent(0,0),null);assert.equal(cachePercent(101,100),null);
 assert.notEqual(cachePercent(Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER),'100');assert.deepEqual([compactTokens(517),compactTokens(12200),compactTokens(4500000)],['517','12.2K','4.5M']);
});
test('footer hides unrecorded metrics, provides accessible detail buttons, and clamps panels',()=>{
 const empty=projectSessionMonitor([],{},undefined);assert.equal(renderToStaticMarkup(React.createElement(SessionStats,{stats:empty})), '');
 const stats=projectSessionMonitor([message('u','user'),message('a','assistant','u',2000)],{tokens:{input:1,cacheRead:9999,output:100,cacheWrite:0}},{tokens:1200,contextWindow:10000});
 const html=renderToStaticMarkup(React.createElement(SessionStats,{stats}));assert.match(html,/1 轮 1 步/);assert.match(html,/缓存命中 99.99%/);assert.match(html,/上下文占用 12%/);assert.match(html,/aria-haspopup="dialog"/);assert.doesNotMatch(html,/tok\/s/);
 assert.deepEqual(statsPanelPosition({left:370,top:500},{width:300,height:200},{width:400,height:600}),{left:88,top:292});
});
