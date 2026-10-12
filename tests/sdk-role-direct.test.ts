import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {digest} from '../packages/core/src/index.js';
import {blockedByFrozenRole,type FrozenRole} from '../packages/expert/src/roles.js';

interface WorkerMessage {type:string;id?:string;error?:string;result?:unknown;event?:{type:string;data:Record<string,unknown>}}
async function worker(){
 const directory=mkdtempSync(join(tmpdir(),'friend-sdk-role-direct-')),events:WorkerMessage[]=[],pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
 let stderr='',finished=false,readyResolve:()=>void=()=>{},readyReject:(error:Error)=>void=()=>{};
 const ready=new Promise<void>((yes,no)=>{readyResolve=yes;readyReject=no;});
 const child=fork(resolve('apps/desktop/dist/sdk-worker.mjs'),[],{execPath:process.execPath,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,PI_OFFLINE:'1',FRIEND_PI_ROOT:resolve('.'),FRIEND_PI_PROJECT:directory,FRIEND_PI_DATA_DIR:join(directory,'data'),FRIEND_PI_TEST_PROVIDER:'1',FRIEND_PI_MEMBER_WORKER:resolve('packages/swarm/dist/member.js')}});
 child.stderr?.on('data',bytes=>stderr+=String(bytes));
 const exited=new Promise<void>(done=>child.once('exit',(code,signal)=>{finished=true;const error=new Error(`SDK worker exited (${code??signal}): ${stderr}`);readyReject(error);for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();done();}));
 child.on('error',readyReject);
 child.on('message',(message:WorkerMessage)=>{events.push(message);if(message.type==='ready')readyResolve();if(message.type==='fatal')readyReject(new Error(message.error));if(message.type==='response'&&message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(new Error(message.error)):item.resolve(message.result);}});
 const request=(method:string,input:Record<string,unknown>={})=>new Promise<unknown>((yes,no)=>{if(finished||!child.connected){no(new Error('SDK worker disconnected'));return;}const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);no(new Error(`${method} timeout: ${stderr}`));},15000);pending.set(id,{resolve:yes,reject:no,timer});child.send({type:'request',id,method,input});});
 const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+15000;while(!predicate()){if(finished||Date.now()>deadline)throw new Error(`SDK condition timeout: ${stderr}`);await new Promise(done=>setTimeout(done,25));}};
 const close=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([(async()=>{if(!finished)await request('shutdown');await exited;})(),new Promise<never>((_,no)=>{timer=setTimeout(()=>{child.kill('SIGKILL');no(new Error(`SDK shutdown timeout: ${stderr}`));},15000);})]);}finally{clearTimeout(timer);rmSync(directory,{recursive:true,force:true});}};
 const boot=setTimeout(()=>readyReject(new Error(`SDK boot timeout: ${stderr}`)),20000);try{await ready;}catch(error){child.kill('SIGKILL');await exited;rmSync(directory,{recursive:true,force:true});throw error;}finally{clearTimeout(boot);}
 return {directory,events,request,wait,close};
}

for(const roleId of ['researcher','planner','reviewer'])test(`Swarm ${roleId} completes a permitted direct task without gaining collaboration authority`,{timeout:30000},async()=>{
 let calls=0;
 const answer=roleId==='reviewer'?{approved:true,findings:'只读核对：2+2=4，无需成员执行。',taskIds:[]}:{summary:'2+2=4，已直接核对。',evidence:['将两个2相加得到4；没有项目写入或成员执行。'],risks:[]};
 const server=createServer(async(req,res)=>{for await(const _chunk of req){}calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});for(const choice of [{delta:{role:'assistant',content:JSON.stringify(answer)},finish_reason:null},{delta:{},finish_reason:'stop'}])res.write(`data: ${JSON.stringify({id:'role-direct',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);res.end('data: [DONE]\n\n');});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();assert.ok(address&&typeof address==='object');
 let fixture:Awaited<ReturnType<typeof worker>>|undefined;
 try{
  fixture=await worker();const f=fixture;
  await f.request('configure',{plugins:['swarm','expert']});
  await f.request('provider.save',{provider:'role-direct-http',modelId:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,api:'openai-completions',apiKey:'test-only-local-credential'});
  await f.request('plugin',{plugin:'expert',action:'role.assign',input:{id:roleId}});
  await f.request('send',{text:'只读核对2+2是多少。这个简单问题直接给出符合当前角色合同的答案，不需要分工、成员或项目修改。',mode:'swarm'});
  await f.wait(()=>f.events.some(message=>message.event?.type==='state'&&message.event.data.lifecycleStatus==='completed'&&message.event.data.isRunning===false));
  const state=await f.request('state') as {runId:string;executionMode:string;sessionFile:string;isRunning:boolean;lifecycleStatus:string};
  assert.equal(state.executionMode,'swarm');assert.equal(state.lifecycleStatus,'completed');assert.equal(state.isRunning,false);assert.equal(calls,1,'a permitted direct role task must not trigger a corrective model request');
  const snapshot=await f.request('plugin',{plugin:'swarm',action:'snapshot'}) as {graphs:unknown[]};assert.deepEqual(snapshot.graphs,[]);
  const role=await f.request('plugin',{plugin:'expert',action:'role.snapshot'}) as {current:FrozenRole;roles:{id:string;tools:string[];writeScopes:string[]}[]};
  assert.equal(role.current.id,roleId);assert.deepEqual(role.current.effectiveWriteScopes,[]);
  const definition=role.roles.find(item=>item.id===roleId)!;assert.ok(definition);assert.ok(role.current.effectiveTools.every(tool=>definition.tools.includes(tool)));
  assert.equal(role.current.effectiveTools.includes('friend_swarm'),false);assert.ok(blockedByFrozenRole(role.current,'friend_swarm',{action:'create'},f.directory));assert.ok(blockedByFrozenRole(role.current,'write',{path:'outside-scope.txt',content:'must remain blocked'},f.directory));
  const entries=readFileSync(state.sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(entries.filter(entry=>entry.customType==='friend-pi.swarm.correction.v1').length,0);
  const plans=entries.filter(entry=>entry.customType==='friend-pi.swarm.plan.v1'&&entry.data.runId===state.runId);assert.equal(plans.length,1);const plan=plans[0].data;
  assert.equal(plan.strategy,'direct');assert.equal(plan.authority,'host-role-boundary');assert.equal(plan.expandsAuthority,false);assert.deepEqual(plan.role,{id:roleId,version:role.current.version,hash:digest(role.current)});
  assert.match(plan.verificationRequired,/objective/);assert.match(plan.verificationRequired,/independent-review/);assert.ok(plan.reason);
  assert.equal(entries.filter(entry=>entry.customType==='friend-pi.run.policy.v1'&&entry.data.runId===state.runId).at(-1).data.requiresSwarm,false);
  const delivery=entries.filter(entry=>entry.customType==='friend-pi.expert.delivery'&&entry.data.runId===state.runId);assert.equal(delivery.length,1);assert.equal(delivery[0].data.roleId,roleId);assert.equal(delivery[0].data.approved,true);
 }finally{if(fixture)await fixture.close();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
