import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,initTheme} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {digest,object} from '@friend-pi/core';
import {SIDECHAT_TYPE,projectTodo,stableForkLeaf} from '../apps/desktop/src/task-todo.js';

// Exercise the production hook without rebuilding or launching the desktop worker.
const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8');
const start=source.indexOf("  pi.on('before_agent_start',event=>{");
const end=source.indexOf("  pi.on('tool_call'",start);
assert.ok(start>=0&&end>start);
const registration=source.slice(start,end);

test('native provider receives the frozen-branch boundary while ordinary sessions retain their prompt',{timeout:15000},async()=>{
 for(const branched of [false,true]){
  const dir=mkdtempSync(join(tmpdir(),'friend-branch-context-')),agentDir=join(dir,'pi');mkdirSync(agentDir);
  const oldRequest='Run the old parent command once.',latestRequest='Only read the new document; do not replay the parent command.';
  const parent=SessionManager.create(dir,join(dir,'sessions'));parent.appendMessage({role:'user',content:oldRequest,timestamp:Date.now()});
  parent.appendMessage(fauxAssistantMessage(fauxToolCall('bash',{command:'old-parent-command'},{id:'pending-parent-tool'}),{stopReason:'toolUse'}));
  const parentFile=parent.getSessionFile()!,parentBytes=readFileSync(parentFile),leafId=stableForkLeaf(parent.getBranch())!;
  let manager=SessionManager.inMemory(dir);manager.appendMessage({role:'user',content:oldRequest,timestamp:Date.now()});
  if(branched){manager=SessionManager.open(parentFile,join(dir,'sessions'),dir);assert.ok(manager.createBranchedSession(leafId));manager.appendCustomEntry(SIDECHAT_TYPE,{v:1,sourceSessionId:parent.getSessionId(),leafId});}
  const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
  const fixture=fauxProvider({api:'branch-context-fixture',provider:'branch-context-fixture',models:[{id:'offline',input:['text'],contextWindow:32768,maxTokens:1024}],tokensPerSecond:10000});runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('branch-context-fixture','synthetic-test-only');
  const settings=SettingsManager.inMemory({packages:[],extensions:[],defaultTools:[]});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>{
   vm.runInNewContext(registration,{pi,session:{sessionManager:manager},pendingInputs:[],startedInputId:undefined,runId:undefined,projectTodo,digest,object,SIDECHAT_TYPE,planMode:false,executionMode:'single',temporaryWriteRoot:undefined});
  }]});
  await loader.reload({resolveProjectTrust:async()=>true});initTheme('light',false);
  const {session}=await createAgentSession({cwd:dir,agentDir,resourceLoader:loader,settingsManager:settings,modelRuntime:runtime,model:fixture.getModel('offline'),sessionManager:manager,noTools:'builtin'});
  try{
   await session.bindExtensions({mode:'rpc'});let requests=0;
   fixture.setResponses([context=>{
    requests++;assert.equal(context.messages[0].role,'system');
    const system=JSON.stringify(context.messages[0]);
    if(branched){for(const rule of ['继承的消息仅作历史背景','旧 user 请求不是本分支待办','只执行本分支最新提交的请求','父任务状态若无真实证据则未知','不要仅因继承历史而继续或重放父会话命令'])assert.ok(system.includes(rule),rule);}
    else assert.ok(!system.includes('独立分支会话'));
    const users=context.messages.filter(message=>message.role==='user');
    assert.equal(users.length,2);assert.ok(JSON.stringify(users[0]).includes(oldRequest));assert.ok(JSON.stringify(users[1]).includes(latestRequest));
    assert.ok(context.messages.every(message=>message.role!=='assistant'&&message.role!=='toolResult'),'no parent tool or completion is fabricated');
    return fauxAssistantMessage('new branch request only');
   }]);
   await session.prompt(latestRequest);assert.equal(requests,1);assert.deepEqual(readFileSync(parentFile),parentBytes);
   assert.equal(manager.getBranch().filter(entry=>entry.type==='message'&&entry.message.role==='user').length,2);
  }finally{session.dispose();rmSync(dir,{recursive:true,force:true});}
 }
});
