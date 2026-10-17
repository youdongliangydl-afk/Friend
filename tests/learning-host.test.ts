import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {closeSync,mkdirSync,mkdtempSync,openSync,rmSync} from 'node:fs';
import {createServer,type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {historyItems,learningHostAvailable,learningRequestHash,learningRequestSnapshot,digest,projectIdentity,RecordStore,LearningBudget,type PluginContext} from '../packages/core/src/index.js';
import {MemoryController,type LearningJob,type MemoryRecord} from '../packages/memory/src/index.js';
import {createProviderRuntime,saveProviderConfiguration} from '../apps/desktop/src/provider-settings.js';
import {foregroundBusy,writeForegroundLease} from '../apps/desktop/src/foreground-lease.js';

type Stage='extract'|'compact'|'foreground';
interface Call {stage:Stage;prompt:string;ended:boolean;closed:boolean;release:()=>void}
interface IpcMessage {type:string;id?:string;error?:string;result?:unknown;state?:Record<string,unknown>;data?:unknown;event?:{type:string;data:Record<string,unknown>}}
const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function until(predicate:()=>boolean,label:string,ms=10000){const end=Date.now()+ms;while(!predicate()){if(Date.now()>=end)throw new Error(`Timeout: ${label}`);await delay(25);}}

/** Actual built entry points, public IPC, isolated SQLite and a loopback HTTP provider. */
async function fixture(hold:(stage:Stage,index:number)=>boolean|'disconnect'|'length'=()=>false){
  const directory=mkdtempSync(join(tmpdir(),'friend-pi-learning-host-')),dataDir=join(directory,'state');
  const calls:Call[]=[],children:Awaited<ReturnType<typeof worker>>[]=[];let active=0,activeLearning=0,maxActive=0,maxLearning=0;
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=String(chunk);
      const body=JSON.parse(raw) as {messages:{content:unknown}[]};const content=body.messages.at(-1)?.content;
      const prompt=typeof content==='string'?content:Array.isArray(content)?content.map(part=>part&&typeof part==='object'&&'text' in part?String(part.text):'').join('\n'):JSON.stringify(content);
      const stage:Stage=prompt.includes('你是项目经验提取器')?'extract':prompt.includes('整理冗余项目记忆')?'compact':'foreground';
      const index=calls.filter(call=>call.stage===stage).length;
      let output='前台只读检查已完成。';
      if(stage==='extract'){
        const items=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)) as {id:string;role:string;userText?:string;text:string}[];
        const source=items.find(item=>item.role==='user')!;const quote=source.userText??source.text;
        output=JSON.stringify({memories:[{title:quote,content:quote,kind:'fact',sourceEntryIds:[source.id],sourceQuotes:{[source.id]:quote}}]});
      }else if(stage==='compact')output=JSON.stringify({memory:null});
      const call:Call={stage,prompt,ended:false,closed:false,release:()=>{if(call.ended||res.destroyed)return;call.ended=true;sendSse(res,output,calls.indexOf(call));}};
      calls.push(call);active++;if(stage!=='foreground')activeLearning++;maxActive=Math.max(maxActive,active);maxLearning=Math.max(maxLearning,activeLearning);
      res.on('close',()=>{call.closed=true;active--;if(stage!=='foreground')activeLearning--;});
      const behavior=hold(stage,index);
      if(behavior==='disconnect'){res.destroy();return;}
      if(behavior==='length'){call.ended=true;sendSse(res,'{"memories":[{"content":"unfinished',calls.indexOf(call),'length');return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
      if(!behavior){await delay(35);call.release();}
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:String(error)}}));}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');
  const runtime=await createProviderRuntime(dataDir);
  await saveProviderConfiguration(runtime,dataDir,{provider:'learning-loopback',modelId:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'test-only-loopback-credential'});

  function rows<T>(table:'memory_jobs'|'memory_records'):T[]{const store=new RecordStore('memory',dataDir);try{if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return [];return store.db.prepare(`SELECT json FROM ${table}`).all().map(row=>JSON.parse(String(row.json)) as T);}finally{store.close();}}
  const jobs=()=>rows<LearningJob>('memory_jobs');const memories=()=>rows<MemoryRecord>('memory_records');
  const modelCall=(job:LearningJob)=>{const operation=job.modelOperations?.at(-1);assert.ok(job.budgetId&&operation,'job checkpoints an independent budget and model operation');const store=new RecordStore('runtime',dataDir);try{return new LearningBudget(store).readCall(job.budgetId,operation.operationId);}finally{store.close();}};
  async function enqueue(name:string){
    const projectDir=join(directory,name);mkdirSync(projectDir,{recursive:true});const manager=SessionManager.create(projectDir,join(dataDir,'sessions'));
    const sessionFile=manager.getSessionFile()!;mkdirSync(join(dataDir,'sessions'),{recursive:true});closeSync(openSync(sessionFile,'wx',0o600));manager.setSessionFile(sessionFile);
    manager.appendCustomEntry('friend-pi.session.created',{v:1,createdAt:new Date().toISOString()});manager.appendMessage({role:'user',content:`${name} 必须保留 UTF-8 中文字段。`,timestamp:Date.now()});
    const sessionId=manager.getSessionId(),projectId=projectIdentity(projectDir);const registry=new RecordStore('sessions',dataDir);registry.put(sessionId,{path:sessionFile,projectDir});registry.close();
    const lease=new RecordStore('runtime',dataDir);const previous=lease.get('learning-host');if(!learningHostAvailable(dataDir))lease.put('learning-host',{pid:process.pid,instance:'test-producer',expiresAt:Date.now()+15000});
    const ctx:PluginContext={origin:'plugin',dataDir,agentDir:join(dataDir,'pi'),projectDir,projectId,sessionId,sessionFile,modelId:'learning-loopback/fixture',thinkingLevel:'off',isIdle:()=>false,history:()=>historyItems(manager.getBranch()),readSource:source=>{const entry=historyItems(manager.getEntries()).find(item=>item.id===source.entryId);if(!entry)throw new Error('Unknown test source');return entry;},complete:async()=>{throw new Error('Producer must not execute a model');},request:async()=>{throw new Error('No producer peer');},appendEntry:(type,data)=>manager.appendCustomEntry(type,data),emit:()=>{},notify:()=>{}};
    const memory=new MemoryController();try{await memory.settled(ctx);}finally{await memory.dispose();if(!previous&&lease.get<{instance:string}>('learning-host')?.value.instance==='test-producer')lease.remove('learning-host');lease.close();}
    const job=jobs().find(item=>item.sessionId===sessionId)!;assert.ok(job,'producer persists a learning job');return {projectDir,projectId,sessionId,sessionFile,jobId:job.id,ctx};
  }
  async function startHost(){const child=await worker('learning-worker',dataDir,{});children.push(child);return child;}
  async function startForeground(projectDir:string){const child=await worker('sdk-worker',dataDir,{FRIEND_PI_PROJECT:projectDir,FRIEND_PI_MODEL:'learning-loopback/fixture',FRIEND_PI_PLUGINS:JSON.stringify(['memory']),FRIEND_PI_LEARNING_ROLE:'producer'});children.push(child);return child;}
  const close=async()=>{for(const child of children){if(child.child.exitCode===null&&child.child.signalCode===null)await child.stop().catch(async()=>{child.child.kill('SIGKILL');await child.exited;});}server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(directory,{recursive:true,force:true});};
  const changeModelConfiguration=async()=>saveProviderConfiguration(runtime,dataDir,{provider:'learning-loopback',modelId:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v2`,api:'openai-completions'});
  const model=runtime.getModel('learning-loopback','fixture')!;const resolvedAuth=await runtime.getAuth(model),modelIdentity=learningRequestSnapshot(model,{...resolvedAuth?.auth,env:resolvedAuth?.env}).identityModel;
  return {directory,dataDir,calls,jobs,memories,modelCall,enqueue,startHost,startForeground,close,changeModelConfiguration,modelIdentity,get maxActive(){return maxActive;},get maxLearning(){return maxLearning;}};
}

function sendSse(res:ServerResponse,text:string,id:number,reason='stop'){
  for(const choice of [{delta:{role:'assistant',content:text},finish_reason:null},{delta:{},finish_reason:reason}])res.write(`data: ${JSON.stringify({id:`completion-${id}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);
  if(reason==='length')res.write(`data: ${JSON.stringify({id:`completion-${id}`,object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:7,completion_tokens:5,total_tokens:12,completion_tokens_details:{reasoning_tokens:2}}})}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function worker(name:'learning-worker'|'sdk-worker',dataDir:string,extra:Record<string,string>){
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('FRIEND_PI_'))delete env[key];
  const child:ChildProcess=fork(resolve(`apps/desktop/dist/${name}.mjs`),[],{execPath:process.execPath,cwd:resolve('.'),stdio:['ignore','pipe','pipe','ipc'],env:{...env,FRIEND_PI_ROOT:resolve('.'),FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_LEARNING_ROLE:'host',...extra}});
  const events:IpcMessage[]=[];let stderr='';const pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done=>child.once('exit',(code,signal)=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(`${name} exited before RPC result`));}pending.clear();done({code,signal});}));
  child.stderr?.on('data',chunk=>{stderr+=String(chunk);});child.on('message',(raw:IpcMessage)=>{events.push(raw);if(raw.type==='response'&&raw.id){const item=pending.get(raw.id);if(item){clearTimeout(item.timer);pending.delete(raw.id);raw.error?item.reject(new Error(raw.error)):item.resolve(raw.result);}}});
  try{await until(()=>events.some(event=>event.type==='ready'||event.type==='fatal')||child.exitCode!==null,'worker ready',12000);const initial=events.find(event=>event.type==='ready');if(!initial)throw new Error(`${name} failed to start: ${events.find(event=>event.type==='fatal')?.error||stderr}`);
    const request=(method:string,input:Record<string,unknown>={})=>new Promise<unknown>((done,reject)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${name}.${method}`));},8000);pending.set(id,{resolve:done,reject,timer});child.send({type:'request',id,method,input},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});});
    const stop=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;await request('shutdown');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<void>((_done,reject)=>{timer=setTimeout(()=>reject(new Error(`${name} did not exit after shutdown`)),8000);})]);}finally{clearTimeout(timer);}};
    return {child,events,initial,request,exited,stop};
  }catch(error){child.kill('SIGKILL');await exited;throw new Error(`${String(error)}\n${name} startup events: ${JSON.stringify(events)}\n${stderr}`);}
}

test('independent Node learning host serializes the durable queue and shuts down without a resident process',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
    const a=await f.enqueue('alpha'),b=await f.enqueue('beta');const host=await f.startHost();assert.notEqual(host.child.pid,process.pid);
    await until(()=>f.calls.some(call=>call.stage==='extract'),'first host extraction').catch(error=>{throw new Error(`${String(error)}\nJobs: ${JSON.stringify(f.jobs().map(({id,state,stage,error})=>({id,state,stage,error})))}\nNotices: ${JSON.stringify(host.events.filter(event=>event.type==='notice'))}`);});await delay(150);
    assert.equal(f.calls.length,1);assert.equal(f.jobs().filter(job=>job.state==='running').length,1);assert.equal(f.jobs().find(job=>job.id===a.jobId)?.owner?.pid,host.child.pid);
    f.calls[0].release();await until(()=>f.jobs().filter(job=>[a.jobId,b.jobId].includes(job.id)).every(job=>job.state==='completed'),'two completed serial jobs');
    assert.equal(f.calls.filter(call=>call.stage==='extract').length,2);assert.equal(f.calls.filter(call=>call.stage==='compact').length,0);assert.equal(f.maxLearning,1);assert.equal(f.memories().filter(record=>record.status==='active').length,2);
    const completed=f.jobs().filter(job=>[a.jobId,b.jobId].includes(job.id));assert.ok(completed.every(job=>f.modelCall(job)?.state==='complete'));assert.ok(completed.every(job=>job.budgetId&&job.budgetId!==job.sourceRunId));
    assert.ok(f.memories().filter(record=>record.status==='active').every(record=>record.kind==='fact'));
    await host.stop();assert.equal((await host.exited).code,0);assert.equal(learningHostAvailable(f.dataDir),false);
    const count=f.calls.length,restarted=await f.startHost();await delay(1000);assert.equal(f.calls.length,count,'completed jobs survive restart without another extraction');assert.ok(f.jobs().filter(job=>[a.jobId,b.jobId].includes(job.id)).every(job=>job.state==='completed'));await restarted.stop();
  }finally{await f.close();}
});

test('actual foreground Pi SDK producer overlaps the host model request without aborting background learning',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='foreground'||stage==='extract'&&index===0);try{
    const source=await f.enqueue('parallel');const host=await f.startHost();await until(()=>f.calls.length===1,'background pending request');const bg=f.calls[0];
    const sdk=await f.startForeground(source.projectDir);const sent=await sdk.request('send',{text:'前台只读检查，不修改文件',mode:'single'}) as {sessionId:string};
    await until(()=>f.calls.some(call=>call.stage==='foreground'),'foreground pending request');assert.equal((await sdk.request('state') as {isRunning:boolean}).isRunning,true);assert.ok(f.maxActive>=2,'separate SDK and host requests overlap');
    assert.equal(bg.closed,false);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.owner?.pid,host.child.pid);
    f.calls.find(call=>call.stage==='foreground')!.release();await until(()=>sdk.events.some(event=>event.event?.type==='pi'&&event.event.data.type==='agent_settled'),'foreground settled');await delay(100);
    assert.equal(bg.closed,false,'new foreground input and settled event do not preempt learning');assert.equal(f.jobs().find(job=>job.id===source.jobId)?.attempts,0);
    bg.release();await until(()=>f.jobs().some(job=>job.sessionId===sent.sessionId&&job.state==='completed')&&f.jobs().find(job=>job.id===source.jobId)?.state==='completed','both producer and backlog completed');
    assert.equal(f.maxLearning,1);assert.ok(f.jobs().filter(job=>job.sessionId===sent.sessionId).every(job=>job.attempts===0));await sdk.stop();await host.stop();
  }finally{await f.close();}
});

test('pausing an active extraction preserves its checkpoint and unknown remote result is never replayed',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
    const source=await f.enqueue('paused');const host=await f.startHost();await until(()=>f.calls.some(call=>call.stage==='extract'),'active extract checkpoint');const before=f.jobs().find(job=>job.id===source.jobId)!;
    assert.equal(before.stage,'extract');assert.deepEqual(before.memoryIds,[]);assert.equal(f.modelCall(before)?.state,'dispatched');await host.request('pause');const paused=f.jobs().find(job=>job.id===source.jobId)!;
    assert.equal(paused.state,'operation_unknown');assert.equal(paused.stage,'extract');assert.equal(paused.attempts,0);assert.equal(paused.owner,undefined);assert.deepEqual(paused.memoryIds,before.memoryIds);assert.equal(f.modelCall(paused)?.state,'unknown');await until(()=>f.calls[0].closed,'paused provider socket closes');const count=f.calls.length;await delay(200);assert.equal(f.calls.length,count);
    await host.request('resume');await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','resume reconciles the original unknown call');await delay(1000);
    const unknown=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(unknown.attempts,0);assert.equal(unknown.stage,'extract');assert.equal(f.calls.filter(call=>call.stage==='extract').length,1);assert.equal(f.memories().filter(record=>record.status==='active').length,0);assert.equal(f.modelCall(unknown)?.state,'unknown');await host.stop();
  }finally{await f.close();}
});

test('a killed host recovers its durable stage but refuses to replay its dispatched remote call',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
    const source=await f.enqueue('crashed');const first=await f.startHost();await until(()=>f.calls.some(call=>call.stage==='extract'),'first extract running');const checkpoint=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(f.modelCall(checkpoint)?.state,'dispatched');
    first.child.kill('SIGKILL');assert.equal((await first.exited).signal,'SIGKILL');await until(()=>f.calls[0].closed,'dead host socket close');assert.equal(f.jobs().find(job=>job.id===source.jobId)?.state,'running');
    const second=await f.startHost();assert.notEqual(second.child.pid,first.child.pid);await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','replacement host reconciles dispatched call');await delay(1000);
    const unknown=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(unknown.attempts,0);assert.equal(unknown.stage,'extract');assert.equal(unknown.owner,undefined);assert.deepEqual(unknown.memoryIds,checkpoint.memoryIds);assert.equal(f.calls.filter(call=>call.stage==='extract').length,1);assert.equal(f.modelCall(unknown)?.state,'dispatched');assert.equal(f.memories().filter(record=>record.status==='active').length,0);await second.stop();
  }finally{await f.close();}
});

test('a killed host with a changed model configuration preserves the original unknown operation without a new HTTP call',{timeout:45000},async()=>{
 const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
  const source=await f.enqueue('crashed-config-change'),first=await f.startHost();await until(()=>f.calls.length===1,'original HTTP dispatched');const checkpoint=f.jobs().find(job=>job.id===source.jobId)!,original=f.modelCall(checkpoint)!;assert.equal(original.state,'dispatched');assert.ok(original.requestHash);
  first.child.kill('SIGKILL');await first.exited;await until(()=>f.calls[0].closed,'crashed HTTP socket closes');await f.changeModelConfiguration();
  const second=await f.startHost();await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','changed configuration cannot escape original unknown');await second.request('resume');await delay(1500);
  const job=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(f.calls.length,1);assert.equal(job.attempts,0);assert.equal(job.operationId,checkpoint.operationId);assert.deepEqual(job.sources,checkpoint.sources);assert.deepEqual(job.pendingRanges,checkpoint.sourceRanges||checkpoint.sources);assert.deepEqual(job.memoryIds,checkpoint.memoryIds);assert.deepEqual(job.modelOperations,checkpoint.modelOperations);assert.deepEqual(job.callIds,checkpoint.callIds);assert.equal(f.modelCall(job)?.callId,original.callId);assert.equal(f.modelCall(job)?.requestHash,original.requestHash);assert.equal(f.modelCall(job)?.state,'dispatched');assert.equal(f.memories().length,0);const cursorStore=new RecordStore('memory',f.dataDir);try{assert.equal(cursorStore.get(`cursor:${source.projectId}:${source.sessionId}`),undefined);}finally{cursorStore.close();}await second.stop();
  const third=await f.startHost();await third.request('resume');await delay(1000);assert.equal(f.calls.length,1);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.state,'operation_unknown');await third.stop();
 }finally{await f.close();}
});

test('a killed compact request cannot be replayed under a new material key after a public title-only correction',{timeout:45000},async()=>{
 const f=await fixture(stage=>stage==='compact');try{
  const source=await f.enqueue('compact-crash'),controller=new MemoryController();let parent:MemoryRecord|undefined;
  try{for(let i=0;i<3;i++){parent=await controller.dispatch('save',{title:`压缩父记忆${i}`,content:`公开输入的独立事实${i}。`,kind:'fact',scope:'project',subject:'compact-fixture',explicitRemember:true},{...source.ctx,origin:'user'}) as MemoryRecord;assert.equal(parent.status,'active');}}finally{await controller.dispose();}
  const first=await f.startHost();await until(()=>f.calls.some(call=>call.stage==='compact'),'compact HTTP dispatched');const checkpoint=f.jobs().find(job=>job.id===source.jobId)!,original=f.modelCall(checkpoint)!;assert.equal(checkpoint.stage,'compact');assert.equal(original.state,'dispatched');const compactCount=f.calls.filter(call=>call.stage==='compact').length,total=f.calls.length;
  first.child.kill('SIGKILL');await first.exited;await until(()=>f.calls.find(call=>call.stage==='compact')!.closed,'compact socket closed');
  const editor=new MemoryController();try{await editor.dispatch('update',{id:parent!.id,revision:parent!.revision,title:'仅修改标题后的父记忆',aliases:['新的别名']},{...source.ctx,origin:'user'});}finally{await editor.dispose();}
  const second=await f.startHost();await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','compact preserves its original unresolved operation');await second.request('resume');await delay(1500);const job=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(f.calls.length,total);assert.equal(f.calls.filter(call=>call.stage==='compact').length,compactCount);assert.equal(compactCount,1);assert.equal(job.attempts,0);assert.equal(job.stage,'compact');assert.deepEqual(job.modelOperations,checkpoint.modelOperations);assert.deepEqual(job.callIds,checkpoint.callIds);assert.deepEqual(job.pendingRanges,checkpoint.sourceRanges||checkpoint.sources);assert.equal(f.modelCall(job)?.callId,original.callId);assert.equal(f.modelCall(job)?.state,'dispatched');const cursorStore=new RecordStore('memory',f.dataDir);try{assert.equal(cursorStore.get(`cursor:${source.projectId}:${source.sessionId}`),undefined);}finally{cursorStore.close();}await second.stop();
  const third=await f.startHost();await third.request('resume');await delay(1000);assert.equal(f.calls.length,total);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.state,'operation_unknown');await third.stop();
 }finally{await f.close();}
});

test('actual HTTP disconnect marks the host operation unknown and neither resume nor restart resends it',{timeout:45000},async t=>{
 const f=await fixture(stage=>stage==='extract'?'disconnect':false);try{
  const source=await f.enqueue('disconnected'),host=await f.startHost();
  await until(()=>f.calls.length>0,'provider receives extraction');
  await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','dispatched disconnect is unknown');
  const job=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(job.attempts,0);assert.equal(f.modelCall(job)?.state,'unknown');assert.equal(f.calls.length,1);
  await host.request('resume');await delay(1000);assert.equal(f.calls.length,1);await host.stop();
  const restarted=await f.startHost();await restarted.request('refresh');await restarted.request('resume');await delay(1000);
  assert.equal(f.calls.length,1);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.state,'operation_unknown');assert.equal(f.memories().filter(record=>record.status==='active').length,0);
  t.diagnostic('HTTP_DISCONNECT_RECEIPT '+JSON.stringify({httpRequests:f.calls.length,state:job.state,attempts:job.attempts,operation:job.modelOperations?.at(-1),ledger:f.modelCall(job)}));await restarted.stop();
 }finally{await f.close();}
});

test('a durable source deletion fences a late localhost model result and invalidates its host job',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
    const source=await f.enqueue('deleted');const host=await f.startHost();await until(()=>f.calls.length===1,'pending deleted-source extraction');
    const registry=new RecordStore('sessions',f.dataDir);registry.put(`tombstone:${source.sessionId}`,{deletedAt:new Date().toISOString()});registry.close();
    f.calls[0].release();await host.request('source.deleted',{sessionId:source.sessionId,projectId:source.projectId,projectDir:source.projectDir,sessionFile:source.sessionFile});
    await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='invalidated','deleted job invalidated');await delay(200);
    assert.equal(f.memories().filter(record=>record.enabled&&record.sources.some(ref=>ref.sessionId===source.sessionId)).length,0);assert.equal(f.calls.filter(call=>call.stage==='compact').length,0);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.attempts,0);await host.stop();
  }finally{await f.close();}
});

test('shutdown persists an interrupted extraction and the next host reports unknown without replay',{timeout:45000},async()=>{
  const f=await fixture((stage,index)=>stage==='extract'&&index===0);try{
    const source=await f.enqueue('shutdown');const first=await f.startHost();await until(()=>f.calls.length===1,'active shutdown request');await first.stop();assert.equal((await first.exited).code,0);assert.equal(learningHostAvailable(f.dataDir),false);
    const pending=f.jobs().find(job=>job.id===source.jobId)!;assert.equal(pending.state,'operation_unknown');assert.equal(pending.stage,'extract');assert.equal(pending.attempts,0);assert.equal(pending.owner,undefined);assert.equal(f.modelCall(pending)?.state,'unknown');
    const next=await f.startHost();await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='operation_unknown','next launch reconciles original unknown call');await delay(1000);assert.equal(f.calls.filter(call=>call.stage==='extract').length,1);assert.equal(f.memories().filter(record=>record.status==='active').length,0);assert.equal(f.jobs().find(job=>job.id===source.jobId)?.attempts,0);await next.stop();
  }finally{await f.close();}
});


test('actual length-limited HTTP response is recorded as received incomplete and never publishes partial JSON',{timeout:45000},async()=>{
 const f=await fixture(stage=>stage==='extract'?'length':false);try{
  const source=await f.enqueue('length-limited'),host=await f.startHost();
  await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='failed','known incomplete extraction fails visibly');
  const job=f.jobs().find(job=>job.id===source.jobId)!,call=f.modelCall(job)!;assert.equal(call.state,'failed');assert.equal(call.response?.received,true);assert.equal(call.response?.complete,false);assert.equal(call.response?.stopReason,'length');assert.equal(typeof call.response?.maxTokens,'number');assert.ok(call.response?.usage);assert.equal(f.memories().filter(record=>record.status==='active').length,0);
  assert.equal(job.attempts,0);assert.equal(job.nextAttemptAt,undefined);assert.deepEqual(job.pendingRanges,job.sourceRanges||job.sources);
  assert.equal(call.requestHash,learningRequestHash(f.modelIdentity,'off',4096,'extract',digest(f.calls[0].prompt)),'built host binds actual non-secret request parameters');
  const cursorStore=new RecordStore('memory',f.dataDir);try{assert.equal(cursorStore.get(`cursor:${source.projectId}:${source.sessionId}`),undefined);}finally{cursorStore.close();}
  const count=f.calls.length;assert.equal(count,1,'confirmed length stops the scheduler without a new operation');await host.stop();const restarted=await f.startHost();await restarted.request('resume');await delay(1000);assert.equal(f.calls.length,1,'received incomplete calls are not replayed on restart');assert.equal(f.jobs().find(job=>job.id===source.jobId)?.state,'failed');await restarted.stop();
 }finally{await f.close();}
});

test('learning host ignores expired foreground leases and yields to a live one',{timeout:45000},async()=>{
  const f=await fixture();try{
    // An expired v1 lease (the previous writer's shape) must not block admission.
    const stale=new RecordStore('runtime',f.dataDir);
    stale.put('foreground:stale',{pid:process.pid,active:true,runId:'stale',expiresAt:Date.now()-5000});
    stale.close();
    const source=await f.enqueue('lease-expired'),host=await f.startHost();
    await until(()=>f.jobs().find(job=>job.id===source.jobId)?.state==='completed','expired lease does not block extraction');
    assert.equal(f.calls.filter(call=>call.stage==='extract').length,1);

    // A live foreground lease pauses new background model calls.
    const live=new RecordStore('runtime',f.dataDir);
    writeForegroundLease(live,{pid:process.pid,sessionId:'live-foreground',runId:'live',active:true});
    assert.equal(foregroundBusy(live),true);
    live.close();
    const blocked=await f.enqueue('lease-live');
    await delay(1500);
    assert.equal(f.jobs().find(job=>job.id===blocked.jobId)?.state,'queued','live foreground lease pauses host admission');
    assert.equal(f.calls.filter(call=>call.stage==='extract').length,1,'no new model call while the foreground lease is live');

    // Releasing the lease lets the same host resume the queued durable job.
    const released=new RecordStore('runtime',f.dataDir);released.remove('foreground:live-foreground');released.close();
    await until(()=>f.jobs().find(job=>job.id===blocked.jobId)?.state==='completed','host resumes after lease release');
    assert.equal(f.calls.filter(call=>call.stage==='extract').length,2);
    await host.stop();
  }finally{await f.close();}
});
