import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRegistry,ModelRuntime,SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {Provider,ProviderHeaders} from '@earendil-works/pi-ai';
import {LearningBudget,RecordStore,digest,executeLearningRequest,learningRequestHash,learningRequestSnapshot,makeContext} from '../src/index.js';

const providerId='effective-config-loopback',prompt='Read the isolated fixture source.',stage='extract';
type Configuration={providerHeaders?:Record<string,string>;modelHeaders?:Record<string,string>};
type Request={path:string;beta:string|undefined};

/** Real locked SDK configuration/auth resolution and HTTP; credentials are test literals. */
async function fixture(initial:Configuration={}){
  const dir=mkdtempSync(join(tmpdir(),'learning-effective-config-')),modelsPath=join(dir,'models.json'),authPath=join(dir,'auth.json'),requests:Request[]=[];
  const previous=new Map(['FRIEND_PI_DATA_DIR','FRIEND_PI_AGENT_DIR','FRIEND_PI_DESKTOP_MANAGED'].map(key=>[key,process.env[key]]));
  const server=createServer(async(req,res)=>{
    for await(const _chunk of req){/* Drain the actual SDK request without retaining credentials or its body. */}
    requests.push({path:req.url||'',beta:typeof req.headers['anthropic-beta']==='string'?req.headers['anthropic-beta']:undefined});
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const choice of [{delta:{role:'assistant',content:'Isolated loopback response.'},finish_reason:null},{delta:{},finish_reason:'stop'}]){
      res.write(`data: ${JSON.stringify({id:'completion-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);
    }
    res.write(`data: ${JSON.stringify({id:'completion-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address&&typeof address==='object');const baseUrl=`http://127.0.0.1:${address.port}`;
  function writeConfiguration(value:Configuration){writeFileSync(modelsPath,JSON.stringify({providers:{[providerId]:{baseUrl:baseUrl+'/v1',api:'openai-completions',headers:value.providerHeaders,models:[{id:'fixture',name:'Isolated fixture',reasoning:false,input:['text'],contextWindow:8192,maxTokens:1024,headers:value.modelHeaders}]}}}),{mode:0o600});}
  function writeCredential(key:string){writeFileSync(authPath,JSON.stringify({[providerId]:{type:'api_key',key}}),{mode:0o600});}
  writeConfiguration(initial);writeCredential('test-only-original-key');
  const runtime=await ModelRuntime.create({authPath,modelsPath,allowModelNetwork:false}),registry=new ModelRegistry(runtime),store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);
  process.env.FRIEND_PI_DATA_DIR=dir;process.env.FRIEND_PI_AGENT_DIR=dir;delete process.env.FRIEND_PI_DESKTOP_MANAGED;
  const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
  const native:ExtensionContext={cwd:dir,model:registry.find(providerId,'fixture'),sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:registry} as unknown as ExtensionContext;
  const hash=(identity:unknown)=>learningRequestHash(identity,'off',128,stage,digest(prompt));
  async function refresh(value:Configuration){writeConfiguration(value);await registry.refresh({allowNetwork:false});native.model=registry.find(providerId,'fixture');}
  async function snapshot(){assert.ok(native.model);const resolved=await registry.getApiKeyAndHeaders(native.model);assert.equal(resolved.ok,true);if(!resolved.ok)throw Error('Fixture auth resolution failed');return learningRequestSnapshot(native.model,resolved);}
  function budget(operationId='same-operation'){const record=budgets.create({projectId:'p',sourceRunId:'run',maxCalls:4});return {budgetId:record.budgetId,operationId,stage,maxTokens:128};}
  async function complete(options:ReturnType<typeof budget>){return makeContext(pi,native).complete(prompt,options);}
  async function endpointProvider(){
    const base=runtime.getProvider(providerId)!;assert.ok(base);const catalog=registry.find(providerId,'fixture')!;let endpoint=baseUrl+'/endpoint-a',resolutions=0;
    const id='effective-auth-endpoint',model={...catalog,provider:id},provider:Provider={id,name:'Isolated auth endpoint',baseUrl:catalog.baseUrl,auth:{apiKey:{name:'Fixture credential',check:async()=>({type:'api_key',source:'fixture'}),resolve:async({credential})=>{resolutions++;return {auth:{apiKey:credential?.key||'test-only-endpoint-key',baseUrl:endpoint},source:'fixture'};}}},getModels:()=>[model],stream:(...args)=>base.stream(...args),streamSimple:(...args)=>base.streamSimple(...args)};
    runtime.registerNativeProvider(provider);await runtime.setRuntimeApiKey(id,'test-only-endpoint-key');await runtime.refresh({allowNetwork:false,providers:[id]});native.model=registry.find(id,'fixture');assert.ok(native.model);
    return {change:()=>{endpoint=baseUrl+'/endpoint-b';},model,get resolutions(){return resolutions;}};
  }
  async function envProvider(){
    const base=runtime.getProvider(providerId)!,id='effective-env-selector',model={...registry.find(providerId,'fixture')!,provider:id};
    let env={AZURE_OPENAI_BASE_URL:baseUrl+'/env-a',AWS_SECRET_ACCESS_KEY:'test-only-secret-a',AWS_SHARED_CREDENTIALS_FILE:'/test-only/credentials-a'};
    const provider:Provider={id,name:'Isolated environment selector',baseUrl:model.baseUrl,auth:{apiKey:{name:'Fixture credential',check:async()=>({type:'api_key',source:'fixture'}),resolve:async({credential})=>({auth:{apiKey:credential?.key||'test-only-env-key'},env,source:'fixture'})}},getModels:()=>[model],stream:(current,context,options)=>base.stream({...current,baseUrl:options?.env?.AZURE_OPENAI_BASE_URL||current.baseUrl},context,options),streamSimple:(current,context,options)=>base.streamSimple({...current,baseUrl:options?.env?.AZURE_OPENAI_BASE_URL||current.baseUrl},context,options)};
    runtime.registerNativeProvider(provider);await runtime.setRuntimeApiKey(id,'test-only-env-key');await runtime.refresh({allowNetwork:false,providers:[id]});native.model=registry.find(id,'fixture');assert.ok(native.model);
    return {changeSecrets:()=>{env={...env,AWS_SECRET_ACCESS_KEY:'test-only-secret-b',AWS_SHARED_CREDENTIALS_FILE:'/test-only/credentials-b'};},changeRoute:()=>{env={...env,AZURE_OPENAI_BASE_URL:baseUrl+'/env-b'};}};
  }
  async function close(){store.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));for(const [key,value] of previous)value===undefined?delete process.env[key]:process.env[key]=value;rmSync(dir,{recursive:true,force:true});}
  return {dir,authPath,runtime,registry,native,requests,budgets,store,hash,refresh,snapshot,budget,complete,writeCredential,endpointProvider,envProvider,close};
}

for(const source of ['provider','model'] as const)test(`native completion binds SDK-resolved ${source} beta despite model.headers being absent`,async()=>{
  const configuration=(value:string):Configuration=>source==='provider'?{providerHeaders:{'Anthropic-Beta':value}}:{providerHeaders:{'Anthropic-Beta':'provider-default'},modelHeaders:{'anthropic-beta':value}};
  const f=await fixture(configuration('feature-a'));try{
    assert.equal(f.native.model!.headers,undefined);
    const resolved=await f.registry.getApiKeyAndHeaders(f.native.model!);assert.equal(resolved.ok,true);assert.ok(resolved.ok&&Object.keys(resolved.headers||{}).some(key=>key.toLowerCase()==='anthropic-beta'));
    const first=await f.snapshot(),options=f.budget();assert.deepEqual(first.identityModel.headers,{'anthropic-beta':'feature-a'});
    assert.equal(await f.complete(options),'Isolated loopback response.');assert.equal(f.requests.length,1);assert.equal(f.requests[0].beta,'feature-a');
    await f.refresh(configuration('feature-b'));assert.equal(f.native.model!.headers,undefined);assert.notEqual(f.hash((await f.snapshot()).identityModel),f.hash(first.identityModel));
    await assert.rejects(f.complete(options),{code:'VERSION_CONFLICT'});assert.equal(f.requests.length,1);assert.equal(f.budgets.read(options.budgetId).calls,1);assert.equal(f.budgets.readCall(options.budgetId,options.operationId)!.requestHash,f.hash(first.identityModel));
  }finally{await f.close();}
});

test('credential and authorization-only changes retain the actual native cached result and never enter the durable request identity',async()=>{
  const f=await fixture({providerHeaders:{'anthropic-beta':'feature-a',Authorization:'Bearer test-only-header-a'}});try{
    const options=f.budget(),before=await f.snapshot();assert.equal(await f.complete(options),'Isolated loopback response.');
    f.writeCredential('test-only-rotated-key');await f.refresh({providerHeaders:{'anthropic-beta':'feature-a',Authorization:'Bearer test-only-header-b'}});
    const after=await f.snapshot();assert.equal(f.hash(before.identityModel),f.hash(after.identityModel));assert.notEqual(before.requestOptions.apiKey,after.requestOptions.apiKey);
    assert.equal(await f.complete(options),'Isolated loopback response.');assert.equal(f.requests.length,1);assert.equal(f.budgets.read(options.budgetId).calls,1);
    assert.doesNotMatch(JSON.stringify(f.store.list('learning-call:')),/test-only-|Authorization|Bearer/);assert.ok(readFileSync(f.authPath,'utf8').includes('test-only-rotated-key'));
  }finally{await f.close();}
});

test('native request identity uses the public auth-resolved endpoint instead of the unchanged catalog endpoint',async()=>{
  const f=await fixture();try{
    const endpoint=await f.endpointProvider(),catalogUrl=f.native.model!.baseUrl,before=await f.snapshot(),options=f.budget();assert.notEqual(before.model.baseUrl,catalogUrl);
    assert.equal(await f.complete(options),'Isolated loopback response.');assert.equal(f.requests[0].path,'/endpoint-a/chat/completions');
    endpoint.change();assert.equal(f.native.model!.baseUrl,catalogUrl);const after=await f.snapshot();assert.notEqual(f.hash(before.identityModel),f.hash(after.identityModel));
    await assert.rejects(f.complete(options),{code:'VERSION_CONFLICT'});assert.equal(f.requests.length,1);assert.equal(f.budgets.read(options.budgetId).calls,1);
  }finally{await f.close();}
});

test('snapshot follows SDK case-insensitive last beta value, explicit null, and clones ephemeral auth options',()=>{
  const model={provider:'fixture',id:'model',baseUrl:'http://127.0.0.1/model',headers:{'anthropic-beta':'model-feature'}},resolved={apiKey:'test-only-key',baseUrl:'http://127.0.0.1/effective',headers:{'ANTHROPIC-BETA':'earlier-feature','aNtHrOpIc-BeTa':null,'X-Fixture':'before'} as ProviderHeaders,env:{REGION:'before'}};
  const snapshot=learningRequestSnapshot(model,resolved);assert.deepEqual(snapshot.identityModel.headers,{'anthropic-beta':null});assert.equal(snapshot.model.baseUrl,resolved.baseUrl);
  resolved.headers['aNtHrOpIc-BeTa']='changed-feature';resolved.headers['X-Fixture']='after';resolved.env.REGION='after';model.baseUrl='http://127.0.0.1/changed';
  assert.equal(snapshot.requestOptions.apiKey,'test-only-key');assert.equal(snapshot.requestOptions.headers!['X-Fixture'],'before');assert.equal(snapshot.requestOptions.env!.REGION,'before');assert.equal(snapshot.model.baseUrl,'http://127.0.0.1/effective');
  assert.deepEqual(snapshot.requestOptions.headers,{'X-Fixture':'before','anthropic-beta':null});
  const omitted=learningRequestSnapshot(model,{headers:{}});assert.deepEqual(omitted.identityModel.headers,{'anthropic-beta':'model-feature'});
  assert.notEqual(learningRequestHash(snapshot.identityModel,'off',128,stage,digest(prompt)),learningRequestHash(omitted.identityModel,'off',128,stage,digest(prompt)));
});

test('an already resolved snapshot freezes the actual HTTP beta across later SDK configuration refresh',async()=>{
  const f=await fixture({providerHeaders:{'Anthropic-Beta':'feature-before'}});try{
    const snapshot=await f.snapshot(),hash=f.hash(snapshot.identityModel),provider=f.runtime.getProvider(providerId)!;await f.refresh({providerHeaders:{'ANTHROPIC-BETA':'feature-after'}});
    const result=await executeLearningRequest(provider,snapshot,{messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:1}]},{maxTokens:128,headers:{'anthropic-beta':'late-option-override'}});
    assert.equal(result.stopReason,'stop');assert.equal(f.requests.length,1);assert.equal(f.requests[0].beta,'feature-before');assert.equal(f.hash(snapshot.identityModel),hash);assert.notEqual(f.hash((await f.snapshot()).identityModel),hash);
  }finally{await f.close();}
});

test('an already resolved snapshot dispatches to its frozen endpoint without a second SDK auth resolution',async()=>{
  const f=await fixture();try{
    const endpoint=await f.endpointProvider(),snapshot=await f.snapshot(),provider=f.runtime.getProvider(snapshot.model.provider)!,resolutions=endpoint.resolutions;endpoint.change();
    const result=await executeLearningRequest(provider,snapshot,{messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:1}]},{maxTokens:128});
    assert.equal(result.stopReason,'stop');assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/endpoint-a/chat/completions');assert.equal(endpoint.resolutions,resolutions,'dispatch must not resolve the changed endpoint again');
  }finally{await f.close();}
});

test('public native auth environment routing binds the operation while secret-only environment changes reuse its one HTTP result',async()=>{
  const f=await fixture();try{
    const provider=await f.envProvider(),before=await f.snapshot(),options=f.budget(),resolved=await f.registry.getApiKeyAndHeaders(f.native.model!);assert.ok(resolved.ok&&resolved.env?.AZURE_OPENAI_BASE_URL);
    assert.equal(await f.complete(options),'Isolated loopback response.');assert.equal(f.requests[0].path,'/env-a/chat/completions');
    provider.changeSecrets();const secretsChanged=await f.snapshot();assert.equal(f.hash(secretsChanged.identityModel),f.hash(before.identityModel));assert.notEqual(secretsChanged.requestOptions.env.AWS_SECRET_ACCESS_KEY,before.requestOptions.env.AWS_SECRET_ACCESS_KEY);
    assert.equal(await f.complete(options),'Isolated loopback response.');assert.equal(f.requests.length,1);
    provider.changeRoute();const routeChanged=await f.snapshot();assert.notEqual(f.hash(routeChanged.identityModel),f.hash(before.identityModel));await assert.rejects(f.complete(options),{code:'VERSION_CONFLICT'});
    assert.equal(f.requests.length,1);assert.equal(f.budgets.read(options.budgetId).calls,1);assert.doesNotMatch(JSON.stringify(f.store.list('learning-call:')),/test-only-|credentials-|AWS_SECRET_ACCESS_KEY|AWS_SHARED_CREDENTIALS_FILE|AZURE_OPENAI_BASE_URL/);
  }finally{await f.close();}
});

test('all declared non-secret SDK routing selectors affect identity with scoped fallback and secrets excluded',()=>{
  const names=['AZURE_OPENAI_DEPLOYMENT_NAME_MAP','AZURE_OPENAI_BASE_URL','AZURE_OPENAI_RESOURCE_NAME','AZURE_OPENAI_API_VERSION','AWS_REGION','AWS_DEFAULT_REGION','AWS_PROFILE','AWS_BEDROCK_SKIP_AUTH','AWS_BEDROCK_FORCE_HTTP1','AWS_BEDROCK_FORCE_CACHE','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_GATEWAY_ID','ANTHROPIC_FEDERATION_RULE_ID','ANTHROPIC_ORGANIZATION_ID','ANTHROPIC_WORKSPACE_ID','ANTHROPIC_SERVICE_ACCOUNT_ID','PI_CACHE_RETENTION'];
  const previous=new Map(names.map(name=>[name,process.env[name]])),model={provider:'fixture',id:'model',baseUrl:'http://127.0.0.1/model'},hash=(identity:unknown)=>learningRequestHash(identity,'off',128,stage,digest(prompt)),routing=(snapshot:{identityModel:{requestRouting:object}})=>snapshot.identityModel.requestRouting as Record<string,string|boolean>;
  try{
    for(const name of names)delete process.env[name];
    for(const name of names){
      const first=learningRequestSnapshot(model,{env:{[name]:'route-a'}}),second=learningRequestSnapshot(model,{env:{[name]:'route-b'}});
      assert.notEqual(hash(first.identityModel),hash(second.identityModel),name);assert.equal(first.requestOptions.env[name],'route-a');assert.equal(second.requestOptions.env[name],'route-b');
      assert.deepEqual(first.identityModel.requestRouting,{[name]:'route-a',ambientAwsProfile:false});
    }
    process.env.AZURE_OPENAI_BASE_URL='http://127.0.0.1/ambient-a';
    const fallback=learningRequestSnapshot(model,{env:{AZURE_OPENAI_BASE_URL:''}});assert.equal(routing(fallback).AZURE_OPENAI_BASE_URL,process.env.AZURE_OPENAI_BASE_URL);assert.equal(fallback.requestOptions.env.AZURE_OPENAI_BASE_URL,process.env.AZURE_OPENAI_BASE_URL);
    process.env.AZURE_OPENAI_BASE_URL='http://127.0.0.1/ambient-b';assert.equal(fallback.requestOptions.env.AZURE_OPENAI_BASE_URL,'http://127.0.0.1/ambient-a');assert.notEqual(hash(fallback.identityModel),hash(learningRequestSnapshot(model,{env:{AZURE_OPENAI_BASE_URL:''}}).identityModel));
    const scoped=learningRequestSnapshot(model,{env:{AZURE_OPENAI_BASE_URL:'http://127.0.0.1/scoped'}});assert.equal(scoped.requestOptions.env.AZURE_OPENAI_BASE_URL,'http://127.0.0.1/scoped');assert.equal(routing(scoped).AZURE_OPENAI_BASE_URL,'http://127.0.0.1/scoped');
    const profileAbsent=learningRequestSnapshot(model,{env:{AWS_PROFILE:'scoped-profile'}});process.env.AWS_PROFILE='ambient-profile';const profilePresent=learningRequestSnapshot(model,{env:{AWS_PROFILE:'scoped-profile'}});assert.equal(routing(profileAbsent).AWS_PROFILE,routing(profilePresent).AWS_PROFILE);assert.equal(profileAbsent.identityModel.requestRouting.ambientAwsProfile,false);assert.equal(profilePresent.identityModel.requestRouting.ambientAwsProfile,true);assert.notEqual(hash(profileAbsent.identityModel),hash(profilePresent.identityModel));
    const secrets={AWS_ACCESS_KEY_ID:'test-only-access-key',AWS_SECRET_ACCESS_KEY:'test-only-secret-key',AWS_SESSION_TOKEN:'test-only-session-token',AWS_SHARED_CREDENTIALS_FILE:'/test-only/credentials',AWS_CONFIG_FILE:'/test-only/config',GOOGLE_APPLICATION_CREDENTIALS:'/test-only/google-credentials',API_KEY:'test-only-api-key',AUTHORIZATION:'test-only-authorization',OTHER_TOKEN:'test-only-token'};
    const before=learningRequestSnapshot(model,{apiKey:'test-only-auth-a',headers:{Authorization:'test-only-header-a'},env:secrets}),after=learningRequestSnapshot(model,{apiKey:'test-only-auth-b',headers:{Authorization:'test-only-header-b'},env:Object.fromEntries(Object.entries(secrets).map(([key,value])=>[key,value+'-changed']))});
    assert.equal(hash(before.identityModel),hash(after.identityModel));assert.doesNotMatch(JSON.stringify(before.identityModel),/test-only-|credentials|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|API_KEY|AUTHORIZATION|OTHER_TOKEN/);
    for(const [key,value] of Object.entries(secrets))assert.equal(before.requestOptions.env[key],value,'authentication configuration remains ephemeral');
  }finally{for(const [name,value] of previous)value===undefined?delete process.env[name]:process.env[name]=value;}
});
