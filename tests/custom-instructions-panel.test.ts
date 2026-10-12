import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';
import * as rendererTypes from '../apps/desktop/src/renderer/types.js';

type Node={type:unknown;props:Record<string,any>};
type Request={method:string;input:Record<string,unknown>;resolve(value:unknown):void;reject(error:Error):void};
function nodes(value:any):Node[] {return !value?[]:Array.isArray(value)?value.flatMap(nodes):typeof value==='object'&&value.props?[value,...nodes(value.props.children)]:[];}
function text(value:any):string {return typeof value==='string'||typeof value==='number'?String(value):Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';}
function plain<T>(value:T):T {return JSON.parse(JSON.stringify(value));}

/** Keep the production event handlers and asynchronous effects under test. */
function fixture() {
  let cursor=0;const slots:any[]=[],effects:(()=>void)[]=[],requests:Request[]=[],busy:boolean[]=[];
  const same=(before:unknown[]|undefined,after:unknown[]|undefined)=>!!before&&!!after&&before.length===after.length&&before.every((value,index)=>Object.is(value,after[index]));
  const hooks={
    useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},
    useEffect(callback:()=>void|(()=>void),deps?:unknown[]){const index=cursor++,previous=slots[index];if(previous&&same(previous.deps,deps))return;const slot={deps,cleanup:previous?.cleanup};slots[index]=slot;effects.push(()=>{slot.cleanup?.();slot.cleanup=callback();});},
  };
  const context:any={window:{friendPi:{request(method:string,input:Record<string,unknown>={}){return new Promise((resolve,reject)=>requests.push({method,input,resolve,reject}));}}},module:{exports:{}},require(name:string){
    if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;if(name==='./types.js')return rendererTypes;
    throw new Error(`Unexpected component dependency: ${name}`);
  }};
  vm.runInNewContext(transformSync(readFileSync('apps/desktop/src/renderer/CustomInstructionsPanel.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
  assert.equal(typeof context.module.exports.CustomInstructionsPanel,'function');
  const props={onBusy:(value:boolean)=>busy.push(value)};
  function render(){cursor=0;const tree=context.module.exports.CustomInstructionsPanel(props);while(effects.length)effects.shift()!();return tree;}
  function element(type:string,label?:string){const node=nodes(render()).find(node=>node.type===type&&(label===undefined||text(node)===label));assert.ok(node,`${type} ${label??''} exists`);return node.props;}
  function button(label:string){return element('button',label);}
  function request(method:string,index=0){const value=requests.filter(request=>request.method===method)[index];assert.ok(value,`${method} request ${index} was dispatched`);return value;}
  function edit(value:string){element('textarea').onChange({target:{value}});render();}
  function submit(){element('form').onSubmit({preventDefault(){}});render();}
  async function flush(){for(let i=0;i<12;i++)await Promise.resolve();return render();}
  async function load(value={text:'先给出结论。',revision:7}){render();request('instructions.get').resolve(value);await flush();}
  function status(){return text(nodes(render()).find(node=>node.props.role==='status'));}
  function unmount(){for(const slot of slots)slot?.cleanup?.();}
  return {render,element,button,request,edit,submit,flush,load,status,unmount,requests,busy};
}

test('instructions controls stay disabled until the initial read finishes',async()=>{
  const f=fixture();
  assert.equal(f.element('textarea').disabled,true);assert.equal(f.button('保存').disabled,true);
  assert.equal(f.button('取消修改').disabled,true);assert.equal(f.button('清空').disabled,true);assert.equal(f.status(),'正在读取…');
  f.submit();assert.equal(f.requests.some(request=>request.method==='instructions.update'),false,'submit callback also guards the unloaded state');
  f.request('instructions.get').resolve({text:'全局偏好',revision:3});await f.flush();
  assert.equal(f.element('textarea').disabled,false);assert.equal(f.element('textarea').value,'全局偏好');
  assert.equal(f.button('保存').disabled,true);assert.equal(f.button('清空').disabled,false);assert.equal(f.busy.at(-1),false);
});

test('saving sends the loaded CAS revision and adopts the server revision for the next save',async()=>{
  const f=fixture();await f.load({text:'旧指令',revision:11});f.edit('新的中文指令\n保留换行');f.submit();
  const first=f.request('instructions.update');assert.deepEqual(plain(first.input),{text:'新的中文指令\n保留换行',revision:11});
  assert.equal(f.element('textarea').disabled,true);assert.equal(f.button('保存中…').disabled,true);
  assert.equal(f.button('清空').disabled,true);assert.equal(f.button('取消修改').disabled,true);assert.equal(f.busy.at(-1),true);
  f.submit();assert.equal(f.requests.filter(request=>request.method==='instructions.update').length,1,'a pending save cannot submit twice');
  first.resolve({text:'服务端确认的指令',revision:12});await f.flush();
  assert.equal(f.element('textarea').value,'服务端确认的指令');assert.equal(f.button('保存').disabled,true);assert.equal(f.busy.at(-1),false);
  assert.equal(f.status(),'已保存，下轮对话生效。');
  f.edit('第二次修改');f.submit();assert.deepEqual(plain(f.request('instructions.update',1).input),{text:'第二次修改',revision:12});
});

test('a failed save keeps the draft and its unsaved navigation guard',async()=>{
  const f=fixture();await f.load();f.edit('不要丢失这个草稿');f.submit();
  f.request('instructions.update').reject(new Error('磁盘写入失败'));await f.flush();
  assert.equal(f.element('textarea').value,'不要丢失这个草稿');assert.equal(f.element('textarea').disabled,false);
  assert.match(text(nodes(f.render()).find(node=>node.props.role==='alert')),/磁盘写入失败/);
  assert.equal(f.button('保存').disabled,false);assert.equal(f.button('取消修改').disabled,false);assert.equal(f.busy.at(-1),true);
  f.submit();assert.deepEqual(plain(f.request('instructions.update',1).input),{text:'不要丢失这个草稿',revision:7},'a failed write does not advance the saved revision');
});

test('cancel restores the saved content and clears the error without writing',async()=>{
  const f=fixture();await f.load();f.edit('临时修改');f.submit();f.request('instructions.update').reject(new Error('保存失败'));await f.flush();
  f.button('取消修改').onClick();f.render();
  assert.equal(f.element('textarea').value,'先给出结论。');assert.equal(f.button('保存').disabled,true);assert.equal(f.button('取消修改').disabled,true);
  assert.equal(nodes(f.render()).some(node=>node.props.role==='alert'),false);assert.equal(f.status(),'已取消修改。');assert.equal(f.busy.at(-1),false);
  assert.equal(f.requests.filter(request=>request.method==='instructions.update').length,1,'cancel does not issue another write');
});

test('clear changes only the draft until an explicit empty save succeeds',async()=>{
  const f=fixture();await f.load({text:'待清空指令',revision:3});f.button('清空').onClick();f.render();
  assert.equal(f.element('textarea').value,'');assert.equal(f.button('清空').disabled,true);assert.equal(f.button('保存').disabled,false);
  assert.equal(f.requests.some(request=>request.method==='instructions.update'),false);assert.equal(f.busy.at(-1),true);
  f.button('取消修改').onClick();f.render();assert.equal(f.element('textarea').value,'待清空指令');
  f.button('清空').onClick();f.render();f.submit();const update=f.request('instructions.update');
  assert.deepEqual(plain(update.input),{text:'',revision:3});update.resolve({text:'',revision:4});await f.flush();
  assert.equal(f.status(),'已清空，下轮对话不再添加自定义指令。');assert.equal(f.button('保存').disabled,true);assert.equal(f.busy.at(-1),false);
});

test('onBusy tracks dirty drafts and clears its navigation guard after discard or unmount',async()=>{
  const f=fixture();await f.load();assert.equal(f.busy.at(-1),false);
  f.edit('尚未保存');assert.equal(f.busy.at(-1),true);assert.equal(f.status(),'有未保存的修改');
  f.edit('先给出结论。');assert.equal(f.busy.at(-1),false,'returning to the saved value removes the guard');
  f.edit('另一个草稿');assert.equal(f.busy.at(-1),true);f.unmount();assert.equal(f.busy.at(-1),false,'the parent is not left permanently busy');
});

test('reloading after a revision conflict preserves the draft and saves against the latest revision',async()=>{
  const f=fixture();await f.load({text:'初始指令',revision:2});f.edit('本地未保存草稿');f.submit();
  f.request('instructions.update').reject(new Error('指令已由其他窗口修改'));await f.flush();
  f.button('重新读取').onClick();f.render();assert.equal(f.element('textarea').disabled,true);assert.equal(f.button('保存').disabled,true);
  f.request('instructions.get',1).resolve({text:'另一窗口保存的指令',revision:9});await f.flush();
  assert.equal(f.element('textarea').value,'本地未保存草稿');assert.equal(f.busy.at(-1),true);assert.equal(nodes(f.render()).some(node=>node.props.role==='alert'),false);
  f.submit();assert.deepEqual(plain(f.request('instructions.update',1).input),{text:'本地未保存草稿',revision:9});
  f.request('instructions.update',1).resolve({text:'本地未保存草稿',revision:10});await f.flush();assert.equal(f.busy.at(-1),false);
});

test('an initial read failure can be retried without enabling an unloaded save',async()=>{
  const f=fixture();f.render();f.request('instructions.get').reject(new Error('读取失败'));await f.flush();
  assert.equal(f.element('textarea').disabled,true);assert.equal(f.button('保存').disabled,true);assert.equal(f.button('重新读取').disabled,false);
  f.submit();assert.equal(f.requests.some(request=>request.method==='instructions.update'),false);
  f.button('重新读取').onClick();f.render();f.request('instructions.get',1).resolve({text:'重试读到的内容',revision:8});await f.flush();
  assert.equal(f.element('textarea').disabled,false);assert.equal(f.element('textarea').value,'重试读到的内容');assert.equal(f.button('保存').disabled,true);assert.equal(f.busy.at(-1),false);
});
