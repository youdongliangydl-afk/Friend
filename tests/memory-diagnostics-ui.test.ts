import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryLearningDiagnostics,MemoryRecallDiagnostics,MemoryImpactPreview} from '../apps/desktop/src/renderer/panels.js';
import {memoryLearningView,memoryRecallView,memoryImpactDraft,memoryImpactMutation,memoryImpactChanged,type MemoryImpactDraft} from '../apps/desktop/src/renderer/memory-view.js';
const render=(component:React.ReactElement)=>renderToStaticMarkup(component);
const memory={id:'memory-one',revision:3,hash:'current-hash',content:'Full body is raw evidence.'};
const preview={action:'update',id:'memory-one',revision:7,previewToken:'frozen-preview-token',candidateDigest:'frozen-candidate-hash',affected:[{id:'memory-one',revision:7,status:'active'},{id:'derived-two',revision:2,status:'active'}],sources:[{valid:true,source:{entryId:'visible-source'}},{valid:false,source:{entryId:'withdrawn-source'}}],conclusion:'更正会撤回相关派生内容。'};
const empty:MemoryImpactDraft={title:'',content:'',generation:0,preview:null,error:''};

test('learning progress separates processed, published, isolated and continuing proposals from cumulative provider budget',()=>{
 const job={id:'batch',stage:'publish',state:'queued',progress:{sourceEnteredExtraction:true,sourceFullyProcessed:false,proposals:25,processed:12,published:9,candidates:2,rejected:1,pending:13,continuing:true},budget:{calls:6,maxCalls:6,tokens:700,usageUnknown:true},proposalLedger:[{id:'bad',state:'rejected',original:{title:'伪造引文',content:'NEVER_RENDER_COLLAPSED_NATIVE_CONTENT'},reason:'引文不能定位'}]};
 const value=memoryLearningView(job);assert.equal(value.total,25);assert.equal(value.processed,12);assert.equal(value.published,9);assert.equal(value.pending,13);assert.equal(value.calls,6);assert.equal(value.maxCalls,6);assert.equal(value.usageUnknown,true);
 const html=render(React.createElement(MemoryLearningDiagnostics,{jobs:[job],pending:false,onRetry:()=>{}}));for(const text of ['发布记忆','有提案待继续','本批 25 条提案，已处理 12 条','已发布','已隔离','待处理','累计模型请求 6 / 6','另有未确认用量','引文不能定位'])assert.ok(html.includes(text));assert.doesNotMatch(html,/NEVER_RENDER_COLLAPSED_NATIVE_CONTENT|全部学完|已采纳|答案正确/);assert.match(html,/<details[^>]*><summary>批次与预算原始记录/);assert.doesNotMatch(html,/<details[^>]*open=/);
});
test('legacy jobs and absent usage do not turn unknown metrics into zeros or source-completeness claims',()=>{
 const value=memoryLearningView({stage:'validate',state:'completed',budget:{unknown:true}});assert.equal(value.known,false);assert.equal(value.calls,undefined);assert.equal(value.tokens,undefined);assert.equal(value.source,'来源提取进度未记录');
 const html=render(React.createElement(MemoryLearningDiagnostics,{jobs:[{id:'old',stage:'validate',state:'completed',budget:{unknown:true}}],pending:false,onRetry:()=>{}}));assert.match(html,/旧批次未记录提案级进度/);assert.match(html,/累计模型请求 未知 \/ 未知/);assert.match(html,/Token 未知/);assert.doesNotMatch(html,/已处理 0|全部学完/);
});
test('failed batch retry remains a native keyboard button and honors the shared pending state',()=>{
 let retried='';const element=MemoryLearningDiagnostics({jobs:[{id:'failure',stage:'publish',state:'failed',error:'来源已撤回'}],pending:true,onRetry:id=>{retried=id;}});const html=render(element);assert.match(html,/role="status"[^>]*>来源已撤回/);assert.match(html,/<button disabled="">显式重试本批<\/button>/);assert.equal(retried,'');
});
test('directory visibility, prepared bodies and observed context/request stages remain distinct and deduplicated',()=>{
 const directory=[{id:memory.id,revision:3,hash:memory.hash},{id:'pointer-only',revision:4,hash:'pointer-hash'}],prepared={operationId:'recall',stage:'prepared',directory,records:[memory]},context={...prepared,stage:'injected-to-context'};
 const usage={receipts:[context],stageReceipts:[prepared,context],sourceReceipts:[]},view=memoryRecallView(usage);assert.equal(view.directory,2);assert.equal(view.selected,1);assert.equal(view.context,1);assert.equal(view.request,0);assert.equal(view.response,0);assert.equal(view.rawCount,2);
 const html=render(React.createElement(MemoryRecallDiagnostics,{usage}));for(const text of ['目录可见','正文选中','已进上下文','请求已准备','不证明模型采用','不证明答案正确'])assert.ok(html.includes(text));assert.doesNotMatch(html,/Full body is raw evidence/);assert.match(html,/<summary>原始收据 · 2<\/summary>/);
});
test('provider request preparation, response observation and explicit tool reads do not imply answer acceptance',()=>{
 const receipt={operationId:'automatic',stage:'request-prepared',records:[memory]},view=memoryRecallView({receipts:[receipt],stageReceipts:[{...receipt,stage:'response-observed'},{operationId:'tool',stage:'tool-read',records:[{id:'different-body',revision:2,hash:'other'}]}],sourceReceipts:[{receiptId:'source'}]});assert.equal(view.request,1);assert.equal(view.response,1);assert.equal(view.tool,1);assert.equal(view.sourceReads,1);assert.equal(view.context,0);assert.equal(view.selected,2);
});
test('recall omissions retain exact revision pointers, translate all boundary reasons, and do not disappear after a tool read',()=>{
 const omitted=['body-budget','directory-budget','record-limit','preference-applicability-unknown'].map((reason,i)=>({id:`memory-${i}`,reason,readRef:{action:'read.range',id:`memory-${i}`,revision:i+2}})),usage={stageReceipts:[{operationId:'select',stage:'prepared',records:[],omitted},{operationId:'later',stage:'tool-read',records:[{id:'memory-0',revision:2}]}]};
 const view=memoryRecallView(usage);assert.equal(view.omissions.length,4);assert.deepEqual(view.omissions[0].readRef,{action:'read.range',id:'memory-0',revision:2});assert.equal(view.omissions[3].reason,'长期偏好的适用范围待核对');assert.equal(view.tool,1);
 const html=render(React.createElement(MemoryRecallDiagnostics,{usage}));assert.match(html,/自动召回未入正文的原因 · 4/);assert.match(html,/memory-0 · v2/);assert.match(html,/正文与完整条件超出预算/);assert.match(html,/目录超出预算/);assert.match(html,/本轮正文条数已满/);assert.match(html,/长期偏好的适用范围待核对/);
});
test('an empty receipt log explains its boundary without claiming that relevant history does not exist',()=>{
 const html=render(React.createElement(MemoryRecallDiagnostics,{usage:{}}));assert.match(html,/没有收据不代表历史中没有相关内容/);assert.doesNotMatch(html,/历史不存在|未找到任何历史/);assert.match(html,/<details[^>]*><summary>原始收据 · 0/);
});
test('draft edits invalidate outstanding preview responses and cannot restore a stale approval',()=>{
 let state=memoryImpactDraft(empty,{type:'open',generation:1,title:'原始标题',content:'原始正文'});state=memoryImpactDraft(state,{type:'change',generation:2,content:'第一版草稿'});state=memoryImpactDraft(state,{type:'start',generation:3});state=memoryImpactDraft(state,{type:'change',generation:4,content:'保留第二版草稿'});const before=state;assert.equal(memoryImpactDraft(state,{type:'ready',generation:3,preview}),before);assert.equal(memoryImpactDraft(state,{type:'error',generation:3,error:'迟到失败'}),before);assert.equal(state.content,'保留第二版草稿');assert.equal(state.preview,null);state=memoryImpactDraft(state,{type:'start',generation:5});state=memoryImpactDraft(state,{type:'ready',generation:5,preview});assert.equal(state.preview,preview);state=memoryImpactDraft(state,{type:'change',generation:6,title:'更改后的标题'});assert.equal(state.preview,null);assert.equal(state.content,'保留第二版草稿');assert.equal(state.title,'更改后的标题');assert.equal(memoryImpactDraft(state,{type:'ready',generation:5,preview}),state);
});
test('a stale preview failure clears approval while preserving draft content for a fresh preview',()=>{
 let state=memoryImpactDraft(empty,{type:'open',generation:1,title:'纠正标题',content:'完整纠正草稿'});state=memoryImpactDraft(state,{type:'start',generation:2});state=memoryImpactDraft(state,{type:'ready',generation:2,preview});state=memoryImpactDraft(state,{type:'error',generation:2,error:'影响预览已过期，请重新预览；草稿已保留。'});assert.equal(state.preview,null);assert.equal(state.title,'纠正标题');assert.equal(state.content,'完整纠正草稿');assert.match(state.error,/过期/);state=memoryImpactDraft(state,{type:'start',generation:3});state=memoryImpactDraft(state,{type:'ready',generation:3,preview:{...preview,revision:8,previewToken:'fresh-token'}});const input=memoryImpactMutation(state.preview,'update','memory-one',{title:state.title,content:state.content});assert.deepEqual(input,{id:'memory-one',revision:8,previewToken:'fresh-token',patch:{title:'纠正标题',content:'完整纠正草稿'}});
});
test('mutation uses the preview revision and token, rejects wrong actions/records and never invents a preview',()=>{
 const patch={title:'新标题',content:'精确草稿'};assert.deepEqual(memoryImpactMutation(preview,'update',memory.id,patch),{id:memory.id,revision:7,previewToken:'frozen-preview-token',patch});assert.deepEqual(memoryImpactMutation({...preview,action:'forget'},'forget',memory.id),{id:memory.id,revision:7,previewToken:'frozen-preview-token'});
 for(const invalid of [null,{}, {...preview,action:'forget'},{...preview,id:'other'},{...preview,revision:0},{...preview,revision:1.5},{...preview,previewToken:''}])assert.throws(()=>memoryImpactMutation(invalid,'update',memory.id,patch),/重新预览/);assert.equal(preview.revision,7);assert.equal(patch.content,'精确草稿');
});
test('impact preview remains descriptive, exposes unavailable sources, and folds exact versions before confirmation',()=>{
 const html=render(React.createElement(MemoryImpactPreview,{preview}));for(const text of ['本次操作的只读影响预览','当前 v7','涉及记忆','派生内容','1 / 2 可用','部分来源已不可用','此预览尚未修改任何记忆','内容或来源变化时，需要重新预览'])assert.ok(html.includes(text));assert.match(html,/<details[^>]*><summary>查看涉及的版本与来源/);assert.doesNotMatch(html,/<details[^>]*open=|<button|onClick/);assert.match(html,/derived-two · v2/);
});


test('live changes to revisions, hashes or epoch expire the displayed preview without treating loading as a change',()=>{
 const current={epoch:3,memories:[{id:'memory-one',revision:7,hash:'root-hash'},{id:'derived-two',revision:2,hash:'child-hash'}],candidates:[]},frozen={...preview,epoch:3,affected:current.memories};assert.equal(memoryImpactChanged(frozen,current),false);assert.equal(memoryImpactChanged(frozen,{}),false);assert.equal(memoryImpactChanged(frozen,{...current,epoch:4}),true);assert.equal(memoryImpactChanged(frozen,{...current,memories:[current.memories[0],{...current.memories[1],revision:3}]}),true);assert.equal(memoryImpactChanged(frozen,{...current,memories:[{...current.memories[0],hash:'new-content'},current.memories[1]]}),true);assert.equal(memoryImpactChanged(frozen,{...current,memories:[current.memories[0]]}),false);assert.equal(memoryImpactChanged(frozen,{...current,memories:[current.memories[1]]}),true);
});


test('a personal preference preview may include a descendant outside the current snapshot scope',()=>{
 const frozen={...preview,id:'personal',epoch:2,affected:[{id:'personal',revision:1},{id:'other-project-child',revision:4}]},current={epoch:2,memories:[{id:'personal',revision:1,scope:'personal'}],candidates:[]};assert.equal(memoryImpactChanged(frozen,current),false);assert.equal(memoryImpactChanged(frozen,{...current,epoch:3}),true);
});
