import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { MemberStart } from './types.js';

function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path); if (parent === path) return path;
  return resolve(canonical(parent),relative(parent,path));
}
export function contains(root: string, path: string): boolean {
  const rel = relative(canonical(resolve(root)),canonical(resolve(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function destructiveCommand(command: string): boolean {
  return /(?:^|[;&|\s])(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot)(?:\s|$)|\bgit\s+(?:reset\s+--hard|clean\b|push\b.*--force|branch\s+-[dD])|\b(?:npm|pnpm|yarn)\s+publish\b/i.test(command);
}
/** This is a high-trust tool policy, not a shell or OS sandbox. Nested Pi tool calls use the same hook. */
export function guardMember(start: MemberStart, confirm: (title:string,message:string)=>Promise<boolean>): ExtensionFactory {
  return pi => {
    pi.on('tool_call',async event => {
      if(event.toolName==='swarm_review_result'&&start.reviewResult)return;
      const input = event.input as Record<string,unknown>;
      const expert=start.expert && typeof start.expert==='object' ? start.expert as Record<string,unknown> : undefined;
      const role=expert?.role&&typeof expert.role==='object'?expert.role as Record<string,unknown>:undefined;
      if(role&&!['swarm_message','team_message'].includes(event.toolName)){
        if(!Array.isArray(role.effectiveTools)||!role.effectiveTools.includes(event.toolName))return {block:true,reason:'工具不在已冻结的角色合同'};
        if(['write','edit'].includes(event.toolName)&&(!Array.isArray(role.effectiveWriteScopes)||!role.effectiveWriteScopes.some(scope=>typeof scope==='string'&&contains(resolve(start.cwd,scope),resolve(start.cwd,String(input.path||'.'))))))return {block:true,reason:'写入超出角色与父任务范围'};
        if(event.toolName==='bash'&&(!Array.isArray(role.effectiveWriteScopes)||!role.effectiveWriteScopes.includes('.')))return {block:true,reason:'窄角色写入范围不能开放 Bash'};
      }
      if(start.parentTools&&!['swarm_message','team_message','friend_expert'].includes(event.toolName)&&!start.parentTools.includes(event.toolName))return {block:true,reason:'工具超出父任务权限'};
      if(start.executionStyle==='team'&&(event.toolName==='swarm_shared'||event.toolName==='swarm_message'&&input.to!=='parent'))return {block:true,reason:'Team 成员只能与主 Agent 通信'};
      if (Array.isArray(expert?.toolScope) && !['swarm_message','team_message','swarm_shared','friend_expert'].includes(event.toolName) && !expert.toolScope.includes(event.toolName)) return {block:true,reason:'工具不在已冻结的专家范围'};
      if (/friend_swarm|friend_team|subagent|spawn_agent/i.test(event.toolName)) return {block:true,reason:'协作成员不能递归派生'};
      if (['read','write','edit','find','grep','ls'].includes(event.toolName)) {
        const target = resolve(start.cwd,String(input.path || input.cwd || '.'));
        if (!contains(start.cwd,target)) return {block:true,reason:'路径超出成员工作区'};
        if (['write','edit'].includes(event.toolName)) {
          if (start.mode !== 'write') return {block:true,reason:'只读成员不能修改文件'};
          if (!start.writeScopes.some(scope => contains(resolve(start.cwd,scope),target))) return {block:true,reason:'路径不在成员写入范围'};
        }
      }
      if (event.toolName === 'bash') {
        const command = String(input.command || '');
        if (start.mode === 'read') return {block:true,reason:'只读成员使用 read/grep/find/ls；Bash 可以产生未知写入，因此未开放'};
        if(start.parentTools&&!start.writeScopes.includes('.'))return {block:true,reason:'窄父任务写入范围不能开放 Bash'};
        // Shell commands are not statically sandboxable. Protect obvious escapes and destructive actions;
        // worktree + this guard are cooperation boundaries, never an OS security claim.
        if (/\bcd\s+(?:\/|\.\.)|\bgit\s+(?:-C\s+|worktree\b)|\b(?:write|edit)\s+\//.test(command)) return {block:true,reason:'命令试图切换到成员工作区外或改动隔离管理'};
        if (destructiveCommand(command) && !await confirm('确认 Swarm 成员的破坏性操作',command)) return {block:true,reason:'破坏性操作未获确认'};
      }
    });
    pi.on('before_agent_start',event => ({systemPrompt: `${event.systemPrompt}\n你是 Swarm 成员。只处理本次任务，不派生子 Agent。工作区：${start.cwd}。写入范围：${start.writeScopes.join(', ')}。完成后报告事实、检查结果与剩余风险。Shell 为高信任工具，禁止越出工作区。`}));
  };
}
