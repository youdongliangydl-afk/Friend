import {useRef,useState} from 'react';
import {errorText,type JsonObject} from './types.js';
export type MemoryFeedbackKind='relevant'|'irrelevant'|'outdated';
export function memoryTaskContext(goal?:string,query?:string):JsonObject{const text=goal?.trim()||query?.trim();return text?{goal:text}:{};}
export function memoryFeedbackInput(id:string,revision:number,kind:MemoryFeedbackKind,goal:string|undefined,query:string|undefined,operationId:string):JsonObject{return {id,revision,kind,taskContext:memoryTaskContext(goal,query),operationId};}
export function MemoryFeedbackButtons({sessionId,id,revision,goal,query,disabled=false,report,onSaved}:{sessionId:string;id:string;revision:number;goal?:string;query?:string;disabled?:boolean;report(message:string,error?:boolean):void;onSaved?():void}){
 const [pending,setPending]=useState(false),[message,setMessage]=useState('');const owner=useRef(sessionId);owner.current=sessionId;
 const send=async(kind:MemoryFeedbackKind)=>{const session=sessionId;setPending(true);setMessage('');try{await window.friendPi.request('plugin.call',{sessionId,plugin:'memory',action:'feedback',input:memoryFeedbackInput(id,revision,kind,goal,query,crypto.randomUUID())});if(owner.current!==session)return;setMessage(kind==='outdated'?'已标记待复核，原事实保留':'已记录此任务的相关性反馈');onSaved?.();}catch(error){if(owner.current===session){setMessage(errorText(error));report(errorText(error),true);}}finally{if(owner.current===session)setPending(false);}};
 return <span className="memory-feedback"><span role="group" aria-label="这条记忆对当前任务的帮助">{([['relevant','相关'],['irrelevant','不相关'],['outdated','已过时']] as const).map(([kind,label])=><button type="button" key={kind} disabled={disabled||pending} onClick={()=>void send(kind)}>{label}</button>)}</span>{message&&<small role="status">{message}</small>}</span>;
}
