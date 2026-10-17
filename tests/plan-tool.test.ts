import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import vm from 'node:vm';
import {Type} from 'typebox';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,initTheme,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {RecordStore,text} from '@friend-pi/core';
import {PlanStore} from '../apps/desktop/src/plan-store.js';

const source=readFileSync('apps/desktop/src/sdk-worker.ts','utf8'),start=source.indexOf("  pi.registerTool({name:'friend_plan'"),end=source.indexOf("  pi.on('context_with_system'",start);
assert.ok(start>=0&&end>start);

test('empty plan reads return explicit null and survive the next OpenAI provider request',{timeout:15000},async()=>{
 const requests:any[]=[];const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=String(chunk);requests.push(JSON.parse(raw));
  const number=requests.length,action=number<=2?'read':'invalid';
  const deltas=number%2?[{delta:{role:'assistant',tool_calls:[{index:0,id:'plan-call-'+number,type:'function',function:{name:'friend_plan',arguments:JSON.stringify({action})}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}]:[{delta:{role:'assistant',content:'continued after tool result'},finish_reason:null},{delta:{},finish_reason:'stop'}];
  res.writeHead(200,{'content-type':'text/event-stream'});for(const choice of deltas)res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');
 const dir=mkdtempSync(join(tmpdir(),'friend-plan-tool-')),agentDir=join(dir,'pi');mkdirSync(agentDir);const store=new RecordStore('plans',dir),plans=new PlanStore(store,'project','native');let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
 try{
  const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});runtime.registerProvider('plan-fixture',{baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'synthetic-local-test-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
  let definition:ToolDefinition|undefined;const settings=SettingsManager.inMemory({packages:[],extensions:[],defaultTools:[]});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[pi=>{
   vm.runInNewContext(source.slice(start,end),{pi:{registerTool(tool:ToolDefinition){definition=tool;pi.registerTool(tool);}},Type,plans,text,session:{model:{provider:'plan-fixture',id:'fixture'},thinkingLevel:'off'},executionMode:'single',permissionMode:'auto',planMode:true,runId:'plan-tool-fixture',publish:()=>{},current:()=>({})});
  }]});
  await loader.reload({resolveProjectTrust:async()=>true});initTheme('light',false);
  ({session}=await createAgentSession({cwd:dir,agentDir,resourceLoader:loader,settingsManager:settings,modelRuntime:runtime,model:runtime.getModel('plan-fixture','fixture'),sessionManager:SessionManager.inMemory(dir),noTools:'builtin'}));await session.bindExtensions({mode:'rpc'});
  assert.ok(definition);const execute=definition.execute as (...args:any[])=>Promise<any>;
  assert.equal(plans.current(),undefined);const empty=await execute('direct-empty',{action:'read'});assert.equal(empty.content[0].text,'null');assert.equal(empty.details,null);
  await session.prompt('Read the current plan.');assert.equal(requests.length,2);assert.equal(requests[1].messages.find((message:any)=>message.role==='tool').content,'null');
  let results=session.messages.filter(message=>message.role==='toolResult');assert.equal(results.length,1);assert.equal(results[0].isError,false);assert.equal(JSON.stringify(results[0].content),JSON.stringify([{type:'text',text:'null'}]));
  await session.prompt('Try an invalid plan operation.');assert.equal(requests.length,4);results=session.messages.filter(message=>message.role==='toolResult');assert.equal(results[1].isError,true);assert.ok(results[1].content.every(part=>part.type!=='text'||typeof part.text==='string'));
  assert.equal(session.messages.at(-1)?.role,'assistant');assert.equal((session.messages.at(-1) as any).stopReason,'stop');
  const submitted=await execute('submit',{action:'submit',body:'Read only and report.'}),read=await execute('read',{action:'read'});assert.equal(JSON.parse(submitted.content[0].text).body,'Read only and report.');assert.equal(read.content[0].text,submitted.content[0].text);assert.deepEqual(read.details,submitted.details);
 }finally{session?.dispose();store.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(dir,{recursive:true,force:true});}
});
