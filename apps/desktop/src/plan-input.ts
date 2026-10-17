import {digest,object,visibleText} from '@friend-pi/core';
import type {SessionManager} from '@earendil-works/pi-coding-agent';
import {PlanStore,type PlanExecution} from './plan-store.js';

export const approvedPlanPrompt=(execution:PlanExecution)=>`开始执行用户已批准的计划 ${execution.plan.id} 第 ${execution.plan.revision} 版。按当前请求中的获批计划快照完成任务及验证。`;
export function planInputReceipt(execution:PlanExecution,entryId:string,text:string){
 return {entryId,textEnd:text.length,hash:digest(text),runId:execution.runId,planExecutionId:execution.id,planId:execution.plan.id,revision:execution.plan.revision,planHash:execution.plan.hash,displayText:'计划已批准，开始执行'};
}
/** Reconcile attribution only. A crashed authorization never triggers another prompt. */
export function recoverPlanInputs(manager:SessionManager,plans:PlanStore){
 const entries=manager.getBranch();
 const attributed=new Set(entries.flatMap(entry=>entry.type==='custom'&&entry.customType==='friend-pi.runtime-wake.input'?[String(object(entry.data).entryId)]:[]));
 for(let i=0;i<entries.length;i++){
  const decision=entries[i];if(decision.type!=='custom'||decision.customType!=='friend-pi.plan.decision')continue;
  const data=object(decision.data),execution=typeof data.runId==='string'?plans.executionForRun(data.runId):undefined;
  if(!execution||execution.id!==data.executionId)continue;
  if(['starting','started'].includes(execution.status))plans.updateExecution(execution,'interrupted');
  let scoped=false;
  for(const entry of entries.slice(i+1)){
   if(entry.type==='custom'&&entry.customType==='friend-pi.run.policy.v1'){
    if(scoped||object(entry.data).runId!==execution.runId)break;scoped=true;continue;
   }
   if(!scoped||entry.type!=='message'||entry.message.role!=='user')continue;
   const text=visibleText(entry.message.content);if(text!==approvedPlanPrompt(execution))break;
   if(!attributed.has(entry.id)){
    manager.appendCustomEntry('friend-pi.runtime-wake.input',{...planInputReceipt(execution,entry.id,text),recovered:true});attributed.add(entry.id);
    plans.updateExecution(execution,'interrupted',{nativeEntryId:entry.id});
   }
   break;
  }
 }
}
