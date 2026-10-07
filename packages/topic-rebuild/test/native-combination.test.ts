import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  ModelRuntime, createEventBus, initTheme, type AgentSession,
} from '@earendil-works/pi-coding-agent';
import memoryExtension from '../../memory/src/index.js';
import rebuildExtension, {type WorkingField} from '../src/index.js';
import {installFixtureProvider,requestPlugin,visibleText,type JsonObject} from '../../core/src/index.js';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';

test('native Pi combination journals canonical fields, compacts, recalls mixed tokens and resumes cold',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-native-memory-rebuild-'));
  const priorDataDir=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=join(dir,'state');
  const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];
  try {
    initTheme('light',false);
    const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});
    const model=await installFixtureProvider(runtime);
    const settings=SettingsManager.inMemory({extensions:[],packages:[],defaultTools:['read'],compaction:{enabled:true,reserveTokens:128,keepRecentTokens:128}});
    const open=async(sessionFile?:string)=>{
      const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[
        pi=>{pi.on('agent_before_settle',event=>({entries:[...event.entries,{type:'custom',customType:'audit-other-extension',data:{preserved:true}}],continue:event.continue}));},
        memoryExtension,rebuildExtension,
      ]});
      await loader.reload({resolveProjectTrust:async()=>true});
      const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model,settingsManager:settings,resourceLoader:loader,sessionManager:sessionFile?SessionManager.open(sessionFile):SessionManager.create(dir,join(dir,'sessions'))});
      assert.deepEqual(created.extensionsResult.errors,[]);
      const next=created.session;await next.bindExtensions({mode:'json',onError:error=>{errors.push(error.error);}});return next;
    };
    session=await open();
    await requestPlugin(bus,'memory','learning.pause',{},1000,'user');
    await session.prompt('必须保留用户原始文件。不要并行写入数据库。请用中文分析SQLite事务。');
    const first=await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as JsonObject;
    assert.equal((first.status as {phase:string}).phase,'applied');assert.equal((first.field as WorkingField).revision,1);
    const saved=await requestPlugin(bus,'memory','save',{content:'SQLite事务写入必须串行',explicitRemember:true},1000,'user') as {id:string;revision:number;status:string};
    assert.equal(saved.status,'active');
    const recall=await requestPlugin(bus,'memory','search',{query:'数据库事务检查',match:'any'},1000,'user') as unknown[];
    assert.equal(recall.length,1);
    await session.prompt('回到数据库事务检查：'+('请检查事务完整性并保留证据。'.repeat(70)));
    await session.compact();
    const compacted=await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as JsonObject;
    assert.equal((compacted.status as {phase:string}).phase,'applied');
    const field=compacted.field as WorkingField;assert.equal(field.revision,3);assert.ok(field.operationId);
    const canonical=session.sessionManager.getEntries();
    assert.equal(canonical.filter(entry=>entry.type==='custom'&&entry.customType==='audit-other-extension').length,2);
    assert.equal(canonical.filter(entry=>entry.type==='custom'&&entry.customType==='friend-pi:working-field:v1').length,2);
    const compactEntries=canonical.filter(entry=>entry.type==='compaction');assert.equal(compactEntries.length,1);
    assert.equal((compactEntries[0]!.details as {friendPiRebuild:WorkingField}).friendPiRebuild.operationId,field.operationId);
    assert.match(compactEntries[0]!.summary,/保留用户原始文件/);
    const sessionFile=session.sessionFile!;assert.ok(readFileSync(sessionFile,'utf8').includes(field.operationId));
    await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();session=undefined;bus.clear();
    session=await open(sessionFile);
    const resumed=await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as JsonObject;
    assert.equal((resumed.field as WorkingField).operationId,field.operationId);
    const history=await requestPlugin(bus,'topic-rebuild','history.search',{query:'原始文件'},1000,'user') as unknown[];
    assert.ok(history.length>0);
    const coldRecall=await requestPlugin(bus,'memory','search',{query:'事务检查',match:'any'},1000,'user') as unknown[];assert.equal(coldRecall.length,1);
    await requestPlugin(bus,'memory','forget',{id:saved.id,revision:saved.revision},1000,'user');
    const invalid=await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as JsonObject;assert.equal(invalid.invalidated,true);
    const noMemory=await requestPlugin(bus,'memory','search',{query:'事务检查',match:'any'},1000,'user') as unknown[];assert.equal(noMemory.length,0);
    assert.deepEqual(errors,[]);
  } finally {
    if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}
    bus.clear();if(priorDataDir===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=priorDataDir;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('real Memory GUI correction and forgetting suppress old Pi sources through compaction and cold checkpoints',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-memory-origin-'));const priorDataDir=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=join(dir,'state');
  const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];const stale=new Map<string,string>();
  try {
    initTheme('light',false);const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:join(dir,'models.json'),allowModelNetwork:false});
    const fixture=fauxProvider({provider:'source-origin-fixture',models:[{id:'offline',name:'Origin suppression fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:4096}]});
    const respond:Parameters<typeof fixture.setResponses>[0][number]=context=>{
      fixture.appendResponses([respond]);const content=context.messages.map(message=>visibleText(message.content)).join('\n');
      if(content.includes('FRIEND_PI_REBUILD_JSON')){const originals=JSON.parse(content.slice(content.lastIndexOf('原始条目：')+'原始条目：'.length)) as {id:string;role:string;text:string}[];const goal=[...originals].reverse().find(item=>item.role==='user')!;return fauxAssistantMessage(JSON.stringify({goal:{text:stale.size?[...stale.values()][0]:goal.text,sourceEntryIds:[goal.id,...stale.keys()]},constraints:[...stale].map(([id,text])=>({text,sourceEntryIds:[id,goal.id]})),decisions:[],unfinished:[],topics:[]}));}
      return fauxAssistantMessage('离线来源引用测试完成，不代表真实模型质量。');
    };
    fixture.setResponses([respond]);runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('source-origin-fixture','fixture');const model=fixture.getModel();
    const open=async(file?:string)=>{
      const settings=SettingsManager.inMemory({extensions:[],packages:[],defaultTools:['read'],compaction:{enabled:false,reserveTokens:128,keepRecentTokens:128}});
      const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[memoryExtension,rebuildExtension]});await loader.reload({resolveProjectTrust:async()=>true});
      const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model,settingsManager:settings,resourceLoader:loader,sessionManager:file?SessionManager.open(file):SessionManager.create(dir,join(dir,'sessions'))});assert.deepEqual(created.extensionsResult.errors,[]);await created.session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});return created.session;
    };
    const field=async()=> (await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {field:WorkingField}).field;
    const noStale=async()=>{const current=await field();for(const point of [current.goal,...current.constraints])assert.equal(point.sources.some(source=>stale.has(source.entryId)),false,'suppressed source must not re-enter effective constraints');};
    session=await open();await requestPlugin(bus,'memory','learning.pause',{},1000,'user');
    await session.prompt('必须使用蓝色侧栏。');const origin=session.sessionManager.getEntries().find(entry=>entry.type==='message'&&entry.message.role==='user')!.id;stale.set(origin,'必须使用蓝色侧栏。');
    const saved=await requestPlugin(bus,'memory','save',{content:'侧栏必须使用蓝色',explicitRemember:true,sources:[{sessionId:session.sessionId,entryId:origin}]},1000,'user') as {id:string;revision:number};
    await session.prompt('继续检查侧栏布局，必须保留用户文件。'+'核对侧栏尺寸和来源证据，保持原项目完整。'.repeat(80));
    await requestPlugin(bus,'memory','update',{id:saved.id,revision:saved.revision,content:'侧栏必须使用绿色'},1000,'user');assert.equal((await requestPlugin(bus,'topic-rebuild','snapshot',{},1000,'user') as {invalidated:boolean}).invalidated,true);
    await session.compact();await noStale();await session.prompt('继续检查侧栏布局。');await noStale();
    const recall=await requestPlugin(bus,'memory','search',{query:'绿色'},1000,'user') as unknown[];assert.equal(recall.length,1,'corrected new version remains available');
    const file=session.sessionFile!;await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();session=undefined;bus.clear();session=await open(file);await session.prompt('冷启动后继续检查侧栏布局。');await noStale();
    await session.prompt('必须使用旧缓存后端。');const forgetOrigin=[...session.sessionManager.getEntries()].reverse().find(entry=>entry.type==='message'&&entry.message.role==='user')!.id;stale.set(forgetOrigin,'必须使用旧缓存后端。');
    const forgotten=await requestPlugin(bus,'memory','save',{content:'缓存必须使用旧后端',explicitRemember:true,sources:[{sessionId:session.sessionId,entryId:forgetOrigin}]},1000,'user') as {id:string;revision:number};await session.prompt('继续检查缓存接口。'+'逐项核对缓存接口和实际返回值并保留原始来源。'.repeat(80));
    await requestPlugin(bus,'memory','forget',{id:forgotten.id,revision:forgotten.revision},1000,'user');await session.compact();await noStale();await session.prompt('遗忘后继续检查接口。');await noStale();
    const forgottenFile=session.sessionFile!;await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();session=undefined;bus.clear();session=await open(forgottenFile);await session.prompt('再次冷启动后检查接口。');await noStale();
    const original=await requestPlugin(bus,'topic-rebuild','history.read',{id:origin},1000,'user') as {item:{text:string}};assert.match(original.item.text,/蓝色侧栏/,'source suppression never deletes original Pi history');assert.deepEqual(errors,[]);
  }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(priorDataDir===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=priorDataDir;rmSync(dir,{recursive:true,force:true});}
});
