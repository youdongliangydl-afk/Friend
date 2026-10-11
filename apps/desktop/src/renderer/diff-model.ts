import type {DiffLine} from '../workspace-files.js';

export interface IndexedDiffLine {line:DiffLine;index:number}
export type DiffDisplayItem = {kind:'line';value:IndexedDiffLine}|{kind:'fold';key:string;count:number;hidden:IndexedDiffLine[]};
export interface SplitDiffRow {left?:IndexedDiffLine;right?:IndexedDiffLine;meta?:IndexedDiffLine;fold?:Extract<DiffDisplayItem,{kind:'fold'}>}

/** Only context actually present in the frozen patch can be expanded. */
export function foldDiffLines(lines:DiffLine[],context=3):DiffDisplayItem[]{
 const result:DiffDisplayItem[]=[];
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(line.kind!=='context'){if(line.kind!=='meta'||line.text.startsWith('@@')||line.text.startsWith('\\'))result.push({kind:'line',value:{line,index:i}});i++;continue;}
  const start=i;while(i<lines.length&&lines[i].kind==='context')i++;
  const prefix=start>0&&['add','remove'].includes(lines[start-1].kind)?context:0,suffix=i<lines.length&&['add','remove'].includes(lines[i].kind)?context:0;
  const block=lines.slice(start,i).map((line,index)=>({line,index:start+index}));
  if(block.length<=prefix+suffix+1){result.push(...block.map(value=>({kind:'line' as const,value})));continue;}
  result.push(...block.slice(0,prefix).map(value=>({kind:'line' as const,value})));
  const hidden=block.slice(prefix,suffix?block.length-suffix:undefined);
  result.push({kind:'fold',key:`context:${start}:${i}`,count:hidden.length,hidden});
  if(suffix)result.push(...block.slice(-suffix).map(value=>({kind:'line' as const,value})));
 }
 return result;
}
export function expandDiffItems(items:DiffDisplayItem[],expanded:ReadonlySet<string>):DiffDisplayItem[]{return items.flatMap(item=>item.kind==='fold'&&expanded.has(item.key)?item.hidden.map(value=>({kind:'line' as const,value})): [item]);}
export function splitDiffRows(items:DiffDisplayItem[]):SplitDiffRow[]{
 const result:SplitDiffRow[]=[];
 for(let i=0;i<items.length;){
  const item=items[i];
  if(item.kind==='fold'){result.push({fold:item});i++;continue;}
  if(item.value.line.kind==='meta'){result.push({meta:item.value});i++;continue;}
  if(item.value.line.kind==='context'){result.push({left:item.value,right:item.value});i++;continue;}
  const removed:IndexedDiffLine[]=[],added:IndexedDiffLine[]=[];
  while(i<items.length){const next=items[i];if(next.kind!=='line'||!['add','remove'].includes(next.value.line.kind))break;(next.value.line.kind==='remove'?removed:added).push(next.value);i++;}
  for(let n=0;n<Math.max(removed.length,added.length);n++)result.push({left:removed[n],right:added[n]});
 }
 return result;
}
export const DIFF_PAGE_LINES=2000;
export interface DiffBlock {key:string;first:number;last:number;additions:number;deletions:number}
/** Blocks follow the existing three-line folds, independently of expanded context and display mode. */
export function projectDiffBlocks(lines:DiffLine[]):DiffBlock[]{
 const blocks:DiffBlock[]=[],changes:IndexedDiffLine[]=[];
 const finish=()=>{if(!changes.length)return;const first=changes[0].index,last=changes.at(-1)!.index;blocks.push({key:`block:${first}:${last}`,first,last,additions:changes.filter(value=>value.line.kind==='add').length,deletions:changes.filter(value=>value.line.kind==='remove').length});changes.length=0;};
 for(const item of foldDiffLines(lines)){
  if(item.kind==='fold'||item.value.line.kind==='meta'&&item.value.line.text.startsWith('@@')){finish();continue;}
  if(item.kind==='line'&&['add','remove'].includes(item.value.line.kind))changes.push(item.value);
 }
 finish();return blocks;
}
export function diffBlockLocation(lines:DiffLine[],block:DiffBlock,split:boolean,expanded:ReadonlySet<string>){
 const items=expandDiffItems(foldDiffLines(lines),expanded);
 const row=split?splitDiffRows(items).findIndex(value=>value.left?.index===block.first||value.right?.index===block.first):items.findIndex(value=>value.kind==='line'&&value.value.index===block.first);
 return row<0?undefined:{row,page:Math.floor(row/DIFF_PAGE_LINES)};
}
export function diffFileStatus(file:{status:string;oldPath?:string}){return file.status==='??'||file.status.includes('A')?'新增':file.status.includes('D')?'删除':file.oldPath?'重命名':'修改';}
export function diffFileRatio(file:{additions?:number;deletions?:number}){
 const known=typeof file.additions==='number'&&Number.isFinite(file.additions)&&file.additions>=0&&typeof file.deletions==='number'&&Number.isFinite(file.deletions)&&file.deletions>=0;
 if(!known)return undefined;const total=file.additions!+file.deletions!;return {additions:file.additions!,deletions:file.deletions!,addedPercent:total?file.additions!/total*100:0,removedPercent:total?file.deletions!/total*100:0};
}
/** An owner change uses its own initial index before effects or old file reads can run. */
export function selectedDiffIndex(owner:string,selection:{owner:string;index:number}|undefined,count:number,initial=0){const index=selection?.owner===owner?selection.index:initial;return count?Math.max(0,Math.min(Number.isSafeInteger(index)?index:0,count-1)):-1;}
export const DIFF_SCOPES=[['run','上一轮'],['workspace','未提交'],['unstaged','未暂存'],['staged','已暂存'],['committed','已提交'],['branch','分支比较']] as const;

/** A stale completion cannot change either the visible data or another request's pending state. */
export class DiffRequestGate {
 private generation=0;private identity='';
 begin(identity:string){this.identity=identity;return ++this.generation;}
 current(generation:number,identity:string){return generation===this.generation&&identity===this.identity;}
 invalidate(){this.generation++;}
}
export interface DiffLoadState<T>{pending:boolean;value?:T;error?:string}
/** Shared by the workspace UI and deferred-response tests. */
export class LatestDiffLoader<T>{
 private gate=new DiffRequestGate();
 constructor(private publish:(state:DiffLoadState<T>)=>void){}
 async load(identity:string,read:()=>Promise<T>){
  const generation=this.gate.begin(identity);this.publish({pending:true});
  try{const value=await read();if(this.gate.current(generation,identity))this.publish({pending:false,value});}
  catch(error){if(this.gate.current(generation,identity))this.publish({pending:false,error:error instanceof Error?error.message:String(error)});}
 }
 invalidate(){this.gate.invalidate();}
}
