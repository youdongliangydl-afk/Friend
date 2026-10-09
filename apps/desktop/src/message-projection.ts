import {visibleText,object,digest} from '@friend-pi/core';
export interface DisplayMessage {id:string;role:string;text:string;userText?:string;timestamp?:number;parts:Record<string,unknown>[];toolCallId?:string;toolName?:string;isError?:boolean;runId?:string;provider?:string;model?:string;durationMs?:number;usage?:Record<string,unknown>;stopReason?:string;errorMessage?:string}
/** A rebuildable projection. Native Pi entries, including the original parts, remain authoritative. */
export function projectMessages(entries:readonly unknown[]):DisplayMessage[]{
 const automatic=new Map<string,string>(),inputs=new Map<string,{textEnd:number;hash:string;runId?:string}>();
 for(const raw of entries){const e=object(raw),data=object(e.data||{});if(e.type!=='custom')continue;
  if(e.customType==='friend-pi.runtime-wake.input')automatic.set(String(data.entryId),String(data.hash));
  if(['friend-pi.input.v1','friend-pi.runtime-wake.input'].includes(String(e.customType))&&typeof data.entryId==='string')inputs.set(data.entryId,data as unknown as {textEnd:number;hash:string;runId?:string});}
 let runId:string|undefined;
 return entries.flatMap(raw=>{const e=object(raw);if(e.type!=='message'||!e.message)return [];const m=object(e.message);if(m.role==='system')return [];
  const parts=typeof m.content==='string'?[{type:'text',text:m.content}]:Array.isArray(m.content)?m.content.map(object):[];
  const text=visibleText(m.content),input=inputs.get(String(e.id));const original=input&&digest(text.slice(0,input.textEnd))===input.hash?text.slice(0,input.textEnd):undefined;
  if(m.role==='user')runId=original!==undefined?input?.runId:undefined;
  return [{id:String(e.id),role:automatic.get(String(e.id))===digest(text)?'automatic':String(m.role),text,parts,timestamp:typeof m.timestamp==='number'?m.timestamp:undefined,userText:original,runId,
   toolCallId:typeof m.toolCallId==='string'?m.toolCallId:undefined,toolName:typeof m.toolName==='string'?m.toolName:undefined,isError:m.isError===true,
   provider:typeof m.provider==='string'?m.provider:undefined,model:typeof m.model==='string'?m.model:undefined,durationMs:typeof m.durationMs==='number'?m.durationMs:undefined,
   usage:m.usage?object(m.usage):undefined,stopReason:typeof m.stopReason==='string'?m.stopReason:undefined,errorMessage:typeof m.errorMessage==='string'?m.errorMessage:undefined}];});
}
export interface TraceSystem {id:string;afterMessageId?:string;label:string;text:string;timestamp?:number;truncated?:boolean}
export function projectTraceSystems(entries:readonly unknown[]):TraceSystem[]{
 let afterMessageId:string|undefined;
 return entries.flatMap(raw=>{const e=object(raw),m=object(e.message||{}),data=object(e.data||{});
  let label='',text='';
  if(e.type==='message'&&m.role==='system'){label='原生系统上下文';text=traceJSON(m);}
  else if(e.type==='custom'&&e.customType==='friend-pi.trace.system.v1'){label='请求准备时的系统上下文';text=String(data.text||'');}
  else if(e.type==='custom_message'){label='插件上下文 · '+String(e.customType||'自定义消息');text=visibleText(e.content);}
  else if(['compaction','context_edit','branch_summary'].includes(String(e.type))){label=e.type==='compaction'?'上下文压缩':e.type==='context_edit'?'上下文编辑':'分支摘要';text=traceJSON(e);}
  else {if(e.type==='message')afterMessageId=String(e.id);return [];}
  return [{id:String(e.id),afterMessageId,label,text,timestamp:Date.parse(String(e.timestamp)),truncated:data.truncated===true}];
 });
}

export function traceJSON(value:unknown){return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&item.type==='image'?{type:'image',mimeType:item.mimeType,note:'图片附件'}:item,2);}
