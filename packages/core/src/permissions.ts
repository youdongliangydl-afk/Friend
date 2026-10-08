export type PermissionMode = 'ask' | 'auto' | 'allPermissions';
export interface PermissionRequest { operation:string; message:string; autoEligible:boolean }
export function parsePermissionMode(value:unknown):PermissionMode {
  if(value==='ask'||value==='auto'||value==='allPermissions')return value;
  throw new Error('权限策略无效');
}
export function permissionDecision(mode:PermissionMode,request:PermissionRequest):'ask'|'allow' {
  return mode==='allPermissions'||mode==='auto'&&request.autoEligible?'allow':'ask';
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
export function toolPermissionRequest(tool:string,input:Record<string,unknown>):PermissionRequest|undefined {
  if(['read','ls','find','grep','swarm_review_result','swarm_message','team_message'].includes(tool))return;
  if(tool==='bash'){
    const command=String(input.command||'');if(readOnlyCommand(command))return;
    return {operation:'执行命令',message:command,autoEligible:false};
  }
  if(tool==='write'||tool==='edit')return {operation:'修改文件',message:String(input.path||''),autoEligible:true};
  if(tool==='friend_plan'||tool==='friend_terminal')return;
  if(tool==='swarm_shared')return input.action==='write'?{operation:'修改共享材料',message:String(input.name||input.documentId||'共享材料'),autoEligible:true}:undefined;
  if(tool.startsWith('friend_')){
    if(/^(?:read|list|snapshot|search|get|status|result|logs|versions|role\.(?:snapshot|read|versions)|history\.(?:read|search|around)|template\.(?:read|list)|shared\.(?:readVersion|conflicts))$/.test(String(input.action)))return;
    // Process command admission handles its own approval for GUI and tools alike.
    if(tool==='friend_jobs'&&input.action==='run'||tool==='friend_task'&&input.action==='verify'||tool==='friend_runtime'&&['jobs.run','task.verify'].includes(String(input.action)))return;
    return {operation:'调用工具',message:tool+' · '+String(input.action||''),autoEligible:true};
  }
}
