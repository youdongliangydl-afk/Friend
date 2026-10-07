import {randomUUID} from 'node:crypto';
import {RecordStore,digest,text,type JsonObject} from '@friend-pi/core';
export interface PlanRecord {id:string;revision:number;hash:string;body:string;status:'proposed'|'approved'|'rejected';sessionId:string;projectId:string;modelId?:string;thinkingLevel?:string;mode:'single'|'swarm';createdAt:string;approvedAt?:string}
export class PlanStore {
 constructor(private store:RecordStore,private projectId:string,private sessionId:string){}
 private key(){return `plan:${this.projectId}:${this.sessionId}`;}
 current():PlanRecord|undefined{return this.store.get<PlanRecord>(this.key())?.value;}
 submit(body:string,snapshot:{modelId?:string;thinkingLevel?:string;mode:'single'|'swarm'}):PlanRecord {body=text(body,'计划',100000);const previous=this.current();const plan:PlanRecord={id:previous?.id||randomUUID(),revision:(previous?.revision||0)+1,hash:digest(body),body:text(body,'计划',100000),status:'proposed',projectId:this.projectId,sessionId:this.sessionId,...snapshot,createdAt:new Date().toISOString()};this.store.transaction(()=>{this.store.put(this.key(),plan);this.store.put(`version:${plan.id}:${plan.revision}`,plan,null);});return plan;}
 decide(action:'approve'|'reject',input:JsonObject,snapshot:{modelId?:string;thinkingLevel?:string;mode:'single'|'swarm'}):PlanRecord {const plan=this.current();if(!plan||plan.id!==input.id||plan.revision!==input.revision||plan.hash!==input.hash||plan.status!=='proposed')throw new Error('计划版本已变化，请阅读当前版本后再决定');if(action==='approve'&&(plan.modelId!==snapshot.modelId||plan.thinkingLevel!==snapshot.thinkingLevel||plan.mode!==snapshot.mode))throw new Error('执行配置已变化，请重新规划后批准');const next={...plan,status:action==='approve'?'approved' as const:'rejected' as const,...(action==='approve'?{approvedAt:new Date().toISOString()}:{})};this.store.put(this.key(),next);return next;}
}
