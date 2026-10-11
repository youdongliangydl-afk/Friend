import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {groupModels,ModelOptions,ModelPicker} from '../apps/desktop/src/renderer/model-picker.js';
import {MemoryPanel,MemoryRecordCard} from '../apps/desktop/src/renderer/panels.js';
import {memorySummary,memoryView} from '../apps/desktop/src/renderer/memory-view.js';
import type {Model} from '../apps/desktop/src/renderer/types.js';

const model=(id:string,provider:string,ready=true):Model=>({id,provider,name:id,ready,reasoning:false,contextWindow:10000});
test('provider grouping uses configured names and preserves first-provider and per-provider model order',()=>{
  const models=[model('a-first','a'),model('b-first','b'),model('a-second','a',false)];
  const groups=groupModels(models,{a:'团队 Ark',b:'DeepSeek'});
  assert.deepEqual(groups.map(group=>[group.name,group.models.map(item=>item.id)]),[['团队 Ark',['a-first','a-second']],['DeepSeek',['b-first']]]);
  assert.equal(groups[0].models[1],models[2]);assert.equal(models[1].id,'b-first');
});
test('missing, blank and prototype-like provider names fall back to the actual provider ID',()=>{
  const groups=groupModels([model('unknown','unknown'),model('blank','blank'),model('prototype','constructor')],{blank:'   '});
  assert.deepEqual(groups.map(group=>group.name),['unknown','blank','constructor']);
});
test('all provider groups render expanded, without search, while selection and readiness remain visible',()=>{
  const html=renderToStaticMarkup(React.createElement(ModelOptions,{models:[model('ready','a'),model('waiting','a',false),model('other','b')],providerNames:{a:'自定义供应商',b:'第二供应商'},modelId:'ready',pending:false,onChoose:()=>{}}));
  assert.match(html,/供应商 自定义供应商/);assert.match(html,/供应商 第二供应商/);
  assert.match(html,/<button[^>]*aria-pressed="true"[^>]*>.*?ready/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>.*?waiting.*?待测试连接/);
  assert.equal((html.match(/<button/g)||[]).length,3);assert.doesNotMatch(html,/<details|<input/);
});
test('provider options keep native focusable buttons and dispatch the actual selected model ID',()=>{
  let selected='';const element=ModelOptions({models:[model('a/one','a'),model('b/two','b')],pending:false,onChoose:id=>{selected=id;}});
  const groups=React.Children.toArray(element.props.children) as React.ReactElement<{children:React.ReactNode}>[];
  const children=React.Children.toArray(groups[1].props.children) as React.ReactElement<{onClick?:()=>void;tabIndex?:number}>[];
  const button=children.find(child=>child.type==='button')!;assert.equal(button.props.tabIndex,undefined);button.props.onClick!();assert.equal(selected,'b/two');
  const busy=renderToStaticMarkup(React.createElement(ModelOptions,{models:[model('one','a'),model('two','b')],pending:true,onChoose:()=>{}}));
  assert.equal((busy.match(/disabled=""/g)||[]).length,2);
});
test('an unverified catalog still offers connection configuration instead of enabling a model',()=>{
  const html=renderToStaticMarkup(React.createElement(ModelPicker,{models:[model('waiting','a',false)],thinkingLevels:['off'],disabled:false,onChange:async()=>{},onConfigure:()=>{}}));
  assert.match(html,/模型尚未通过连接测试/);assert.match(html,/配置模型/);assert.doesNotMatch(html,/model-picker-list/);
});

const memory=(id:string,scope='project',status='active',revision=1)=>({id,scope,status,revision,title:id,content:'读取全部工作表，包括隐藏表。',kind:'fact',enabled:status==='active',sources:[] as {sessionId:string;entryId:string}[]});
test('memory scope filters include only current snapshot project/personal records and retain inactive entries',()=>{
  const records=[memory('project'),memory('personal','personal'),memory('inactive','project','inactive')],candidates=[memory('candidate','personal','candidate'),memory('invalid','project','invalidated')];
  assert.deepEqual(memoryView(records,candidates,'project').memories.map(value=>value.id),['project','inactive']);
  assert.deepEqual(memoryView(records,candidates,'personal').memories.map(value=>value.id),['personal']);
  assert.deepEqual(memoryView(records,candidates,'all').candidates.map(value=>value.id),['candidate','invalid']);
  assert.equal(memoryView(records,candidates,'all').memories.length,3);
});
test('candidate search hits stay in the candidate section once and use the newest available revision',()=>{
  const active=memory('same'),newer=memory('same','project','invalidated',2),candidate=memory('candidate','project','candidate');
  const result=memoryView([active],[newer,candidate],'project',[active,active,candidate,candidate]);
  assert.deepEqual(result.memories,[]);assert.deepEqual(result.candidates.map(value=>[value.id,value.revision]),[['same',2],['candidate',1]]);
  assert.equal(result.candidates[0],newer);
});
test('stale search hits removed by forgetting are not resurrected and empty search differs from full list',()=>{
  const kept=memory('kept');assert.deepEqual(memoryView([kept],[],'all',[memory('forgotten')]),{memories:[],candidates:[]});
  assert.equal(memoryView([kept],[],'all',[]).memories.length,0);assert.equal(memoryView([kept],[],'all',null).memories.length,1);
});
test('summaries collapse whitespace and truncate by characters without splitting Unicode',()=>{
  assert.equal(memorySummary('  中文\n\n说明\t继续 '),'中文 说明 继续');assert.equal(memorySummary('甲😀乙丙',2),'甲😀…');
  assert.equal(memorySummary(''), '');assert.equal(memorySummary('短正文'),'短正文');
});
test('collapsed memory cards keep title, summary, scope, version, status and warnings outside the disclosure',()=>{
  const record={...memory('预算规则','project','invalidated',3),content:'第一段要求。 '.repeat(30)+'正文末尾',conflictIds:['other'],invalidatedReason:'来源已撤回'};
  const html=renderToStaticMarkup(React.createElement(MemoryRecordCard,{memory:record,expanded:false,onExpanded:()=>{},actions:React.createElement('button',null,'纠正')}));
  const header=html.slice(0,html.indexOf('<details'));
  for(const expected of ['预算规则','本项目','v3','第一段要求','存在冲突','来源已撤回'])assert.ok(header.includes(expected));
  assert.doesNotMatch(header,/正文末尾/);assert.match(html,/<details[^>]*><summary>展开正文与操作/);
  assert.doesNotMatch(html,/正文末尾|>纠正</);
  const opened=renderToStaticMarkup(React.createElement(MemoryRecordCard,{memory:record,expanded:true,onExpanded:()=>{},actions:React.createElement('button',null,'纠正')}));
  assert.ok(opened.indexOf('正文末尾')>opened.indexOf('<details'));assert.ok(opened.indexOf('>纠正<')>opened.indexOf('<details'));
});
test('multiple memory bodies can remain open and candidate warnings do not imply publication',()=>{
  const render=(record:ReturnType<typeof memory>)=>React.createElement(MemoryRecordCard,{memory:record,expanded:true,onExpanded:()=>{},actions:null,key:record.id});
  const html=renderToStaticMarkup(React.createElement('div',null,[render(memory('one')),render(memory('two','personal','candidate'))]));
  assert.equal((html.match(/open=""/g)||[]).length,2);assert.match(html,/未确认内容不参与召回/);assert.doesNotMatch(html,/<details[^>]*name=/);
});
test('management defaults to project scope and resets its local state for a different session',()=>{
  const props={sessionId:'one',report:()=>{}};const first=MemoryPanel(props),second=MemoryPanel({...props,sessionId:'two'});
  assert.notEqual(first.key,second.key);
  const html=renderToStaticMarkup(React.createElement(MemoryPanel,props));
  assert.match(html,/<button[^>]*aria-pressed="true"[^>]*>本项目<\/button>/);assert.match(html,/全部（本项目＋个人）/);
  assert.match(html,/<details[^>]*memory-candidates[^>]*><summary>候选与失效记录/);assert.doesNotMatch(html,/<details[^>]*memory-candidates[^>]*open=/);
});
