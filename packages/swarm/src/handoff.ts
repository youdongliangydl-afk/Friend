import {CapabilityError,digest,object,visibleText,RecordStore,type SourceRef} from '@friend-pi/core';
import type {Graph,Task,Attempt,FrozenExecution} from './types.js';
import {graphReachability} from './reachability.js';
import {memberNativeInput,nativeRunType} from './member-checks.js';

export interface HandoffRef {id:string;version:1;hash:string;length:number;mustRead:true}
export interface StructuredHandoff {v:1;goal:string;taskId:string;requirements:string;constraints:string[];unresolved:string[];sources:SourceRef[];dependencies:{taskId:string;attemptId?:string;resultRevision:number;summary?:string;commit?:string;nativeSessionId?:string;nativeSessionFile?:string;memoryRefs:FrozenExecution['memoryRefs'];expertRefs:FrozenExecution['expertRefs'];skillRefs:FrozenExecution['skillRefs']}[];artifacts:{artifactId:string;revision:number;digest:string;taskId:string}[];memoryRefs:FrozenExecution['memoryRefs'];expertRefs:FrozenExecution['expertRefs'];skillRefs:FrozenExecution['skillRefs']}
export function handoffBody(graph:Graph,task:Task,frozen:FrozenExecution|undefined,artifacts:StructuredHandoff['artifacts']):StructuredHandoff {
  const ancestors=graphReachability(graph.tasks).ancestors(task.id),dependencies=graph.tasks.filter(t=>ancestors.has(t.id));
  return {v:1,goal:graph.goal,taskId:task.id,requirements:task.requirementVersions?.at(-1)?.prompt||task.prompt,constraints:[...new Set([...(task.constraints||[]),...dependencies.flatMap(t=>t.constraints||[]),...(graph.contract?.acceptance||[]),...(graph.contract?.forbiddenEffects||[])])],unresolved:[...new Set([...(task.unresolved||[]),...dependencies.flatMap(t=>t.unresolved||[])])],sources:graph.sourceFence?.sources||[],dependencies:dependencies.map(dep=>{const attempt=graph.attempts.find(a=>a.id===dep.currentAttempt);return {taskId:dep.id,attemptId:attempt?.id,resultRevision:dep.resultRevision,summary:attempt?.summary,commit:attempt?.commit,nativeSessionId:attempt?.sessionId,nativeSessionFile:attempt?.sessionFile,memoryRefs:attempt?.frozen?.memoryRefs||[],expertRefs:attempt?.frozen?.expertRefs||[],skillRefs:attempt?.frozen?.skillRefs||[]};}),artifacts:artifacts.filter(a=>ancestors.has(a.taskId)),memoryRefs:frozen?.memoryRefs||[],expertRefs:frozen?.expertRefs||[],skillRefs:frozen?.skillRefs||[]};
}
export function prepareHandoff(store:RecordStore,graph:Graph,task:Task,attempt:Attempt,artifacts:StructuredHandoff['artifacts'],memoryContext=''):{prompt:string;required?:HandoffRef} {
  const content=JSON.stringify({...handoffBody(graph,task,attempt.frozen,artifacts),memoryContext}),hash=digest(content);
  if(content.length<=8000)return {prompt:`结构化交接（约束须全部遵守；不代替明确要求完整阅读的原始附件）：\n${content}`};
  const ref:HandoffRef={id:attempt.id,version:1,hash,length:content.length,mustRead:true};
  const key=`handoff:${graph.id}:${ref.id}:1`,known=store.get<{ref:HandoffRef;content:string}>(key);
  if(known&&known.value.ref.hash!==hash)throw new CapabilityError('VERSION_CONFLICT','交接版本不可覆盖');
  if(!known)store.put(key,{ref,content},null);
  return {prompt:`结构化交接超过默认8000字符，完整目标、要求、约束、未决问题及精确来源/成果/Memory/Skill引用均保存在必读引用中，未截断。执行前必须用 swarm_handoff_read 从 offset:0 连续完整读取；读完前不能执行相关工具或提交成果。原始附件明确要求完整阅读时仍须完整阅读。\n必读引用：${JSON.stringify(ref)}`,required:ref};
}
export function readHandoff(store:RecordStore,graphId:string,ref:HandoffRef,offset:unknown,maxChars:unknown=8000):{ref:HandoffRef;offset:number;end:number;content:string;complete:boolean} {
  if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(maxChars)||Number(maxChars)<1||Number(maxChars)>8000)throw new CapabilityError('VALIDATION_ERROR','交接读取范围无效');
  const saved=store.get<{ref:HandoffRef;content:string}>(`handoff:${graphId}:${ref.id}:1`)?.value;
  if(!saved||digest(saved.content)!==ref.hash||digest(saved.ref)!==digest(ref))throw new CapabilityError('SOURCE_UNAVAILABLE','交接版本、长度或摘要已变化');
  if(Number(offset)>=ref.length)throw new CapabilityError('VALIDATION_ERROR','交接读取起点越界');const end=Math.min(ref.length,Number(offset)+Number(maxChars));
  return {ref,offset:Number(offset),end,content:saved.content.slice(Number(offset),end),complete:end===ref.length};
}
/** Controlled read coverage; end-of-file alone cannot count as a full read. */
export class HandoffReadCoverage {
  private offset=0;
  private readonly parts:string[]=[];
  constructor(readonly ref:HandoffRef){}
  get complete():boolean{return this.offset===this.ref.length;}
  accept(value:{ref:HandoffRef;offset:number;end:number;content:string}):void {
    if(digest(value.ref)!==digest(this.ref)||value.offset!==this.offset||value.end!==value.offset+value.content.length||value.end>this.ref.length)throw new Error('交接读取必须按精确版本连续覆盖全文');this.parts.push(value.content);if(value.end===this.ref.length&&digest(this.parts.join(''))!==this.ref.hash)throw new Error('交接完整内容摘要不匹配');this.offset=value.end;
  }
  next():number{return this.offset;}
}
export function verifyHandoffRead(store:RecordStore,entries:unknown[],graph:Graph,attempt:Attempt,sessionId:string) {
  const ref=attempt.requiredHandoff;if(!ref)throw new CapabilityError('SOURCE_UNAVAILABLE','缺少必读交接引用');memberNativeInput(entries,graph,attempt);
  const rows=entries.map(object),begin=rows.findLastIndex(e=>e.type==='custom'&&e.customType===nativeRunType&&object(e.data).runId===attempt.id),calls=new Map<string,Record<string,unknown>>(),coverage=new HandoffReadCoverage(ref),receipts:{entryId:string;offset:number;end:number;hash:string}[]=[];
  for(const row of rows.slice(begin+1)){
    const message=row.type==='message'?object(row.message):undefined;if(!message)continue;
    if(message.role==='assistant'&&Array.isArray(message.content))for(const part of message.content.map(object))if(part.type==='toolCall'&&part.name==='swarm_handoff_read')calls.set(String(part.id),object(part.arguments));
    if(message.role!=='toolResult'||message.isError===true)continue;
    if(message.toolName==='swarm_handoff_read'){
      const call=calls.get(String(message.toolCallId));if(!call)throw new CapabilityError('SOURCE_UNAVAILABLE','交接原生结果缺少当前尝试工具调用');
      const expected=readHandoff(store,graph.id,ref,call.offset,call.maxChars);if(visibleText(message.content)!==expected.content)throw new CapabilityError('SOURCE_UNAVAILABLE','交接原生结果与冻结正文不符');coverage.accept(expected);receipts.push({entryId:String(row.id),offset:expected.offset,end:expected.end,hash:digest(expected.content)});
    }else if(!coverage.complete)throw new CapabilityError('SOURCE_UNAVAILABLE','必读交接未读全前存在成功执行的工具');
  }
  if(!coverage.complete)throw new CapabilityError('SOURCE_UNAVAILABLE','当前尝试原生记录未覆盖完整交接');
  return {v:1 as const,status:'native-full-read' as const,reference:ref,sessionId,entries:receipts};
}
