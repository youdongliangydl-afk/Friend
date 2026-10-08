import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import {createAgentSession,createEventBus,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,type AgentSession} from '@earendil-works/pi-coding-agent';
import swarmExtension,{ SwarmController, type Graph, type MemberInput, type MemberOutput, type MemberStart } from '../src/index.js';
import {requestPlugin,type PluginContext} from '@friend-pi/core';
import {Compile} from 'typebox/compile';
import type {TSchema} from 'typebox';
import {ExpertController} from '../../expert/src/index.js';

type LocalResponse=string|{tool:string;args:Record<string,unknown>};
type ModelRequest=Record<string,unknown>;
function reviewResponse(input:ModelRequest):LocalResponse|undefined {
  const tools=input.tools as {function:{name:string}}[]|undefined;
  if(!tools?.some(item=>item.function.name==='swarm_review_result'))return;
  const messages=input.messages as {role:string;name?:string}[];
  return messages.some(message=>message.role==='tool')?'Verification complete. The immutable tool result is authoritative.':{tool:'swarm_review_result',args:{approved:true,findings:'offline independent review of supplied evidence'}};
}
async function waitFor(check:()=>boolean,timeout=10000){const began=Date.now();while(!check()){if(Date.now()-began>timeout)throw new Error('Member fixture wait timed out');await new Promise(done=>setTimeout(done,10));}}

/** Local HTTP fixture drives the real Pi SDK; no credential or external endpoint is used. */
async function environment(respond:(input:Record<string,unknown>)=>string|{tool:string;args:Record<string,unknown>}|Promise<string|{tool:string;args:Record<string,unknown>}>) {
  const root=mkdtempSync(join(tmpdir(),'friend-pi-member-'));const project=join(root,'project');const agentDir=join(root,'pi');mkdirSync(project);mkdirSync(agentDir);writeFileSync(join(project,'readme.txt'),'source fixture\n');
  let requests=0;
  const server=createServer(async(req,res)=>{let body='';for await (const chunk of req) body+=chunk;const input=JSON.parse(body) as Record<string,unknown>;requests++;const response=await respond(input);const delta=typeof response==='string'?{role:'assistant',content:response}:{role:'assistant',tool_calls:[{index:0,id:`fixture-call-${requests}`,type:'function',function:{name:response.tool,arguments:JSON.stringify(response.args)}}]};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta:{},finish_reason:typeof response==='string'?'stop':'tool_calls'}]})}\n\n`);res.end('data: [DONE]\n\n');});
  await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));const address=server.address();assert.ok(address && typeof address==='object');
  writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{'swarm-fixture':{baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'fixture-local-no-real-credential',models:[{id:'fixture',name:'Swarm local fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  const buildDir=resolve('.cache','swarm-member-tests',randomUUID());mkdirSync(buildDir,{recursive:true});const worker=join(buildDir,'member.mjs');
  await build({entryPoints:[resolve('packages/swarm/src/member.ts')],bundle:true,outfile:worker,platform:'node',format:'esm',packages:'external',target:'node24',alias:{'@friend-pi/core':resolve('packages/core/src/index.ts')}});
  return {root,project,agentDir,worker,requests:()=>requests,cleanup:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});rmSync(buildDir,{recursive:true,force:true});}};
}

function runReviewer(env:Awaited<ReturnType<typeof environment>>){
  const start:MemberStart={v:1,type:'start',graphId:'review-fixture',taskId:'independent-review',attemptId:randomUUID(),cwd:env.project,dataDir:join(env.root,'data'),agentDir:env.agentDir,sessionDir:join(env.root,'sessions'),modelId:'swarm-fixture/fixture',thinkingLevel:'off',prompt:'独立成果审查者：read/grep/find/ls only. Host objective check passed. Submit using swarm_review_result.',mode:'read',writeScopes:[],reviewResult:true};
  const child=fork(env.worker,[],{cwd:env.project,stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});child.stdout?.resume();child.stderr?.resume();const messages:MemberOutput[]=[];
  const terminal=new Promise<Extract<MemberOutput,{type:'settled'|'failed'}>>((done,reject)=>{const timer=setTimeout(()=>reject(new Error('Reviewer fixture timed out')),15000);child.on('message',(message:MemberOutput)=>{messages.push(message);if(message.type==='settled'||message.type==='failed'){clearTimeout(timer);done(message);}});child.once('error',error=>{clearTimeout(timer);reject(error);});});
  child.send(start);return {start,child,messages,terminal};
}

test('bundled standalone member runs Pi SDK in a separate process and stores only native JSONL',async()=>{
  const env=await environment(()=> 'A source-backed member outcome');
  const start:MemberStart={v:1,type:'start',graphId:'fixture-graph',taskId:'read-source',attemptId:'fixture-attempt',cwd:env.project,dataDir:join(env.root,'data'),agentDir:env.agentDir,sessionDir:join(env.root,'sessions'),modelId:'swarm-fixture/fixture',thinkingLevel:'off',prompt:'Read the given fixture and report an outcome.',mode:'read',writeScopes:[]};
  const child=fork(env.worker,[],{cwd:env.project,stdio:['ignore','pipe','pipe','ipc'],execArgv:[]});child.stdout?.resume();child.stderr?.resume();
  try {
    assert.notEqual(child.pid,process.pid);const messages:MemberOutput[]=[];
    const finished=new Promise<Extract<MemberOutput,{type:'settled'}>>((resolveResult,reject)=>{const timer=setTimeout(()=>reject(new Error('Member SDK fixture timed out')),15000);child.on('message',(message:MemberOutput)=>{messages.push(message);if (message.type==='settled') {clearTimeout(timer);resolveResult(message);}if (message.type==='failed') {clearTimeout(timer);reject(new Error(message.error));}});child.on('error',reject);});
    child.send(start satisfies MemberInput);const result=await finished;assert.equal(result.summary,'A source-backed member outcome');assert.ok(messages.some(message=>message.type==='ready'));assert.ok(messages.some(message=>message.type==='event' && typeof message.event==='object' && message.event!==null && 'type' in message.event && message.event.type==='agent_settled'));
    assert.ok(env.requests()>=1);const files=readdirSync(start.sessionDir).filter(file=>file.endsWith('.jsonl'));assert.equal(files.length,1);const entries=readFileSync(join(start.sessionDir,files[0]),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(entries[0].type,'session');assert.ok(entries.some(entry=>entry.type==='message' && entry.message.role==='assistant'));assert.ok(result.sessionId);assert.equal(result.sessionFile,join(start.sessionDir,files[0]));
    await new Promise<void>(done=>{if (child.exitCode!==null) done();else child.once('exit',()=>done());});
  }finally {child.kill('SIGTERM');await env.cleanup();}
});

test('native reviewer submits strict immutable tool data and waits for Pi settled despite contradictory assistant prose',async()=>{
  let continuing=false;let finishResponse!:()=>void;const gate=new Promise<void>(done=>{finishResponse=done;});let requests=0;
  const env=await environment(async input=>{
    const tools=input.tools as {function:{name:string;parameters:TSchema}}[];assert.deepEqual(tools.map(item=>item.function.name).sort(),['find','grep','ls','read','swarm_review_result']);
    const submission=tools.find(item=>item.function.name==='swarm_review_result')!;const schema=Compile(submission.function.parameters);assert.equal(schema.Check({approved:true,findings:'checked source'}),true);assert.equal(schema.Check({approved:'true',findings:'checked source'}),false);assert.equal(schema.Check({approved:true}),false);assert.equal(schema.Check({approved:true,findings:'checked source',command:'wc -l'}),false);
    requests++;if(requests===1)return {tool:'read',args:{path:'readme.txt'}};
    if(requests===2)return {tool:'swarm_review_result',args:{approved:true,findings:'Read source fixture; host objective evidence passed.'}};
    continuing=true;await gate;return 'Verification complete.\n{"approved":false,"findings":"assistant prose must never replace the submitted result"}';
  });const reviewer=runReviewer(env);
  try{
    await waitFor(()=>continuing);assert.equal(reviewer.messages.some(message=>message.type==='settled'),false,'tool completion must not finish the reviewer');finishResponse();const result=await reviewer.terminal;assert.equal(result.type,'settled');if(result.type!=='settled')throw new Error('Reviewer failed');assert.deepEqual(JSON.parse(result.summary),{approved:true,findings:'Read source fixture; host objective evidence passed.'});
    const settledEvent=reviewer.messages.findIndex(message=>message.type==='event'&&typeof message.event==='object'&&message.event!==null&&'type' in message.event&&message.event.type==='agent_settled');assert.ok(settledEvent>=0&&settledEvent<reviewer.messages.indexOf(result));assert.equal(reviewer.messages.some(message=>message.type==='request'),false);
    const entries=readFileSync(result.sessionFile!,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='read'));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='swarm_review_result'&&!entry.message.isError));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content?.some((part:{type:string;name?:string;arguments?:{approved:boolean};text?:string})=>part.type==='toolCall'&&part.name==='swarm_review_result'&&part.arguments?.approved===true)));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='assistant'&&JSON.stringify(entry.message.content).includes('assistant prose must never')));
  }finally{finishResponse();reviewer.child.kill('SIGTERM');await env.cleanup();}
});

test('native reviewer refuses missing, invalid and conflicting submissions without falling back to prose',async()=>{
  for(const scenario of ['missing','invalid','conflict'] as const){
    let turns=0;const env=await environment(()=>{turns++;if(scenario==='missing')return '{"approved":true,"findings":"unsubmitted raw JSON"}';if(turns===1)return {tool:'swarm_review_result',args:{approved:scenario==='invalid'?'true':true,findings:'initial evidence'}};if(scenario==='conflict'&&turns===2)return {tool:'swarm_review_result',args:{approved:false,findings:'changed judgment'}};return 'Verification complete. {"approved":true,"findings":"unsubmitted replacement"}';});const reviewer=runReviewer(env);
    try{const result=await reviewer.terminal;assert.equal(result.type,'failed',scenario);if(result.type!=='failed')throw new Error('unexpected reviewer success');assert.match(result.error,scenario==='conflict'?/冲突/:/未通过 swarm_review_result/);assert.equal(reviewer.messages.some(message=>message.type==='settled'),false);assert.equal(readFileSync(join(env.project,'readme.txt'),'utf8'),'source fixture\n');assert.equal(readdirSync(reviewer.start.sessionDir).filter(file=>file.endsWith('.jsonl')).length,1);}finally{reviewer.child.kill('SIGTERM');await env.cleanup();}
  }
});

test('stopping a reviewer after native tool submission cannot adopt the result or replay a side effect',async()=>{
  let continuing=false;let finishResponse!:()=>void;const gate=new Promise<void>(done=>{finishResponse=done;});let turns=0;
  const env=await environment(async()=>{if(++turns===1)return {tool:'swarm_review_result',args:{approved:true,findings:'checked evidence'}};continuing=true;await gate;return 'done';});const reviewer=runReviewer(env);
  try{await waitFor(()=>continuing);assert.equal(reviewer.messages.some(message=>message.type==='settled'),false);reviewer.child.send({v:1,type:'stop'} satisfies MemberInput);finishResponse();const result=await reviewer.terminal;assert.equal(result.type,'failed');assert.equal(reviewer.messages.some(message=>message.type==='settled'),false);assert.equal(turns,2);assert.equal(readFileSync(join(env.project,'readme.txt'),'utf8'),'source fixture\n');}finally{finishResponse();reviewer.child.kill('SIGTERM');await env.cleanup();}
});

test('real SDK coordinator receives the legal Swarm protocol, copies the full graph id and reports only integrated', {timeout:25000},async()=>{
  let copiedId='';let snapshots=0;let sawProtocol=false;
  const env=await environment(async input=>{
    const tools=input.tools as {function:{name:string;description:string;parameters:Record<string,unknown>}}[]|undefined;
    const tool=tools?.find(item=>item.function.name==='friend_swarm');
    if(!tool)return reviewResponse(input)||'offline read-only member outcome';
    assert.match(tool.function.description,/input\.graphId/);assert.match(tool.function.description,/完整.*UUID/);assert.match(tool.function.description,/mode:"read"/);assert.match(tool.function.description,/integrated/);assert.match(tool.function.description,/automatic:true/);
    const action=(tool.function.parameters.properties as Record<string,Record<string,unknown>>).action;const allowed=(action.anyOf as {const:string}[]).map(value=>value.const);assert.ok(allowed.includes('snapshot'));assert.equal(allowed.includes('status'),false);assert.equal(allowed.includes('update_task'),true);assert.equal(allowed.includes('append'),true);assert.deepEqual(tool.function.parameters.required,['action','input']);sawProtocol=true;
    const results=(input.messages as {role:string;content:string}[]).filter(message=>message.role==='tool').map(message=>JSON.parse(message.content) as Record<string,unknown>);
    if(!results.length)return {tool:'friend_swarm',args:{action:'create',input:{goal:'inspect two read-only outcomes',tasks:[{id:'read-left',title:'inspect left',prompt:'read readme.txt',mode:'read',dependencies:[]},{id:'read-right',title:'inspect right',prompt:'read readme.txt',mode:'read',dependencies:[]}]}}};
    const created=results.find(result=>result.status==='created')!;copiedId=String(created.id);assert.match(copiedId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    if(results.length===1)return {tool:'friend_swarm',args:{action:'start',input:{graphId:copiedId}}};
    const queried=results.filter(result=>Array.isArray(result.graphs));const matched=queried.at(-1)?.graphs as {id:string;status:string}[]|undefined;
    if(matched?.some(graph=>graph.id===copiedId&&graph.status==='integrated'))return '目标任务图 integrated，两个只读成员及独立复核已完成。';
    snapshots++;assert.ok(snapshots<6,'coordinator must not spin indefinitely');await new Promise(done=>setTimeout(done,1500));return {tool:'friend_swarm',args:{action:'snapshot',input:{}}};
  });
  const oldData=process.env.FRIEND_PI_DATA_DIR;const oldAgent=process.env.FRIEND_PI_AGENT_DIR;const oldWorker=process.env.FRIEND_PI_MEMBER_WORKER;
  process.env.FRIEND_PI_DATA_DIR=join(env.root,'state');process.env.FRIEND_PI_AGENT_DIR=env.agentDir;process.env.FRIEND_PI_MEMBER_WORKER=env.worker;const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];
  try {
    const runtime=await ModelRuntime.create({authPath:join(env.agentDir,'auth.json'),modelsPath:join(env.agentDir,'models.json'),allowModelNetwork:false});const model=runtime.getModel('swarm-fixture','fixture')!;const settings=SettingsManager.inMemory({extensions:[],packages:[],compaction:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:env.project,agentDir:env.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[swarmExtension]});await loader.reload();
    const created=await createAgentSession({cwd:env.project,agentDir:env.agentDir,modelRuntime:runtime,model,thinkingLevel:'off',resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.create(env.project,join(env.root,'host-sessions')),tools:['friend_swarm']});session=created.session;await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});
    await session.prompt('Use the declared Swarm protocol to coordinate two read-only inspections.');const state=await requestPlugin(bus,'swarm','snapshot',{},1000,'user') as {graphs:Graph[]};const graph=state.graphs.find(item=>item.id===copiedId)!;
    assert.ok(sawProtocol);assert.equal(graph.status,'integrated');assert.equal(graph.tasks.length,2);assert.ok(graph.tasks.every(task=>task.mode==='read'&&task.status==='completed'));assert.ok(graph.integration?.review?.approved);assert.match(session.getLastAssistantText()!,/integrated/);assert.deepEqual(errors,[]);
  }finally {if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(oldData===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=oldData;if(oldAgent===undefined)delete process.env.FRIEND_PI_AGENT_DIR;else process.env.FRIEND_PI_AGENT_DIR=oldAgent;if(oldWorker===undefined)delete process.env.FRIEND_PI_MEMBER_WORKER;else process.env.FRIEND_PI_MEMBER_WORKER=oldWorker;await env.cleanup();}
});

test('real controller schedules standalone SDK member and a different independent SDK reviewer',async()=>{
  const env=await environment(input=>{
    const review=reviewResponse(input);if(review)return review;
    const messages=input.messages as {role:string}[];
    return messages.some(message=>message.role==='tool') ? 'read-source outcome' : {tool:'swarm_shared',args:{action:'write',name:'接口约定',content:'SDK member shared outcome',expectedRevision:0}};
  });
  const oldWorker=process.env.FRIEND_PI_MEMBER_WORKER;const oldAgent=process.env.FRIEND_PI_AGENT_DIR;process.env.FRIEND_PI_MEMBER_WORKER=env.worker;process.env.FRIEND_PI_AGENT_DIR=join(env.root,'unconfigured-legacy-pi');
  const context:PluginContext={dataDir:join(env.root,'data'),agentDir:env.agentDir,projectDir:env.project,projectId:'sdk-fixture',sessionId:'host-fixture',modelId:'swarm-fixture/fixture',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unused');},complete:async()=>{throw new Error('unused');},request:async()=>{throw new Error('optional absent');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
  const controller=new SwarmController();
  try {
    const graph=await controller.dispatch('create',{goal:'read source',tasks:[{id:'read-source',title:'read source',prompt:'read readme.txt',mode:'read',dependencies:[]}]},context) as Graph;
    await controller.dispatch('start',{graphId:graph.id,thinkingLevel:'off'},context);const began=Date.now();let final:Graph;
    while (true) {final=(controller.snapshot(context) as {graphs:Graph[]}).graphs[0];if (final.status==='integrated') break;if (final.status==='paused') throw new Error(final.error);if (Date.now()-began>20000) throw new Error('SDK Swarm fixture timed out');await new Promise(done=>setTimeout(done,20));}
    assert.equal(final.attempts.length,1);assert.ok(final.attempts[0].sessionId);assert.ok(final.integration?.review?.approved);assert.ok(final.integration.review.sessionId);assert.ok(final.integration.review.sessionFile?.includes(final.integration.review.attemptId));assert.ok(env.requests()>=2);const dirs=readdirSync(join(context.dataDir,'swarm-sessions',graph.id));assert.equal(dirs.length,2,'execution and independent review must each own a Pi session');
    assert.equal(final.agentDir,env.agentDir,'actual SDK directory must win over an inherited legacy Pi path');
    const shared=(controller.snapshot(context) as {shared:{content:string;revision:number}[]}).shared;assert.equal(shared.length,1);assert.equal(shared[0].content,'SDK member shared outcome');assert.equal(shared[0].revision,1,'member tool must route through host controller CAS');
  }finally {await controller.dispose();if (oldWorker===undefined) delete process.env.FRIEND_PI_MEMBER_WORKER;else process.env.FRIEND_PI_MEMBER_WORKER=oldWorker;if(oldAgent===undefined)delete process.env.FRIEND_PI_AGENT_DIR;else process.env.FRIEND_PI_AGENT_DIR=oldAgent;await env.cleanup();}
});

test('standalone Pi member automatically adopts frozen expert and blocks Bash through its real tool hook',async()=>{
  let expertId='';const env=await environment(input=>{
    const review=reviewResponse(input);if(review)return review;
    const messages=input.messages as {role:string;content?:string;tool_calls?:{function:{name:string}}[]}[];const results=messages.filter(message=>message.role==='tool');const called=new Set(messages.flatMap(message=>message.tool_calls?.map(call=>call.function.name)||[]));
    if(!called.has('friend_expert'))return {tool:'friend_expert',args:{action:'use',input:{id:expertId}}};
    if(!called.has('bash'))return {tool:'bash',args:{command:'echo forbidden > forbidden.txt'}};
    assert.match(results.at(-1)?.content||'',/范围/);return 'Readonly expert adopted; Bash correctly denied.';
  });
  const prior=process.env.FRIEND_PI_MEMBER_WORKER;process.env.FRIEND_PI_MEMBER_WORKER=env.worker;
  const ctx:PluginContext={origin:'user',dataDir:join(env.root,'data'),agentDir:env.agentDir,projectDir:env.project,projectId:'sdk-expert-fixture',sessionId:'host',modelId:'swarm-fixture/fixture',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>{throw Error('unused');},request:async()=>undefined,emit:()=>{},notify:()=>{},appendEntry:()=>{}};
  const expert=new ExpertController(ctx.dataDir),controller=new SwarmController();ctx.request=async(plugin,action,input)=>{assert.equal(plugin,'expert');return expert.dispatch(action,input||{},{...ctx,origin:'plugin'});};
  try{
    const method=await expert.dispatch('create',{title:'Readonly method',prompt:'Only inspect source. Do not execute shell.',tools:['read'],skills:[]},ctx) as {id:string};expertId=method.id;
    const graph=await controller.dispatch('create',{goal:'verify automatic expert policy',tasks:[{id:'a',title:'a',prompt:'Adopt readonly method then attempt Bash to prove guard.',mode:'write',dependencies:[],writeScopes:['.']}],checks:[{command:process.execPath,args:['-e',"if(require('node:fs').existsSync('forbidden.txt'))process.exit(9)"]}]},ctx) as Graph;
    await controller.dispatch('start',{graphId:graph.id},ctx);await waitFor(()=>['integrated','paused'].includes((controller.snapshot(ctx) as {graphs:Graph[]}).graphs[0].status),20000);
    const result=(controller.snapshot(ctx) as {graphs:Graph[]}).graphs[0];assert.equal(result.status,'integrated',result.error);assert.equal(readdirSync(env.project).includes('forbidden.txt'),false);
    assert.equal(result.attempts[0].expertAdoptions?.length,1);const adoption=result.attempts[0].expertAdoptions![0] as {id:string;version:number;toolScope:string[]};assert.equal(adoption.id,expertId);assert.equal(adoption.version,1);assert.deepEqual(adoption.toolScope,['read']);
    const entries=readFileSync(result.attempts[0].sessionFile!,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(entries.some(entry=>entry.type==='custom'&&entry.customType==='friend-pi.expert.adoption'&&entry.data.id===expertId));assert.ok(entries.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.toolName==='bash'&&entry.message.isError));
  }finally{await controller.dispose();expert.dispose();if(prior===undefined)delete process.env.FRIEND_PI_MEMBER_WORKER;else process.env.FRIEND_PI_MEMBER_WORKER=prior;await env.cleanup();}
});

test('native workflow EventBus auto-advances stages through fresh contexts without status-driven execution', {timeout:25000},async()=>{
  const env=await environment(input=>reviewResponse(input)||JSON.stringify({needed:true,evidence:'local fixture source'}));
  const oldData=process.env.FRIEND_PI_DATA_DIR,oldAgent=process.env.FRIEND_PI_AGENT_DIR,oldWorker=process.env.FRIEND_PI_MEMBER_WORKER;
  process.env.FRIEND_PI_DATA_DIR=join(env.root,'data');process.env.FRIEND_PI_AGENT_DIR=env.agentDir;process.env.FRIEND_PI_MEMBER_WORKER=env.worker;
  const bus=createEventBus();let session:AgentSession|undefined;const errors:string[]=[];
  try {
    const runtime=await ModelRuntime.create({authPath:join(env.agentDir,'auth.json'),modelsPath:join(env.agentDir,'models.json'),allowModelNetwork:false});const model=runtime.getModel('swarm-fixture','fixture')!;
    const settings=SettingsManager.inMemory({extensions:[],packages:[],compaction:{enabled:false}});
    const loader=new DefaultResourceLoader({cwd:env.project,agentDir:env.agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:[swarmExtension]});await loader.reload();
    session=(await createAgentSession({cwd:env.project,agentDir:env.agentDir,modelRuntime:runtime,model,thinkingLevel:'off',resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.create(env.project,join(env.root,'host-sessions')),tools:['friend_workflow']})).session;
    await session.bindExtensions({mode:'json',onError:error=>errors.push(error.error)});assert.ok(session.getAllTools().some(tool=>tool.name==='friend_workflow'));
    const definition={v:1,title:'Native bounded workflow',goal:'Inspect source in two stages',nodes:[{id:'read-a',title:'Read A',prompt:'Inspect local source fixture',mode:'read',dependencies:[],writeScopes:[],maxRetries:0},{id:'read-b',title:'Read B',prompt:'Verify the first inspection',mode:'read',dependencies:['read-a'],writeScopes:[],when:{taskId:'read-a',path:['needed'],op:'eq',value:true},maxRetries:0}]};
    const created=await requestPlugin(bus,'workflow','create',{definition},1000,'user') as {id:string};await requestPlugin(bus,'workflow','start',{workflowId:created.id},3000,'user');
    let snapshot:{workflows:{id:string;status:string;graphId:string;nodes:{id:string;status:string}[]}[]};const began=Date.now();
    while(true){snapshot=await requestPlugin(bus,'workflow','snapshot',{},1000,'user') as typeof snapshot;const run=snapshot.workflows.find(item=>item.id===created.id)!;if(run.status==='completed')break;if(['paused','blocked'].includes(run.status))throw Error(JSON.stringify(run));if(Date.now()-began>20000)throw Error('Native workflow auto-advance timeout');await new Promise(done=>setTimeout(done,20));}
    const run=snapshot.workflows.find(item=>item.id===created.id)!;assert.deepEqual(run.nodes.map(node=>[node.id,node.status]),[['read-a','completed'],['read-b','completed']]);const graphs=await requestPlugin(bus,'swarm','snapshot',{},1000,'user') as {graphs:Graph[]};const graph=graphs.graphs.find(item=>item.id===run.graphId)!;assert.equal(graph.status,'integrated');assert.equal(graph.attempts.length,2);assert.equal(graph.reviewAttempts?.length,1);assert.deepEqual(errors,[]);
  }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();if(oldData===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=oldData;if(oldAgent===undefined)delete process.env.FRIEND_PI_AGENT_DIR;else process.env.FRIEND_PI_AGENT_DIR=oldAgent;if(oldWorker===undefined)delete process.env.FRIEND_PI_MEMBER_WORKER;else process.env.FRIEND_PI_MEMBER_WORKER=oldWorker;await env.cleanup();}
});
