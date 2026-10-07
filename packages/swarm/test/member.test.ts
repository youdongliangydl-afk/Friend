import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { SwarmController, type Graph, type MemberInput, type MemberOutput, type MemberStart } from '../src/index.js';
import type { PluginContext } from '@friend-pi/core';

/** Local HTTP fixture drives the real Pi SDK; no credential or external endpoint is used. */
async function environment(respond:(input:Record<string,unknown>)=>string|{tool:string;args:Record<string,unknown>}) {
  const root=mkdtempSync(join(tmpdir(),'friend-pi-member-'));const project=join(root,'project');const agentDir=join(root,'pi');mkdirSync(project);mkdirSync(agentDir);writeFileSync(join(project,'readme.txt'),'source fixture\n');
  let requests=0;
  const server=createServer(async(req,res)=>{let body='';for await (const chunk of req) body+=chunk;const input=JSON.parse(body) as Record<string,unknown>;requests++;const response=respond(input);const delta=typeof response==='string'?{role:'assistant',content:response}:{role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:response.tool,arguments:JSON.stringify(response.args)}}]};res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'fixture',choices:[{index:0,delta:{},finish_reason:typeof response==='string'?'stop':'tool_calls'}]})}\n\n`);res.end('data: [DONE]\n\n');});
  await new Promise<void>(resolveListen=>server.listen(0,'127.0.0.1',resolveListen));const address=server.address();assert.ok(address && typeof address==='object');
  writeFileSync(join(agentDir,'models.json'),JSON.stringify({providers:{'swarm-fixture':{baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'fixture-local-no-real-credential',models:[{id:'fixture',name:'Swarm local fixture',reasoning:false,input:['text'],contextWindow:32000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  const buildDir=resolve('.cache','swarm-member-tests',randomUUID());mkdirSync(buildDir,{recursive:true});const worker=join(buildDir,'member.mjs');
  await build({entryPoints:[resolve('packages/swarm/src/member.ts')],bundle:true,outfile:worker,platform:'node',format:'esm',packages:'external',target:'node24',alias:{'@friend-pi/core':resolve('packages/core/src/index.ts')}});
  return {root,project,agentDir,worker,requests:()=>requests,cleanup:async()=>{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});rmSync(buildDir,{recursive:true,force:true});}};
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

test('real controller schedules standalone SDK member and a different independent SDK reviewer',async()=>{
  const env=await environment(input=>{
    if (JSON.stringify(input).includes('独立成果审查者')) return '{"approved":true,"findings":"read source and verified requested outcomes"}';
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
    assert.equal(final.attempts.length,1);assert.ok(final.attempts[0].sessionId);assert.ok(final.integration?.review?.approved);assert.ok(env.requests()>=2);const dirs=readdirSync(join(context.dataDir,'swarm-sessions',graph.id));assert.equal(dirs.length,2,'execution and independent review must each own a Pi session');
    assert.equal(final.agentDir,env.agentDir,'actual SDK directory must win over an inherited legacy Pi path');
    const shared=(controller.snapshot(context) as {shared:{content:string;revision:number}[]}).shared;assert.equal(shared.length,1);assert.equal(shared[0].content,'SDK member shared outcome');assert.equal(shared[0].revision,1,'member tool must route through host controller CAS');
  }finally {await controller.dispose();if (oldWorker===undefined) delete process.env.FRIEND_PI_MEMBER_WORKER;else process.env.FRIEND_PI_MEMBER_WORKER=oldWorker;if(oldAgent===undefined)delete process.env.FRIEND_PI_AGENT_DIR;else process.env.FRIEND_PI_AGENT_DIR=oldAgent;await env.cleanup();}
});
