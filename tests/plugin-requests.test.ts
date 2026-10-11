import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {requestPlugin,registerPlugin,type Bus} from '../packages/core/src/index.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('parallel plugin requests correlate reversed replies with one bounded listener and release timeouts',async()=>{const emitter=new EventEmitter(),frames:{id:string;input:{index:number}}[]=[],bus:Bus={on:(event,listener)=>{emitter.on(event,listener);return()=>emitter.off(event,listener);},emit:(event,data)=>{emitter.emit(event,data);}};emitter.on('friend-pi:v1:request',frame=>frames.push(frame));const requests=Array.from({length:16},(_,index)=>requestPlugin(bus,'expert','snapshot',{index},500));assert.equal(emitter.listenerCount('friend-pi:v1:response'),1);for(const frame of [...frames].reverse())emitter.emit('friend-pi:v1:response',{id:frame.id,result:frame.input.index});assert.deepEqual(await Promise.all(requests),Array.from({length:16},(_,index)=>index));assert.equal(emitter.listenerCount('friend-pi:v1:response'),0);const expired=requestPlugin(bus,'missing','read',{},5);await assert.rejects(expired,/超时/);assert.equal(emitter.listenerCount('friend-pi:v1:response'),0);const recovered=requestPlugin(bus,'expert','read',{},500);emitter.emit('friend-pi:v1:response',{id:frames.at(-1)!.id,error:'correlated failure'});await assert.rejects(recovered,/correlated failure/);assert.equal(emitter.listenerCount('friend-pi:v1:response'),0);});


test('member history and list are read-only plugin queries and never produce a changed feedback loop',async()=>{
 const emitter=new EventEmitter(),events:string[]=[],bus:Bus={on:(event,listener)=>{emitter.on(event,listener);return()=>emitter.off(event,listener);},emit:(event,data)=>{events.push(event);emitter.emit(event,data);}},hooks=new Map<string,Function>();
 const pi={events:bus,on:(event:string,hook:Function)=>hooks.set(event,hook),registerTool:()=>{},registerCommand:()=>{},getThinkingLevel:()=> 'off',getActiveTools:()=>[],appendEntry:()=>{},getModelRuntime:()=>({})};
 const context={cwd:process.cwd(),sessionManager:{getSessionFile:()=>undefined,getSessionId:()=> 'readonly-member-test',getEntries:()=>[],getBranch:()=>[]},ui:{notify:()=>{}},isIdle:()=>true,model:undefined};
 registerPlugin(pi as any,'swarm',{snapshot:()=>({teammates:[]}),dispatch:async()=>({messages:[]})},'test');hooks.get('session_start')!({},context);
 for(const action of ['member.list','member.history']){await requestPlugin(bus,'swarm',action,{},1000);assert.equal(events.filter(event=>event==='friend-pi:v1:event').length,0);}
});

test('compact model content keeps authoritative details and desktop responses intact',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'friend-tool-projection-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=directory;
 const emitter=new EventEmitter(),hooks=new Map<string,Function>(),bus:Bus={on:(event,listener)=>{emitter.on(event,listener);return()=>emitter.off(event,listener);},emit:(event,data)=>{emitter.emit(event,data);}};
 let tool:any;const raw={id:'graph-id',status:'paused',error:'Unknown side effects',internalCatalog:'large'.repeat(1000)};
 const pi={events:bus,on:(event:string,hook:Function)=>hooks.set(event,hook),registerTool:(definition:any)=>{tool=definition;},registerCommand:()=>{},getThinkingLevel:()=> 'off',getActiveTools:()=>[],appendEntry:()=>{}};
 const context={cwd:directory,sessionManager:{getSessionFile:()=>undefined,getSessionId:()=> 'projection-test'},ui:{notify:()=>{}},isIdle:()=>true,model:undefined};
 try{
  registerPlugin(pi as any,'sample',{snapshot:()=>raw,dispatch:async()=>raw},'test',{projectToolResult:(action,value)=>{assert.equal(action,'snapshot');const {id,status,error}=value as typeof raw;return {id,status,error};}});
  hooks.get('session_start')!({},context);
  const result=await tool.execute('call',{action:'snapshot',input:{}},undefined,undefined,context);
  assert.deepEqual(JSON.parse(result.content[0].text),{id:raw.id,status:raw.status,error:raw.error});assert.equal(result.details,raw);
  assert.equal(await requestPlugin(bus,'sample','snapshot',{},1000),raw);assert.equal(raw.internalCatalog.length,5000);
 }finally{await hooks.get('session_shutdown')?.();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(directory,{recursive:true,force:true});}
});

test('member input identity travels only through the native trusted context and rejects serialized or invalid hashes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'friend-trusted-input-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=directory;
 const emitter=new EventEmitter(),hooks=new Map<string,Function>(),bus:Bus={on:(event,listener)=>{emitter.on(event,listener);return()=>emitter.off(event,listener);},emit:(event,data)=>{emitter.emit(event,data);}};let tool:any;
 const pi={events:bus,on:(event:string,hook:Function)=>hooks.set(event,hook),registerTool:(definition:any)=>{tool=definition;},registerCommand:()=>{},getThinkingLevel:()=> 'off',appendEntry:()=>{}};
 const native={cwd:directory,sessionManager:{getSessionFile:()=>undefined,getSessionId:()=> 'trusted-test'},ui:{notify:()=>{}},isIdle:()=>true,model:undefined};
 try{
  registerPlugin(pi as any,'sample',{snapshot:ctx=>({inputHash:ctx.inputHash}),dispatch:(_action,_input,ctx)=>({inputHash:ctx.inputHash,runId:ctx.runId,taskId:ctx.taskId,taskScope:ctx.taskScope})},'test');hooks.get('session_start')!({},native);
  const trusted={runId:'attempt',memberId:'member',taskId:'task',taskScope:'b'.repeat(64),inputHash:'a'.repeat(64),findJournalEntry:()=>undefined};
  assert.deepEqual(await requestPlugin(bus,'sample','observe',{},1000,'plugin',trusted),{inputHash:trusted.inputHash,runId:'attempt',taskId:'task',taskScope:trusted.taskScope});
  await assert.rejects(requestPlugin(bus,'sample','observe',{},1000,'plugin',JSON.parse(JSON.stringify(trusted))),{code:'PERMISSION_DENIED'});
  await assert.rejects(requestPlugin(bus,'sample','observe',{},1000,'plugin',{...trusted,inputHash:'unverified'}),{code:'VALIDATION_ERROR'});
  await assert.rejects(requestPlugin(bus,'sample','observe',{},1000,'plugin',{...trusted,taskScope:'other-graph'}),{code:'VALIDATION_ERROR'});
  const result=await tool.execute('model',{action:'observe',input:{inputHash:trusted.inputHash}},undefined,undefined,native);assert.equal(result.details.inputHash,undefined);
 }finally{await hooks.get('session_shutdown')?.();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(directory,{recursive:true,force:true});}
});
