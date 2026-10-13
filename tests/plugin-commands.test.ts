import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerPlugin,type Bus} from '../packages/core/src/index.js';

test('registered commands accept pasted whitespace without changing JSON content or hiding errors',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'friend-command-whitespace-')),prior=process.env.FRIEND_PI_DATA_DIR;
 process.env.FRIEND_PI_DATA_DIR=directory;
 const emitter=new EventEmitter(),hooks=new Map<string,Function>();
 const bus:Bus={on:(event,listener)=>{emitter.on(event,listener);return()=>emitter.off(event,listener);},emit:(event,data)=>{emitter.emit(event,data);}};
 let command:any,snapshots=0;const dispatched:{action:string;input:unknown;origin?:string}[]=[],notices:string[]=[];
 const pi={events:bus,on:(event:string,hook:Function)=>hooks.set(event,hook),registerTool:()=>{},registerCommand:(_name:string,value:any)=>{command=value;},getThinkingLevel:()=> 'off',appendEntry:()=>{}};
 const context={cwd:directory,sessionManager:{getSessionFile:()=>undefined,getSessionId:()=> 'command-whitespace'},ui:{notify:(message:string)=>notices.push(message)},isIdle:()=>true,model:undefined};
 try{
  registerPlugin(pi as any,'swarm',{snapshot:()=>{snapshots++;return {graphs:[]};},dispatch:async(action,input,ctx)=>{if(action!=='create')throw Error('unsupported action');dispatched.push({action,input,origin:ctx.origin});return {id:'created',status:'created'};}},'test');
  for(const args of ['', ' \t\r\n', 'snapshot', 'snapshot\n', ' snapshot\r\n', '\tsnapshot\t\n']){
   const before=snapshots;await command.handler(args,context);
   assert.equal(snapshots,before+1);assert.equal(dispatched.length,0);assert.match(notices.at(-1)!,/已读取当前结果/);
  }
  const input={goal:'keep  internal\ntext\tand spaces',tasks:[]};
  for(const separator of [' ', '\t', '\n', '\r\n'])await command.handler(' \tcreate'+separator+JSON.stringify(input)+'\r\n',context);
  assert.deepEqual(dispatched,Array.from({length:4},()=>({action:'create',input,origin:'user'})));
  await command.handler('create \t preserve\ntext',context);
  assert.deepEqual(dispatched.at(-1),{action:'create',input:{text:'\t preserve\ntext'},origin:'user'},'only the command separator is removed from plain-text arguments');
  const before={dispatched:dispatched.length,notices:notices.length,snapshots};
  await assert.rejects(command.handler('create\n{invalid JSON}',context),SyntaxError);
  await assert.rejects(command.handler('unknown\n',context),/unsupported action/);
  assert.deepEqual({dispatched:dispatched.length,notices:notices.length,snapshots},before);
 }finally{
  await hooks.get('session_shutdown')?.();
  if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;
  rmSync(directory,{recursive:true,force:true});
 }
});
