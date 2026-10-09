import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {RecordStore,digest,type PluginContext} from '@friend-pi/core';
import {SwarmController,type Graph,type MemberLauncher,type MemberStart,type MemberOutput,type StopObject} from '../src/index.js';
import {nativeBranch,TeammateStore,teamMessageText} from '../src/teammates.js';
import {MemberInbox} from '../src/member-inbox.js';
import type {AgentSession} from '@earendil-works/pi-coding-agent';

function fixture(){const root=mkdtempSync(join(tmpdir(),'friend-persistent-')),project=join(root,'project'),data=join(root,'data');mkdirSync(project);const events:{name:string;data:unknown}[]=[];const ctx:PluginContext={dataDir:data,projectDir:project,projectId:'project',sessionId:'chat',modelId:'fake/offline',executionMode:'swarm',origin:'user',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>'',request:async()=>{throw Error('optional plugin absent');},emit:(name,data)=>events.push({name,data}),notify:()=>{},appendEntry:()=>{}};return{root,ctx,events,close:()=>rmSync(root,{recursive:true,force:true})};}
const task=(id:string,dependencies:string[]=[])=>({id,title:id,prompt:id,mode:'read',dependencies});
async function wait(check:()=>boolean){const began=Date.now();while(!check()){if(Date.now()-began>10000)throw Error('test timeout');await new Promise(done=>setTimeout(done,10));}}
function controlled(){const starts=new Map<string,MemberStart>(),outputs=new Map<string,(message:MemberOutput)=>void>(),ended=new Map<string,(receipt:StopObject)=>void>(),stops:string[]=[];const launcher:MemberLauncher=(start,output)=>{starts.set(start.attemptId,start);outputs.set(start.attemptId,message=>output({...message,v:2,protocol:2,memberId:start.memberId,generation:start.generation,attemptId:start.attemptId}));const closed=new Promise<StopObject>(done=>ended.set(start.attemptId,done));setImmediate(()=>outputs.get(start.attemptId)!({v:1,type:'ready',sessionId:'native-'+start.memberId}));return{closed,send:()=>{},stop:async()=>{stops.push(start.attemptId);const receipt:StopObject={id:start.attemptId,kind:'member',status:'terminated'};ended.get(start.attemptId)!(receipt);return receipt;}};};return{launcher,starts,outputs,ended,stops};}

test('teammates are chat-owned, names are stable and an active writer cannot be acquired twice',()=>{const f=fixture(),db=new RecordStore('swarm',f.ctx.dataDir),members=new TeammateStore(db);try{const member=members.create({name:'reviewer'},f.ctx);assert.throws(()=>members.get(member.id,{...f.ctx,sessionId:'another'}),/不属于/);const one=members.acquire(member.id,'a','g','t',f.ctx,'runtime');assert.throws(()=>members.acquire(member.id,'b','g','t',f.ctx,'runtime'),/正在执行/);members.release(member.id,'stale',f.ctx);assert.equal(members.get(member.id,f.ctx).state,'running');members.release(member.id,'a',f.ctx);assert.equal(members.acquire(member.id,'b','g2','t2',f.ctx,'runtime').generation,one.generation+1);}finally{db.close();f.close();}});
test('mailbox admission is ordered, idempotent, and never reports IPC delivery as durable context',()=>{const f=fixture(),db=new RecordStore('swarm',f.ctx.dataDir),members=new TeammateStore(db);try{const member=members.create({name:'worker'},f.ctx);const one=members.enqueue(member.id,{messageId:'one',body:'constraint'},f.ctx,'你');assert.equal(one.sequence,1);assert.equal(one.receivedAt,undefined);assert.equal(one.processedAt,undefined);assert.equal(members.enqueue(member.id,{messageId:'one',body:'constraint'},f.ctx,'你').id,one.id);assert.throws(()=>members.enqueue(member.id,{messageId:'one',body:'changed'},f.ctx,'你'),/已变化/);assert.equal(members.enqueue(member.id,{messageId:'two',body:'next'},f.ctx,'你').sequence,2);assert.throws(()=>members.enqueue(member.id,{body:'stale',generation:99},f.ctx,'你'),/代次/);}finally{db.close();f.close();}});
test('lost context ACK is repaired from exact native user entry, and viewing does not rewrite Pi history',()=>{const f=fixture(),db=new RecordStore('swarm',f.ctx.dataDir),members=new TeammateStore(db);try{const member=members.create({name:'worker'},f.ctx),message=members.enqueue(member.id,{body:'durable constraint'},f.ctx,'你');const dir=join(f.ctx.dataDir,'swarm-sessions','project','chat',member.id);mkdirSync(dir,{recursive:true});const manager=SessionManager.create(f.ctx.projectDir,dir);manager.appendMessage({role:'user',content:[{type:'text',text:teamMessageText(message)}],timestamp:Date.now()});members.update(member.id,f.ctx,value=>{value.sessionFile=manager.getSessionFile();value.sessionId=manager.getSessionId();});const before=digest(readFileSync(manager.getSessionFile()!));members.recover(member.id,f.ctx);const receipt=members.messages(member.id,f.ctx)[0];assert.ok(receipt.nativeEntryId);assert.ok(receipt.processedAt);assert.equal(members.history(member.id,f.ctx).entries.length,1);assert.equal(digest(readFileSync(manager.getSessionFile()!)),before);}finally{db.close();f.close();}});
test('single member interruption fences late results, keeps its dependent waiting, and leaves its peer running',async()=>{const f=fixture(),c=controlled(),controller=new SwarmController(c.launcher);try{const graph=await controller.dispatch('create',{goal:'parallel',tasks:[task('alpha'),task('beta'),task('after-alpha',['alpha'])]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>c.starts.size===2);const snap=controller.snapshot(f.ctx) as {graphs:Graph[];teammates:{id:string;name:string;generation:number;state:string}[]};const alpha=snap.teammates.find(member=>member.name==='alpha')!,first=snap.graphs[0].attempts.find(attempt=>attempt.taskId==='alpha')!;await controller.dispatch('member.interrupt',{memberId:alpha.id,generation:alpha.generation},f.ctx);c.outputs.get(first.id)!({v:1,type:'settled',summary:'late'});await new Promise(done=>setTimeout(done,20));const current=(controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs[0];assert.equal(current.tasks.find(item=>item.id==='alpha')!.status,'unknown');assert.equal(current.tasks.find(item=>item.id==='beta')!.status,'running');assert.equal(current.tasks.find(item=>item.id==='after-alpha')!.status,'pending');assert.deepEqual(c.stops,[first.id]);assert.equal(current.status,'running');await assert.rejects(controller.dispatch('member.resume',{memberId:alpha.id},f.ctx),/检查/);}finally{await controller.dispose();f.close();}});
for(const cancel of [false,true])test(`independent review usage keeps native entry identity and fences frames after ${cancel?'cancellation':'settlement'}`,async()=>{
 const f=fixture(),c=controlled(),controller=new SwarmController(c.launcher);
 try{
  const graph=await controller.dispatch('create',{goal:'review usage',tasks:[task('reader')],checks:[]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>c.starts.size===1);
  const member=[...c.starts.values()][0];c.outputs.get(member.attemptId)!({v:1,type:'settled',summary:'read result'});c.ended.get(member.attemptId)!({id:member.attemptId,kind:'member',status:'terminated'});await wait(()=>c.starts.size===2);
  const review=[...c.starts.values()][1];assert.equal(review.v,1);assert.equal(review.reviewResult,true);
  c.outputs.get(review.attemptId)!({v:1,type:'usage',entryId:'native-review-entry',tokens:7});
  const events=()=>f.events.filter(event=>event.name==='swarm.member-usage');assert.equal(events().length,1);assert.deepEqual(events()[0].data,{v:1,graphId:graph.id,memberId:review.attemptId,attemptId:review.attemptId,entryId:'native-review-entry',tokens:7,runId:(controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs[0].runId});
  if(cancel)await controller.dispatch('stop',{graphId:graph.id},f.ctx);
  else {c.outputs.get(review.attemptId)!({v:1,type:'settled',summary:JSON.stringify({approved:true,findings:'readonly review'})});c.ended.get(review.attemptId)!({id:review.attemptId,kind:'member',status:'terminated'});await wait(()=>(controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs[0].status==='integrated');}
  c.outputs.get(review.attemptId)!({v:1,type:'usage',entryId:'late-review-entry',tokens:999});assert.equal(events().length,1);
 }finally{await controller.dispose();f.close();}
});
test('completed member messages are retained while explicitly stopped; model tools cannot self-confirm unknown effects',async()=>{const f=fixture(),controller=new SwarmController();try{const member=await controller.dispatch('member.create',{name:'idle'},f.ctx) as {id:string};const stopped:PluginContext={...f.ctx,policy:{v:1,revision:1,stage:'main',runId:'r',canSwitchRole:false,unsettledTools:0,tools:[],writeScopes:[],executionMode:'swarm' as const,planMode:false,executionStopped:true}};await controller.dispatch('member.send',{memberId:member.id,body:'saved after stop'},stopped);const history=await controller.dispatch('member.history',{memberId:member.id},f.ctx) as {member:{state:string};messages:unknown[]};assert.equal(history.member.state,'paused');assert.equal(history.messages.length,1);await assert.rejects(controller.dispatch('member.resume',{memberId:member.id,confirmUnknown:true},{...f.ctx,origin:'agent'}),/用户/);}finally{await controller.dispose();f.close();}});


test('receiver drains a durable ordered prefix, survives received-before-context crash, and binds exact native entries',()=>{
  const f=fixture(),db=new RecordStore('swarm',f.ctx.dataDir),members=new TeammateStore(db);
  let inbox:MemberInbox|undefined;
  try{
    const member=members.create({name:'ordered'},f.ctx);
    const one=members.enqueue(member.id,{messageId:'one',body:'first'},f.ctx,'你'),two=members.enqueue(member.id,{messageId:'two',body:'second'},f.ctx,'你');
    assert.equal(two.kind,'discussion');const lease=members.acquire(member.id,'attempt','graph','task',f.ctx,'runtime');
    const dir=join(f.ctx.dataDir,'swarm-sessions','project','chat',member.id);mkdirSync(dir,{recursive:true});const manager=SessionManager.create(f.ctx.projectDir,dir);
    const session={sessionManager:manager,get sessionFile(){return manager.getSessionFile();}} as AgentSession;
    const start:MemberStart={v:2,type:'start',memberId:member.id,rootSessionId:'chat',generation:lease.generation,graphId:'graph',taskId:'task',attemptId:'attempt',cwd:f.ctx.projectDir,dataDir:f.ctx.dataDir,agentDir:dir,sessionDir:dir,prompt:'task',mode:'read',writeScopes:[]};
    inbox=new MemberInbox(start,session,()=>{});assert.deepEqual(inbox.receiveOrdered(two.id,two.bodyDigest).map(message=>message.id),['one','two']);assert.equal(members.messages(member.id,f.ctx)[0].processedAt,undefined);assert.ok(members.messages(member.id,f.ctx)[1].receivedAt);
    inbox.close();inbox=new MemberInbox(start,session,()=>{});assert.deepEqual(inbox.receiveOrdered(two.id,two.bodyDigest).map(message=>message.id),['one','two']);
    manager.appendMessage({role:'user',content:[{type:'text',text:teamMessageText(one)}],timestamp:Date.now()});
    manager.appendMessage({role:'assistant',content:[{type:'text',text:'offline'}],api:'openai-completions',provider:'fake',model:'offline',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
    // Crash after native append, before context ACK: history repairs the acknowledgement.
    members.update(member.id,f.ctx,m=>{m.sessionFile=manager.getSessionFile();m.sessionId=manager.getSessionId();});inbox.close();inbox=undefined;members.recover(member.id,f.ctx);
    inbox=new MemberInbox(start,session,()=>{});assert.deepEqual(inbox.receiveOrdered(two.id,two.bodyDigest).map(message=>message.id),['two']);manager.appendMessage({role:'user',content:[{type:'text',text:teamMessageText(two)}],timestamp:Date.now()});inbox.reconcile();
    assert.equal(members.messages(member.id,f.ctx).filter(message=>message.nativeEntryId).length,2);assert.equal(members.messages(member.id,f.ctx)[1].kind,'discussion');assert.equal(members.messages(member.id,f.ctx)[1].contextKind,'constraint');assert.equal(members.messages(member.id,f.ctx)[1].contextGraphId,'graph');assert.equal(members.messages(member.id,f.ctx)[1].contextTaskId,'task');assert.deepEqual(inbox.receiveOrdered(two.id,two.bodyDigest),[]);
    members.update(member.id,f.ctx,m=>{m.generation++;m.state='paused';});assert.equal(inbox.owned(),false);assert.deepEqual(inbox.receiveOrdered(two.id,two.bodyDigest),[]);
  }finally{inbox?.close();db.close();f.close();}
});

test('corrupt native history is rejected without rewrite and a teammate cannot read a foreign session file',()=>{
  const f=fixture(),db=new RecordStore('swarm',f.ctx.dataDir),members=new TeammateStore(db);
  try{const member=members.create({name:'reader'},f.ctx),file=join(f.root,'foreign.jsonl');writeFileSync(file,'{"type":"session","version":3,"id":"foreign"}\n{broken}\n{}\n');const before=readFileSync(file,'utf8');assert.throws(()=>nativeBranch(file),/损坏/);assert.equal(readFileSync(file,'utf8'),before);members.update(member.id,f.ctx,m=>{m.sessionFile=file;});assert.throws(()=>members.history(member.id,f.ctx));members.update(member.id,f.ctx,m=>{m.sessionFile=join(f.root,'missing.jsonl');});assert.throws(()=>members.history(member.id,f.ctx),/历史文件已丢失/);}finally{db.close();f.close();}
});

test('unknown exit receipts block both member and graph resume until the original process closes',async()=>{
  const f=fixture(),c=controlled();let first=true;
  const launcher:MemberLauncher=(start,output,exited)=>{const handle=c.launcher(start,output,exited);if(!first)return handle;first=false;return {...handle,stop:async()=>({id:start.attemptId,kind:'member',status:'unknown'})};};
  const controller=new SwarmController(launcher);
  try{const graph=await controller.dispatch('create',{goal:'unknown boundary',tasks:[task('reader')]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>c.starts.size===1);const attempt=[...c.starts.keys()][0],member=graph.tasks[0].memberId!;await controller.dispatch('member.interrupt',{memberId:member},f.ctx);
    await assert.rejects(controller.dispatch('member.resume',{memberId:member,confirmUnknown:true},f.ctx),/退出收据/);await assert.rejects(controller.dispatch('resume',{graphId:graph.id,confirmUnknown:true},f.ctx),/边界|收据/);
    await controller.dispatch('member.send',{memberId:member,body:'retain while stopping'},f.ctx);assert.equal(c.starts.size,1);
    c.ended.get(attempt)!({id:attempt,kind:'member',status:'terminated'});await wait(()=>(controller.snapshot(f.ctx) as {teammates:{state:string}[]}).teammates[0].state==='paused');await new Promise(done=>setImmediate(done));
    await controller.dispatch('member.resume',{memberId:member,confirmUnknown:true},f.ctx);await wait(()=>c.starts.size===2);assert.equal([...c.starts.values()][1].memberId,member);assert.notEqual([...c.starts.values()][1].generation,[...c.starts.values()][0].generation);
  }finally{await controller.dispose();f.close();}
});


test('prelaunch role failure records a confirmed no-child boundary instead of permanent stopping',async()=>{
 const f=fixture(),controller=new SwarmController(()=>{throw Error('launcher should not run');});
 try{const graph=await controller.dispatch('create',{goal:'bad role',tasks:[{...task('reader'),roleId:'missing-role'}]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);const snap=controller.snapshot(f.ctx) as {graphs:Graph[];teammates:{state:string;stopReceipt:StopObject}[]};assert.equal(snap.graphs[0].tasks[0].status,'blocked');assert.equal(snap.teammates[0].state,'paused');assert.equal(snap.teammates[0].stopReceipt.status,'terminated');assert.match(snap.graphs[0].error!,/角色/);}finally{await controller.dispose();f.close();}
});


test('review keeps native user constraints from an interrupted earlier attempt of the same task',async()=>{
 const f=fixture(),c=controlled(),controller=new SwarmController(c.launcher);let db:RecordStore|undefined,inbox:MemberInbox|undefined;
 try{
  const graph=await controller.dispatch('create',{goal:'constraint survives retry',tasks:[task('reader')]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>c.starts.size===1);const first=[...c.starts.values()][0],memberId=graph.tasks[0].memberId!;
  const sent=await controller.dispatch('member.send',{memberId,body:'必须保留用户的 UTF-8 约束'},f.ctx) as {id:string};db=new RecordStore('swarm',f.ctx.dataDir);const members=new TeammateStore(db),dir=join(f.ctx.dataDir,'swarm-sessions','project','chat',memberId);mkdirSync(dir,{recursive:true});const manager=SessionManager.create(f.ctx.projectDir,dir),native={sessionManager:manager,get sessionFile(){return manager.getSessionFile();}} as AgentSession;inbox=new MemberInbox(first,native,()=>{});const message=inbox.receive(sent.id)!;manager.appendMessage({role:'user',content:[{type:'text',text:teamMessageText(message)}],timestamp:Date.now()});inbox.reconcile();members.update(memberId,f.ctx,m=>{m.sessionFile=manager.getSessionFile();m.sessionId=manager.getSessionId();});inbox.close();inbox=undefined;
  await controller.dispatch('member.interrupt',{memberId},f.ctx);await controller.dispatch('member.resume',{memberId,confirmUnknown:true},f.ctx);await wait(()=>c.starts.size===2);const retry=[...c.starts.values()][1];c.outputs.get(retry.attemptId)!({v:1,type:'settled',summary:'current attempt'});c.ended.get(retry.attemptId)!({id:retry.attemptId,kind:'member',status:'terminated'});await wait(()=>c.starts.size===3);const review=[...c.starts.values()][2];assert.equal(review.reviewResult,true);assert.ok(review.prompt.includes('必须保留用户的 UTF-8 约束'));assert.equal(members.messages(memberId,f.ctx)[0].attemptId,first.attemptId,'the original native receipt must remain attached to its original attempt');
  c.outputs.get(review.attemptId)!({v:1,type:'settled',summary:JSON.stringify({approved:true,findings:'fixture review'})});c.ended.get(review.attemptId)!({id:review.attemptId,kind:'member',status:'terminated'});await wait(()=>(controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs[0].status==='integrated');
 }finally{inbox?.close();await controller.dispose();db?.close();f.close();}
});
