import { Badge, JsonView, Markdown } from './ui.js';
import { messageAnchor } from './TurnIndex.js';
import { projectTimeline, type ToolRun } from './timeline.js';
import type { Message } from './types.js';
export function Conversation({ messages, live, tools, running }: { messages: Message[]; live: Message | null; tools: ToolRun[]; running: boolean }) {
  return <div className="messages">{projectTimeline(messages, live, tools, running).map((message, i) =>
    <article className={'chat-message ' + (message.role === 'user' ? 'user' : 'assistant') + (message.live ? ' live' : '')}
      data-message-id={messageAnchor(message.source, i)} key={message.id}>
      <div className="message-role">{message.source.senderLabel|| (message.role === 'user' ? '你' : message.role==='automatic'?'自动接续':'Friend')}{message.live && running && <span className="pulse-dot"/>}</div>
      {message.parts.map((part, index) => part.kind === 'text' ? <Markdown key={index} text={part.text}/> :
        part.kind === 'thinking' ? <details key={index} data-thought-part={index} className="thinking-block"><summary>思考过程</summary><pre>{part.text}</pre></details> :
        part.kind === 'image' ? <img className="message-image" key={index} src={'data:' + part.mimeType + ';base64,' + part.data} alt="原始消息附件"/> :
        <details className="history-tool timeline-tool" data-tool-call-id={part.tool.id} key={part.tool.id}>
          <summary><span className={'tool-indicator ' + part.tool.status}/><strong>{part.tool.name}</strong><Badge value={part.tool.status}/></summary>
          <JsonView value={part.tool.input}/>{part.tool.output !== undefined && <JsonView value={part.tool.output}/>}
        </details>)}
    </article>)}{running && !live && <div className="working-indicator"><span/><span/><span/>正在处理任务</div>}</div>;
}
