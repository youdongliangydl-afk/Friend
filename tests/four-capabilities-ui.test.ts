import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as types from '../apps/desktop/src/renderer/types.js';
import * as ui from '../apps/desktop/src/renderer/ui.js';
import * as profiles from '../apps/desktop/src/renderer/expert-profiles.js';
import * as feedback from '../apps/desktop/src/renderer/memory-feedback.js';
import * as memoryView from '../apps/desktop/src/renderer/memory-view.js';
import {ExecutionPolicyFields,GraphExecutionFacts,parseTaskDraft} from '../apps/desktop/src/renderer/swarm-controls.js';
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'&&value.props?[value,...nodes(value.props.children),...nodes(value.props.actions)]:[];
const label=(value:any):string=>Array.isArray(value)?value.map(label).join(''):value?.props?label(value.props.children):typeof value==='string'||typeof value==='number'?String(value):'';
const plain=(value:any)=>JSON.parse(JSON.stringify(value));
function fixture(file:string,component:string,initialProps:Record<string,unknown>={}){
 let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],requests:{method:string;input:any;resolve(value:unknown):void;reject(reason:Error):void}[]=[],reports:string[]=[];
 const same=(a:any[],b:any[])=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const hooks={useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],(next:any)=>slots[index]=typeof next==='function'?next(slots[index]):next];},useRef(initial:any){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},useCallback(callback:any,deps:any[]){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={callback,deps};return slots[index].callback;},useEffect(callback:any,deps:any[]){const index=cursor++,prior=slots[index];if(prior&&same(prior.deps,deps))return;const slot={deps,cleanup:prior?.cleanup};slots[index]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});}};
 const context:any={module:{exports:{}},crypto:{randomUUID:()=>`feedback-operation`},window:{friendPi:{onEvent:()=>()=>{},request(method:string,input:any){return new Promise((resolve,reject)=>requests.push({method,input,resolve,reject}));}}},require(name:string){if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;if(name==='./types.js')return types;if(name==='./ui.js')return ui;if(name==='./expert-profiles.js')return profiles;if(name==='./memory-feedback.js')return feedback;if(name==='./memory-view.js')return memoryView;throw new Error('Unexpected import '+name);}};
 vm.runInNewContext(transformSync(readFileSync(`apps/desktop/src/renderer/${file}`,'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
 const props:any={sessionId:'one',report:(message:string)=>reports.push(message),...initialProps};
 const render=()=>{cursor=0;const tree=context.module.exports[component](props);while(effects.length)effects.shift()!();return tree;};
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();return render();};
 const button=(text:string)=>{const node=nodes(render()).find(node=>node.type==='button'&&label(node)===text);assert.ok(node,`button ${text}`);return node.props;};
 const field=(text:string)=>{const node=nodes(render()).find(node=>node.type===ui.Field&&node.props.label===text);assert.ok(node,`field ${text}`);return nodes(node.props.children).find(node=>['input','textarea','select'].includes(node.type)).props;};
 const input=(text:string)=>{const node=nodes(render()).find(node=>node.props['aria-label']===text);assert.ok(node);return node.props;};
 const request=(action:string,index=-1)=>{const values=requests.filter(row=>row.input.action===action),row=index<0?values.at(index):values[index];assert.ok(row,action);return row;};
 render();return {render,flush,button,field,input,request,requests,reports,props,html:()=>renderToStaticMarkup(render())};
}
const catalog={items:[],total:0,skills:[{id:'skill-one',version:3,title:'已配置 Skill',available:true,enabled:true}],availableTools:['read','edit'],availableModels:[{id:'configured/model',thinkingLevels:['off','high']}]};

test('expert editor saves an immediately usable inherited preset and preserves the form on revision failure',async()=>{
 const f=fixture('expert-profiles.tsx','ExpertProfiles');f.request('profile.list').resolve(catalog);await f.flush();f.button('＋ 新专家').onClick();f.field('名称').onChange({target:{value:'界面专家'}});f.field('专业提示').onChange({target:{value:'检查可访问性'}});f.button('保存专家预设').onClick();
 assert.deepEqual(plain(f.request('profile.create').input.input),{title:'界面专家',prompt:'检查可访问性',skillRefs:[],toolsMode:'inherit',modelId:null,thinkingLevel:null,enabled:true});assert.equal(f.requests.some(row=>row.input.action==='validation.run'),false);
 f.request('profile.create').reject(new Error('版本冲突'));await f.flush();assert.equal(f.field('名称').value,'界面专家');assert.equal(f.field('专业提示').value,'检查可访问性');assert.match(label(f.render()),/版本冲突.*草稿已保留/);
});
test('expert editing preserves frozen skill version and distinguishes empty tool allowlist from inheritance',async()=>{
 const f=fixture('expert-profiles.tsx','ExpertProfiles');f.request('profile.list').resolve({...catalog,items:[{id:'profile',title:'测试专家',revision:7,version:4,enabled:true,source:'user'}],total:1});await f.flush();assert.match(f.html(),/用户配置 · 未经成长验证/);f.button('编辑预设').onClick();f.request('profile.read').resolve({id:'profile',revision:7,title:'测试专家',prompt:'prompt',skillRefs:[{id:'skill-one',version:2}],toolsMode:'allowlist',tools:[],modelId:'configured/model',thinkingLevel:'high'});await f.flush();f.field('执行模型').onChange({target:{value:''}});f.button('保存专家预设').onClick();const input=plain(f.request('profile.update').input.input);assert.equal(input.expectedRevision,7);assert.deepEqual(input.tools,[]);assert.deepEqual(input.skillRefs,[{id:'skill-one',version:2}]);assert.equal(input.modelId,null);assert.equal(input.thinkingLevel,null);
});
test('expert search rejects late results and sends server cursor rather than truncating arbitrary profiles',async()=>{
 const f=fixture('expert-profiles.tsx','ExpertProfiles');const old=f.request('profile.list');f.input('搜索专家预设').onChange({target:{value:'审查'}});f.render();const recent=f.request('profile.list');assert.notEqual(recent,old);recent.resolve({...catalog,items:[{id:'new',title:'匹配专家',source:'user'}],total:45,nextCursor:'next:20'});await f.flush();old.resolve({...catalog,items:[{id:'old',title:'迟到结果'}],total:1});await f.flush();assert.match(f.html(),/匹配专家/);assert.doesNotMatch(f.html(),/迟到结果/);f.button('下一页').onClick();f.render();assert.deepEqual(plain(f.request('profile.list').input.input),{query:'审查',cursor:'next:20',limit:20});
});
test('an old session profile read cannot populate the new session editor',async()=>{
 const f=fixture('expert-profiles.tsx','ExpertProfiles');f.request('profile.list').resolve({...catalog,items:[{id:'old',title:'旧专家'}],total:1});await f.flush();f.button('编辑预设').onClick();const old=f.request('profile.read');f.props.sessionId='two';f.render();f.request('profile.list').resolve(catalog);old.resolve({id:'old',title:'旧专家完整正文'});await f.flush();assert.doesNotMatch(f.html(),/旧专家完整正文/);
});
test('manual graph creation sends chosen policy and per-task preset overrides through the Swarm controller',async()=>{
 const f=fixture('swarm-controls.tsx','SwarmCreationControls',{hasExpert:true,disabled:false,onCreated:async()=>{}});f.request('template.list').resolve([]);f.request('profile.list').resolve(catalog);await f.flush();f.field('交付目标').onChange({target:{value:'交付修复'}});const auto=nodes(f.render()).find(node=>node.type==='input'&&node.props.type==='checkbox');auto.props.onChange({target:{checked:false}});const policy=nodes(f.render()).find(node=>node.type?.name==='ExecutionPolicyFields');policy.props.onChange({v:1,workspace:'shared',review:'none',dirtyBaseline:'snapshot'});f.field('成果标题').onChange({target:{value:'修复'}});f.field('执行要求').onChange({target:{value:'核对错误并修复'}});f.field('专家预设').onChange({target:{value:'expert-one'}});f.field('单次覆盖 JSON').onChange({target:{value:'{"toolsMode":"allowlist","tools":[],"thinkingLevel":"high"}'}});f.button('创建协作任务').onClick();const request=f.request('create');assert.equal(request.input.plugin,'swarm');assert.equal(request.input.input.maxWorkers,4);assert.deepEqual(plain(request.input.input.executionPolicy),{v:1,workspace:'shared',review:'none',dirtyBaseline:'snapshot'});assert.equal(request.input.input.tasks[0].expertId,'expert-one');assert.deepEqual(plain(request.input.input.tasks[0].expertOverrides.tools),[]);assert.match(f.html(),/本次不请求独立复核/);
});
test('template create preserves edited definition and target, and does not run until the explicit start control',async()=>{
 const f=fixture('swarm-controls.tsx','SwarmCreationControls',{hasExpert:false,disabled:false,onCreated:async()=>{}});f.request('template.list').resolve([{v:1,id:'source-research',version:1,definition:{title:'源码调研',nodes:[],executionPolicy:{v:1,workspace:'shared',review:'none',dirtyBaseline:'snapshot'}}}]);await f.flush();f.field('任务模板').onChange({target:{value:'source-research'}});f.field('本次目标').onChange({target:{value:'解释索引'}});const definition=JSON.parse(f.field('模板定义 JSON').value);definition.checks=[{command:'node',args:['--test']}];f.field('模板定义 JSON').onChange({target:{value:JSON.stringify(definition)}});f.button('从模板创建任务').onClick();assert.equal(f.request('create').input.plugin,'workflow');assert.deepEqual(plain(f.request('create').input.input),{templateId:'source-research',parameters:{target:'解释索引'},definition});assert.equal(f.requests.some(row=>row.input.action==='start'),false);
});
test('bad per-task override JSON never silently drops an override or creates a graph',()=>{
 const draft={id:'t',title:'任务',prompt:'工作',mode:'read' as const,dependencies:'a, b',writeScopes:'.',expertId:'e',expertOverrides:'[]'};assert.throws(()=>parseTaskDraft(draft),/必须是 JSON 对象/);assert.deepEqual(parseTaskDraft({...draft,expertOverrides:'{"tools":[]}'}).expertOverrides,{tools:[]});
});
test('no-review and observed counters do not make unsupported approval or savings claims',()=>{
 const html=renderToStaticMarkup(React.createElement(GraphExecutionFacts,{graph:{executionPolicy:{v:1,workspace:'shared',review:'none',dirtyBaseline:'snapshot'}},summary:{kind:'observed',elapsedMs:2500,memberElapsedMs:4000,timeComplete:false,tokens:42,tokenUnknown:true,estimatedSavings:null}}));assert.match(html,/未请求独立复核/);assert.match(html,/2.5 秒/);assert.match(html,/耗时记录不完整/);assert.match(html,/另有未知用量/);assert.match(html,/节省估算：未提供/);assert.doesNotMatch(html,/节省了|复核通过/);
});
test('memory feedback binds record revision and goal context without submitting fact edits',async()=>{
 const f=fixture('memory-feedback.tsx','MemoryFeedbackButtons',{id:'memory',revision:9,goal:'修复登录',query:'用户',report:()=>{}});f.button('已过时').onClick();assert.deepEqual(plain(f.request('feedback').input.input),{id:'memory',revision:9,kind:'outdated',taskContext:{goal:'修复登录'},operationId:'feedback-operation'});f.request('feedback').resolve({});await f.flush();assert.match(f.html(),/原事实保留/);assert.equal(f.requests.length,1);assert.deepEqual(feedback.memoryTaskContext('', '检索问题'),{goal:'检索问题'});
});
test('ReBuild view keeps goal and current request separate and marks incomplete adopted coverage',async()=>{
 const f=fixture('panels.tsx','RebuildPanel');const point=(text:string)=>({text,sources:[]});f.request('snapshot').resolve({field:{goal:point('原始交付目标'),currentRequest:point('现在只问进度'),goalStatus:'active',coverage:{v:1,ranges:[{entryId:'one'}],pending:[{entryId:'two'}],complete:false}},timeline:[{id:'entry',revision:2,status:'adopted',goal:point('原始交付目标'),currentRequest:point('现在只问进度'),preservedFacts:[point('必须保留的事实')],conflicts:[{...point('待核对冲突'),reason:'来源不同'}],sourceEntries:[{sessionId:'pi',entryId:'source'}]}]});await f.flush();const html=f.html();for(const text of ['原始交付目标','现在只问进度','必须保留的事实','待核对冲突','来源不同','已采用范围 1 条','待覆盖 1 条','覆盖尚未完成或未记录']){assert.ok(html.includes(text),text);}assert.match(html,/仅 Pi 实际采用后更新有效覆盖/);
});
