import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {SwarmController,type Graph,type MemberLauncher,type MemberOutput,type MemberStart,type StopObject} from '../src/index.js';
import type {PluginContext} from '@friend-pi/core';

async function drain(){for(let i=0;i<20;i++)await nextTurn();}
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'friend-member-startup-')),project=join(root,'project');mkdirSync(project);
 const ctx:PluginContext={dataDir:join(root,'data'),projectDir:project,projectId:'startup',sessionId:'chat',modelId:'fake/offline',executionMode:'swarm',origin:'user',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>'',request:async()=>{throw Error('optional plugin absent');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 let start!:MemberStart,send!:(message:MemberOutput)=>void,stops=0;
 const launcher:MemberLauncher=(input,output)=>{start=input;send=message=>output({...message,v:2,protocol:2,memberId:input.memberId,generation:input.generation,attemptId:input.attemptId});let ended!:(receipt:StopObject)=>void;const closed=new Promise<StopObject>(done=>{ended=done;});return {closed,send:()=>{},stop:async()=>{stops++;const receipt:StopObject={id:input.attemptId,kind:'member',status:'terminated'};ended(receipt);return receipt;}};};
 const controller=new SwarmController(launcher),created=await controller.dispatch('create',{goal:'Native startup lifecycle',deferPreparation:true,tasks:[{id:'read',title:'read',prompt:'read fixture',mode:'read',dependencies:[]}]},ctx) as Graph;
 return {controller,ctx,id:created.id,begin:async()=>{await controller.dispatch('start',{graphId:created.id},ctx);await drain();assert.ok(start);},send:(message:MemberOutput)=>send(message),stops:()=>stops,graph:()=>((controller.snapshot(ctx) as {graphs:Graph[]}).graphs.find(graph=>graph.id===created.id)!),close:async()=>{await controller.dispose();rmSync(root,{recursive:true,force:true});}};
}

test('a valid native member may become ready after ten seconds and its old startup deadline cannot fail it',async t=>{
 const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
 try{await f.begin();t.mock.timers.tick(10001);await drain();assert.equal(f.graph().status,'running');assert.equal(f.stops(),0);f.send({v:1,type:'ready',sessionId:'native-startup'});await drain();t.mock.timers.tick(45000);await drain();assert.equal(f.graph().status,'running');assert.equal(f.graph().attempts[0].sessionId,'native-startup');assert.equal(f.stops(),0);}finally{await f.close();t.mock.timers.reset();}
});

test('a native pre-inference quota denial remains authoritative after the startup deadline',async t=>{
 const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
 try{await f.begin();f.send({v:1,type:'failed',error:'试用额度已达 3 次'});await drain();assert.equal(f.graph().status,'paused');assert.match(f.graph().error||'',/试用额度/);t.mock.timers.tick(45000);await drain();assert.match(f.graph().error||'',/试用额度/);assert.equal(f.stops(),1);}finally{await f.close();t.mock.timers.reset();}
});

test('a member without a ready handshake is stopped at the bounded startup deadline and late readiness cannot revive it',async t=>{
 const f=await fixture();t.mock.timers.enable({apis:['setTimeout']});
 try{await f.begin();t.mock.timers.tick(44999);await drain();assert.equal(f.graph().status,'running');t.mock.timers.tick(1);await drain();assert.equal(f.graph().status,'paused');assert.match(f.graph().error||'',/启动超时/);assert.equal(f.stops(),1);f.send({v:1,type:'ready',sessionId:'late-native'});await drain();assert.equal(f.graph().status,'paused');assert.equal(f.graph().attempts[0].sessionId,undefined);}finally{await f.close();t.mock.timers.reset();}
});
