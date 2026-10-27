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

test('worker-level extension factories mount through the same facade and can be disposed',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s',entries:()=>[],append:()=>'x',isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    const appended:{kind:string;data:unknown}[]=[];
    const host2=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s2',entries:()=>[],append:(kind,data)=>{appended.push({kind,data});return 'x';},isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    void host2;
    let disposed=0;
    const dispose=host.mountFactory(pi=>{
      // The worker's own extensions use exactly this surface; none of it may throw on the facade.
      pi.registerTool({name:'read_document'} as never);
      pi.registerCommand('plan' as never,{handler:()=>undefined} as never);
      pi.appendEntry('friend-pi.custom-instructions.v1',{v:1});
      assert.equal(pi.getThinkingLevel(),'off','thinking level is readable through the facade');
      return ()=>{disposed+=1;};
    });
    assert.equal(typeof dispose,'function','the factory disposer is handed back');
    host.sessionStart();
    dispose?.();
    assert.equal(disposed,1,'the factory disposer runs');
    await host2.dispose();
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('before_agent_start splits into a one-per-run side effect and a rendered prompt section',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s',entries:()=>[],append:()=>'x',isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    let begins=0;
    host.mountFactory(pi=>{
      // Side effect: Pi fires this once per turn.
      pi.on('before_agent_start',()=>{begins+=1;});
      // Prompt contribution: Pi expects a replacement prompt.
      pi.on('before_agent_start',event=>({systemPrompt:`${event.systemPrompt}加上的规则`}));
    });

    host.beforeAgentStart();
    assert.equal(begins,1,'the side effect runs once per run');
    assert.equal(host.promptText(),'加上的规则','only the appended text is captured, not the empty base');
    assert.equal(host.promptText(),'加上的规则','reading it again does not re-run handlers');

    host.beforeAgentStart();
    assert.equal(begins,2,'a second run fires the side effect again');

    const extension=host.buildExtension('probe');
    assert.equal(extension.name,'probe');
    assert.equal(extension.sections?.length,1,'the captured prompt becomes exactly one section');
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('mounted friend_ tools are carried into the durable extension',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s',entries:()=>[],append:()=>'x',isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    const seen:{action:string}[]=[];
    host.mount('memory',{
      dispatch:(action:string)=>{seen.push({action});return {ok:true};},
      snapshot:()=>({}),
    } as never,'记忆');
    const extension=host.buildExtension('capabilities');
    assert.equal(extension.tools?.length,1,'the friend_ tool is installed on the extension');
    assert.equal(extension.tools?.[0]?.name,'friend_memory');
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('tool and request events become durable hooks that keep Pi blocking semantics',async()=>{
  const dir=workdir();
  try{
    const bus=createBus();
    const host=createDurablePluginHost({
      bus,cwd:dir,
      conversation:{id:'s',entries:()=>[],append:()=>'x',isIdle:()=>true},
      models:{available:()=>[],find:()=>undefined,current:()=>undefined,thinkingLevel:()=>'off'},
      confirm:async()=>false,notify:()=>undefined,
    });
    const seen={results:0,requests:0,responses:0,structured:[] as unknown[]};
    host.mountFactory(pi=>{
      pi.on('tool_call',(event:unknown)=>(event as {toolName:string}).toolName==='bash'?({block:true,reason:'危险命令已阻止'} as never):undefined);
      pi.on('tool_result',(event:unknown)=>{seen.results+=1;seen.structured.push((event as {structuredContent?:unknown}).structuredContent);});
      pi.on('before_provider_request',()=>{seen.requests+=1;});
      pi.on('after_provider_response',()=>{seen.responses+=1;});
    });
    const extension=host.buildExtension('probe');
    const hooks=extension.hooks ?? [];
    const toolHook=hooks.find(entry=>entry.task==='pi.tool')?.handlers as Record<string,(...args:unknown[])=>unknown>;
    const generationHook=hooks.find(entry=>entry.task==='pi.generation')?.handlers as Record<string,(...args:unknown[])=>unknown>;
    assert.ok(toolHook,'the tool hook is registered');
    assert.ok(generationHook,'the generation hook is registered');

    const blocked=toolHook.beforeTool({id:'c1',name:'bash',arguments:{command:'rm -rf /'}});
    assert.deepEqual(blocked,{block:'危险命令已阻止'},'a Pi block becomes a durable block message');

    const allowed=toolHook.beforeTool({id:'c2',name:'read',arguments:{path:'a'}});
    assert.equal(allowed,undefined,'a call the plugin does not block is left alone');

    toolHook.afterTool({id:'c3',name:'bash'},{isError:false,content:[{type:'text',text:'ok'}]});
    assert.equal(seen.results,1);
    assert.equal(seen.structured[0],undefined,'structuredContent is not fabricated');

    generationHook.beforeRequest({messages:[]});
    generationHook.afterResponse({role:'assistant'});
    assert.equal(seen.requests,1);
    assert.equal(seen.responses,1);
    await host.dispose();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
