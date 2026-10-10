import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentSession,createEventBus,DefaultResourceLoader,initTheme,ModelRuntime,SessionManager,SettingsManager,type AgentSession} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {requestPlugin,visibleText} from '@friend-pi/core';
import expertExtension,{type ExpertDefinition,type FrozenRun} from '../src/index.js';

test('real Pi JSONL keeps each selected expert run/version and binds explicit use to the same immutable run',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-expert-adoption-'));const prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=join(dir,'state');
  const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];
  try {
    initTheme('light',false);const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});
    const fixture=fauxProvider({provider:'expert-adoption-fixture',models:[{id:'offline',name:'Expert adoption fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}]});
    const respond:Parameters<typeof fixture.setResponses>[0][number]=context=>{
      fixture.appendResponses([respond]);const lastUser=context.messages.findLastIndex(message=>message.role==='user');const user=context.messages[lastUser];
      if(user&&visibleText(user.content).includes('USE_EXPERT')&&!context.messages.slice(lastUser+1).some(message=>message.role==='toolResult'&&message.toolName==='friend_expert'))return fauxAssistantMessage(fauxToolCall('friend_expert',{action:'use',input:{id:'researcher'}}),{stopReason:'toolUse'});
      return fauxAssistantMessage('离线专家采用记录测试完成，不代表真实模型专业效果。');
    };
    fixture.setResponses([respond]);runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('expert-adoption-fixture','fixture');
    const settings=SettingsManager.inMemory({extensions:[],packages:[],compaction:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[expertExtension]});await loader.reload();
    const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model:fixture.getModel(),thinkingLevel:'off',settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(dir,join(dir,'sessions')),tools:['friend_expert']});session=created.session;
    assert.deepEqual(created.extensionsResult.errors,[]);await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});
    await requestPlugin(bus,'expert','select',{ids:['researcher']},1000,'user');await session.prompt('USE_EXPERT 第一轮，请使用研究方法处理来源。');
    const firstFile=readFileSync(session.sessionFile!,'utf8');const firstEntries=firstFile.trim().split('\n').map(line=>JSON.parse(line));
    const firstRun=firstEntries.find(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.run').data as {runId:string;frozen:FrozenRun};assert.match(firstRun.runId,/^[0-9a-f-]{36}$/);assert.equal(firstRun.frozen.selectionMode,'explicit');assert.deepEqual(firstRun.frozen.selectedIds,['researcher']);
    const firstAdoptions=firstEntries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.adoption').map(entry=>entry.data as {runId:string;version:number;mode:string});assert.equal(firstAdoptions.length,1);assert.ok(firstAdoptions.every(adoption=>adoption.runId===firstRun.runId&&adoption.version===1));assert.ok(firstAdoptions.some(adoption=>adoption.mode==='selected'));assert.ok(firstAdoptions.every(adoption=>adoption.mode==='selected'));
    const list=await requestPlugin(bus,'expert','snapshot',{},1000,'user') as {experts:(ExpertDefinition&{revision:number})[]};const researcher=list.experts.find(expert=>expert.id==='researcher')!;
    await requestPlugin(bus,'expert','update',{id:'researcher',revision:researcher.revision,title:'第二版研究方法',prompt:'第二版：检查当前源码及来源，明确验证范围。'},1000,'user');
    await session.prompt('USE_EXPERT 第二轮，请使用更新后的研究方法。');const secondFile=readFileSync(session.sessionFile!,'utf8');assert.ok(secondFile.startsWith(firstFile),'previous native history must never be rewritten by an expert edit');
    const secondEntries=secondFile.trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(secondEntries.filter(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='friend_expert'&&entry.message.isError).map(entry=>entry.message.content),[],'native use must succeed in both runs');const runs=secondEntries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.run').map(entry=>entry.data as {runId:string;frozen:FrozenRun});assert.equal(runs.length,2);assert.notEqual(runs[0].runId,runs[1].runId);assert.equal(runs[0].frozen.experts[0].version,1);assert.equal(runs[1].frozen.experts[0].version,2);assert.match(runs[1].frozen.prompt,/第二版/);assert.doesNotMatch(runs[0].frozen.prompt,/第二版/);
    const selected=secondEntries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.adoption'&&entry.data.mode==='selected').map(entry=>entry.data);assert.deepEqual(selected.map(adoption=>adoption.version),[1,2]);assert.deepEqual(selected.map(adoption=>adoption.runId),runs.map(run=>run.runId));
    await requestPlugin(bus,'expert','select',{ids:[]},1000,'user');await session.prompt('目录模式下正常处理请求。');const finalEntries=readFileSync(session.sessionFile!,'utf8').trim().split('\n').map(line=>JSON.parse(line));const finalRun=finalEntries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.run').at(-1).data;
    assert.equal(finalRun.frozen.selectionMode,'auto');assert.deepEqual(finalRun.frozen.selectedIds,[]);assert.equal(finalEntries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.adoption').length,2,'freezing the auto directory must not claim adoption of every expert');assert.deepEqual(errors,[]);
  }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
