import { useMemo, useState } from 'react';
import { Empty, Markdown } from './ui.js';
import { MemoryFeedbackButtons } from './memory-feedback.js';
import { MemoryReceiptsBody } from './MemoryReceipts.js';
import { memoryInjectionView, type MemoryInjectionEntry } from './memory-receipts.js';
import { memoryGist, memoryRelativeTime } from './memory-display.js';

/**
 * Workbench "记忆" tab: the current turn's recall list.
 *
 * It is a context view, not a memory browser. Each entry is one line; the body
 * opens on demand, and the full stage-by-stage receipts stay in a disclosure.
 */
export interface MemoryRunPanelProps {
  sessionId: string;
  goal?: string;
  receipts: unknown[];
  runId?: string;
  onSettings(page?: 'general' | 'memory'): void;
  report(message: string, error?: boolean): void;
}

const GROUP_LABELS: Record<string, string> = { injected: '已注入', catalog: '目录', unused: '未用', unknown: '未记录' };

function RunRow({ entry, sessionId, goal, report }: { entry: MemoryInjectionEntry; sessionId: string; goal?: string; report(message: string, error?: boolean): void }) {
  const [open, setOpen] = useState(false);
  const title = entry.title || entry.id;
  return <article className="memory-run-row">
    <button type="button" className="memory-run-open" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className={`memory-run-dot is-${entry.group}`} aria-hidden="true" />
      <span className="memory-run-title" title={title}>{title}</span>
      <span className="memory-run-gist">{entry.content ? memoryGist(entry.content, 60) : entry.reason || '正文未读'}</span>
      <span className={`memory-run-tag is-${entry.group}`}>{GROUP_LABELS[entry.group] || entry.group}</span>
      <span className="memory-run-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
    </button>
    {open && <div className="memory-run-body">
      {entry.content ? <Markdown text={entry.content} /> : <p className="hint">{entry.reason || '仅目录可见，正文未读。'}</p>}
      {entry.conditions.length > 0 && <p className="hint">适用条件：{entry.conditions.join('；')}</p>}
      {entry.sources.length > 0 && <p className="hint">来源 {entry.sources.length} 条</p>}
      {entry.hash && <p className="hint">内容摘要 <code title={entry.hash}>{entry.hash.slice(0, 12)}{entry.hash.length > 12 ? '…' : ''}</code></p>}
      {entry.group === 'injected' && entry.revision !== undefined && <MemoryFeedbackButtons sessionId={sessionId} id={entry.id} revision={entry.revision} goal={goal} report={report} />}
    </div>}
  </article>;
}

export function MemoryRunPanel({ sessionId, goal, receipts, runId, onSettings, report }: MemoryRunPanelProps) {
  const view = useMemo(() => memoryInjectionView(receipts, runId), [receipts, runId]);
  const turn = view.turns.find(item => item.current) || view.turns[0];
  if (!turn) return <div className="panel-content memory-run">
    <Empty title="尚无记忆注入回执">{view.reason}</Empty>
    <button type="button" onClick={() => onSettings('memory')}>记忆设置</button>
  </div>;
  const rows = [...turn.injected, ...turn.catalog, ...turn.unused, ...turn.unknown];
  return <div className="panel-content memory-run">
    <header className="memory-run-head">
      <div>
        <h3>本轮记忆</h3>
        <small>{turn.current ? '当前轮次' : '最近一轮'} · {memoryRelativeTime(turn.at)} · {turn.receipts} 条回执</small>
      </div>
      <div className="memory-run-counts">
        <span>注入 <b>{turn.injected.length}</b></span>
        <span>目录 <b>{turn.catalog.length}</b></span>
        <span>未用 <b>{turn.unused.length}</b></span>
        {turn.unknown.length > 0 && <span>未记录 <b>{turn.unknown.length}</b></span>}
      </div>
    </header>
    <p className="memory-run-budget">{turn.budget}</p>
    <div className="memory-run-list">
      {rows.length === 0 && <p className="hint">本轮没有可展示的记忆条目。</p>}
      {rows.map(entry => <RunRow key={entry.key} entry={entry} sessionId={sessionId} goal={goal} report={report} />)}
    </div>
    <footer className="memory-run-foot">
      <span>回执只证明记录被送入上下文或请求，不证明模型采用。</span>
      <div className="button-row"><button type="button" onClick={() => onSettings('memory')}>记忆设置</button></div>
      <details>
        <summary>完整回执（阶段链、来源与摘要）</summary>
        <MemoryReceiptsBody receipts={receipts} runId={runId} />
      </details>
    </footer>
  </div>;
}
