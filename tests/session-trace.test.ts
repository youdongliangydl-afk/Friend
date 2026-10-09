import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {projectMessages,projectTraceSystems} from '../apps/desktop/src/message-projection.js';
import {projectTrajectory,searchTrajectory,groupTrajectory,traceDuration} from '../apps/desktop/src/renderer/trace-projection.js';
import {ChangedFiles} from '../apps/desktop/src/renderer/ChangedFiles.js';
import {Trajectory} from '../apps/desktop/src/renderer/Trajectory.js';
import {Conversation} from '../apps/desktop/src/renderer/Conversation.js';
import {digest} from '../packages/core/src/index.js';
import type {Message} from '../apps/desktop/src/renderer/types.js';
import type {RunChangesSummary} from '../apps/desktop/src/run-changes.js';

test('native projection preserves empty original input, run identity and exact model/tool metadata',()=>{
 const entries=[{type:'model_change',id:'m',provider:'fixture'}, {type:'message',id:'u',message:{role:'user',content:'附件内容',timestamp:10}},
  {type:'custom',customType:'friend-pi.input.v1',data:{entryId:'u',textEnd:0,hash:digest(''),runId:'run'}},
  {type:'message',id:'a',message:{role:'assistant',content:[],provider:'fixture',model:'offline',usage:{totalTokens:0},durationMs:0,stopReason:'error',errorMessage:'failure',timestamp:12}},
  {type:'message',id:'r',message:{role:'toolResult',toolCallId:'orphan',toolName:'read',content:'response',durationMs:5,isError:true,timestamp:20}}];
 const messages=projectMessages(entries);assert.equal(messages[0].userText,'');assert.equal(messages[1].runId,'run');assert.equal(messages[1].durationMs,0);assert.equal(messages[1].usage?.totalTokens,0);
 const rows=projectTrajectory(messages,null,[],false);assert.deepEqual(rows.map(row=>row.kind),['input','context','model','tool']);assert.equal(rows[2].status,'failed');assert.equal(rows[3].timestamp,15);assert.equal(rows[3].status,'failed');
 assert.equal(traceDuration(0),'0 ms');assert.equal(traceDuration(), '耗时未记录');
});
test('native system, custom context and compaction records stay out of chat and omit image bytes',()=>{
 const entries=[{type:'message',id:'sys',message:{role:'system',sections:[{title:'Workspace',content:'Rules'}]}},
  {type:'message',id:'u',message:{role:'user',content:'query'}},
  {type:'custom_message',id:'custom',customType:'memory',content:[{type:'text',text:'Recall context'}]},
  {type:'context_edit',id:'edit',replacement:{content:[{type:'image',mimeType:'image/png',data:'PRIVATE_IMAGE_BYTES'}]}},
  {type:'compaction',id:'compact',summary:'shortened history'},
  {type:'custom',id:'snapshot',customType:'friend-pi.trace.system.v1',data:{text:'Prepared system',truncated:true}}];
 const systems=projectTraceSystems(entries);assert.equal(systems.length,5);assert.ok(systems[0].text.includes('Rules'));assert.equal(systems[1].afterMessageId,'u');assert.ok(!JSON.stringify(systems).includes('PRIVATE_IMAGE_BYTES'));
 assert.equal(projectMessages(entries).length,1);assert.ok(projectTrajectory(projectMessages(entries),null,[],false,systems).some(row=>row.metadata));
});
test('parallel and orphan tools, context anchors and live-to-native identities never duplicate',()=>{
 const user:Message={id:'u',role:'user',text:'find'};
 const assistant:Message={id:'a',role:'assistant',text:'',parts:[{type:'toolCall',id:'one',name:'read',arguments:{path:'a'}},{type:'toolCall',id:'two',name:'read',arguments:{path:'b'}}]};
 const r=(id:string):Message=>({id:'r-'+id,role:'toolResult',text:'needle '+id,toolCallId:id,toolName:'read',timestamp:20,durationMs:3});
 const rows=projectTrajectory([user,assistant,r('two'),r('one'),r('orphan')],assistant,[{id:'one',name:'read',input:{},status:'failed'}],false,[{id:'context',afterMessageId:'r-orphan',label:'上下文编辑',text:'changed'}]);
 assert.equal(rows.filter(row=>row.id==='a').length,1);assert.deepEqual(rows.filter(row=>row.kind==='tool').map(row=>row.id),['tool-one','tool-two','tool-orphan']);assert.equal(rows.filter(row=>row.id==='context').length,1);
 assert.equal(searchTrajectory(rows,'NEEDLE').length,3);assert.equal(rows.find(row=>row.id==='tool-one')?.status,'completed');
 assert.equal(projectTrajectory([user,assistant],null,[],false).find(row=>row.id==='tool-one')?.status,'interrupted');
 assert.equal(projectTrajectory([user,{id:'wake',role:'automatic',text:'wake'}],null,[],false).at(-1)?.round,1);
});
test('images are diagnostic placeholders and failed empty responses remain inspectable',()=>{
 const rows=projectTrajectory([{id:'a',role:'assistant',text:'',model:'fixture',stopReason:'error',errorMessage:'failed'},{id:'r',role:'toolResult',toolCallId:'image',toolName:'read',text:'',parts:[{type:'image',data:'PRIVATE_BASE64',mimeType:'image/png'}]}],null,[],false);
 assert.equal(rows.filter(row=>row.kind==='model').length,1);assert.equal(searchTrajectory(rows,'PRIVATE_BASE64').length,0);assert.ok(JSON.stringify(rows).includes('图片附件'));
});
test('DSH trajectory groups preserve parallel calls and all-word search; toolbar folds rather than rescales turns',()=>{
 const messages:Message[]=[{id:'u',role:'user',text:'request'},{id:'a',role:'assistant',text:'',parts:[{type:'toolCall',id:'one',name:'read',arguments:{path:'Alpha.txt'}},{type:'toolCall',id:'two',name:'read',arguments:{path:'Beta.txt'}}]},{id:'u2',role:'user',text:'next'}];
 const rows=projectTrajectory(messages,null,[],false),turns=groupTrajectory(rows);assert.equal(turns.length,2);const calls=turns[0].entries.find(entry=>entry.kind==='calls');assert.ok(calls?.kind==='calls');assert.deepEqual(calls.rows.map(row=>row.id),['tool-one','tool-two']);assert.deepEqual(searchTrajectory(rows,'ALPHA read').map(row=>row.id),['tool-one']);assert.deepEqual(searchTrajectory(rows,'ALPHA missing'),[]);
 const html=renderToStaticMarkup(React.createElement(Trajectory,{messages,live:null,tools:[],running:false}));assert.match(html,/aria-label="折叠全部轮次"/);assert.match(html,/aria-label="折叠全部调用"/);assert.match(html,/工具调用 · 2 项/);assert.match(html,/class="trace-turn" open=""/);
});
const summary:RunChangesSummary={v:1,runId:'run',sessionId:'session',projectId:'project',startedAt:'start',finishedAt:'end',status:'completed',note:'包括同期外部编辑',files:Array.from({length:5},(_,i)=>({path:'file-'+i,binary:i===0,status:'M',additions:i===0?undefined:2,deletions:0}))};
test('summary renders four-file preview, totals and unavailable truthfully; anchors to its own run',()=>{
 const html=renderToStaticMarkup(React.createElement(ChangedFiles,{summary}));assert.match(html,/已改动 5 个文件/);assert.match(html,/全部 5 个文件/);assert.match(html,/二进制或大文件/);assert.ok(!html.includes('file-4'));assert.match(html,/aria-expanded="false"/);
 const missing=renderToStaticMarkup(React.createElement(ChangedFiles,{summary:{...summary,files:[],unavailable:'Git unavailable'}}));assert.match(missing,/统计不可用/);assert.doesNotMatch(missing,/本轮没有文件变化/);
 const conversation=renderToStaticMarkup(React.createElement(Conversation,{messages:[{id:'u',role:'user',text:'query',runId:'run'},{id:'a',role:'assistant',text:'answer',runId:'run'},{id:'u2',role:'user',text:'next',runId:'next'}],live:null,tools:[],running:false,changes:[summary]}));
 assert.equal(conversation.match(/aria-label="本轮改动文件"/g)?.length,1);assert.ok(conversation.indexOf('answer')<conversation.indexOf('已改动'));assert.ok(conversation.indexOf('已改动')<conversation.indexOf('next'));
 const trace=renderToStaticMarkup(React.createElement(Trajectory,{messages:[],live:null,tools:[],running:false}));assert.match(trace,/搜索轨迹/);assert.match(trace,/发送消息后/);
});

test('DSH preview placement uses card inset, viewport clamps, gap and available vertical room',async()=>{
 const {changePreviewPosition}=await import('../apps/desktop/src/renderer/change-preview-position.js');
 const above=changePreviewPosition({top:600,bottom:640},{left:100,width:700},350,{width:1200,height:900},40);assert.deepEqual(above,{left:124,top:242,width:652,maxHeight:420});
 const below=changePreviewPosition({top:30,bottom:70},{left:1100,width:700},350,{width:1200,height:900},20);assert.equal(below.top,78);assert.equal(below.left,540);assert.equal(below.maxHeight,420);
 const narrow=changePreviewPosition({top:80,bottom:120},{left:-100,width:900},500,{width:320,height:220},20);assert.equal(narrow.width,304);assert.equal(narrow.left,8);assert.equal(narrow.maxHeight,84);
});
test('single file uses a review header; deleted files still open their run comparison; shared diff renders red/green rows',async()=>{
 const {FileDiffView}=await import('../apps/desktop/src/renderer/DiffView.js');const {parsePatch}=await import('../apps/desktop/src/workspace-files.js');
 const one=renderToStaticMarkup(React.createElement(ChangedFiles,{summary:{...summary,files:[{path:'deleted.txt',status:'D',binary:false,additions:0,deletions:1}]},workspacePath:'/workspace'}));assert.match(one,/查看变更：deleted.txt/);assert.match(one,/\/workspace\/deleted.txt/);assert.doesNotMatch(one,/disabled|title="打开/);assert.doesNotMatch(one,/<ul/);
 const patch='@@ -1 +1 @@\n-old value\n+new value';const state={phase:'ready' as const,file:{path:'f',status:'M',staged:false,binary:false,patch,lines:parsePatch(patch),additions:1,deletions:1}};
 const diff=renderToStaticMarkup(React.createElement(FileDiffView,{state,split:false,retry:()=>{}}));assert.match(diff,/diff-add/);assert.match(diff,/diff-remove/);assert.match(diff,/-old value/);assert.match(diff,/\+new value/);
 const preview=renderToStaticMarkup(React.createElement(FileDiffView,{state,preview:true,retry:()=>{}}));assert.doesNotMatch(preview,/@\@/);
 const missing=renderToStaticMarkup(React.createElement(FileDiffView,{state:{phase:'missing',message:'历史不可用'},retry:()=>{}}));assert.match(missing,/历史不可用/);
});
test('hover and review share one lazy comparison read; failures retry and missing comparisons do not fall back to current files',async()=>{
 const {ChangeDiffCache}=await import('../apps/desktop/src/renderer/change-review.js');const cache=new ChangeDiffCache(),coords={sessionId:'desktop',runId:'run',changeId:'change',index:0};let calls=0;
 const original=globalThis.window;Object.assign(globalThis,{window:{friendPi:{request:async(method:string)=>{assert.equal(method,'session.changes.read');calls++;if(calls===1)throw new Error('read failed');return {file:{path:'f',lines:[],patch:'',binary:false}};}}}});
 try{await cache.load(coords);assert.equal(cache.get(coords)?.phase,'error');await Promise.all([cache.load(coords),cache.load(coords)]);assert.equal(calls,2);assert.equal(cache.get(coords)?.phase,'ready');await cache.load(coords);assert.equal(calls,2);await cache.load({...coords,changeId:undefined});assert.equal(cache.get({...coords,changeId:undefined})?.phase,'missing');assert.equal(calls,2);}finally{if(original)Object.assign(globalThis,{window:original});else delete (globalThis as {window?:unknown}).window;}
});
