import {formatPatch,parsePatch as parseGitPatch} from 'diff';
import type {ChangedFile,DiffLine,DiffRef,WorkspaceDiff} from './workspace-files.js';
export const DIFF_PATCH_BUDGET=8*1024*1024;
export const DIFF_LINE_BUDGET=128*1024;
export const diffBytes=(text:string)=>new TextEncoder().encode(text).byteLength;

/** Scan the complete patch without splitting it or allocating a DiffLine per source line. */
function inspectPatch(patch:string){
 let lineCount=0,additions=0,deletions=0,inHunk=false;
 for(let start=0;start<=patch.length;){const end=patch.indexOf('\n',start),text=patch.slice(start,end<0?patch.length:end);lineCount++;if(text.startsWith('diff '))inHunk=false;if(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(text))inHunk=true;else if(inHunk){if(text.startsWith('+'))additions++;else if(text.startsWith('-'))deletions++;}if(end<0)break;start=end+1;}
 const bytes=diffBytes(patch);return {lineCount,additions,deletions,bytes,truncated:bytes>DIFF_PATCH_BUDGET||lineCount>DIFF_LINE_BUDGET};
}
export function parsePatchBounded(patch:string){
 const stats=inspectPatch(patch);if(stats.truncated)return {...stats,lines:[] as DiffLine[],parsedLineCount:0};
 let old=0,next=0,inHunk=false;const lines:DiffLine[]=patch.split('\n').map(text=>{const h=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);if(text.startsWith('diff '))inHunk=false;if(h){inHunk=true;old=Number(h[1]);next=Number(h[2]);return {kind:'meta',text};}if(inHunk&&text.startsWith('+'))return {kind:'add',text:text.slice(1),newLine:next++};if(inHunk&&text.startsWith('-'))return {kind:'remove',text:text.slice(1),oldLine:old++};if(text.startsWith(' ')&&old&&next)return {kind:'context',text:text.slice(1),oldLine:old++,newLine:next++};return {kind:'meta',text};});
 return {...stats,lines,parsedLineCount:lines.length};
}
export function parsePatch(patch:string):DiffLine[]{return parsePatchBounded(patch).lines;}
function metadataOnly(file:Omit<ChangedFile,'lines'>,stats:ReturnType<typeof inspectPatch>):ChangedFile {
 return {...file,...(!file.binary&&file.patch?{additions:stats.additions,deletions:stats.deletions}:{}),patch:'',lines:[],contextComplete:false,truncated:true,contextNote:'比较内容超过展示限额，文件统计保留，正文未提供。'};
}
export function parseChangedFile(file:Omit<ChangedFile,'lines'>):ChangedFile {
 if(!file.patch)return {...file,lines:[]};
 const parsed=parsePatchBounded(file.patch);return parsed.truncated?metadataOnly(file,parsed):{...file,lines:parsed.lines};
}

/** Remove only unchanged context; every changed line and EOF marker survives. */
export function compactDiffPatch(patch:string,context=3):string {
 if(inspectPatch(patch).truncated)return patch;
 try {
  const files=parseGitPatch(patch);
  if(files.length!==1||!files[0].hunks.length)return patch;
  const file=files[0],hunks:typeof file.hunks=[];
  for(const h of file.hunks){
   const keep=new Set<number>();
   h.lines.forEach((line,i)=>{if(line[0]==='+'||line[0]==='-'||line[0]==='\\')for(let j=Math.max(0,i-context);j<=Math.min(h.lines.length-1,i+context);j++)keep.add(j);});
   let old=h.oldStart,next=h.newStart;
   for(let i=0;i<h.lines.length;){
    if(!keep.has(i)){if(h.lines[i][0]!=='+'&&h.lines[i][0]!=='\\')old++;if(h.lines[i][0]!=='-'&&h.lines[i][0]!=='\\')next++;i++;continue;}
    const oldStart=old,newStart=next,lines:string[]=[];let oldLines=0,newLines=0;
    while(i<h.lines.length&&keep.has(i)){const line=h.lines[i++];lines.push(line);if(line[0]!=='+'&&line[0]!=='\\'){old++;oldLines++;}if(line[0]!=='-'&&line[0]!=='\\'){next++;newLines++;}}
    hunks.push({oldStart,oldLines,newStart,newLines,lines});
   }
  }
  return formatPatch({...file,hunks});
 }catch{return patch;}
}
/** The budget never silently clips a changed tail. Context is sacrificed first. */
export function fitChangedFile(file:ChangedFile,budget=DIFF_PATCH_BUDGET,serialized=false):ChangedFile {
 const stats=inspectPatch(file.patch);if(stats.truncated)return metadataOnly(file,stats);
 const size=(value:ChangedFile)=>diffBytes(serialized?JSON.stringify(value):value.patch);
 if(size(file)<=budget)return file;
 const compact=compactDiffPatch(file.patch),reduced=parseChangedFile({...file,patch:compact,contextComplete:false,contextNote:'上下文超出展示预算，仅保存改动周围 3 行；省略的正文不可展开。'});
 if(size(reduced)<=budget)return reduced;
 return {...file,patch:'',lines:[],contextComplete:false,truncated:true,contextNote:'比较内容超过 8 MiB 展示预算，未截断伪装为完整补丁；文件统计保留，正文未提供。'};
}
export function boundDiffRefs(refs:DiffRef[]){let bytes=0;const visible:DiffRef[]=[];for(const ref of refs){const size=diffBytes(JSON.stringify(ref))+1;if(visible.length>=512||bytes+size>512*1024)break;visible.push(ref);bytes+=size;}return {refs:visible,refsTruncated:visible.length<refs.length};}
/** Includes refs, metadata, line objects and JSON overhead in the single response budget. */
export function budgetWorkspaceDiff(data:WorkspaceDiff,budget=DIFF_PATCH_BUDGET):WorkspaceDiff {
 const bounded=boundDiffRefs(data.refs||[]),result:WorkspaceDiff={...data,...bounded,refsTruncated:data.refsTruncated||bounded.refsTruncated,files:[],fileCount:data.fileCount??data.files.length,omittedFiles:data.omittedFiles||0,responseBytes:budget,truncated:!!data.truncated};
 let remaining=budget-diffBytes(JSON.stringify(result))-32;
 for(const value of data.files){if(result.files.length>=500){result.omittedFiles!++;continue;}const file=fitChangedFile(value,Math.max(0,remaining),true),size=diffBytes(JSON.stringify(file))+1;if(size>remaining){result.omittedFiles!++;continue;}remaining-=size;result.files.push(file);}
 result.truncated=!!(result.truncated||result.omittedFiles||result.files.some(file=>file.truncated||file.contextComplete===false));
 result.responseBytes=diffBytes(JSON.stringify(result));result.responseBytes=diffBytes(JSON.stringify(result));return result;
}
