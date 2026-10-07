import { app,BrowserWindow,ipcMain,dialog,Menu } from 'electron';
import { fork,type ChildProcess } from 'node:child_process';
import { existsSync,readFileSync,realpathSync } from 'node:fs';
import { join,resolve,dirname,relative,isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RecordStore,object,text,projectIdentity } from '@friend-pi/core';

if(process.argv.includes('--version')){console.log(`v${process.versions.electron}`);app.exit(0);}
const __dirname=dirname(fileURLToPath(import.meta.url));
const execute=promisify(execFile);const root=app.isPackaged?app.getAppPath():resolve(__dirname,'../../..');
const dataDir=resolve(process.env.FRIEND_PI_DATA_DIR||join(app.getPath('appData'),'Friend-Pi'));process.env.FRIEND_PI_DATA_DIR=dataDir;
const node=process.env.FRIEND_PI_NODE||(app.isPackaged?join(process.resourcesPath,'runtime','node'):join(process.env.HOME||'','/.local/bin/node'));
const store=new RecordStore('desktop',dataDir);
interface Project {id:string;path:string;name:string}
interface SessionRecord {id:string;projectId:string;name:string;path?:string;updatedAt:string;modelId?:string;thinkingLevel?:string;plugins?:string[]}
interface Worker {child:ChildProcess;record:SessionRecord;state:Record<string,unknown>;ready:Promise<void>;pending:Map<string,{resolve:(data:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>}
const workers=new Map<string,Worker>();const dialogOwners=new Map<string,string>();let currentId=store.get<string>('current')?.value;let window:BrowserWindow;let shuttingDown=false;
let models:unknown[]=[];let providers:unknown[]=[];
const allowed=new Set(['app.state','project.open','project.select','session.new','session.open','session.rename','session.send','session.stop','session.configure','plugin.call','file.pick','file.read','git.diff','provider.save','dialog.respond']);
function records(){return store.list<SessionRecord>('session:').map(row=>row.value);}
function projects(){return store.list<Project>('project:').map(row=>row.value);}
function state(){const worker=currentId?workers.get(currentId):undefined;return {projects:projects(),sessions:records(),current:worker?{...worker.state,sessionId:worker.record.id,piSessionId:worker.state.sessionId,projectId:worker.record.projectId}:undefined,models,providers,piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit};}
function publish(type:string,data:unknown,sessionId?:string){if(window&&!window.isDestroyed())window.webContents.send('friend-pi:event',{type,data,sessionId});}
function publishState(){publish('state',state());}
function persist(record:SessionRecord){store.put(`session:${record.id}`,record);}
function request(worker:Worker,method:string,input:Record<string,unknown>={}):Promise<unknown>{
  const id=randomUUID();return new Promise((resolveResult,reject)=>{const timer=setTimeout(()=>{worker.pending.delete(id);reject(new Error('运行时操作超时，请检查状态'));},125000);worker.pending.set(id,{resolve:resolveResult,reject,timer});worker.child.send({type:'request',id,method,input});});
}
async function startWorker(record:SessionRecord):Promise<Worker>{
  const previous=workers.get(record.id);if(previous){await previous.ready;return previous;}
  const project=store.get<Project>(`project:${record.projectId}`)?.value;if(!project)throw new Error('项目不可用');
  if(!existsSync(node))throw new Error('Node 运行时缺失，请重新构建');
  let resolveReady:()=>void=()=>{};let rejectReady:(error:Error)=>void=()=>{};
  const ready=new Promise<void>((resolveResult,reject)=>{resolveReady=resolveResult;rejectReady=reject;});
  const child=fork(join(root,'apps/desktop/dist/sdk-worker.mjs'),[],{execPath:node,cwd:project.path,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PATH:`${dirname(node)}:${process.env.PATH||''}`,FRIEND_PI_ROOT:root,FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_PROJECT:project.path,FRIEND_PI_AGENT_DIR:join(dataDir,'pi'),FRIEND_PI_MEMBER_WORKER:join(root,'packages/swarm/dist/member.js'),FRIEND_PI_SESSION_FILE:record.path&&existsSync(record.path)?record.path:undefined,FRIEND_PI_MODEL:record.modelId,FRIEND_PI_PLUGINS:record.plugins?JSON.stringify(record.plugins):undefined}});
  const worker:Worker={child,record,state:{isRunning:false,messages:[]},ready,pending:new Map()};workers.set(record.id,worker);
  const timer=setTimeout(()=>{rejectReady(new Error('Pi 初始化超时'));child.kill();},45000);
  child.on('message',raw=>{
    if(!raw||typeof raw!=='object')return;const message=object(raw);
    if(message.type==='ready'){
      clearTimeout(timer);worker.state=object(message.state);if(typeof worker.state.sessionFile==='string')record.path=worker.state.sessionFile;record.updatedAt=new Date().toISOString();persist(record);models=Array.isArray(message.models)?message.models:[];providers=Array.isArray(message.providers)?message.providers:[];resolveReady();publishState();
    }else if(message.type==='response'){
      const pending=worker.pending.get(String(message.id));if(!pending)return;clearTimeout(pending.timer);worker.pending.delete(String(message.id));if(message.error)pending.reject(new Error(String(message.error)));else pending.resolve(message.result);
    }else if(message.type==='fatal'){clearTimeout(timer);rejectReady(new Error(String(message.error)));publish('notice',{level:'error',message:message.error},record.id);}
    else if(message.type==='event'){
      const event=object(message.event);if(event.type==='state'){worker.state=object(event.data);record.updatedAt=new Date().toISOString();if(typeof worker.state.sessionFile==='string')record.path=worker.state.sessionFile;persist(record);publishState();}
      else {if(event.type==='dialog'){const data=object(event.data);dialogOwners.set(String(data.id),record.id);}if(event.type==='dialog.closed')dialogOwners.delete(String(object(event.data).id));publish(String(event.type),event.data,record.id);}
    }
  });
  child.stderr?.on('data',bytes=>{const message=String(bytes);if(!message.includes('ExperimentalWarning'))publish('notice',{level:'warning',message:message.slice(0,1000)},record.id);});
  child.on('exit',(code)=>{clearTimeout(timer);for(const pending of worker.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('运行时已退出，未自动重放请求'));}worker.pending.clear();workers.delete(record.id);for(const [id,owner] of dialogOwners)if(owner===record.id){dialogOwners.delete(id);publish('dialog.closed',{id},record.id);}rejectReady(new Error(`Pi 进程退出 (${code})`));if(!shuttingDown){publish('notice',{level:'error',message:'运行时已退出。历史已保留，重新打开会话后显式继续。'},record.id);publishState();}});
  await ready;if(record.thinkingLevel)worker.state=object(await request(worker,'configure',{thinkingLevel:record.thinkingLevel}));return worker;
}
async function target(input:Record<string,unknown>):Promise<Worker>{const id=text(input.sessionId||currentId,'会话');const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话已不可用');return await startWorker(record);}
function pathInProject(projectId:string,path:string){const project=store.get<Project>(`project:${projectId}`)?.value;if(!project)throw new Error('项目不存在');const actual=realpathSync(resolve(project.path,path));const rel=relative(realpathSync(project.path),actual);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('只能读取当前项目文件');return actual;}
async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  if(method==='app.state')return state();
  if(method==='project.open'){
    let path=typeof input.path==='string'?input.path:undefined;if(!path){const result=await dialog.showOpenDialog(window,{title:'打开项目',properties:['openDirectory']});if(result.canceled)return {cancelled:true};path=result.filePaths[0];}
    const canonical=realpathSync(text(path));const project:Project={id:projectIdentity(canonical),path:canonical,name:canonical.split('/').at(-1)||canonical};store.put(`project:${project.id}`,project);publishState();return project;
  }
  if(method==='session.new'){
    const projectId=text(input.projectId);if(!store.get(`project:${projectId}`))throw new Error('请先打开项目');const record:SessionRecord={id:randomUUID(),projectId,name:'新会话',updatedAt:new Date().toISOString()};persist(record);currentId=record.id;store.put('current',currentId);await startWorker(record);publishState();return state();
  }
  if(method==='project.select'){
    const projectId=text(input.projectId);if(!store.get(`project:${projectId}`))throw new Error('项目不存在');
    const recent=records().filter(record=>record.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(recent)return await handle('session.open',{id:recent.id});
    return await handle('session.new',{projectId});
  }
  if(method==='session.open'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');await startWorker(record);currentId=id;store.put('current',id);publishState();return state();
  }
  if(method==='session.rename'){
    const id=text(input.id);const record=store.get<SessionRecord>(`session:${id}`)?.value;if(!record)throw new Error('会话不存在');record.name=text(input.name,'名称',200);persist(record);const worker=workers.get(id);if(worker)await request(worker,'rename',{name:record.name});publishState();return state();
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
  if(method==='provider.save'){const result=object(await request(worker,'provider.save',input));models=Array.isArray(result.models)?result.models:models;providers=Array.isArray(result.providers)?result.providers:providers;worker.state=result;worker.record.modelId=typeof result.modelId==='string'?result.modelId:undefined;persist(worker.record);publishState();return {saved:true};}
  throw new Error('未知客户端操作');
}
app.setName('Friend-Pi');app.setPath('userData',dataDir);
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    const qaWidth=Number(process.env.FRIEND_PI_QA_WIDTH);const qaHeight=Number(process.env.FRIEND_PI_QA_HEIGHT);
    window=new BrowserWindow({title:'Friend-Pi',width:Number.isInteger(qaWidth)&&qaWidth>=680?qaWidth:1320,height:Number.isInteger(qaHeight)&&qaHeight>=550?qaHeight:860,minWidth:680,minHeight:550,backgroundColor:'#f7f8fb',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Friend-Pi',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'显示',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}]));
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    ipcMain.handle('friend-pi:request',async(event,method:unknown,raw:unknown)=>{
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('请求来源无效');if(typeof method!=='string'||!allowed.has(method))throw new Error('客户端操作无效');return await handle(method,object(raw||{}));
    });
    await window.loadFile(join(__dirname,'renderer','index.html'));
    if(currentId){const record=store.get<SessionRecord>(`session:${currentId}`)?.value;if(record)try{await startWorker(record);}catch(error){publish('notice',{level:'error',message:String(error)});}}
    publishState();
  }).catch(error=>{dialog.showErrorBox('Friend-Pi 启动失败',String(error));app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(shuttingDown)return;event.preventDefault();shuttingDown=true;void (async()=>{await Promise.allSettled([...workers.values()].map(worker=>request(worker,'shutdown')));for(const worker of workers.values())worker.child.kill();store.close();app.quit();})();});
}
