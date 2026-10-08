import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as path from 'node:path';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as views from '../apps/desktop/src/session-view.js';
import * as policy from '../apps/desktop/src/browser-policy.js';
function fixture(){
  class Contents extends EventEmitter {
    mainFrame={};destroyed=false;zoom=1;url='';popup:any;sent:any[]=[];focused=0;navigationHistory={canGoBack:()=>true,goBack:()=>{},canGoForward:()=>true,goForward:()=>{}};
    async loadURL(url:string){this.url=url;this.emit('did-navigate',{},url);}
    async loadFile(_path:string){await Promise.resolve();}
    send(channel:string,value:any){this.sent.push({channel,value});}
    isDestroyed(){return this.destroyed;}close(){this.destroyed=true;this.emit('destroyed');}reload(){this.emit('did-stop-loading');}
    setWindowOpenHandler(handler:any){this.popup=handler;}getZoomFactor(){return this.zoom;}setZoomFactor(value:number){this.zoom=value;}focus(){this.focused++;}
  }
  class View {webContents:Contents;visible=false;bounds:any;preferences:any;constructor(options:any){if(Object.hasOwn(options,'webContents')&&!options.webContents)throw Error('invalid webContents option');this.webContents=options.webContents||new Contents();this.preferences=options.webPreferences;made.push(this);}setVisible(v:boolean){this.visible=v;}setBounds(v:any){this.bounds=v;}setBackgroundColor(){} }
  class Session extends EventEmitter {permission:any;check:any;setPermissionRequestHandler(v:any){this.permission=v;}setPermissionCheckHandler(v:any){this.check=v;}}
  const made:View[]=[],partitions=new Map<string,Session>(),contexts=new Map<string,any>(),events:any[]=[],children:View[]=[];
  const window={webContents:new Contents(),getContentSize:()=>[1200,800],contentView:{addChildView(view:View){const i=children.indexOf(view);if(i>=0)children.splice(i,1);children.push(view);},removeChildView(view:View){const i=children.indexOf(view);if(i>=0)children.splice(i,1);}}};
  const compiled=transformSync(readFileSync(new URL('../apps/desktop/src/browser-host.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs',target:'node24'}).code;
  const scope:any={module:{exports:{}},exports:{},console,Promise,Map,Set,Number,String,Math,Error,Object,require(name:string){if(name==='electron')return {WebContentsView:View,session:{fromPartition(key:string){if(!partitions.has(key))partitions.set(key,new Session());return partitions.get(key);}},dialog:{}};if(name==='node:path')return path;if(name==='node:crypto')return {randomUUID};if(name==='./browser-policy.js')return policy;if(name==='./session-view.js')return views;throw Error(name);}};scope.exports=scope.module.exports;
  vm.runInNewContext(compiled,scope);const Host=scope.module.exports.BrowserHost;
  const context=(id:string)=>{const value=contexts.get(id);if(!value)throw Error('missing owner');return value;};
  const save=(id:string,ui:any)=>{context(id).ui=views.validateView(ui);};
  const host=new Host(window,'/fixture',context,save,(type:string,data:any,owner:string)=>events.push({type,data,owner}));
  const owner=(id:string,scope:views.BrowserScope='app',workspacePath='/same')=>{const ui={...views.initialView(),browserScope:scope,tabs:[{id:'web-'+id,kind:'browser',url:'https://example.com/'}],active:'web-'+id};contexts.set(id,{id,workspacePath,ui});return ui;};
  return {host,made,partitions,contexts,events,children,window,owner,Contents};
}
const bounds={x:250,y:60,width:900,height:700};
test('native guest isolation, tab switching, stale hide fencing and crash recovery',async()=>{
  const f=fixture();f.owner('a');f.owner('b');f.host.present('a','web-a',bounds);const a=f.made[0];assert.equal(a.preferences.nodeIntegration,false);assert.equal(a.preferences.sandbox,true);assert.equal(a.preferences.preload,undefined);
  f.host.present('b','web-b',bounds);const b=f.made[1];f.host.present('a','web-a');assert.equal(b.visible,true);assert.equal(a.visible,false);
  b.webContents.emit('render-process-gone');assert.equal(b.visible,false);f.host.action('b','web-b','reload');assert.equal(b.visible,true);
  const count=b.webContents.focused;f.host.present('b','web-b',{...bounds,width:800});assert.equal(b.webContents.focused,count);
  f.host.destroy();f.host.destroy();assert.ok(f.made.every(v=>v.webContents.destroyed));
});
test('popup adopts Electron contents, inherits partition, persists blank URL and remains sandboxed',async()=>{
  const f=fixture();f.owner('a','session');f.host.present('a','web-a',bounds);const a=f.made[0],popup=new f.Contents();
  const response=a.webContents.popup({url:'about:blank',disposition:'new-window'});assert.equal(response.action,'allow');assert.equal(response.overrideBrowserWindowOptions.webPreferences.preload,undefined);
  assert.equal(response.createWindow({webContents:popup}),popup);const child=f.made[1];assert.equal(child.preferences.session,a.preferences.session);
  popup.emit('did-navigate',{},'about:blank');assert.equal(f.contexts.get('a').ui.tabs[1].url,'about:blank');
  assert.equal(a.webContents.popup({url:'file:///etc/passwd',disposition:'new-window'}).action,'deny');f.host.destroy();
});
test('download save prompt is configured synchronously; closing source tab retains transfer until done',async()=>{
  const f=fixture(),ui=f.owner('a');f.host.present('a','web-a',bounds);const entry=f.made[0];
  class Item extends EventEmitter {options:any;getFilename(){return '../artifact.zip';}getTotalBytes(){return 100;}getReceivedBytes(){return 20;}getSavePath(){return '/chosen/artifact.zip';}setSaveDialogOptions(value:any){this.options=value;}cancel(){this.emit('done',{},'cancelled');}}
  const item=new Item();f.partitions.values().next().value!.emit('will-download',{},item,entry.webContents);assert.equal(item.options.defaultPath,'artifact.zip');
  f.contexts.get('a').ui={...ui,tabs:[],active:'conversation'};f.host.reconcile('a',f.contexts.get('a').ui);assert.equal(entry.webContents.destroyed,false);
  item.emit('updated',{},'interrupted');assert.equal(f.host.snapshot('a').downloads[0].state,'interrupted');f.host.cancelDownload('a',f.host.snapshot('a').downloads[0].id);assert.equal(entry.webContents.destroyed,true);assert.equal(f.host.snapshot('a').downloads[0].state,'cancelled');f.host.destroy();
});
test('trusted composer bootstrap uses latest owner, stale tokens are rejected and native bounds follow zoom',async()=>{
  const f=fixture();f.owner('a');f.owner('b');f.window.webContents.zoom=1.25;
  f.host.syncComposer('a',{sessionId:'a',draft:'old'}, {x:700,y:500,width:400,height:200});
  f.host.syncComposer('b',{sessionId:'b',draft:'new'}, {x:700,y:500,width:400,height:200});await Promise.resolve();await Promise.resolve();
  const overlay=f.made[0],last=overlay.webContents.sent.at(-1).value;assert.equal(last.sessionId,'b');assert.equal(last.draft,'new');assert.equal(overlay.bounds.x,875);
  assert.equal(f.host.acceptsOverlay({sender:overlay.webContents,senderFrame:overlay.webContents.mainFrame}),true);assert.equal(f.host.acceptsOverlay({sender:new f.Contents(),senderFrame:{}}),false);
  assert.throws(()=>f.host.overlayAction({sessionId:'a',token:last.token,type:'draft',value:'late'}));f.host.overlayAction({sessionId:'b',token:last.token,type:'draft',value:'accepted'});assert.equal(f.events.at(-1).type,'composer.action');f.host.destroy();
});

test('popup self-close removes its dead native entry and restores the opener tab',()=>{const f=fixture();f.owner('a');f.host.present('a','web-a',bounds);const response=f.made[0].webContents.popup({url:'https://example.com/child',disposition:'new-window'}),popup=new f.Contents();response.createWindow({webContents:popup});assert.equal(f.contexts.get('a').ui.tabs.length,2);popup.close();assert.equal(f.contexts.get('a').ui.tabs.length,1);assert.equal(f.contexts.get('a').ui.active,'web-a');assert.equal(f.host.snapshot('a').tabs.length,1);f.host.destroy();});

test('switching desktop context hides every native surface while retaining guest identity',()=>{const f=fixture();f.owner('a');f.host.present('a','web-a',bounds);const first=f.made[0];f.host.hide();assert.equal(first.visible,false);assert.equal(first.webContents.destroyed,false);f.host.present('a','web-a',bounds);assert.equal(f.made.length,1);assert.equal(first.visible,true);f.host.destroy();});

test('switching sessions puts trusted composer above guest regardless of presentation order',()=>{
  const f=fixture();f.owner('a');f.owner('b');f.host.present('a','web-a',bounds);f.host.syncComposer('a',{sessionId:'a'},bounds);const overlay=f.made[1];
  f.host.hide();f.host.present('b','web-b',bounds);assert.notEqual(f.children.at(-1),overlay);f.host.syncComposer('b',{sessionId:'b'},bounds);assert.equal(f.children.at(-1),overlay);assert.equal(overlay.visible,true);
  f.host.hide();f.host.syncComposer('a',{sessionId:'a'},bounds);f.host.present('a','web-a',bounds);assert.equal(f.children.at(-1),overlay);f.host.destroy();
});

test('untrusted history navigation cannot crash the host or persist credential/local URLs',()=>{const f=fixture();f.owner('a');f.host.present('a','web-a',bounds);const guest=f.made[0];for(const url of ['https://user:password@example.com/','file:///etc/passwd','javascript:alert(1)'])assert.doesNotThrow(()=>guest.webContents.emit('did-navigate-in-page',{},url,true));assert.equal(f.contexts.get('a').ui.tabs[0].url,'https://example.com/');assert.equal(f.host.snapshot('a').tabs[0].url,'https://example.com/');assert.ok(f.host.snapshot('a').tabs[0].error);f.host.destroy();});
