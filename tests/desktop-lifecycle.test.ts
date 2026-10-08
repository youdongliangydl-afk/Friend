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
import {RecordStore,object,text,digest,projectIdentity,isSessionDeleted} from '../packages/core/src/index.js';
import * as workspaceRefs from '../apps/desktop/src/workspaces.js';
import * as fileEditor from '../apps/desktop/src/file-editor.js';
import * as htmlPreview from '../apps/desktop/src/html-preview.js';
import * as workspace from '../apps/desktop/src/workspace-files.js';

const root=path.resolve('.');
const mainSource=fs.readFileSync(path.join(root,'apps/desktop/src/main.ts'),'utf8');
const compiled=transformSync(mainSource,{loader:'ts',format:'cjs',target:'node24',define:{'import.meta.url':JSON.stringify(`file://${root}/apps/desktop/dist/main.mjs`)}}).code;

/** Electron and children are boundaries only; production handlers and SQLite run unchanged. */
function fixture(){
  const directory=fs.mkdtempSync(path.join(tmpdir(),'friend-pi-desktop-lifecycle-'));
  const project=path.join(directory,'project'),dataDir=path.join(directory,'data');fs.mkdirSync(project);fs.mkdirSync(dataDir);
  const timers=new Map<number,{at:number;callback:()=>void}>(),children:any[]=[],signals:{pid:number;signal:string}[]=[],unlinkFailures=new Set<string>();let now=0,nextTimer=0;
  const app:any=new EventEmitter();app.isPackaged=true;app.getAppPath=()=>root;app.getPath=()=>dataDir;app.setName=()=>{};app.setPath=()=>{};app.requestSingleInstanceLock=()=>true;app.whenReady=()=>new Promise(()=>{});app.quit=()=>{};
  const fork=(_file:string,_args:unknown,options:unknown)=>{
    const child:any=new EventEmitter();child.pid=40000+children.length;child.connected=true;child.stderr=new EventEmitter();child.commands=[];child.options=options;
    child.send=(message:any,callback?:(error?:Error)=>void)=>{child.commands.push(message);callback?.();queueMicrotask(()=>child.emit('message',{type:'response',id:message.id,result:message.method==='state'||message.method==='configure'?child.state:message.method==='send'?{accepted:true}:message.method==='plugin'?{observed:true}:{ok:true}}));return true;};
    child.kill=(signal:string)=>{signals.push({pid:child.pid,signal});return true;};children.push(child);return child;
  };
  const context:any={console,Buffer,Promise,Map,Set,Date,Error,JSON,Number,String,Boolean,Array,URL,queueMicrotask,
    setTimeout:(callback:()=>void,delay:number)=>{const id=++nextTimer;timers.set(id,{at:now+delay,callback});return id;},clearTimeout:(id:number)=>timers.delete(id),
    process:{argv:['node','main.mjs'],env:{FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_NODE:'/fixture/node'},platform:'darwin',resourcesPath:'/fixture/resources',kill:(pid:number,signal:string)=>{signals.push({pid,signal});return true;}},
    require(specifier:string){
      if(specifier==='electron')return {app,BrowserWindow:class{},ipcMain:{handle(){}},dialog:{showOpenDialog:async()=>({canceled:true})},Menu:{},shell:{openPath:async()=>'',openExternal:async()=>{}}};
      if(specifier==='node:child_process')return {fork,execFile(){}};
      if(specifier==='node:fs')return {...fs,existsSync:(value:string)=>value==='/fixture/node'||fs.existsSync(value),unlinkSync:(value:string)=>{if(unlinkFailures.has(value))throw new Error('fixture EACCES');fs.unlinkSync(value);}};
      if(specifier==='node:path')return path;if(specifier==='node:crypto')return {randomUUID};if(specifier==='node:util')return {promisify:()=>()=>Promise.resolve({stdout:''})};if(specifier==='node:url')return {fileURLToPath};
      if(specifier==='@friend-pi/core')return {RecordStore,object,text,digest,projectIdentity,isSessionDeleted};
      if(specifier==='./workspace-files.js')return workspace;
      if(specifier==='./workspaces.js')return workspaceRefs;
      if(specifier==='./file-editor.js')return fileEditor;
      if(specifier==='./html-preview.js')return htmlPreview;
      if(specifier==='./terminal-broker.js')return {TerminalBroker:class{async hasRunning(){return false;}async stopAgentServices(){}async shutdown(){}async request(){return {terminals:[]};}}};
      if(specifier==='./provider-settings.js')return {createProviderRuntime:async()=>({refresh:async()=>{}}),providerMetadata:()=>({models:[],providers:[]}),saveProviderConfiguration:async()=>{}};
      throw new Error(`Unrecognized production dependency: ${specifier}`);
    },
  };
  context.globalThis=context;
  vm.runInNewContext(compiled+'\nglobalThis.audit={startWorker,workers,store,handle,finishDeletion,retireWorker,stopAudit:()=>{shuttingDown=true;storeClosed=true;}};',context);
  const api=context.audit;assert.equal(typeof api.handle,'function');assert.equal(typeof api.finishDeletion,'function');
  api.store.put('project:fixture',{id:'fixture',path:project,name:'Fixture'});
  function history(content:string){const manager=SessionManager.create(project,path.join(dataDir,'sessions'));manager.appendMessage({role:'user',content,timestamp:Date.now()});return {id:manager.getSessionId(),file:manager.getSessionFile()!};}
  function record(id:string,native=history('owned source fixture')){const value={id,projectId:'fixture',name:id,path:native.file,piSessionId:native.id,updatedAt:'2026-01-01T00:00:00Z',archived:false,status:'idle'};api.store.put(`session:${id}`,value);return value;}
  async function ready(value:ReturnType<typeof record>){const starting=api.startWorker(value),child=children.at(-1);child.state={isRunning:false,lifecycleStatus:'idle',sessionId:value.piSessionId,sessionFile:value.path,plugins:['swarm'],thinkingLevels:['off']};child.emit('message',{type:'ready',state:child.state,models:[],providers:[]});await starting;return child;}
  async function flush(){for(let i=0;i<100;i++)await Promise.resolve();}
  async function tick(duration:number){const end=now+duration;await flush();while(true){const row=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!row)break;now=row[1].at;timers.delete(row[0]);row[1].callback();await flush();}now=end;await flush();}
  function cleanup(){for(const worker of api.workers.values())api.retireWorker(worker,new Error('audit fixture closed'));api.stopAudit();timers.clear();api.store.close();fs.rmSync(directory,{recursive:true,force:true});}
  return {directory,project,dataDir,api,children,signals,unlinkFailures,record,history,ready,flush,tick,cleanup};
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

test('production blank-session bootstrap writes a real Pi header and custom chain before restart',()=>{
  const f=fixture();try{
    const source=fs.readFileSync(path.join(root,'apps/desktop/src/sdk-worker.ts'),'utf8'),start=source.indexOf('  const priorFile='),end=source.indexOf('  plans=new PlanStore',start);
    assert.ok(start>=0&&end>start,'production initialization boundary must be identifiable');
    const boot=source.slice(start,end);assert.match(boot,/manager\.setSessionFile/,'test must execute the production public persistence path');
    const context:any={process:{env:{FRIEND_PI_DESKTOP_SESSION_ID:'desktop-fixture'}},cwd:f.project,dataDir:f.dataDir,SessionManager,existsSync:fs.existsSync,readFileSync:fs.readFileSync,openSync:fs.openSync,closeSync:fs.closeSync,join:path.join,isSessionDeleted};
    vm.runInNewContext(transformSync(boot+'\nglobalThis.result=manager;',{loader:'ts',format:'cjs',target:'node24'}).code,context);const manager=context.result as SessionManager,file=manager.getSessionFile()!;
    assert.ok(fs.existsSync(file));assert.equal(manager.isPersisted(),true);const originalId=manager.getSessionId();
    manager.appendMessage({role:'user',content:'first genuine user input',timestamp:Date.now()});const loaded=SessionManager.open(file);
    assert.equal(loaded.getSessionId(),originalId);const entries=loaded.getBranch();assert.ok(entries.some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.session.created'));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='user'));
    for(let i=1;i<entries.length;i++)assert.equal(entries[i]!.parentId,entries[i-1]!.id,'initial custom entry and later native append stay on the same canonical chain');
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
 const pending=f.api.handle('session.new',{}),child=f.children.at(-1),record=f.api.store.list('session:').map((row:any)=>row.value).find((record:any)=>!f.api.workers.get(record.id)?.state.sessionFile);
 assert.ok(record);const cwd=record.workspaceDir,manager=SessionManager.create(cwd,path.join(f.dataDir,'sessions'));manager.appendMessage({role:'user',content:'temporary-native-history',timestamp:Date.now()});
 child.state={isRunning:false,lifecycleStatus:'idle',sessionId:manager.getSessionId(),sessionFile:manager.getSessionFile(),plugins:['swarm'],thinkingLevels:['off']};child.emit('message',{type:'ready',state:child.state,models:[],providers:[]});await pending;return {record:f.api.store.get('session:'+record.id).value,child,manager};
}
test('temporary workspaces are isolated, recoverable and compatible with file APIs',async()=>{
 const f=fixture();try{const a=await temporary(f),b=await temporary(f);assert.notEqual(a.record.workspaceDir,b.record.workspaceDir);assert.equal(a.record.projectId,'');assert.deepEqual(JSON.parse(JSON.stringify(a.record.workspace)),{kind:'temporary',sessionId:a.record.id});assert.equal(a.child.options.cwd,a.record.workspaceDir);assert.equal(a.child.options.env.FRIEND_PI_PROJECT,a.record.workspaceDir);
 fs.writeFileSync(path.join(a.record.workspaceDir,'中文.md'),'临时正文');assert.equal((await f.api.handle('file.read',{workspace:a.record.workspace,path:'中文.md',edit:true})).content,'临时正文');assert.equal(f.api.store.list('project:').length,1);assert.equal((await f.api.handle('file.read',{projectId:'fixture',path:(fs.writeFileSync(path.join(f.project,'legacy.txt'),'old'),'legacy.txt')})).content,'old');
 const cold=new RecordStore('desktop',f.dataDir);try{assert.equal(cold.get<{workspaceDir:string}>('session:'+a.record.id)!.value.workspaceDir,a.record.workspaceDir);}finally{cold.close();}
 }finally{f.cleanup();}
});
test('promotion retains directory, original Pi identity and worker; running promotion is rejected',async()=>{
 const f=fixture();try{const a=await temporary(f),worker=f.api.workers.get(a.record.id);worker.state.isRunning=true;await assert.rejects(f.api.handle('session.promote',{id:a.record.id,name:'登记项目'}),/停止/);worker.state.isRunning=false;
 const before={cwd:worker.child.options.cwd,file:a.record.path,native:a.record.piSessionId,count:f.children.length};await f.api.handle('session.promote',{id:a.record.id,name:'登记项目'});const record=f.api.store.get('session:'+a.record.id).value;assert.equal(f.api.workers.get(a.record.id),worker);assert.equal(f.children.length,before.count);assert.equal(record.path,before.file);assert.equal(record.piSessionId,before.native);assert.equal(record.workspace.kind,'project');assert.equal(f.api.store.get('project:'+record.projectId).value.path,before.cwd);
 a.child.emit('message',{type:'event',event:{type:'state',data:a.child.state}});await f.flush();assert.equal(f.api.store.get('session:'+a.record.id).value.projectId,record.projectId);await assert.rejects(f.api.handle('session.promote',{id:a.record.id,name:'again'}),/已归属/);
 }finally{f.cleanup();}
});
test('project order persists exact permutations without altering active execution target',async()=>{
 const f=fixture();try{for(const id of ['second','third'])f.api.store.put('project:'+id,{id,path:f.project,name:id});const record=f.record('active'),child=await f.ready(record);await f.api.handle('session.open',{id:record.id});f.api.workers.get(record.id).state.isRunning=true;
 const sorted=await f.api.handle('project.reorder',{ids:['third','fixture','second']});assert.deepEqual(Array.from(sorted.projects,(p:any)=>p.id),['third','fixture','second']);assert.equal(sorted.current.sessionId,record.id);assert.equal(f.api.workers.get(record.id).child,child);
 for(const ids of [['fixture'],['third','third','fixture'],['third','foreign','fixture']])await assert.rejects(f.api.handle('project.reorder',{ids}));assert.deepEqual(Array.from(f.api.store.get('project-order').value),['third','fixture','second']);
 f.api.store.put('project:new',{id:'new',path:f.project,name:'New'});assert.deepEqual(Array.from((await f.api.handle('app.state',{})).projects,(p:any)=>p.id),['third','fixture','second','new']);
 }finally{f.cleanup();}
});
