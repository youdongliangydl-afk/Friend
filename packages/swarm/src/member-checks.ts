import {CapabilityError,digest,object,visibleText} from '@friend-pi/core';
import type {CheckRef,RegisteredCheck} from '@friend-pi/core';
import type {Attempt,Graph} from './types.js';

export const nativeCheckType='friend-pi.swarm.native-check.v1';
export const nativeRunType='friend-pi.swarm.run.v1';
export const nativeUserType='friend-pi.swarm.native-user.v1';
export function memberNativeInput(entries:unknown[],graph:Graph,attempt:Attempt):string {
 const rows=entries.map(object),runIndex=rows.findLastIndex(e=>e.type==='custom'&&e.customType===nativeRunType&&object(e.data).runId===attempt.id),run=object(rows[runIndex]?.data||{});
 if(run.graphId!==graph.id||run.taskId!==attempt.taskId||run.memberId!==(attempt.memberId||attempt.id)||run.generation!==attempt.generation)throw new CapabilityError('SOURCE_UNAVAILABLE','成员任务原史身份未核验');
 const userIndex=rows.findIndex((e,i)=>i>runIndex&&e.type==='message'&&object(e.message).role==='user'),user=rows[userIndex],hash=digest(visibleText(object(user?.message||{}).content));
 if(!attempt.startPromptDigest||hash!==attempt.startPromptDigest||!rows.some((e,i)=>i>userIndex&&e.type==='custom'&&e.customType===nativeUserType&&object(e.data).runId===attempt.id&&object(e.data).entryId===user.id&&object(e.data).promptDigest===hash))throw new CapabilityError('SOURCE_UNAVAILABLE','成员当前任务输入未核验');
 return hash;
}
export interface NativeCheckReceipt {
 v:1;operationId:string;runId:string;graphId:string;taskId:string;memberId:string;generation?:number;sessionId:string;
 toolEntryId:string;toolCallId:string;toolResultHash:string;commandHash:string;outputHash:string;exitCode:number;
 adoptions:{operationId:string;journalEntryId:string;skillsHash:string}[];
}
export function trialAdoptions(attempt:Pick<Attempt,'expertAdoptions'>):Record<string,unknown>[] {
 return (attempt.expertAdoptions||[]).map(object).filter(a=>Array.isArray(a.skills)&&a.skills.some(raw=>object(raw).statusAtFreeze==='trial'));
}

/** Only the parent admits evidence, after reading Pi's immutable entries from its managed child. */
export function readMemberChecks(entries:unknown[],graph:Graph,attempt:Attempt,sessionId:string,complete=false):RegisteredCheck[] {
 const invalid=():never=>{throw new CapabilityError('SOURCE_UNAVAILABLE','成员客观检查原史或采用身份未核验');};
 const rows=entries.map(object),runIndex=rows.findLastIndex(e=>e.type==='custom'&&e.customType==='friend-pi.expert.run'&&object(e.data).runId===attempt.id);
 if(runIndex<0)return [];
 memberNativeInput(entries,graph,attempt);
 const run=object(rows[runIndex].data);if(run.graphId!==graph.id||run.taskId!==attempt.taskId||digest(run.frozen)!==digest(attempt.expert))invalid();
 const userIndex=rows.findIndex((e,i)=>i>runIndex&&e.type==='message'&&object(e.message).role==='user');
 if(userIndex<0||!attempt.startPromptDigest||digest(visibleText(object(rows[userIndex].message).content))!==attempt.startPromptDigest)invalid();
 const confirmed=trialAdoptions(attempt),checks:RegisteredCheck[]=[];
 for(let i=userIndex+1;i<rows.length;i++){
  const entry=rows[i];if(entry.type!=='custom'||entry.customType!==nativeCheckType)continue;
  const data=object(entry.data) as unknown as NativeCheckReceipt;if(data.runId!==attempt.id)continue;
  if(data.v!==1||data.graphId!==graph.id||data.taskId!==attempt.taskId||data.memberId!==(attempt.memberId||attempt.id)||data.generation!==attempt.generation||data.sessionId!==sessionId||!Number.isSafeInteger(data.exitCode)||data.operationId!==digest([attempt.id,data.toolEntryId])||!Array.isArray(data.adoptions)||!data.adoptions.length)invalid();
  const toolIndex=rows.findIndex(e=>e.id===data.toolEntryId),message=object(rows[toolIndex]?.message||{});
  if(toolIndex<=userIndex||toolIndex>=i||message.role!=='toolResult'||message.toolName!=='bash'||message.toolCallId!==data.toolCallId||digest(message)!==data.toolResultHash||digest(visibleText(message.content))!==data.outputHash||Boolean(message.isError)!==(data.exitCode!==0))invalid();
  const callIndex=rows.findIndex((e,index)=>index>userIndex&&index<toolIndex&&e.type==='message'&&object(e.message).role==='assistant'&&Array.isArray(object(e.message).content)&&(object(e.message).content as unknown[]).some(raw=>{const p=object(raw);return p.type==='toolCall'&&p.id===data.toolCallId&&p.name==='bash';})),call=(Array.isArray(object(rows[callIndex]?.message||{}).content)?object(rows[callIndex].message).content as unknown[]:[]).map(object).find(p=>p.type==='toolCall'&&p.id===data.toolCallId);
  if(!call||digest(object(call.arguments).command)!==data.commandHash)invalid();
  for(const adoption of data.adoptions){
   const canonical=confirmed.find(a=>a.operationId===adoption.operationId&&a.journalEntryId===adoption.journalEntryId&&digest(a.skills)===adoption.skillsHash);
   const nativeIndex=rows.findIndex(e=>e.id===adoption.journalEntryId),native=rows[nativeIndex],body=object(native?.data||{});
   if(!canonical||nativeIndex<=runIndex||nativeIndex>=callIndex||native.type!=='custom'||native.customType!=='friend-pi.expert.adoption'||body.operationId!==adoption.operationId||body.runId!==attempt.id||body.memberId!==(attempt.memberId||attempt.id)||body.catalogHash!==object(attempt.expert).hash||digest(body.skills)!==adoption.skillsHash)invalid();
  }
  if(complete&&confirmed.some(a=>!data.adoptions.some(d=>d.operationId===a.operationId&&d.journalEntryId===a.journalEntryId)))throw new CapabilityError('OPERATION_UNKNOWN','部分检查早于后续采用，整组试运行证据保持等待');
  const ref:CheckRef={checkId:`swarm-native:${sessionId}:${data.toolEntryId}`,version:1,hash:data.toolResultHash,taskId:attempt.taskId,producerRunId:attempt.id,artifacts:[]};
  checks.push({ref,projectId:graph.projectId,passed:data.exitCode===0,output:{exitCode:data.exitCode,toolCallId:data.toolCallId,outputHash:data.outputHash,receiptEntryId:String(entry.id)},sources:[{sessionId,entryId:data.toolEntryId,hash:data.outputHash}]});
 }
 return checks;
}
