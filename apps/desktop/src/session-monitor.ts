import {randomUUID} from 'node:crypto';
import {object} from '@friend-pi/core';
export const SESSION_METRIC_TYPE='friend-pi.session.metric.v1';
export interface StepMetric {v:1;entryId:string;turnId:string;stepId:string;closed:boolean;llmMs:number;ttftMs?:number;decodeMs?:number;outputTokens?:number}
export interface SessionMonitor {
 v:1;turns:number;steps:number;legacySteps:number;llmMs:number;toolMs:number;ttftMs:number;ttftSteps:number;decodeMs:number;decodeTokens:number;
 tokens:{input:number;output:number;cacheRead:number;cacheWrite:number;total:number};
 context?:{tokens:number|null;contextWindow:number;percent:number|null};
}
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
/** Public Pi execution boundaries map to DSH turns/steps; only numeric receipts enter native history. */
export class SessionMetricRecorder {
 private turnId='';private stepId='';private started?:number;private first?:number;private retry=false;private hasReply=false;private failed=false;private ended?:Omit<StepMetric,'entryId'>;
 constructor(private now:()=>number=()=>performance.now()){}
 observe(raw:unknown):Omit<StepMetric,'entryId'>|undefined{
  const event=object(raw);
  if(event.type==='auto_retry_start'){this.retry=true;return this.ended?{...this.ended,closed:false}:undefined;}
  if(event.type==='auto_retry_end'){this.retry=false;return event.success===false&&this.ended?{...this.ended,closed:true}:undefined;}
  if(event.type==='agent_start'&&!this.retry){this.turnId=randomUUID();this.hasReply=false;}
  if(event.type==='turn_start'){
   if(!this.retry||this.started===undefined){this.stepId=randomUUID();this.started=this.now();this.first=undefined;this.ended=undefined;this.failed=false;}
   this.retry=false;return;
  }
  const message=object(event.message||{});
  if(event.type==='turn_end'&&this.ended)return {...this.ended,closed:!this.failed&&!this.retry};
  // The installed SDK decides retries after turn_end, on public agent_end.willRetry.
  if(event.type==='agent_end'&&this.failed&&this.ended)return {...this.ended,closed:event.willRetry!==true};
  if(event.type==='message_start'&&message.role==='user'&&this.hasReply){this.turnId=randomUUID();this.hasReply=false;}
  if(event.type==='message_update'&&this.started!==undefined&&this.first===undefined){
   const delta=object(event.assistantMessageEvent||{}),part=object((object(delta.partial||{}).content as unknown[]|undefined)?.[Number(delta.contentIndex)]||{});
   const hasDelta=['text_delta','thinking_delta','toolcall_delta'].includes(String(delta.type))&&typeof delta.delta==='string'&&delta.delta.length>0;
   if(hasDelta||delta.type==='toolcall_start'&&typeof part.name==='string'&&part.name.length>0)this.first=this.now();
  }
  if(event.type!=='message_end'||message.role!=='assistant'||this.started===undefined)return;
  const end=this.now(),output=object(message.usage||{}).output;this.hasReply=true;this.failed=message.stopReason==='error';
  this.ended={v:1,turnId:this.turnId||randomUUID(),stepId:this.stepId,closed:false,llmMs:Math.max(0,end-this.started),
   ...(this.first===undefined?{}:{ttftMs:Math.max(0,this.first-this.started),decodeMs:Math.max(0,end-this.first)}),...(nonnegative(output)?{outputTokens:output}:{})};
  return this.ended;
 }
}
/** Whole native history, independent of rendered branch, paging and compaction. SDK owns token accounting. */
export function projectSessionMonitor(entries:readonly unknown[],sdkStats:unknown,context:unknown):SessionMonitor{
 const all=entries.map(object),receipts=new Map<string,StepMetric>(),automatic=new Set<string>();
 for(const entry of all)if(entry.type==='custom'&&entry.customType==='friend-pi.runtime-wake.input')automatic.add(String(object(entry.data||{}).entryId));
 for(const entry of all){const value=object(entry.data||{});if(entry.type==='custom'&&entry.customType===SESSION_METRIC_TYPE&&value.v===1&&typeof value.entryId==='string'&&typeof value.stepId==='string'&&typeof value.turnId==='string'&&nonnegative(value.llmMs))receipts.set(value.entryId,value as unknown as StepMetric);}
 const stats:SessionMonitor={v:1,turns:0,steps:0,legacySteps:0,llmMs:0,toolMs:0,ttftMs:0,ttftSteps:0,decodeMs:0,decodeTokens:0,tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const steps=new Map<string,StepMetric>(),turns=new Set<string>(),anchors=new Map<string,string>();let legacyTurn='initial';
 for(const entry of all){const message=object(entry.message||{}),id=String(entry.id);
  const inherited=typeof entry.parentId==='string'?anchors.get(entry.parentId):undefined;
  if(entry.type==='message'&&message.role==='user'&&!automatic.has(id))legacyTurn=id;
  const anchor=message.role==='user'&&!automatic.has(id)?id:inherited||legacyTurn;anchors.set(id,anchor);
  if(entry.type!=='message')continue;
  if(message.role==='toolResult'&&nonnegative(message.durationMs))stats.toolMs+=message.durationMs;
  if(message.role!=='assistant')continue;
  const receipt=receipts.get(String(entry.id));
  if(receipt)steps.set(receipt.stepId,receipt);
  else{stats.legacySteps++;stats.steps++;turns.add('legacy:'+anchor);if(nonnegative(message.durationMs))stats.llmMs+=message.durationMs;}
 }
 for(const receipt of steps.values()){
  if(receipt.closed){stats.steps++;turns.add(receipt.turnId);}stats.llmMs+=receipt.llmMs;
  if(nonnegative(receipt.ttftMs)){stats.ttftMs+=receipt.ttftMs;stats.ttftSteps++;}
  if(nonnegative(receipt.decodeMs)&&nonnegative(receipt.outputTokens)){stats.decodeMs+=receipt.decodeMs;stats.decodeTokens+=receipt.outputTokens;}
 }
 stats.turns=turns.size;
 const tokens=object(object(sdkStats).tokens||{});for(const key of ['input','output','cacheRead','cacheWrite'] as const)if(nonnegative(tokens[key]))stats.tokens[key]=tokens[key];
 stats.tokens.total=stats.tokens.input+stats.tokens.output+stats.tokens.cacheRead+stats.tokens.cacheWrite;
 const usage=object(context||{});if(nonnegative(usage.contextWindow)&&usage.contextWindow>0)stats.context={tokens:nonnegative(usage.tokens)?usage.tokens:null,contextWindow:usage.contextWindow,percent:nonnegative(usage.tokens)?Math.min(100,Math.round(usage.tokens/usage.contextWindow*100)):null};
 return stats;
}
