import {useEffect,useSyncExternalStore} from 'react';
import type {RunChangesSummary} from '../run-changes.js';
import type {ChangedFile} from '../workspace-files.js';
export interface ChangeCoordinates {sessionId:string;runId:string;changeId?:string;index:number}
export interface ChangeReviewTarget extends ChangeCoordinates {files:RunChangesSummary['files'];finishedAt:string}
export type ChangeDiffState = {phase:'loading'}|{phase:'ready';file:ChangedFile}|{phase:'missing';message:string}|{phase:'error';message:string};
/** Session-scoped cache shared by delayed hover previews and the right workbench. */
export class ChangeDiffCache {
 private states=new Map<string,ChangeDiffState>();private pending=new Map<string,Promise<void>>();private listeners=new Set<()=>void>();
 private key(value:ChangeCoordinates){return JSON.stringify([value.sessionId,value.runId,value.changeId,value.index]);}
 get(value:ChangeCoordinates){return this.states.get(this.key(value));}
 subscribe=(callback:()=>void)=>{this.listeners.add(callback);return()=>{this.listeners.delete(callback);};};
 private publish(){for(const listener of this.listeners)listener();}
 async load(value:ChangeCoordinates){
  const key=this.key(value),state=this.states.get(key);if(state&&state.phase!=='error')return this.pending.get(key);
  if(!value.changeId){this.states.set(key,{phase:'missing',message:'此历史记录未保存变更快照'});this.publish();return;}
  this.states.set(key,{phase:'loading'});this.publish();
  const task=window.friendPi.request<{file?:ChangedFile;unavailable?:string}>('session.changes.read',{...value}).then(result=>{
   if(result.file&&typeof result.file.path==='string'&&Array.isArray(result.file.lines))this.states.set(key,{phase:'ready',file:result.file});
   else this.states.set(key,{phase:'missing',message:result.unavailable||'该轮变更不可用'});
  }).catch(error=>{this.states.set(key,{phase:'error',message:error instanceof Error?error.message:String(error)});}).finally(()=>{this.pending.delete(key);this.publish();});
  this.pending.set(key,task);await task;
 }
}
export function useChangeDiff(cache:ChangeDiffCache,coordinates:ChangeCoordinates){
 const state=useSyncExternalStore(cache.subscribe,()=>cache.get(coordinates),()=>undefined);
 useEffect(()=>{if(state===undefined)void cache.load(coordinates);},[cache,coordinates.sessionId,coordinates.runId,coordinates.changeId,coordinates.index,state]);
 return state;
}
