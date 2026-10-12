import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {initialView,validateView,type SessionViewState} from '../apps/desktop/src/session-view.js';
import {openTool,toggleTerminal,closeViewTab} from '../apps/desktop/src/renderer/view-tabs.js';
import {errorText} from '../apps/desktop/src/renderer/types.js';

function fixture(view:SessionViewState,holdFirstWrite=false){
  const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8'),start=source.indexOf('  const showTerminal=async()=>{'),end=source.indexOf('  const openNewView=',start);
  assert.ok(start>=0&&end>start,'exercise the production terminal action');
  const viewRef={current:view},terminalOpening={current:false},requests:string[]=[],targets:unknown[]=[],reports:string[]=[],writes:SessionViewState[]=[];
  let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
  const context:any={toggleTerminal,viewRef,terminalOpening,navigationEpoch:{current:0},viewOwner:{current:'chat'},stateRef:{current:{current:{sessionId:'chat'},sessions:[{id:'chat'}]}},errorText,report:(message:string)=>reports.push(message),setTerminalTarget:(target:unknown)=>targets.push(target),window:{friendPi:{async request(method:string){requests.push(method);return {id:'shell'};}}},writeView:async(next:SessionViewState)=>{writes.push(next);viewRef.current=next;if(holdFirstWrite){holdFirstWrite=false;await gate;}return next;}};
  vm.runInNewContext(transformSync(source.slice(start,end)+'\nglobalThis.action=showTerminal;',{loader:'ts',format:'cjs',target:'node24'}).code,context);
  return {action:()=>context.action() as Promise<void>,viewRef,terminalOpening,requests,targets,reports,writes,release};
}

test('terminal action opens once and the next click closes without opening or stopping a shell',async()=>{
  const original=openTool(initialView(),'file'),f=fixture(original);
  await f.action();assert.equal(f.viewRef.current.tabs.at(-1)?.page,'terminal');assert.deepEqual(f.requests,['terminal.open']);assert.deepEqual(JSON.parse(JSON.stringify(f.targets)),[{sessionId:'chat',id:'shell'}]);
  await f.action();assert.equal(f.viewRef.current.active,'conversation');assert.deepEqual(f.viewRef.current.tabs,original.tabs);assert.deepEqual(f.requests,['terminal.open']);assert.deepEqual(f.reports,[]);
  assert.deepEqual(validateView(f.viewRef.current),f.viewRef.current);
});

test('terminal action focuses an existing inactive terminal instead of duplicating its tab',async()=>{
  const terminal=openTool(initialView(),'terminal'),file=openTool(terminal,'file'),f=fixture(file);
  await f.action();assert.equal(f.viewRef.current.active,terminal.active);assert.deepEqual(f.viewRef.current.tabs,file.tabs);assert.equal(f.requests.length,1);
});

test('a second click closes during a pending open and its late completion cannot open a shell',async()=>{
  const original=openTool(initialView(),'file'),f=fixture(original,true),opening=f.action();
  assert.equal(f.terminalOpening.current,true);assert.equal(f.viewRef.current.tabs.at(-1)?.page,'terminal');
  await f.action();assert.equal(f.viewRef.current.active,'conversation');assert.deepEqual(f.viewRef.current.tabs,original.tabs);
  f.release();await opening;assert.deepEqual(f.requests,[]);assert.equal(f.terminalOpening.current,false);assert.deepEqual(f.reports,[]);
});

test('a pending open may finish for a retained background terminal tab without stealing focus',async()=>{
  const original=openTool(initialView(),'file'),f=fixture(original,true),opening=f.action(),terminalId=f.viewRef.current.active;
  f.viewRef.current={...f.viewRef.current,active:original.active};
  f.release();await opening;assert.deepEqual(f.requests,['terminal.open']);assert.equal(f.viewRef.current.active,original.active);
  assert.ok(f.viewRef.current.tabs.some(tab=>tab.id===terminalId));assert.deepEqual(f.reports,[]);
});

test('terminal toggle returns to conversation while the tab X keeps its existing adjacent-tab contract',()=>{
  const file=openTool(initialView(),'file'),terminal=openTool(file,'terminal');
  assert.equal(toggleTerminal(terminal).active,'conversation');assert.equal(closeViewTab(terminal,terminal.active).active,file.active);
  assert.deepEqual(toggleTerminal(terminal).tabs,file.tabs);assert.equal(terminal.tabs.length,2,'helpers do not mutate the existing view');
});
