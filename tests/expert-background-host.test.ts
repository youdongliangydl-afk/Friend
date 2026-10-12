import test from 'node:test';
import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {createServer,type ServerResponse} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {RecordStore,LearningBudget,digest,historyItems,projectIdentity,type HostPolicy,type HostEvalRequest,type HostEvalResult} from '../packages/core/src/index.js';
import type {ExpertLearningJob} from '../packages/expert/src/index.js';
import type {RegisteredEvaluationSuite} from '../apps/desktop/src/expert-evaluation-cases.js';
import {createProviderRuntime,saveProviderConfiguration} from '../apps/desktop/src/provider-settings.js';
import {testConfiguredModel} from '../apps/desktop/src/model-readiness.js';

interface IpcMessage {type:string;id?:string;error?:string;result?:unknown;event?:{type:string;data:Record<string,unknown>};data?:unknown}
interface ParentGrant {v:1;projectId:string;sessionId:string;expertEnabled:boolean;policy:HostPolicy}
interface HostOperation {request:HostEvalRequest;requestHash:string;state:string;result?:HostEvalResult;sessionId?:string;nativeFile?:string;providerOperationIds?:string[]}
interface FrozenSuite {sessionId:string;role:{role?:{id?:string};parent:{tools:string[];writeScopes:string[]}};registered:RegisteredEvaluationSuite}
interface HttpCall {operationId:string;request:HostEvalRequest;prompt:string;release():void}
const delay=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
async function until(predicate:()=>boolean,label:string,ms=12000){const end=Date.now()+ms;while(!predicate()){if(Date.now()>=end)throw new Error(`Timeout: ${label}`);await delay(25);}}

async function worker(name:'sdk-worker'|'learning-worker',dataDir:string,extra:Record<string,string>={}){
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('FRIEND_PI_'))delete env[key];
  const child:ChildProcess=fork(resolve(`apps/desktop/dist/${name}.mjs`),[],{execPath:process.execPath,cwd:resolve('.'),stdio:['ignore','pipe','pipe','ipc'],env:{...env,FRIEND_PI_ROOT:resolve('.'),FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_LEARNING_ROLE:name==='sdk-worker'?'producer':'host',FRIEND_PI_DESKTOP_MANAGED:'1',...extra}});
  const events:IpcMessage[]=[],pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();let stderr='';
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(done=>child.once('exit',(code,signal)=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(`${name} exited before RPC result: ${stderr}`));}pending.clear();done({code,signal});}));
  child.stderr?.on('data',chunk=>{stderr+=String(chunk);});
  child.on('message',(raw:IpcMessage)=>{events.push(raw);if(raw.type==='response'&&raw.id){const item=pending.get(raw.id);if(item){clearTimeout(item.timer);pending.delete(raw.id);raw.error?item.reject(new Error(raw.error)):item.resolve(raw.result);}}});
  try{
    await until(()=>events.some(event=>event.type==='ready'||event.type==='fatal')||child.exitCode!==null,`${name} ready`);
    if(!events.some(event=>event.type==='ready'))throw new Error(`${name} startup failed: ${JSON.stringify(events)}\n${stderr}`);
    const request=(method:string,input:Record<string,unknown>={})=>new Promise<unknown>((done,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${name}.${method}`));},15000);pending.set(id,{resolve:done,reject,timer});child.send({type:'request',id,method,input},error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});});
    const stop=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;await request('shutdown');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([exited,new Promise<never>((_done,reject)=>{timer=setTimeout(()=>reject(new Error(`${name} failed to exit`)),10000);})]);}finally{clearTimeout(timer);}};
    return {child,events,request,stop,exited};
  }catch(error){child.kill('SIGKILL');await exited;throw error;}
}

function sendSse(res:ServerResponse,output:string,id:string){
  if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const choice of [{delta:{role:'assistant',content:output},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:24,completion_tokens:8,total_tokens:32}})}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** Real built entry points and public IPC; the HTTP oracle is deliberately test-only. */
async function fixture(options:{holdFirst?:boolean;role?:'implementer'|'researcher'}={}){
  const directory=mkdtempSync(join(tmpdir(),'friend-expert-background-')),projectDir=join(directory,'project'),dataDir=join(directory,'state');mkdirSync(projectDir);
  const projectId=projectIdentity(projectDir),calls:HttpCall[]=[],children:Awaited<ReturnType<typeof worker>>[]=[],serverErrors:unknown[]=[];
  function read<T>(namespace:string,key:string){const store=new RecordStore(namespace,dataDir);try{return store.get<T>(key)?.value;}finally{store.close();}}
  function list<T>(namespace:string,prefix:string){const store=new RecordStore(namespace,dataDir);try{return store.list<T>(prefix).map(row=>row.value);}finally{store.close();}}
  const operations=()=>list<HostOperation>('expert-evaluation-host',`operation:${projectId}:`);
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=String(chunk);const body=JSON.parse(raw) as {messages:{role:string;content:unknown}[]};
      const last=body.messages.findLast(message=>message.role==='user')?.content,prompt=typeof last==='string'?last:Array.isArray(last)?last.map(part=>part&&typeof part==='object'&&'text' in part?String(part.text):'').join('\n'):String(last);
      if(prompt==='Reply only OK.'){sendSse(res,'OK','readiness');return;}
      if(prompt.startsWith('BACKGROUND_HOST_SOURCE_')){sendSse(res,JSON.stringify({summary:'只读来源已记录',evidence:[],...(options.role==='researcher'?{risks:[]}:{checks:[]})}),'foreground');return;}
      // Only this local test server reads persisted private expected answers. Production
      // code freezes the random suite and gives the public SDK its task/materials only.
      const running=operations().filter(operation=>operation.state==='running'&&!operation.result),operation=running.find(operation=>{const suite=read<FrozenSuite>('expert-evaluation-host',`suite:${projectId}:${operation.request.suiteId}`);return suite?.registered[operation.request.phase].some(example=>example.id===operation.request.caseId&&prompt.startsWith(example.prompt));});
      assert.ok(operation,`HTTP request belongs to a real running isolated SDK evaluation: ${prompt.slice(0,160)}`);
      const suite=read<FrozenSuite>('expert-evaluation-host',`suite:${projectId}:${operation.request.suiteId}`)!;
      const example=suite.registered[operation.request.phase].find(example=>example.id===operation.request.caseId)!;
      const check=example.checks[0],output=JSON.stringify(check.kind==='code-exact'?{code:check.expected}:check.expected);
      let sent=false;const call:HttpCall={operationId:operation.request.operationId,request:operation.request,prompt,release:()=>{if(sent||res.destroyed)return;sent=true;sendSse(res,output,operation.request.operationId);}};
      calls.push(call);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();if(!(options.holdFirst&&calls.length===1))call.release();
    }catch(error){serverErrors.push(error);if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'test-only evaluation oracle failed'}}));}
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');
  const runtime=await createProviderRuntime(dataDir),modelId='expert-background-loopback/fixture';
  try{
    await saveProviderConfiguration(runtime,dataDir,{provider:'expert-background-loopback',modelId:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'test-only-loopback-credential'});
    await testConfiguredModel(runtime,dataDir,modelId);
    const foreground=await worker('sdk-worker',dataDir,{FRIEND_PI_PROJECT:projectDir,FRIEND_PI_MODEL:modelId,FRIEND_PI_PLUGINS:JSON.stringify(['expert'])});children.push(foreground);
    const plugin=(action:string,input:Record<string,unknown>={})=>foreground.request('plugin',{plugin:'expert',action,input});
    await plugin('role.assign',{id:options.role||'implementer'});
    await foreground.request('send',{text:'BACKGROUND_HOST_SOURCE_'+randomUUID()});
    await until(()=>foreground.events.some(event=>event.event?.type==='pi'&&event.event.data.type==='agent_settled'),'foreground settled');
    const state=await foreground.request('state') as {sessionId:string;sessionFile:string};
    const source=historyItems(SessionManager.open(state.sessionFile).getBranch()).findLast(item=>item.role==='user')!;assert.ok(source);
    const applicability='authorized code changes',submitted=await plugin('candidate.submit',{key:'background-candidate',skillBody:{title:'Bounded background code method',scenario:'code-development',applicability,body:'Use the registered materials, preserve the exact requested function contract, and return only the declared JSON.'},evidence:[{kind:'pi',projectId,source:{sessionId:state.sessionId,entryId:source.id,start:0,end:source.text.length,hash:digest(source.text)}}]}) as {id:string;revision:number};
    const configured=await plugin('trial.configure',{id:submitted.id,expectedRevision:submitted.revision,scope:{projectId,applicability},limits:{maxTasks:3},key:'background-trial'}) as {evaluation:{state:string;jobId?:string;reason?:string}};
    assert.equal(configured.evaluation.state,'queued',configured.evaluation.reason);assert.ok(configured.evaluation.jobId);
    const jobId=configured.evaluation.jobId,grantKey=`expert-parent:${state.sessionId}`,grant=read<ParentGrant>('runtime',grantKey)!;assert.ok(grant,'actual SDK worker persists the trusted parent grant');assert.equal(grant.projectId,projectId);assert.equal(grant.sessionId,state.sessionId);assert.equal(grant.expertEnabled,true);assert.equal(grant.policy.executionMode,'single');
    const job=()=>read<ExpertLearningJob>('expert',`job:${jobId}`)!;
    const manifest=read<{hostSuite:{suiteId:string};tools:string[]}>('expert',`evaluation.manifest:${job().manifestHash}`)!;
    const frozen=read<FrozenSuite>('expert-evaluation-host',`suite:${projectId}:${manifest.hostSuite.suiteId}`)!;
    assert.equal(frozen.sessionId,state.sessionId);assert.equal(frozen.role.role?.id,options.role||'implementer');assert.deepEqual(frozen.role.parent.tools,grant.policy.tools);assert.deepEqual(frozen.role.parent.writeScopes,grant.policy.writeScopes);
    await foreground.stop();assert.equal((await foreground.exited).code,0);
    const sourceHistory=readFileSync(state.sessionFile,'utf8');
    const startHost=async()=>{const host=await worker('learning-worker',dataDir);children.push(host);return host;};
    const ledger=()=>{const store=new RecordStore('runtime',dataDir);try{return new LearningBudget(store).read(job().budgetId);}finally{store.close();}};
    const providerReceipts=()=>{const store=new RecordStore('runtime',dataDir);try{return store.list(`learning-call:${job().budgetId}:`).map(row=>({key:row.key,value:row.value}));}finally{store.close();}};
    const close=async()=>{for(const call of calls)call.release();for(const child of children)if(child.child.exitCode===null&&child.child.signalCode===null)await child.stop().catch(async()=>{child.child.kill('SIGKILL');await child.exited;});server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(directory,{recursive:true,force:true});};
    return {directory,dataDir,projectId,sessionId:state.sessionId,sessionFile:state.sessionFile,sourceHistory,candidateId:submitted.id,grantKey,grant,job,jobId,manifest,calls,operations,read,list,ledger,providerReceipts,startHost,serverErrors,foreground,close};
  }catch(error){for(const child of children)await child.stop().catch(()=>child.child.kill('SIGKILL'));server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(directory,{recursive:true,force:true});throw error;}
}

test('SDK parent grant survives foreground exit and independently runs all 36 public SDK tasks without fabricated promotion',{timeout:90000},async()=>{
  const f=await fixture();try{
    const host=await f.startHost();assert.notEqual(host.child.pid,f.foreground.child.pid);
    await until(()=>f.job().state==='waiting_evidence'||f.job().state==='failed','36 SDK tasks settled',60000).catch(error=>{throw new Error(`${String(error)}\nJob: ${JSON.stringify(f.job())}\nNotices: ${JSON.stringify(host.events.filter(event=>event.type==='notice'))}\nOracle: ${String(f.serverErrors[0]||'none')}`);});
    const job=f.job(),operations=f.operations();assert.equal(job.state,'waiting_evidence',job.error);assert.match(job.error||'',/门槛|增益/);assert.equal(f.calls.length,36);assert.equal(new Set(f.calls.map(call=>call.operationId)).size,36);assert.equal(operations.length,36);
    assert.ok(operations.every(operation=>operation.result?.status==='completed'&&operation.result.usage.providerRequests===1&&operation.result.checks.every(check=>check.passed)));
    assert.equal(new Set(operations.map(operation=>operation.sessionId)).size,36);assert.ok(operations.every(operation=>operation.sessionId!==f.sessionId&&operation.nativeFile&&readFileSync(operation.nativeFile,'utf8').includes('friend-pi.expert.evaluation.checked.v1')));
    assert.ok(f.calls.every(call=>call.request.budgetId===job.budgetId&&call.request.sourceRunId===job.sourceRunId&&call.request.modelId===job.modelId&&call.request.thinkingLevel===job.thinkingLevel));
    assert.equal(job.sessionId,f.sessionId);assert.deepEqual(f.ledger(),{budgetId:job.budgetId,projectId:f.projectId,sourceRunId:job.sourceRunId,maxCalls:64,calls:36,tokens:36*32,usageUnknown:false});
    const phases=f.list<{complete:boolean;known:boolean;strictImprovement:boolean;tokenGain:boolean}>('expert',`evaluation.phase:${job.id}:`);assert.equal(phases.length,2);assert.ok(phases.every(phase=>phase.complete&&phase.known&&!phase.strictImprovement&&!phase.tokenGain));
    assert.equal(f.read<{status:string}>('expert',`skill.head:${f.projectId}:${f.candidateId}`)?.status,'trial');assert.equal(f.read('expert',`evaluation:${job.id}`),undefined);assert.equal(readFileSync(f.sessionFile,'utf8'),f.sourceHistory);assert.deepEqual(f.serverErrors,[]);
    const ledger=f.ledger(),receipts=f.providerReceipts();await host.stop();const restarted=await f.startHost();await delay(1200);assert.equal(f.calls.length,36);assert.deepEqual(f.ledger(),ledger);assert.deepEqual(f.providerReceipts(),receipts);assert.equal(f.job().budgetId,job.budgetId);await restarted.stop();
  }finally{await f.close();}
});

test('a source researcher automatically freezes only permitted read tools and reaches an independent SDK task',{timeout:30000},async()=>{
  const f=await fixture({holdFirst:true,role:'researcher'});try{
    assert.deepEqual(f.manifest.tools,['read']);const host=await f.startHost();await until(()=>f.calls.length===1,'read-only role SDK request');
    assert.deepEqual(f.calls[0].request.tools,['read']);const store=new RecordStore('runtime',f.dataDir);try{store.remove(f.grantKey);}finally{store.close();}f.calls[0].release();
    await until(()=>f.job().state==='waiting_configuration','revoked read-only grant settled');assert.equal(f.calls.length,1);assert.deepEqual(f.serverErrors,[]);await host.stop();
  }finally{await f.close();}
});

test('grant removal, Expert disablement and narrower parent permission prevent new SDK requests and retain cold ledger',{timeout:90000},async t=>{
  for(const invalidation of ['removed','expert-disabled','permission-narrowed'] as const)await t.test(invalidation,async()=>{
    const f=await fixture({holdFirst:true});try{
      const host=await f.startHost();await until(()=>f.calls.length===1,'first SDK request dispatched');
      const store=new RecordStore('runtime',f.dataDir);try{const saved=store.get<ParentGrant>(f.grantKey)!;if(invalidation==='removed')store.remove(f.grantKey);else store.put(f.grantKey,invalidation==='expert-disabled'?{...saved.value,expertEnabled:false}:{...saved.value,policy:{...saved.value.policy,writeScopes:[],planMode:true}},saved.revision);}finally{store.close();}
      f.calls[0].release();await until(()=>f.job().state==='waiting_configuration','invalidation preserves completed provider receipt');
      assert.equal(f.calls.length,1);assert.equal(f.ledger().calls,1);assert.equal(f.ledger().usageUnknown,false);assert.equal(f.operations()[0].result?.checks.length,0);assert.equal(f.operations()[0].result?.status,'waiting');
      const ledger=f.ledger(),receipts=f.providerReceipts(),operation=f.operations()[0];await host.request('refresh');await delay(1000);assert.equal(f.calls.length,1);await host.stop();
      const restarted=await f.startHost();await restarted.request('refresh');await delay(1000);assert.equal(f.calls.length,1);assert.deepEqual(f.ledger(),ledger);assert.deepEqual(f.providerReceipts(),receipts);assert.deepEqual(f.operations()[0],operation);assert.equal(f.read<{status:string}>('expert',`skill.head:${f.projectId}:${f.candidateId}`)?.status,'trial');assert.deepEqual(f.serverErrors,[]);await restarted.stop();
    }finally{await f.close();}
  });
});
