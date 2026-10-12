export type MemoryViewScope='project'|'personal'|'all';
export interface MemoryViewRecord {id:string;revision:number;scope:string;status:string;content:string}
export function memoryView<T extends MemoryViewRecord>(memories:T[],candidates:T[],scope:MemoryViewScope,results:T[]|null=null){
  const available=new Map<string,T>();
  for(const record of [...memories,...candidates])if(!available.has(record.id)||available.get(record.id)!.revision<record.revision)available.set(record.id,record);
  const selected=results===null?[...available.values()]:[...new Set(results.map(record=>record.id))].flatMap(id=>available.has(id)?[available.get(id)!]:[]);
  const visible=selected.filter(record=>scope==='all'||record.scope===scope);
  return {memories:visible.filter(record=>record.status==='active'||record.status==='inactive'),candidates:visible.filter(record=>record.status==='candidate'||record.status==='invalidated')};
}
export function memorySummary(content:string,max=110){
  const text=Array.from(content.replace(/\s+/gu,' ').trim());
  return text.length>max?text.slice(0,max).join('')+'…':text.join('');
}

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const list=(value:unknown):Record<string,unknown>[]=>Array.isArray(value)?value.map(object):[];
const count=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
export function memoryLearningView(value:unknown){
  const job=object(value),progress=object(job.progress),budget=object(job.budget),ledger=list(job.proposalLedger),known=count(progress.proposals)!==undefined;
  const states:Record<string,string>={extract:'提取来源',validate:'核对提案',publish:'发布记忆',compact:'可选整理',reflection:'旧版提取',dream:'旧版整理'};
  return {stage:states[String(job.stage)]||'处理阶段未记录',known,total:count(progress.proposals),processed:count(progress.processed),published:count(progress.published),candidates:count(progress.candidates),rejected:count(progress.rejected),pending:count(progress.pending),continuing:progress.continuing===true,source:typeof progress.sourceEnteredExtraction==='boolean'?(progress.sourceEnteredExtraction?'来源已进入提取':'来源尚未进入提取'):'来源提取进度未记录',calls:count(budget.calls),maxCalls:count(budget.maxCalls),tokens:count(budget.tokens),usageUnknown:budget.usageUnknown===true||budget.unknown===true,rejections:ledger.filter(item=>item.state==='rejected'||item.state==='candidate').map(item=>({id:String(item.id),title:String(object(item.original).title||'未命名提案'),state:item.state,reason:String(item.reason||'等待核对')}))};
}
const omissionLabels:Record<string,string>={'body-budget':'正文与完整条件超出预算','directory-budget':'目录超出预算','record-limit':'本轮正文条数已满','preference-applicability-unknown':'长期偏好的适用范围待核对','source-unavailable':'来源不可用','conflict':'记忆存在冲突','validity':'记忆不在有效期内','forgotten':'记忆已遗忘'};
export function memoryRecallView(value:unknown){
  const usage=object(value),receipts=[...new Map([...list(usage.receipts),...list(usage.stageReceipts)].map((receipt,index)=>[receipt.operationId?`${receipt.operationId}:${receipt.stage}`:`unkeyed:${index}`,receipt])).values()],unique=(records:Record<string,unknown>[])=>new Map(records.map(record=>[`${record.id}:${record.revision}:${record.hash||''}`,record])).size;
  const records=(stages:string[])=>receipts.filter(receipt=>stages.includes(String(receipt.stage))).flatMap(receipt=>list(receipt.records));
  const omissions=new Map<string,{id:string;revision?:number;reason:string;readRef:Record<string,unknown>}>();
  for(const receipt of receipts)for(const omitted of list(receipt.omitted)){const ref=object(omitted.readRef),key=`${omitted.id}:${ref.revision||''}:${omitted.reason}`;omissions.set(key,{id:String(omitted.id),revision:count(ref.revision),reason:omissionLabels[String(omitted.reason)]||String(omitted.reason||'原因未记录'),readRef:ref});}
  return {recorded:receipts.length>0,directory:unique(receipts.flatMap(receipt=>list(receipt.directory))),selected:unique(receipts.flatMap(receipt=>list(receipt.records))),context:unique(records(['injected-to-context'])),request:unique(records(['request-prepared'])),response:unique(records(['response-observed'])),tool:unique(records(['tool-read'])),sourceReads:list(usage.sourceReceipts).length,omissions:[...omissions.values()],rawCount:receipts.length+list(usage.sourceReceipts).length};
}
export interface MemoryImpactDraft {title:string;content:string;generation:number;preview:Record<string,unknown>|null;error:string}
export type MemoryImpactEvent={type:'open';generation:number;title:string;content:string}|{type:'change';generation:number;title?:string;content?:string}|{type:'start';generation:number}|{type:'ready';generation:number;preview:unknown}|{type:'error';generation:number;error:string};
export function memoryImpactDraft(state:MemoryImpactDraft,event:MemoryImpactEvent):MemoryImpactDraft {
  if(event.type==='ready'||event.type==='error'){if(event.generation!==state.generation)return state;return {...state,preview:event.type==='ready'?object(event.preview):null,error:event.type==='error'?event.error:''};}
  if(event.generation<=state.generation)return state;
  return {...state,...(event.type==='open'?{title:event.title,content:event.content}:event.type==='change'?{...(event.title!==undefined?{title:event.title}:{}),...(event.content!==undefined?{content:event.content}:{})}:{}),generation:event.generation,preview:null,error:''};
}
export function memoryImpactMutation(preview:unknown,action:'update'|'forget',id:string,patch?:Record<string,unknown>){
  const value=object(preview);if(value.action!==action||value.id!==id||typeof value.previewToken!=='string'||!value.previewToken||!Number.isSafeInteger(value.revision)||Number(value.revision)<1)throw new Error('请先重新预览影响，再确认操作。');
  return {id,revision:Number(value.revision),previewToken:value.previewToken,...(action==='update'?{patch:patch||{}}:{})};
}
export function memoryImpactChanged(preview:unknown,snapshot:unknown):boolean {
  const value=object(preview),current=object(snapshot);if(!Array.isArray(current.memories)||!Array.isArray(current.candidates))return false;
  if(typeof value.epoch==='number'&&typeof current.epoch==='number'&&value.epoch!==current.epoch)return true;
  const records=new Map([...list(current.memories),...list(current.candidates)].map(record=>[record.id,record]));
  return list(value.affected).some(expected=>{const record=records.get(expected.id);return !record?expected.id===value.id:record.revision!==expected.revision||typeof expected.hash==='string'&&typeof record.hash==='string'&&record.hash!==expected.hash;});
}
