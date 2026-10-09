import { projectTimeline, type ToolRun } from './timeline.js';
import type { Message } from './types.js';
import type { TraceSystem } from '../message-projection.js';
export interface TraceRow {
  id: string; kind: 'input' | 'context' | 'model' | 'tool'; round: number;
  label: string; text: string; input?: unknown; output?: unknown; status?: string;
  timestamp?: number; durationMs?: number; metadata?: unknown; live?: boolean;
}
// Image bytes stay in the native history, outside diagnostic text and search.
function diagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(diagnostic);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.type === 'image') return { type: 'image', mimeType: object.mimeType, note: '图片附件' };
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, diagnostic(item)]));
  }
  return value;
}
export function projectTrajectory(messages: Message[], live: Message | null, tools: ToolRun[], running: boolean, systems: TraceSystem[] = []): TraceRow[] {
  const rows: TraceRow[] = []; let round = 0;const claimed=new Set<string>();
  const results=new Map(messages.filter(message=>message.role==='toolResult').map(message=>[message.toolCallId,message]));
  const systemGroups=new Map<string|undefined,TraceSystem[]>();for(const system of systems){const group=systemGroups.get(system.afterMessageId)||[];group.push(system);systemGroups.set(system.afterMessageId,group);}
  const addSystems = (id?: string) => { for (const system of (systemGroups.get(id)||[]).filter(item => !claimed.has(item.id))) {claimed.add(system.id);rows.push({ id: system.id, kind: 'context', round, label: system.label, text: system.text, timestamp: system.timestamp, metadata: system.truncated ? { note: '系统上下文超过 64 KiB，已截取' } : undefined });} };
  addSystems();
  for (const message of projectTimeline(messages, live, tools, running,true)) {
    const source = message.source;
    if (message.role === 'user') round++;
    if (message.role === 'user' || message.role === 'automatic') {
      rows.push({ id: message.id, kind: 'input', round, label: message.role === 'automatic' ? '自动接续' : '用户', text: source.userText ?? source.text, timestamp: source.timestamp });
      if (source.userText !== undefined && source.text.slice(source.userText.length).trim()) rows.push({ id: message.id + '-context', kind: 'context', round, label: '附件与注入上下文', text: source.text.slice(source.userText.length), timestamp: source.timestamp });
    } else if (message.role !== 'toolResult') {
      const text = message.parts.flatMap(part => part.kind === 'text' ? [part.text] : part.kind === 'thinking' ? ['思考：\n' + part.text] : []).join('\n');
      rows.push({ id: message.id, kind: message.role === 'assistant' ? 'model' : 'context', round, label: message.role === 'assistant' ? source.model || '助手' : '上下文', text, timestamp: source.timestamp, durationMs: source.durationMs, live: message.live,
        status: message.live && running ? 'running' : source.stopReason === 'error' ? 'failed' : source.stopReason === 'aborted' ? 'interrupted' : 'completed',
        metadata: { provider: source.provider, model: source.model, usage: source.usage, stopReason: source.stopReason, error: source.errorMessage } });
    }
    if(message.role!=='toolResult')addSystems(message.id);
    for (const part of message.parts) if (part.kind === 'tool') {
      const tool = part.tool;
      rows.push({ id: 'tool-' + tool.id, kind: 'tool', round, label: tool.name, text: '', input: diagnostic(tool.input), output: diagnostic(tool.output), status: tool.status,
        durationMs: tool.durationMs, timestamp: tool.timestamp === undefined ? undefined : tool.timestamp - (tool.durationMs || 0) });
      const result=results.get(tool.id);if(result?.id)addSystems(result.id);
    }
  }
  // A system/context record may follow a result hidden by the conversation projection.
  for (const system of systems) if (!claimed.has(system.id)) {
    const position = messages.findIndex(message => message.id === system.afterMessageId);
    const preceding = messages.slice(0, position + 1).filter(message => message.role === 'user').length;
    rows.push({ id: system.id, kind: 'context', round: preceding, label: system.label, text: system.text, timestamp: system.timestamp });
  }
  return rows;
}
export function searchTrajectory(rows: TraceRow[], query: string) {
  const term = query.trim().toLocaleLowerCase();
  return term ? rows.filter(row => [row.label, row.text, row.status, JSON.stringify(row.input), JSON.stringify(row.output), JSON.stringify(row.metadata)].join('\n').toLocaleLowerCase().includes(term)) : rows;
}
export function traceDuration(value?: number) { return value === undefined || !Number.isFinite(value) ? '耗时未记录' : value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' s'; }
