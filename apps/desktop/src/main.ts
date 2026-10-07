import { app,BrowserWindow,ipcMain,dialog,Menu } from 'electron';
import { fork,type ChildProcess } from 'node:child_process';
import { existsSync,readFileSync,realpathSync } from 'node:fs';
import { join,resolve,dirname,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RecordStore,object,text,projectIdentity } from '@friend-pi/core';
import { createProviderRuntime,providerMetadata,saveProviderConfiguration,type ProviderRuntime } from './provider-settings.js';

if(process.argv.includes('--version')){console.log(`v${process.versions.electron}`);app.exit(0);}
const __dirname=dirname(fileURLToPath(import.meta.url));
const execute=promisify(execFile);const root=app.isPackaged?app.getAppPath():resolve(__dirname,'../../..');
const dataDir=resolve(process.env.FRIEND_PI_DATA_DIR||join(app.getPath('appData'),'Friend-Pi'));process.env.FRIEND_PI_DATA_DIR=dataDir;
const node=process.env.FRIEND_PI_NODE||(app.isPackaged?join(process.resourcesPath,'runtime','node'):join(process.env.HOME||'','/.local/bin/node'));
const store=new RecordStore('desktop',dataDir);
interface Project {id:string;path:string;name:string}
interface SessionRecord {id:string;projectId:string;name:string;path?:string;updatedAt:string;modelId?:string;thinkingLevel?:string;plugins?:string[];status?:string;executionMode?:string;planMode?:boolean}
const pluginNames=['swarm','expert','memory','topic-rebuild'];
const thinkingLevels=['off','minimal','low','medium','high','xhigh'];
interface Preferences {defaultModelId:string;defaultThinkingLevel:string;defaultPlugins:string[];defaultMode:'single'|'swarm';defaultPlanMode:boolean}
const preferenceDefaults:Preferences={defaultModelId:'',defaultThinkingLevel:'medium',defaultPlugins:pluginNames,defaultMode:'single',defaultPlanMode:false};
function preferences():Preferences{return {...preferenceDefaults,...store.get<Partial<Preferences>>('preferences')?.value};}
let providerRuntime:Promise<ProviderRuntime>|undefined;
const getProviderRuntime=()=>providerRuntime||=createProviderRuntime(dataDir);
function requireActive(){if(shuttingDown)throw new Error('应用正在退出');}
async function loadProviderMetadata(){const runtime=await getProviderRuntime();requireActive();await runtime.refresh();requireActive();const metadata=providerMetadata(runtime);models=metadata.models;providers=metadata.providers;}
async function settings(){await loadProviderMetadata();return {preferences:preferences(),models,providers,paths:{dataDir},piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit};}
interface Worker {child:ChildProcess;record:SessionRecord;state:Record<string,unknown>;ready:Promise<void>;rejectReady:(error:Error)=>void;phase:'starting'|'ready'|'stopping'|'exited';exited:boolean;groupOwned:boolean;startupTimer?:ReturnType<typeof setTimeout>;termination?:Promise<void>;pending:Map<string,{resolve:(data:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>}
const workers=new Map<string,Worker>();const liveWorkers=new Set<Worker>();const dialogOwners=new Map<string,string>();let currentId=store.get<string>('current')?.value;let window:BrowserWindow;let shuttingDown=false;let quitComplete=false;let storeClosed=false;
let models:unknown[]=[];let providers:unknown[]=[];
const allowed=new Set(['app.state','settings.get','settings.update','project.open','project.select','session.new','session.open','session.rename','session.send','session.stop','session.configure','plugin.call','file.pick','file.read','git.diff','provider.save','dialog.respond']);
function records(){return store.list<SessionRecord>('session:').map(row=>row.value);}
function projects(){return store.list<Project>('project:').map(row=>row.value);}
function state(){if(storeClosed)throw new Error('应用已经退出');const worker=currentId?workers.get(currentId):undefined;return {projects:projects(),sessions:records(),current:worker?{...worker.state,sessionId:worker.record.id,piSessionId:worker.state.sessionId,projectId:worker.record.projectId}:undefined,models,providers,preferences:preferences(),piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit};}
function publish(type:string,data:unknown,sessionId?:string){if(window&&!window.isDestroyed())window.webContents.send('friend-pi:event',{type,data,sessionId});}
function publishState(){if(!shuttingDown)publish('state',state());}
function persist(record:SessionRecord){if(storeClosed)throw new Error('应用已经退出');store.put(`session:${record.id}`,record);}
function persistWorker(worker:Worker){const s=worker.state;worker.record.updatedAt=new Date().toISOString();if(typeof s.sessionFile==='string')worker.record.path=s.sessionFile;if(typeof s.lifecycleStatus==='string')worker.record.status=s.lifecycleStatus;if(typeof s.modelId==='string')worker.record.modelId=s.modelId;if(typeof s.thinkingLevel==='string')worker.record.thinkingLevel=s.thinkingLevel;if(typeof s.executionMode==='string')worker.record.executionMode=s.executionMode;if(typeof s.planMode==='boolean')worker.record.planMode=s.planMode;persist(worker.record);}
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
  const previous=workers.get(record.id);if(previous){await previous.ready;if(previous.phase!=='ready'||workers.get(record.id)!==previous)throw new Error('运行时已退出，请重新打开会话');return previous;}
  const project=store.get<Project>(`project:${record.projectId}`)?.value;if(!project)throw new Error('项目不可用');
  if(!existsSync(node))throw new Error('Node 运行时缺失，请重新构建');
  if(['running','awaiting_review','rebuilding'].includes(record.status||'')){record.status='interrupted';persist(record);}
  let resolveReady:()=>void=()=>{};let rejectReady:(error:Error)=>void=()=>{};
  const ready=new Promise<void>((resolveResult,reject)=>{resolveReady=resolveResult;rejectReady=reject;});
  const initialThinking=record.thinkingLevel;
  const groupOwned=process.platform!=='win32';
  const child=fork(join(root,'apps/desktop/dist/sdk-worker.mjs'),[],{execPath:node,cwd:project.path,detached:groupOwned,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PATH:`${dirname(node)}:${process.env.PATH||''}`,FRIEND_PI_ROOT:root,FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_PROJECT:project.path,FRIEND_PI_AGENT_DIR:join(dataDir,'pi'),FRIEND_PI_MEMBER_WORKER:join(root,'packages/swarm/dist/member.js'),FRIEND_PI_SESSION_FILE:record.path&&existsSync(record.path)?record.path:undefined,FRIEND_PI_MODEL:record.modelId,FRIEND_PI_STATUS:record.status,FRIEND_PI_PLAN_MODE:record.planMode?'1':'0',FRIEND_PI_MODE:record.executionMode,FRIEND_PI_PLUGINS:record.plugins?JSON.stringify(record.plugins):undefined}});
  const worker:Worker={child,record,state:{isRunning:false,messages:[]},ready,rejectReady,phase:'starting',exited:false,groupOwned,pending:new Map()};workers.set(record.id,worker);liveWorkers.add(worker);
  worker.startupTimer=setTimeout(()=>{
    const error=new Error('Pi 初始化超时；请检查系统文件访问授权，重新打开会话后显式继续');
    retireWorker(worker,error,true);void terminateWorker(worker);if(!shuttingDown)publishState();
  },45000);
  child.on('message',raw=>{
    if(worker.phase==='stopping'||worker.phase==='exited'||workers.get(record.id)!==worker)return;
    if(!raw||typeof raw!=='object')return;const message=object(raw);
    if(message.type==='ready'){
      if(worker.phase!=='starting'||shuttingDown)return;
      clearTimeout(worker.startupTimer);worker.phase='ready';worker.state=object(message.state);persistWorker(worker);models=Array.isArray(message.models)?message.models:[];providers=Array.isArray(message.providers)?message.providers:[];resolveReady();publishState();
    }else if(message.type==='response'){
      const pending=worker.pending.get(String(message.id));if(!pending)return;clearTimeout(pending.timer);worker.pending.delete(String(message.id));if(message.error)pending.reject(new Error(String(message.error)));else pending.resolve(message.result);
    }else if(message.type==='fatal'){retireWorker(worker,new Error(String(message.error)),true);void terminateWorker(worker);if(!shuttingDown){publish('notice',{level:'error',message:message.error},record.id);publishState();}}
    else if(message.type==='event'){
      const event=object(message.event);if(event.type==='state'){worker.state=object(event.data);persistWorker(worker);publishState();}
      else {if(event.type==='dialog'){const data=object(event.data);dialogOwners.set(String(data.id),record.id);}if(event.type==='dialog.closed')dialogOwners.delete(String(object(event.data).id));publish(String(event.type),event.data,record.id);}
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
  await ready;if(initialThinking)worker.state=object(await request(worker,'configure',{thinkingLevel:initialThinking}));if(worker.phase!=='ready'||workers.get(record.id)!==worker)throw new Error('运行时已退出，请重新打开会话');persistWorker(worker);return worker;
}
async function target(input:Record<string,unknown>):Promise<Worker>{const id=text(input.sessionId||currentId,'会话');const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话已不可用');return await startWorker(record);}
function pathInProject(projectId:string,path:string){const project=store.get<Project>(`project:${projectId}`)?.value;if(!project)throw new Error('项目不存在');const actual=realpathSync(resolve(project.path,path));const rel=relative(realpathSync(project.path),actual);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('只能读取当前项目文件');return actual;}
async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  requireActive();
  if(method==='app.state')return state();
  if(method==='settings.get')return await settings();
  if(method==='settings.update'){
    const next={...preferences()};
    if(input.defaultModelId!==undefined){const id=String(input.defaultModelId);if(id&&!providerMetadata(await getProviderRuntime()).models.some(model=>model.id===id))throw new Error('默认型号不可用');next.defaultModelId=id;}
    if(input.defaultThinkingLevel!==undefined){if(!thinkingLevels.includes(String(input.defaultThinkingLevel)))throw new Error('思考等级无效');next.defaultThinkingLevel=String(input.defaultThinkingLevel);}
    if(input.defaultPlugins!==undefined){if(!Array.isArray(input.defaultPlugins)||input.defaultPlugins.some(name=>!pluginNames.includes(String(name))))throw new Error('插件无效');next.defaultPlugins=[...new Set(input.defaultPlugins.map(String))];}
    if(input.defaultMode!==undefined){if(!['single','swarm'].includes(String(input.defaultMode)))throw new Error('协作方式无效');next.defaultMode=input.defaultMode as 'single'|'swarm';}
    if(input.defaultPlanMode!==undefined){if(typeof input.defaultPlanMode!=='boolean')throw new Error('计划模式无效');next.defaultPlanMode=input.defaultPlanMode;}
    requireActive();store.put('preferences',next);publishState();return await settings();
  }
  if(method==='provider.save'){
    if([...workers.values()].some(worker=>worker.state.isRunning))throw new Error('请等待所有执行停止，再修改供应商配置');
    const provider=await saveProviderConfiguration(await getProviderRuntime(),dataDir,input);requireActive();await loadProviderMetadata();
    for(const active of workers.values()){active.state=object(await request(active,'provider.refresh',{provider}));persistWorker(active);}
    publishState();return {saved:true};
  }
  if(method==='project.open'){
    let path=typeof input.path==='string'?input.path:undefined;if(!path){const result=await dialog.showOpenDialog(window,{title:'打开项目',properties:['openDirectory']});if(result.canceled)return {cancelled:true};path=result.filePaths[0];}
    requireActive();const canonical=realpathSync(text(path));const project:Project={id:projectIdentity(canonical),path:canonical,name:canonical.split('/').at(-1)||canonical};store.put(`project:${project.id}`,project);publishState();return project;
  }
  if(method==='session.new'){
    const projectId=text(input.projectId);if(!store.get(`project:${projectId}`))throw new Error('请先打开项目');const defaults=preferences();const record:SessionRecord={id:randomUUID(),projectId,name:'新会话',updatedAt:new Date().toISOString(),status:'idle',modelId:defaults.defaultModelId||undefined,thinkingLevel:defaults.defaultThinkingLevel,plugins:[...defaults.defaultPlugins],executionMode:defaults.defaultMode,planMode:defaults.defaultPlanMode};persist(record);currentId=record.id;store.put('current',currentId);await startWorker(record);publishState();return state();
  }
  if(method==='project.select'){
    const projectId=text(input.projectId);if(!store.get(`project:${projectId}`))throw new Error('项目不存在');
    const recent=records().filter(record=>record.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(recent)return await handle('session.open',{id:recent.id});
    return await handle('session.new',{projectId});
  }
  if(method==='session.open'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');await startWorker(record);requireActive();currentId=id;store.put('current',id);publishState();return state();
  }
  if(method==='session.rename'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');record.name=text(input.name,'名称',200);persist(record);const worker=workers.get(id);if(worker){worker.record.name=record.name;await request(worker,'rename',{name:record.name});}publishState();return state();
  }
  if(method==='file.pick'){const result=await dialog.showOpenDialog(window,{title:'添加附件',properties:['openFile','multiSelections']});return result.canceled?[]:result.filePaths.map(path=>({path,name:path.split('/').at(-1)}));}
  if(method==='file.read'){const path=pathInProject(text(input.projectId),text(input.path));const bytes=readFileSync(path);if(bytes.length>1024*1024||bytes.includes(0))throw new Error('仅预览 1 MiB 内文本文件');return {path,content:bytes.toString('utf8')};}
  if(method==='git.diff'){const project=store.get<Project>(`project:${text(input.projectId)}`)?.value;if(!project)throw new Error('项目不存在');const result=await execute('git',['diff','--no-ext-diff','HEAD'],{cwd:project.path,maxBuffer:2*1024*1024});return {diff:result.stdout};}
  if(method==='dialog.respond'){const owner=dialogOwners.get(text(input.id));if(!owner)throw new Error('交互已失效');dialogOwners.delete(String(input.id));const worker=workers.get(owner);if(!worker)throw new Error('运行时已结束');return await request(worker,'dialog.respond',input);}
  const worker=await target(input);
  if(method==='session.send'){
    const response=await request(worker,'send',input);if(worker.record.name==='新会话'){worker.record.name=text(input.text).slice(0,48);persist(worker.record);}worker.state=object(await request(worker,'state'));publishState();return response;
  }
  if(method==='session.stop'){worker.state=object(await request(worker,'stop',input));publishState();return state();}
  if(method==='session.configure'){
    worker.state=object(await request(worker,'configure',input));worker.record.modelId=typeof worker.state.modelId==='string'?worker.state.modelId:undefined;worker.record.thinkingLevel=typeof worker.state.thinkingLevel==='string'?worker.state.thinkingLevel:undefined;worker.record.plugins=Array.isArray(worker.state.plugins)?worker.state.plugins.map(String):undefined;persist(worker.record);publishState();return state();
  }
  if(method==='plugin.call')return await request(worker,'plugin',input);
  throw new Error('未知客户端操作');
}
app.setName('Friend-Pi');app.setPath('userData',dataDir);
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    if(shuttingDown)return;
    for(const record of records())if(['running','awaiting_review','rebuilding'].includes(record.status||'')){record.status='interrupted';persist(record);}
    await loadProviderMetadata();
    const qaWidth=Number(process.env.FRIEND_PI_QA_WIDTH);const qaHeight=Number(process.env.FRIEND_PI_QA_HEIGHT);
    window=new BrowserWindow({title:'Friend-Pi',titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:18},width:Number.isInteger(qaWidth)&&qaWidth>=680?qaWidth:1320,height:Number.isInteger(qaHeight)&&qaHeight>=550?qaHeight:860,minWidth:680,minHeight:550,backgroundColor:'#f7f8fb',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Friend-Pi',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'显示',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('friend-pi:request',async(event,method:unknown,raw:unknown)=>{
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('请求来源无效');if(typeof method!=='string'||!allowed.has(method))throw new Error('客户端操作无效');return await handle(method,object(raw||{}));
    });
    await window.loadFile(join(__dirname,'renderer','index.html'));
    if(shuttingDown)return;
    if(currentId){const record=store.get<SessionRecord>(`session:${currentId}`)?.value;if(record)try{await startWorker(record);}catch(error){publish('notice',{level:'error',message:String(error)});}}
    publishState();
  }).catch(error=>{if(!shuttingDown){dialog.showErrorBox('Friend-Pi 启动失败',String(error));app.quit();}});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitComplete)return;event.preventDefault();if(shuttingDown)return;shuttingDown=true;
    void (async()=>{
      const children=[...liveWorkers];const closing=new Error('应用正在退出，执行已中断；未自动重放请求');
      try {
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
