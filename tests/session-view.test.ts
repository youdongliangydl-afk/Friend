import test from 'node:test';
import assert from 'node:assert/strict';
import {initialView,validateView,browserUrl,mergeViewUpdate} from '../apps/desktop/src/session-view.js';
import {browserPartition} from '../apps/desktop/src/browser-policy.js';
import {openTool,addNewTab,closeViewTab} from '../apps/desktop/src/renderer/view-tabs.js';
test('pending renderer updates preserve concurrent popup creation and self-close',()=>{
  const base=validateView({...initialView(),tabs:[{id:'web',kind:'browser',url:'https://example.com'}],active:'web'});
  const popup={id:'popup',kind:'browser' as const,url:'about:blank'},prior=validateView({...base,tabs:[...base.tabs,popup],active:'popup'});
  const merged=mergeViewUpdate(prior,base,{...base,sidebar:false});assert.equal(merged.active,'popup');assert.equal(merged.tabs.length,2);assert.equal(merged.sidebar,false);
  const closed=validateView({...prior,tabs:base.tabs,active:'web'});
  const after=mergeViewUpdate(closed,prior,{...prior,composerCollapsed:true});assert.equal(after.active,'web');assert.equal(after.tabs.length,1);
  const explicit=mergeViewUpdate(prior,base,{...base,tabs:[],active:'conversation'});assert.deepEqual(explicit.tabs.map(t=>t.id),['popup']);assert.equal(explicit.active,'conversation');
});
test('legacy layout remains standard; new session defaults and normal panel snapshot round trip',()=>{
  assert.equal(initialView().mode,'standard');const view=initialView({defaultLayoutMode:'fullscreen',defaultBrowserScope:'project'});
  assert.deepEqual(validateView({...view,normalPage:'diff',normalTerminal:true}),{...view,normalPage:'diff',normalTerminal:true});
  assert.equal(view.browserScope,'project');
});
test('tool launcher consumes blank tab, focuses a singleton and closes without closing conversation',()=>{
  let view=addNewTab(initialView());view=openTool(view,'diff');const id=view.active;assert.equal(view.tabs.length,1);
  view=openTool(addNewTab(view),'diff');assert.equal(view.active,id);assert.equal(view.tabs.length,1);
  const second=openTool(view,'file');assert.equal(second.tabs.length,2);assert.equal(closeViewTab(second,second.active).active,id);
  assert.equal(closeViewTab(view,id).active,'conversation');assert.deepEqual(closeViewTab(view,'conversation'),view);
});
test('persistent browser partition shares exactly the selected scope and survives workspace promotion',()=>{
  assert.equal(browserPartition('app','a','/a'),browserPartition('app','b','/b'));
  assert.equal(browserPartition('project','a','/same'),browserPartition('project','b','/same'));
  assert.notEqual(browserPartition('project','a','/a'),browserPartition('project','a','/b'));
  assert.notEqual(browserPartition('session','a','/same'),browserPartition('session','b','/same'));
  assert.equal(browserPartition('session','a','/before'),browserPartition('session','a','/after'));
  assert.ok(browserPartition('project','a','/same').startsWith('persist:'));assert.ok(!browserPartition('project','a','/same').includes('/same'));
});
test('navigation rejects executable/local protocols and credentials; accepts Unicode and localhost',()=>{
  assert.equal(browserUrl('localhost:3000/a'),'http://localhost:3000/a');assert.equal(browserUrl('example.com'),'https://example.com/');
  for(const value of ['javascript:alert(1)','file:///etc/passwd','data:text/html,hello','https://user:secret@example.com',''])assert.throws(()=>browserUrl(value));
  assert.match(browserUrl('https://example.com/中文'),/%E4/);
});
test('UI validation fences malformed tabs, duplicate tools and unknown selection; preserves safe blank popup',()=>{
  const view=openTool(initialView(),'diff');
  assert.throws(()=>validateView({...view,tabs:[...view.tabs,{id:'other',kind:'tool',page:'diff'}]}),/重复/);
  assert.throws(()=>validateView({...view,active:'missing'}),/不存在/);
  assert.throws(()=>validateView({...view,browserScope:'unknown'}),/无效/);
  assert.throws(()=>validateView({...view,tabs:[{id:'evil',kind:'browser',url:'file:///etc/passwd'}]}));
  assert.equal(validateView({...initialView(),tabs:[{id:'blank',kind:'browser',url:'about:blank'}],active:'blank'}).tabs[0].url,'about:blank');
});
