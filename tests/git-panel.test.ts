import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ui from '../apps/desktop/src/renderer/ui.js';
import * as types from '../apps/desktop/src/renderer/types.js';
type Node={type:unknown;props:Record<string,any>};
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
type Slot={value:any;deps?:unknown[];cleanup?:()=>void};
const status=(changes:Record<string,unknown>={})=>({branch:'main',detached:false,head:'a'.repeat(40),shortHead:'aaaaaaa',files:[{path:'file.txt',xy:' M',letter:'M',staged:false,unstaged:true,untracked:false,conflict:false}],staged:0,unstaged:1,untracked:0,truncated:false,clean:false,projectPath:'/p',repoPath:'/p',...changes});
const history=(commits:unknown[]=[{sha:'a'.repeat(40),shortSha:'aaaaaaa',subject:'初始提交',author:'Fixture',at:'2026-01-02T03:04:05Z',parents:[],refs:['main']}])=>({branch:'main',detached:false,head:'a'.repeat(40),commits,mayHaveMore:false,emptyRepository:false,projectPath:'/p'});
/** Runs the production component with deterministic hooks; only IPC results are substituted. */
function panel(initial:{status?:unknown;history?:unknown}={}){
  const slots:Slot[]=[],effects:Array<()=>void>=[],requests:{method:string;input:Record<string,unknown>;resolve(value:unknown):void;reject(error:Error):void}[]=[],reports:string[]=[];
  let index=0,dirty=false,tree:Node;
  const answers:Record<string,unknown>={status:initial.status??status(),history:initial.history??history()};
  const hooks={
    useState(initial:unknown){const id=index++;if(!slots[id])slots[id]={value:typeof initial==='function'?(initial as ()=>unknown)():initial};return [slots[id].value,(next:unknown)=>{const value=typeof next==='function'?(next as (value:unknown)=>unknown)(slots[id].value):next;if(!Object.is(value,slots[id].value)){slots[id].value=value;dirty=true;}}];},
    useRef(initial:unknown){const id=index++;if(!slots[id])slots[id]={value:{current:initial}};return slots[id].value;},
    useEffect(effect:()=>void|(()=>void),deps:unknown[]){const id=index++,prior=slots[id];if(!prior||deps.some((value,i)=>!Object.is(value,prior.deps?.[i]))){slots[id]={value:undefined,deps};effects.push(()=>{prior?.cleanup?.();const cleanup=effect();if(typeof cleanup==='function')slots[id].cleanup=cleanup;});}},
  };
  const module={exports:{} as {GitPanel:(props:Record<string,unknown>)=>Node}};
  const context=vm.createContext({module,exports:module.exports,require:(name:string)=>{
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return jsxRuntime;
    if(name==='./ui.js')return ui;
    if(name==='./types.js')return types;
    throw new Error('Unexpected component import: '+name);
  },window:{friendPi:{request:(method:string,input:Record<string,unknown>)=>{if(method==='git.status')return Promise.resolve(answers.status);if(method==='git.log')return Promise.resolve(answers.history);return new Promise((resolve,reject)=>requests.push({method,input,resolve,reject}));}}},Date});
  vm.runInContext(transformSync(readFileSync('apps/desktop/src/renderer/GitPanel.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
  const props={workspace:{kind:'project',projectId:'project'},report:(message:string)=>reports.push(message)};
  function render(){let turns=0;do{if(++turns>10)throw new Error('render loop');dirty=false;index=0;tree=module.exports.GitPanel(props);while(effects.length)effects.shift()!();}while(dirty);return tree;}
  function nodes(){const result:Node[]=[];function visit(value:unknown){if(Array.isArray(value)){value.forEach(visit);return;}if(value&&typeof value==='object'&&'props' in value){const node=value as Node;result.push(node);visit(node.props.children);}}visit(tree);return result;}
  const text=(value:any):string=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'&&'props' in value?(value.type==='style'?'':text(value.props.children)):typeof value==='string'||typeof value==='number'?String(value):'';
  async function flush(){for(let i=0;i<10;i++)await Promise.resolve();render();}
  const button=(label:string)=>{const found=nodes().find(node=>node.type==='button'&&text(node.props.children)===label);assert.ok(found,'button '+label);return found.props;};
  const action=(label:string)=>{const found=nodes().find(node=>node.type==='button'&&node.props['aria-label']===label);assert.ok(found,'aria '+label);return found.props;};
  const textarea=()=>nodes().find(node=>node.type==='textarea')!.props;
  const submit=()=>{const form=nodes().find(node=>node.type==='form');assert.ok(form,'commit form');return form.props.onSubmit({preventDefault(){}});};
  return {render,flush,button,action,textarea,submit,nodes,text:()=>text(tree),requests,reports,answers};
}
test('Git panel renders branch, HEAD, status letters and both change groups from git.status',async()=>{
  const p=panel({status:status({files:[{path:'file.txt',xy:' M',letter:'M',staged:false,unstaged:true,untracked:false,conflict:false},{path:'new.txt',xy:'??',letter:'U',staged:false,unstaged:false,untracked:true,conflict:false},{path:'staged.txt',xy:'A ',letter:'A',staged:true,unstaged:false,untracked:false,conflict:false}],staged:1,unstaged:1,untracked:1})});
  p.render();await p.flush();
  assert.match(p.text(),/main/);assert.match(p.text(),/aaaaaaa/);assert.match(p.text(),/1 已暂存 · 1 未暂存 · 1 未跟踪/);
  const letters=p.nodes().filter(node=>String(node.props?.className||'').startsWith('git-letter')).map(node=>node.props.children);
  assert.deepEqual(letters,['A','M','U']);
  assert.match(p.text(),/已暂存 · 1/);assert.match(p.text(),/未暂存 · 2/);assert.match(p.text(),/初始提交/);
});
test('opening a file requests its own diff, and the diff toggle asks for the other side of the index',async()=>{
  const p=panel();for(let i=0;i<2;i++){p.render();await p.flush();}
  p.action('查看 file.txt 的差异').onClick();p.render();
  assert.deepEqual(plain(p.requests.at(-1)?.input),{workspace:{kind:'project',projectId:'project'},path:'file.txt',staged:false});
  p.requests.at(-1)!.resolve({path:'file.txt',staged:false,patch:'@@ -1 +1 @@\n-old\n+new\n',binary:false,untracked:false,truncated:false,additions:1,deletions:1});
  await p.flush();
  assert.match(p.text(),/\+new/);assert.match(p.text(),/\+1 −1/);
  p.button('查看已暂存版本').onClick();p.render();
  assert.equal(p.requests.at(-1)?.input.staged,true);
});
test('stage, unstage and commit only send explicit paths and adopt the returned status',async()=>{
  const p=panel();for(let i=0;i<2;i++){p.render();await p.flush();}
  const stagedStatus=status({files:[{path:'file.txt',xy:'M ',letter:'M',staged:true,unstaged:false,untracked:false,conflict:false}],staged:1,unstaged:0});
  p.button('暂存').onClick();p.render();
  assert.equal(p.requests.at(-1)?.method,'git.stage');assert.deepEqual(plain(p.requests.at(-1)?.input.paths),['file.txt']);
  p.requests.at(-1)!.resolve({status:stagedStatus});await p.flush();
  assert.match(p.text(),/已暂存 · 1/);assert.equal(p.button('提交已暂存改动').disabled,true);
  p.button('取消暂存').onClick();p.render();
  assert.equal(p.requests.at(-1)?.method,'git.unstage');assert.deepEqual(plain(p.requests.at(-1)?.input.paths),['file.txt']);
  p.requests.at(-1)!.resolve({status:status()});await p.flush();
  assert.equal(p.button('全部暂存').disabled,false);assert.equal(p.button('全部取消暂存').disabled,true);
  p.button('暂存').onClick();p.render();p.requests.at(-1)!.resolve({status:stagedStatus});await p.flush();
  p.textarea().onChange({target:{value:'说明改动'}});p.render();
  assert.equal(p.button('提交已暂存改动').disabled,false);
  p.submit();p.render();
  assert.equal(p.requests.at(-1)?.method,'git.commit');assert.equal(p.requests.at(-1)?.input.message,'说明改动');
  p.requests.at(-1)!.resolve({commit:{sha:'b'.repeat(40),shortSha:'bbbbbbb',subject:'说明改动',author:'Fixture',at:'2026-02-03T00:00:00Z',parents:['a'.repeat(40)],refs:[]},status:status({clean:true,files:[],staged:0,unstaged:0,untracked:0})});await p.flush();
  assert.match(p.text(),/工作区干净/);assert.equal(p.textarea().value,'');assert.equal(p.reports.at(-1),'已提交 bbbbbbb：说明改动');
  assert.deepEqual(p.reports.slice(0,-1),['已暂存所选文件','已取消暂存所选文件','已暂存所选文件']);
});
test('a missing repository surfaces the IPC error text instead of inventing a clean tree',async()=>{
  const p=panel();p.answers.status=Promise.reject(new Error('当前项目不是 Git 仓库，无法使用 Git 面板'));p.render();await p.flush();
  assert.match(p.text(),/当前项目不是 Git 仓库/);assert.equal(p.nodes().some(node=>String(node.props?.className||'').includes('git-letter')),false);
});
