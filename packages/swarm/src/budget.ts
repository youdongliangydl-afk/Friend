import {randomUUID} from 'node:crypto';
import {CapabilityError,object,RecordStore,type JsonObject,type PluginContext} from '@friend-pi/core';
import type {BudgetSnapshot} from './types.js';
export class Budget {
  constructor(private readonly store:RecordStore){}
  async capture(graphId:string,raw:unknown,maxWorkers:number,ctx:PluginContext):Promise<BudgetSnapshot>{const r=raw===undefined?{}:object(raw);if(r.tokenLimit!==undefined&&(!Number.isInteger(r.tokenLimit)||Number(r.tokenLimit)<1))throw new CapabilityError('VALIDATION_ERROR','tokenLimit必须为正整数');
    if(ctx.policy){const result=object(await ctx.request('runtime','budget.capture',{graphId,...(r.parentBudgetId?{parentBudgetId:r.parentBudgetId}:{}),...(r.tokenLimit?{tokenLimit:r.tokenLimit}:{})}));const captured=this.validate(result,maxWorkers);if(r.tokenLimit!==undefined)captured.tokenLimit=Math.min(captured.tokenLimit??Number(r.tokenLimit),Number(r.tokenLimit));return captured;}
    return {budgetId:`swarm:${ctx.projectId}:${ctx.runId||ctx.sessionId}:${graphId}`,tokenLimit:r.tokenLimit as number|undefined,tokenUsed:0,tokenReserved:0,tokenUnknown:false,maxWorkers,maxTasks:64,maxRepairRounds:2};}
  private validate(r:JsonObject,maxWorkers:number):BudgetSnapshot {if(typeof r.budgetId!=='string'||typeof r.tokenUsed!=='number'||typeof r.tokenReserved!=='number'||typeof r.tokenUnknown!=='boolean')throw new CapabilityError('CAPABILITY_UNAVAILABLE','宿主预算快照无效');return {...r,parentMaxWorkers:typeof r.maxWorkers==='number'?r.maxWorkers:maxWorkers,maxWorkers:Math.min(maxWorkers,typeof r.maxWorkers==='number'?r.maxWorkers:maxWorkers),maxTasks:64,maxRepairRounds:2} as unknown as BudgetSnapshot;}
  async reserve(b:BudgetSnapshot,graphId:string,taskId:string,attemptId:string,ctx:PluginContext):Promise<{reservationId?:string;budget:BudgetSnapshot}>{if(b.deadline&&Date.now()>Date.parse(b.deadline)||b.tokenLimit!==undefined&&(b.tokenUnknown||b.tokenUsed+b.tokenReserved>=b.tokenLimit))throw new CapabilityError('BUDGET_EXHAUSTED','冻结任务预算已耗尽');if(ctx.policy){const r=object(await ctx.request('runtime','budget.reserve',{budgetId:b.budgetId,graphId,taskId,attemptId}));return {reservationId:String(r.reservationId),budget:{...this.validate(object(r.budget),b.maxWorkers),tokenLimit:b.tokenLimit}};}return {budget:b};}
  async usage(b:BudgetSnapshot,graphId:string,attemptId:string,entryId:string,tokens:unknown,ctx:PluginContext):Promise<BudgetSnapshot>{if(typeof entryId!=='string'||!entryId||tokens!==undefined&&(!Number.isInteger(tokens)||Number(tokens)<0))throw new CapabilityError('VALIDATION_ERROR','原生usage无效');const receiptId=`${attemptId}:${entryId}`;
    const known=this.store.db.prepare('SELECT tokens FROM swarm_budget_usage WHERE budget_id=? AND receipt_id=?').get(b.budgetId,receiptId);if(known&&(known.tokens===null?tokens!==undefined:Number(known.tokens)!==tokens))throw new CapabilityError('VERSION_CONFLICT','同一原生usage收据内容变化');
    this.store.db.prepare('INSERT OR IGNORE INTO swarm_budget_usage VALUES(?,?,?,?,?,?,?)').run(b.budgetId,receiptId,graphId,attemptId,entryId,tokens===undefined?null:Number(tokens),JSON.stringify({synced:false}));
    if(ctx.policy){for(const row of this.store.db.prepare('SELECT * FROM swarm_budget_usage WHERE budget_id=?').all(b.budgetId)){const saved=JSON.parse(String(row.json));if(saved.synced)continue;await ctx.request('runtime','budget.usage',{budgetId:b.budgetId,receiptId:row.receipt_id,attemptId:row.attempt_id,entryId:row.native_entry_id,tokens:row.tokens===null?undefined:Number(row.tokens)});this.store.db.prepare('UPDATE swarm_budget_usage SET json=? WHERE budget_id=? AND receipt_id=?').run(JSON.stringify({synced:true}),b.budgetId,String(row.receipt_id));}}
    const rows=this.store.db.prepare('SELECT tokens FROM swarm_budget_usage WHERE budget_id=?').all(b.budgetId);return {...b,tokenUsed:rows.reduce((n,r)=>n+Number(r.tokens||0),0),tokenUnknown:rows.some(r=>r.tokens===null)};}
  async complete(b:BudgetSnapshot,graphId:string,taskId:string,ctx:PluginContext,prompt:string,options:{signal?:AbortSignal;maxTokens?:number}={}):Promise<{text:string;budget:BudgetSnapshot}>{
    const attemptId=`complete:${randomUUID()}`,reserved=await this.reserve(b,graphId,taskId,attemptId,ctx);
    let observed:{callId:string;tokens?:number}|undefined,updated=reserved.budget,result='',failure:{error:unknown}|undefined;
    try {result=await ctx.complete(prompt,{...options,budgetId:b.budgetId,callId:attemptId,stage:taskId,onUsage:receipt=>{observed=receipt;}});}
    catch(error){failure={error};}
    // A failed provider response can still contain billable native usage. Persist it before releasing the reservation.
    try {updated=await this.usage(updated,graphId,attemptId,observed?.callId||attemptId,observed?.tokens,{...ctx,origin:'plugin'});}
    catch(error){failure??={error};}
    try {ctx.emit('runtime.model-usage',{runId:ctx.runId,callId:observed?.callId||attemptId,tokens:observed?.tokens});}
    catch(error){failure??={error};}
    try {updated=await this.release(updated,reserved.reservationId,ctx);}
    catch(error){failure??={error};}
    if(failure)throw failure.error;
    return {text:result,budget:updated};
  }
  async release(b:BudgetSnapshot,reservationId:string|undefined,ctx:PluginContext):Promise<BudgetSnapshot>{if(reservationId&&ctx.policy){const r=object(await ctx.request('runtime','budget.release',{budgetId:b.budgetId,reservationId}));return {...this.validate(r,b.maxWorkers),tokenLimit:b.tokenLimit};}return b;}
}
