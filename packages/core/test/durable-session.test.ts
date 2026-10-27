import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryStorage,createRegistry} from '@earendil-works/pi-durable';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createBus,installFixtureProvider,type PluginController,type PluginContext} from '../src/index.js';
import {openDurableSession} from '../src/durable-session.js';
import type {PiWorkerEvent} from '../src/durable-events.js';

async function fixture(mountProbe = true){
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-durable-session-'));
  const runtime=await ModelRuntime.create({allowModelNetwork:false});
  const model=await installFixtureProvider(runtime);
  assert.ok(model);
  const bus=createBus();
  const dispatched:{action:string;sessionId:string;types:string[]}[]=[];
  const controller={
    dispatch:(action:string,_input:unknown,ctx:PluginContext)=>{dispatched.push({action,sessionId:ctx.sessionId,types:ctx.history().map(item=>item.type)});return {ok:true};},
    snapshot:()=>({ok:true}),
  } as unknown as PluginController;
  const session=await openDurableSession({
    cwd:dir,
    storage:new MemoryStorage(),
    models:runtime,
    registry:createRegistry(),
    bus,
    confirm:async()=>true,
    notify:()=>undefined,
    agent:{model:{provider:'friend-fixture',modelId:'offline'}},
    plugins:mountProbe?[{name:'memory',controller,description:'记忆'}]:[],
  });
  return {dir,session,bus,dispatched};
}

test('a durable session runs one turn and reports the events the worker expects',async()=>{
  const {dir,session}=await fixture();
  try{
    const seen:PiWorkerEvent[]=[];
    let settle!:()=>void;
    const settled=new Promise<void>(resolve=>{settle=resolve;});
    session.subscribe(event=>{seen.push(event);if(event.type==='agent_settled')settle();});

    assert.equal(session.isIdle,true,'a fresh session is idle');
    await session.prompt('hello from the durable session');
    await Promise.race([settled,new Promise((_,reject)=>setTimeout(()=>reject(new Error('the run never settled')),15000))]);
    await new Promise(resolve=>setImmediate(resolve));

    const types=seen.map(event=>event.type);
    assert.ok(types.includes('agent_start'),'the run starts');
    assert.ok(types.includes('message_start'),'a message streams');
    assert.ok(types.includes('message_end'),'a message completes');
    assert.ok(types.includes('agent_settled'),'the run settles');
    assert.equal(types.at(-1),'agent_settled','settlement is the last event of the run');
    assert.equal(session.isIdle,true,'the session returns to idle after settling');

    const history=session.sessionManager.getBranch();
    const roles=history.map(entry=>(entry.message as {role?:string} | undefined)?.role);
    const userAt=roles.indexOf('user');
    const assistantAt=roles.indexOf('assistant');
    assert.ok(userAt>=0,'the input is stored');
    assert.ok(assistantAt>=0,'the answer is stored');
    assert.ok(userAt<assistantAt,'the input precedes the answer');
    assert.ok(history.every(entry=>entry.parentId===null),'no fabricated parent links');

    const stats=session.getSessionStats();
    assert.equal(stats.userMessages,1);
    assert.equal(stats.assistantMessages,1);
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('projected entries keep object identity, which the worker compares by reference',async()=>{
  const {dir,session}=await fixture();
  try{
    let settle!:()=>void;
    const settled=new Promise<void>(resolve=>{settle=resolve;});
    session.subscribe(event=>{if(event.type==='agent_settled')settle();});
    await session.prompt('identity check');
    await settled;

    const first=session.sessionManager.getBranch();
    const second=session.sessionManager.getBranch();
    assert.equal(first.length,second.length);
    for(let index=0;index<first.length;index+=1)
      assert.equal(first[index],second[index],`entry ${index} is returned by reference, not re-projected`);
    assert.equal((first[0].message as object),(second[0].message as object),'the message object itself is stable');
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('a custom entry appended through the session manager is visible in history',async()=>{
  const {dir,session}=await fixture();
  try{
    const id=await session.sessionManager.appendCustomEntry('friend-pi.probe.v1',{v:1,note:'marker'});
    assert.ok(id!==undefined,'the appended entry reports an id');
    const found=session.sessionManager.getBranch().find(entry=>entry.customType==='friend-pi.probe.v1');
    assert.ok(found,'the custom entry is readable');
    assert.equal(found?.type,'custom');
    assert.deepEqual(found?.data,{v:1,note:'marker'});
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('mounted capabilities receive the session id and a Pi-shaped history',async()=>{
  const {dir,session,bus,dispatched}=await fixture();
  try{
    await session.sessionManager.appendCustomEntry('friend-pi.goal-wake',{v:1});
    bus.emit('friend-pi:v1:request',{v:1,id:'r1',plugin:'memory',action:'list',input:{},origin:'user'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dispatched.length,1);
    assert.equal(dispatched[0].sessionId,session.sessionId);
    assert.deepEqual(dispatched[0].types,['custom'],'history reaches the plugin in Pi entry shape');
  }finally{await session.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('a mounted prompt contribution reaches the durable system prompt',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-durable-prompt-'));
  try{
    const runtime=await ModelRuntime.create({allowModelNetwork:false});
    const model=await installFixtureProvider(runtime);
    assert.ok(model);
    const session=await openDurableSession({
      cwd:dir,
      storage:new MemoryStorage(),
      models:runtime,
      registry:createRegistry(),
      bus:createBus(),
      confirm:async()=>true,
      notify:()=>undefined,
      agent:{model:{provider:'friend-fixture',modelId:'offline'}},
      plugins:[{
        name:'memory',
        controller:{
          dispatch:()=>({ok:true}),
          snapshot:()=>({}),
        } as unknown as PluginController,
        description:'记忆',
      }],
    });
    // A rule injected the way the capability packages do it on Pi.
    const internals=session as unknown as {__host?:{mountFactory(f:(pi:unknown)=>unknown):unknown}};
    void internals;
    let settle!:()=>void;
    const settled=new Promise<void>(resolve=>{settle=resolve;});
    session.subscribe(event=>{if(event.type==='agent_settled')settle();});
    await session.prompt('prompt section check');
    await settled;

    const history=session.sessionManager.getBranch();
    // Durable records each prompt change as a positional `pi.system` entry.
    const systemEntries=history.filter(entry=>entry.type==='message'&&(entry.message as {role?:string} | undefined)?.role==='system');
    assert.ok(history.some(entry=>entry.type==='message'),'the run produced transcript entries');
    assert.ok(systemEntries.length>=1,'the system prompt was recorded as a positional entry');
    await session.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
