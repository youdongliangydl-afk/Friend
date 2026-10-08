import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
export type PermissionMode = 'ask' | 'auto' | 'allPermissions';
export interface PermissionRequest { operation:string; message:string; autoEligible:boolean; requireExplicit?:boolean; writePath?:string; binding?:string }
export function parsePermissionMode(value:unknown):PermissionMode {
  if(value==='ask'||value==='auto'||value==='allPermissions')return value;
  throw new Error('权限策略无效');
}
export function permissionDecision(mode:PermissionMode,request:PermissionRequest):'ask'|'allow' {
  return !request.requireExplicit&&(mode==='allPermissions'||mode==='auto'&&request.autoEligible)?'allow':'ask';
}
// Match the pinned Pi write/edit path spelling, including @ and Unicode spaces.
export function permissionPath(input:string,cwd:string):string {
  let path=input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,' ');
  if(path.startsWith('@'))path=path.slice(1);
  if(path==='~')path=homedir();else if(path.startsWith('~/'))path=resolve(homedir(),path.slice(2));
  if(/^file:\/\//.test(path))path=fileURLToPath(path);
  return resolve(cwd,path);
}
function canonicalWritePath(path:string,seen=new Set<string>()):string {
  if(seen.has(path))throw new Error('路径无法解析');seen.add(path);
  let stat;
  try {stat=lstatSync(path);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const parent=dirname(path);if(parent===path)throw error;
    return resolve(canonicalWritePath(parent,seen),relative(parent,path));
  }
  return stat.isSymbolicLink()?canonicalWritePath(resolve(dirname(path),readlinkSync(path)),seen):realpathSync(path);
}
export function temporaryPermission(request:PermissionRequest,root:string|undefined,cwd=root):PermissionRequest {
  if(!root)return request;
  let target:string|undefined,scope:string|undefined,executionDirectory:string|undefined;
  try{scope=realpathSync(root);}catch{}
  try{executionDirectory=realpathSync(cwd||root);}catch{}
  if(request.writePath!==undefined)try{
    target=canonicalWritePath(permissionPath(request.writePath,cwd||root));
    if(scope!==resolve(root))throw new Error('临时目录已变化');
    const rel=relative(root,target);
    if(rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel))return {...request,binding:JSON.stringify([scope,target,executionDirectory])};
  }catch{/* An unresolved target cannot receive automatic approval. */}
  return {...request,requireExplicit:true,binding:JSON.stringify([scope,target,executionDirectory]),message:request.requireExplicit&&request.message.startsWith(`临时会话目录：${root}\n`)?request.message:`临时会话目录：${root}\n${target?`目录外目标：${target}`:`执行目录：${executionDirectory||cwd||root}\n此操作的写入范围无法确认，可能修改会话目录外的内容。`}\n${request.message}`};
}
export function temporaryPermissionMatches(request:PermissionRequest,root:string|undefined,cwd=root):boolean {
  return !root||request.binding===temporaryPermission(request,root,cwd).binding;
}
export function assertTemporaryArtifactPath(path:string,root:string|undefined):void {
  if(!root)return;
  try{const target=canonicalWritePath(resolve(path)),scope=realpathSync(root),rel=relative(scope,target);if(scope===resolve(root)&&(rel===''||rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel)))return;}catch{}
  throw new Error('产物路径超出临时会话目录，未写入');
}
export function destructiveCommand(command:string):boolean {
  const normalized=command.replace(/["']/g,'');
  return /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot)(?:\s|$)|\bgit\s+(?:reset\s+--hard|clean\b|push\b|branch\s+-[dD])|\b(?:npm|pnpm|yarn)\s+publish\b/i.test(normalized);
}
// This classifies approval requests; it is not a shell or filesystem sandbox.
export function readOnlyCommand(command:string):boolean {
  if(/[<>\n\r`"'\\$]|\$\(|\b(?:eval|exec)\b|--(?:output|pre|ext-diff|textconv)(?:[=\s]|$)/.test(command))return false;
  return command.split(/[;&|]+/).every(part=>/^(?:pwd|ls|cat|head|tail|wc|rg|grep|which|echo|printf)(?:\s|$)|^git\s+(?:status|diff|log|show|rev-parse)(?:\s|$)|^(?:node|npm|pnpm|yarn|python3?)\s+--version\s*$/.test(part.trim()));
}
export function toolPermissionRequest(tool:string,input:Record<string,unknown>,temporary=false):PermissionRequest|undefined {
  if(['read','ls','find','grep','swarm_review_result','swarm_message','team_message'].includes(tool))return;
  if(tool==='bash'){
    const command=String(input.command||'');if(readOnlyCommand(command))return;
    return {operation:'执行命令',message:command,autoEligible:false};
  }
  if(tool==='write'||tool==='edit')return {operation:'修改文件',message:String(input.path||''),writePath:String(input.path||''),autoEligible:true};
  if(tool==='friend_plan'||tool==='friend_terminal')return;
  if(tool==='swarm_shared')return input.action==='write'?{operation:'修改共享材料',message:String(input.name||input.documentId||'共享材料'),autoEligible:true}:undefined;
  if(tool.startsWith('friend_')){
    if(/^(?:read|list|snapshot|search|get|status|result|logs|versions|role\.(?:snapshot|read|versions)|history\.(?:read|search|around)|template\.(?:read|list)|shared\.(?:readVersion|conflicts))$/.test(String(input.action)))return;
    // Process command admission handles its own approval for GUI and tools alike.
    if(tool==='friend_jobs'&&input.action==='run'||tool==='friend_task'&&input.action==='verify'||tool==='friend_runtime'&&['jobs.run','task.verify'].includes(String(input.action)))return;
    return {operation:'调用工具',message:tool+' · '+String(input.action||''),autoEligible:true};
  }
  if(temporary)return {operation:'调用工具',message:tool,autoEligible:false};
}
