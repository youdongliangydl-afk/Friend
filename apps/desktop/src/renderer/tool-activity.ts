import type { TimelineMessage, TimelinePart, ToolRun } from './timeline.js';

export type ActivityPart = Extract<TimelinePart, { kind: 'tool' | 'thinking' }> & { key: string };
export interface ToolActivity { kind: 'activity'; id: string; items: ActivityPart[] }
export type ConversationMessage = Omit<TimelineMessage, 'parts'> & { parts: (Exclude<TimelinePart, { kind: 'tool' | 'thinking' }> | ToolActivity)[] };

/** Adapted from DeepSeek Harness process-groups: display only; Pi history stays authoritative. */
export function groupToolActivity(timeline: TimelineMessage[]): ConversationMessage[] {
  const rows: ConversationMessage[] = [];
  const occurrences = new Map<number, number>();
  for (const message of timeline) {
    const timestamp = message.source.timestamp;
    const occurrence = timestamp === undefined ? 0 : occurrences.get(timestamp) || 0;
    if (timestamp !== undefined) occurrences.set(timestamp, occurrence + 1);
    const identity = timestamp === undefined ? message.id : `${timestamp}:${occurrence}`;
    const previous = rows.at(-1);
    const row = message.role === 'assistant' && previous?.role === 'assistant' && previous.source.senderLabel === message.source.senderLabel
      ? previous : { ...message, parts: [] } as ConversationMessage;
    if (row !== previous) rows.push(row);
    row.live ||= message.live;
    message.parts.forEach((part, index) => {
      if (part.kind === 'text' && !part.text.trim()) return;
      if (part.kind !== 'tool' && part.kind !== 'thinking') { row.parts.push(part); return; }
      // Native timestamps survive the streaming message ID handover.
      const key = part.kind === 'tool' ? 'tool:' + part.tool.id : `thinking:${identity}:${index}`;
      const last = row.parts.at(-1);
      const group: ToolActivity = last?.kind === 'activity' ? last : { kind: 'activity', id: 'group:' + key, items: [] };
      if (group !== last) row.parts.push(group);
      group.items.push({ ...part, key });
    });
  }
  return rows;
}

const labels = {
  read: ['读取文件', '已读取文件'], image: ['读取图片', '已读取图片'], search: ['搜索文件', '已搜索文件'],
  edit: ['修改文件', '修改了文件'], commands: ['运行命令', '执行了命令'], web: ['浏览网页', '已浏览网页'],
  agents: ['调用队友', '已调用队友'], strategy: ['校验协作策略', '已校验协作策略'], plan: ['更新计划', '已更新计划'], tools: ['调用工具', '调用了工具'],
} as const;
export function toolCategory(tool: ToolRun): keyof typeof labels {
  if (tool.name === 'read_image' || tool.name === 'read' && /\.(png|jpe?g|gif|webp)$/i.test(toolDetail(tool))) return 'image';
  if (tool.name === 'read') return 'read';
  if (['ls', 'find', 'grep', 'glob'].includes(tool.name) || tool.name.endsWith('_inspect')) return 'search';
  if (['write', 'edit', 'apply_patch'].includes(tool.name)) return 'edit';
  if (['bash', 'pwsh', 'exec_command', 'write_stdin', 'friend_terminal'].includes(tool.name) || tool.name.startsWith('terminal_')) return 'commands';
  if (['web_search', 'web_fetch'].includes(tool.name)) return 'web';
  if (tool.name === 'friend_swarm') {
    const action = (tool.input as {action?:unknown} | undefined)?.action;
    return action === 'plan.validate' ? 'strategy' : ['start', 'resume', 'member.send'].includes(String(action)) ? 'agents' : 'tools';
  }
  if (tool.name.startsWith('subagent')) return 'agents';
  if (['todo_write', 'friend_todo', 'create_goal', 'update_goal', 'get_goal', 'friend_goal'].includes(tool.name)) return 'plan';
  return 'tools';
}
export function toolLabel(tool: ToolRun): string { return toolCategory(tool) === 'tools' ? tool.name : labels[toolCategory(tool)][0]; }
export function toolDetail(tool: ToolRun): string {
  if (!tool.input || typeof tool.input !== 'object') return '';
  const input = tool.input as Record<string, unknown>;
  for (const key of ['title', 'description', 'command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'action']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  return '';
}
export function activitySummary(group: ToolActivity, thinking = false): { title: string; status: string; count: number } {
  const tools = group.items.flatMap(item => item.kind === 'tool' ? [item.tool] : []);
  const current = tools.findLast(tool => tool.status === 'running');
  const status = current ? 'running' : tools.some(tool => tool.status === 'failed' || tool.error) ? 'failed'
    : tools.some(tool => tool.status === 'interrupted') ? 'interrupted' : thinking ? 'running' : 'completed';
  if (current) return { title: toolLabel(current) + (toolDetail(current) ? ' · ' + toolDetail(current) : ''), status, count: tools.length };
  if (thinking) return { title: '正在分析', status, count: tools.length };
  // Rank categories by call count, retaining first appearance for ties, as upstream does.
  const counts = new Map<keyof typeof labels, number>();
  for (const tool of tools) { const category = toolCategory(tool); counts.set(category, (counts.get(category) || 0) + 1); }
  const titles = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([category]) => labels[category][1]);
  const title = titles.length === 2 ? titles[0] + '并' + titles[1] : titles.join('，');
  return { title: (title || '已完成分析') + (counts.size > 3 ? '等' : ''), status, count: tools.length };
}
