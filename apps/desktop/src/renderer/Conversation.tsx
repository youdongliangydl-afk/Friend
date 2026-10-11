import {BatchQuestionHistory,questionResult} from './BatchQuestionCard.js';
import {AttachmentDelivery} from './AttachmentDelivery.js';
import type {JsonObject} from './types.js';
import {Deliverables} from './Deliverables.js';
import { useState } from 'react';
import { Markdown } from './ui.js';
import { messageAnchor } from './TurnIndex.js';
import { projectTimeline, type ToolRun } from './timeline.js';
import { groupToolActivity } from './tool-activity.js';
import { ToolActivity } from './ToolActivity.js';
import type { Message } from './types.js';
import type { RunChangesSummary } from '../run-changes.js';
import type { ChangeDiffCache } from './change-review.js';
import { ChangedFiles } from './ChangedFiles.js';
export function Conversation({ messages, live, tools, running, initialExpanded, readingKey, changes=[], sessionId, changeCache, workspacePath,receipts=[] }: {
  messages: Message[]; live: Message | null; tools: ToolRun[]; running: boolean; initialExpanded?: Record<string, boolean>; readingKey?: string;
  changes?: RunChangesSummary[]; sessionId?: string; changeCache?: ChangeDiffCache; workspacePath?: string;receipts?:JsonObject[];
}) {
  const expansionKey = readingKey ? 'friend-pi.tool-expanded:' + readingKey : undefined;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    if (initialExpanded) return { ...initialExpanded };
    try { return expansionKey ? { ...JSON.parse(sessionStorage.getItem(expansionKey) || '{}') } : {}; } catch { return {}; }
  });
  const toggle = (id: string, open: boolean) => setExpanded(previous => {
    if (previous[id] === open) return previous;
    const next = { ...previous, [id]: open };
    if (expansionKey && !initialExpanded) sessionStorage.setItem(expansionKey, JSON.stringify(next));
    return next;
  });
  const timeline = groupToolActivity(projectTimeline(messages.filter(message => !message.background), live, tools, running));
  const anchors = new Map<string, string>();
  for (const message of timeline) if (message.source.runId) anchors.set(message.source.runId, message.id);
  return <div className="messages">{timeline.map((message, i) =>
    <article className={'chat-message ' + (message.role === 'user' ? 'user' : 'assistant') + (message.live ? ' live' : '')}
      data-message-id={messageAnchor(message.source, i)} key={message.id}>
      <div className="message-role">{message.source.senderLabel || (message.role === 'user' ? '你' : message.role === 'automatic' ? '自动接续' : 'Friend')}{message.live && running && <span className="pulse-dot"/>}</div>
      {message.parts.map((part, index) => part.kind === 'text' ? <Markdown key={index} text={part.text}/> :
        part.kind === 'image' ? <img className="message-image" key={index} src={'data:' + part.mimeType + ';base64,' + part.data} alt="原始消息附件"/> :
        <div key={part.id}><ToolActivity group={part} thinking={!!message.live && running && index === message.parts.length - 1} expanded={expanded} onToggle={toggle} readingKey={readingKey}/>{part.items.flatMap(item=>{if(item.kind!=='tool'||item.tool.name!=='friend_questions')return [];const result=questionResult(item.tool.output);return result?[<BatchQuestionHistory key={item.key} result={result}/>]:[];})}</div>)}
      {changes.filter(summary => anchors.get(summary.runId) === message.id).map(summary => <div key={summary.runId}><ChangedFiles summary={summary} sessionId={sessionId} cache={changeCache} workspacePath={workspacePath}/><Deliverables summary={summary} sessionId={sessionId} workspacePath={workspacePath}/></div>)}
    </article>)}{changes.filter(summary => !anchors.has(summary.runId)).map(summary => <div key={summary.runId}><ChangedFiles summary={summary} sessionId={sessionId} cache={changeCache} workspacePath={workspacePath}/><Deliverables summary={summary} sessionId={sessionId} workspacePath={workspacePath}/></div>)}
    <AttachmentDelivery receipts={receipts}/>{running && !live && <div className="working-indicator"><span/><span/><span/>正在处理任务</div>}
  </div>;
}
