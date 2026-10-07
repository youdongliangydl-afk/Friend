import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAgentSession,createEventBus,DefaultResourceLoader,initTheme,ModelRuntime,SessionManager,SettingsManager,type AgentSession} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {requestPlugin,type JsonObject} from '../../core/src/index.js';
import memoryExtension,{type MemoryRecord} from '../src/index.js';

test('Memory alone injects exact versions into actual public Pi faux requests, journals receipts and restores them cold',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-native-memory-'));const prior=process.env.FRIEND_PI_DATA_DIR,role=process.env.FRIEND_PI_LEARNING_ROLE;process.env.FRIEND_PI_DATA_DIR=join(dir,'state');process.env.FRIEND_PI_LEARNING_ROLE='producer';
  const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];const observed:string[]=[];let recordId='';
  try{
    initTheme('light',false);const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});const provider=fauxProvider({provider:'memory-offline',models:[{id:'native',name:'Memory offline fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}]});
    const respond:Parameters<typeof provider.setResponses>[0][number]=context=>{observed.push(JSON.stringify(context.messages));provider.appendResponses([respond]);const lastUser=context.messages.findLastIndex(message=>message.role==='user');if(JSON.stringify(context.messages[lastUser]).includes('READ_MEMORY')&&!context.messages.slice(lastUser+1).some(message=>message.role==='toolResult'&&message.toolName==='friend_memory'))return fauxAssistantMessage(fauxToolCall('friend_memory',{action:'read',input:{id:recordId}}),{stopReason:'toolUse'});return fauxAssistantMessage('离线记忆上下文测试已完成。');};provider.setResponses([respond]);runtime.registerNativeProvider(provider.provider);await runtime.setRuntimeApiKey('memory-offline','fixture');
    const settings=SettingsManager.inMemory({extensions:[],packages:[],compaction:{enabled:false}});const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[memoryExtension]});await loader.reload();
    const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model:provider.getModel(),settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(dir,join(dir,'sessions')),tools:['friend_memory']});session=created.session;await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});
    const record=await requestPlugin(bus,'memory','save',{content:'SQLite事务必须串行提交。',explicitRemember:true},1000,'user') as MemoryRecord;recordId=record.id;
    await session.prompt('检查SQLite事务。');assert.ok(observed[0].includes('SQLite事务必须串行提交。'));assert.ok(observed[0].includes('FRIEND_PI_MEMORY_RECEIPT:'));
    const first=readFileSync(session.sessionFile!,'utf8');const entries=first.trim().split('\n').map(line=>JSON.parse(line));const receipts=entries.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.memory.usage:v1').map(entry=>entry.data);assert.ok(receipts.some(receipt=>receipt.stage==='prepared'));assert.ok(receipts.some(receipt=>receipt.stage==='injected-to-context'));assert.ok(receipts.every(receipt=>receipt.records.every((item:MemoryRecord)=>item.id===record.id&&item.revision===1)));
    await requestPlugin(bus,'memory','update',{id:record.id,revision:1,content:'SQLite事务需要逐项验证后提交。'},1000,'user');await session.prompt('再检查SQLite事务。');assert.ok(observed[1].includes('SQLite事务需要逐项验证后提交。'));assert.ok(!observed[1].includes('SQLite事务必须串行提交。'));assert.ok(readFileSync(session.sessionFile!,'utf8').startsWith(first));
    const usage=await requestPlugin(bus,'memory','usage',{},1000,'user') as JsonObject;assert.equal((usage.records as MemoryRecord[])[0].revision,2);
    await session.reload();await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});const restored=await requestPlugin(bus,'memory','usage',{},1000,'user') as JsonObject;assert.equal((restored.records as MemoryRecord[])[0].revision,2);assert.deepEqual(errors,[]);
    await session.prompt('READ_MEMORY');const toolReceipts=readFileSync(session.sessionFile!,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi.memory.usage:v1'&&entry.data.channel==='model-tool');assert.ok(toolReceipts.some(entry=>entry.data.stage==='tool-read'&&entry.data.records[0].revision===2));assert.deepEqual(errors,[]);
  }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;if(role===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=role;rmSync(dir,{recursive:true,force:true});}
});
