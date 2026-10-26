import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as capabilityCatalog from '../apps/desktop/src/renderer/capability-catalog.js';

const compiled=transformSync(readFileSync('apps/desktop/src/renderer/CapabilitiesPanel.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code;
type Node={type:unknown;props:Record<string,any>};
type Slot={value:any;deps?:unknown[];cleanup?:()=>void};
/** Runs production component callbacks with deterministic React hook state and deferred IPC. */
function panel(){
  const slots:Slot[]=[],effects:Array<()=>void>=[],requests:Array<{sessionId:string;action:string;input:unknown}>=[],pending:Array<{action:string;resolve:(value:unknown)=>void}>=[],reports:string[]=[];
  let index=0,dirty=false,sessionId='A',tree:Node;
  const hooks={
    useState(initial:unknown){const id=index++;if(!slots[id])slots[id]={value:typeof initial==='function'?(initial as ()=>unknown)():initial};return [slots[id].value,(next:unknown)=>{const value=typeof next==='function'?(next as (value:unknown)=>unknown)(slots[id].value):next;if(!Object.is(value,slots[id].value)){slots[id].value=value;dirty=true;}}];},
    useRef(initial:unknown){const id=index++;if(!slots[id])slots[id]={value:{current:initial}};return slots[id].value;},
    useEffect(effect:()=>void|(()=>void),deps:unknown[]){const id=index++,prior=slots[id];if(!prior||deps.some((value,i)=>!Object.is(value,prior.deps?.[i]))){slots[id]={value:undefined,deps};effects.push(()=>{prior?.cleanup?.();const cleanup=effect();if(typeof cleanup==='function')slots[id].cleanup=cleanup;});}},
  };
  const snapshot=(id:string)=>({v:1,revision:1,servers:[{name:'shared',type:'stdio',enabled:false,command:id+'-program',args:[],envNames:[],headerNames:[],state:'disabled',tools:[]}],web:{provider:'brave',enabled:id==='A',configured:false,fetchAvailable:true,source:'https://api-dashboard.search.brave.com/app/documentation/web-search/query'}});
  const module={exports:{} as {CapabilitiesPanel:(props:{sessionId:string;report:(message:string)=>void})=>Node}};
  const context=vm.createContext({module,exports:module.exports,require:(name:string)=>{
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx:(type:unknown,props:Node['props'])=>({type,props}),jsxs:(type:unknown,props:Node['props'])=>({type,props}),Fragment:'Fragment'};
    if(name==='./ui.js')return {Field:'Field',Empty:'Empty'};
    if(name==='./types.js')return {errorText:(error:unknown)=>error instanceof Error?error.message:String(error)};
    if(name==='./capability-catalog.js')return capabilityCatalog;
    throw new Error('Unexpected component import: '+name);
  },window:{friendPi:{request:(_method:string,request:any)=>{if(_method==='reference.list')return Promise.resolve({items:[]});const action=request.input.action;requests.push({sessionId:request.sessionId,action,input:request.input.input});if(action==='snapshot')return Promise.resolve(snapshot(request.sessionId));return new Promise(resolve=>pending.push({action,resolve}));}}}});
  vm.runInContext(compiled,context);
  function render(id=sessionId){sessionId=id;let turns=0;do{if(++turns>10)throw new Error('render loop');dirty=false;index=0;tree=module.exports.CapabilitiesPanel({sessionId,report:message=>reports.push(message)});while(effects.length)effects.shift()!();}while(dirty);return tree;}
  function nodes(){const result:Node[]=[];function visit(value:unknown){if(Array.isArray(value)){value.forEach(visit);return;}if(value&&typeof value==='object'&&'props' in value){const node=value as Node;result.push(node);visit(node.props.children);}}visit(tree);return result;}
  const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):typeof value==='string'?value:'';
  const button=(label:string)=>{const found=nodes().find(node=>node.type==='button'&&text(node.props.children)===label);assert.ok(found,'button '+label);return found;};
  const input=(placeholder:string)=>{const found=nodes().find(node=>node.type==='input'&&node.props.placeholder===placeholder);assert.ok(found,'input '+placeholder);return found;};
  const form=(which:number)=>{const found=nodes().filter(node=>node.type==='form')[which];assert.ok(found);return found;};
  async function flush(){for(let i=0;i<8;i++)await Promise.resolve();render();}
  const complete=(action:string,value:unknown)=>{const task=pending.find(item=>item.action===action);assert.ok(task,'pending '+action);task.resolve(value);pending.splice(pending.indexOf(task),1);};
  render();return {render,flush,button,input,form,nodes,complete,requests,reports};
}

test('changing sessions during MCP testing clears busy and removal state; late results stay with their owner',async()=>{
  const ui=panel();await ui.flush();ui.button('移除').props.onClick();ui.render();assert.ok(ui.nodes().some(node=>node.props['aria-label']==='确认移除服务'));
  ui.button('测试连接').props.onClick();ui.render();assert.equal(ui.button('刷新状态').props.disabled,true);
  ui.render('B');await ui.flush();assert.equal(ui.button('刷新状态').props.disabled,false);assert.equal(ui.button('测试连接').props.disabled,false);assert.ok(!ui.nodes().some(node=>node.props['aria-label']==='确认移除服务'));
  const checkbox=ui.nodes().find(node=>node.type==='input'&&node.props.type==='checkbox')!;assert.equal(checkbox.props.checked,false);
  ui.complete('mcp.test',{ok:true});await ui.flush();assert.equal(ui.button('刷新状态').props.disabled,false);assert.deepEqual(ui.reports,[]);assert.equal(ui.requests.filter(request=>request.action==='snapshot'&&request.sessionId==='A').length,1);
});

test('a late MCP save cannot clear a new session edit or its draft',async()=>{
  const ui=panel();await ui.flush();ui.input('例如 docs-tools').props.onChange({target:{value:'a-new'}});ui.input('例如 npx').props.onChange({target:{value:'a-program'}});ui.render();ui.form(0).props.onSubmit({preventDefault(){}});ui.render();
  ui.render('B');await ui.flush();ui.button('编辑').props.onClick();ui.render();ui.input('例如 npx').props.onChange({target:{value:'b-unsaved-program'}});ui.render();
  ui.complete('mcp.save',{});await ui.flush();assert.equal(ui.input('例如 docs-tools').props.value,'shared');assert.equal(ui.input('例如 docs-tools').props.disabled,true,'B must remain in edit mode');assert.equal(ui.input('例如 npx').props.value,'b-unsaved-program');assert.deepEqual(ui.reports,[]);
});

test('a late search configuration save cannot erase a new session credential draft',async()=>{
  const ui=panel();await ui.flush();ui.input('粘贴 Brave Search API Key').props.onChange({target:{value:'a-unsaved-key'}});ui.render();ui.form(1).props.onSubmit({preventDefault(){}});ui.render();
  ui.render('B');await ui.flush();ui.input('粘贴 Brave Search API Key').props.onChange({target:{value:'b-unsaved-key'}});ui.render();ui.complete('web.save',{});await ui.flush();assert.equal(ui.input('粘贴 Brave Search API Key').props.value,'b-unsaved-key');assert.equal(ui.button('保存检索配置').props.disabled,false);assert.deepEqual(ui.reports,[]);
});

const readable=(value:any):string=>Array.isArray(value)?value.map(readable).join(''):value&&typeof value==='object'?readable(value.props?.children):typeof value==='string'?value:'';
test('capability center renders the four sources with three explicit states and honest empty states',async()=>{
  const ui=panel();await ui.flush();
  const sections=ui.nodes().filter(node=>node.type==='section'&&node.props['aria-label']);
  assert.deepEqual(sections.map(node=>node.props['aria-label']).filter(label=>['Skills','Plugins','MCP','Slash 命令'].includes(label)),['Skills','Plugins','MCP','Slash 命令']);
  const mcp=readable(sections.find(node=>node.props['aria-label']==='MCP')!);
  assert.match(mcp,/shared/);assert.match(mcp,/✓ 已配置/);assert.match(mcp,/— 已加载/);assert.match(mcp,/— 当前会话可用/);assert.match(mcp,/服务已停用/);
  assert.match(readable(sections.find(node=>node.props['aria-label']==='Plugins')!),/未提供当前会话的插件启用列表/);
  assert.match(readable(sections.find(node=>node.props['aria-label']==='Skills')!),/没有返回技能/);
  assert.match(readable(sections.find(node=>node.props['aria-label']==='Slash 命令')!),/没有注册 slash 命令/);
});
