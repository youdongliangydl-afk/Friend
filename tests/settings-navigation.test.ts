import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {renderToStaticMarkup} from 'react-dom/server';
import * as rendererTypes from '../apps/desktop/src/renderer/types.js';
import * as ui from '../apps/desktop/src/renderer/ui.js';
import * as sessionView from '../apps/desktop/src/session-view.js';
import {permissionOptions} from '../apps/desktop/src/renderer/composer-permissions.js';
import {CapabilitiesPanel} from '../apps/desktop/src/renderer/CapabilitiesPanel.js';
import type {AppState,Preferences} from '../apps/desktop/src/renderer/types.js';

const initialPreferences:Preferences={defaultModelId:'fixture/saved',defaultThinkingLevel:'off',defaultPlugins:['swarm','expert','memory','topic-rebuild'],defaultMode:'single',defaultPlanMode:false,defaultPermissionMode:'auto',defaultBrowserScope:'app',contextMode:'native',backgroundModelId:''};
const state:AppState={projects:[{id:'project',name:'Project',path:'/fixture/project'}],sessions:[],models:[{id:'fixture/saved',provider:'fixture',name:'Saved model',reasoning:false,contextWindow:8192,thinkingLevels:['off'],ready:true},{id:'fixture/draft',provider:'fixture',name:'Unsaved model',reasoning:true,contextWindow:8192,thinkingLevels:['off','high'],ready:true}],providers:[{id:'fixture',name:'Fixture',configured:true}],preferences:initialPreferences,current:{sessionId:'session',projectId:'project',messages:[],isRunning:false,modelId:'fixture/saved',thinkingLevel:'off',plugins:[...initialPreferences.defaultPlugins]}};
function settings(changes:Partial<Preferences>={}) {return {preferences:{...initialPreferences,...changes},models:state.models,providers:state.providers,paths:{dataDir:'/fixture/data'},piSource:'fixture-pi'};}
type Node={type:unknown;props:Record<string,any>};
function nodes(value:any):Node[] {return !value?[]:Array.isArray(value)?value.flatMap(nodes):typeof value==='object'&&value.props?[value,...nodes(value.props.children)]:[];}
function text(value:any):string {return typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';}
function plain<T>(value:T):T {return JSON.parse(JSON.stringify(value));}

/** Execute the production component, retaining real callbacks and asynchronous effects. */
function fixture(page:'general'|'extensions'='general') {
  let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],requests:{method:string;input:Record<string,unknown>;resolve(value:unknown):void;reject(error:Error):void}[]=[],reports:string[]=[];
  const same=(before:unknown[]|undefined,after:unknown[]|undefined)=>!!before&&!!after&&before.length===after.length&&before.every((value,index)=>Object.is(value,after[index]));
  const hooks={
    useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useRef(initial:unknown){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useCallback(callback:unknown,deps:unknown[]){const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={callback,deps};return slots[index].callback;},
    useEffect(callback:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot={deps,cleanup:previous?.cleanup};slots[index]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});},
  };
  const stubs=new Map<string,object>();
  const context:any={console,window:{friendPi:{request(method:string,input:Record<string,unknown>={}){if(method==='learning.state')return Promise.resolve({alive:true,paused:false});return new Promise((resolve,reject)=>requests.push({method,input,resolve,reject}));}}},module:{exports:{}},require(name:string){
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;
    if(name==='./types.js')return rendererTypes;if(name==='./ui.js')return ui;if(name==='../session-view.js')return sessionView;
    if(name==='./composer-permissions.js')return {permissionOptions};if(name==='./CapabilitiesPanel.js')return {CapabilitiesPanel};
    if(!stubs.has(name))stubs.set(name,new Proxy({}, {get(_target,key){return function SettingsChild(){return React.createElement('div',{'data-settings-child':String(key)});};}}));return stubs.get(name);
  }};
  vm.runInNewContext(transformSync(readFileSync('apps/desktop/src/renderer/App.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
  assert.equal(typeof context.module.exports.SettingsPanel,'function','exercise the exported production SettingsPanel');
  const props={state,projectId:'project',page,report:(message:string)=>reports.push(message),refresh:async()=>state,setPage:(value:typeof page)=>{props.page=value;},onClose(){},onBusy(){}};
  function render(runEffects=true){cursor=0;const tree=context.module.exports.SettingsPanel(props);if(runEffects)while(effects.length)effects.shift()!();return tree;}
  function field(label:string,runEffects=true){const node=nodes(render(runEffects)).find(node=>node.type===ui.Field&&node.props.label===label);assert.ok(node,`field ${label} exists`);return nodes(node.props.children).find(node=>node.type==='select')!.props;}
  function capability(label='启用 Expert',runEffects=true){const row=nodes(render(runEffects)).find(node=>node.type==='label'&&text(node)===label);assert.ok(row,`${label} control exists`);return nodes(row.props.children).find(node=>node.type==='input')!.props;}
  async function flush(){for(let i=0;i<12;i++)await Promise.resolve();return render();}
  function get(index=0){const request=requests.filter(request=>request.method==='settings.get')[index];assert.ok(request,`settings load ${index} was dispatched`);return request;}
  function changeScope(value:'global'|'project'){field('设置作用域').onChange({target:{value}});}
  return {render,field,capability,flush,get,changeScope,requests,reports,props};
}

test('Settings switches and save stay disabled until initial and changed-scope loads finish',async()=>{
  const f=fixture();const first=f.capability();assert.equal(first.disabled,true);
  first.onChange({target:{checked:false}});assert.equal(f.requests.some(request=>request.method==='settings.update'),false,'guard also rejects a stale/programmatic callback');
  assert.equal(nodes(f.render()).find(node=>node.type==='button'&&node.props.type==='submit')!.props.disabled,true);
  f.get().resolve(settings());await f.flush();assert.equal(f.capability().disabled,false);
  f.changeScope('project');assert.equal(f.capability('启用 Expert',false).disabled,true,'scope event disables the switch before its effect dispatches');
  f.render();assert.equal(f.get(1).input.projectId,'project');
  f.get(1).resolve(settings({defaultPlugins:['swarm','memory','topic-rebuild']}));await f.flush();
  assert.equal(f.capability().disabled,false);assert.equal(f.capability().checked,false);
  f.capability().onChange({target:{checked:true}});const projectUpdate=f.requests.find(request=>request.method==='settings.update')!;
  assert.deepEqual(plain(projectUpdate.input),{defaultPlugins:['swarm','memory','topic-rebuild','expert'],projectId:'project'});
  projectUpdate.resolve(settings());await f.flush();assert.equal(f.capability().checked,true);
});

test('an old global load cannot overwrite a newer completed project settings load',async()=>{
  const f=fixture();f.render();const global=f.get();f.changeScope('project');f.render();const project=f.get(1);
  project.resolve(settings({defaultPlugins:['swarm','memory','topic-rebuild'],defaultModelId:'fixture/draft'}));await f.flush();
  assert.equal(f.capability().checked,false);assert.equal(f.field('默认模型').value,'fixture/draft');
  global.resolve(settings());await f.flush();
  assert.equal(f.capability().checked,false);assert.equal(f.field('默认模型').value,'fixture/draft');assert.equal(f.capability().disabled,false);
});

test('completion of an old global load cannot unlock the pending project switch',async()=>{
  const f=fixture();f.render();const global=f.get();f.changeScope('project');f.render();const project=f.get(1);
  global.resolve(settings());await f.flush();assert.equal(f.capability().disabled,true);
  f.capability().onChange({target:{checked:false}});assert.equal(f.requests.some(request=>request.method==='settings.update'),false);
  project.resolve(settings({defaultPlugins:['swarm','memory','topic-rebuild']}));await f.flush();assert.equal(f.capability().disabled,false);assert.equal(f.capability().checked,false);
});

test('Expert toggle submits only its plugin change and keeps unsaved model drafts local',async()=>{
  const f=fixture();f.render();f.get().resolve(settings());await f.flush();
  f.field('默认模型').onChange({target:{value:'fixture/draft'}});f.field('默认思考等级').onChange({target:{value:'high'}});
  f.capability().onChange({target:{checked:false}});
  const off=f.requests.find(request=>request.method==='settings.update')!;assert.ok(off);
  assert.deepEqual(plain(off.input),{defaultPlugins:['swarm','memory','topic-rebuild']});assert.equal(f.capability().disabled,true);
  off.resolve(settings({defaultPlugins:['swarm','memory','topic-rebuild']}));await f.flush();
  assert.equal(f.field('默认模型').value,'fixture/draft');assert.equal(f.field('默认思考等级').value,'high');assert.equal(f.capability().checked,false);
  f.capability().onChange({target:{checked:true}});const on=f.requests.filter(request=>request.method==='settings.update')[1];
  assert.deepEqual(plain(on.input),{defaultPlugins:['swarm','memory','topic-rebuild','expert']});
  on.resolve(settings());await f.flush();assert.equal(f.capability().checked,true);assert.equal(f.field('默认模型').value,'fixture/draft');
});

test('Settings retain only General Expert switch and external Extensions capabilities',async()=>{
  const f=fixture('extensions');f.render();f.get().resolve(settings());await f.flush();
  const html=renderToStaticMarkup(f.render());assert.match(html,/外部能力设置/);assert.match(html,/连接你的工具服务/);
  assert.doesNotMatch(html,/Swarm|上下文高级诊断|专家库与版本管理|专家库|方法候选/);
  const nav=nodes(f.render()).find(node=>node.type==='nav')!;
  assert.equal(text(nav),'常规模型自定义指令记忆扩展');
  f.props.page='general';const tree=f.render();const general=nodes(tree).find(node=>node.type==='div'&&'data-settings-general' in node.props)!;
  assert.equal(general.props.hidden,false);
  const expertRows=nodes(general).filter(node=>node.type==='label'&&text(node)==='启用 Expert');
  assert.equal(expertRows.length,1);assert.equal(nodes(expertRows[0]).filter(node=>node.type==='input'&&node.props.role==='switch').length,1);
  assert.doesNotMatch(renderToStaticMarkup(general as any),/专家库|擅长领域|Skill|后台验证|Swarm|高级诊断|Expert 页面/);
});
