import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSessionRuntime,createAgentSessionServices,createAgentSessionFromServices,createEventBus,
  initTheme,ModelRuntime,SessionManager,SettingsManager,type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import swarmExtension,{SwarmController,type Graph} from '../src/index.js';
import expertExtension from '../../expert/src/index.js';
import memoryExtension from '../../memory/src/index.js';
import rebuildExtension,{type WorkingField} from '../../topic-rebuild/src/index.js';
import {installFixtureProvider,requestPlugin,RecordStore,type JsonObject,type PluginContext} from '@friend-pi/core';

test('real Pi Runtime new/resume/fork recreates all four extensions and preserves native tool/event authority',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-native-lifecycle-'));const priorDataDir=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=join(dir,'state');
  const bus=createEventBus();const errors:string[]=[];let runtime:Awaited<ReturnType<typeof createAgentSessionRuntime>>|undefined;let factories=0;
  try {
    initTheme('light',false);const models=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});const model=await installFixtureProvider(models);
    const factory:CreateAgentSessionRuntimeFactory=async options=>{
      factories++;const settings=SettingsManager.inMemory({extensions:[],packages:[],defaultTools:['read','write'],compaction:{enabled:false}});
      const services=await createAgentSessionServices({cwd:options.cwd,agentDir:options.agentDir,modelRuntime:models,settingsManager:settings,resourceLoaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[swarmExtension,expertExtension,memoryExtension,rebuildExtension]},resourceLoaderReloadOptions:{resolveProjectTrust:async()=>true}});
      const result=await createAgentSessionFromServices({services,sessionManager:options.sessionManager,sessionStartEvent:options.sessionStartEvent,model,thinkingLevel:'off',tools:['read','write','friend_swarm','friend_expert','friend_memory','friend_topic_rebuild']});
      assert.deepEqual(result.extensionsResult.errors,[]);return {...result,services,diagnostics:services.diagnostics};
    };
    runtime=await createAgentSessionRuntime(factory,{cwd:dir,agentDir:join(dir,'agent'),sessionManager:SessionManager.create(dir,join(dir,'sessions'))});
    const bind=async()=>{await runtime!.session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});};await bind();runtime.setRebindSession(async()=>bind());
    await requestPlugin(bus,'memory','learning.pause',{},1000,'user');await requestPlugin(bus,'expert','settings',{paused:true},1000,'user');
    await runtime.session.prompt('必须保留原项目文件。请分析数据库事务。');const originalSession=runtime.session.sessionId;const originalFile=runtime.session.sessionFile!;
    const originalField=(await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {field:WorkingField}).field;assert.equal(originalField.sessionId,originalSession);
    const graph=await requestPlugin(bus,'swarm','create',{goal:'old graph',tasks:[{id:'read',title:'read',prompt:'read source',mode:'read',dependencies:[]}]},1000,'user') as Graph;
    const memory=await requestPlugin(bus,'memory','save',{content:'SQLite transactions preserve user files',explicitRemember:true},1000,'user') as {id:string;revision:number};
    const candidate=await requestPlugin(bus,'expert','candidate.submit',{title:'old candidate',method:'Keep source evidence',sourceMemoryIds:[memory.id]},1000,'user') as {id:string};
    await runtime.newSession();assert.notEqual(runtime.session.sessionId,originalSession);assert.equal(factories,2);
    assert.equal((await requestPlugin(bus,'swarm','snapshot',{},1000,'user') as {graphs:Graph[]}).graphs.length,0);
    assert.equal((await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {field?:WorkingField}).field,undefined);
    await runtime.session.prompt('QA_WRITE 必须保留当前项目文件，并检查当前会话。');assert.match(readFileSync(join(dir,'fixture-result.txt'),'utf8'),/SDK tool execution verified/);
    const newField=(await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {field:WorkingField}).field;assert.equal(newField.sessionId,runtime.session.sessionId);assert.notEqual(newField.operationId,originalField.operationId);
    await requestPlugin(bus,'memory','forget',{id:memory.id,revision:memory.revision},1000,'user');
    assert.equal((await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {invalidated:boolean}).invalidated,true);
    const withdrawn=(await requestPlugin(bus,'expert','snapshot',{},1000,'user') as {candidates:{id:string;status:string}[]}).candidates.find(item=>item.id===candidate.id)!;assert.equal(withdrawn.status,'withdrawn','memory bus listeners must remain attached after /new');
    const forkAt=runtime.session.sessionManager.getEntries().find(entry=>entry.type==='message'&&entry.message.role==='user')!.id;const priorSession=runtime.session.sessionId;
    await runtime.fork(forkAt,{position:'at'});assert.notEqual(runtime.session.sessionId,priorSession);assert.equal(factories,3);await runtime.session.prompt('继续 fork 后的工作，必须保留文件。');
    assert.equal((await requestPlugin(bus,'swarm','snapshot',{},1000,'user') as {graphs:Graph[]}).graphs.length,0);
    await runtime.switchSession(originalFile);assert.equal(runtime.session.sessionId,originalSession);assert.equal(factories,4);
    const returned=(await requestPlugin(bus,'swarm','snapshot',{},1000,'user') as {graphs:Graph[]}).graphs;assert.equal(returned[0].id,graph.id);assert.equal(returned[0].status,'created');
    const tools=runtime.session.getAllTools();assert.ok(tools.some(tool=>tool.name==='friend_expert'));assert.ok(tools.some(tool=>tool.name==='friend_memory'));assert.deepEqual(errors,[]);
  }finally{await runtime?.dispose();bus.clear();if(priorDataDir===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=priorDataDir;rmSync(dir,{recursive:true,force:true});}
});

test('shutdown during pre-launch claim persists unknown even before a process handle exists',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-claim-shutdown-'));const controller=new SwarmController();
  const ctx:PluginContext={dataDir:dir,projectDir:dir,projectId:'project',sessionId:'old-session',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unused');},complete:async()=>'',request:async()=>undefined,emit:()=>{},notify:()=>{},appendEntry:()=>{}};
  try {const graph=await controller.dispatch('create',{goal:'claimed',tasks:[{id:'pending',title:'pending',prompt:'pending',mode:'read'}]},ctx) as Graph;const store=new RecordStore('swarm',dir);const doc=store.get<Graph>(`graph:project:${graph.id}`)!;doc.value.status='running';store.put(doc.key,doc.value,doc.revision);store.close();controller.claim(graph.id,'pending',ctx);await controller.dispose();const restored=new SwarmController();try{const state=(restored.snapshot(ctx) as {graphs:Graph[]}).graphs[0];assert.equal(state.status,'paused');assert.equal(state.attempts[0].status,'unknown');const fresh={...ctx,sessionId:'new-session'};assert.equal((restored.snapshot(fresh) as {graphs:Graph[]}).graphs.length,0);}finally{await restored.dispose();}}finally{await controller.dispose();rmSync(dir,{recursive:true,force:true});}
});
