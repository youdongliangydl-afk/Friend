import type { Message, JsonObject } from './types.js';
export interface ToolRun { id: string; name: string; status: string; input: unknown; output?: unknown; error?: boolean;durationMs?:number;timestamp?:number }
export function updateToolRun(tools: ToolRun[], event: JsonObject): ToolRun[] {
  if (typeof event.toolCallId !== 'string') return tools;
  const previous = tools.find(tool => tool.id === event.toolCallId);
  if (event.type === 'tool_execution_update' && previous && previous.status !== 'running') return tools;
  const next: ToolRun = { ...previous, id: event.toolCallId, name: typeof event.toolName === 'string' ? event.toolName : previous?.name || '工具',
    input: event.args ?? previous?.input, output: event.result ?? event.partialResult ?? previous?.output,
    status: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : 'running', error: event.isError === true };
  return previous ? tools.map(tool => tool.id === next.id ? next : tool) : [...tools, next];
}
export type TimelinePart = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } |
  { kind: 'image'; data: string; mimeType: string } |
  { kind: 'tool'; tool: ToolRun };
export interface TimelineMessage { id: string; role: string; source: Message; parts: TimelinePart[]; live?: boolean }
export function projectTimeline(messages: Message[], live: Message | null, tools: ToolRun[], running: boolean, includeEmpty=false): TimelineMessage[] {
  const results = new Map<string, Message>(), overlays = new Map(tools.map(tool => [tool.id, tool]));
  for (const message of messages) if (message.role === 'toolResult' && message.toolCallId) results.set(message.toolCallId, message);
  const claimed = new Set<string>();
  const all = [...messages];
  if (live && !all.some(message => message.id === live.id)) all.push(live);
  const timeline: TimelineMessage[] = [];
  const nativeCalls=new Set(all.flatMap(message=>(message.parts||[]).filter(part=>part.type==='toolCall').map(part=>String(part.id))));
  const toolFor = (id: string, name: string, input: unknown): ToolRun => {
    const result = results.get(id), overlay = overlays.get(id);
    return { id, name: name || result?.toolName || overlay?.name || '工具', input,
      status: result ? result.isError ? 'failed' : 'completed' : overlay?.status === 'running' && !running ? 'interrupted' : overlay?.status || (running ? 'running' : 'interrupted'),
      output: result ? result.parts?.length ? result.parts : result.text : overlay?.output, durationMs:result?.durationMs,timestamp:result?.timestamp,error: result ? result.isError : overlay?.error };
  };
  for (let i = 0; i < all.length; i++) {
    const message = all[i], parts: TimelinePart[] = [];
    if (message.role === 'toolResult') {
      if (!message.toolCallId || claimed.has(message.toolCallId)) continue;
      // Native result can precede a snapshot containing the assistant call.
      const hasCall = nativeCalls.has(message.toolCallId);
      if (hasCall) continue;
      claimed.add(message.toolCallId);
      parts.push({ kind: 'tool', tool: toolFor(message.toolCallId, message.toolName || '', {}) });
    } else if (message.role === 'user') {
      parts.push({ kind: 'text', text: message.userText ?? message.text });
      for (const part of message.parts || []) if (part.type === 'image') parts.push({ kind: 'image', data: String(part.data), mimeType: String(part.mimeType) });
    } else {
      for (const part of message.parts || []) {
        if (part.type === 'text') parts.push({ kind: 'text', text: String(part.text || '') });
        if (part.type === 'thinking') parts.push({ kind: 'thinking', text: String(part.thinking || '') });
        if (part.type === 'toolCall') {
          const id = String(part.id);
          if (!claimed.has(id)) { claimed.add(id); parts.push({ kind: 'tool', tool: toolFor(id, String(part.name || ''), part.arguments) }); }
        }
      }
      if (!message.parts?.length && message.text) parts.push({ kind: 'text', text: message.text });
    }
    if (parts.length||includeEmpty) timeline.push({ id: message.id || 'message-' + i, role: message.role, source: message, parts, live: message === live });
  }
  // Events preceding the streaming toolCall are transient, attached to that live
  // assistant. They disappear as soon as native history supplies the same call.
  const unmatched = tools.filter(tool => !claimed.has(tool.id) && !results.has(tool.id));
  if (unmatched.length && running) {
    let last = timeline.at(-1);
    if (!last || last.role !== 'assistant') { last = { id: 'live-tools', role: 'assistant', source: { role: 'assistant', text: '' }, parts: [], live: true }; timeline.push(last); }
    for (const tool of unmatched) last.parts.push({ kind: 'tool', tool });
  }
  return timeline;
}
export function piLiveMessage(raw: JsonObject, id: string): Message {
  const parts = Array.isArray(raw.content) ? raw.content as JsonObject[] : [{ type: 'text', text: String(raw.content || '') }];
  return { id, role: String(raw.role), text: parts.filter(p => p.type === 'text').map(p => String(p.text || '')).join('\n'), parts, timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : undefined,provider:typeof raw.provider==='string'?raw.provider:undefined,model:typeof raw.model==='string'?raw.model:undefined,usage:raw.usage as JsonObject|undefined,stopReason:typeof raw.stopReason==='string'?raw.stopReason:undefined,durationMs:typeof raw.durationMs==='number'?raw.durationMs:undefined };
}
