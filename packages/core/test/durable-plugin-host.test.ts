import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import {MemoryStorage} from '@earendil-works/pi-durable';
import {createBus,type PluginController,type PluginContext} from '../src/index.js';
import {createDurablePluginHost,durablePiEntries,toPiEntry} from '../src/durable-plugin-host.js';

const workdir=()=>mkdtempSync(join(tmpdir(),'friend-pi-durable-host-'));

/** Minimal controller: records what the plugin boundary actually hands it. */
function probe(seen:{action:string;sessionId:string;types:string[];policy:unknown}[]):PluginController{
  return {
    dispatch:(action:string,_input:unknown,ctx:PluginContext)=>{
      seen.push({action,sessionId:ctx.sessionId,types:ctx.history().map(item=>item.type),policy:ctx.policy});
      return {ok:true};
    },
    snapshot:()=>({ok:true}),
  } as unknown as PluginController;
}

test('toPiEntry keeps customType so plugin customType checks survive a backend swap',()=>{
  const entry=toPiEntry({id:'e1',kind:'friend-pi.expert.run',data:{v:1,runId:'r1'}});
  assert.equal(entry.type,'custom');
  assert.equal(entry.customType,'friend-pi.expert.run');
  assert.deepEqual(entry.data,{v:1,runId:'r1'});
  assert.equal(entry.parentId,null);
});

test('toPiEntry maps message kinds to Pi message entries and compaction to a summary entry',()=>{
  const message=toPiEntry({id:'m1',kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'hi'}],timestamp:1700000000000}]});
  assert.equal(message.type,'message');
  assert.equal(message.customType,undefined);
  assert.equal((message.message as {role:string}).role,'assistant');
  assert.equal(message.timestamp,new Date(1700000000000).toISOString());

  const summary=toPiEntry({id:'c1',kind:'pi.compaction',data:{summary:'早前摘要'}});
  assert.equal(summary.type,'compaction');
  assert.equal(summary.summary,'早前摘要');
});

test('durablePiEntries preserves order, which every history consumer relies on',()=>{
  const entries=durablePiEntries([
    {id:'1',kind:'pi.user',model:[{role:'user',content:'a',timestamp:1}]},
    {id:'2',kind:'friend-pi.input.v1',data:{entryId:'1',textEnd:1,hash:'x'}},
    {id:'3',kind:'pi.assistant',model:[{role:'assistant',content:'b',timestamp:2}]},
  ]);
  assert.deepEqual(entries.map(entry=>entry.id),['1','2','3']);
  assert.deepEqual(entries.map(entry=>entry.type),['message','custom','message']);
});

test('a real memory storage accepts the entry records this projection targets',async()=>{
  const storage=new MemoryStorage();
  const record={id:'1',conversationId:'c1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'真实写入'}],timestamp:1700000000000}]};
  await storage.commit([{type:'entry',value:record} as never],BACKGROUND_CONTEXT);
  const stored=await storage.entry('1' as never,BACKGROUND_CONTEXT);
  assert.ok(stored!==undefined,'the storage persists what Durable itself would write');
  const projected=toPiEntry(stored.entry as never);
  assert.equal(projected.type,'message');
  assert.equal((projected.message as {role:string}).role,'user');
});

test('mounting a controller registers its friend_ tool and command, and answers bus requests',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,
      cwd:dir,
      conversation:{
        id:'sess-1',
        entries:()=>[
          {id:'e1',kind:'pi.user',model:[{role:'user',content:[{type:'text',text:'原话'}],timestamp:1}]},
          {id:'e2',kind:'friend-pi.goal-wake',data:{v:1}},
        ],
        append:()=>'id-1',
        isIdle:()=>true,
      },
      models:{
        available:()=>[{provider:'openai',id:'gpt-test',thinkingLevels:['off','low']}],
        find:(provider,id)=>({provider,id}),
        current:()=>({provider:'openai',id:'gpt-test'}),
        thinkingLevel:()=>'low',
      },
      confirm:async()=>true,
      notify:()=>undefined,
    });

    const seen:{action:string;sessionId:string;types:string[];policy:unknown}[]=[];
    const plugin=host.mount('memory',probe(seen),'记忆');

    assert.equal(plugin.tools.length,1,'one friend_ tool is registered');
    assert.deepEqual([...plugin.commands],['memory']);
    assert.equal((plugin.tools[0] as {name:string}).name,'friend_memory');

    host.sessionStart();

    let response:unknown;
    const off=bus.on('friend-pi:v1:response',raw=>{response=raw;});
    bus.emit('friend-pi:v1:request',{v:1,id:'r1',plugin:'memory',action:'list',input:{},origin:'user'});
    await new Promise(resolve=>setImmediate(resolve));
    off();

    assert.equal(seen.length,1,'the controller received the bus request');
    assert.equal(seen[0].action,'list');
    assert.equal(seen[0].sessionId,'sess-1');
    assert.deepEqual(seen[0].types,['message','custom'],'history arrives in Pi entry shape');
    assert.equal((response as {result:unknown}).result!==undefined,true,'a result is sent back on the bus');
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a host without a policy provider leaves policy undefined rather than inventing one',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s',entries:()=>[],append:()=>undefined,isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    const seen:{action:string;sessionId:string;types:string[];policy:unknown}[]=[];
    host.mount('probe',probe(seen),'探针');
    host.sessionStart();
    bus.emit('friend-pi:v1:request',{v:1,id:'r2',plugin:'probe',action:'list',input:{},origin:'user'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(seen.length,1);
    assert.equal(seen[0].policy,undefined,'no policy is fabricated when the host cannot supply one');
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the host forwards the policy it is given, so capabilities keep their write scopes',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const policy={v:1 as const,revision:1,stage:'main',canSwitchRole:true,unsettledTools:0,tools:['read'],writeScopes:['.'],executionMode:'single' as const,planMode:false};
    const host=createDurablePluginHost({
      bus,cwd:dir,policy:()=>policy as never,
      conversation:{id:'s',entries:()=>[],append:()=>undefined,isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    const seen:{action:string;sessionId:string;types:string[];policy:unknown}[]=[];
    host.mount('probe',probe(seen),'探针');
    host.sessionStart();
    bus.emit('friend-pi:v1:request',{v:1,id:'r3',plugin:'probe',action:'list',input:{},origin:'user'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(seen.length,1);
    assert.deepEqual(seen[0].policy,policy);
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
