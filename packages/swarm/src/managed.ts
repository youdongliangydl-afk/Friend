import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {PluginContext} from '@friend-pi/core';
import type {StopObject} from './types.js';

export class CancelledError extends Error {constructor(){super('执行已取消；现场保留，未自动重放');this.name='CancelledError';}}
export function checkCancelled(signal?:AbortSignal):void {if(signal?.aborted)throw new CancelledError();}
export interface ManagedResult {stdout:string;stderr:string;exitCode:number|null;signal:NodeJS.Signals|null;cancelled:boolean}
/** Each process owns its freshly-created POSIX group. Never signal a discovered/user process. */
export function ownChild(child:ChildProcess,id:string,kind:StopObject['kind'],groupOwned:boolean,notify:(action:'started'|'closed',pid:number)=>void,grace=0){
  let closed=false,cancelled=false;let receipt:StopObject|undefined;let stopping:Promise<StopObject>|undefined;
  let resolveClosed!:(value:StopObject)=>void;
  const ended=new Promise<StopObject>(done=>{resolveClosed=done;});
  const inform=(action:'started'|'closed')=>{if(child.pid)try{notify(action,child.pid);}catch{/* Notification failure cannot abandon ownership of the process. */}};
  inform('started');
  child.once('close',(code,signal)=>{closed=true;receipt={id,kind,status:'terminated',pid:child.pid,exitCode:code,signal};inform('closed');resolveClosed(receipt);});
  child.once('error',error=>{if(!child.pid){closed=true;receipt={id,kind,status:'terminated',detail:error.message};resolveClosed(receipt);}});
  const signal=(value:NodeJS.Signals)=>{if(closed)return;try{if(groupOwned&&child.pid)process.kill(-child.pid,value);else child.kill(value);}catch{/* close remains the authority, not kill's return value. */}};
  return {ended,get cancelled(){return cancelled;},stop(before?:()=>void):Promise<StopObject>{
    if(stopping)return stopping;cancelled=true;try{before?.();}catch{/* Escalation still runs if the IPC channel has already closed. */}
    if(closed)return Promise.resolve(receipt!);
    stopping=new Promise<StopObject>(done=>{
      const term=setTimeout(()=>signal('SIGTERM'),grace);
      const kill=setTimeout(()=>signal('SIGKILL'),grace+1000);
      const limit=setTimeout(()=>done({id,kind,status:'unknown',pid:child.pid,detail:'没有收到进程关闭回执；现场及所有权保留'}),grace+3000);
      void ended.then(value=>{clearTimeout(term);clearTimeout(kill);clearTimeout(limit);done(value);});
    });return stopping;
  }};
}
export function managedCommand(command:string,args:string[],cwd:string,signal:AbortSignal|undefined,ctx:PluginContext,graphId:string,kind:'check'|'git',onStarted:(operation:{id:string;stop:()=>Promise<StopObject>;ended:Promise<StopObject>})=>void,maxBuffer=4*1024*1024,timeout=120000):Promise<ManagedResult>{
  checkCancelled(signal);const id=randomUUID();const groupOwned=process.platform!=='win32';
  const child=spawn(command,args,{cwd,detached:groupOwned,stdio:['ignore','pipe','pipe'],env:process.env});
  const owned=ownChild(child,id,kind,groupOwned,(action,pid)=>ctx.emit('swarm.process',{v:1,graphId,operationId:id,kind,action,pid,groupOwned}));
  onStarted({id,stop:()=>owned.stop(),ended:owned.ended});
  return new Promise<ManagedResult>((done,reject)=>{
    let stdout='',stderr='',bytes=0,failed:Error|undefined;
    const collect=(target:'stdout'|'stderr',chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxBuffer){failed=new Error('工具输出超过保留上限；现场保留');void owned.stop();return;}if(target==='stdout')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
    child.stdout?.on('data',chunk=>collect('stdout',chunk));child.stderr?.on('data',chunk=>collect('stderr',chunk));
    const abort=()=>{void owned.stop();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{failed=new Error('执行检查超时；现场保留');void owned.stop();},timeout);
    child.once('error',error=>{failed=error;});
    void owned.ended.then(receipt=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failed&&!signal?.aborted)reject(failed);else done({stdout,stderr,exitCode:receipt.exitCode??null,signal:(receipt.signal as NodeJS.Signals)||null,cancelled:owned.cancelled});});
  });
}
