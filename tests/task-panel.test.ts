import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {createElement,type ReactNode} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as rendererTypes from '../apps/desktop/src/renderer/types.js';
import * as ui from '../apps/desktop/src/renderer/ui.js';
import {TaskGraphCanvas,TaskEvidenceSummary} from '../apps/desktop/src/renderer/TaskGraph.js';
import * as graphModel from '../apps/desktop/src/renderer/task-graph-model.js';
import {openTool} from '../apps/desktop/src/renderer/view-tabs.js';
import type {AppState,JsonObject} from '../apps/desktop/src/renderer/types.js';

type Node={type:unknown;props:Record<string,any>};
const nodes=(value:any):Node[]=>!value?[]:Array.isArray(value)?value.flatMap(nodes):typeof value==='object'&&value.props?[value,...nodes(value.props.children)]:[];
const text=(value:any):string=>typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';
const forbidden=/长期目标|可选令牌预算|开始目标|工作目标|生成工作流|编辑结构化步骤|步骤定义 JSON|创建工作流|已保存模板|选择模板|运行方式|启动命令|编辑阶段|完整定义 JSON|追加节点 JSON|追加步骤|保存模板/;
const compiled=transformSync(readFileSync('apps/desktop/src/renderer/task-panel.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code;

/** Load the production panel through its snapshot IPC, then SSR its real status cards and graph. */
function fixture({runtime={},graphs=[],flows=[],mode='swarm',failure,previews=[],receipts=[],confirm=()=>true,failOnce=false}:{runtime?:JsonObject;graphs?:JsonObject[];flows?:JsonObject[];mode?:'single'|'team'|'swarm';failure?:string;previews?:JsonObject[];receipts?:JsonObject[];confirm?:()=>boolean;failOnce?:boolean}={}){
 let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],requests:{method:string;input:JsonObject}[]=[],reports:string[]=[];
 const same=(a:unknown[]|undefined,b:unknown[]|undefined)=>!!a&&!!b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
 const hooks={
  useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
  useRef(initial:unknown){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
  useCallback(callback:unknown,deps:unknown[]){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={callback,deps};return slots[index].callback;},
  useMemo(callback:()=>unknown,deps:unknown[]){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={value:callback(),deps};return slots[index].value;},
  useEffect(callback:()=>void|(()=>void),deps?:unknown[]){const index=cursor++;if(slots[index]&&same(slots[index].deps,deps))return;slots[index]={deps};effects.push(()=>{callback();});},
 };
 const state:AppState={projects:[],sessions:[],models:[],providers:[],current:{sessionId:'desktop-session',piSessionId:'native-session',projectId:'project',messages:[],isRunning:false,modelId:'fixture/model',thinkingLevel:'off',plugins:['swarm'],executionMode:mode,runId:'run',receipts}};let failures=0,previewIndex=0;
 const context:any={module:{exports:{}},require(name:string){
  if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;
  if(name==='./types.js')return rendererTypes;if(name==='./ui.js')return ui;
  if(name==='./TaskGraph.js')return {TaskGraphCanvas,TaskEvidenceSummary};if(name==='./task-graph-model.js')return graphModel;if(name==='./view-tabs.js')return {openTool};
  if(name==='./Teammates.js')return {TeammateRoster:({rootSessionId}:{rootSessionId:string})=>createElement('div',{'data-members-for':rootSessionId}),openTeammate(){throw new Error('SSR must not open a teammate');}};
  throw new Error('Unexpected panel import: '+name);
 },window:{confirm,friendPi:{onEvent:()=>()=>{},request(method:string,input:JsonObject){
  requests.push({method,input});if(input.action==='snapshot')return Promise.resolve(method==='runtime.call'?runtime:input.plugin==='swarm'?{graphs,teammates:[]}:{workflows:flows,templates:[{id:'saved-template',definition:{title:'Old template'}}]});
  if(method==='session.ui.get')return Promise.resolve({version:1,mode:'fullscreen',tabs:[{id:'existing',kind:'browser',url:'https://example.com'}],active:'existing',sidebar:true,composerCollapsed:false,browserScope:'session'});
  if(method==='session.ui.update')return Promise.resolve(input.ui);
  if(input.action==='resume.preview')return Promise.resolve(previews[Math.min(previewIndex++,previews.length-1)]||{});
  if(input.action===failure&&(!failOnce||failures++===0))return Promise.reject(new Error('预算耗尽，请明确增加预算'));
  if(input.action==='jobs.logs')return Promise.resolve({output:'Retained log'});
  if(input.action==='result')return Promise.resolve({summary:'Retained team result'});
  return Promise.resolve({});
 }}}};
 vm.runInNewContext(compiled,context);
 const props={state,report:(message:string)=>reports.push(message)};
 function render(){cursor=0;const tree=context.module.exports.TaskPanel(props) as Node;while(effects.length)effects.shift()!();return tree;}
 async function flush(){for(let i=0;i<16;i++)await Promise.resolve();return render();}
 const markup=()=>renderToStaticMarkup(render() as ReactNode);
 function button(label:string,owner:Node=render()){const found=nodes(owner).find(node=>node.type==='button'&&text(node)===label);assert.ok(found,`button ${label}`);return found;}
 function section(title:string){const found=nodes(render()).find(node=>node.type==='section'&&nodes(node.props.children).some(child=>child.type==='h3'&&text(child).startsWith(title)));assert.ok(found,`section ${title}`);return found;}
 render();return {render,flush,markup,button,section,requests,reports};
}

const goal=(status='active')=>({id:'goal',objective:'已记录目标',status,progress:'已完成范围核查',nextAction:'复核成果',mode:'swarm',tokens:100,tokenBudget:1000});
const flow=(id:string,status:string)=>({id,sessionId:'native-session',status,title:'阶段 '+id,definition:{title:'阶段 '+id,nodes:[{id:'a',title:'只读阶段成果',dependencies:[]}]},nodes:[{id:'a',status:'completed',result:'保留的阶段成果'}]});

test('empty TaskPanel directs goals to Swarm conversation without creation or configuration forms',async()=>{
 const f=fixture();await f.flush();const markup=f.markup();
 assert.match(markup,/在 Swarm 模式的对话中说明目标/);assert.match(markup,/本轮尚未建立任务依赖图/);assert.match(markup,/当前会话队友/);assert.match(markup,/data-members-for="desktop-session"/);
 assert.doesNotMatch(markup,forbidden);assert.doesNotMatch(markup,/<input|<textarea|<select|目标与步骤|动态工作流|后台命令/);
 assert.ok(f.requests.every(request=>request.input.action==='snapshot'),'opening the task page only reads snapshots');
});

test('existing task states, graph, recovery checks, results and execution controls survive form removal',async()=>{
 const graphs=[{id:'graph',sessionId:'native-session',runId:'run',goal:'已有协作任务',status:'paused',tasks:[{id:'a',title:'依赖图任务',dependencies:[],mode:'read',status:'completed',currentAttempt:'attempt'}],attempts:[{id:'attempt',taskId:'a',status:'completed',summary:'图中成果'}]}];
 const f=fixture({runtime:{goal:{...goal('waiting'),waitFor:'user-acceptance',revision:3,acceptance:{binding:'frozen-candidate'}},tasks:[{id:'step',title:'待核对步骤',status:'unknown',evidence:[]}],unknownActivities:[{id:'activity'}],jobs:[{id:'job',name:'已有后台任务',kind:'task',origin:'agent',status:'running'},{id:'unknown-job',name:'中断的后台任务',status:'unknown'}]},graphs,flows:[flow('created','created'),flow('running','running'),flow('paused','paused')]});
 await f.flush();const markup=f.markup();
 for(const label of ['只读任务画布','只读阶段成果','已有协作任务','当前会话队友','现场检查说明','步骤现场检查说明','已检查成果，确认验收','停止目标','验证完成','暂停成员','停止成员','接续成员','已有后台任务','查看日志','停止命令'])assert.match(markup,new RegExp(label));
 assert.doesNotMatch(markup,forbidden);
 const canvas=nodes(f.render()).find(node=>node.type===TaskGraphCanvas);assert.ok(canvas);assert.equal(canvas.props.graphs.find((graph:JsonObject)=>graph.key==='swarm:graph').nodes[0].summary,'图中成果');
 const created=f.section('阶段 created'),running=f.section('阶段 running'),paused=f.section('阶段 paused');
 assert.equal(f.button('启动',created).props.disabled,false);assert.equal(f.button('暂停',running).props.disabled,false);assert.equal(f.button('接续',paused).props.disabled,false);
 f.button('查看阶段',running).props.onClick();assert.match(f.markup(),/保留的阶段成果/);assert.doesNotMatch(f.markup(),forbidden);
 f.button('停止命令',f.section('已有后台任务')).props.onClick();await f.flush();
 assert.ok(f.requests.some(request=>request.method==='runtime.call'&&request.input.action==='jobs.kill'&&rendererTypes.asObject(request.input.input).id==='job'));
 assert.ok(!f.requests.some(request=>['goal.create','workflow.generate','create','revise','append','template.save','jobs.run'].includes(String(request.input.action))));
});

test('stopped goals remain visible and resume preserves budget restrictions and error reporting',async()=>{
 const f=fixture({runtime:{goal:{...goal('stopped'),tokens:1000}},failure:'goal.resume'});await f.flush();
 assert.match(f.markup(),/已记录目标/);assert.match(f.markup(),/已停止/);assert.match(f.markup(),/令牌：1000 \/ 1000/);assert.doesNotMatch(f.markup(),forbidden);
 assert.equal(f.button('接续').props.disabled,false);assert.equal(f.button('停止目标').props.disabled,true);
 f.button('接续').props.onClick();await f.flush();
 const request=f.requests.find(request=>request.input.action==='goal.resume');assert.ok(request);
 assert.deepEqual(JSON.parse(JSON.stringify(request.input.input)),{goalId:'goal'});assert.deepEqual(f.reports,['预算耗尽，请明确增加预算']);
});

test('completed goals retain their evidence without active goal controls or a new goal form',async()=>{
 const f=fixture({runtime:{goal:goal('completed')}});await f.flush();
 assert.match(f.markup(),/已记录目标/);assert.match(f.markup(),/已完成范围核查/);assert.match(f.markup(),/已完成/);
 assert.doesNotMatch(f.markup(),forbidden);assert.doesNotMatch(f.markup(),/停止目标|验证完成|>暂停<|>接续<|已检查成果，确认验收/);
});

test('Team results and existing review controls remain available without manual task creation',async()=>{
 const f=fixture({mode:'team',graphs:[{id:'team-graph',executionStyle:'team',status:'completed',goal:'已有 Team 成果',tasks:[{id:'a',title:'成员成果',status:'completed'}]}]});await f.flush();
 const markup=f.markup();assert.match(markup,/Team 成果/);assert.match(markup,/成员成果/);assert.match(markup,/查看成果/);assert.match(markup,/检查与复核/);assert.match(markup,/整合已复核成果/);assert.match(markup,/停止成员/);assert.doesNotMatch(markup,forbidden);
 f.button('查看成果').props.onClick();await f.flush();assert.match(f.markup(),/Retained team result/);
});
const recoveryPreview=(binding:string,unknown=false)=>({v:1,readOnly:true,binding,sourceValidity:{valid:true},nodes:[{id:'a',decision:unknown?'check':'redo',reasons:[unknown?'副作用未知，必须核对后明确确认':'相关代码变化']}]});
test('resume first shows a readonly preview; unknown side effects retain human confirmation and bind the explicit attempt',async()=>{
 let confirmations=0;const f=fixture({graphs:[{id:'g',sessionId:'native-session',runId:'run',goal:'恢复当前任务',status:'paused',tasks:[{id:'a',status:'unknown',mode:'read',dependencies:[]}],attempts:[]}],previews:[recoveryPreview('frozen-binding',true)],confirm:()=>{confirmations++;return true;}});await f.flush();f.button('接续成员').props.onClick();await f.flush();assert.match(f.markup(),/恢复范围预览/);assert.match(f.markup(),/待核对 · a/);assert.equal(f.requests.filter(r=>r.input.action==='resume').length,0);assert.equal(confirmations,0);
 f.button('确认此预览并接续').props.onClick();await f.flush();const request=f.requests.find(r=>r.input.action==='resume');assert.ok(request);assert.deepEqual(JSON.parse(JSON.stringify(request.input.input)),{graphId:'g',previewBinding:'frozen-binding',confirmUnknown:true});assert.equal(confirmations,1);
});
test('stale recovery errors refresh the preview without replay and use the new binding only after another click',async()=>{
 const f=fixture({graphs:[{id:'g',sessionId:'native-session',runId:'run',goal:'恢复漂移候选',status:'paused',tasks:[],attempts:[]}],previews:[recoveryPreview('old-binding'),recoveryPreview('new-binding')],failure:'resume',failOnce:true});await f.flush();f.button('接续成员').props.onClick();await f.flush();f.button('确认此预览并接续').props.onClick();await f.flush();assert.match(f.markup(),/预览已更新/);assert.equal(f.requests.filter(r=>r.input.action==='resume').length,1);assert.equal(f.requests.filter(r=>r.input.action==='resume.preview').length,2);
 f.button('确认此预览并接续').props.onClick();await f.flush();const calls=f.requests.filter(r=>r.input.action==='resume');assert.equal(calls.length,2);assert.equal(rendererTypes.asObject(calls[1].input.input).previewBinding,'new-binding');
});
test('declining unknown side-effect confirmation does not dispatch recovery',async()=>{
 const f=fixture({graphs:[{id:'g',sessionId:'native-session',runId:'run',goal:'未知恢复',status:'paused',tasks:[{id:'a',status:'unknown'}],attempts:[]}],previews:[recoveryPreview('binding',true)],confirm:()=>false});await f.flush();f.button('接续成员').props.onClick();await f.flush();f.button('确认此预览并接续').props.onClick();await f.flush();assert.equal(f.requests.filter(r=>r.input.action==='resume').length,0);assert.match(f.markup(),/恢复范围预览/);
});
test('workflow recovery previews preserve definition identity and capability receipts expose distinct native stages',async()=>{
 const receipts=[{id:'selected-entry',customType:'friend-pi.memory.usage:v1',data:{runId:'run',stage:'prepared',records:[{id:'memory',revision:2,contentHash:'mh'}]}},{id:'request-entry',customType:'friend-pi.expert.evidence',data:{runId:'run',stage:'request-prepared',dependencies:[{capability:'expert',id:'method',version:4,hash:'eh'}]}}];const f=fixture({flows:[flow('paused','paused')],previews:[{...recoveryPreview('workflow-binding'),definitionRevision:3}],receipts});await f.flush();const markup=f.markup();assert.match(markup,/Memory · 已选中/);assert.match(markup,/Expert · 已进入请求准备/);assert.match(markup,/原生收据与条目引用/);assert.match(markup,/不推断模型采纳或答案正确/);f.button('接续',f.section('阶段 paused')).props.onClick();await f.flush();assert.match(f.markup(),/定义 v3/);f.button('确认此预览并接续').props.onClick();await f.flush();const request=f.requests.find(r=>r.input.action==='resume');assert.equal(request?.input.plugin,'workflow');assert.deepEqual(JSON.parse(JSON.stringify(request?.input.input)),{workflowId:'paused',previewBinding:'workflow-binding'});
});
test('capability source link reuses the current desktop session and retains existing fullscreen tabs',async()=>{
 const f=fixture({receipts:[{id:'native-entry',customType:'friend-pi.memory.usage:v1',data:{runId:'run',stage:'tool-read',records:[{id:'m',revision:1}]}}]});await f.flush();f.button('在 Memory 查看原记录').props.onClick();await f.flush();const request=f.requests.find(r=>r.method==='session.ui.update');assert.ok(request);assert.equal(request.input.sessionId,'desktop-session');const next=rendererTypes.asObject(request.input.ui),tabs=rendererTypes.asList<JsonObject>(next.tabs);assert.equal(next.mode,'fullscreen');assert.ok(tabs.some(t=>t.id==='existing'));assert.ok(tabs.some(t=>t.id===next.active&&t.page==='memory'));assert.ok(!f.requests.some(r=>r.input.action==='create'||r.input.action==='resume'));
});
