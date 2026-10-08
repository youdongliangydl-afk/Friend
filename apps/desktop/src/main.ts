import { app,BrowserWindow,ipcMain,dialog,Menu,shell,protocol } from 'electron';
import { fork,type ChildProcess } from 'node:child_process';
import { existsSync,readFileSync,realpathSync,unlinkSync,readdirSync } from 'node:fs';
import { join,resolve,dirname,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RecordStore,object,text,projectIdentity,digest,installFixtureProvider } from '@friend-pi/core';
import {fileTree,previewFile,workspaceDiff,captureRunBaseline,projectFile,type DiffScope} from './workspace-files.js';
import { TerminalBroker } from './terminal-broker.js';
import type { TerminalContext } from './terminal-controller.js';
import { sessionWorkspace, temporaryWorkspace, orderedProjects, validateProjectOrder, type Project, type WorkspaceRef } from './workspaces.js';
import { listDirectory, readEditorFile, writeEditorFile } from './file-editor.js';
import { grantHtmlPreview, revokeHtmlPreview, htmlPreviewResponse } from './html-preview.js';
import { createProviderRuntime,providerMetadata,saveProviderConfiguration,type ProviderRuntime } from './provider-settings.js';

import {configuredModelMetadata,requireReadyModel,testConfiguredModel,registerSavedModel} from './model-readiness.js';

if(process.argv.includes('--version')){console.log(`v${process.versions.electron}`);app.exit(0);}
const __dirname=dirname(fileURLToPath(import.meta.url));
const execute=promisify(execFile);const root=app.isPackaged?app.getAppPath():resolve(__dirname,'../../..');
const dataDir=resolve(process.env.FRIEND_PI_DATA_DIR||join(app.getPath('appData'),'Friend-Pi'));process.env.FRIEND_PI_DATA_DIR=dataDir;
const node=process.env.FRIEND_PI_NODE||(app.isPackaged?join(process.resourcesPath,'runtime','node'):join(process.env.HOME||'','/.local/bin/node'));
const store=new RecordStore('desktop',dataDir);
interface SessionRecord {id:string;projectId:string;workspace?:WorkspaceRef;workspaceDir?:string;name:string;path?:string;piSessionId?:string;archived?:boolean;updatedAt:string;modelId?:string;thinkingLevel?:string;plugins?:string[];status?:string;executionMode?:string;planMode?:boolean}
const pluginNames=['swarm','expert','memory','topic-rebuild'];
const thinkingLevels=['off','minimal','low','medium','high','xhigh'];
interface Preferences {defaultModelId:string;defaultThinkingLevel:string;defaultPlugins:string[];defaultMode:'single'|'swarm';defaultPlanMode:boolean;contextMode:'native'|'infinite';backgroundModelId:string}
const preferenceDefaults:Preferences={defaultModelId:'',defaultThinkingLevel:'off',defaultPlugins:pluginNames,defaultMode:'single',defaultPlanMode:false,contextMode:'native',backgroundModelId:''};
function preferences(projectId?:string):Preferences{return {...preferenceDefaults,...store.get<Partial<Preferences>>('preferences')?.value,...(projectId?store.get<Partial<Preferences>>(`preferences:${projectId}`)?.value:{})};}
let providerRuntime:Promise<ProviderRuntime>|undefined;
const getProviderRuntime=()=>providerRuntime||=(async()=>{const runtime=await createProviderRuntime(dataDir);if(process.env.FRIEND_PI_TEST_PROVIDER==='1'){await installFixtureProvider(runtime);registerSavedModel(dataDir,'friend-fixture/offline');}return runtime;})();
function requireActive(){if(shuttingDown)throw new Error('应用正在退出');}
async function loadProviderMetadata(){const runtime=await getProviderRuntime();requireActive();await runtime.refresh({allowNetwork:false});requireActive();const metadata=await configuredModelMetadata(runtime,dataDir);models=metadata.models;providers=metadata.providers;}
async function settings(projectId?:string){await loadProviderMetadata();return {preferences:preferences(projectId),globalPreferences:preferences(),projectOverrides:projectId?store.get(`preferences:${projectId}`)?.value:undefined,models,providers,paths:{dataDir},piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit};}
interface Worker {child:ChildProcess;record:SessionRecord;state:Record<string,unknown>;ready:Promise<void>;rejectReady:(error:Error)=>void;phase:'starting'|'ready'|'stopping'|'exited';exited:boolean;groupOwned:boolean;startupTimer?:ReturnType<typeof setTimeout>;termination?:Promise<void>;pending:Map<string,{resolve:(data:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>}
const workers=new Map<string,Worker>();const liveWorkers=new Set<Worker>();const dialogOwners=new Map<string,string>();let currentId=store.get<string>('current')?.value;let window:BrowserWindow;let shuttingDown=false;let quitComplete=false;let storeClosed=false;
let models:unknown[]=[];let providers:unknown[]=[];
let learningReady=false;let learning:ChildProcess|undefined;let learningRestarts=0;const learningPending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const ownedChildren=new Map<Worker,Set<number>>();
function startLearning(){if(shuttingDown||learning)return;learning=fork(join(root,'apps/desktop/dist/learning-worker.mjs'),[],{execPath:node,cwd:root,detached:process.platform!=='win32',stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_LEARNING_ROLE:'host',FRIEND_PI_DESKTOP_MANAGED:'1'}});const child=learning;learningReady=false;child.on('message',raw=>{if(!raw||typeof raw!=='object')return;const message=object(raw);if(message.type==='ready'){learningReady=true;child.emit('friend-ready');}else if(message.type==='response'){const pending=learningPending.get(String(message.id));if(pending){clearTimeout(pending.timer);learningPending.delete(String(message.id));message.error?pending.reject(new Error(String(message.error))):pending.resolve(message.result);}}else if(message.type==='event')publish('plugin',message.data);else if(message.type==='notice')publish('notice',message.data);else if(message.type==='state')publish('learning',message.data);});child.stderr?.on('data',bytes=>{const value=String(bytes);if(!value.includes('ExperimentalWarning'))publish('notice',{level:'warning',message:value.replace(/sk-[A-Za-z0-9_-]{8,}/g,'[隐藏]').slice(0,1000)});});child.on('exit',()=>{if(learning===child){learning=undefined;learningReady=false;}for(const pending of learningPending.values()){clearTimeout(pending.timer);pending.reject(new Error('后台学习进程已退出，进度保留'));}learningPending.clear();if(!shuttingDown&&learningRestarts++<3)setTimeout(startLearning,1000*learningRestarts);});child.on('error',()=>publish('notice',{level:'warning',message:'后台学习未启动，队列已保留'}));}
async function learningRequest(method:string,input:Record<string,unknown>={},timeoutMs=15000):Promise<unknown>{if(learning&&!learningReady){const child=learning;await new Promise<void>((yes,no)=>{const cleanup=()=>{clearTimeout(timer);child.off('friend-ready',ready);child.off('exit',failed);};const ready=()=>{cleanup();yes();};const failed=()=>{cleanup();no(new Error('后台服务未能启动'));};const timer=setTimeout(failed,timeoutMs);child.once('friend-ready',ready);child.once('exit',failed);});}if(!learning?.connected)return Promise.reject(new Error('后台服务尚未就绪'));const id=randomUUID();return new Promise((resolveResult,reject)=>{const timer=setTimeout(()=>{learningPending.delete(id);reject(new Error('后台服务操作超时'));},timeoutMs);learningPending.set(id,{resolve:resolveResult,reject,timer});learning!.send({type:'request',id,method,input});});}
const allowed=new Set(['app.state','settings.get','settings.update','project.open','project.select','session.new','session.open','session.rename','session.send','session.stop','session.configure','session.archive','session.delete.preview','session.delete','session.relocate','plugin.call','file.pick','file.read','file.tree','file.open','git.diff','provider.save','dialog.respond','plan.read','plan.approve','plan.reject','plan.revise','learning.pause','learning.resume','learning.state']);
allowed.add('link.open');allowed.add('model.test');
for(const method of ['session.promote','project.reorder','file.search','file.write','file.preview','file.preview.revoke'])allowed.add(method);
const terminalBroker=new TerminalBroker(root,node,dataDir,event=>publish('terminal',event));
for(const method of ['create','list','read','input','response','resize','takeover','release','stop'])allowed.add('terminal.'+method);
function terminalContext(record:SessionRecord,actor:'user'|'agent',planMode?:boolean):TerminalContext {const workspace=sessionWorkspace(store,record);return {sessionId:record.id,workspaceId:workspace.id,cwd:workspace.path,actor,planMode,runId:typeof workers.get(record.id)?.state.runId==='string'?String(workers.get(record.id)?.state.runId):undefined};}
const deletionPreviews=new Map<string,{token:string;updatedAt:string}>();
const pendingConfigurations=new Map<string,{plugins:string[];contextMode:string}>();
function idleRecord(input:Record<string,unknown>){const id=text(input.id),record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record||store.get(`deleting:${id}`))throw new Error('会话不存在或已删除');const active=workers.get(id);if(active&&(active.phase==='starting'||active.state.isRunning||active.state.lifecycleStatus==='stopping'))throw new Error('请先停止前台和 Swarm 执行');return {record,active};}
async function chooseAfterArchive(projectId:string){const recent=records().filter(r=>r.projectId===projectId&&!r.archived&&!store.get(`deleting:${r.id}`)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];currentId=undefined;store.remove('current');if(recent){try{await startWorker(recent);currentId=recent.id;store.put('current',recent.id);}catch{publish('notice',{level:'warning',message:'其他会话原史不可用，保留空态和索引'});}}}
function records(){return store.list<SessionRecord>('session:').map(row=>row.value);}
function projects(){return orderedProjects(store.list<Project>('project:').map(row=>row.value),store.get<string[]>('project-order')?.value||[]);}
function state(){if(storeClosed)throw new Error('应用已经退出');const worker=currentId?workers.get(currentId):undefined;return {projects:projects(),sessions:records(),current:worker?{...worker.state,pendingConfiguration:pendingConfigurations.get(worker.record.id),sessionId:worker.record.id,piSessionId:worker.state.sessionId,projectId:worker.record.projectId,workspace:sessionWorkspace(store,worker.record).ref,workspacePath:sessionWorkspace(store,worker.record).path}:undefined,models,providers,preferences:preferences(),piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit};}
function publish(type:string,data:unknown,sessionId?:string){if(window&&!window.isDestroyed())window.webContents.send('friend-pi:event',{type,data,sessionId});}
function publishState(){if(!shuttingDown)publish('state',state());}
function persist(record:SessionRecord){if(storeClosed)throw new Error('应用已经退出');if(store.get(`deleting:${record.id}`))return;store.put(`session:${record.id}`,record);}
function persistWorker(worker:Worker){worker.record.archived=store.get<SessionRecord>(`session:${worker.record.id}`)?.value.archived||false;const s=worker.state;worker.record.updatedAt=new Date().toISOString();if(typeof s.sessionFile==='string')worker.record.path=s.sessionFile;if(typeof s.sessionId==='string')worker.record.piSessionId=s.sessionId;if(typeof s.lifecycleStatus==='string')worker.record.status=s.lifecycleStatus;if(typeof s.modelId==='string')worker.record.modelId=s.modelId;if(typeof s.thinkingLevel==='string')worker.record.thinkingLevel=s.thinkingLevel;if(typeof s.executionMode==='string')worker.record.executionMode=s.executionMode;if(typeof s.planMode==='boolean')worker.record.planMode=s.planMode;persist(worker.record);}
function retireWorker(worker:Worker,error:Error,interrupted=false):void {
  if(worker.phase==='stopping'||worker.phase==='exited')return;
  worker.phase='stopping';clearTimeout(worker.startupTimer);worker.rejectReady(error);
  for(const pending of worker.pending.values()){clearTimeout(pending.timer);pending.reject(error);}worker.pending.clear();
  // An earlier process may exit after the user has explicitly reopened this session.
  // Only its own cache entry and dialogs may be removed; the replacement owns its record.
  if(workers.get(worker.record.id)===worker){
    workers.delete(worker.record.id);
    if(interrupted){worker.record.status='interrupted';try{persist(worker.record);}catch{if(!shuttingDown)publish('notice',{level:'error',message:'中断状态未能保存；运行时仍会终止，历史未自动重放。'},worker.record.id);}}
    for(const [id,owner] of dialogOwners)if(owner===worker.record.id){dialogOwners.delete(id);publish('dialog.closed',{id},worker.record.id);}
  }
}
function signalWorker(worker:Worker,signal:NodeJS.Signals):boolean {
  for(const pid of ownedChildren.get(worker)||[]){try{process.kill(-pid,signal);}catch {}}
  if(!worker.child.pid)return false;
  try {
    // Each POSIX SDK process owns a fresh group, inherited by its Swarm members.
    // Pi handles its separate tool groups during normal abort; this fallback targets
    // only the group this application created, not arbitrary OS processes.
    if(worker.groupOwned)process.kill(-worker.child.pid,signal);
    else if(!worker.exited)worker.child.kill(signal);
    else return false;
    return true;
  }catch{return false;}
}
function terminateWorker(worker:Worker):Promise<void> {
  if(worker.termination)return worker.termination;
  worker.termination=new Promise<void>(resolveResult=>{
    if(!signalWorker(worker,'SIGTERM')){resolveResult();return;}
    setTimeout(()=>{signalWorker(worker,'SIGKILL');resolveResult();},1000);
  }).finally(()=>{worker.phase='exited';liveWorkers.delete(worker);});
  return worker.termination;
}
function request(worker:Worker,method:string,input:Record<string,unknown>={},timeoutMs=125000):Promise<unknown>{
  if(worker.phase!=='ready'||!worker.child.connected)return Promise.reject(new Error('运行时未就绪或已退出，请重新打开会话'));
  const id=randomUUID();return new Promise((resolveResult,reject)=>{
    const fail=(error:Error)=>{const pending=worker.pending.get(id);if(!pending)return;clearTimeout(pending.timer);worker.pending.delete(id);pending.reject(error);};
    const timer=setTimeout(()=>fail(new Error('运行时操作超时，请检查状态')),timeoutMs);worker.pending.set(id,{resolve:resolveResult,reject,timer});
    try{worker.child.send({type:'request',id,method,input},error=>{if(error)fail(error);});}catch(error){fail(error instanceof Error?error:new Error(String(error)));}
  });
}
async function startWorker(record:SessionRecord):Promise<Worker>{
  if(shuttingDown)throw new Error('应用正在退出');
  if(store.get(`deleting:${record.id}`))throw new Error('会话已删除');
  if(record.path&&!existsSync(record.path))throw new Error('原始会话历史缺失。请重新定位原史或明确另建会话，索引保持不变。');
  const previous=workers.get(record.id);if(previous){await previous.ready;if(previous.phase!=='ready'||workers.get(record.id)!==previous)throw new Error('运行时已退出，请重新打开会话');return previous;}
  const project=sessionWorkspace(store,record);
  if(!existsSync(node))throw new Error('Node 运行时缺失，请重新构建');
  if(['running','awaiting_review','rebuilding'].includes(record.status||'')){record.status='interrupted';persist(record);}
  let resolveReady:()=>void=()=>{};let rejectReady:(error:Error)=>void=()=>{};
  const ready=new Promise<void>((resolveResult,reject)=>{resolveReady=resolveResult;rejectReady=reject;});
  const initialThinking=record.thinkingLevel;
  const groupOwned=process.platform!=='win32';
  const child=fork(join(root,'apps/desktop/dist/sdk-worker.mjs'),[],{execPath:node,cwd:project.path,detached:groupOwned,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PATH:`${dirname(node)}:${process.env.PATH||''}`,FRIEND_PI_ROOT:root,FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_PROJECT:project.path,FRIEND_PI_AGENT_DIR:join(dataDir,'pi'),FRIEND_PI_MEMBER_WORKER:join(root,'packages/swarm/dist/member.js'),FRIEND_PI_SESSION_FILE:record.path,FRIEND_PI_PI_SESSION_ID:record.piSessionId,FRIEND_PI_DESKTOP_SESSION_ID:record.id,FRIEND_PI_LEARNING_ROLE:'producer',FRIEND_PI_DESKTOP_MANAGED:'1',FRIEND_PI_CONTEXT_MODE:preferences(record.projectId).contextMode,FRIEND_PI_MODEL:record.modelId,FRIEND_PI_STATUS:record.status,FRIEND_PI_PLAN_MODE:record.planMode?'1':'0',FRIEND_PI_MODE:record.executionMode,FRIEND_PI_PLUGINS:record.plugins?JSON.stringify(record.plugins):undefined}});
  // The renderer initializes its draft and execution controls from this first snapshot.
  // Keep the persisted configuration visible while native Pi history is loading.
  const worker:Worker={child,record,state:{isRunning:false,messages:[],modelId:record.modelId,thinkingLevel:record.thinkingLevel,plugins:record.plugins||pluginNames,planMode:record.planMode||false,executionMode:record.executionMode==='swarm'?'swarm':'single',lifecycleStatus:record.status||'idle'},ready,rejectReady,phase:'starting',exited:false,groupOwned,pending:new Map()};workers.set(record.id,worker);liveWorkers.add(worker);
  worker.startupTimer=setTimeout(()=>{
    const error=new Error('Pi 初始化超时；请检查系统文件访问授权，重新打开会话后显式继续');
    retireWorker(worker,error,true);void terminateWorker(worker);if(!shuttingDown)publishState();
  },45000);
  child.on('message',raw=>{
    if(worker.phase==='stopping'||worker.phase==='exited'||workers.get(record.id)!==worker||store.get(`deleting:${record.id}`))return;
    if(!raw||typeof raw!=='object')return;const message=object(raw);
    if(message.type==='ready'){
      if(worker.phase!=='starting'||shuttingDown)return;
      clearTimeout(worker.startupTimer);worker.phase='ready';worker.state=object(message.state);persistWorker(worker);resolveReady();publishState();
    }else if(message.type==='response'){
      const pending=worker.pending.get(String(message.id));if(!pending)return;clearTimeout(pending.timer);worker.pending.delete(String(message.id));if(message.error)pending.reject(new Error(String(message.error)));else pending.resolve(message.result);
    }else if(message.type==='terminal.request'){
      const method=String(message.method);
      if(!['create','list','read','input','stop'].includes(method)||worker.record.archived){child.send({type:'terminal.response',id:message.id,error:'终端请求不允许'});return;}
      void terminalBroker.request(method,object(message.input||{}),terminalContext(worker.record,'agent',worker.state.planMode===true||message.planMode===true)).then(result=>{if(child.connected)child.send({type:'terminal.response',id:message.id,result});}).catch(error=>{if(child.connected)child.send({type:'terminal.response',id:message.id,error:String(error instanceof Error?error.message:error)});});
    }else if(message.type==='fatal'){retireWorker(worker,new Error(String(message.error)),true);void terminateWorker(worker);if(!shuttingDown){publish('notice',{level:'error',message:message.error},record.id);publishState();}}
    else if(message.type==='event'){
      const event=object(message.event);if(event.type==='state'){worker.state=object(event.data);persistWorker(worker);const next=pendingConfigurations.get(worker.record.id);if(next&&!worker.state.isRunning){pendingConfigurations.delete(worker.record.id);void request(worker,'configure',next).then(raw=>{worker.state=object(raw);worker.record.plugins=next.plugins;persistWorker(worker);publishState();}).catch(error=>publish('notice',{level:'error',message:String(error)},worker.record.id));}publishState();}
      else {if(event.type==='plugin'){const plugin=object(event.data);if(plugin.pluginEvent==='swarm.process'){const data=object(plugin.data),pid=Number(data.pid);if(Number.isInteger(pid)&&pid>1){const owned=ownedChildren.get(worker)||new Set<number>();if(data.action==='started'&&data.groupOwned===true)owned.add(pid);else if(data.action==='closed')owned.delete(pid);ownedChildren.set(worker,owned);}}}if(event.type==='dialog'){const data=object(event.data);dialogOwners.set(String(data.id),record.id);}if(event.type==='dialog.closed')dialogOwners.delete(String(object(event.data).id));publish(String(event.type),event.data,record.id);}
    }
  });
  child.stderr?.on('data',bytes=>{if(worker.phase==='stopping'||worker.phase==='exited')return;const message=String(bytes);if(!message.includes('ExperimentalWarning'))publish('notice',{level:'warning',message:message.slice(0,1000)},record.id);});
  child.on('error',error=>{retireWorker(worker,error,true);void terminateWorker(worker);if(!shuttingDown){publish('notice',{level:'error',message:'运行时未能启动；历史已保留，请重新打开会话。'},record.id);publishState();}});
  child.on('exit',(code)=>{
    worker.exited=true;const wasActive=worker.phase==='starting'||worker.phase==='ready';
    retireWorker(worker,new Error(`Pi 进程退出 (${code})，未自动重放请求`),worker.phase==='starting'||['running','awaiting_review','rebuilding'].includes(record.status||''));
    void terminateWorker(worker);
    if(wasActive&&!shuttingDown){publish('notice',{level:'error',message:'运行时已退出。历史已保留，重新打开会话后显式继续。'},record.id);publishState();}
  });
  await ready;if(initialThinking){const levels=Array.isArray(worker.state.thinkingLevels)?worker.state.thinkingLevels:['off'];if(levels.includes(initialThinking))worker.state=object(await request(worker,'configure',{thinkingLevel:initialThinking}));else publish('notice',{level:'warning',message:'旧思考设置不受当前模型支持，已采用 Pi 的有效等级；请在设置中重新选择。'},record.id);}if(worker.phase!=='ready'||workers.get(record.id)!==worker)throw new Error('运行时已退出，请重新打开会话');persistWorker(worker);return worker;
}
async function target(input:Record<string,unknown>):Promise<Worker>{const id=text(input.sessionId||currentId,'会话');const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话已不可用');return await startWorker(record);}
function pathInProject(projectId:string,path:string){const project=store.get<Project>(`project:${projectId}`)?.value;if(!project)throw new Error('项目不存在');const actual=realpathSync(resolve(project.path,path));const rel=relative(realpathSync(project.path),actual);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('只能读取当前项目文件');return actual;}
function resolveWorkspaceInput(input:Record<string,unknown>){
  const ref=object(input.workspace||{});
  if(ref.kind==='temporary'){
    const record=store.get<SessionRecord>('session:'+text(ref.sessionId))?.value;
    if(!record||store.get('deleting:'+record.id))throw new Error('临时工作区不可用');return sessionWorkspace(store,record);
  }
  const projectId=typeof ref.projectId==='string'?ref.projectId:typeof input.projectId==='string'?input.projectId:undefined;
  if(projectId){const project=store.get<Project>('project:'+projectId)?.value;if(!project)throw new Error('项目不存在');return {...project,ref:{kind:'project',projectId} as WorkspaceRef};}
  const record=store.get<SessionRecord>('session:'+text(input.sessionId||currentId))?.value;if(!record)throw new Error('请先创建会话');return sessionWorkspace(store,record);
}
interface Deletion { listProjectId?:string;workspaceDir?:string;id:string;piSessionId?:string;path?:string;projectId:string;state:'preparing'|'complete';token:string;memoryPending?:boolean;nativeIds?:string[];files?:string[];graphIds?:string[];at:string}
async function finishDeletion(mark:Deletion){
 const nativeId=mark.piSessionId;if(!mark.nativeIds){const graphs=store.db.prepare("SELECT json FROM documents WHERE namespace='swarm'").all().map(row=>JSON.parse(String(row.json))).filter(value=>value.sessionId===nativeId&&Array.isArray(value.attempts));mark.graphIds=graphs.map(value=>value.id);const histories=graphs.flatMap(value=>[...value.attempts,...(value.reviews||[]),...(value.reviewAttempts||[]),value.integration?.review].filter(Boolean));mark.nativeIds=[...new Set([nativeId,...histories.map(value=>value.sessionId)].filter(Boolean))];mark.files=[...new Set([mark.path,...histories.map(value=>value.sessionFile)].filter(Boolean))];for(const graphId of mark.graphIds||[]){if(!/^[A-Za-z0-9_-]+$/.test(graphId))continue;const ownedDir=join(dataDir,'swarm-sessions',graphId);if(!existsSync(ownedDir))continue;for(const entry of readdirSync(ownedDir,{recursive:true,withFileTypes:true})){if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;const path=join(entry.parentPath,entry.name);if(!realpathSync(path).startsWith(realpathSync(ownedDir)+'/'))continue;try{const header=JSON.parse(readFileSync(path,'utf8').split('\n')[0]);if(header.type==='session'&&typeof header.id==='string'){mark.nativeIds.push(header.id);mark.files.push(path);}}catch{}}}mark.nativeIds=[...new Set(mark.nativeIds)];mark.files=[...new Set(mark.files)];store.put(`deleting:${mark.id}`,mark);}const active=workers.get(mark.id);let cleanupPending=false;for(const sourceId of mark.nativeIds||[]){const registry=new RecordStore('sessions',dataDir);try{registry.put(`tombstone:${sourceId}`,{desktopId:mark.id,at:mark.at});}finally{registry.close();}await learningRequest('cancelSource',{sessionId:sourceId}).catch(()=>{});const project=store.get<Project>(`project:${mark.projectId}`)?.value||(mark.workspaceDir?{id:mark.projectId,path:mark.workspaceDir}:undefined);if(project){try{await learningRequest('source.deleted',{sessionId:sourceId,projectId:mark.projectId,projectDir:project.path,sessionFile:mark.path});mark.memoryPending=false;}catch{cleanupPending=true;}}}
 mark.memoryPending=cleanupPending;
 if(active){try{await request(active,'shutdown',{},3000);}catch{}retireWorker(active,new Error('会话已删除'));await terminateWorker(active);}
 for(const file of mark.files||[]){if(file&&existsSync(file)){const rel=relative(realpathSync(dataDir),realpathSync(file));if(!rel.startsWith('..')&&!isAbsolute(rel))unlinkSync(file);}}
 for(const graphId of mark.graphIds||[]){if(!/^[A-Za-z0-9_-]+$/.test(graphId))continue;const dir=join(dataDir,'swarm-shared',graphId);if(existsSync(dir))for(const entry of readdirSync(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isFile()&&realpathSync(file).startsWith(realpathSync(dir)+'/'))unlinkSync(file);}}
 store.transaction(()=>{for(const namespace of ['sessions','topic-rebuild','plans','diff','swarm','memory']){const rows=store.db.prepare('SELECT key,json FROM documents WHERE namespace=?').all(namespace);for(const row of rows){if(namespace==='sessions'&&String(row.key).startsWith('tombstone:'))continue;const value=JSON.parse(String(row.json));if((mark.nativeIds||[]).some(id=>value.sessionId===id||value.field?.sessionId===id||row.key===id||String(row.key).endsWith(':'+id)||String(row.key).includes(':'+id+':'))||(mark.graphIds||[]).includes(value.graphId))store.db.prepare('DELETE FROM documents WHERE namespace=? AND key=?').run(namespace,String(row.key));}}for(const table of ['rebuild_history','rebuild_history_search'])if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))store.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(nativeId||'');for(const sourceId of (mark.nativeIds||[]).filter(id=>id!==nativeId))for(const table of ['rebuild_history','rebuild_history_search'])if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))store.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sourceId);store.remove(`session:${mark.id}`);store.put(`deleting:${mark.id}`,{...mark,state:'complete'});});
 if(currentId===mark.id)await chooseAfterArchive(mark.listProjectId??mark.projectId);return {deleted:true,id:mark.id,piSessionId:nativeId};
}
async function applyPreferenceSnapshots(projectId?:string){for(const active of workers.values())if(!active.record.archived&&(!projectId||active.record.projectId===projectId)){const effective=preferences(active.record.projectId),next={plugins:effective.defaultPlugins,contextMode:effective.contextMode};if(active.state.isRunning||active.state.lifecycleStatus==='stopping')pendingConfigurations.set(active.record.id,next);else {active.state=object(await request(active,'configure',next));active.record.plugins=effective.defaultPlugins;persistWorker(active);}}}
async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  requireActive();
  if(method==='app.state'){await loadProviderMetadata();return state();}
  if(method.startsWith('terminal.')){const id=text(input.sessionId||currentId),record=store.get<SessionRecord>('session:'+id)?.value;if(!record||store.get('deleting:'+id))throw new Error('会话不可用');if(record.archived&&!['terminal.list','terminal.read'].includes(method))throw new Error('归档会话为只读');return await terminalBroker.request(method.slice(9),input,terminalContext(record,'user'));}
  if(method==='link.open'){const url=new URL(text(input.url));if(!['https:','http:'].includes(url.protocol))throw new Error('链接协议不可打开');await shell.openExternal(url.toString());return {ok:true};}
  if(method==='model.test'){const result=await testConfiguredModel(await getProviderRuntime(),dataDir,text(input.modelId));await loadProviderMetadata();await learningRequest('refresh').catch(()=>{});publishState();return result;}
  if(method==='learning.pause'||method==='learning.resume'){store.put('learning-paused',method==='learning.pause');return await learningRequest(method==='learning.pause'?'pause':'resume');}
  if(method==='learning.state'){const jobs=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_jobs'").get()?store.db.prepare('SELECT state,count(*) AS count FROM memory_jobs GROUP BY state').all():[];return {alive:learningReady&&!!learning?.connected,paused:store.get<boolean>('learning-paused')?.value||false,jobs};}
  if(method==='session.archive'){const {record}=idleRecord(input);if(await terminalBroker.hasRunning(terminalContext(record,'user')))throw new Error('请先关闭此会话的运行终端，再归档');if(typeof input.archived!=='boolean')throw new Error('归档状态无效');record.archived=input.archived;const cached=workers.get(record.id);if(cached)cached.record.archived=record.archived;persist(record);if(currentId===record.id&&record.archived)await chooseAfterArchive(record.projectId);publishState();return state();}
  if(method==='session.delete.preview'){const {record}=idleRecord(input);if(await terminalBroker.hasRunning(terminalContext(record,'user')))throw new Error('请先关闭此会话的运行终端，再删除');const token=digest([record.id,record.updatedAt,record.path,randomUUID()]);deletionPreviews.set(record.id,{token,updatedAt:record.updatedAt});return {id:record.id,name:record.name,token,piSessionId:record.piSessionId,path:record.path,scope:'会话历史和独占插件记录；项目文件、原附件与Git成果保留'};}
  if(method==='session.delete'){
    const id=text(input.id),existing=store.get<Deletion>(`deleting:${id}`)?.value;if(existing){if(existing.token!==input.token)throw new Error('删除确认已失效');if(existing.state==='complete')return {deleted:true,id};const result=await finishDeletion(existing);publishState();return result;}
    const {record}=idleRecord(input),preview=deletionPreviews.get(record.id);if(!preview||preview.token!==input.token||preview.updatedAt!==record.updatedAt)throw new Error('删除预览已变化，请重新确认');deletionPreviews.delete(record.id);let nativeId=record.piSessionId;if(!nativeId&&record.path&&existsSync(record.path)){try{const header=JSON.parse(readFileSync(record.path,'utf8').split('\n')[0]);if(header.type==='session'&&typeof header.id==='string')nativeId=header.id;}catch{}}
    const mark:Deletion={id:record.id,piSessionId:nativeId,path:record.path,projectId:sessionWorkspace(store,record).id,workspaceDir:sessionWorkspace(store,record).path,listProjectId:record.projectId,state:'preparing',token:String(input.token),at:new Date().toISOString()};store.put(`deleting:${record.id}`,mark);const result=await finishDeletion(mark);publishState();return result;
  }
  if(method==='session.relocate'){const {record}=idleRecord(input);const result=await dialog.showOpenDialog(window,{title:'重新定位 Pi 原始历史',properties:['openFile'],filters:[{name:'Pi历史',extensions:['jsonl']}]});if(result.canceled)return {cancelled:true};const prior=workers.get(record.id);if(prior){try{await request(prior,'shutdown',{},3000);}catch{}retireWorker(prior,new Error('重新定位原史'));await terminateWorker(prior);}await startWorker({...record,path:result.filePaths[0]});currentId=record.id;store.put('current',record.id);publishState();return state();}
  if(method==='settings.get')return await settings(typeof input.projectId==='string'?input.projectId:undefined);
  if(method==='settings.update'){
    const projectId=typeof input.projectId==='string'?input.projectId:undefined;if(projectId&&!store.get(`project:${projectId}`))throw new Error('项目不存在');const key=projectId?`preferences:${projectId}`:'preferences';
    if(input.reset===true&&projectId){store.remove(key);await applyPreferenceSnapshots(projectId);await learningRequest('refresh').catch(()=>{});publishState();return await settings(projectId);}
    const next={...preferences(projectId)};
    if(input.defaultModelId!==undefined){const id=String(input.defaultModelId);if(id&&!(await configuredModelMetadata(await getProviderRuntime(),dataDir)).models.some(model=>model.id===id&&model.ready))throw new Error('默认型号不可用');next.defaultModelId=id;}
    if(input.defaultThinkingLevel!==undefined){if(!thinkingLevels.includes(String(input.defaultThinkingLevel)))throw new Error('思考等级无效');next.defaultThinkingLevel=String(input.defaultThinkingLevel);}
    if(input.defaultPlugins!==undefined){if(!Array.isArray(input.defaultPlugins)||input.defaultPlugins.some(name=>!pluginNames.includes(String(name))))throw new Error('插件无效');next.defaultPlugins=[...new Set(input.defaultPlugins.map(String))];}
    if(input.defaultMode!==undefined){if(!['single','swarm'].includes(String(input.defaultMode)))throw new Error('协作方式无效');next.defaultMode=input.defaultMode as 'single'|'swarm';}
    if(input.defaultPlanMode!==undefined){if(typeof input.defaultPlanMode!=='boolean')throw new Error('计划模式无效');next.defaultPlanMode=input.defaultPlanMode;}
    if(input.contextMode!==undefined){if(!['native','infinite'].includes(String(input.contextMode)))throw new Error('上下文模式无效');next.contextMode=input.contextMode as Preferences['contextMode'];}
    if(input.backgroundModelId!==undefined)next.backgroundModelId=String(input.backgroundModelId);
    if(next.defaultMode==='swarm'&&!next.defaultPlugins.includes('swarm'))throw new Error('默认 Swarm 需要同时启用 Swarm 插件');
    if(next.contextMode==='infinite'&&!next.defaultPlugins.includes('topic-rebuild'))throw new Error('无限上下文需要启用 Topic & ReBuild');
    const metadata=await configuredModelMetadata(await getProviderRuntime(),dataDir);if(next.backgroundModelId&&!metadata.models.some(model=>model.id===next.backgroundModelId&&model.ready))throw new Error('后台学习模型不可用');const model=metadata.models.find(model=>model.id===(next.defaultModelId||metadata.models.find(model=>model.ready)?.id));if(model&&!model.thinkingLevels.includes(next.defaultThinkingLevel as never))throw new Error('默认模型不支持此思考等级');
    requireActive();store.put(key,next);
    await applyPreferenceSnapshots(projectId);await learningRequest('refresh').catch(()=>{});
    publishState();return await settings(projectId);
  }
  if(method==='provider.save'){
    if([...workers.values()].some(worker=>worker.state.isRunning))throw new Error('请等待所有执行停止，再修改供应商配置');
    const wasPaused=store.get<boolean>('learning-paused')?.value||false;await learningRequest('pause').catch(()=>{});try{const provider=await saveProviderConfiguration(await getProviderRuntime(),dataDir,input);requireActive();await loadProviderMetadata();await learningRequest('refresh').catch(()=>{});for(const active of workers.values()){active.state=object(await request(active,'provider.refresh',{provider}));persistWorker(active);}}finally{if(!wasPaused)await learningRequest('resume').catch(()=>{});}
    publishState();return {saved:true};
  }
  if(method==='project.open'){
    let path=typeof input.path==='string'?input.path:undefined;if(!path){const result=await dialog.showOpenDialog(window,{title:'打开项目',properties:['openDirectory']});if(result.canceled)return {cancelled:true};path=result.filePaths[0];}
    requireActive();const canonical=realpathSync(text(path));const project:Project={id:projectIdentity(canonical),path:canonical,name:canonical.split('/').at(-1)||canonical};store.put(`project:${project.id}`,project);publishState();return project;
  }
  if(method==='project.reorder'){
    store.put('project-order',validateProjectOrder(projects(),input.ids));publishState();return state();
  }
  if(method==='session.promote'){
    const {record,active}=idleRecord(input);if(record.archived)throw new Error('请先恢复归档会话');
    if(record.workspace?.kind!=='temporary')throw new Error('此会话已归属项目');
    const workspace=sessionWorkspace(store,record),project:Project={id:workspace.id,path:workspace.path,name:typeof input.name==='string'?text(input.name,'项目名称',100):record.name==='新会话'?'新项目':record.name.slice(0,60)};
    store.transaction(()=>{store.put('project:'+project.id,project);record.projectId=project.id;record.workspace={kind:'project',projectId:project.id};persist(record);});
    if(active)active.record=record;publishState();return state();
  }
  if(method==='session.new'){
    const projectId=typeof input.projectId==='string'?input.projectId:'',defaults=preferences(projectId||undefined);
    if(projectId&&!store.get('project:'+projectId))throw new Error('项目不存在');
    if(defaults.defaultMode==='swarm'&&!defaults.defaultPlugins.includes('swarm'))throw new Error('默认 Swarm 配置需要启用对应插件，请在设置中修正');
    const selectedId=typeof input.modelId==='string'&&input.modelId?input.modelId:defaults.defaultModelId||(await configuredModelMetadata(await getProviderRuntime(),dataDir)).models.find(model=>model.ready)?.id;
    if(input.forSend===true)await requireReadyModel(await getProviderRuntime(),dataDir,selectedId||'');
    const id=randomUUID();const workspace=projectId?{workspace:{kind:'project',projectId} as WorkspaceRef}:temporaryWorkspace(dataDir,id);
    const record:SessionRecord={id,projectId,...workspace,name:'新会话',archived:false,updatedAt:new Date().toISOString(),status:'idle',modelId:selectedId,thinkingLevel:defaults.defaultThinkingLevel,plugins:[...defaults.defaultPlugins],executionMode:defaults.defaultMode,planMode:defaults.defaultPlanMode};
    persist(record);currentId=record.id;store.put('current',currentId);await startWorker(record);publishState();return state();
  }
  if(method==='project.select'){
    const projectId=typeof input.projectId==='string'?input.projectId:'';if(projectId&&!store.get('project:'+projectId))throw new Error('项目不存在');
    const recent=records().filter(record=>record.projectId===projectId&&!record.archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(recent)return await handle('session.open',{id:recent.id});
    currentId=undefined;store.remove('current');publishState();return state();
  }
  if(method==='session.open'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');await startWorker(record);requireActive();currentId=id;store.put('current',id);publishState();return state();
  }
  if(method==='session.rename'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');record.name=text(input.name,'名称',200);persist(record);const worker=workers.get(id);if(worker){worker.record.name=record.name;await request(worker,'rename',{name:record.name});}publishState();return state();
  }
  if(method==='file.pick'){const result=await dialog.showOpenDialog(window,{title:'添加附件',properties:['openFile','multiSelections']});return result.canceled?[]:result.filePaths.map(path=>({path,name:path.split('/').at(-1)}));}
  if(method==='file.preview.revoke'){revokeHtmlPreview(text(input.token));return {revoked:true};}
  if(['file.search','file.read','file.tree','file.open','file.write','file.preview','git.diff'].includes(method)){
    const workspace=resolveWorkspaceInput(input);
    if(method==='file.search'){const all=fileTree(workspace.path),query=text(input.query).toLowerCase();return {entries:all.entries.filter(entry=>entry.kind!=='directory'&&entry.path.toLowerCase().includes(query)).map(entry=>({...entry,name:entry.path})),truncated:all.truncated};}
    if(method==='file.tree')return typeof input.directory==='string'?listDirectory(workspace.path,input.directory,Number(input.offset)||0):fileTree(workspace.path);
    if(method==='file.read')return input.edit===true?readEditorFile(workspace.path,text(input.path)):previewFile(workspace.path,text(input.path),typeof input.offset==='number'?input.offset:0,typeof input.line==='number'?input.line:undefined);
    if(method==='file.write'){if(typeof input.content!=='string')throw new Error('文件内容无效');const result=writeEditorFile(workspace.path,text(input.path),input.content,text(input.expectedHash));if(result.saved)publish('files.changed',{workspaceId:workspace.id,path:input.path});return result;}
    if(method==='file.preview')return grantHtmlPreview(workspace.path,text(input.path),typeof input.content==='string'?input.content:undefined);
    if(method==='file.open'){await shell.openPath(projectFile(workspace.path,text(input.path)));return {ok:true};}
    const scope=String(input.scope||'workspace');if(!['workspace','unstaged','staged','run'].includes(scope))throw new Error('Diff 范围无效');return await workspaceDiff(workspace.path,workspace.id,dataDir,scope as DiffScope,typeof input.runId==='string'?input.runId:workers.get(currentId||'')?.state.runId as string|undefined);
  }
  if(method==='dialog.respond'){const owner=dialogOwners.get(text(input.id));if(!owner)throw new Error('交互已失效');dialogOwners.delete(String(input.id));const worker=workers.get(owner);if(!worker)throw new Error('运行时已结束');return await request(worker,'dialog.respond',input);}
  const worker=await target(input);
  if(method==='session.send'){
    if(worker.record.archived)throw new Error('归档会话为只读，请先恢复');await requireReadyModel(await getProviderRuntime(),dataDir,String(worker.state.modelId||''));const nextRun=worker.state.isRunning?String(worker.state.runId):randomUUID();const project=sessionWorkspace(store,worker.record);if(!worker.state.isRunning)await captureRunBaseline(project.path,project.id,nextRun,dataDir,worker.record.piSessionId).catch(()=>{});const response=await request(worker,'send',{...input,runId:nextRun});if(worker.record.name==='新会话'){worker.record.name=text(input.text).slice(0,48);persist(worker.record);}worker.state=object(await request(worker,'state'));publishState();return response;
  }
  if(method.startsWith('plan.')){if(method!=='plan.read'&&worker.record.archived)throw new Error('请先恢复归档会话');const nextRun=randomUUID();if(method==='plan.approve'){await requireReadyModel(await getProviderRuntime(),dataDir,String(worker.state.modelId||''));const project=sessionWorkspace(store,worker.record);await captureRunBaseline(project.path,project.id,nextRun,dataDir,worker.record.piSessionId).catch(()=>{});}const result=await request(worker,method,{...input,runId:nextRun});worker.state=object(await request(worker,'state'));persistWorker(worker);publishState();return result;}
  if(method==='session.stop'){try{worker.state=object(await request(worker,'stop',input));}finally{await terminalBroker.stopAgentServices(terminalContext(worker.record,'user'));}publishState();return state();}
  if(method==='session.configure'){
    if(worker.record.archived)throw new Error('归档会话为只读，请先恢复');if(input.modelId)await requireReadyModel(await getProviderRuntime(),dataDir,text(input.modelId));worker.state=object(await request(worker,'configure',input));worker.record.modelId=typeof worker.state.modelId==='string'?worker.state.modelId:undefined;worker.record.thinkingLevel=typeof worker.state.thinkingLevel==='string'?worker.state.thinkingLevel:undefined;worker.record.plugins=Array.isArray(worker.state.plugins)?worker.state.plugins.map(String):undefined;persist(worker.record);publishState();return state();
  }
  if(method==='plugin.call'){if(worker.record.archived&&!['snapshot','read','search','versions','usage','plan','shared.readVersion','shared.conflicts','invalidation.snapshot'].includes(String(input.action)))throw new Error('归档会话为只读，请先恢复');return await request(worker,'plugin',input);}
  throw new Error('未知客户端操作');
}
protocol?.registerSchemesAsPrivileged?.([{scheme:'friend-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setName('Friend-Pi');app.setPath('userData',dataDir);
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    if(shuttingDown)return;
    protocol?.handle?.('friend-preview',request=>htmlPreviewResponse(request.url));
    for(const record of records())if(['running','awaiting_review','rebuilding'].includes(record.status||'')){record.status='interrupted';persist(record);}
    await loadProviderMetadata();startLearning();for(const mark of store.list<Deletion>('deleting:').map(row=>row.value))if(mark.state==='preparing'||mark.memoryPending)await finishDeletion(mark).catch(error=>publish('notice',{level:'warning',message:'删除清理待恢复：'+String(error)}));
    const qaWidth=Number(process.env.FRIEND_PI_QA_WIDTH);const qaHeight=Number(process.env.FRIEND_PI_QA_HEIGHT);
    window=new BrowserWindow({title:'Friend-Pi',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},width:Number.isInteger(qaWidth)&&qaWidth>=680?qaWidth:1320,height:Number.isInteger(qaHeight)&&qaHeight>=550?qaHeight:860,minWidth:680,minHeight:550,backgroundColor:'#f7f8fb',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.on('close',event=>{if(!shuttingDown){event.preventDefault();window.hide();}});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Friend-Pi',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'显示',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('friend-pi:request',async(event,method:unknown,raw:unknown)=>{
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('请求来源无效');if(typeof method!=='string'||!allowed.has(method))throw new Error('客户端操作无效');return await handle(method,object(raw||{}));
    });
    await window.loadFile(join(__dirname,'renderer','index.html'));
    const previous=currentId?store.get<SessionRecord>(`session:${currentId}`)?.value:undefined;if(previous&&!previous.archived&&!store.get(`deleting:${previous.id}`))void startWorker(previous).catch(error=>publish('notice',{level:'error',message:String(error)},previous.id));else {currentId=undefined;store.remove('current');}
    if(shuttingDown)return;
    if(currentId){const record=store.get<SessionRecord>(`session:${currentId}`)?.value;if(record)try{await startWorker(record);}catch(error){publish('notice',{level:'error',message:String(error)});}}
    publishState();
  }).catch(error=>{if(!shuttingDown){dialog.showErrorBox('Friend-Pi 启动失败',String(error));app.quit();}});
  app.on('window-all-closed',()=>{});
  app.on('activate',()=>{if(window&&!window.isDestroyed()){window.show();window.focus();}});
  app.on('before-quit',event=>{
    if(quitComplete)return;event.preventDefault();if(shuttingDown)return;shuttingDown=true;
    void (async()=>{
      const children=[...liveWorkers];const closing=new Error('应用正在退出，执行已中断；未自动重放请求');
      try {
        await terminalBroker.shutdown().catch(error=>console.error(String(error)));
        await learningRequest('shutdown',{},3000).catch(()=>{});
        if(learning?.pid){try{process.kill(process.platform!=='win32'?-learning.pid:learning.pid,'SIGTERM');}catch {}}
        // Never wait on startup or on a cached rejected ready promise. Ready workers
        // have three seconds to persist shutdown state before their own process groups stop.
        for(const worker of children)if(worker.phase!=='ready'){retireWorker(worker,closing,true);void terminateWorker(worker);}
        await Promise.allSettled(children.filter(worker=>worker.phase==='ready').map(worker=>request(worker,'shutdown',{},3000)));
      }finally {
        for(const worker of children)retireWorker(worker,closing,worker.phase==='starting'||['running','awaiting_review','rebuilding'].includes(worker.record.status||''));
        await Promise.allSettled(children.map(terminateWorker));
        try{store.close();}finally{storeClosed=true;quitComplete=true;app.quit();}
      }
    })();
  });
}
