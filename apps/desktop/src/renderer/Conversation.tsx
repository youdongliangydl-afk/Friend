import { Badge, JsonView, Markdown } from './ui.js';
import { messageAnchor } from './TurnIndex.js';
import { projectTimeline, type ToolRun } from './timeline.js';
import type { Message } from './types.js';
import type {RunChangesSummary} from '../run-changes.js';
import {ChangedFiles} from './ChangedFiles.js';
export function Conversation({ messages, live, tools, running, changes=[] }: { messages: Message[]; live: Message | null; tools: ToolRun[]; running: boolean;changes?:RunChangesSummary[] }) {
  const timeline=projectTimeline(messages, live, tools, running);
  const anchors=new Map<string,string>();for(const message of timeline)if(message.source.runId)anchors.set(message.source.runId,message.id);
  return <div className="messages">{timeline.map((message, i) =>
    <article className={'chat-message ' + (message.role === 'user' ? 'user' : 'assistant') + (message.live ? ' live' : '')}
      data-message-id={messageAnchor(message.source, i)} key={message.id}>
      <div className="message-role">{message.role === 'user' ? '你' : message.role==='automatic'?'自动接续':'Friend'}{message.live && running && <span className="pulse-dot"/>}</div>
      {message.parts.map((part, index) => part.kind === 'text' ? <Markdown key={index} text={part.text}/> :
        part.kind === 'thinking' ? <details key={index} className="thinking-block"><summary>思考过程</summary><pre>{part.text}</pre></details> :
        part.kind === 'image' ? <img className="message-image" key={index} src={'data:' + part.mimeType + ';base64,' + part.data} alt="原始消息附件"/> :
        <details className="history-tool timeline-tool" data-tool-call-id={part.tool.id} key={part.tool.id}>
          <summary><span className={'tool-indicator ' + part.tool.status}/><strong>{part.tool.name}</strong><Badge value={part.tool.status}/></summary>
          <JsonView value={part.tool.input}/>{part.tool.output !== undefined && <JsonView value={part.tool.output}/>}
        </details>)}
      {changes.filter(summary=>anchors.get(summary.runId)===message.id).map(summary=><ChangedFiles key={summary.runId} summary={summary}/>)}
    </article>)}{changes.filter(summary=>!anchors.has(summary.runId)).map(summary=><ChangedFiles key={summary.runId} summary={summary}/>)}{running && !live && <div className="working-indicator"><span/><span/><span/>正在处理任务</div>}</div>;
}
