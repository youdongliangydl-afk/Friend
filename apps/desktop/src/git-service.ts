import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpathSync,statSync} from 'node:fs';
import {isAbsolute,relative,resolve,sep} from 'node:path';
const execute=promisify(execFile);
const MAX=1024*1024,PATCH_LIMIT=256*1024,FILE_LIMIT=500,PATH_LIMIT=200,MESSAGE_LIMIT=20000,LOG_DEFAULT=30,LOG_MAX=200,TIMEOUT=30000;
// Identical hardening to workspace-files.ts: literal pathspecs, no fsmonitor, no external diff,
// no repository hooks, no lazy fetch and no optional index locks.
const HARDENING=['--literal-pathspecs','-c','core.fsmonitor=false','-c','diff.external=','-c','core.hooksPath=/dev/null'];
const LOG_FORMAT='--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%P%x00%D%x1e';
export interface GitFile {path:string;oldPath?:string;xy:string;letter:string;staged:boolean;unstaged:boolean;untracked:boolean;conflict:boolean}
export interface GitStatus {branch:string;detached:boolean;head:string|null;shortHead:string|null;files:GitFile[];staged:number;unstaged:number;untracked:number;truncated:boolean;clean:boolean;projectPath:string;repoPath:string}
export interface GitCommit {sha:string;shortSha:string;subject:string;author:string;at:string;parents:string[];refs:string[]}
export interface GitLog {branch:string;detached:boolean;head:string|null;commits:GitCommit[];mayHaveMore:boolean;emptyRepository:boolean;projectPath:string}
export interface GitFileDiff {path:string;staged:boolean;patch:string;binary:boolean;untracked:boolean;truncated:boolean;additions:number;deletions:number;note?:string}
export interface GitResult {affected:number;status:GitStatus}
interface Workspace {projectDir:string;repoRoot:string;prefix:string}
interface StatusRow {path:string;oldPath?:string;xy:string}
type GitInput=Record<string,unknown>;
function run(cwd:string,args:string[]){return execute('git',[...HARDENING,...args],{cwd,encoding:'utf8',maxBuffer:8*MAX,timeout:TIMEOUT,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}}).then(result=>result.stdout);}
function rawOutput(error:unknown){const value=error as {stderr?:string;stdout?:string;message?:string};return String(value.stderr||value.stdout||value.message||'').trim();}
function readable(error:unknown,fallback:string){
  const value=error as {code?:unknown;killed?:boolean;signal?:string;message?:string};
  if(value.code==='ENOENT')return new Error('未找到 Git 命令，请先安装 Git 并确认 PATH 中可用');
  if(value.killed||value.signal)return new Error('Git 命令超时，请检查仓库大小、索引锁或挂载状态后重试');
  if(/maxBuffer|ENOBUFS/i.test(String(value.message||'')))return new Error('Git 输出超过单次读取上限，请在终端中处理此文件');
  const detail=rawOutput(error).split('\n').filter(Boolean).slice(-3).join(' ').slice(0,600);
  return new Error(detail?`${fallback}：${detail}`:fallback);
}
async function inspect(rootDir:string):Promise<Workspace>{
  if(typeof rootDir!=='string'||!rootDir.trim()||rootDir.length>4096||rootDir.includes('\0'))throw new Error('Git 工作目录无效');
  let projectDir:string;try{projectDir=realpathSync(rootDir);}catch{throw new Error('Git 工作目录不存在或不可访问');}
  let directory:boolean;try{directory=statSync(projectDir).isDirectory();}catch{throw new Error('Git 工作目录不可访问');}
  if(!directory)throw new Error('Git 面板只支持文件夹工作区');
  let repoRoot:string;
  try{const value=(await run(projectDir,['rev-parse','--show-toplevel'])).trim();if(!value)throw new Error('not a git repository (empty output)');repoRoot=realpathSync(value);}
  catch(error){const detail=rawOutput(error);if(/not a git repository/i.test(detail))throw new Error('当前项目不是 Git 仓库，无法使用 Git 面板');if(/dubious ownership/i.test(detail))throw new Error('Git 因仓库所有者不一致拒绝读取，请调整所有者或 safe.directory 后重试');throw readable(error,'无法读取 Git 仓库信息');}
  const prefix=relative(repoRoot,projectDir).split(sep).join('/');
  if(prefix==='..'||prefix.startsWith('../')||isAbsolute(prefix))throw new Error('项目不在 Git 仓库内');
  return {projectDir,repoRoot,prefix};
}
const scope=(workspace:Workspace)=>workspace.prefix||'.';
function repoPath(workspace:Workspace,value:unknown){
  if(typeof value!=='string'||!value||value.length>4096||value.includes('\0'))throw new Error('文件路径无效');
  if(isAbsolute(value))throw new Error('只能操作项目内的相对路径');
  const relativePath=relative(workspace.projectDir,resolve(workspace.projectDir,value)).split(sep).join('/');
  if(!relativePath||relativePath==='..'||relativePath.startsWith('../')||isAbsolute(relativePath))throw new Error('只能操作项目内的文件');
  if(relativePath==='.git'||relativePath.startsWith('.git/'))throw new Error('Git 内部文件不可在此操作');
  return workspace.prefix?`${workspace.prefix}/${relativePath}`:relativePath;
}
function repoPaths(workspace:Workspace,value:unknown,action:string){
  if(value===undefined||value===null)throw new Error(`请选择要${action}的文件`);
  const list=Array.isArray(value)?value:[value];
  if(!list.length)throw new Error(`请选择要${action}的文件`);
  if(list.length>PATH_LIMIT)throw new Error(`一次最多${action} ${PATH_LIMIT} 个文件`);
  return list.map(item=>repoPath(workspace,item));
}
const displayPath=(workspace:Workspace,path:string)=>workspace.prefix&&path.startsWith(workspace.prefix+'/')?path.slice(workspace.prefix.length+1):path;
function statusRows(raw:string):StatusRow[]{const parts=raw.split('\0'),rows:StatusRow[]=[];for(let index=0;index<parts.length;index++){const part=parts[index];if(!part)continue;const xy=part.slice(0,2),path=part.slice(3);rows.push({path,xy,...(/[RC]/.test(xy)?{oldPath:parts[++index]}:{})});}return rows;}
function classifyRow(path:string,xy:string,oldPath?:string,movedIn=false):GitFile{
  const index=xy[0],worktree=xy[1],untracked=xy==='??',conflict=/^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy);
  const letter=untracked?'U':conflict?'C':movedIn?'A':index!==' '?index:worktree;
  return {path,xy,letter,staged:!untracked&&index!==' ',unstaged:!untracked&&worktree!==' ',untracked,conflict,...(oldPath?{oldPath}:{})};
}
function mapStatusRow(workspace:Workspace,row:StatusRow):GitFile|undefined{
  const inside=(path:string)=>workspace.prefix?path.startsWith(workspace.prefix+'/'):true;
  const local=(path:string)=>workspace.prefix?path.slice(workspace.prefix.length+1):path;
  if(inside(row.path))return classifyRow(local(row.path),row.xy,row.oldPath&&inside(row.oldPath)?local(row.oldPath):undefined,!!row.oldPath&&!inside(row.oldPath));
  if(row.oldPath&&inside(row.oldPath))return classifyRow(local(row.oldPath),row.xy[0]===' '?' D':'D ');
  return undefined;
}
async function statusRowsOf(workspace:Workspace){
  const raw=await run(workspace.repoRoot,['-c','status.relativePaths=false','status','--porcelain=v1','-z','--untracked-files=all','--',scope(workspace)]).catch(error=>{throw readable(error,'无法读取 Git 状态');});
  return statusRows(raw);
}
async function branchOf(workspace:Workspace){try{return (await run(workspace.repoRoot,['symbolic-ref','--short','-q','HEAD'])).trim();}catch{return '';}}
async function headOf(workspace:Workspace){try{return (await run(workspace.repoRoot,['rev-parse','--verify','HEAD'])).trim()||null;}catch{return null;}}
function refLabel(value:string){const ref=value.trim().replace(/^HEAD -> /,'');if(!ref||ref==='HEAD')return '';return ref.replace(/^refs\/heads\//,'').replace(/^refs\/remotes\//,'').replace(/^refs\/tags\//,'tag:');}
function parseLog(raw:string):GitCommit[]{return raw.split('\x1e').map(record=>record.replace(/^\n+|\n+$/g,'')).filter(Boolean).map(record=>{const [sha='',shortSha='',subject='',author='',at='',parents='',refs='']=record.split('\0');return {sha,shortSha,subject:subject.replace(/[\r\n\t]+/g,' ').slice(0,200),author,at,parents:parents.split(' ').filter(Boolean),refs:refs.split(',').map(refLabel).filter(Boolean)};});}
function commitMessage(value:unknown){
  if(typeof value!=='string')throw new Error('请填写提交信息');
  const message=value.replace(/\r\n?/g,'\n').trim();
  if(!message)throw new Error('请填写提交信息');
  if(message.length>MESSAGE_LIMIT)throw new Error(`提交信息最多 ${MESSAGE_LIMIT} 个字符`);
  if(message.includes('\0'))throw new Error('提交信息包含非法字符');
  return message;
}
function logLimit(value:unknown){const limit=value===undefined?LOG_DEFAULT:Number(value);if(!Number.isInteger(limit)||limit<1||limit>LOG_MAX)throw new Error(`提交历史条数须为 1 至 ${LOG_MAX}`);return limit;}
function withinPrefix(path:string,prefix:string){return !prefix||path===prefix||path.startsWith(prefix+'/');}
/** `git diff --cached --name-status -z`: status, then one path, or two for rename/copy. */
function parseNameStatus(raw:string){const tokens=raw.split('\0'),entries:{status:string;paths:string[]}[]=[];let index=0;while(index<tokens.length){const status=tokens[index++];if(!status)continue;const paths=[tokens[index++]||''];if(/^[RC]/.test(status))paths.push(tokens[index++]||'');entries.push({status,paths:paths.filter(Boolean)});}return entries;}
const unsupported=(action:'push'|'fetch')=>new Error(`暂不支持 ${action}：为避免误操作，请在终端中手动执行 git ${action}`);
export async function gitStatus(rootDir:string):Promise<GitStatus>{
  const workspace=await inspect(rootDir),branch=await branchOf(workspace),head=await headOf(workspace);
  const files=(await statusRowsOf(workspace)).flatMap(row=>{const file=mapStatusRow(workspace,row);return file?[file]:[];});
  return {branch,detached:!branch&&!!head,head,shortHead:head?head.slice(0,7):null,files:files.slice(0,FILE_LIMIT),staged:files.filter(file=>file.staged).length,unstaged:files.filter(file=>file.unstaged).length,untracked:files.filter(file=>file.untracked).length,truncated:files.length>FILE_LIMIT,clean:files.length===0,projectPath:workspace.projectDir,repoPath:workspace.repoRoot};
}
export async function gitFileDiff(rootDir:string,input:{path:unknown;staged?:boolean}):Promise<GitFileDiff>{
  const workspace=await inspect(rootDir),path=repoPath(workspace,input.path),staged=input.staged===true,shownPath=displayPath(workspace,path);
  const row=(await statusRowsOf(workspace)).find(value=>value.path===path||value.oldPath===path);
  if(row?.xy==='??')return {path:shownPath,staged:false,patch:'',binary:false,untracked:true,truncated:false,additions:0,deletions:0,note:'未跟踪文件：暂存后才会出现在差异中'};
  // A rename can only be detected when both sides are given to diff; the panel shows it as one entry.
  const pathspecs=row?.oldPath?[row.oldPath,path]:[path];
  const raw=await run(workspace.repoRoot,['diff','--no-ext-diff','--no-textconv','--no-color','-U3',...(staged?['--cached']:[]),'--',...pathspecs]).catch(error=>{throw readable(error,'无法读取文件差异');});
  const cut=raw.length>PATCH_LIMIT?raw.lastIndexOf('\n',PATCH_LIMIT):-1,patch=cut>0?raw.slice(0,cut):raw.length>PATCH_LIMIT?raw.slice(0,PATCH_LIMIT):raw,truncated=patch.length<raw.length;
  const binary=/^Binary files .* differ$/m.test(patch)||patch.startsWith('GIT binary patch');
  const lines=patch.split('\n'),additions=lines.filter(line=>line.startsWith('+')&&!line.startsWith('+++')).length,deletions=lines.filter(line=>line.startsWith('-')&&!line.startsWith('---')).length;
  return {path:shownPath,staged,patch,binary,untracked:false,truncated,additions,deletions,...(truncated?{note:'差异过大，已截断；完整内容请在终端查看'}:binary?{note:'二进制文件差异不在此展开'}:!patch?{note:staged?'没有已暂存的改动':'没有未暂存的改动'}:{})};
}
export async function gitStage(rootDir:string,input:{paths?:unknown;all?:boolean}):Promise<GitResult>{
  const workspace=await inspect(rootDir),paths=input.all===true?[scope(workspace)]:repoPaths(workspace,input.paths,'暂存');
  const before=await gitStatus(rootDir);
  await run(workspace.repoRoot,['add','-A','--',...paths]).catch(error=>{
    const detail=rawOutput(error);
    if(/index\.lock/i.test(detail))throw new Error('Git 索引被占用（index.lock），请稍后重试');
    if(/ignored by one of your \.gitignore/i.test(detail))throw new Error('此文件被 .gitignore 忽略，需在终端中强制添加');
    throw readable(error,'暂存失败');
  });
  const after=await gitStatus(rootDir);
  return {affected:Math.max(0,after.staged-before.staged),status:after};
}
export async function gitUnstage(rootDir:string,input:{paths?:unknown;all?:boolean}):Promise<GitResult>{
  const workspace=await inspect(rootDir),paths=input.all===true?[scope(workspace)]:repoPaths(workspace,input.paths,'取消暂存'),head=await headOf(workspace),before=await gitStatus(rootDir);
  // An unborn branch has no HEAD to restore from, so remove the new entries from the index instead.
  const unstage=head?run(workspace.repoRoot,['restore','--staged','--',...paths]):run(workspace.repoRoot,['rm','--cached','-r','--ignore-unmatch','--quiet','--',...paths]);
  await unstage.catch(error=>{throw readable(error,'取消暂存失败');});
  const after=await gitStatus(rootDir);
  return {affected:Math.max(0,before.staged-after.staged),status:after};
}
export async function gitCommit(rootDir:string,input:{message:unknown}):Promise<{commit:GitCommit;status:GitStatus}>{
  const workspace=await inspect(rootDir),message=commitMessage(input.message);
  // Inspect the whole index, not just the project pathspec: a sub-directory workspace must never commit
  // changes that other work staged outside it.
  const staged=(await run(workspace.repoRoot,['diff','--cached','--name-status','-z','--']).catch(error=>{throw readable(error,'无法读取暂存区');}));
  const stagedPaths=parseNameStatus(staged).flatMap(entry=>entry.paths);
  const outer=stagedPaths.filter(path=>!withinPrefix(path,workspace.prefix));
  if(outer.length)throw new Error(`暂存区包含项目外的改动：${outer.slice(0,3).join('、')}${outer.length>3?' 等':''}。请先取消暂存，或在终端中提交。`);
  if(!stagedPaths.length)throw new Error('没有已暂存的文件，请先暂存要提交的改动');
  await run(workspace.repoRoot,['-c','commit.gpgsign=false','commit','-m',message]).catch(error=>{
    const detail=rawOutput(error);
    if(/Author identity unknown|Please tell me who you are|unable to auto-detect email/i.test(detail))throw new Error('尚未配置 Git 用户信息，请先设置 user.name 与 user.email');
    if(/nothing to commit|no changes added to commit/i.test(detail))throw new Error('暂存区没有可提交的改动');
    if(/index\.lock/i.test(detail))throw new Error('Git 索引被占用（index.lock），请稍后重试');
    throw readable(error,'提交失败');
  });
  const commit=parseLog(await run(workspace.repoRoot,['log','-1',LOG_FORMAT]).catch(error=>{throw readable(error,'提交已完成，但读取新提交信息失败');}))[0];
  if(!commit)throw new Error('提交已完成，但读取新提交信息失败');
  return {commit,status:await gitStatus(rootDir)};
}
export async function gitLog(rootDir:string,input:{limit?:unknown}={}):Promise<GitLog>{
  const workspace=await inspect(rootDir),limit=logLimit(input.limit),head=await headOf(workspace),branch=await branchOf(workspace);
  if(!head)return {branch:'',detached:false,head:null,commits:[],mayHaveMore:false,emptyRepository:true,projectPath:workspace.projectDir};
  const commits=parseLog(await run(workspace.repoRoot,['log',`--max-count=${limit}`,LOG_FORMAT,'--',scope(workspace)]).catch(error=>{throw readable(error,'无法读取提交历史');}));
  return {branch,detached:!branch,head,commits,mayHaveMore:commits.length>=limit,emptyRepository:false,projectPath:workspace.projectDir};
}
/** Parameterised Git service; every command runs inside rootDir with argv arrays only. */
export function gitService(rootDir:string|(()=>string)){
  const root=typeof rootDir==='function'?rootDir:()=>rootDir;
  return {
    status:()=>gitStatus(root()),
    diff:(input:{path:unknown;staged?:boolean})=>gitFileDiff(root(),input),
    stage:(input:{paths?:unknown;all?:boolean})=>gitStage(root(),input),
    unstage:(input:{paths?:unknown;all?:boolean})=>gitUnstage(root(),input),
    commit:(input:{message:unknown})=>gitCommit(root(),input),
    log:(input:{limit?:unknown}={})=>gitLog(root(),input),
    push:async():Promise<never>=>{throw unsupported('push');},
    fetch:async():Promise<never>=>{throw unsupported('fetch');},
  };
}
export type GitService=ReturnType<typeof gitService>;
export const gitMethods=['git.status','git.file.diff','git.stage','git.unstage','git.commit','git.log','git.push','git.fetch'] as const;
export type GitMethod=typeof gitMethods[number];
/** Pure IPC registration: main.ts owns resolveWorkspaceInput, this module owns argv safety. */
export function gitHandlers(rootDir:string|((input:GitInput)=>string)):Record<GitMethod,(input:GitInput)=>Promise<unknown>>{
  const service=(input:GitInput)=>gitService(typeof rootDir==='function'?()=>rootDir(input):rootDir);
  return {
    'git.status':input=>service(input).status(),
    'git.file.diff':input=>service(input).diff({path:input.path,staged:input.staged===true}),
    'git.stage':input=>service(input).stage({paths:input.paths,all:input.all===true}),
    'git.unstage':input=>service(input).unstage({paths:input.paths,all:input.all===true}),
    'git.commit':input=>service(input).commit({message:input.message}),
    'git.log':input=>service(input).log({limit:input.limit}),
    'git.push':async()=>{throw unsupported('push');},
    'git.fetch':async()=>{throw unsupported('fetch');},
  };
}
