import { useState } from 'react';
import { Markdown } from './ui.js';
import { messageAnchor } from './TurnIndex.js';
import { projectTimeline, type ToolRun } from './timeline.js';
import { groupToolActivity } from './tool-activity.js';
import { ToolActivity } from './ToolActivity.js';
import type { Message } from './types.js';
export function Conversation({ messages, live, tools, running, initialExpanded = {} }: { messages: Message[]; live: Message | null; tools: ToolRun[]; running: boolean; initialExpanded?: Record<string, boolean> }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialExpanded);
  const toggle = (id: string, open: boolean) => setExpanded(previous => previous[id] === open ? previous : { ...previous, [id]: open });
  return <div className="messages">{groupToolActivity(projectTimeline(messages, live, tools, running)).map((message, i) =>
    <article className={'chat-message ' + (message.role === 'user' ? 'user' : 'assistant') + (message.live ? ' live' : '')}
      data-message-id={messageAnchor(message.source, i)} key={message.id}>
      <div className="message-role">{message.source.senderLabel|| (message.role === 'user' ? '你' : message.role==='automatic'?'自动接续':'Friend')}{message.live && running && <span className="pulse-dot"/>}</div>
      {message.parts.map((part, index) => part.kind === 'text' ? <Markdown key={index} text={part.text}/> :
        part.kind === 'image' ? <img className="message-image" key={index} src={'data:' + part.mimeType + ';base64,' + part.data} alt="原始消息附件"/> :
        <ToolActivity key={part.id} group={part} thinking={!!message.live && running && index === message.parts.length - 1} expanded={expanded} onToggle={toggle}/>)}
    </article>)}{running && !live && <div className="working-indicator"><span/><span/><span/>正在处理任务</div>}</div>;
}
