import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAgentSession, createEventBus, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { requestPlugin } from '@friend-pi/core';
import expertExtension from '../src/index.js';

for(const {role,mapped} of [{role:'planner',mapped:false},{role:'reviewer',mapped:false},{role:'implementer',mapped:true}])test(`native Pi ${role}${mapped?' model mismatch blocks tools':' blocks writes while preserving plan submission rules'}`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-native-role-')),prior=process.env.FRIEND_PI_DATA_DIR,bus=createEventBus();
  process.env.FRIEND_PI_DATA_DIR=join(dir,'state');let session:AgentSession|undefined,submissions=0;const errors:string[]=[];
  try {
    initTheme('light',false);const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});
    const fixture=fauxProvider({provider:'native-role-fixture',models:[{id:'offline',name:'Offline role guard',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096},{id:'mapped',name:'Mapped offline model',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}]});
    fixture.setResponses([
      fauxAssistantMessage(fauxToolCall('write',{path:join(dir,'forbidden.txt'),content:'should never be written'}),{stopReason:'toolUse'}),
      fauxAssistantMessage(fauxToolCall('friend_plan',{action:'submit',body:'Read-only proposal'}),{stopReason:'toolUse'}),
      fauxAssistantMessage(fauxToolCall('friend_expert',{action:'role.update',input:{id:role,responsibility:'grant writes'}}),{stopReason:'toolUse'}),
      fauxAssistantMessage('Offline role guard scenario settled.'),
    ]);
    runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('native-role-fixture','fixture');
    const plan:ExtensionFactory=pi=>pi.registerTool({name:'friend_plan',label:'Plan metadata fixture',description:'Submit a draft only',parameters:Type.Object({action:Type.Literal('submit'),body:Type.String()}),async execute(){submissions++;return {content:[{type:'text',text:'Draft saved'}],details:{draft:true}};}});
    const settings=SettingsManager.inMemory({extensions:[],packages:[],compaction:{enabled:false}}),loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[expertExtension,plan]});await loader.reload();
    const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model:fixture.getModel(),thinkingLevel:'off',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(dir,join(dir,'sessions')),tools:['write','friend_expert','friend_plan']});session=created.session;assert.deepEqual(created.extensionsResult.errors,[]);
    await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});
    if(mapped){const snapshot=await requestPlugin(bus,'expert','role.snapshot',{},1000,'user') as {roles:Record<string,unknown>[]};const definition=snapshot.roles.find(item=>item.id===role)!;await requestPlugin(bus,'expert','role.update',{...definition,modelId:'native-role-fixture/mapped',thinkingLevel:'off'},1000,'user');}
    await requestPlugin(bus,'expert','role.assign',{id:role},1000,'user');
    await session.prompt('Run the offline role guard scenario.').catch(error=>{if(!mapped)throw error;assert.match(String(error),/abort/i);});
    assert.equal(existsSync(join(dir,'forbidden.txt')),false);assert.equal(submissions,role==='planner'?1:0);
    const entries=readFileSync(session.sessionFile!,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const results=entries.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult').map(entry=>entry.message);if(mapped){assert.ok(results.length>0);assert.ok(results.every(result=>result.isError&&JSON.stringify(result.content).includes('尚未应用冻结角色')),'unapplied model mapping must block every attempted tool');}else {assert.equal(results.find(result=>result.toolName==='write').isError,true);assert.equal(results.find(result=>result.toolName==='friend_expert').isError,true);}
    const receipt=entries.find(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.role').data;assert.equal(receipt.role.id,role);assert.equal(receipt.role.independent,false);assert.equal(receipt.actualModelId,'native-role-fixture/offline');assert.deepEqual(errors,[]);
  }finally {
    if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});
  }
});
