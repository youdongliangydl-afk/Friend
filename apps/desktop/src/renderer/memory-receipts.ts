import {asList,asObject} from './types.js';

/**
 * Memory injection receipts (renderer side).
 *
 * Input is the native custom-entry list the desktop already exposes as
 * `state.current.receipts` (`friend-pi.memory.usage:v1`). The producer records
 * one receipt per stage; this module only merges what was recorded. It never
 * upgrades "selected" to "injected" and never invents a turn for a missing runId.
 */
const USAGE_TYPE='friend-pi.memory.usage';
export const MEMORY_RECEIPT_STAGES=['prepared','retrieved','context-observed','injected-to-context','request-prepared','response-observed','tool-read'] as const;
export const MEMORY_RECEIPT_STAGE_LABELS:Record<string,string>={prepared:'已选中',retrieved:'检索已返回','context-observed':'历史上下文观察（等级未提升）','injected-to-context':'已进入上下文','request-prepared':'已进入请求准备','response-observed':'响应已观察','tool-read':'工具正文已读'};
const CONTEXT_STAGES=new Set(['injected-to-context','request-prepared','response-observed']);
const TOOL_STAGES=new Set(['tool-read']);
const SELECTED_STAGES=new Set(['prepared','retrieved','context-observed']);
export const MEMORY_OMISSION_LABELS:Record<string,string>={'body-budget':'正文与完整条件超出预算','directory-budget':'目录超出预算','record-limit':'本轮正文条数已满','preference-applicability-unknown':'长期偏好的适用范围待核对','source-unavailable':'来源不可用','conflict':'记忆存在冲突','validity':'记忆不在有效期内','forgotten':'记忆已遗忘','directory-only':'只进入目录，正文未读'};

const text=(value:unknown)=>typeof value==='string'?value:'';
const safeInt=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?value:undefined;
const strings=(value:unknown)=>asList<unknown>(value).filter((item):item is string=>typeof item==='string'&&item.length>0);
const at=(value:unknown)=>text(value);
const later=(left:string,right:string)=>left&&right?left>right?left:right:left||right;

export type MemoryInjectionGroup='catalog'|'injected'|'unused'|'unknown';
export interface MemoryInjectionSource {sessionId:string;entryId:string}
export interface MemoryInjectionEntry {
 key:string;id:string;revision:number|undefined;hash:string;title:string;content:string;
 group:MemoryInjectionGroup;label:string;reason:string;stages:string[];tool:boolean;catalog:boolean;unknownStage:boolean;
 lastAt:string;conditions:string[];sources:MemoryInjectionSource[];
}
export interface MemoryInjectionTurn {
 runId:string;label:string;current:boolean;at:string;receipts:number;operations:string[];
 catalog:MemoryInjectionEntry[];injected:MemoryInjectionEntry[];unused:MemoryInjectionEntry[];unknown:MemoryInjectionEntry[];
 budget:string;note:string;
}
export interface MemoryInjectionView {
 recorded:boolean;receiptCount:number;turns:MemoryInjectionTurn[];currentRunId:string;reason:string;warnings:string[];
 counts:{catalog:number;injected:number;unused:number;unknown:number};
}

interface TurnState {
 runId:string;index:number;at:string;receipts:number;operations:Set<string>;unknownStage:boolean;
 records:Map<string,MemoryInjectionEntry>;directories:Map<string,MemoryInjectionEntry>;omissions:Map<string,MemoryInjectionEntry>;
 budgetUsed:number|undefined;budgetLimit:number|null|undefined;
}
const groupLabel=(group:MemoryInjectionGroup,tool=false)=>group==='catalog'?'目录指针':group==='injected'?(tool?'工具正文读取':'正文注入'):group==='unused'?'未使用':'阶段未记录';
const keyOf=(id:string,revision:number|undefined)=>`${id}:${revision===undefined?'':revision}`;

function entryOf(id:string,revision:number|undefined):MemoryInjectionEntry {
 return {key:keyOf(id,revision),id,revision,hash:'',title:'',content:'',group:'unknown',label:groupLabel('unknown'),reason:'',stages:[],tool:false,catalog:false,unknownStage:false,lastAt:'',conditions:[],sources:[]};
}
function mergeSource(entry:MemoryInjectionEntry,value:unknown):void {
 for(const raw of asList<unknown>(value)){
  const source=asObject(raw),sessionId=text(source.sessionId),entryId=text(source.entryId);
  if(!sessionId&&!entryId)continue;
  if(!entry.sources.some(item=>item.sessionId===sessionId&&item.entryId===entryId))entry.sources.push({sessionId,entryId});
 }
}
function applyRecord(entry:MemoryInjectionEntry,record:Record<string,unknown>,stage:string,known:boolean,atValue:string):void {
 entry.title=entry.title||text(record.title);
 entry.content=entry.content||text(record.content);
 entry.hash=entry.hash||text(record.hash)||text(record.sentSliceHash);
 entry.conditions.push(...strings(record.conditions).filter(condition=>!entry.conditions.includes(condition)));
 mergeSource(entry,record.sources);
 entry.lastAt=later(entry.lastAt,atValue);
 if(text(record.omittedReason)&&!entry.reason)entry.reason=MEMORY_OMISSION_LABELS[text(record.omittedReason)]||text(record.omittedReason);
 if(known&&!entry.stages.includes(stage))entry.stages.push(stage);
 if(!known)entry.unknownStage=true;
}
/** Receipts are keyed by runId (one desktop run = one turn); a missing runId stays unknown. */
export function memoryInjectionView(receipts:unknown,currentRunId=''):MemoryInjectionView {
 const turns=new Map<string,TurnState>(),warnings:string[]=[];
 let receiptCount=0,missingIds=0,malformed=0;const seenReceipts=new Set<string>();
 for(const raw of asList<unknown>(receipts)){
  const receipt=asObject(raw),customType=text(receipt.customType);
  // Only the exact receipt type or its explicit version suffix; a look-alike type must not be counted.
  if(customType!==USAGE_TYPE&&!customType.startsWith(USAGE_TYPE+':'))continue;
  const data=asObject(receipt.data);
  if(!Object.keys(data).length){warnings.push('有一条记忆回执缺少数据体，未纳入统计');continue;}
  const runId=text(data.runId),knownRun=runId&&runId!=='unrecorded'?runId:'',key=knownRun||'unrecorded';
  // The same receipt may be replayed by a projection refresh; count it once per run.
  const receiptId=text(receipt.id);if(receiptId){const seen=`${key}|${receiptId}|${JSON.stringify(data)}`;if(seenReceipts.has(seen))continue;seenReceipts.add(seen);}
  receiptCount++;
  let turn=turns.get(key);
  if(!turn){turn={runId:knownRun,index:turns.size,at:'',receipts:0,operations:new Set(),unknownStage:false,records:new Map(),directories:new Map(),omissions:new Map(),budgetUsed:undefined,budgetLimit:undefined};turns.set(key,turn);}
  turn.receipts++;
  turn.at=later(turn.at,at(data.at));
  const operationId=text(data.operationId);if(operationId)turn.operations.add(operationId);
  const stage=text(data.stage),known=MEMORY_RECEIPT_STAGES.includes(stage as never);
  if(!known)turn.unknownStage=true;
  const budget=asObject(data.budget),used=safeInt(budget.used),rawLimit=budget.limit;
  if(used!==undefined)turn.budgetUsed=Math.max(turn.budgetUsed??0,used);
  if(rawLimit===null)turn.budgetLimit=turn.budgetLimit===undefined?null:turn.budgetLimit;
  else if(safeInt(rawLimit)!==undefined)turn.budgetLimit=safeInt(rawLimit);
  if(data.records!==undefined&&!Array.isArray(data.records))malformed++;
  for(const record of asList<unknown>(data.records).map(asObject)){
   const id=text(record.id);
   if(!id){missingIds++;continue;}
   const revision=safeInt(record.revision),entryKey=keyOf(id,revision),existing=turn.records.get(entryKey);
   const entry=existing||entryOf(id,revision);
   const hash=text(record.hash)||text(record.sentSliceHash);
   if(existing&&hash&&entry.hash&&hash!==entry.hash)warnings.push(`记忆 ${id} v${revision??'未记录'} 出现不同摘要，未合并为同一版本`);
   applyRecord(entry,record,stage,known,at(data.at));
   turn.records.set(entryKey,entry);
  }
  for(const pointer of asList<unknown>(data.directory).map(asObject)){
   const id=text(pointer.id);
   if(!id){missingIds++;continue;}
   const revision=safeInt(pointer.revision),entryKey=keyOf(id,revision),entry=turn.directories.get(entryKey)||entryOf(id,revision);
   entry.title=entry.title||text(pointer.title);
   entry.hash=entry.hash||text(pointer.hash);
   entry.conditions.push(...strings(pointer.conditions).filter(condition=>!entry.conditions.includes(condition)));
   mergeSource(entry,pointer.sources);
   entry.lastAt=later(entry.lastAt,at(data.at));
   if(text(pointer.omittedReason))entry.reason=MEMORY_OMISSION_LABELS[text(pointer.omittedReason)]||text(pointer.omittedReason);
   turn.directories.set(entryKey,entry);
  }
  for(const omission of asList<unknown>(data.omitted).map(asObject)){
   const id=text(omission.id),readRef=asObject(omission.readRef),revision=safeInt(readRef.revision),entryKey=keyOf(id,revision);
   if(!id){missingIds++;continue;}
   const entry=turn.omissions.get(entryKey)||entryOf(id,revision),reason=text(omission.reason);
   entry.reason=MEMORY_OMISSION_LABELS[reason]||reason||'原因未记录';
   entry.lastAt=later(entry.lastAt,at(data.at));
   turn.omissions.set(entryKey,entry);
  }
 }
 if(missingIds)warnings.push(`有 ${missingIds} 条记录或指针缺少标识，未纳入统计`);
 if(malformed)warnings.push(`有 ${malformed} 条回执的记录列表格式未知，未推测其正文`);
 const counts={catalog:0,injected:0,unused:0,unknown:0};
 const result=[...turns.values()].map(turn=>{
  for(const entry of turn.records.values()){
   const context=entry.stages.some(stage=>CONTEXT_STAGES.has(stage)),tool=entry.stages.some(stage=>TOOL_STAGES.has(stage)),selected=entry.stages.some(stage=>SELECTED_STAGES.has(stage));
   const catalog=turn.directories.has(entry.key);
   entry.catalog=catalog;
   entry.tool=tool&&!context;
   if(context||tool){entry.group='injected';entry.label=groupLabel('injected',entry.tool);entry.reason=entry.reason||(context?'已观察到进入上下文或请求的回执':'已观察到工具正文读取的回执');}
   else if(selected||entry.reason){entry.group='unused';entry.label=selected?'选中未注入':'未使用';entry.reason=entry.reason||'已选中但没有观察到注入收据';}
   else{entry.group='unknown';entry.label=groupLabel('unknown');entry.reason=entry.reason||'阶段未记录，不能断言是否注入';}
  }
  for(const entry of turn.directories.values())if(!turn.records.has(entry.key)){entry.group='catalog';entry.label=groupLabel('catalog');entry.catalog=true;entry.reason=entry.reason||'仅目录可见，正文未读';}
  const injected=[...turn.records.values()].filter(entry=>entry.group==='injected');
  const unused=[...turn.records.values()].filter(entry=>entry.group==='unused');
  const unknown=[...turn.records.values()].filter(entry=>entry.group==='unknown');
  const catalog=[...turn.directories.values()].filter(entry=>!turn.records.has(entry.key));
  for(const entry of [...turn.omissions.values()])if(!turn.records.has(entry.key)&&!turn.directories.has(entry.key))unused.push({...entry,group:'unused',label:'未入选',reason:entry.reason||'未记录原因'});
  const sortEntries=(entries:MemoryInjectionEntry[])=>entries.sort((left,right)=>(right.lastAt||'').localeCompare(left.lastAt||'')||left.key.localeCompare(right.key));
  sortEntries(injected);sortEntries(unused);sortEntries(unknown);sortEntries(catalog);
  counts.catalog+=catalog.length;counts.injected+=injected.length;counts.unused+=unused.length;counts.unknown+=unknown.length;
  const budget=describeBudget(turn);
  const turnLabel=turn.runId?`轮次 ${turn.runId.slice(0,8)}`:'轮次未记录';
  return {runId:turn.runId,label:turnLabel,current:!!currentRunId&&turn.runId===currentRunId,at:turn.at,receipts:turn.receipts,operations:[...turn.operations],catalog,injected,unused,unknown,budget,note:turn.unknownStage?'存在阶段未记录的回执：阶段不明的记录不计入注入，也不计入未使用。':'',index:turn.index} as MemoryInjectionTurn&{index:number};
 }).sort((left,right)=>(right.at&&left.at?right.at.localeCompare(left.at):0)||right.index-left.index).map(({index:_index,...turn})=>turn as MemoryInjectionTurn);
 return {recorded:receiptCount>0,receiptCount,turns:result,currentRunId:currentRunId||'',reason:receiptCount?'':'本会话尚无记忆注入回执；没有收据不代表没有相关记忆，只代表没有记录。',warnings:[...new Set(warnings)],counts};
}

function describeBudget(turn:TurnState):string {
 if(turn.budgetUsed===undefined&&turn.budgetLimit===undefined)return '正文预算未记录';
 const used=turn.budgetUsed===undefined?'用量未记录':`已用 ${turn.budgetUsed} 字符`;
 const limit=turn.budgetLimit===undefined?'上限未记录':turn.budgetLimit===null?'未设上限':`上限 ${turn.budgetLimit} 字符`;
 return `本轮正文预算：${used} / ${limit}`;
}

/** Canonical stage order for display; unknown stages are listed after the known ones. */
export function memoryReceiptStages(stages:string[]):{stage:string;label:string;known:boolean}[] {
 const rank=(stage:string)=>{const index=MEMORY_RECEIPT_STAGES.indexOf(stage as never);return index<0?MEMORY_RECEIPT_STAGES.length:index;};
 return [...new Set(stages)].sort((left,right)=>rank(left)-rank(right)||left.localeCompare(right)).map(stage=>({stage,label:MEMORY_RECEIPT_STAGE_LABELS[stage]||'阶段未记录',known:MEMORY_RECEIPT_STAGES.includes(stage as never)}));
}
export function memorySourceText(source:MemoryInjectionSource):string {
 return [source.sessionId,source.entryId].filter(Boolean).join(' · ')||'来源未记录';
}
