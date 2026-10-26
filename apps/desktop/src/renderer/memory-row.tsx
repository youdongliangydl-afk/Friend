import type { MouseEvent } from 'react';
import { asList, type JsonObject } from './types.js';
import { memoryKindLabel, memoryRecordStateView, memoryScopeLabel } from './memory-center-model.js';
import { memoryGist } from './memory-display.js';

export interface MemoryRowProps {
  record: JsonObject;
  selected?: boolean;
  pinned?: boolean;
  bulkMode?: boolean;
  checked?: boolean;
  busy?: boolean;
  onOpen(): void;
  onCheck?(checked: boolean): void;
  onPin?(): void;
  onToggle?(): void;
  onForget?(): void;
}

const recordTitle = (record: JsonObject) => String(record.title || '未命名记录');

/**
 * Compact one-line record row. It shows identity and one gist only; provenance,
 * conditions, versions and destructive actions live in the detail drawer.
 */
export function MemoryRow({ record, selected = false, pinned = false, bulkMode = false, checked = false, busy = false, onOpen, onCheck, onPin, onToggle, onForget }: MemoryRowProps) {
  const state = memoryRecordStateView(record);
  const conflict = asList(record.conflictIds).length > 0;
  const exception = conflict ? '冲突' : state.status === 'candidate' ? '候选' : state.status === 'invalidated' ? '失效' : state.status === 'inactive' ? (record.enabled === false ? '停用' : '未启用') : state.tone === 'inactive' ? '未启用' : '';
  const tone = conflict ? 'is-warning' : `is-${state.tone}`;
  const title = recordTitle(record);
  const gist = String(record.summary || '').trim() || memoryGist(record.content, 80);
  const scoped = memoryScopeLabel(record.scope);
  const kind = memoryKindLabel(record.kindV2 || record.kind);

  const closeMenu = (event: MouseEvent<HTMLElement>) => {
    const details = event.currentTarget.closest('details');
    if (details) details.open = false;
  };
  const run = (event: MouseEvent<HTMLElement>, action?: () => void) => {
    closeMenu(event);
    action?.();
  };

  return <article className={`memory-row ${selected ? 'is-selected' : ''}`} data-record-id={String(record.id || '')}>
    {bulkMode && <label className="memory-row-check" title="选择此记录">
      <input type="checkbox" checked={checked} disabled={busy} aria-label={`选择记录 ${title}`} onChange={event => onCheck?.(event.target.checked)} />
    </label>}
    <button type="button" className="memory-row-open" aria-label={`打开记忆：${title}${exception ? `，${exception}` : '，生效'}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <span className={`memory-row-dot ${tone}`} aria-hidden="true" />
      <span className="memory-row-title" title={title}>{title}</span>
      <span className="memory-row-gist" title={gist || undefined}>{gist || '正文未记录'}</span>
      <span className="memory-row-chips">
        <span className="memory-chip">{kind}</span>
        <span className="memory-chip is-scope">{scoped}</span>
      </span>
      {exception && <span className={`memory-row-flag ${tone}`}>{exception}</span>}
      {pinned && <span className="memory-row-pin" title="已置顶">置顶</span>}
    </button>
    {(onPin || onToggle || onForget) && <details className="memory-row-menu">
      <summary aria-label={`更多操作：${title}`} aria-haspopup="menu" aria-disabled={busy || undefined}>⋯</summary>
      <div className="memory-row-menu-list" role="menu">
        <button type="button" role="menuitem" disabled={busy} onClick={event => run(event, onOpen)}>详情</button>
        {onPin && <button type="button" role="menuitem" disabled={busy} onClick={event => run(event, onPin)}>{pinned ? '取消置顶' : '置顶'}</button>}
        {onToggle && <button type="button" role="menuitem" disabled={busy} onClick={event => run(event, onToggle)}>{record.enabled === false ? '启用' : '停用'}</button>}
        {onForget && <button type="button" role="menuitem" className="danger-text" disabled={busy} onClick={event => run(event, onForget)}>遗忘</button>}
      </div>
    </details>}
  </article>;
}
