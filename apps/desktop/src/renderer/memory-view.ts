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
