import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { RecordStore } from '@friend-pi/core';
import type { PluginContext } from '@friend-pi/core';
import { SwarmController, type Graph, type MemberLauncher, type MemberOutput, type MemberStart, type MemberInput } from '../src/index.js';
import { contains, guardMember } from '../src/guard.js';

function fixture(git=false) {
  const root=mkdtempSync(join(tmpdir(),'friend-pi-swarm-'));const project=join(root,'project');mkdirSync(project);writeFileSync(join(project,'original.txt'),'original\n');
  if (git) {execFileSync('git',['init'],{cwd:project,stdio:'ignore'});execFileSync('git',['add','.'],{cwd:project});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline'],{cwd:project,stdio:'ignore'});}
  const events:unknown[]=[];
  const context:PluginContext={dataDir:join(root,'data'),projectDir:project,projectId:'fixture',sessionId:'host-session',modelId:'fake/deterministic',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unused');},complete:async()=>{throw new Error('unneeded model call');},request:async()=>{throw new Error('optional plugin absent');},emit:(_name,data)=>events.push(data),notify:()=>{},appendEntry:()=>{}};
  return {root,project,context,events,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const spec=(id:string,mode:'read'|'write'='read',dependencies:string[]=[])=>({id,title:id,prompt:`Produce ${id}`,mode,dependencies,writeScopes:['.']});
function snapshot(controller:SwarmController,context:PluginContext) {return controller.snapshot(context) as {graphs:Graph[];messages:{id:string;deliveredAt?:string;processedAt?:string;attemptId?:string}[];shared:{revision:number;file:string;content:string}[]};}
function makeRunning(controller:SwarmController,graph:Graph,ctx:PluginContext) {const store=new RecordStore('swarm',ctx.dataDir);const doc=store.get<Graph>(`graph:${ctx.projectId}:${graph.id}`)!;doc.value.status='running';store.put(doc.key,doc.value,doc.revision);store.close();}
async function waitFor(check:()=>boolean,timeout=10000) {const start=Date.now();while (!check()) {if (Date.now()-start>timeout) throw new Error('Timed out waiting for Swarm state');await new Promise(resolve=>setTimeout(resolve,10));}}
function controlled() {
  const starts=new Map<string,MemberStart>();const outputs=new Map<string,(output:MemberOutput)=>void>();const sent:MemberInput[]=[];
  const launcher:MemberLauncher=(start,output,_exit)=>{starts.set(start.attemptId,start);outputs.set(start.attemptId,output);setTimeout(()=>output({v:1,type:'ready',sessionId:`member-${start.attemptId}`,sessionFile:join(start.sessionDir,'history.jsonl')}),0);return {send:message=>{sent.push(message);},stop:()=>{}};};
  return {launcher,starts,outputs,sent};
}

test('DAG validation rejects cycles, duplicate ids, and absent dependencies before storage',async()=>{
  const f=fixture();const controller=new SwarmController();
  try {
    await assert.rejects(controller.dispatch('create',{goal:'cycle',tasks:[spec('a','read',['b']),spec('b','read',['a'])]},f.context),/循环/);
    await assert.rejects(controller.dispatch('create',{goal:'duplicate',tasks:[spec('a'),spec('a')]},f.context),/重复/);
    await assert.rejects(controller.dispatch('create',{goal:'missing',tasks:[spec('a','read',['missing'])]},f.context),/不存在/);
    assert.equal(snapshot(controller,f.context).graphs.length,0);
  }finally {await controller.dispose();f.cleanup();}
});
test('a running graph is scoped to its owning session and project history is read-only',async()=>{
  const f=fixture();const controller=new SwarmController();
  try {const graph=await controller.dispatch('create',{goal:'own session',tasks:[spec('a')]},f.context) as Graph;makeRunning(controller,graph,f.context);controller.claim(graph.id,'a',f.context);const other={...f.context,sessionId:'other-session'};assert.equal(snapshot(controller,other).graphs.length,0);await assert.rejects(controller.dispatch('pause',{graphId:graph.id},other),/当前会话/);const history=await controller.dispatch('history',{},other) as {graphs:Graph[];readOnly:boolean};assert.equal(history.graphs.length,1);assert.equal(history.readOnly,true);assert.equal(snapshot(controller,f.context).graphs[0].status,'running');}finally {await controller.dispose();f.cleanup();}
});
test('SQLite claim race grants exactly one attempt across independent controllers',async()=>{
  const f=fixture();const first=new SwarmController();const second=new SwarmController();
  try {
    const graph=await first.dispatch('create',{goal:'race',tasks:[spec('a')]},f.context) as Graph;makeRunning(first,graph,f.context);
    const results=await Promise.allSettled([Promise.resolve().then(()=>first.claim(graph.id,'a',f.context)),Promise.resolve().then(()=>second.claim(graph.id,'a',f.context))]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(snapshot(first,f.context).graphs[0].attempts.length,1);
  }finally {await first.dispose();await second.dispose();f.cleanup();}
});
test('claim enforces dependencies and serializes non-Git writers while allowing readers',async()=>{
  const f=fixture();const controller=new SwarmController();
  try {
    const graph=await controller.dispatch('create',{goal:'non-git',tasks:[spec('a','write'),spec('b','write'),spec('c'),spec('d','read',['a'])]},f.context) as Graph;makeRunning(controller,graph,f.context);
    controller.claim(graph.id,'a',f.context);assert.throws(()=>controller.claim(graph.id,'b',f.context),/串行/);controller.claim(graph.id,'c',f.context);assert.throws(()=>controller.claim(graph.id,'d',f.context),/依赖/);
  }finally {await controller.dispose();f.cleanup();}
});
test('Swarm inherits off/high at actual start and keeps the existing execution snapshot on resume',async()=>{
  const f=fixture();const worker=controlled();const controller=new SwarmController(worker.launcher);
  try {
    const off={...f.context,origin:'user' as const,thinkingLevel:'off'};const high={...off,thinkingLevel:'high'};
    const a=await controller.dispatch('create',{goal:'off inheritance',tasks:[spec('a')]},off) as Graph;assert.equal(a.thinkingLevel,'off');await controller.dispatch('start',{graphId:a.id},off);await waitFor(()=>worker.starts.size===1);assert.equal([...worker.starts.values()][0].thinkingLevel,'off');
    await controller.dispatch('pause',{graphId:a.id},off);await controller.dispatch('resume',{graphId:a.id,confirmUnknown:true,thinkingLevel:'high'},high);await waitFor(()=>worker.starts.size===2);assert.equal([...worker.starts.values()][1].thinkingLevel,'off');assert.equal(snapshot(controller,off).graphs.find(graph=>graph.id===a.id)!.thinkingLevel,'off');await controller.dispatch('pause',{graphId:a.id},off);
    const b=await controller.dispatch('create',{goal:'high inheritance',tasks:[spec('b')]},off) as Graph;await controller.dispatch('start',{graphId:b.id},high);await waitFor(()=>worker.starts.size===3);assert.equal([...worker.starts.values()][2].thinkingLevel,'high','latest user selection at actual launch is authoritative');await controller.dispatch('pause',{graphId:b.id},high);
    const c=await controller.dispatch('create',{goal:'explicit override',tasks:[spec('c')]},high) as Graph;await controller.dispatch('start',{graphId:c.id,thinkingLevel:'off'},high);await waitFor(()=>worker.starts.size===4);assert.equal([...worker.starts.values()][3].thinkingLevel,'off');
    await assert.rejects(controller.dispatch('create',{goal:'invalid',thinkingLevel:'unsupported',tasks:[spec('bad')]},high),/未知思考等级/);
  }finally{await controller.dispose();f.cleanup();}
});
test('shared files use durable version CAS and immutable atomic version files',async()=>{
  const f=fixture();const first=new SwarmController();const second=new SwarmController();
  try {
    const graph=await first.dispatch('create',{goal:'shared',tasks:[spec('a')]},f.context) as Graph;
    const created=await first.dispatch('shared.write',{graphId:graph.id,name:'接口约定',content:'v1',expectedRevision:0},f.context) as {file:string};
    const updated=await second.dispatch('shared.write',{graphId:graph.id,name:'接口约定',content:'v2',expectedRevision:1},f.context) as {file:string};
    await assert.rejects(first.dispatch('shared.write',{graphId:graph.id,name:'接口约定',content:'lost-update',expectedRevision:1},f.context),/版本/);
    assert.equal(readFileSync(created.file,'utf8'),'v1');assert.equal(readFileSync(updated.file,'utf8'),'v2');assert.equal(snapshot(first,f.context).shared[0].revision,2);
    await assert.rejects(first.dispatch('shared.write',{graphId:graph.id,name:'../escape',content:'x',expectedRevision:0},f.context),/无效/);
  }finally {await first.dispose();await second.dispose();f.cleanup();}
});
test('cross-attempt late result is rejected after explicit resume',async()=>{
  const f=fixture();const controlledWorker=controlled();const controller=new SwarmController(controlledWorker.launcher);
  try {
    const graph=await controller.dispatch('create',{goal:'resume',tasks:[spec('a')]},f.context) as Graph;await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>controlledWorker.starts.size===1);const old=snapshot(controller,f.context).graphs[0].attempts[0];
    await controller.dispatch('pause',{graphId:graph.id},f.context);
    await assert.rejects(controller.dispatch('resume',{graphId:graph.id},f.context),/confirmUnknown/);
    await controller.dispatch('resume',{graphId:graph.id,confirmUnknown:true},f.context);await waitFor(()=>controlledWorker.starts.size===2);
    controlledWorker.outputs.get(old.id)!({v:1,type:'settled',summary:'late stale result'});
    await assert.rejects(controller.dispatch('result',{graphId:graph.id,attemptId:old.id,summary:'model forged result'},f.context),/未知 Swarm 操作/);
    const current=snapshot(controller,f.context).graphs[0];assert.equal(current.attempts[0].status,'unknown');assert.notEqual(current.tasks[0].currentAttempt,old.id);
  }finally {await controller.dispose();f.cleanup();}
});
test('messages persist before delivery and processing receipt follows actual member acknowledgement',async()=>{
  const f=fixture();const worker=controlled();const controller=new SwarmController(worker.launcher);
  try {
    const graph=await controller.dispatch('create',{goal:'messages',tasks:[spec('a')]},f.context) as Graph;
    const message=await controller.dispatch('send',{graphId:graph.id,to:'a',body:'new constraint'},f.context) as {id:string};assert.equal(snapshot(controller,f.context).messages[0].deliveredAt,undefined);
    await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>worker.sent.length===1);
    const attempt=[...worker.starts.keys()][0];assert.ok(snapshot(controller,f.context).messages[0].deliveredAt);assert.equal(snapshot(controller,f.context).messages[0].processedAt,undefined);
    worker.outputs.get(attempt)!({v:1,type:'processed',messageId:message.id});assert.ok(snapshot(controller,f.context).messages[0].processedAt);
    worker.outputs.get(attempt)!({v:1,type:'ready',sessionId:`member-${attempt}`});assert.equal(worker.sent.length,1,'ready replay must not duplicate delivered message');
  }finally {await controller.dispose();f.cleanup();}
});
test('cold recovery marks a vanished owner unknown and does not launch or replay',async()=>{
  const f=fixture();const first=new SwarmController();const worker=controlled();
  try {
    const graph=await first.dispatch('create',{goal:'recover',tasks:[spec('a')]},f.context) as Graph;makeRunning(first,graph,f.context);first.claim(graph.id,'a',f.context);
    const store=new RecordStore('swarm',f.context.dataDir);const doc=store.get<Graph>(`graph:fixture:${graph.id}`)!;doc.value.attempts[0].ownerPid=2147483647;store.put(doc.key,doc.value,doc.revision);store.close();
    const second=new SwarmController(worker.launcher);try {const recovered=snapshot(second,f.context).graphs[0];assert.equal(recovered.status,'paused');assert.equal(recovered.attempts[0].status,'unknown');assert.equal(worker.starts.size,0);}finally {await second.dispose();}
  }finally {await first.dispose();f.cleanup();}
});
test('dirty Git baseline is rejected without touching user files or creating members',async()=>{
  const f=fixture(true);const worker=controlled();const controller=new SwarmController(worker.launcher);
  try {writeFileSync(join(f.project,'original.txt'),'user draft\n');const graph=await controller.dispatch('create',{goal:'dirty',tasks:[spec('a','write')]},f.context) as Graph;await assert.rejects(controller.dispatch('start',{graphId:graph.id},f.context),/未提交/);assert.equal(readFileSync(join(f.project,'original.txt'),'utf8'),'user draft\n');assert.equal(worker.starts.size,0);assert.equal(snapshot(controller,f.context).graphs[0].status,'created');}
  finally {await controller.dispose();f.cleanup();}
});
test('prepare validates completed tasks and returns immediately while one actual reviewer owns completion',async()=>{
  const f=fixture();const worker=controlled();const controller=new SwarmController(worker.launcher);
  try{
    const graph=await controller.dispatch('create',{goal:'queued review',tasks:[spec('a')]},f.context) as Graph;await assert.rejects(controller.dispatch('prepare',{graphId:graph.id},f.context),/所有成果完成/);assert.equal(worker.starts.size,0);
    const store=new RecordStore('swarm',f.context.dataDir);const saved=store.get<Graph>(`graph:${f.context.projectId}:${graph.id}`)!;saved.value.tasks[0].status='completed';saved.value.status='paused';store.put(saved.key,saved.value,saved.revision);store.close();
    const result=await Promise.race([controller.dispatch('prepare',{graphId:graph.id},f.context),new Promise<never>((_done,reject)=>{const timer=setTimeout(()=>reject(new Error('prepare blocked the request bridge')),500);timer.unref();})]) as Graph;assert.equal(result.status,'awaiting_review');await controller.dispatch('review',{graphId:graph.id},f.context);assert.equal(worker.starts.size,1,'repeated prepare/review must share the running review');const start=[...worker.starts.values()][0];assert.equal(start.reviewResult,true);assert.equal(start.mode,'read');assert.deepEqual(start.writeScopes,[]);assert.match(start.prompt,/read\/grep\/find\/ls/);assert.match(start.prompt,/swarm_review_result/);
    worker.outputs.get(start.attemptId)!({v:1,type:'failed',error:'missing native result'});await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');assert.match(snapshot(controller,f.context).graphs[0].error!,/missing native result/);assert.equal(snapshot(controller,f.context).graphs[0].tasks[0].status,'completed');assert.equal(readFileSync(join(f.project,'original.txt'),'utf8'),'original\n');
    const second=await controller.dispatch('prepare',{graphId:graph.id},f.context) as Graph;assert.equal(second.status,'awaiting_review');assert.equal(worker.starts.size,2);const next=[...worker.starts.values()][1];worker.outputs.get(next.attemptId)!({v:1,type:'settled',summary:'{"approved":true,"findings":"checked actual source"}'});await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='integrated');await controller.dispatch('prepare',{graphId:graph.id},f.context);assert.equal(worker.starts.size,2,'integrated review must remain an early return');
  }finally{await controller.dispose();f.cleanup();}
});
function completingLauncher(reviewApproved=true): MemberLauncher {
  return (start,output,_exited)=>{
    const timer=setTimeout(()=>{output({v:1,type:'ready',sessionId:`member-${start.attemptId}`});if (start.taskId==='independent-review') output({v:1,type:'settled',summary:JSON.stringify({approved:reviewApproved,findings:reviewApproved?'Read source files; objective check passed':'Needs revision based on actual source',...(reviewApproved?{}:{taskIds:['a']})}),sessionId:`member-${start.attemptId}`});else {if (start.mode==='write') writeFileSync(join(start.cwd,`${start.taskId}.txt`),`${start.taskId} outcome\n`);output({v:1,type:'settled',summary:`${start.taskId} completed with local self-check`,sessionId:`member-${start.attemptId}`});}},10);
    return {send:()=>{},stop:()=>clearTimeout(timer)};
  };
}
test('real Git attempts and independent integration are separate, reviewed and fast-forwarded',async()=>{
  const f=fixture(true);const controller=new SwarmController(completingLauncher());
  try {
    const graph=await controller.dispatch('create',{goal:'deliver',tasks:[spec('a','write'),spec('b','write',['a'])],checks:[{command:process.execPath,args:['-e','require("node:fs").readFileSync("a.txt");require("node:fs").readFileSync("b.txt")']}]},f.context) as Graph;
    await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='integrated');
    const result=snapshot(controller,f.context).graphs[0];assert.equal(result.attempts.length,2);assert.notEqual(result.attempts[0].cwd,result.attempts[1].cwd);assert.notEqual(result.integration!.cwd,result.attempts[0].cwd);assert.ok(result.integration!.review!.approved);assert.ok(result.integration!.checks.every(c=>c.exitCode===0));assert.equal(readFileSync(join(f.project,'b.txt'),'utf8'),'b outcome\n');assert.ok(existsSync(result.attempts[0].cwd),'member workspaces must be preserved');
  }finally {await controller.dispose();f.cleanup();}
});
test('changed source baseline preserves integration without overwriting a new user draft',async()=>{
  const f=fixture(true);const worker=controlled();const controller=new SwarmController(worker.launcher);
  try {
    const graph=await controller.dispatch('create',{goal:'changed baseline',tasks:[spec('a','write')]},f.context) as Graph;await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>worker.starts.size===1);
    const start=[...worker.starts.values()][0];writeFileSync(join(start.cwd,'a.txt'),'result\n');writeFileSync(join(f.project,'original.txt'),'new user draft\n');worker.outputs.get(start.attemptId)!({v:1,type:'settled',summary:'done'});
    await waitFor(()=>[...worker.starts.values()].some(s=>s.taskId==='independent-review'));const review=[...worker.starts.values()].find(s=>s.taskId==='independent-review')!;worker.outputs.get(review.attemptId)!({v:1,type:'settled',summary:'{"approved":true,"findings":"checked source and diff"}'});
    await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');assert.match(snapshot(controller,f.context).graphs[0].error!,/基线或工作区/);assert.equal(readFileSync(join(f.project,'original.txt'),'utf8'),'new user draft\n');assert.equal(existsSync(join(f.project,'a.txt')),false);
  }finally {await controller.dispose();f.cleanup();}
});
test('failed independent submission retains Git results and explicit reprepare never replays completed members',async()=>{
  const f=fixture(true);const worker=controlled();const controller=new SwarmController(worker.launcher);
  try{
    const graph=await controller.dispatch('create',{goal:'retained review failure',tasks:[spec('a','write')]},f.context) as Graph;const baseline=execFileSync('git',['rev-parse','HEAD'],{cwd:f.project,encoding:'utf8'}).trim();await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>worker.starts.size===1);const member=[...worker.starts.values()][0];writeFileSync(join(member.cwd,'a.txt'),'retained result\n');worker.outputs.get(member.attemptId)!({v:1,type:'settled',summary:'actual member result'});
    await waitFor(()=>[...worker.starts.values()].some(start=>start.reviewResult));const first=[...worker.starts.values()].find(start=>start.reviewResult)!;worker.outputs.get(first.attemptId)!({v:1,type:'failed',error:'conflicting native review submissions'});await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');const paused=snapshot(controller,f.context).graphs[0];assert.ok(existsSync(paused.integration!.cwd));assert.equal(readFileSync(join(paused.integration!.cwd,'a.txt'),'utf8'),'retained result\n');assert.equal(existsSync(join(f.project,'a.txt')),false);assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:f.project,encoding:'utf8'}).trim(),baseline);assert.equal(paused.tasks[0].status,'completed');
    await controller.dispatch('prepare',{graphId:graph.id},f.context);await waitFor(()=>[...worker.starts.values()].filter(start=>start.reviewResult).length===2);assert.equal([...worker.starts.values()].filter(start=>!start.reviewResult).length,1,'reprepare must only replace the read-only reviewer');const second=[...worker.starts.values()].filter(start=>start.reviewResult)[1];worker.outputs.get(second.attemptId)!({v:1,type:'failed',error:'missing native review result'});await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');assert.ok(existsSync(first.cwd));assert.ok(existsSync(second.cwd));assert.equal(existsSync(join(f.project,'a.txt')),false);
  }finally{await controller.dispose();f.cleanup();}
});
test('launcher failure retains isolation and never falls back into project root',async()=>{
  const f=fixture(true);const paths:string[]=[];const controller=new SwarmController(start=>{paths.push(start.cwd);throw new Error('worker unavailable');});
  try {const graph=await controller.dispatch('create',{goal:'isolated failure',tasks:[spec('a','write')]},f.context) as Graph;await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');const attempt=snapshot(controller,f.context).graphs[0].attempts[0];assert.equal(attempt.status,'failed');assert.notEqual(paths[0],f.project);assert.ok(existsSync(paths[0]));assert.equal(readFileSync(join(f.project,'original.txt'),'utf8'),'original\n');}
  finally {await controller.dispose();f.cleanup();}
});
test('failed objective check blocks independent review and source integration',async()=>{
  const f=fixture(true);const controller=new SwarmController(completingLauncher());
  try {const graph=await controller.dispatch('create',{goal:'checks fail',tasks:[spec('a','write')],checks:[{command:process.execPath,args:['-e','process.exit(7)']}]},f.context) as Graph;await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>snapshot(controller,f.context).graphs[0].status==='paused');const result=snapshot(controller,f.context).graphs[0];assert.equal(result.integration!.checks.at(-1)!.exitCode,7);assert.equal(result.integration!.review,undefined);assert.equal(existsSync(join(f.project,'a.txt')),false);}
  finally {await controller.dispose();f.cleanup();}
});
test('independent rejection stops after exactly two automatic rework rounds',async()=>{
  const f=fixture(true);const controller=new SwarmController(completingLauncher(false));
  try {const graph=await controller.dispatch('create',{goal:'bounded rework',tasks:[spec('a','write')]},f.context) as Graph;await controller.dispatch('start',{graphId:graph.id},f.context);await waitFor(()=>snapshot(controller,f.context).graphs[0].error?.includes('上限')===true);const result=snapshot(controller,f.context).graphs[0];assert.equal(result.reworkRound,2);assert.equal(result.attempts.length,3);assert.equal(result.status,'paused');assert.equal(existsSync(join(f.project,'a.txt')),false);assert.ok(result.attempts.every(a=>existsSync(a.cwd)));}
  finally {await controller.dispose();f.cleanup();}
});
test('tool boundary blocks read/write escapes, nested writes, recursive spawning and unconfirmed destructive bash',async()=>{
  const f=fixture();const callbacks=new Map<string,(event:unknown)=>Promise<unknown>>();
  const pi={on:(name:string,callback:(event:unknown)=>Promise<unknown>)=>{callbacks.set(name,callback);}} as unknown as ExtensionAPI;
  const start:MemberStart={v:1,type:'start',graphId:'g',taskId:'t',attemptId:'a',cwd:f.project,dataDir:f.context.dataDir,agentDir:join(f.root,'pi'),sessionDir:join(f.root,'sessions'),mode:'write',writeScopes:['allowed'],prompt:'task'};
  try {guardMember(start,async()=>false)(pi);const call=callbacks.get('tool_call')!;assert.deepEqual(await call({toolName:'write',input:{path:'../escape.txt'},toolCallId:'parent/1',parentToolCallId:'parent'}),{block:true,reason:'路径超出成员工作区'});assert.ok(await call({toolName:'edit',input:{path:'original.txt'}}));assert.equal(await call({toolName:'write',input:{path:'allowed/result.txt'}}),undefined);assert.ok(await call({toolName:'bash',input:{command:'rm original.txt'}}));assert.ok(await call({toolName:'friend_swarm',input:{}}));assert.equal(contains(f.project,join(f.project,'../escape')),false);}
  finally {f.cleanup();}
});
