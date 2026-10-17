import {randomUUID} from 'node:crypto';
import {RecordStore,digest,text,type JsonObject,type PermissionMode} from '@friend-pi/core';
export interface PlanSubmission {v:1;via:'tool'|'user';runId?:string;toolCallId?:string}
export interface PlanConfiguration {modelId?:string;thinkingLevel?:string;mode:'single'|'team'|'swarm';permissionMode?:PermissionMode}
export interface PlanRecord extends PlanConfiguration {
 id:string;revision:number;hash:string;body:string;status:'proposed'|'approved'|'rejected'|'superseded';
 sessionId:string;projectId:string;createdAt:string;approvedAt?:string;submission?:PlanSubmission;
}
export interface PlanExecution {
 v:1;id:string;runId:string;plan:PlanRecord;status:'starting'|'started'|'settled'|'failed'|'cancelled'|'interrupted';
 createdAt:string;updatedAt:string;nativeEntryId?:string;error?:string;
}
export const isSubmittedPlan=(plan:PlanRecord)=>plan.submission?.v===1&&['tool','user'].includes(plan.submission.via);

export class PlanStore {
 constructor(private store:RecordStore,private projectId:string,private sessionId:string){}
 private key(){return `plan:${this.projectId}:${this.sessionId}`;}
 private executionKey(input:Pick<PlanRecord,'id'|'revision'|'hash'>){return `execution:${this.sessionId}:${input.id}:${input.revision}:${input.hash}`;}
 current():PlanRecord|undefined{return this.store.get<PlanRecord>(this.key())?.value;}
 submit(body:string,snapshot:PlanConfiguration,submission:PlanSubmission={v:1,via:'user'}):PlanRecord {
  body=text(body,'计划',100000);const previous=this.current();
  const plan:PlanRecord={id:previous?.id||randomUUID(),revision:(previous?.revision||0)+1,hash:digest(body),body,status:'proposed',projectId:this.projectId,sessionId:this.sessionId,...snapshot,submission:{...submission},createdAt:new Date().toISOString()};
  this.store.transaction(()=>{this.store.put(this.key(),plan);this.store.put(`version:${plan.id}:${plan.revision}`,plan,null);});return plan;
 }
 supersede(){const plan=this.current();if(plan&&['proposed','approved'].includes(plan.status))this.store.put(this.key(),{...plan,status:'superseded'});}
 matches(input:JsonObject):PlanRecord {
  const plan=this.current();
  if(!plan||plan.id!==input.id||plan.revision!==input.revision||plan.hash!==input.hash||['rejected','superseded'].includes(plan.status))throw new Error('计划版本已变化，请阅读当前版本后再决定');
  return plan;
 }
 decide(action:'approve'|'reject',input:JsonObject,snapshot:PlanConfiguration):PlanRecord {
  const plan=this.matches(input);if(plan.status!=='proposed')throw new Error('计划版本已变化，请阅读当前版本后再决定');
  if(action==='approve'){
   if(!isSubmittedPlan(plan))throw new Error('旧计划缺少明确提交来源，请重新提交计划后批准');
   if(plan.modelId!==snapshot.modelId||plan.thinkingLevel!==snapshot.thinkingLevel||plan.mode!==snapshot.mode||(plan.permissionMode||'auto')!==(snapshot.permissionMode||'auto'))throw new Error('执行配置已变化，请重新规划后批准');
  }
  const next:PlanRecord={...plan,status:action==='approve'?'approved':'rejected',...(action==='approve'?{approvedAt:new Date().toISOString()}:{})};this.store.put(this.key(),next);return next;
 }
 execution(input:Pick<PlanRecord,'id'|'revision'|'hash'>):PlanExecution|undefined{return this.store.get<PlanExecution>(this.executionKey(input))?.value;}
 executionForRun(runId?:string):PlanExecution|undefined {
  if(!runId)return;const key=this.store.get<{key:string}>(`execution-run:${this.sessionId}:${runId}`)?.value.key;
  return key?this.store.get<PlanExecution>(key)?.value:undefined;
 }
 approve(input:JsonObject,snapshot:PlanConfiguration,runId:string):PlanExecution {
  return this.store.transaction(()=>{
   const plan=this.decide('approve',input,snapshot),at=new Date().toISOString();
   const execution:PlanExecution={v:1,id:randomUUID(),runId,plan,status:'starting',createdAt:at,updatedAt:at};
   const key=this.executionKey(plan);this.store.put(key,execution);this.store.put(`execution-run:${this.sessionId}:${runId}`,{key});return execution;
  });
 }
 updateExecution(execution:PlanExecution,status:PlanExecution['status'],extra:Pick<Partial<PlanExecution>,'nativeEntryId'|'error'>={}):PlanExecution {
  const current=this.execution(execution.plan);if(!current||current.id!==execution.id)throw new Error('计划执行收据已失效');
  // Terminal receipts never become runnable again, including delayed native events after stop.
  const terminal=['settled','failed','cancelled','interrupted'].includes(current.status);
  const next={...current,...extra,status:terminal?current.status:status,updatedAt:new Date().toISOString()};this.store.put(this.executionKey(execution.plan),next);return next;
 }
 recover(){
  // A persisted authorization cannot prove that a crashed prompt never ran.
  // Preserve its identity and native receipt, but never replay it on startup.
  const plan=this.current(),execution=plan&&this.execution(plan);
  if(execution&&['starting','started'].includes(execution.status))this.updateExecution(execution,'interrupted');
 }
}
