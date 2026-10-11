import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {questionOrder,questionBatch,questionAnswers,questionAnswerText,type QuestionBatchDialog} from '../apps/desktop/src/question-batch.js';
import {AttentionRegistry} from '../apps/desktop/src/session-attention.js';
import {BatchQuestionCard,BatchQuestionHistory,questionDraftKey,questionResult} from '../apps/desktop/src/renderer/BatchQuestionCard.js';
const batch=questionBatch({v:1,title:'确认交付',questions:[{id:'format',type:'single',title:'交付形式',required:true,options:[{id:'web',label:'网页'},{id:'doc',label:'文档'}],allowOther:true},{id:'features',type:'multiple',title:'需要的能力',required:true,options:[{id:'mobile',label:'移动端'},{id:'offline',label:'离线'}],allowOther:true},{id:'notes',type:'text',title:'补充说明',required:false}]});
test('batch answers require an actual choice, validate IDs and normalize optional skips',()=>{
 assert.throws(()=>questionAnswers(batch,[]),/请选择/);
 assert.throws(()=>questionAnswers(batch,[{questionId:'format',optionIds:['missing']}]),/有效选项/);
 assert.throws(()=>questionAnswers(batch,[{questionId:'format',optionIds:['web','doc']}]),/只能选择/);
 assert.throws(()=>questionAnswers(batch,[{questionId:'unknown',text:'x'}]),/ID/);
 assert.throws(()=>questionAnswers(batch,[{questionId:'format',skipped:true}]),/必答/);
 const answers=questionAnswers(batch,[{questionId:'format',other:' 图片 '},{questionId:'features',optionIds:['mobile','offline'],other:'打印'}]);
 assert.deepEqual(answers[0],{questionId:'format',other:'图片'});assert.deepEqual(answers[2],{questionId:'notes',skipped:true});assert.equal(questionAnswerText(batch.questions[1],answers[1]),'移动端；离线；其他：打印');
 assert.throws(()=>questionBatch({...batch,questions:[batch.questions[0],batch.questions[0]]}),/ID重复/);
});
test('question attention has no deadline, survives switching views and rejects retired generation',()=>{
 let now=1;const registry=new AttentionRegistry({now:()=>now});const owner={sessionId:'root',generation:'worker',runId:'run'};registry.register('root','worker');registry.observeState(owner,{runId:'run',isRunning:true});
 const dialog:QuestionBatchDialog={...batch,id:'questions',kind:'questionBatch',generation:'question-owner',runId:'run',toolCallId:'call',createdAt:now,sequence:1};assert.equal(registry.captureDialog(owner,dialog),true);
 now+=120000;registry.setView({sessionId:'other',foreground:true});assert.equal(registry.getDialog(owner,dialog.id)?.kind,'questionBatch');assert.equal(registry.snapshot().find(item=>item.dialog?.id===dialog.id)?.expiresAt,undefined);
 const copy=registry.getDialog(owner,dialog.id)!;copy.questions![0].title='changed';assert.equal(registry.getDialog(owner,dialog.id)?.questions?.[0].title,'交付形式');
 registry.register('root','replacement');assert.equal(registry.getDialog(owner,dialog.id),undefined);assert.equal(registry.captureDialog(owner,dialog),false);
});
test('a new question card has no preselected answer and history is derived from one native result',()=>{
 const dialog:QuestionBatchDialog={...batch,id:'request',kind:'questionBatch',generation:'g',runId:'r',toolCallId:'call',createdAt:1,sequence:1};const drafts=new Map();const html=renderToStaticMarkup(React.createElement(BatchQuestionCard,{dialog,drafts,respond:async()=>({})}));
 assert.ok(!html.includes('checked=""'));assert.match(html,/1 \/ 3/);assert.ok(!html.includes('dialog"'));assert.equal(questionDraftKey(dialog),JSON.stringify(['g','r','request']));
 const result=questionResult([{type:'text',text:JSON.stringify({...batch,status:'answered',answers:[{questionId:'format',optionIds:['web']},{questionId:'features',optionIds:['mobile']} ]})}]);assert.ok(result);
 const history=renderToStaticMarkup(React.createElement(BatchQuestionHistory,{result}));assert.match(history,/已提交全部回答/);assert.match(history,/网页/);assert.match(history,/已跳过/);assert.equal(questionResult('{"v":1,"questions":[],"status":"answered"}'),undefined);
});

test('question order follows host sequence even with equal timestamps and inverse request IDs',()=>{
 const requests=[{id:'a',createdAt:1,sequence:2},{id:'z',createdAt:1,sequence:1}];assert.deepEqual(requests.sort(questionOrder).map(item=>item.id),['z','a']);
});
