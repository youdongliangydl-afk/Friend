import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,readdirSync,lstatSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {structuredPatch,formatPatch} from 'diff';
import {parsePatch,fitChangedFile,budgetWorkspaceDiff,boundDiffRefs as boundRefs,DIFF_PATCH_BUDGET} from './diff-budget.js';
export {parsePatch,fitChangedFile,compactDiffPatch,budgetWorkspaceDiff,DIFF_PATCH_BUDGET} from './diff-budget.js';
import {join,resolve,relative,isAbsolute,extname} from 'node:path';
import {RecordStore,digest} from '@friend-pi/core';
const execute=promisify(execFile);
const MAX=1024*1024;
export interface DiffLine {kind:'context'|'add'|'remove'|'meta';text:string;oldLine?:number;newLine?:number}
export interface ChangedFile {path:string;oldPath?:string;status:string;staged:boolean;binary:boolean;additions?:number;deletions?:number;patch:string;lines:DiffLine[];truncated?:boolean;error?:string;contextComplete?:boolean;contextNote?:string}
export type DiffScope='workspace'|'unstaged'|'staged'|'run'|'committed'|'branch';
export interface DiffRef {name:string;sha:string;label:string}
export interface DiffComparison {headSha?:string;baseSha?:string;ref?:string;refSha?:string;rootCommit?:boolean}
export interface FilePreview {path:string;kind:string;size:number;content?:string;dataUrl?:string;reason?:string;offset?:number;startLine?:number;nextOffset?:number;truncated?:boolean}
export interface WorkspaceDiff {scope:DiffScope;files:ChangedFile[];unavailable?:string;baseline?:{createdAt:string;head?:string};note?:string;refs?:DiffRef[];refsTruncated?:boolean;comparison?:DiffComparison;fileCount?:number;omittedFiles?:number;responseBytes?:number;truncated?:boolean}
interface Baseline {head?:string;sessionId?:string;files:Record<string,{content?:string;binary:boolean;hash?:string;mode?:number;exists?:boolean}>;complete:boolean;createdAt:string}
async function git(cwd:string,args:string[],diff=false){try{return (await execute('git',['--literal-pathspecs','-c','core.fsmonitor=false','-c','diff.external=','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',maxBuffer:8*MAX,timeout:30000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}})).stdout;}catch(e){const error=e as {code?:number;stdout?:string};if(diff&&error.code===1)return error.stdout||'';throw new Error('无法读取 Git 状态或 Diff，请检查项目和文件权限');}}
interface GitWorkspace {repoRoot:string;prefix:string}
async function gitWorkspace(root:string):Promise<GitWorkspace>{const actual=realpathSync(root),repoRoot=realpathSync((await git(actual,['rev-parse','--show-toplevel'])).replace(/\r?\n$/,'')),prefix=relative(repoRoot,actual);if(prefix==='..'||prefix.startsWith('../')||isAbsolute(prefix))throw new Error('项目不在 Git 仓库内');return {repoRoot,prefix};}
function projectGitPath(path:string,workspace:GitWorkspace){return workspace.prefix?(path.startsWith(workspace.prefix+'/')?path.slice(workspace.prefix.length+1):undefined):path;}
function projectGitRows(rows:{path:string;oldPath?:string;xy:string}[],workspace:GitWorkspace):{path:string;oldPath?:string;xy:string}[]{return rows.flatMap(row=>{const path=projectGitPath(row.path,workspace),oldPath=row.oldPath?projectGitPath(row.oldPath,workspace):undefined,localStatus=(status:string)=>row.xy.length===2?(row.xy[0]===' '?' '+status:status+' '):status;if(path!==undefined)return [{...row,path,oldPath,...(row.oldPath&&oldPath===undefined?{xy:localStatus('A')}:{})}];return oldPath!==undefined?[{path:oldPath,xy:localStatus('D')}]:[];});}
export function projectFile(root:string,path:string){const base=realpathSync(root),actual=realpathSync(resolve(base,path));const rel=relative(base,actual);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('文件不在当前项目内');return actual;}
export function fileTree(root:string){const entries:{path:string;kind:string}[]=[];const visit=(dir:string,depth:number)=>{if(depth>6||entries.length>=2000)return;for(const name of readdirSync(dir).sort()){if(['.git','node_modules','.cache','.artifacts'].includes(name))continue;const absolute=join(dir,name),stat=lstatSync(absolute),path=relative(root,absolute);entries.push({path,kind:stat.isSymbolicLink()?'symlink':stat.isDirectory()?'directory':'file'});if(stat.isDirectory())visit(absolute,depth+1);if(entries.length>=2000)break;}};visit(root,0);return {entries,truncated:entries.length>=2000};}
export function previewFile(root:string,path:string,offset=0,line?:number):FilePreview {const actual=projectFile(root,path),stat=lstatSync(actual);if(!stat.isFile())throw new Error('请选择文件');const extension=extname(actual).toLowerCase();const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml'};
 if(mime[extension])return stat.size<=10*MAX?{path:relative(root,actual),kind:'image',size:stat.size,dataUrl:`data:${mime[extension]};base64,${readFileSync(actual).toString('base64')}`}:{path:relative(root,actual),kind:'unsupported',size:stat.size,reason:'图片超过 10 MiB'};
 const fd=openSync(actual,'r');try{let start=Math.max(0,Math.min(stat.size,Math.floor(offset))),startLine=1;const scan=Buffer.alloc(65536);let position=0;const desired=line&&Number.isInteger(line)?Math.max(1,Math.min(10000000,line)):undefined;if(desired)start=0;while(position<(desired?stat.size:start)){const n=readSync(fd,scan,0,Math.min(scan.length,(desired?stat.size:start)-position),position);if(!n)break;let found=false;for(let i=0;i<n;i++){if(scan[i]===10){startLine++;if(desired&&startLine===desired){start=position+i+1;found=true;break;}}}position+=n;if(found)break;if(desired)start=position;if(desired===1){start=0;startLine=1;break;}}if(desired===1){start=0;startLine=1;}const bytes=Buffer.alloc(Math.min(256*1024,stat.size-start));let count=readSync(fd,bytes,0,bytes.length,start);if(bytes.subarray(0,Math.min(count,8192)).includes(0))return {path:relative(root,actual),kind:'binary',size:stat.size};let content='';const decoder=new TextDecoder('utf-8',{fatal:true});for(let trim=0;trim<4;trim++){try{content=decoder.decode(bytes.subarray(0,count));break;}catch{if(start+count>=stat.size||trim===3)return {path:relative(root,actual),kind:'unsupported',size:stat.size,reason:'不是可预览的 UTF-8 文本'};count--;}}const end=start+count;return {path:relative(root,actual),kind:extension==='.md'?'markdown':'text',size:stat.size,content,offset:start,startLine,nextOffset:end<stat.size?end:undefined,truncated:end<stat.size};}finally{closeSync(fd);}}
async function statuses(root:string,workspace?:GitWorkspace){workspace??=await gitWorkspace(root);const raw=await git(workspace.repoRoot,['status','--porcelain=v1','-z','--untracked-files=all','--',workspace.prefix||'.']);const parts=raw.split('\0');const result:{path:string;oldPath?:string;xy:string}[]=[];for(let i=0;i<parts.length;i++){const part=parts[i];if(!part)continue;const xy=part.slice(0,2),path=part.slice(3);result.push({path,xy,...(/[RC]/.test(xy)?{oldPath:parts[++i]}:{})});}return projectGitRows(result,workspace);}

function fileContent(root:string,path:string):CapturedRunFile {
 const base=realpathSync(root),entry=resolve(base,path),rel=relative(base,entry);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('文件不在当前项目内');
 try{const stat=lstatSync(entry),mode=stat.mode&0o777;if(!stat.isFile())return {exists:true,binary:true,mode};if(stat.size>MAX)return {exists:true,binary:true,oversized:true,mode};const fd=openSync(projectFile(base,path),'r'),probe=Buffer.alloc(MAX+1);let length=0;try{while(length<probe.length){const count=readSync(fd,probe,length,probe.length-length,null);if(!count)break;length+=count;}}finally{closeSync(fd);}if(length>MAX)return {exists:true,binary:true,oversized:true,mode};const bytes=probe.subarray(0,length);let content:string|undefined;try{if(!bytes.includes(0))content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{}return {exists:true,mode,hash:createHash('sha256').update(bytes).digest('hex'),binary:content===undefined,...(content!==undefined?{content}:{})};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {exists:false,binary:false,content:''};throw error;}
}
export interface CapturedRunFile {exists:boolean;binary:boolean;content?:string;hash?:string;mode?:number;oversized?:boolean}
/** Distinguish an absent Git workspace/executable from a repository whose baseline failed. */
export async function hasGitRepository(root:string){
 try{await execute('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}});return true;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;let directory=realpathSync(root);while(true){if(lstatExists(join(directory,'.git')))return true;const parent=resolve(directory,'..');if(parent===directory)return false;directory=parent;}}
}
/** Bounded file-tool capture, including absent paths; refuses symlink escapes and unrelated directories. */
export function captureToolFile(root:string,path:string):{path:string;file:CapturedRunFile}|undefined {
 const base=realpathSync(root),absolute=resolve(base,path),rel=relative(base,absolute);
 if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))return;
 let parent=absolute;while(!lstatExists(parent)){const next=resolve(parent,'..');if(next===parent)return;parent=next;}
 const canonical=realpathSync(parent),parentRel=relative(base,canonical);if(parentRel==='..'||parentRel.startsWith('../')||isAbsolute(parentRel))return;
 if(!lstatExists(absolute))return {path:rel,file:{exists:false,binary:false,content:''}};
 const actual=projectFile(base,path),stat=lstatSync(actual);if(!stat.isFile())return;
 const mode=stat.mode&0o777;if(stat.size>MAX)return {path:rel,file:{exists:true,binary:true,oversized:true,mode}};
 const fd=openSync(actual,'r'),probe=Buffer.alloc(MAX+1);let length=0;
 try{while(length<probe.length){const n=readSync(fd,probe,length,probe.length-length,null);if(!n)break;length+=n;}}finally{closeSync(fd);}
 if(length>MAX)return {path:rel,file:{exists:true,binary:true,oversized:true,mode}};
 const bytes=probe.subarray(0,length),binary=bytes.includes(0);
 return {path:rel,file:{exists:true,binary,mode,hash:createHash('sha256').update(bytes).digest('hex'),...(!binary?{content:bytes.toString('utf8')}:{})}};
}
function lstatExists(path:string){try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
/** DSH Git snapshots cover all workspace paths except ignored files; gitlinks are never descended. */
export async function uncoveredToolPaths(root:string,paths:string[]){
 const entries=(await git(root,['ls-files','--stage','-z'])).split('\0');
 const links=entries.filter(entry=>entry.startsWith('160000 ')).map(entry=>entry.slice(entry.indexOf('\t')+1));
 const candidates=paths.filter(path=>!links.some(link=>path===link||path.startsWith(link+'/')));
 if(!candidates.length)return new Set<string>();
 const output=await new Promise<string>((resolveResult,reject)=>{
  const child=execFile('git',['-c','core.fsmonitor=false','check-ignore','-z','--stdin'],{cwd:root,encoding:'utf8',maxBuffer:8*MAX,timeout:30000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}},(error,stdout)=>{if(error&&(error as {code?:number}).code!==1)reject(error);else resolveResult(stdout);});
  child.stdin?.on('error',()=>{});child.stdin?.end(candidates.join('\0')+'\0');
 });
 return new Set(output.split('\0').filter(Boolean));
}
export function textFileDiff(path:string,before:string,after:string):Pick<ChangedFile,'patch'|'lines'|'additions'|'deletions'|'contextComplete'|'contextNote'> {
 const result=structuredPatch(path,path,before,after,undefined,undefined,{context:MAX,timeout:100});
 let patch:string;
 if(result)patch=formatPatch(result);
 else {
  const lines=(value:string)=>value===''?[]:(value.endsWith('\n')?value.slice(0,-1):value).split('\n');
  const a=lines(before),b=lines(after),eof=(value:string)=>value&&!value.endsWith('\n')?['\\ No newline at end of file']:[];
  patch=['diff 比较超时，按整文件替换展示','--- '+path,'+++ '+path,`@@ -1,${a.length} +1,${b.length} @@`,...a.map(line=>'-'+line),...eof(before),...b.map(line=>'+'+line),...eof(after)].join('\n');
 }
 const lines=parsePatch(patch);
 return {patch,lines,additions:lines.filter(line=>line.kind==='add').length,deletions:lines.filter(line=>line.kind==='remove').length,contextComplete:true,...(!result?{contextNote:'比较超时，按整文件替换展示。'}:{})};
}
export async function compareToolCapture(root:string,path:string,before:CapturedRunFile):Promise<ChangedFile|undefined>{
 const captured=captureToolFile(root,path);if(!captured)return {path,status:'M',binary:true,staged:false,patch:'',lines:[],error:'文件路径已不在当前工作区内'};
 return compareFiles(path,before,captured.file,false);
}
const absent=():CapturedRunFile=>({exists:false,binary:false,content:''});
function gitMode(mode?:number){return mode===0o755?'100755':'100644';}
function compareFiles(path:string,before:CapturedRunFile,after:CapturedRunFile,staged:boolean,oldPath?:string,status?:string):ChangedFile|undefined {
 if(before.exists===after.exists&&before.mode===after.mode&&(before.hash&&before.hash===after.hash||!before.exists&&!after.exists)&&!oldPath)return;
 const binary=before.binary||after.binary,kind=!after.exists?'D':!before.exists?'A':status||'M';
 let value:ChangedFile={path,oldPath,status:kind,binary,staged,patch:'',lines:[]};
 if(!binary&&before.content!==after.content)value={...value,...textFileDiff(path,before.content||'',after.content||'')};
 else {
  const metadata=[...(oldPath?[`rename from ${oldPath}`,`rename to ${path}`]:[]),...(before.mode!==after.mode&&before.exists&&after.exists?[`File mode changed ${gitMode(before.mode)} → ${gitMode(after.mode)}`,`old mode ${gitMode(before.mode)}`,`new mode ${gitMode(after.mode)}`]:[]),...(before.exists!==after.exists?[after.exists?(binary?'New file':'New empty file'):(binary?'Deleted file':'Deleted empty file')]:[])];
  if(binary&&(!metadata.length||before.hash!==after.hash))metadata.push(before.oversized||after.oversized?'文件超过 1024 KiB 文本读取上限；仅提供变更元数据。':'Binary content changed');
  const patch=metadata.join('\n');value={...value,patch,lines:parsePatch(patch),...(!binary?{additions:0,deletions:0,contextComplete:true}:{})};
 }
 return fitChangedFile(value);
}
/** Read raw blobs, never textconv, external diff, checkout or the current filesystem. */
async function headContent(root:string,head:string,path:string,workspace?:GitWorkspace):Promise<CapturedRunFile>{
 workspace??=await gitWorkspace(root);const repoPath=workspace.prefix?workspace.prefix+'/'+path:path,cwd=workspace.repoRoot;
 const listing=await git(cwd,head?['ls-tree','-z',head,'--',repoPath]:['ls-files','--stage','-z','--',repoPath]);
 const entries=listing.split('\0').filter(entry=>entry.slice(entry.indexOf('\t')+1)===repoPath);
 if(!entries.length)return absent();
 const entry=entries.find(entry=>head||entry.slice(0,entry.indexOf('\t')).endsWith(' 0'));if(!entry)throw new Error('此文件索引存在未解决的合并冲突');
 const fields=entry.slice(0,entry.indexOf('\t')).split(' '),object=fields[head?2:1],mode=fields[0]==='100755'?0o755:0o644;
 if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object))throw new Error('无效 Git 对象标识');
 if(!/^100(?:644|755)$/.test(fields[0]))return {exists:true,binary:true,mode};
 // A recorded path with a missing promised blob is unavailable, never an absent file.
 let size:number;try{size=Number((await git(cwd,['cat-file','-s',object])).trim());}catch{throw new Error('Git 对象在本地不可读取，可能尚未下载；此 Diff 不会自动访问远端。');}if(!Number.isSafeInteger(size)||size<0)throw new Error('无效 Git blob 大小');
 if(size>MAX)return {exists:true,binary:true,oversized:true,mode};
 const {stdout}=await execute('git',['--literal-pathspecs','-c','core.fsmonitor=false','-c','diff.external=','-c','core.hooksPath=/dev/null','show',object],{cwd,encoding:'buffer',maxBuffer:MAX+1,timeout:30000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}});
 let content:string|undefined;try{if(!stdout.includes(0))content=new TextDecoder('utf-8',{fatal:true}).decode(stdout);}catch{}
 return {exists:true,hash:createHash('sha256').update(stdout).digest('hex'),mode,binary:content===undefined,...(content!==undefined?{content}:{})};
}
export async function captureRunBaseline(root:string,projectId:string,runId:string,dataDir:string,sessionId?:string,reuse=false){
 const s=new RecordStore('diff',dataDir);try{
  const prior=s.get<Baseline>(`baseline:${projectId}:${runId}`)?.value;if(reuse&&prior&&prior.sessionId===sessionId)return {complete:prior.complete,createdAt:prior.createdAt};
  const workspace=await gitWorkspace(root);let head:string|undefined;try{head=(await git(workspace.repoRoot,['rev-parse','--verify','HEAD^{commit}'])).trim();}catch{}
  const rows=await statuses(root,workspace),files:Baseline['files']={};let size=0,complete=true;
  for(const path of [...new Set(rows.flatMap(row=>row.oldPath?[row.path,row.oldPath]:[row.path]))]){const content=fileContent(root,path);size+=Buffer.byteLength(content.content||'');if(size>DIFF_PATCH_BUDGET||Object.keys(files).length>=500){complete=false;break;}files[path]=content;}
  const createdAt=new Date().toISOString();s.put(`baseline:${projectId}:${runId}`,{head,sessionId,files,complete,createdAt} satisfies Baseline);return {complete,createdAt};
 }finally{s.close();}
}
export async function listDiffRefs(root:string):Promise<DiffRef[]>{
 const raw=await git(root,['for-each-ref','--count=513','--format=%(refname)%00%(objectname)%00%(objecttype)','refs/heads','refs/remotes']);
 return raw.split('\n').filter(Boolean).flatMap(line=>{const [name,sha,type]=line.split('\0');return type==='commit'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)&&/^refs\/(heads|remotes)\//.test(name)?[{name,sha,label:name.replace(/^refs\/(?:heads|remotes)\//,'')}]:[];}).sort((a,b)=>a.name.localeCompare(b.name));
}
function nameStatus(raw:string){
 const parts=raw.split('\0'),rows:{path:string;oldPath?:string;xy:string}[]=[];
 for(let i=0;i<parts.length;){const xy=parts[i++];if(!xy)continue;const first=parts[i++];if(!first)throw new Error('Git 路径列表不完整');if(/^[RC]/.test(xy)){const path=parts[i++];if(!path)throw new Error('Git 重命名列表不完整');rows.push({xy,path,oldPath:first});}else rows.push({xy,path:first});}
 return rows;
}
export async function workspaceDiff(root:string,projectId:string,dataDir:string,scope:DiffScope='workspace',runId?:string,selection:{ref?:string;refSha?:string}={}):Promise<WorkspaceDiff>{
 if(!['workspace','unstaged','staged','run','committed','branch'].includes(scope))throw new Error('Diff 范围无效');
 let refs:DiffRef[],refsTruncated=false,rows:Awaited<ReturnType<typeof statuses>>,head:string|undefined,workspace:GitWorkspace;
 try{workspace=await gitWorkspace(root);({refs,refsTruncated}=boundRefs(await listDiffRefs(workspace.repoRoot)));rows=await statuses(root,workspace);try{head=(await git(workspace.repoRoot,['rev-parse','--verify','HEAD^{commit}'])).trim();}catch{}}
 catch{return {scope,files:[],unavailable:'当前项目不是可读取的 Git 工作区'};}
 let baseline:Baseline|undefined,base:string|undefined,rootCommit=false;
 const comparison:DiffComparison={headSha:head};
 const unavailable=(message:string):WorkspaceDiff=>budgetWorkspaceDiff({scope,files:[],refs,refsTruncated,comparison,unavailable:message});
 if(scope==='committed'||scope==='branch'){
  if(!head)return unavailable('当前仓库还没有 HEAD 提交。');
  if(scope==='committed'){const parents=(await git(root,['rev-list','--parents','-n','1',head,'--'])).trim().split(/\s+/);base=parents[1];rootCommit=!base;comparison.rootCommit=rootCommit;comparison.baseSha=base;}
  else {
   const chosen=refs.find(ref=>ref.name===selection.ref);
   if(!chosen)return unavailable('请选择本仓库枚举的对比分支。');
   if(selection.refSha!==chosen.sha)return unavailable('对比分支 SHA 已变化或未冻结，请刷新后重新选择。');
   const verified=(await git(root,['rev-parse','--verify','--end-of-options',`${chosen.sha}^{commit}`])).trim();if(verified!==chosen.sha)return unavailable('所选分支不是已验证的提交。');
   comparison.ref=chosen.name;comparison.refSha=chosen.sha;
   let bases:string[];try{bases=(await git(root,['merge-base','--all',chosen.sha,head])).trim().split('\n').filter(Boolean);}catch{return unavailable('所选分支与 HEAD 没有共同祖先。');}
   if(bases.length!==1)return unavailable('所选分支有多个合并基点，无法提供唯一比较。');base=bases[0];comparison.baseSha=base;
  }
  rows=projectGitRows(nameStatus(await git(workspace.repoRoot,rootCommit?['diff-tree','--no-ext-diff','--no-textconv','--root','--no-commit-id','--name-status','-r','-z','--find-renames',head,'--',workspace.prefix||'.']:['diff','--no-ext-diff','--no-textconv','--name-status','-z','--find-renames',base!,head,'--',workspace.prefix||'.'])),workspace);
 }else if(scope==='run'){
  const s=new RecordStore('diff',dataDir);try{baseline=runId?s.get<Baseline>(`baseline:${projectId}:${runId}`)?.value:undefined;}finally{s.close();}
  if(!baseline?.complete)return unavailable('本轮开始基线不可用，不能用工作区改动代替本轮');
  comparison.baseSha=baseline.head;
  if(!baseline.head){for(const repoPath of (await git(workspace.repoRoot,['ls-files','-z','--',workspace.prefix||'.'])).split('\0').filter(Boolean)){const path=projectGitPath(repoPath,workspace);if(path!==undefined&&!rows.some(row=>row.path===path))rows.push({path,xy:' M'});}}
  if(baseline.head){try{for(const repoPath of (await git(workspace.repoRoot,['diff','--no-ext-diff','--no-textconv','--name-only','-z','--no-renames',baseline.head,'--',workspace.prefix||'.'])).split('\0').filter(Boolean)){const path=projectGitPath(repoPath,workspace);if(path!==undefined&&!rows.some(row=>row.path===path))rows.push({path,xy:' M'});}}catch{return unavailable('Git 基线不可读取，本轮范围不可用');}}
  for(const path of Object.keys(baseline.files))if(!rows.some(row=>row.path===path))rows.push({path,xy:' M'});
 }else if(scope==='staged')rows=rows.filter(row=>row.xy[0]!==' '&&row.xy!=='??');
 else if(scope==='unstaged')rows=rows.filter(row=>row.xy[1]!==' '||row.xy==='??');
 const files:ChangedFile[]=[];let omittedFiles=0,examined=0,remaining=DIFF_PATCH_BUDGET-Buffer.byteLength(JSON.stringify({scope,refs,comparison}))-4096;
 for(const row of rows){
  if(examined++>=500){omittedFiles++;continue;}
  let file:ChangedFile|undefined;
  try{
   if(row.xy.includes('U')||row.xy==='AA'||row.xy==='DD')throw new Error('此文件存在未解决的合并冲突；未将冲突索引当作空文件比较。');
   let before:CapturedRunFile,after:CapturedRunFile;
   if(scope==='run'){const saved=baseline!.files[row.path];before=saved?{...saved,exists:saved.exists!==false}:(baseline!.head?await headContent(root,baseline!.head,row.path,workspace):absent());after=fileContent(root,row.path);}
   else if(scope==='committed'||scope==='branch'){before=base?await headContent(root,base,row.oldPath||row.path,workspace):absent();after=await headContent(root,head!,row.path,workspace);}
   else if(scope==='staged'){before=head?await headContent(root,head,row.oldPath||row.path,workspace):absent();after=await headContent(root,'',row.path,workspace);}
   else {before=scope==='unstaged'?await headContent(root,'',row.path,workspace):head?await headContent(root,head,row.oldPath||row.path,workspace):absent();after=fileContent(root,row.path);}
   file=compareFiles(row.path,before,after,scope==='staged'||(scope==='workspace'&&row.xy[0]!==' '&&row.xy!=='??'),scope==='run'||scope==='unstaged'?undefined:row.oldPath,scope==='run'?undefined:row.xy);
  }catch(error){file={path:row.path,oldPath:row.oldPath,status:row.xy,staged:scope==='staged',binary:false,patch:'',lines:[],error:error instanceof Error?error.message:String(error)};}
  if(!file)continue;
  file=fitChangedFile(file,Math.max(0,remaining),true);const size=Buffer.byteLength(JSON.stringify(file))+1;if(size>remaining){omittedFiles++;continue;}remaining-=size;files.push(file);
 }
 const incomplete=omittedFiles>0||files.some(file=>file.truncated||file.contextComplete===false);
 return budgetWorkspaceDiff({scope,files,refs,refsTruncated,comparison,fileCount:files.length+omittedFiles,omittedFiles,truncated:incomplete,baseline:baseline?{createdAt:baseline.createdAt,head:baseline.head}:undefined,note:scope==='run'?'此范围表示本轮期间的文件变化，包括同期外部编辑。':rootCommit?'HEAD 为根提交：显示空树 → HEAD；没有 HEAD^。':scope==='committed'?'显示 HEAD 第一父提交 → HEAD，不包含未提交变化。':scope==='branch'?'显示所选分支与 HEAD 的唯一 merge-base → HEAD，不包含未提交变化。':undefined});
}
