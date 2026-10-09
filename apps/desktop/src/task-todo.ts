import {object,text} from '@friend-pi/core';
export const TODO_TYPE='friend-pi.todo.v1';
export const SIDECHAT_TYPE='friend-pi.sidechat.origin.v1';
export interface TodoItem {content:string;status:'pending'|'in_progress'|'completed'}
export interface TaskTodo {v:1;runId:string;items:TodoItem[]}
export function todoItems(raw:unknown):TodoItem[]{
 if(!Array.isArray(raw)||raw.length>64)throw new Error('Todo 需要不超过 64 项的清单');
 const seen=new Set<string>();return raw.map(value=>{const item=object(value),content=text(item.content,'待办内容',1000);if(seen.has(content))throw new Error('待办内容不能重复');seen.add(content);if(!['pending','in_progress','completed'].includes(String(item.status)))throw new Error('待办状态无效');return {content,status:item.status as TodoItem['status']};});
}
/** Inherited context is readable history, never the child's execution state. */
export function ownedEntries<T>(entries:readonly T[]):readonly T[]{let start=0;entries.forEach((entry,index)=>{const raw=object(entry);if(raw.type==='custom'&&raw.customType===SIDECHAT_TYPE)start=index+1;});return entries.slice(start);}
export function projectTodo(entries:readonly unknown[],runId?:string):TaskTodo|undefined{
 if(!runId)return;let result:TaskTodo|undefined;
 for(const entry of ownedEntries(entries)){const raw=object(entry);if(raw.type!=='custom'||raw.customType!==TODO_TYPE)continue;try{const data=object(raw.data);if(data.v===1&&data.runId===runId)result={v:1,runId,items:todoItems(data.items)};}catch{/* Old malformed metadata must not prevent opening native history. */}}return result;
}
/** Do not fork a prefix that would ask a child to finish its parent's tools. */
export function stableForkLeaf(entries:readonly unknown[]):string|undefined{
 const pending=new Set<string>();let stable:string|undefined;
 for(const raw of entries){const entry=object(raw),message=object(entry.message||{});if(entry.type==='message'){
  if(message.role==='assistant'&&Array.isArray(message.content))for(const part of message.content.map(object))if(part.type==='toolCall'&&typeof part.id==='string')pending.add(part.id);
  if(message.role==='toolResult')pending.delete(String(message.toolCallId));
 }if(!pending.size&&typeof entry.id==='string')stable=entry.id;}return stable;
}
