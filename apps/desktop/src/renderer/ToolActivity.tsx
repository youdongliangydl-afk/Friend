import { useRef, type SyntheticEvent } from 'react';
import { Badge, JsonView } from './ui.js';
import { activitySummary, toolDetail, toolLabel, type ToolActivity as Activity } from './tool-activity.js';

function ToolOutput({ value }: { value: unknown }) {
  const parts = Array.isArray(value) ? value : value && typeof value === 'object' && 'content' in value ? value.content : undefined;
  if (!Array.isArray(parts)) return <JsonView value={value}/>;
  return <>{parts.map((part, index) => part?.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) && typeof part.data === 'string'
    ? <img className="message-image tool-result-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="工具返回的图片" loading="lazy"/>
    : <JsonView key={index} value={part?.type === 'text' ? part.text : part}/>)}</>;
}

export function ToolActivity({ group, thinking, expanded, onToggle, readingKey }: {
  group: Activity; thinking: boolean; expanded: Record<string, boolean>; onToggle(id: string, open: boolean): void; readingKey?: string;
}) {
  const summary = activitySummary(group, thinking), body = useRef<HTMLDivElement>(null), restored = useRef(false);
  const scrollKey = readingKey ? 'friend-pi.tool-scroll:' + JSON.stringify([readingKey, group.id]) : undefined;
  const toggle = (id: string) => (event: SyntheticEvent<HTMLDetailsElement>) => {
    event.stopPropagation();
    const open = event.currentTarget.open;
    onToggle(id, open);
    if (id === group.id) {
      restored.current = false;
      if (open && body.current) {
        const saved = scrollKey ? sessionStorage.getItem(scrollKey) : null;
        const top = saved === null ? (summary.status === 'running' ? body.current.scrollHeight : 0) : Number(saved);
        body.current.scrollTop = Number.isFinite(top) && top >= 0 ? top : 0;
        restored.current = true;
      }
    }
  };
  return <details className="tool-activity" data-tool-group-id={group.id} open={expanded[group.id] === true} onToggle={toggle(group.id)}>
    <summary><span className="disclosure-chevron" aria-hidden="true"/><span className={'tool-indicator ' + summary.status}/><span className="activity-title">{summary.title}</span>
      {summary.count > 0 && <span className="activity-count">{summary.count} 项工具</span>}
      {summary.status !== 'completed' && <Badge value={summary.status}/>}</summary>
    <div className="tool-activity-body" ref={body} tabIndex={0} role="region" aria-label="工具调用与思考详情" onScroll={event=>{if(scrollKey&&restored.current)sessionStorage.setItem(scrollKey,String(event.currentTarget.scrollTop));}}>
      {group.items.map(item => item.kind === 'thinking'
        ? <details key={item.key} className="thinking-block activity-thinking" data-thought-part={item.key} open={expanded[item.key] === true} onToggle={toggle(item.key)}>
          <summary><span className="disclosure-chevron" aria-hidden="true"/>思考过程</summary>{expanded[item.key] && <pre>{item.text}</pre>}</details>
        : <details className="history-tool timeline-tool" data-tool-call-id={item.tool.id} key={item.key} open={expanded[item.key] === true} onToggle={toggle(item.key)}>
          <summary title={item.tool.name}><span className="disclosure-chevron" aria-hidden="true"/><span className={'tool-indicator ' + item.tool.status}/><strong>{toolLabel(item.tool)}</strong>
            <span className="tool-detail">{toolDetail(item.tool)}</span><Badge value={item.tool.status}/></summary>
          {expanded[item.key] && <div className="tool-call-body"><div className="tool-section-label">输入 · {item.tool.name}</div><JsonView value={item.tool.input}/>
            {item.tool.output !== undefined && <><div className="tool-section-label">结果</div><ToolOutput value={item.tool.output}/></>}</div>}
        </details>)}
    </div>
  </details>;
}
