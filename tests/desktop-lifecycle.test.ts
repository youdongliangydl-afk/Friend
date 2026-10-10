import {MessageQueue} from '../apps/desktop/src/message-queue.js';
import {ownedEntries} from '../apps/desktop/src/task-todo.js';
import * as sessionView from '../apps/desktop/src/session-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {RecordStore,object,text,digest,projectIdentity,isSessionDeleted,parsePermissionMode} from '../packages/core/src/index.js';
import * as modelReadiness from '../apps/desktop/src/model-readiness.js';
import * as workspaceRefs from '../apps/desktop/src/workspaces.js';
import * as fileEditor from '../apps/desktop/src/file-editor.js';
import * as htmlPreview from '../apps/desktop/src/html-preview.js';
import * as workspace from '../apps/desktop/src/workspace-files.js';
import * as runChanges from '../apps/desktop/src/run-changes.js';
import {AttentionRegistry} from '../apps/desktop/src/session-attention.js';
import * as attachmentInput from '../apps/desktop/src/attachment-input.js';
import * as materialReferences from '../apps/desktop/src/material-references.js';
import * as documentReader from '../apps/desktop/src/document-reader.js';

const root=path.resolve('.');
const mainSource=fs.readFileSync(path.join(root,'apps/desktop/src/main.ts'),'utf8');
const compiled=transformSync(mainSource,{loader:'ts',format:'cjs',target:'node24',define:{'import.meta.url':JSON.stringify(`file://${root}/apps/desktop/dist/main.mjs`)}}).code;

/** Electron and children are boundaries only; production handlers and SQLite run unchanged. */
function fixture(){
  const directory=fs.mkdtempSync(path.join(tmpdir(),'friend-pi-desktop-lifecycle-'));
  const project=path.join(directory,'project'),dataDir=path.join(directory,'data');fs.mkdirSync(project);fs.mkdirSync(dataDir);
  const timers=new Map<number,{at:number;callback:()=>void}>(),children:any[]=[],signals:{pid:number;signal:string}[]=[],unlinkFailures=new Set<string>();let now=0,nextTimer=0;const control={psFailures:0,terminalFailures:0,born:'fixture',terminalGate:undefined as (()=>Promise<void>)|undefined,permissionGate:undefined as Promise<boolean>|undefined,terminalRequests:[] as string[]};let quitCalls=0;
  const app:any=new EventEmitter();app.isPackaged=true;app.getAppPath=()=>root;app.getPath=()=>dataDir;app.setName=()=>{};app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>new Promise(()=>{});app.quit=()=>{quitCalls++;};
  const fork=(_file:string,_args:unknown,options:unknown)=>{
    const child:any=new EventEmitter();child.pid=40000+children.length;child.connected=true;child.stderr=new EventEmitter();child.commands=[];child.options=options;
    child.send=(message:any,callback?:(error?:Error)=>void)=>{child.commands.push(message);callback?.();if(message.method==='permission.confirm'&&control.permissionGate)void control.permissionGate.then(result=>child.emit('message',{type:'response',id:message.id,result}));else queueMicrotask(()=>child.emit('message',{type:'response',id:message.id,result:message.method==='state'||message.method==='configure'?child.state:message.method==='permission.confirm'?true:message.method==='send'?{accepted:true}:message.method==='plugin'?{observed:true}:{ok:true}}));return true;};
    child.kill=(signal:string)=>{signals.push({pid:child.pid,signal});return true;};children.push(child);return child;
  };
  const model={id:'unit',provider:'main-fixture',name:'Main fixture',api:'openai-completions',baseUrl:'http://127.0.0.1',reasoning:false,input:['text'],contextWindow:4096,maxTokens:32,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const modelRuntime={refresh:async()=>{},getModel:(provider:string,id:string)=>provider===model.provider&&id===model.id?model:undefined,getModels:()=>[model],getProviders:()=>[{id:model.provider,name:'Fixture'}],hasConfiguredAuth:()=>true,getAuth:async()=>({auth:{apiKey:'private-fixture'}}),complete:async()=>({stopReason:'stop',content:[{type:'text',text:'OK'}]})};
  const context:any={console,Buffer,Promise,Map,Set,Date,Error,JSON,Number,String,Boolean,Array,URL,queueMicrotask,
    setTimeout:(callback:()=>void,delay:number)=>{const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},clearTimeout:(id:number)=>timers.delete(id),
    process:{argv:['node','main.mjs'],execPath:'/fixture/Friend-Pi',env:{FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_NODE:'/fixture/node'},platform:'darwin',resourcesPath:'/fixture/resources',kill:(pid:number,signal:string)=>{signals.push({pid,signal});return true;}},
    require(specifier:string){
      if(specifier==='electron')return {app,BrowserWindow:class{},ipcMain:{handle(){}},dialog:{showOpenDialog:async()=>({canceled:true})},Menu:{},shell:{openPath:async()=>'',openExternal:async()=>{}}};
      if(specifier==='node:child_process')return {fork,execFile(){}};
      if(specifier==='node:fs')return {...fs,existsSync:(value:string)=>value==='/fixture/node'||fs.existsSync(value),unlinkSync:(value:string)=>{if(unlinkFailures.has(value))throw new Error('fixture EACCES');fs.unlinkSync(value);}};
      if(specifier==='node:path')return path;if(specifier==='node:crypto')return {randomUUID};if(specifier==='node:util')return {promisify:()=>()=>Promise.resolve({stdout:''})};if(specifier==='node:url')return {fileURLToPath};
      if(specifier==='@friend-pi/core')return {RecordStore,object,text,digest,projectIdentity,isSessionDeleted,parsePermissionMode};
      if(specifier==='./session-view.js')return sessionView;
      if(specifier==='./browser-host.js')return {BrowserHost:class{destroy(){}removeSession(){}}};
      if(specifier==='./workspace-files.js')return workspace;
      if(specifier==='./run-changes.js')return runChanges;
      if(specifier==='./session-attention.js')return {AttentionRegistry:class extends AttentionRegistry {constructor(){super({now:()=>now});}}};
      if(specifier==='./attachment-input.js')return attachmentInput;
      if(specifier==='./material-references.js')return materialReferences;
      if(specifier==='./document-reader.js')return documentReader;
      if(specifier==='./workspaces.js')return workspaceRefs;
      if(specifier==='./file-editor.js')return fileEditor;
      if(specifier==='./html-preview.js')return htmlPreview;
      if(specifier==='./terminal-broker.js')return {TerminalBroker:class{async hasRunning(){return false;}async stopAgentServices(){}async shutdown(){if(control.terminalGate)await control.terminalGate();if(control.terminalFailures-->0)throw Error('fixture terminal cleanup failed');}async request(method:string,_input:unknown,_context:unknown,validate?:()=>void){if(control.terminalGate)await control.terminalGate();validate?.();control.terminalRequests.push(method);return {terminals:[]};}}};
      if(specifier==='./terminal-processes.js')return {processSnapshot:()=>{if(control.psFailures-->0)throw Error('fixture ps failed');return new Map(children.map(child=>[child.pid,{pid:child.pid,ppid:1,pgid:child.pid,tty:'??',born:control.born,state:'S'}]));},ownedDescendants:()=>{},terminateOwned:async(owned:Iterable<any>)=>{for(const identity of owned)signals.push({pid:identity.pid,signal:'SIGKILL'});return true;}};
      if(specifier==='./model-readiness.js')return modelReadiness;
      if(specifier==='./provider-settings.js')return {createProviderRuntime:async()=>modelRuntime,providerMetadata:()=>({models:[],providers:[]}),saveProviderConfiguration:async()=>{}};
      throw new Error(`Unrecognized production dependency: ${specifier}`);
    },
  };
  context.globalThis=context;
  vm.runInNewContext(compiled+'\nglobalThis.audit={setBrowserHost:value=>{browserHost=value;},startWorker,workers,store,handle,finishDeletion,retireWorker,terminateWorker,captureOwned,ownedChildren,liveWorkers,isClosed:()=>storeClosed,stopAudit:()=>{shuttingDown=true;storeClosed=true;}};',context);
  const api=context.audit;assert.equal(typeof api.handle,'function');assert.equal(typeof api.finishDeletion,'function');
  api.store.put('preferences',{defaultWorkspaceDir:path.join(dataDir,'workspaces')});
  api.store.put('project:fixture',{id:'fixture',path:project,name:'Fixture'});
  function history(content:string){const manager=SessionManager.create(project,path.join(dataDir,'sessions'));manager.appendMessage({role:'user',content,timestamp:Date.now()});return {id:manager.getSessionId(),file:manager.getSessionFile()!};}
  function record(id:string,native=history('owned source fixture')){const value={id,projectId:'fixture',name:id,path:native.file,piSessionId:native.id,updatedAt:'2026-01-01T00:00:00Z',archived:false,status:'idle'};api.store.put(`session:${id}`,value);return value;}
  async function ready(value:ReturnType<typeof record>){const starting=api.startWorker(value),child=children.at(-1);child.state={isRunning:false,lifecycleStatus:'idle',sessionId:value.piSessionId,sessionFile:value.path,plugins:['swarm'],thinkingLevels:['off']};child.emit('message',{type:'ready',state:child.state,models:[],providers:[]});await starting;return child;}
  async function flush(){for(let i=0;i<100;i++)await Promise.resolve();}
  async function tick(duration:number){const end=now+duration;await flush();while(true){const row=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!row)break;now=row[1].at;timers.delete(row[0]);row[1].callback();await flush();}now=end;await flush();}
  function cleanup(){for(const worker of api.workers.values())api.retireWorker(worker,new Error('audit fixture closed'));const closed=api.isClosed();api.stopAudit();timers.clear();if(!closed)api.store.close();fs.rmSync(directory,{recursive:true,force:true});}
  return {directory,project,dataDir,modelRuntime,api,children,signals,unlinkFailures,record,history,ready,flush,tick,cleanup,control,app,get quitCalls(){return quitCalls;}};
}

function ownedGraph(f:ReturnType<typeof fixture>,record:ReturnType<ReturnType<typeof fixture>['record']>){
  const member=f.history('member original fixture'),review=f.history('review original fixture');
  const registry=new RecordStore('sessions',f.dataDir);for(const native of [{id:record.piSessionId,file:record.path},member,review])registry.put(native.id,{path:native.file,projectDir:f.project});registry.close();
  const store=new RecordStore('swarm',f.dataDir);store.put('graph:fixture:owned',{id:'owned',projectId:'fixture',sessionId:record.piSessionId,projectDir:f.project,status:'integrated',attempts:[{sessionId:member.id,sessionFile:member.file}],integration:{review:{sessionId:review.id,sessionFile:review.file}},tasks:[]});
  store.put('message:owned:message',{id:'message',graphId:'owned',body:'owned message'});store.put('shared:owned:material',{graphId:'owned',name:'material',content:'owned material'});store.put('shared-conflict:owned:conflict',{graphId:'owned',status:'pending'});store.put('message:other:retained',{graphId:'other',body:'unrelated message'});store.close();return {member,review};
}
function assertDeleted(f:ReturnType<typeof fixture>,record:ReturnType<ReturnType<typeof fixture>['record']>,owned:ReturnType<typeof ownedGraph>){
  const registry=new RecordStore('sessions',f.dataDir),swarm=new RecordStore('swarm',f.dataDir);
  try{for(const native of [{id:record.piSessionId,file:record.path},owned.member,owned.review]){assert.ok(registry.get(`tombstone:${native.id}`));assert.equal(registry.get(native.id),undefined);assert.equal(fs.existsSync(native.file),false);}
    for(const key of ['graph:fixture:owned','message:owned:message','shared:owned:material','shared-conflict:owned:conflict'])assert.equal(swarm.get(key),undefined,key);
    assert.ok(swarm.get('message:other:retained'));assert.equal(f.api.store.get(`session:${record.id}`),undefined);
  }finally{registry.close();swarm.close();}
}

test('registered missing original history rejects before forking and preserves its index',async()=>{
  const f=fixture();try{const value={...f.record('missing'),path:path.join(f.dataDir,'missing.jsonl')};f.api.store.put('session:missing',value);await assert.rejects(f.api.handle('session.open',{id:'missing'}),/原始会话历史缺失/);assert.equal(f.children.length,0);assert.equal(f.api.store.get('session:missing').value.path,value.path);}finally{f.cleanup();}
});
test('recorded comparison read is session-owned, starts no SDK, and is removed with its session',async()=>{
 const f=fixture();try{
  const record=f.record('comparison'),summaries:runChanges.RunChangesSummary[]=[];
  const tracker=new runChanges.RunChangesTracker(f.project,'fixture',f.dataDir,record.piSessionId,value=>summaries.push(value));
  fs.writeFileSync(path.join(f.project,'changed.txt'),'before\n');await tracker.begin('run');await tracker.captureTool('write',{path:'changed.txt'});fs.writeFileSync(path.join(f.project,'changed.txt'),'after\n');await tracker.settle('run','completed');
  const query={sessionId:record.id,runId:'run',changeId:summaries[0].changeId,index:0};fs.rmSync(path.join(f.project,'changed.txt'));
  const comparison=await f.api.handle('session.changes.read',query);assert.match(comparison.file.patch,/-before/);assert.match(comparison.file.patch,/\+after/);assert.equal(f.children.length,0);
  assert.ok((await f.api.handle('session.changes.read',{...query,sessionId:f.record('other').id})).unavailable);
  f.api.store.put('deleting:'+record.id,{state:'preparing'});await assert.rejects(f.api.handle('session.changes.read',query),/不可用/);f.api.store.remove('deleting:'+record.id);
  const preview=await f.api.handle('session.delete.preview',{id:record.id});await f.api.handle('session.delete',{id:record.id,token:preview.token});await assert.rejects(f.api.handle('session.changes.read',query),/不可用/);
  const store=new RecordStore('diff',f.dataDir);try{assert.equal(store.get(`snapshot:${record.piSessionId}:${summaries[0].changeId}`),undefined);assert.equal(store.get(`captures:${record.piSessionId}:run`),undefined);}finally{store.close();}
  assert.equal(f.children.length,0);
 }finally{f.cleanup();}
});
test('permission configuration persists immediately and pending project uses its effective defaults',async()=>{const f=fixture();try{f.api.store.put('preferences',{defaultPermissionMode:'auto'});f.api.store.put('preferences:fixture',{defaultPermissionMode:'ask'});const pending=await f.api.handle('project.select',{projectId:'fixture'});assert.equal(pending.preferences.defaultPermissionMode,'ask');const record=f.record('permission-cold'),child=await f.ready(record);child.state.permissionMode='ask';child.state.executionMode='team';await f.api.handle('session.configure',{sessionId:record.id,permissionMode:'ask'});const saved=f.api.store.get('session:'+record.id).value;assert.equal(saved.permissionMode,'ask');assert.equal(saved.executionMode,'team');f.api.retireWorker(f.api.workers.get(record.id),Error('cold fixture'));const reopened=await f.ready(saved);assert.equal(reopened.options.env.FRIEND_PI_PERMISSION_MODE,'ask');assert.equal(reopened.options.env.FRIEND_PI_MODE,'team');}finally{f.cleanup();}});
test('a delayed terminal approval after stop cannot reach terminal admission',async()=>{const f=fixture();try{const record=f.record('late-terminal'),child=await f.ready(record);let approve!:(value:boolean)=>void;f.control.permissionGate=new Promise(done=>approve=done);child.emit('message',{type:'terminal.request',id:'late-create',method:'create',input:{command:'fixture service'}});await f.flush();assert.ok(child.commands.some((command:any)=>command.method==='permission.confirm'));await f.api.handle('session.stop',{sessionId:record.id});approve(true);await f.flush();assert.equal(f.control.terminalRequests.includes('create'),false);const response=child.commands.find((command:any)=>command.type==='terminal.response'&&command.id==='late-create');assert.match(response.error,/取消/);}finally{f.cleanup();}});
test('SDK-internal cancellation and terminal host initialization both invalidate delayed admission',async()=>{for(const during of ['approval','host'] as const){const f=fixture();try{const record=f.record('terminal-epoch-'+during),child=await f.ready(record);let release!:()=>void;const gate=new Promise<void>(done=>release=done);if(during==='approval')f.control.permissionGate=gate.then(()=>true);else f.control.terminalGate=()=>gate;child.state.permissionEpoch=1;child.emit('message',{type:'terminal.request',id:'cancelled',method:'create',input:{command:'fixture service'}});await f.flush();child.state={...child.state,permissionEpoch:2,lifecycleStatus:'stopped'};child.emit('message',{type:'event',event:{type:'state',data:child.state}});release();await f.flush();assert.equal(f.control.terminalRequests.includes('create'),false);assert.match(child.commands.find((command:any)=>command.type==='terminal.response'&&command.id==='cancelled').error,/取消/);}finally{f.cleanup();}}});

test('production blank-session bootstrap writes a real Pi header and custom chain before restart',()=>{
  const f=fixture();try{
    const source=fs.readFileSync(path.join(root,'apps/desktop/src/sdk-worker.ts'),'utf8'),start=source.indexOf('  const priorFile='),end=source.indexOf('  plans=new PlanStore',start);
    assert.ok(start>=0&&end>start,'production initialization boundary must be identifiable');
    const boot=source.slice(start,end);assert.match(boot,/manager\.setSessionFile/,'test must execute the production public persistence path');
    const context:any={process:{env:{FRIEND_PI_DESKTOP_SESSION_ID:'desktop-fixture'}},cwd:f.project,dataDir:f.dataDir,MessageQueue,ownedEntries,SessionManager,existsSync:fs.existsSync,readFileSync:fs.readFileSync,openSync:fs.openSync,closeSync:fs.closeSync,join:path.join,isSessionDeleted};
    vm.runInNewContext(transformSync(boot+'\nglobalThis.result=manager;',{loader:'ts',format:'cjs',target:'node24'}).code,context);const manager=context.result as SessionManager,file=manager.getSessionFile()!;
    assert.ok(fs.existsSync(file));assert.equal(manager.isPersisted(),true);const originalId=manager.getSessionId();
    manager.appendMessage({role:'user',content:'first genuine user input',timestamp:Date.now()});const loaded=SessionManager.open(file);
    assert.equal(loaded.getSessionId(),originalId);const entries=loaded.getBranch();assert.ok(entries.some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.session.created'));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='user'));
    for(let i=1;i<entries.length;i++)assert.equal(entries[i]!.parentId,entries[i-1]!.id,'initial custom entry and later native append stay on the same canonical chain');context.inputQueue.dispose();
  }finally{f.cleanup();}
});

test('archive survives late worker state and rejects send, planning and execution until restored',async()=>{
  const f=fixture();try{const record=f.record('archive'),child=await f.ready(record);await f.api.handle('session.archive',{id:record.id,archived:true});assert.equal(f.api.store.get('session:archive').value.archived,true);
    child.emit('message',{type:'event',event:{type:'state',data:child.state}});await f.flush();assert.equal(f.api.store.get('session:archive').value.archived,true);
    await assert.rejects(f.api.handle('session.send',{sessionId:record.id,text:'must not dispatch'}),/归档/);await assert.rejects(f.api.handle('plugin.call',{sessionId:record.id,plugin:'swarm',action:'start',input:{graphId:'owned'}}),/归档/);await assert.rejects(f.api.handle('plan.approve',{sessionId:record.id}),/归档/);await assert.rejects(f.api.handle('session.configure',{sessionId:record.id,modelId:'fixture/model'}),/归档/);
    assert.equal(child.commands.some((message:any)=>['send','plugin','plan.approve','configure'].includes(message.method)),false);
    await f.api.handle('session.archive',{id:record.id,archived:false});assert.equal(f.api.store.get('session:archive').value.archived,false);assert.equal(f.api.workers.get(record.id).record.archived,false);
  }finally{f.cleanup();}
});

test('running and stopping workers cannot be archived or previewed for deletion',async()=>{
  const f=fixture();try{const record=f.record('busy'),child=await f.ready(record);for(const state of [{isRunning:true,lifecycleStatus:'running'},{isRunning:false,lifecycleStatus:'stopping'}]){f.api.workers.get(record.id).state={...child.state,...state};await assert.rejects(f.api.handle('session.archive',{id:record.id,archived:true}),/先停止/);await assert.rejects(f.api.handle('session.delete.preview',{id:record.id}),/先停止/);}assert.equal(f.api.store.get('session:busy').value.archived,false);}finally{f.cleanup();}
});

test('deletion clears owned parent/member/review sources and graph records, fences late callbacks and retries idempotently',async()=>{
  const f=fixture();try{const record=f.record('delete'),owned=ownedGraph(f,record),child=await f.ready(record);fs.writeFileSync(path.join(f.project,'retained-code.txt'),'user code must remain');const preview=await f.api.handle('session.delete.preview',{id:record.id});const pending=f.api.handle('session.delete',{id:record.id,token:preview.token});let finished=false;void pending.then(()=>{finished=true;});for(let i=0;i<10&&!finished;i++)await f.tick(1000);assert.equal(finished,true,'owned process shutdown must reach its terminal boundary');assert.equal((await pending).deleted,true);assertDeleted(f,record,owned);assert.ok(fs.existsSync(path.join(f.project,'retained-code.txt')));
    child.emit('message',{type:'event',event:{type:'state',data:{...child.state,lifecycleStatus:'completed'}}});await f.flush();assert.equal(f.api.store.get('session:delete'),undefined);
    const replay=await f.api.handle('session.delete',{id:record.id,token:preview.token});assert.equal(replay.deleted,true);assertDeleted(f,record,owned);await assert.rejects(f.api.handle('session.delete',{id:record.id,token:'wrong'}),/确认.*失效/);
  }finally{f.cleanup();}
});

test('interrupted deletion preserves its fixed inventory and preparing cleanup resumes without replaying work',async()=>{
  const f=fixture();try{const record=f.record('interrupted-delete'),owned=ownedGraph(f,record);f.unlinkFailures.add(record.path);const preview=await f.api.handle('session.delete.preview',{id:record.id});await assert.rejects(f.api.handle('session.delete',{id:record.id,token:preview.token}),/EACCES/);const saved=f.api.store.get('deleting:interrupted-delete').value;assert.equal(saved.state,'preparing');assert.ok(saved.nativeIds.includes(owned.member.id));assert.ok(saved.nativeIds.includes(owned.review.id));assert.ok(saved.files.includes(record.path));assert.equal(f.children.length,0);
    f.unlinkFailures.clear();assert.match(mainSource,/mark\.state==='preparing'\|\|mark\.memoryPending/,'startup must consume durable pending deletion records');const completed=await f.api.finishDeletion(saved);assert.equal(completed.deleted,true);assertDeleted(f,record,owned);assert.equal(f.children.length,0,'recovery cleans records instead of dispatching a model or user tool');
  }finally{f.cleanup();}
});

async function temporary(f:ReturnType<typeof fixture>){
 const pending=f.api.handle('session.new',{});await f.flush();const child=f.children.at(-1),record=f.api.store.list('session:').map((row:any)=>row.value).find((record:any)=>!f.api.workers.get(record.id)?.state.sessionFile);
 assert.ok(record);const cwd=record.workspaceDir,manager=SessionManager.create(cwd,path.join(f.dataDir,'sessions'));manager.appendMessage({role:'user',content:'temporary-native-history',timestamp:Date.now()});
 child.state={isRunning:false,lifecycleStatus:'idle',sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),plugins:['swarm'],thinkingLevels:['off']};child.emit('message',{type:'ready',state:child.state,models:[],providers:[]});await pending;return {record:f.api.store.get('session:'+record.id).value,child,manager};
}
test('temporary workspaces are isolated, recoverable and compatible with file APIs',async()=>{
 const f=fixture();try{const a=await temporary(f),b=await temporary(f);assert.notEqual(a.record.workspaceDir,b.record.workspaceDir);assert.equal(a.record.projectId,'');assert.deepEqual(JSON.parse(JSON.stringify(a.record.workspace)),{kind:'temporary',sessionId:a.record.id});assert.equal(a.child.options.cwd,a.record.workspaceDir);assert.equal(a.child.options.env.FRIEND_PI_PROJECT,a.record.workspaceDir);
 fs.writeFileSync(path.join(a.record.workspaceDir,'中文.md'),'临时正文');assert.equal((await f.api.handle('file.read',{workspace:a.record.workspace,path:'中文.md',edit:true})).content,'临时正文');assert.equal(f.api.store.list('project:').length,1);assert.equal((await f.api.handle('file.read',{projectId:'fixture',path:(fs.writeFileSync(path.join(f.project,'legacy.txt'),'old'),'legacy.txt')})).content,'old');
 const cold=new RecordStore('desktop',f.dataDir);try{assert.equal(cold.get<{workspaceDir:string}>('session:'+a.record.id)!.value.workspaceDir,a.record.workspaceDir);}finally{cold.close();}
 }finally{f.cleanup();}
});
test('temporary sessions cannot be promoted and changing the default directory preserves old sessions',async()=>{
 const f=fixture();try{const a=await temporary(f),saved={...a.record};await assert.rejects(f.api.handle('session.promote',{id:a.record.id,name:'登记项目'}));assert.equal(f.api.store.list('project:').length,1);assert.equal(f.api.store.get('session:'+a.record.id).value.workspace.kind,'temporary');
 const newRoot=path.join(f.dataDir,'new-location');await f.api.handle('settings.update',{defaultWorkspaceDir:newRoot});const b=await temporary(f);assert.equal(path.dirname(b.record.workspaceDir),fs.realpathSync(newRoot));assert.equal(a.child.options.env.FRIEND_PI_TEMPORARY_WRITE_ROOT,saved.workspaceDir);assert.equal(b.child.options.env.FRIEND_PI_TEMPORARY_WRITE_ROOT,b.record.workspaceDir);assert.equal(f.api.store.get('session:'+a.record.id).value.workspaceDir,saved.workspaceDir);assert.equal(f.api.store.get('session:'+a.record.id).value.piSessionId,saved.piSessionId);
 const tree=await f.api.handle('file.tree',{workspace:b.record.workspace});assert.ok(tree);await assert.rejects(f.api.handle('settings.update',{defaultWorkspaceDir:'relative'}),/绝对/);
 }finally{f.cleanup();}
});
test('project order persists exact permutations without altering active execution target',async()=>{
 const f=fixture();try{for(const id of ['second','third'])f.api.store.put('project:'+id,{id,path:f.project,name:id});const record=f.record('active'),child=await f.ready(record);await f.api.handle('session.open',{id:record.id});f.api.workers.get(record.id).state.isRunning=true;
 const sorted=await f.api.handle('project.reorder',{ids:['third','fixture','second']});assert.deepEqual(Array.from(sorted.projects,(p:any)=>p.id),['third','fixture','second']);assert.equal(sorted.current.sessionId,record.id);assert.equal(f.api.workers.get(record.id).child,child);
 for(const ids of [['fixture'],['third','third','fixture'],['third','foreign','fixture']])await assert.rejects(f.api.handle('project.reorder',{ids}));assert.deepEqual(Array.from(f.api.store.get('project-order').value),['third','fixture','second']);
 f.api.store.put('project:new',{id:'new',path:f.project,name:'New'});assert.deepEqual(Array.from((await f.api.handle('app.state',{})).projects,(p:any)=>p.id),['third','fixture','second','new']);
 }finally{f.cleanup();}
});

test('desktop refuses inference before dispatch and first-send workspace allocation unless exact model passed a test',async()=>{
 const f=fixture();try{fs.mkdirSync(path.join(f.dataDir,'pi'),{recursive:true});modelReadiness.registerSavedModel(f.dataDir,'main-fixture/unit');const record=f.record('model-guard'),child=await f.ready(record);child.state.modelId='main-fixture/unit';const before=child.commands.length;await assert.rejects(f.api.handle('session.send',{sessionId:record.id,text:'must not run',ready:true}),/连接测试/);await assert.rejects(f.api.handle('plan.approve',{sessionId:record.id,ready:true}),/连接测试/);assert.equal(child.commands.slice(before).some((command:any)=>['send','plan.approve'].includes(command.method)),false);const count=f.api.store.list('session:').length;await assert.rejects(f.api.handle('session.new',{forSend:true,modelId:'main-fixture/unit'}),/连接测试/);assert.equal(f.api.store.list('session:').length,count);assert.equal(fs.existsSync(path.join(f.dataDir,'workspaces')),false);await modelReadiness.testConfiguredModel(f.modelRuntime as never,f.dataDir,'main-fixture/unit');await f.api.handle('session.send',{sessionId:record.id,text:'now accepted'});assert.ok(child.commands.some((command:any)=>command.method==='send'));}finally{f.cleanup();}
});

test('a failed ownership scan clears its termination cache and permits verified retry',async()=>{const f=fixture();try{const record=f.record('retry-scan');await f.ready(record);const worker=f.api.workers.get(record.id);f.control.psFailures=1;await assert.rejects(f.api.terminateWorker(worker),/fixture ps failed/);assert.equal(worker.termination,undefined);assert.equal(f.api.liveWorkers.has(worker),true);await f.api.terminateWorker(worker);assert.equal(f.api.liveWorkers.has(worker),false);}finally{f.cleanup();}});
test('only trusted new ownership may replace a reused PID birth identity',async()=>{const f=fixture();try{const record=f.record('birth');const child=await f.ready(record),worker=f.api.workers.get(record.id);f.control.born='new birth';f.api.captureOwned(worker);assert.equal(f.api.ownedChildren.get(worker).get(child.pid).born,'fixture');f.api.captureOwned(worker,child.pid);assert.equal(f.api.ownedChildren.get(worker).get(child.pid).born,'new birth');}finally{f.cleanup();}});
test('unavailable ownership inspection fails before creating an SDK child',async()=>{const f=fixture();try{f.control.psFailures=1;await assert.rejects(f.api.startWorker(f.record('before-fork')),/fixture ps failed/);assert.equal(f.children.length,0);}finally{f.cleanup();}});
test('terminal cleanup failure keeps the application and permits a later verified quit',async()=>{const f=fixture();try{f.control.terminalFailures=1;const event={preventDefault(){}};f.app.emit('before-quit',event);await f.flush();assert.equal(f.quitCalls,0);assert.equal(f.api.isClosed(),false);f.app.emit('before-quit',event);await f.flush();assert.equal(f.quitCalls,1);assert.equal(f.api.isClosed(),true);}finally{f.cleanup();}});

test('a late ownership handshake cannot initialize SDK while quit waits for terminal cleanup',async()=>{const f=fixture();try{let release!:()=>void;f.control.terminalGate=()=>new Promise<void>(yes=>{release=yes;});const starting=f.api.startWorker(f.record('late-handshake')),stopped=assert.rejects(starting,/启动授权已失效/);const child=f.children[0];f.app.emit('before-quit',{preventDefault(){}});await f.flush();child.emit('message',{type:'supervisor.await'});await stopped;assert.equal(child.commands.some((message:any)=>message.type==='supervisor.ready'),false);release();await f.flush();assert.equal(f.quitCalls,1);}finally{f.cleanup();}});

test('temporary Agent terminal approval carries the explicit boundary under all permissions',async()=>{
 const f=fixture();try{const a=await temporary(f);const worker=f.api.workers.get(a.record.id);worker.state.permissionMode='allPermissions';worker.state.permissionEpoch=0;f.control.permissionGate=Promise.resolve(false);a.child.emit('message',{type:'terminal.request',id:'temporary-create',method:'create',input:{command:'node server.js'}});await f.flush();await f.flush();const approval=a.child.commands.find((m:any)=>m.method==='permission.confirm');assert.equal(approval.input.requireExplicit,true);assert.equal(f.control.terminalRequests.length,0);assert.ok(a.child.commands.some((m:any)=>m.type==='terminal.response'&&m.error?.includes('未批准')));
 }finally{f.cleanup();}
});

test('new temporary allocation rejects a pre-existing symlink and restored scopes reject directory drift',async()=>{
 const f=fixture();try{const parent=path.join(f.dataDir,'allocation');fs.mkdirSync(parent);fs.symlinkSync(f.project,path.join(parent,'existing'));assert.throws(()=>workspaceRefs.temporaryWorkspace(parent,'existing'),/已存在/);assert.equal(fs.readdirSync(f.project).length,0);const ordinaryFile=path.join(f.dataDir,'ordinary-file');fs.writeFileSync(ordinaryFile,'x');assert.throws(()=>workspaceRefs.temporaryDirectory(path.join(f.dataDir,'missing','..','ordinary-file')),/不是文件夹/);const a=await temporary(f),saved=a.record.workspaceDir;fs.renameSync(saved,saved+'-old');fs.symlinkSync(f.project,saved);await assert.rejects(f.api.handle('file.tree',{workspace:a.record.workspace}),/目录已变化/);assert.throws(()=>workspaceRefs.sessionWorkspace(f.api.store,a.record),/目录已变化/);
 }finally{f.cleanup();}
});

test('temporary terminal startup rechecks the directory after a delayed host becomes ready',async()=>{
 const f=fixture();try{const a=await temporary(f);let release!:()=>void;const gate=new Promise<void>(done=>release=done);f.control.terminalGate=()=>gate;a.child.state.permissionEpoch=1;a.child.emit('message',{type:'terminal.request',id:'root-drift',method:'create',input:{command:'fixture service'}});await f.flush();fs.renameSync(a.record.workspaceDir,a.record.workspaceDir+'-old');fs.symlinkSync(f.project,a.record.workspaceDir);release();await f.flush();await f.flush();assert.equal(f.control.terminalRequests.includes('create'),false);assert.match(a.child.commands.find((m:any)=>m.type==='terminal.response'&&m.id==='root-drift').error,/目录已变化/);
 }finally{f.cleanup();}
});
test('session view state stays separate from Pi history and layout is always fullscreen',async()=>{
 const f=fixture();try{
  const a=f.record('ui-a'),b=f.record('ui-b'),before=fs.readFileSync(a.path,'utf8');
  const current=await f.api.handle('session.ui.get',{sessionId:a.id});assert.equal(current.mode,'fullscreen');
  const next={...current,browserScope:'session',tabs:[{id:'diff-ui',kind:'tool',page:'diff'}],active:'diff-ui'};
  await f.api.handle('session.ui.update',{sessionId:a.id,ui:next});assert.equal((await f.api.handle('session.ui.get',{sessionId:b.id})).mode,'fullscreen');
  assert.equal(fs.readFileSync(a.path,'utf8'),before);assert.equal(f.api.store.get('session-ui:'+a.id).value.browserScope,'session');
  await f.api.handle('settings.update',{defaultLayoutMode:'standard',defaultBrowserScope:'project'});
  assert.equal((await f.api.handle('settings.get',{})).preferences.defaultLayoutMode,'fullscreen');assert.equal((await f.api.handle('session.ui.get',{sessionId:a.id})).browserScope,'session');
  await assert.rejects(f.api.handle('session.ui.update',{sessionId:a.id,ui:{...next,tabs:[{id:'web-ui',kind:'browser',url:'https://example.com'}],active:'missing'}}),/不存在/);
 }finally{f.cleanup();}
});
test('opening old UI records migrates panels and global/project layout preferences idempotently',async()=>{
 const f=fixture();try{
  const a=f.record('legacy-ui'),before=fs.readFileSync(a.path,'utf8');
  f.api.store.put('preferences',{defaultLayoutMode:'standard'});f.api.store.put('preferences:'+a.projectId,{defaultLayoutMode:'standard',defaultBrowserScope:'project'});
  const old={version:1,mode:'standard',browserScope:'session',sidebar:false,composerCollapsed:true,tabs:[{id:'web-old',kind:'browser',url:'https://example.com/form'}],active:'web-old',normalPage:'browser',normalTerminal:true};
  f.api.store.put('session-ui:'+a.id,old);
  const ui=await f.api.handle('session.ui.get',{sessionId:a.id});assert.equal(ui.mode,'fullscreen');assert.equal(ui.active,'web-old');assert.equal(ui.tabs.length,2);assert.equal(ui.sidebar,false);assert.equal(ui.composerCollapsed,true);assert.equal(ui.browserScope,'session');
  assert.equal(JSON.stringify(f.api.store.get('session-ui:'+a.id).value),JSON.stringify(ui));assert.equal(JSON.stringify(await f.api.handle('session.ui.get',{sessionId:a.id})),JSON.stringify(ui));
  const settings=await f.api.handle('settings.get',{projectId:a.projectId});assert.equal(settings.preferences.defaultLayoutMode,'fullscreen');assert.equal(settings.globalPreferences.defaultLayoutMode,'fullscreen');
  await f.api.handle('session.ui.update',{sessionId:a.id,base:old,ui:{...old,sidebar:true}});assert.equal((await f.api.handle('session.ui.get',{sessionId:a.id})).mode,'fullscreen');assert.equal(fs.readFileSync(a.path,'utf8'),before);
 }finally{f.cleanup();}
});


test('failed host cleanup retains the browser controller; successful retry destroys it once',async()=>{
 const f=fixture();try{
  let hidden=0,destroyed=0;f.api.setBrowserHost({hide(){hidden++;},destroy(){destroyed++;}});
  f.control.terminalFailures=1;f.app.emit('before-quit',{preventDefault(){}});await f.flush();
  assert.equal(f.quitCalls,0);assert.equal(hidden,1);assert.equal(destroyed,0);
  f.app.emit('before-quit',{preventDefault(){}});await f.flush();
  assert.equal(f.quitCalls,1);assert.equal(hidden,2);assert.equal(destroyed,1);
 }finally{f.cleanup();}
});


test('cancelled SDK terminal admission cannot start after a late permission answer',async()=>{
 const f=fixture();try{const a=await temporary(f);let allow!:(value:boolean)=>void;f.control.permissionGate=new Promise(done=>allow=done);
  a.child.emit('message',{type:'terminal.request',id:'expired-terminal',method:'create',input:{command:'fixture service'}});await f.flush();
  assert.ok(a.child.commands.some((m:any)=>m.type==='terminal.waiting'&&m.id==='expired-terminal'));
  a.child.emit('message',{type:'terminal.cancel',id:'expired-terminal'});allow(true);await f.flush();await f.flush();
  assert.equal(f.control.terminalRequests.length,0);assert.ok(a.child.commands.some((m:any)=>m.type==='terminal.response'&&m.id==='expired-terminal'&&m.error?.includes('失效')));
 }finally{f.cleanup();}
});


test('cancelled terminal admission stays cancelled through delayed broker startup',async()=>{
 const f=fixture();try{const a=await temporary(f);let ready!:()=>void;const gate=new Promise<void>(done=>ready=done);f.control.terminalGate=()=>gate;
  a.child.emit('message',{type:'terminal.request',id:'cancel-host',method:'create',input:{command:'fixture service'}});await f.flush();
  a.child.emit('message',{type:'terminal.cancel',id:'cancel-host'});ready();await f.flush();await f.flush();
  assert.equal(f.control.terminalRequests.length,0);assert.equal(a.child.commands.some((m:any)=>m.type==='terminal.admitted'&&m.id==='cancel-host'),false);
 }finally{f.cleanup();}
});

test('side chat transfer reconciles a persisted draft after its response is lost without sending the source',async()=>{
 const f=fixture();try{
  const parent=f.record('side-parent'),source=await f.ready(parent),native=f.history('stable source context');let sourceItem:any={id:'queued',revision:1,text:'side draft',attachments:[],mode:'single',planMode:false,state:'queued',leafId:'stable'};let savedDraft:any,lost=true;
  await f.api.handle('session.open',{id:parent.id});
  source.send=(message:any,callback?:Function)=>{source.commands.push(message);callback?.();let result:any;
   if(message.method==='queue'){const input=message.input;if(input.action==='move.prepare'){sourceItem={...sourceItem,state:'moving',targetId:input.targetId};result=sourceItem;}else if(input.action==='move.inspect'){if(!sourceItem)throw Error('source item no longer exists');result=sourceItem;}else if(input.action==='move.failed'){sourceItem.state='unknown';result={};}else if(input.action==='move.commit'){sourceItem=null;result={};}else throw Error('unexpected source queue action');}
   else if(message.method==='sidechat.fork')result={path:native.file,piSessionId:native.id};else if(message.method==='state')result=source.state;else result={ok:true};queueMicrotask(()=>source.emit('message',{type:'response',id:message.id,result}));return true;};
  const first=f.api.handle('session.queue',{sessionId:parent.id,action:'sidechat',id:'queued',revision:1});const failed=assert.rejects(first,/lost response/);await f.flush();const child=f.children.at(-1);assert.notEqual(child,source);
  child.send=(message:any,callback?:Function)=>{child.commands.push(message);callback?.();if(message.method==='draft.install'){savedDraft||=message.input.payload;const shouldLose=lost;lost=false;queueMicrotask(()=>child.emit('message',{type:'response',id:message.id,...(shouldLose?{error:'lost response after persistent write'}:{result:child.state})}));}else queueMicrotask(()=>child.emit('message',{type:'response',id:message.id,result:child.state}));return true;};
  child.state={isRunning:false,lifecycleStatus:'idle',sessionId:native.id,sessionFile:native.file,plugins:[],thinkingLevels:['off']};child.emit('message',{type:'ready',state:child.state});await failed;assert.equal(savedDraft.text,'side draft');assert.equal(sourceItem.state,'unknown');assert.equal(source.commands.some((m:any)=>m.method==='send'),false);
  const intent=f.api.store.get('sidechat-transfer:side-parent:queued').value;const recovered=await f.api.handle('session.queue',{sessionId:parent.id,action:'sidechat',id:'queued',revision:1});assert.equal(recovered.sessionId,intent.id);assert.equal(f.children.filter(c=>c!==source).length,1);assert.equal(sourceItem,null);assert.equal((await f.api.handle('app.state',{})).current.sessionId,parent.id);const repeated=await f.api.handle('session.queue',{sessionId:parent.id,action:'sidechat',id:'queued',revision:1});assert.equal(repeated.sessionId,recovered.sessionId);assert.equal(f.children.filter(c=>c!==source).length,1);assert.equal(source.commands.some((m:any)=>m.method==='send'),false);
 }finally{f.cleanup();}
});

test('side transfers recover prepare and fork reply loss in project and temporary workspaces',async()=>{
 for(const temporary of [false,true])for(const lostStage of ['prepare','fork']){
  const f=fixture();const queue=new MessageQueue('transfer-native',f.dataDir);try{
   let parent:any=f.record('transfer-parent');if(temporary){parent={...parent,projectId:undefined,...workspaceRefs.temporaryWorkspace(path.join(f.dataDir,'workspaces'),parent.id)};f.api.store.put('session:'+parent.id,parent);}
   const source=await f.ready(parent),native=f.history('complete inherited context'),item=queue.add({text:'durable draft',attachments:[],mode:'single',planMode:false});let lost=true,forkCalls=0;
   source.send=(message:any,callback?:Function)=>{source.commands.push(message);callback?.();let result:any,error:string|undefined;try{
    if(message.method==='queue'){const input=message.input;if(input.action==='move.prepare'){result=queue.moving(input.id,input.revision,input.targetId,'stable');if(lost&&lostStage==='prepare'){lost=false;error='reply lost after prepare';}}
     else if(input.action==='move.failed'){const row=queue.snapshot().items.find(i=>i.id===input.id);if(row?.targetId===input.targetId)queue.unknown(input.id);result={};}
     else if(input.action==='move.commit'){if(queue.snapshot().items.length)queue.moved(input.id,input.targetId);result={};}else result={};}
    else if(message.method==='sidechat.fork'){forkCalls++;result={path:native.file,piSessionId:native.id};if(lost&&lostStage==='fork'){lost=false;error='reply lost after native fork';}}
    else result=source.state;
   }catch(e){error=String(e);}queueMicrotask(()=>source.emit('message',{type:'response',id:message.id,...(error?{error}:{result})}));return true;};
   await assert.rejects(f.api.handle('session.queue',{sessionId:parent.id,action:'sidechat',id:item.id,revision:1}),/reply lost/);
   const intent=f.api.store.get(`sidechat-transfer:${parent.id}:${item.id}`).value;assert.equal(queue.read(item.id).targetId,intent.id);
   const retry=f.api.handle('session.queue',{sessionId:parent.id,action:'sidechat',id:item.id,revision:1});await f.flush();const child=f.children.at(-1);assert.notEqual(child,source);
   child.state={isRunning:false,lifecycleStatus:'idle',sessionId:native.id,sessionFile:native.file,plugins:[],thinkingLevels:['off']};child.send=(message:any,callback?:Function)=>{child.commands.push(message);callback?.();queueMicrotask(()=>child.emit('message',{type:'response',id:message.id,result:child.state}));return true;};child.emit('message',{type:'ready',state:child.state});
   const result=await retry;assert.equal(result.sessionId,intent.id);assert.equal(queue.snapshot().items.length,0);assert.equal(f.children.length,2);assert.equal(forkCalls,lostStage==='fork'?2:1);
   if(temporary){const directories=fs.readdirSync(path.join(f.dataDir,'workspaces'));assert.deepEqual(directories.sort(),['transfer-parent',intent.id].sort());}
  }finally{queue.dispose();f.cleanup();}
 }
});
