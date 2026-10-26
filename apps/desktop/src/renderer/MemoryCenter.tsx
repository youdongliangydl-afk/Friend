/**
 * Memory Center — full-screen nine-tab surface (P3, spec §3).
 *
 * Data channel: `window.friendPi.request('plugin.call',{sessionId,plugin:'memory',action,input})`.
 * sdk-worker forwards plugin calls to the Memory controller with origin:'user', so the write
 * actions below are user-origin writes. Every request shape is built by memory-center-model.ts
 * and covered by tests/memory-center.test.ts; this file is the presentation layer.
 *
 * Entry wiring (owned by Lead): render `<MemoryCenter sessionId goal report onClose/>` from a
 * "打开记忆中心" button in Settings → 记忆 (or any modal host). MemoryCenter renders itself as a
 * full-screen dialog portal, so no extra `<Modal>` wrapper is needed.
 */
import './memory-center.css';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { asList, asObject, errorText, type JsonObject } from './types.js';
import { Badge, Card, Empty, Field, JsonView, Markdown, Modal, TextDiff } from './ui.js';
import { MemoryFeedbackButtons, memoryFeedbackAvailable } from './memory-feedback.js';
import { MemoryRow } from './memory-row.js';
import { memoryDateText, memoryRelativeTime } from './memory-display.js';
import {
  AUTO_PUBLISH_MODES,
  CONFLICT_RESOLUTION_LABELS,
  CONFLICT_RESOLUTIONS,
  EMPTY_RECORD_FILTERS,
  MEMORY_CENTER_TABS,
  MEMORY_CENTER_TAB_IDS,
  MEMORY_KIND_IDS,
  PINNED_CHAR_LIMIT,
  RECORD_SCOPE_OPTIONS,
  RECORD_STATUS_OPTIONS,
  REVIEW_REASON_LABELS,
  memoryAuditView,
  memoryAutoPublishRevokeInput,
  memoryAutoPublishSettingsInput,
  memoryAutoPublishView,
  memoryBulkPinRequests,
  memoryBulkToggleRequests,
  memoryCandidateAcceptRequest,
  memoryCandidateEditRequest,
  memoryCandidateGroups,
  memoryCandidateRejectRequest,
  memoryCenterDataState,
  memoryCenterEmptyMessage,
  memoryCenterSnapshotView,
  memoryCenterTabBadge,
  memoryCenterTabNeighbor,
  memoryCenterErrorHint,
  memoryConflictImpactView,
  memoryConflictResolveAllowed,
  memoryConflictResolveInput,
  memoryConflictViews,
  memoryCountText,
  memoryDerivedRefs,
  memoryDetailRevisionDiff,
  memoryDetailSources,
  memoryDiagnosticsRequest,
  memoryExplainView,
  memoryExplainRequest,
  memoryExportInput,
  memoryGraphFromSnapshot,
  memoryGraphLayout,
  memoryGraphRequest,
  memoryGraphView,
  memoryImpactCommitInput,
  memoryImpactView,
  memoryImportInput,
  memoryKindLabel,
  memoryKindPolicyRows,
  memoryLearningControlRequest,
  memoryLearningJobViews,
  memoryMergeInput,
  memoryPinEligible,
  memoryPinRequest,
  memoryPinnedChars,
  memoryReadInput,
  memoryReadSourcesInput,
  memoryRecordPage,
  memoryRecordList,
  memoryRecordStateView,
  memoryRecordSubject,
  memoryRecordSummary,
  memoryReviewActions,
  memoryReviewBatchInputs,
  memoryReviewItems,
  memoryReviewListInput,
  memoryReviewResolveInput,
  memoryScopeLabel,
  memorySearchInput,
  memorySplitInput,
  memorySupersedeInput,
  memoryUsageView,
  memoryVersionsInput,
  type AuditView,
  type CandidateView,
  type ConflictView,
  type GraphView,
  type MemoryCenterSnapshotView,
  type MemoryCenterTabId,
  type MemoryImpactView,
  type MemoryRecordFilters,
  type MemoryTone,
  type ReviewItemView,
  type UsageView,
} from './memory-center-model.js';

export type { MemoryCenterTabId } from './memory-center-model.js';
export { MEMORY_CENTER_TABS, MEMORY_CENTER_TAB_IDS } from './memory-center-model.js';

export interface MemoryCenterProps {
  sessionId: string;
  goal?: string;
  report(message: string, error?: boolean): void;
  onClose(): void;
  initialTab?: MemoryCenterTabId;
  className?: string;
}

/** Settings entry button. Lead wires `<MemoryCenterButton onOpen={...}/>` next to the memory toggle. */
export function MemoryCenterButton({ onOpen, disabled = false, label = '打开记忆中心' }: { onOpen(): void; disabled?: boolean; label?: string }) {
  return <button type="button" className="memory-center-launcher" disabled={disabled} aria-haspopup="dialog" onClick={onOpen}>{label}</button>;
}

interface TabBase {
  sessionId: string;
  goal?: string;
  view: MemoryCenterSnapshotView;
  pending: string;
  request<T = unknown>(action: string, input?: JsonObject): Promise<T>;
  perform<T = unknown>(action: string, input?: JsonObject, success?: string): Promise<T>;
  refresh(): Promise<void>;
  report(message: string, error?: boolean): void;
  openRecord(id: string): void;
  openTab(tab: MemoryCenterTabId): void;
  focusId?: string;
}

const toneClass: Record<MemoryTone, string> = {
  active: 'is-active',
  candidate: 'is-candidate',
  inactive: 'is-inactive',
  invalidated: 'is-invalidated',
};

function StatusPill({ record }: { record: unknown }) {
  const state = memoryRecordStateView(record);
  return <span className={`memory-center-status ${toneClass[state.tone]}`}>{state.label}</span>;
}

function Notice({ message, onClose, error = false }: { message: string; onClose(): void; error?: boolean }) {
  if (!message) return null;
  return <div className={`memory-center-inline-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}><span>{message}</span><button type="button" aria-label="关闭提示" onClick={onClose}>×</button></div>;
}

function ImpactPreviewPanel({ preview }: { preview: MemoryImpactView }) {
  return <section className="memory-center-impact" aria-label="本次操作的只读影响预览">
    <strong>影响预览 · 当前 v{memoryCountText(preview.revision)}</strong>
    <p>{preview.conclusion}</p>
    <dl>
      <div><dt>涉及记忆</dt><dd>{preview.counts.affected} 条</dd></div>
      <div><dt>派生内容</dt><dd>{preview.counts.derived} 条</dd></div>
      <div><dt>会话原文</dt><dd>{preview.sourceValidity.valid} / {preview.counts.sources} 可用</dd></div>
      <div><dt>产物引用</dt><dd>{preview.counts.artifacts}</dd></div>
      <div><dt>能力依赖</dt><dd>{preview.counts.dependencies}</dd></div>
    </dl>
    {preview.sourceValidity.invalid > 0 && <p className="memory-center-warning" role="status">有来源不可用。请展开核对原因后确认。</p>}
    {preview.sourceValidity.unknown > 0 && <p className="memory-center-warning" role="status">部分来源有效性未确认，请展开核对。</p>}
    <details>
      <summary>查看涉及的版本与来源{preview.invalidSources.length ? `（${preview.invalidSources.length} 条不可用）` : ''}</summary>
      <ul>
        {preview.affected.map(item => <li key={`${item.id}:${item.revision}`}><code>{item.id}</code> · v{memoryCountText(item.revision)} · {item.statusLabel}</li>)}
        {preview.invalidSources.map((source, index) => <li key={`invalid:${index}`} className="memory-center-warning">来源不可用：{source}</li>)}
      </ul>
    </details>
    <small>此预览尚未修改任何记忆；内容、来源或策略变化后需要重新预览。{preview.evidenceBoundary}</small>
  </section>;
}

function BudgetBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return <div className="memory-center-budget" aria-label={`${label}：已用 ${used} / ${limit}`}>
    <div className="memory-center-budget-heading"><span>{label}</span><small>{used} / {limit}</small></div>
    <div className="memory-center-budget-track"><span style={{ width: `${percent}%` }} className={used > limit ? 'is-over' : ''} /></div>
  </div>;
}

function Pager({ page, onPage }: { page: ReturnType<typeof memoryRecordPage>; onPage(page: number): void }) {
  return <nav className="memory-center-pager" aria-label="记录分页">
    <button type="button" disabled={!page.hasPrevious} onClick={() => onPage(page.page - 1)}>上一页</button>
    <span>第 {page.page + 1} / {page.pageCount} 页 · 显示 {page.start}-{page.end}，共 {page.total} 条{page.omitted > 0 ? `（本页省略 ${page.omitted} 条）` : ''}</span>
    <button type="button" disabled={!page.hasNext} onClick={() => onPage(page.page + 1)}>下一页</button>
  </nav>;
}

/* ------------------------------------------------------------------------- */
/* Overview                                                                  */
/* ------------------------------------------------------------------------- */

function OverviewTab({ view, openTab }: TabBase) {
  const metrics = [
    { id: 'active', label: '生效记忆', count: view.counts.active, tab: 'records' as const, tone: 'is-active' },
    { id: 'candidate', label: '候选未采用', count: view.counts.candidate, tab: 'candidates' as const, tone: 'is-candidate' },
    { id: 'conflicts', label: '待裁决冲突', count: view.openConflicts.length, tab: 'conflicts' as const, tone: 'is-warning' },
    { id: 'reviews', label: '到期复审', count: view.reviewsDue, tab: 'reviews' as const, tone: 'is-warning' },
  ];
  const extraProblems = view.problems.filter(problem => !['candidates', 'conflicts', 'reviews'].includes(problem.id));
  return <div className="memory-center-overview">
    <div className="memory-center-metrics" role="list" aria-label="记忆关键计数">
      {metrics.map(metric => <button type="button" role="listitem" key={metric.id} className={`memory-center-metric ${metric.tone}`} onClick={() => openTab(metric.tab)}>
        <span>{metric.label}</span><strong>{metric.count}</strong>
      </button>)}
    </div>
    {extraProblems.length > 0 && <div className="memory-center-problems-line" role="status">
      <span>另需处理</span>
      {extraProblems.map(problem => <button type="button" key={problem.id} className="memory-center-problem" onClick={() => openTab(problem.tab)}>
        {problem.label} <b>{problem.count}</b>
      </button>)}
    </div>}
    <div className="memory-center-columns">
      <Card title="按类型">
        <table className="memory-center-table"><caption className="memory-center-visually-hidden">记忆类型计数</caption>
          <thead><tr><th scope="col">类型</th><th scope="col">生效</th><th scope="col">候选</th><th scope="col">合计</th></tr></thead>
          <tbody>{view.byKind.map(row => <tr key={row.kind}><th scope="row">{row.label}</th><td>{row.active}</td><td>{row.candidate}</td><td>{row.total}</td></tr>)}</tbody>
        </table>
      </Card>
      <div className="memory-center-stack">
        <Card title="按范围"><ul className="memory-center-count-list">{view.byScope.map(row => <li key={row.key}><span>{row.label}</span><strong>{row.total}</strong></li>)}</ul></Card>
        <Card title="按状态"><ul className="memory-center-count-list">{view.byStatus.map(row => <li key={row.key}><span>{row.label}</span><strong>{row.total}</strong></li>)}</ul></Card>
      </div>
    </div>
    <div className="memory-center-columns">
      <Card title="学习队列" actions={<Badge value={view.learning.paused ? 'paused' : view.learning.running ? 'running' : view.learning.enabled ? 'active' : 'inactive'} />}>
        <ul className="memory-center-count-list">
          <li><span>等待中</span><strong>{view.learning.queued}</strong></li>
          <li><span>失败</span><strong>{view.learning.failed}</strong></li>
        </ul>
        <p className="hint">累计模型调用 {memoryCountText(view.learning.calls)} / {memoryCountText(view.learning.maxCalls)} · Token {view.learning.usageUnknown ? '含未确认用量' : memoryCountText(view.learning.tokens)}</p>
        <button type="button" className="memory-center-link" onClick={() => openTab('learning')}>打开学习页</button>
      </Card>
      <Card title="预算">
        <ul className="memory-center-budget-list">{view.budget.map(row => <li key={row.id}>
          <span>{row.label}</span>
          <strong>{row.available ? `${memoryCountText(row.used)}${row.limit !== undefined ? ` / ${row.limit}` : ''} ${row.unit}` : '未提供'}</strong>
        </li>)}</ul>
        <p className="hint">置顶稳定前缀上限 {PINNED_CHAR_LIMIT} 字符；超限时不会自动裁剪，需要用户取消部分置顶。</p>
      </Card>
    </div>
    <p className="hint">{view.epoch !== undefined ? `快照 epoch ${view.epoch}` : 'epoch 未记录'}{view.schemaVersion !== undefined ? ` · schema v${view.schemaVersion}` : ''}</p>
  </div>;
}

function memoryCenterTabLabel(tab: MemoryCenterTabId): string {
  return MEMORY_CENTER_TABS.find(item => item.id === tab)?.label || tab;
}

/* ------------------------------------------------------------------------- */
/* Records                                                                   */
/* ------------------------------------------------------------------------- */

interface RecordDetailState {
  id: string;
  loading: boolean;
  error: string;
  record: JsonObject | null;
  versions: JsonObject[];
  originals: { title: string; text: string; error: string }[] | null;
  sourcesLoading: boolean;
}

interface EditorState {
  record: JsonObject;
  title: string;
  content: string;
  conditions: string;
  error: string;
}

interface ImpactState {
  action: 'update' | 'forget';
  record: JsonObject;
  patch?: JsonObject;
  loading: boolean;
  error: string;
  preview: MemoryImpactView | null;
  raw: JsonObject | null;
}

interface ConfirmToggleState {
  record: JsonObject;
  enabled: boolean;
}

function RecordsTab({ view, request, perform, pending, report, openRecord, focusId, sessionId, goal, refresh }: TabBase) {
  const [filters, setFilters] = useState<MemoryRecordFilters>({ ...EMPTY_RECORD_FILTERS });
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState<{ ids: string[]; query: string; error: string } | null>(null);
  const [selected, setSelected] = useState(focusId || '');
  const [detail, setDetail] = useState<RecordDetailState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [impact, setImpact] = useState<ImpactState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmToggleState | null>(null);
  const [forgetTarget, setForgetTarget] = useState<JsonObject | null>(null);
  const [bulk, setBulk] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [creating, setCreating] = useState<{ title: string; content: string; kind: string; scope: string; error: string } | null>(null);
  const [pendingLabel, setPendingLabel] = useState('');
  const [advanced, setAdvanced] = useState<{ mode: 'merge' | 'split' | 'supersede'; peer: string; content: string; title: string; parts: { title: string; content: string; conditions: string }[]; error: string } | null>(null);
  const busy = Boolean(pending) || Boolean(pendingLabel);
  const sourceRecords = useMemo(() => {
    if (search) return search.ids.flatMap(id => (view.recordById.get(id) ? [view.recordById.get(id)!] : []));
    return view.records;
  }, [search, view]);
  const filtered = useMemo(() => memoryRecordList(sourceRecords, filters), [sourceRecords, filters]);
  const recordPage = useMemo(() => memoryRecordPage(filtered, page), [filtered, page]);

  useEffect(() => {
    if (!focusId) return;
    setSelected(focusId);
    void loadDetail(focusId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const setFilter = (patch: Partial<MemoryRecordFilters>) => {
    setFilters(previous => ({ ...previous, ...patch }));
    setPage(0);
    if (patch.query === '') setSearch(null);
  };

  const runSearch = async () => {
    const query = filters.query.trim();
    if (!query) { setSearch(null); return; }
    try {
      const result = await request('search', memorySearchInput(query, filters));
      const value = asObject(result);
      const rows = Array.isArray(result) ? asList<JsonObject>(result) : asList<JsonObject>(value.records || value.matches || value.results);
      const ids = rows.map(row => String(row.id || '')).filter(Boolean);
      setSearch({ ids, query, error: '' });
      setPage(0);
      if (!ids.length) report('检索零命中：零命中不代表历史中不存在；可尝试别名、主题或更短的关键词。');
    } catch (error) {
      setSearch({ ids: [], query, error: errorText(error) });
      setPendingLabel('');
      report(errorText(error), true);
    }
  };

  const loadDetail = async (id: string) => {
    const fallback = view.recordById.get(id);
    if (!fallback) return;
    setDetail({ id, loading: true, error: '', record: fallback, versions: [], originals: null, sourcesLoading: false });
    try {
      const [readResult, versionsResult] = await Promise.all([
        request('read', memoryReadInput(id, Number(fallback.revision) || undefined)),
        request('versions', memoryVersionsInput(id)).catch(() => []),
      ]);
      const record = asObject(readResult);
      setDetail({ id, loading: false, error: '', record: Object.keys(record).length ? record : fallback, versions: asList<JsonObject>(versionsResult), originals: null, sourcesLoading: false });
    } catch (error) {
      setDetail({ id, loading: false, error: errorText(error), record: fallback, versions: [], originals: null, sourcesLoading: false });
    }
  };

  const guardPending = () => {
    if (editor) { report('请先保存或取消当前编辑。', true); return false; }
    if (forgetTarget || confirm) { report('请先处理当前确认。', true); return false; }
    return true;
  };

  const openDetail = (id: string) => {
    if (!guardPending()) return;
    setSelected(id);
    setConfirm(null);
    setEditor(null);
    setForgetTarget(null);
    setImpact(null);
    void loadDetail(id);
  };

  const closeDetail = () => {
    setSelected('');
    setDetail(null);
    setEditor(null);
    setForgetTarget(null);
    setConfirm(null);
    setImpact(null);
    setAdvanced(null);
  };

  const loadSources = async () => {
    if (!detail) return;
    setDetail({ ...detail, sourcesLoading: true });
    try {
      const value = asObject(await request('read', memoryReadSourcesInput(detail.id, Number(asObject(detail.record).revision) || undefined)));
      setDetail({ ...detail, sourcesLoading: false, originals: memoryDetailSources(detail.record || {}, value).originals });
    } catch (error) {
      setDetail({ ...detail, sourcesLoading: false, originals: [{ title: '来源原文', text: '', error: errorText(error) }] });
    }
  };

  const startUpdateImpact = async (record: JsonObject, patch: JsonObject) => {
    setPendingLabel('impact');
    setImpact({ action: 'update', record, patch, loading: true, error: '', preview: null, raw: null });
    try {
      const preview = await request('impact.preview', { action: 'update', id: String(record.id), patch });
      setImpact({ action: 'update', record, patch, loading: false, error: '', preview: memoryImpactView(preview), raw: asObject(preview) });
    } catch (error) {
      setImpact({ action: 'update', record, patch, loading: false, error: errorText(error), preview: null, raw: null });
    } finally { setPendingLabel(''); }
  };

  const startForgetImpact = async (record: JsonObject) => {
    setForgetTarget(record);
    setEditor(null);
    setPendingLabel('impact');
    setImpact({ action: 'forget', record, loading: true, error: '', preview: null, raw: null });
    try {
      const preview = await request('impact.preview', { action: 'forget', id: String(record.id) });
      setImpact({ action: 'forget', record, loading: false, error: '', preview: memoryImpactView(preview), raw: asObject(preview) });
    } catch (error) {
      setImpact({ action: 'forget', record, loading: false, error: errorText(error), preview: null, raw: null });
    } finally { setPendingLabel(''); }
  };

  const commitImpact = async () => {
    if (!impact?.raw || !impact.preview?.available) return;
    setPendingLabel('commit');
    try {
      const recordId = String(impact.record.id);
      if (impact.action === 'update') {
        await perform('update', memoryImpactCommitInput(impact.raw, 'update', recordId, impact.patch), '记忆已更正；相关派生内容已失效。');
        setEditor(null);
      } else {
        await perform('forget', memoryImpactCommitInput(impact.raw, 'forget', recordId), '记忆已遗忘；原始会话历史保留。');
        setForgetTarget(null);
      }
      setImpact(null);
      await loadDetail(recordId);
      setSelected(recordId);
    } catch (error) {
      setImpact(previous => previous ? { ...previous, error: errorText(error) } : previous);
    } finally { setPendingLabel(''); }
  };

  const toggleRecord = async (record: JsonObject, enabled: boolean) => {
    setPendingLabel('toggle');
    try {
      const requestValue = memoryBulkToggleRequests([record], enabled)[0];
      if (!requestValue) throw new Error('记录缺少编号或版本。');
      await perform(requestValue.action, requestValue.input, enabled ? '记忆已启用。' : '记忆已停用；派生内容同步失效。');
      setConfirm(null);
      if (selected) await loadDetail(selected);
    } catch { /* perform already reported */ } finally { setPendingLabel(''); }
  };

  const pinRecord = async (record: JsonObject) => {
    setPendingLabel('pin');
    try {
      const requestValue = memoryPinRequest(record, view.pinned);
      await perform(requestValue.action, requestValue.input, requestValue.action === 'pin' ? '已加入置顶稳定前缀。' : '已取消置顶。');
      if (selected) await loadDetail(selected);
    } catch (error) {
      report(errorText(error), true);
    } finally { setPendingLabel(''); }
  };

  const createMemory = async () => {
    if (!creating) return;
    const content = creating.content.trim();
    if (!content) return;
    setPendingLabel('create');
    try {
      const title = creating.title.trim() || Array.from(content).slice(0, 24).join('');
      await perform('save', {
        kind: creating.kind,
        scope: creating.kind === 'preference' ? 'personal' : creating.scope,
        explicitRemember: true,
        title,
        content,
      }, '记忆已保存。');
      setCreating(null);
    } catch (error) {
      setCreating(previous => previous ? { ...previous, error: errorText(error) } : previous);
    } finally { setPendingLabel(''); }
  };

  const runBulk = async (kind: 'disable' | 'enable' | 'pin') => {
    const records = view.records.filter(record => bulk.includes(String(record.id)));
    if (!records.length) return;
    setPendingLabel('bulk');
    try {
      if (kind === 'pin') {
        const plan = memoryBulkPinRequests(records, view.pinned, true);
        for (const entry of plan.actions) await perform(entry.action, entry.input);
        const skipped = plan.skipped.map(item => `${item.id}：${item.reason}`).join('；');
        report(`已置顶 ${plan.actions.length} 条${skipped ? `；跳过 ${plan.skipped.length} 条——${skipped}` : ''}${plan.overBudget ? '；置顶预算已超限' : ''}`);
      } else {
        const plan = memoryBulkToggleRequests(records, kind === 'enable');
        for (const entry of plan) await perform(entry.action, entry.input);
        report(`已${kind === 'enable' ? '启用' : '停用'} ${plan.length} 条记忆。`);
      }
      setBulk([]);
    } catch { /* reported by perform/report */ } finally { setPendingLabel(''); }
  };

  const submitAdvanced = async () => {
    if (!advanced || !selected) return;
    setPendingLabel('advanced');
    try {
      const record = view.recordById.get(selected);
      if (!record) throw new Error('记录已不在当前快照。');
      if (advanced.mode === 'merge') {
        const peer = advanced.peer || view.records.find(item => String(item.id) !== selected)?.id as string | undefined;
        const input = memoryMergeInput(selected, String(peer || ''), advanced.content);
        await perform('merge', input, '已合并为新记录并记录血缘；可回滚。');
      } else if (advanced.mode === 'split') {
        const input = memorySplitInput(selected, advanced.parts.map(part => ({
          title: part.title,
          content: part.content,
          conditions: part.conditions.split(/[；;]/u).map(value => value.trim()).filter(Boolean),
        })));
        await perform('split', input, '已拆分记录并记录血缘；可回滚。');
      } else {
        const input = memorySupersedeInput(selected, advanced.peer);
        await perform('supersede', input, '已用新记录替代旧记录。');
      }
      setAdvanced(null);
      await loadDetail(selected);
    } catch (error) {
      setAdvanced(previous => previous ? { ...previous, error: errorText(error) } : previous);
    } finally { setPendingLabel(''); }
  };

  const detailRecord = detail?.record || null;
  const detailDiff = detailRecord ? memoryDetailRevisionDiff(detailRecord, detail?.versions || []) : null;
  const detailOriginals = detail?.originals || memoryDetailSources(detailRecord || {}).originals;
  const detailSources = memoryDetailSources(detailRecord || {});
  const selectedRecord = view.recordById.get(selected);
  const detailState = memoryRecordStateView(detailRecord || {});
  const eligible = selectedRecord ? memoryPinEligible(selectedRecord) : { eligible: false, reason: '' };
  const pinned = selectedRecord ? view.pinned.ids.includes(String(selectedRecord.id)) : false;
  const drawerOpen = Boolean(confirm || editor || forgetTarget || detail || (impact && !editor && !forgetTarget));

  return <div className="memory-center-records">
    <section className="memory-center-toolbar" aria-label="筛选与搜索">
      <form className="memory-center-toolbar-search" onSubmit={event => { event.preventDefault(); void runSearch(); }}>
        <input aria-label="搜索记忆记录" placeholder="搜索标题、正文或主题" value={filters.query} onChange={event => setFilter({ query: event.target.value })} />
        <button type="submit" disabled={busy || !filters.query.trim()}>搜索</button>
        {search && <button type="button" disabled={busy} onClick={() => { setSearch(null); setFilter({ query: '' }); }}>清除</button>}
      </form>
      <select aria-label="按类型筛选" value={filters.kind} onChange={event => setFilter({ kind: event.target.value })}>
        <option value="all">全部类型</option>
        {MEMORY_KIND_IDS.map(kind => <option key={kind} value={kind}>{memoryKindLabel(kind)}</option>)}
        <option value="method">旧方法</option>
      </select>
      <select aria-label="按范围筛选" value={filters.scope} onChange={event => setFilter({ scope: event.target.value as MemoryRecordFilters['scope'] })}>
        {RECORD_SCOPE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <select aria-label="按状态筛选" value={filters.status} onChange={event => setFilter({ status: event.target.value as MemoryRecordFilters['status'] })}>
        {RECORD_STATUS_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <details className="memory-center-toolbar-more">
        <summary>更多</summary>
        <div className="memory-center-toolbar-pop">
          <Field label="主题/别名"><input aria-label="按主题筛选记录" placeholder="subject、标题或别名" value={filters.subject} onChange={event => setFilter({ subject: event.target.value })} /></Field>
        </div>
      </details>
      <button type="button" aria-pressed={bulkMode} onClick={() => { setBulkMode(value => !value); if (bulkMode) setBulk([]); }}>批量</button>
      <button type="button" className="primary" disabled={busy} onClick={() => setCreating({ title: '', content: '', kind: 'fact', scope: 'project', error: '' })}>＋ 记住一条</button>
      <span className="memory-center-toolbar-count">{view.records.length} 条</span>
    </section>

    {search && <p className="memory-center-search-note" role="status">搜索“{search.query}”命中 {search.ids.length} 条{search.error ? `：${search.error}` : '；结果仅包含当前可检索记录，停用与失效记录请清除搜索查看。'}</p>}

    {bulkMode && <div className="memory-center-bulk" role="region" aria-label="批量操作">
      <span>已选择 {bulk.length} 条</span>
      <button type="button" disabled={busy || !bulk.length} onClick={() => { setConfirm(null); void runBulk('disable'); }}>批量停用</button>
      <button type="button" disabled={busy || !bulk.length} onClick={() => void runBulk('enable')}>批量启用</button>
      <button type="button" disabled={busy || !bulk.length} onClick={() => void runBulk('pin')}>批量置顶</button>
      <button type="button" onClick={() => { setBulk([]); setBulkMode(false); }}>退出批量</button>
      <small>批量停用影响派生内容；批量置顶遵守 {PINNED_CHAR_LIMIT} 字符预算，超限条目会跳过并提示。</small>
    </div>}

    <div className={`memory-center-records-body ${drawerOpen ? 'has-detail' : ''}`}>
      <div className="memory-center-records-list">
        <Card title="记忆列表" actions={recordPage.pageCount > 1 ? <span className="hint">第 {recordPage.page + 1} / {recordPage.pageCount} 页</span> : undefined}>
          {recordPage.items.length === 0 && <Empty title={search ? '没有匹配的记录' : '没有符合筛选条件的记忆'}>
            {search ? '清除搜索或调整筛选；零命中不代表历史中不存在。' : '候选与失效记录在「候选」页处理；这里只显示已保存记录。'}
          </Empty>}
          {recordPage.items.map(record => {
            const id = String(record.id);
            const isPinned = view.pinned.ids.includes(id);
            return <MemoryRow
              key={id}
              record={record}
              selected={selected === id}
              pinned={isPinned}
              bulkMode={bulkMode}
              checked={bulk.includes(id)}
              busy={busy}
              onOpen={() => openDetail(id)}
              onCheck={checked => setBulk(previous => checked ? [...new Set([...previous, id])] : previous.filter(value => value !== id))}
              onPin={() => void pinRecord(record)}
              onToggle={() => { if (!guardPending()) return; setSelected(id); setConfirm({ record, enabled: record.enabled === false }); }}
              onForget={() => { if (!guardPending()) return; setSelected(id); void startForgetImpact(record); }}
            />;
          })}
          {recordPage.pageCount > 1 && <Pager page={recordPage} onPage={setPage} />}
        </Card>
      </div>

      {drawerOpen && <aside className="memory-center-record-detail" aria-label="记录详情">
        {confirm && <Card title={confirm.enabled ? '启用记忆' : '停用记忆'} actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => setConfirm(null)}>取消</button>}>
          <p>将{confirm.enabled ? '启用' : '停用'}「{String(confirm.record.title)}」。{confirm.enabled ? '启用后重新参与检索。' : '停用会让相关派生内容同步失效；原始会话历史保留。'}</p>
          <button type="button" className={confirm.enabled ? 'primary' : 'danger'} disabled={busy} onClick={() => void toggleRecord(confirm.record, confirm.enabled)}>{busy ? '处理中…' : `确认${confirm.enabled ? '启用' : '停用'}`}</button>
        </Card>}
        {editor && <Card title="编辑记忆" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => setEditor(null)}>取消</button>}>
          <Field label="标题"><input value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} /></Field>
          <Field label="正文"><textarea rows={6} value={editor.content} onChange={event => setEditor({ ...editor, content: event.target.value })} /></Field>
          <Field label="适用条件（每行一条）" hint="条件必须完整；不完整的条件会影响召回适用范围。"><textarea rows={3} value={editor.conditions} onChange={event => setEditor({ ...editor, conditions: event.target.value })} /></Field>
          <p className="hint">保存前必须预览影响；影响变化后需要重新预览。</p>
          {impact?.action === 'update' && impact.record.id === editor.record.id && (impact.loading ? <p role="status">正在核对影响…</p> : impact.error ? <Notice message={impact.error} onClose={() => setImpact(null)} error /> : impact.preview ? <ImpactPreviewPanel preview={impact.preview} /> : null)}
          <div className="button-row">
            <button type="button" className="primary" disabled={busy || !editor.content.trim()} onClick={() => void startUpdateImpact(editor.record, {
              title: editor.title,
              content: editor.content,
              conditions: editor.conditions.split(/\n/u).map(value => value.trim()).filter(Boolean),
            })}>{busy ? '处理中…' : impact?.action === 'update' && impact.preview?.available ? '重新预览影响' : '预览影响'}</button>
            <button type="button" className="danger-text" disabled={busy || !impact?.preview?.available} onClick={() => void commitImpact()}>确认保存更正</button>
          </div>
        </Card>}
        {forgetTarget && impact?.action === 'forget' && <Card title="遗忘这条记忆" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => { setForgetTarget(null); setImpact(null); }}>取消</button>}>
          <p>将遗忘「{String(forgetTarget.title)}」及其派生内容，并阻止从旧来源重新学习。原始 Pi 会话历史保留。</p>
          {impact.loading && <p role="status">正在核对影响…</p>}
          {impact.error && <Notice message={impact.error} onClose={() => setImpact(null)} error />}
          {impact.preview && <ImpactPreviewPanel preview={impact.preview} />}
          <button type="button" className="danger full" disabled={busy || !impact.preview?.available} onClick={() => void commitImpact()}>{busy ? '正在遗忘…' : impact.preview?.available ? '确认遗忘' : '重新预览影响'}</button>
        </Card>}
        {detail && !editor && !forgetTarget && <Card title={detailRecord?.title ? String(detailRecord.title) : '记录详情'} actions={<button type="button" className="memory-center-link" disabled={busy} onClick={closeDetail}>关闭</button>}>
          {detail.loading && <p role="status">正在读取记录与版本…</p>}
          {detail.error && <Notice message={detail.error} onClose={closeDetail} error />}
          {detailRecord && <>
            <div className="memory-center-detail-meta">
              <StatusPill record={detailRecord} />
              <span>{memoryKindLabel(detailRecord.kindV2 || detailRecord.kind)} · {memoryScopeLabel(detailRecord.scope)} · 更新于 <span title={String(detailRecord.updatedAt || '')}>{memoryRelativeTime(detailRecord.updatedAt)}</span> · v{String(detailRecord.revision ?? '?')}</span>
            </div>
            {detailState.status !== 'active' && <p className="hint">{detailState.safety}</p>}
            <Markdown text={String(detailRecord.content || '')} />
            {asList<string>(detailRecord.conditions).length > 0 && <details className="memory-center-fold">
              <summary>适用条件 {asList<string>(detailRecord.conditions).length} 条</summary>
              <ul className="memory-center-condition-list">{asList<string>(detailRecord.conditions).map((condition, index) => <li key={index}>{condition}</li>)}</ul>
            </details>}
            {detailSources.sources.length > 0 ? <details className="memory-center-fold">
              <summary>来源 {detailSources.sources.length} 条</summary>
              <ul className="memory-center-source-list">{detailSources.sources.map(source => <li key={source.label}><code>{source.label}</code></li>)}</ul>
              {detail.originals === null && <button type="button" disabled={busy || detail.sourcesLoading} onClick={() => void loadSources()}>{detail.sourcesLoading ? '正在读取…' : '读取来源原文'}</button>}
              {detailOriginals.length > 0 && <div className="memory-center-original-list">{detailOriginals.map((original, index) => <article key={index}><strong>{original.title}</strong>{original.error ? <p className="memory-center-warning">{original.error}</p> : <Markdown text={original.text} />}</article>)}</div>}
            </details> : <p className="hint">来源：用户明确输入</p>}
            {detailDiff?.available && <details className="memory-center-fold">
              <summary>版本 v{memoryCountText(detailDiff.currentRevision)}：{detailDiff.summary}</summary>
              <TextDiff before={detailDiff.before} after={detailDiff.after} />
            </details>}
            <details className="memory-center-fold">
              <summary>更多信息</summary>
              <dl className="memory-center-facts">
                <div><dt>使用次数</dt><dd>{memoryCountText(Number(detailRecord.useCount) || undefined)}</dd></div>
                <div><dt>反馈分</dt><dd>{memoryCountText(typeof detailRecord.feedbackScore === 'number' ? detailRecord.feedbackScore : undefined)}</dd></div>
                <div><dt>置顶</dt><dd>{pinned ? `已置顶（${memoryPinnedChars(detailRecord)} 字符）` : eligible.eligible ? '未置顶' : eligible.reason}</dd></div>
                <div><dt>来源</dt><dd>{detailSources.sources.length} 条</dd></div>
              </dl>
              <p className="hint">有效期：{memoryDateText(detailRecord.validFrom) || '未指定'} 至 {memoryDateText(detailRecord.validTo) || '未指定'}{detailRecord.expiresAt ? ` · 过期 ${memoryDateText(detailRecord.expiresAt)}` : ''}{detailRecord.reviewAfter ? ` · 建议复核 ${memoryDateText(detailRecord.reviewAfter)}` : ''}</p>
              {detailRecord.autoPublished === true && <p className="hint">自动发布 · 分数 {String(detailRecord.score ?? '未记录')} · 策略 v{String(detailRecord.policyVersion ?? '?')} · 信任 {String(detailRecord.trust ?? '未记录')}</p>}
            </details>
            <div className="memory-center-record-actions">
              <button type="button" disabled={busy} onClick={() => setEditor({ record: detailRecord, title: String(detailRecord.title || ''), content: String(detailRecord.content || ''), conditions: asList<string>(detailRecord.conditions).join('\n'), error: '' })}>编辑</button>
              <button type="button" disabled={busy} onClick={() => void pinRecord(detailRecord)}>{pinned ? '取消置顶' : '置顶'}</button>
              <button type="button" disabled={busy} onClick={() => setConfirm({ record: detailRecord, enabled: detailRecord.enabled === false })}>{detailRecord.enabled === false ? '启用' : '停用'}</button>
              <button type="button" className="danger-text" disabled={busy} onClick={() => void startForgetImpact(detailRecord)}>遗忘</button>
              <MemoryFeedbackButtons sessionId={sessionId} id={String(detailRecord.id)} revision={Number(detailRecord.revision) || 1} goal={goal} query={filters.query} disabled={busy || !memoryFeedbackAvailable({ status: String(detailRecord.status), enabled: detailRecord.enabled !== false, validFrom: detailRecord.validFrom as string | undefined, validTo: detailRecord.validTo as string | undefined, invalidatedReason: detailRecord.invalidatedReason as string | undefined })} report={report} onSaved={() => { void refresh().catch(error => report(errorText(error), true)); }} />
            </div>
            <details className="memory-center-advanced">
              <summary>高级整理（合并 / 拆分 / 替代，记录血缘且可回滚）</summary>
              <div className="memory-center-advanced-actions">
                <button type="button" disabled={busy} onClick={() => setAdvanced({ mode: 'merge', peer: '', content: '', title: '', parts: [], error: '' })}>合并</button>
                <button type="button" disabled={busy} onClick={() => setAdvanced({ mode: 'split', peer: '', content: '', title: '', parts: [{ title: '', content: '', conditions: '' }, { title: '', content: '', conditions: '' }], error: '' })}>拆分</button>
                <button type="button" disabled={busy} onClick={() => setAdvanced({ mode: 'supersede', peer: '', content: '', title: '', parts: [], error: '' })}>替代</button>
              </div>
              {advanced && <section className="memory-center-advanced-form" aria-label="高级整理确认">
                {advanced.mode === 'merge' && <>
                  <Field label="合并对象"><select value={advanced.peer} onChange={event => setAdvanced({ ...advanced, peer: event.target.value })}><option value="">选择另一条记录</option>{view.records.filter(record => String(record.id) !== detail.id).map(record => <option key={String(record.id)} value={String(record.id)}>{String(record.title)}</option>)}</select></Field>
                  <Field label="合并后正文（留空使用左侧正文）"><textarea rows={4} value={advanced.content} onChange={event => setAdvanced({ ...advanced, content: event.target.value })} /></Field>
                </>}
                {advanced.mode === 'split' && <>
                  {advanced.parts.map((part, index) => <div key={index} className="memory-center-split-part">
                    <Field label={`第 ${index + 1} 部分标题`}><input value={part.title} onChange={event => setAdvanced({ ...advanced, parts: advanced.parts.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item) })} /></Field>
                    <Field label="正文"><textarea rows={2} value={part.content} onChange={event => setAdvanced({ ...advanced, parts: advanced.parts.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item) })} /></Field>
                    <Field label="条件（分号分隔）"><input value={part.conditions} onChange={event => setAdvanced({ ...advanced, parts: advanced.parts.map((item, itemIndex) => itemIndex === index ? { ...item, conditions: event.target.value } : item) })} /></Field>
                  </div>)}
                  <button type="button" className="memory-center-link" onClick={() => setAdvanced({ ...advanced, parts: [...advanced.parts, { title: '', content: '', conditions: '' }] })}>＋ 添加部分</button>
                </>}
                {advanced.mode === 'supersede' && <Field label="新记录"><select value={advanced.peer} onChange={event => setAdvanced({ ...advanced, peer: event.target.value })}><option value="">选择替代记录</option>{view.records.filter(record => String(record.id) !== detail.id).map(record => <option key={String(record.id)} value={String(record.id)}>{String(record.title)}</option>)}</select></Field>}
                {advanced.error && <p className="memory-center-warning" role="alert">{advanced.error}</p>}
                <p className="hint">这些操作会停用旧记录并保留血缘，可通过 consolidation.rollback 恢复；请确认影响后再执行。</p>
                <div className="button-row">
                  <button type="button" className="danger-text" disabled={busy} onClick={() => void submitAdvanced()}>确认{advanced.mode === 'merge' ? '合并' : advanced.mode === 'split' ? '拆分' : '替代'}</button>
                  <button type="button" disabled={busy} onClick={() => setAdvanced(null)}>取消</button>
                </div>
              </section>}
            </details>
          </>}
        </Card>}
        {impact?.action === 'update' && !editor && impact.preview && <Card title="待确认的更正"><ImpactPreviewPanel preview={impact.preview} /><div className="button-row"><button type="button" className="primary" disabled={busy || !impact.preview?.available} onClick={() => void commitImpact()}>确认保存更正</button><button type="button" disabled={busy} onClick={() => setImpact(null)}>取消</button></div>{impact.error && <Notice message={impact.error} onClose={() => setImpact(null)} error />}</Card>}
      </aside>}
    </div>

    {creating && <Modal title="记住一条" closeDisabled={busy} onClose={() => setCreating(null)}>
      <Field label="标题"><input value={creating.title} onChange={event => setCreating({ ...creating, title: event.target.value })} /></Field>
      <Field label="内容"><textarea rows={6} value={creating.content} onChange={event => setCreating({ ...creating, content: event.target.value })} /></Field>
      <div className="form-row">
        <Field label="类型"><select value={creating.kind} disabled={busy} onChange={event => setCreating({ ...creating, kind: event.target.value, scope: event.target.value === 'preference' ? 'personal' : creating.scope })}>
          <option value="fact">项目事实</option><option value="experience">项目经验</option><option value="preference">个人偏好</option>
        </select></Field>
        <Field label="范围"><select value={creating.scope} disabled={busy || creating.kind === 'preference'} onChange={event => setCreating({ ...creating, scope: event.target.value })}>
          <option value="project" disabled={creating.kind === 'preference'}>本项目</option><option value="personal">个人</option>
        </select></Field>
      </div>
      <p className="hint">点击记住表示你明确要求保存此内容；保存后直接生效。</p>
      {creating.error && <p className="memory-center-warning" role="alert">{creating.error}</p>}
      <button className="primary full" disabled={busy || !creating.content.trim()} onClick={() => void createMemory()}>{pendingLabel === 'create' ? '正在保存…' : '记住'}</button>
    </Modal>}
  </div>;
}


/* ------------------------------------------------------------------------- */
/* Candidates                                                                */
/* ------------------------------------------------------------------------- */

function CandidatesTab({ view, request, perform, pending, report, openRecord, refresh, sessionId, goal }: TabBase) {
  const groups = useMemo(() => memoryCandidateGroups(view), [view]);
  const [confirm, setConfirm] = useState<{ kind: 'accept' | 'reject'; candidate: CandidateView } | null>(null);
  const [editing, setEditing] = useState<{ candidate: CandidateView; title: string; content: string; conditions: string } | null>(null);
  const [impact, setImpact] = useState<{ candidate: CandidateView; raw: JsonObject | null; preview: MemoryImpactView | null; loading: boolean; error: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const busy = Boolean(pending);

  const startEditImpact = async () => {
    if (!editing) return;
    const patch = { title: editing.title, content: editing.content, conditions: editing.conditions.split(/\n/u).map(value => value.trim()).filter(Boolean) };
    setImpact({ candidate: editing.candidate, raw: null, preview: null, loading: true, error: '' });
    try {
      const preview = await request('impact.preview', { action: 'update', id: editing.candidate.id, patch });
      setImpact({ candidate: editing.candidate, raw: asObject(preview), preview: memoryImpactView(preview), loading: false, error: '' });
    } catch (error) {
      setImpact({ candidate: editing.candidate, raw: null, preview: null, loading: false, error: errorText(error) });
    }
  };

  const commitEdit = async () => {
    if (!editing || !impact?.raw || !impact.preview?.available) return;
    try {
      const patch = { title: editing.title, content: editing.content, conditions: editing.conditions.split(/\n/u).map(value => value.trim()).filter(Boolean) };
      const requestValue = memoryCandidateEditRequest(editing.candidate, impact.raw, patch);
      await perform(requestValue.action, requestValue.input, '候选已由用户更正并生效。');
      setEditing(null);
      setImpact(null);
      await refresh();
    } catch (error) {
      setImpact(previous => previous ? { ...previous, error: errorText(error) } : previous);
      report(errorText(error), true);
    }
  };

  const accept = async (candidate: CandidateView) => {
    try {
      const requestValue = memoryCandidateAcceptRequest(candidate);
      await perform(requestValue.action, requestValue.input, '候选已接受；同主题不同值会转为冲突等待裁决。');
      setConfirm(null);
    } catch { /* reported */ }
  };

  const reject = async (candidate: CandidateView) => {
    try {
      const requestValue = memoryCandidateRejectRequest(candidate);
      await perform(requestValue.action, requestValue.input, '候选已拒绝并停用；不会自动重新学习。');
      setConfirm(null);
    } catch { /* reported */ }
  };

  const acceptSelected = async () => {
    const chosen = view.candidates.filter(candidate => selected.includes(String(candidate.id)));
    for (const candidate of chosen) {
      try {
        const requestValue = memoryCandidateAcceptRequest(candidate);
        await perform(requestValue.action, requestValue.input);
      } catch { /* reported; continue with the rest */ }
    }
    report(`已处理 ${chosen.length} 条候选的接受请求。`);
    setSelected([]);
    setBulkConfirm(false);
    await refresh();
  };

  return <div className="memory-center-candidates">
    {view.candidates.length === 0 ? <Empty title="暂无待处理候选">{memoryCenterEmptyMessage('candidates', view)}</Empty> : <>
      <Card title="候选操作说明"><p className="hint">候选未采用，不参与召回。接受会成为生效记忆；更正必须以用户身份提交并携带影响预览；门禁未通过的候选会显示拒绝原因。自动发布门禁明细按 #1-#10 展示。</p>
        {selected.length > 0 && <div className="memory-center-bulk" role="region" aria-label="批量接受候选">
          <span>已选择 {selected.length} 条</span>
          <button type="button" disabled={busy} onClick={() => setBulkConfirm(true)}>批量接受</button>
          <button type="button" disabled={busy} onClick={() => setSelected([])}>取消选择</button>
        </div>}
        {bulkConfirm && <div className="memory-center-inline-confirm" role="group" aria-label="确认批量接受">
          <p>将接受 {selected.length} 条候选。同主题存在不同生效值时会转为冲突，等待裁决。</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void acceptSelected()}>确认接受</button>
          <button type="button" disabled={busy} onClick={() => setBulkConfirm(false)}>取消</button>
        </div>}
      </Card>
      {groups.map(group => <Card key={group.key} title={group.label} actions={<span className="hint">{group.candidates.length} 条候选{group.rejected ? ` · ${group.rejected} 条门禁未通过` : ''}{group.jobState ? ` · 批次 ${group.jobState}` : ''}</span>}>
        {group.candidates.map(candidate => {
          const raw = view.recordById.get(candidate.id) || {};
          return <article className="memory-center-candidate" key={candidate.id}>
            <div className="memory-center-record-head">
              <label className="check"><input type="checkbox" checked={selected.includes(candidate.id)} aria-label={`选择候选 ${candidate.title}`} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, candidate.id])] : previous.filter(value => value !== candidate.id))} /><strong>{candidate.title}</strong></label>
              <span className="memory-center-record-badges"><span className={`memory-center-status ${candidate.status === 'invalidated' ? 'is-invalidated' : 'is-candidate'}`}>{candidate.status === 'invalidated' ? candidate.statusLabel : `${candidate.statusLabel}（未生效）`}</span></span>
            </div>
            <small>{candidate.kindLabel} · {candidate.scopeLabel} · v{String(candidate.revision ?? '?')} · 信任 {candidate.trustLabel} · 分数 {memoryCountText(candidate.score)} · {candidate.sources} 条来源</small>
            <p className="memory-center-summary">{candidate.summary}</p>
            {candidate.conditions.length > 0 && <p className="hint">条件：{candidate.conditions.join('；')}</p>}
            {candidate.conflict && <p className="memory-center-warning" role="alert">与同主题生效记忆冲突，需要裁决。</p>}
            {candidate.status === 'invalidated' && <p className="memory-center-warning">来源已失效：不能直接接受；请先核对来源或选择忽略/遗忘。</p>}
            <p className="memory-center-warning">拒绝原因/保留原因：{candidate.rejectionReason}</p>
            <details>
              <summary>自动发布门禁明细：{candidate.gate.summary}</summary>
              {candidate.gate.available ? <ul className="memory-center-gates">{candidate.gate.items.map(gate => <li key={`${candidate.id}:${gate.id}`} className={gate.pass ? 'is-pass' : 'is-fail'}><span>#{gate.id} {gate.label}</span><strong>{gate.pass ? '通过' : '未通过'}</strong>{!gate.pass && gate.reason && <small>{gate.reason}</small>}</li>)}</ul>
                : <p className="hint">门禁明细未记录；候选保持未生效。可查看学习批次或自动发布审计了解原因。</p>}
            </details>
            <div className="memory-center-record-actions">
              <button type="button" disabled={busy || candidate.status === 'invalidated'} title={candidate.status === 'invalidated' ? '来源已失效，不能直接接受' : undefined} onClick={() => setConfirm({ kind: 'accept', candidate })}>接受</button>
              <button type="button" disabled={busy} onClick={() => { setEditing({ candidate, title: candidate.title, content: raw.content ? String(raw.content) : '', conditions: candidate.conditions.join('\n') }); setImpact(null); }}>编辑</button>
              <button type="button" className="danger-text" disabled={busy} onClick={() => setConfirm({ kind: 'reject', candidate })}>拒绝</button>
              <button type="button" disabled={busy} onClick={() => openRecord(candidate.id)}>查看记录</button>
            </div>
            {confirm?.candidate.id === candidate.id && <div className="memory-center-inline-confirm" role="group" aria-label={confirm.kind === 'accept' ? '确认接受候选' : '确认拒绝候选'}>
              {confirm.kind === 'accept' ? <>
                <p>接受后将成为生效记忆。若同主题已存在不同值，会转为冲突等待你裁决；检索不会同时给出两个生效值。</p>
                <button type="button" className="primary" disabled={busy} onClick={() => void accept(candidate)}>确认接受</button>
              </> : <>
                <p>拒绝会停用该候选并保留记录（当前控制器以 toggle enabled:false 实现）；不会自动重新学习。</p>
                <button type="button" className="danger" disabled={busy} onClick={() => void reject(candidate)}>确认拒绝</button>
              </>}
              <button type="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button>
            </div>}
            {editing?.candidate.id === candidate.id && <section className="memory-center-edit" aria-label="编辑候选">
              <Field label="标题"><input value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} /></Field>
              <Field label="正文"><textarea rows={5} value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} /></Field>
              <Field label="适用条件（每行一条）"><textarea rows={3} value={editing.conditions} onChange={event => setEditing({ ...editing, conditions: event.target.value })} /></Field>
              {impact && impact.candidate.id === candidate.id && (impact.loading ? <p role="status">正在核对影响…</p> : impact.error ? <p className="memory-center-warning" role="alert">{impact.error}</p> : impact.preview ? <ImpactPreviewPanel preview={impact.preview} /> : null)}
              <div className="button-row">
                <button type="button" disabled={busy || !editing.content.trim()} onClick={() => void startEditImpact()}>预览影响</button>
                <button type="button" className="primary" disabled={busy || !impact?.preview?.available} onClick={() => void commitEdit()}>确认更正并生效</button>
                <button type="button" disabled={busy} onClick={() => { setEditing(null); setImpact(null); }}>取消</button>
              </div>
            </section>}
          </article>;
        })}
      </Card>)}
    </>}
  </div>;
}

/* ------------------------------------------------------------------------- */
/* Conflicts                                                                 */
/* ------------------------------------------------------------------------- */

function ConflictsTab({ view, request, perform, pending, report, openRecord, refresh }: TabBase) {
  const [raw, setRaw] = useState<JsonObject[] | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'all' | 'open' | 'deferred' | 'resolved'>('open');
  const [resolving, setResolving] = useState<{ conflict: ConflictView; resolution: string; notes: string; content: string; title: string; error: string } | null>(null);
  const busy = Boolean(pending);

  const load = useCallback(async () => {
    try {
      const result = await request('conflict.list', {});
      setRaw(asList<JsonObject>(asObject(result).conflicts || result));
      setError('');
    } catch (cause) {
      const text = errorText(cause);
      setError(`冲突接口暂不可用，使用快照数据：${text}`);
      setRaw(null);
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  const conflicts = useMemo(() => memoryConflictViews({ ...view, conflicts: raw ?? view.conflicts }, status), [view, raw, status]);
  const resolve = async () => {
    if (!resolving) return;
    try {
      const input = memoryConflictResolveInput(resolving.conflict, resolving.resolution, {
        content: resolving.content,
        title: resolving.title,
        notes: resolving.notes,
      });
      await perform('conflict.resolve', input, '冲突已裁决；相关记录已更新。');
      setResolving(null);
      await load();
      await refresh();
    } catch (cause) {
      setResolving(previous => previous ? { ...previous, error: errorText(cause) } : previous);
      report(errorText(cause), true);
    }
  };

  return <div className="memory-center-conflicts">
    {error && <Notice message={error} onClose={() => setError('')} error />}
    <Card title="冲突筛选" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => void load()}>刷新冲突</button>}>
      <div className="memory-center-filter-buttons" role="group" aria-label="冲突状态">
        {([['open', '待裁决'], ['deferred', '已延后'], ['resolved', '已裁决'], ['all', '全部']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={status === value} disabled={busy} onClick={() => setStatus(value)}>{label}</button>)}
      </div>
      <p className="hint">冲突两侧并列显示 claim、条件、来源与支持度。裁决前会展示影响预览；操作后自动刷新。</p>
    </Card>
    {conflicts.length === 0 && <Empty title={status === 'open' ? '暂无待裁决冲突' : '没有符合筛选的冲突'}>{memoryCenterEmptyMessage('conflicts', view)}</Empty>}
    {conflicts.map(conflict => {
      const impact = memoryConflictImpactView(view, conflict, resolving?.conflict.id === conflict.id ? resolving.resolution : 'defer');
      const canResolve = conflict.status === 'open' || conflict.status === 'deferred';
      return <Card key={conflict.id} title={`冲突 · ${conflict.subjectKey || conflict.id}`} actions={<span className={`memory-center-status ${conflict.status === 'open' ? 'is-warning' : 'is-inactive'}`}>{conflict.statusLabel}</span>}>
        <div className="memory-center-conflict-sides">
          {[conflict.left, conflict.right].map(side => <article key={side.side} className="memory-center-conflict-side">
            <div className="memory-center-record-head"><strong>{side.side === 'left' ? '左侧' : '右侧'} · {side.title}</strong><StatusPill record={view.recordById.get(side.memoryId) || { status: side.status }} /></div>
            <p className="memory-center-summary">{side.claim}</p>
            <small>{side.kindLabel} · {side.scopeLabel} · v{memoryCountText(side.revision)} · {side.trustLabel} · {side.sources} 条来源 · 支持度 {memoryCountText(side.supportScore)}</small>
            {side.conditions.length > 0 ? <p className="hint">条件：{side.conditions.join('；')}</p> : <p className="hint">未记录适用条件</p>}
            {!side.found && <p className="memory-center-warning">记录已不在当前快照：请刷新后再裁决。</p>}
            {side.memoryId && <button type="button" className="memory-center-link" disabled={busy} onClick={() => openRecord(side.memoryId)}>在记录页打开</button>}
          </article>)}
        </div>
        {conflict.notes && <p className="hint">备注：{conflict.notes}</p>}
        {conflict.status === 'resolved' && <p className="hint">裁决结果：{conflict.resolutionLabel}{conflict.resolvedAt ? ` · ${conflict.resolvedAt}` : ''}</p>}
        {canResolve && <div className="memory-center-resolution-actions" role="group" aria-label="冲突裁决方式">
          {CONFLICT_RESOLUTIONS.map(resolution => {
            const allowed = memoryConflictResolveAllowed(conflict, resolution);
            return <button type="button" key={resolution} disabled={busy || !allowed.allowed} title={allowed.allowed ? '' : allowed.reason} aria-pressed={resolving?.conflict.id === conflict.id && resolving.resolution === resolution} onClick={() => setResolving({
              conflict,
              resolution,
              notes: '',
              content: resolution === 'merge' ? [conflict.left.claim, conflict.right.claim].filter(Boolean).join('\n') : '',
              title: conflict.left.title,
              error: '',
            })}>{CONFLICT_RESOLUTION_LABELS[resolution] || resolution}</button>;
          })}
        </div>}
        {resolving?.conflict.id === conflict.id && <section className="memory-center-resolution" aria-label="冲突裁决影响预览">
          <h4>{CONFLICT_RESOLUTION_LABELS[resolving.resolution] || resolving.resolution} · 影响预览</h4>
          <ImpactSummary impact={impact} />
          {resolving.resolution === 'merge' ? <>
            <Field label="合并后的标题"><input value={resolving.title} onChange={event => setResolving({ ...resolving, title: event.target.value })} /></Field>
            <Field label="合并后的完整正文" hint="必须完整表达两侧都成立的内容；不确定时请保留一侧或稍后处理。"><textarea rows={5} value={resolving.content} onChange={event => setResolving({ ...resolving, content: event.target.value })} /></Field>
          </> : null}
          <Field label="裁决备注（写入审计）"><textarea rows={2} value={resolving.notes} onChange={event => setResolving({ ...resolving, notes: event.target.value })} /></Field>
          {resolving.error && <p className="memory-center-warning" role="alert">{resolving.error}</p>}
          <div className="button-row">
            <button type="button" className={resolving.resolution === 'defer' ? 'secondary' : 'primary'} disabled={busy} onClick={() => void resolve()}>确认{CONFLICT_RESOLUTION_LABELS[resolving.resolution] || '裁决'}</button>
            <button type="button" disabled={busy} onClick={() => setResolving(null)}>取消</button>
          </div>
        </section>}
      </Card>;
    })}
  </div>;
}

function ImpactSummary({ impact }: { impact: ReturnType<typeof memoryConflictImpactView> }) {
  return <section className="memory-center-impact-summary" aria-label="冲突裁决影响摘要">
    <p>{impact.retrieval}</p>
    <dl>
      <div><dt>涉及记录</dt><dd>{impact.affectedRecords.length}</dd></div>
      <div><dt>派生内容</dt><dd>{impact.derived}</dd></div>
    </dl>
    <ul>{impact.affectedRecords.map(record => <li key={record.id}><code>{record.id}</code> · {record.title} · {record.statusLabel} → {record.role}</li>)}</ul>
    <small>影响预览来自当前快照；实际提交后以控制器返回的 affectedRecordIds 为准。</small>
  </section>;
}

/* ------------------------------------------------------------------------- */
/* Reviews                                                                   */
/* ------------------------------------------------------------------------- */

function ReviewsTab({ view, request, perform, pending, report, openRecord, refresh }: TabBase) {
  const [raw, setRaw] = useState<JsonObject[] | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('all');
  const [reviewStatus, setReviewStatus] = useState<'open' | 'deferred' | 'resolved' | 'all'>('open');
  const [reviewCounts, setReviewCounts] = useState<{ open: number | undefined; overdue: number | undefined }>({ open: undefined, overdue: undefined });
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<{ item: ReviewItemView; action: string; notes: string; content: string; conditions: string; error: string } | null>(null);
  const [batchConfirm, setBatchConfirm] = useState<{ action: 'confirm' | 'disable' | 'defer'; notes: string } | null>(null);
  const busy = Boolean(pending);

  const load = useCallback(async () => {
    try {
      const result = await request('review.list', memoryReviewListInput({ status: reviewStatus, limit: 200 }));
      const value = asObject(result);
      setRaw(asList<JsonObject>(Array.isArray(result) ? result : value.reviews || value.items));
      setReviewCounts({
        open: typeof value.open === 'number' ? value.open : undefined,
        overdue: typeof value.overdue === 'number' ? value.overdue : undefined,
      });
      setError('');
    } catch (cause) {
      setError(`复审接口暂不可用，使用快照数据：${errorText(cause)}`);
      setRaw(null);
    }
  }, [request, reviewStatus]);

  useEffect(() => { void load(); }, [load]);

  const all = useMemo(() => raw ? memoryReviewItems(raw) : view.reviews, [raw, view.reviews]);
  const items = useMemo(() => reason === 'all' ? all : all.filter(item => item.reason === reason), [all, reason]);

  const recordFor = (item: ReviewItemView): JsonObject => view.recordById.get(item.memoryId) || item.record || {};
  const runAction = async () => {
    if (!action) return;
    try {
      const patch = action.action === 'correct' ? {
        content: action.content,
        ...(action.conditions.trim() ? { conditions: action.conditions.split(/\n/u).map(value => value.trim()).filter(Boolean) } : {}),
      } : undefined;
      const input = memoryReviewResolveInput(action.item, action.action, {
        confirmed: ['forget', 'disable', 'correct', 'merge', 'split'].includes(action.action) ? true : undefined,
        patch,
        notes: action.notes,
      });
      await perform('review.resolve', input, '复审已处理并记录审计。');
      setAction(null);
      await load();
      await refresh();
    } catch (cause) {
      setAction(previous => previous ? { ...previous, error: errorText(cause) } : previous);
      report(errorText(cause), true);
    }
  };

  const runBatch = async () => {
    if (!batchConfirm) return;
    const chosen = items.filter(item => selected.includes(item.id));
    try {
      const requests = memoryReviewBatchInputs(chosen, batchConfirm.action, { notes: batchConfirm.notes, confirmed: batchConfirm.action === 'disable' ? true : undefined });
      for (const entry of requests) await perform(entry.action, entry.input);
      report(`已批量处理 ${requests.length} 条复审；操作已写入审计。`);
      setSelected([]);
      setBatchConfirm(null);
      await load();
      await refresh();
    } catch (cause) {
      report(errorText(cause), true);
    }
  };

  return <div className="memory-center-reviews">
    {error && <Notice message={error} onClose={() => setError('')} error />}
    <Card title="复审队列" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => void load()}>刷新复审</button>}>
      <p className="hint">按优先级排序；控制器报告待处理 {memoryCountText(reviewCounts.open)} 条、已到期 {memoryCountText(reviewCounts.overdue ?? view.reviewsDue)} 条，当前列表 {items.length} 条。危险操作（停用/遗忘/更正）需要先查看影响并确认，批量操作仅支持确认、停用与稍后，并写入审计。</p>
      <div className="memory-center-filter-grid">
        <Field label="复审状态"><select value={reviewStatus} aria-label="按状态筛选复审" onChange={event => setReviewStatus(event.target.value as typeof reviewStatus)}><option value="open">待处理</option><option value="deferred">已延后</option><option value="resolved">已裁决</option><option value="all">全部</option></select></Field>
        <Field label="按原因筛选"><select value={reason} aria-label="按原因筛选复审" onChange={event => setReason(event.target.value)}><option value="all">全部原因</option>{Object.entries(REVIEW_REASON_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
      {selected.length > 0 && <div className="memory-center-bulk" role="region" aria-label="批量复审">
        <span>已选择 {selected.length} 条</span>
        <button type="button" disabled={busy} onClick={() => setBatchConfirm({ action: 'confirm', notes: '' })}>批量确认</button>
        <button type="button" disabled={busy} onClick={() => setBatchConfirm({ action: 'disable', notes: '' })}>批量停用</button>
        <button type="button" disabled={busy} onClick={() => setBatchConfirm({ action: 'defer', notes: '' })}>批量稍后</button>
        <button type="button" disabled={busy} onClick={() => setSelected([])}>取消选择</button>
      </div>}
      {batchConfirm && <div className="memory-center-inline-confirm" role="group" aria-label="确认批量复审">
        <p>将对 {selected.length} 条复审执行“{REVIEW_REASON_LABELS[batchConfirm.action] || batchConfirm.action}”；批量停用会同步失效派生的内容，操作会写入审计。</p>
        <Field label="批量备注（写入审计）"><input value={batchConfirm.notes} onChange={event => setBatchConfirm({ ...batchConfirm, notes: event.target.value })} /></Field>
        <button type="button" className={batchConfirm.action === 'disable' ? 'danger' : 'primary'} disabled={busy} onClick={() => void runBatch()}>确认批量处理</button>
        <button type="button" disabled={busy} onClick={() => setBatchConfirm(null)}>取消</button>
      </div>}
    </Card>
    {items.length === 0 && <Empty title="暂无到期复审">{memoryCenterEmptyMessage('reviews', view)}</Empty>}
    {items.map(item => {
      const record = recordFor(item);
      const actionable = item.status === 'open' || item.status === 'deferred';
      const actions = actionable ? memoryReviewActions(item) : [];
      const selectedItem = selected.includes(item.id);
      return <Card key={item.id} title={String(record.title || item.recordTitle || item.memoryId || '复审条目')} actions={<span className="memory-center-record-badges">{item.overdue && <span className="memory-center-status is-warning">已到期</span>}<span className="memory-center-status is-inactive">{item.reasonLabel}</span></span>}>
        <div className="memory-center-review-meta">
          <label className="check"><input type="checkbox" checked={selectedItem} disabled={!actionable} aria-label={`选择复审 ${item.memoryId}`} onChange={event => setSelected(previous => event.target.checked ? [...new Set([...previous, item.id])] : previous.filter(value => value !== item.id))} />选择批量处理</label>
          <small>优先级 {item.priority} · 到期 {item.dueAt || '未记录'} · 状态 {item.status} · v{memoryCountText(item.revision)}</small>
        </div>
        <p className="memory-center-summary">{memoryRecordSummary(record)}</p>
        {item.notes && <p className="hint">复审说明：{item.notes}</p>}
        {!actionable && <p className="hint">该复审项已{item.status === 'resolved' ? '裁决' : '延后'}，不再显示处理按钮。</p>}
        <div className="memory-center-record-actions">
          {actions.map(actionName => <button key={actionName} type="button" disabled={busy} className={['forget', 'disable'].includes(actionName) ? 'danger-text' : ''} onClick={() => setAction({
            item,
            action: actionName,
            notes: '',
            content: actionName === 'correct' ? String(record.content || '') : '',
            conditions: asList<string>(record.conditions).join('\n'),
            error: '',
          })}>{actionLabel(actionName)}</button>)}
          {Boolean(record.id) && <button type="button" disabled={busy} onClick={() => openRecord(String(record.id))}>查看记录</button>}
        </div>
        {action?.item.id === item.id && <section className="memory-center-review-action" aria-label="复审处理">
          <p className="hint">{actionHint(action.action)}</p>
          {action.action === 'correct' && <>
            <Field label="更正后的正文"><textarea rows={4} value={action.content} onChange={event => setAction({ ...action, content: event.target.value })} /></Field>
            <Field label="更正后的条件（每行一条，留空保持）"><textarea rows={2} value={action.conditions} onChange={event => setAction({ ...action, conditions: event.target.value })} /></Field>
          </>}
          {['forget', 'disable', 'merge', 'split'].includes(action.action) && <ReviewImpact view={view} record={record} />}
          <Field label="处理备注（写入审计）"><textarea rows={2} value={action.notes} onChange={event => setAction({ ...action, notes: event.target.value })} /></Field>
          {action.error && <p className="memory-center-warning" role="alert">{action.error}</p>}
          <div className="button-row">
            <button type="button" className={['forget', 'disable'].includes(action.action) ? 'danger' : 'primary'} disabled={busy} onClick={() => void runAction()}>确认{actionLabel(action.action)}</button>
            <button type="button" disabled={busy} onClick={() => setAction(null)}>取消</button>
          </div>
        </section>}
      </Card>;
    })}
  </div>;
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = { confirm: '确认', correct: '更正', merge: '合并', split: '拆分', disable: '停用', forget: '遗忘', defer: '稍后' };
  return labels[action] || action;
}

function actionHint(action: string): string {
  switch (action) {
    case 'confirm': return '确认该记忆仍然成立；会更新复审状态并刷新到期时间。';
    case 'correct': return '更正会创建新的用户确认版本，并使相关派生内容失效。';
    case 'disable': return '停用后不再参与召回，相关派生内容同步失效。';
    case 'forget': return '遗忘会删除记忆正文与版本并阻止从旧来源重新学习；原始 Pi 会话历史保留。';
    case 'defer': return '稍后处理会延后复审，不修改记忆正文。';
    case 'merge': return '合并会把相关记录合并为一条并保留血缘；请在记录页确认目标记录。';
    case 'split': return '拆分需要多个部分；请在记录页的高级整理中执行并核对影响。';
    default: return '请核对影响后确认。';
  }
}

function ReviewImpact({ view, record }: { view: MemoryCenterSnapshotView; record: JsonObject }) {
  const derived = record.id ? memoryDerivedRefs(view, String(record.id)) : [];
  return <section className="memory-center-impact-summary" aria-label="复审操作影响摘要">
    <p>该操作会影响当前记录及其派生内容（{derived.length} 条派生）。历史 Pi 会话原文保留；来源有效性由控制器再次核对。</p>
    <dl><div><dt>当前状态</dt><dd>{memoryRecordStateView(record).label}</dd></div><div><dt>版本</dt><dd>v{memoryCountText(Number(record.revision) || undefined)}</dd></div><div><dt>派生</dt><dd>{derived.length} 条</dd></div></dl>
    <small>提交后以控制器返回的结果为准；失败不会重放。</small>
  </section>;
}

/* ------------------------------------------------------------------------- */
/* Learning                                                                  */
/* ------------------------------------------------------------------------- */

function LearningTab({ view, perform, pending, report }: TabBase) {
  const jobs = useMemo(() => memoryLearningJobViews(view), [view]);
  const busy = Boolean(pending);
  const control = async (action: 'run' | 'retry' | 'pause' | 'resume', jobId?: string) => {
    try {
      const requestValue = memoryLearningControlRequest(action, jobId);
      const messages: Record<string, string> = { run: '学习已排入后台队列。', retry: '已请求重试失败批次。', pause: '学习已暂停。', resume: '学习已恢复。' };
      await perform(requestValue.action, requestValue.input, messages[action]);
    } catch (error) {
      report(errorText(error), true);
    }
  };
  return <div className="memory-center-learning">
    <Card title="后台学习" actions={<Badge value={view.learning.paused ? 'paused' : view.learning.running ? 'running' : view.learning.enabled ? 'active' : 'inactive'} />}>
      <p className="hint">Memory 独立处理来源与提案，前台可以同时工作。阶段、预算、提案与源区间分别展示；失败原因可读但不包含密钥。</p>
      <div className="memory-center-record-actions">
        <button type="button" disabled={busy} onClick={() => void control('run')}>立即学习</button>
        <button type="button" disabled={busy} onClick={() => void control(view.learning.paused ? 'resume' : 'pause')}>{view.learning.paused ? '恢复学习' : '暂停学习'}</button>
        <span className="hint">等待中 {view.learning.queued} · 失败 {view.learning.failed} · 累计调用 {memoryCountText(view.learning.calls)} / {memoryCountText(view.learning.maxCalls)}{view.learning.usageUnknown ? ' · 含未确认用量' : ''}</span>
      </div>
    </Card>
    {jobs.length === 0 && <Empty title="暂无学习批次">{memoryCenterEmptyMessage('learning', view)}</Empty>}
    {jobs.map(job => <Card key={job.id || 'job'} title={job.id ? `批次 ${job.id.slice(0, 12)}` : '学习批次'} actions={<span className="memory-center-record-badges"><span className="memory-center-status is-inactive">{job.stageLabel}</span><Badge value={job.state || 'unknown'} /></span>}>
      {job.error && <p className="memory-center-warning" role="status">{job.error}</p>}
      <dl className="memory-center-facts">
        <div><dt>阶段</dt><dd>{job.stageLabel}</dd></div>
        <div><dt>状态</dt><dd>{job.stateLabel}</dd></div>
        <div><dt>尝试</dt><dd>{memoryCountText(job.attempts)}</dd></div>
        <div><dt>更新时间</dt><dd>{job.updatedAt || '未记录'}</dd></div>
      </dl>
      <div className="memory-center-progress-grid">
        {([['total', '提案'], ['processed', '已处理'], ['published', '已发布'], ['candidates', '候选'], ['rejected', '已隔离'], ['pending', '待处理']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{job.proposals[key]}</dd></div>)}
      </div>
      <p className="hint">累计模型请求 {memoryCountText(job.budget.calls)} / {memoryCountText(job.budget.maxCalls)} · Token {job.budget.usageUnknown ? '含未确认用量' : memoryCountText(job.budget.tokens)} · 本批已保存提案进度，不证明全部知识已提取。</p>
      <details>
        <summary>源区间 · {job.sourceCount}</summary>
        {job.sourceRanges.length === 0 ? <p className="hint">该批次未记录源区间。</p> : <ul className="memory-center-source-list">{job.sourceRanges.map((range, index) => <li key={`${range}:${index}`}><code>{range}</code></li>)}</ul>}
      </details>
      {job.rejections.length > 0 && <details>
        <summary>候选与隔离原因 · {job.rejections.length}</summary>
        <ul className="memory-center-rejection-list">{job.rejections.map(item => <li key={item.id}><strong>{item.title}</strong><span>{item.reason}</span></li>)}</ul>
      </details>}
      <details><summary>批次与预算原始记录</summary><JsonView value={job} /></details>
      <div className="memory-center-record-actions">
        <button type="button" disabled={busy || !job.canRetry} onClick={() => void control('retry', job.id)}>重试本批</button>
      </div>
    </Card>)}
  </div>;
}

/* ------------------------------------------------------------------------- */
/* Graph                                                                     */
/* ------------------------------------------------------------------------- */

function GraphTab({ view, request, pending, report, openRecord }: TabBase) {
  const [controllerGraph, setControllerGraph] = useState<JsonObject | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState('all');
  const [scope, setScope] = useState('all');
  const [rootId, setRootId] = useState('');
  const [depth, setDepth] = useState(1);
  const [selectedNode, setSelectedNode] = useState('');
  const busy = Boolean(pending);

  const load = useCallback(async () => {
    try {
      const result = await request('graph', memoryGraphRequest({ rootId: rootId || undefined, depth, scope }));
      setControllerGraph(asObject(result));
      setError('');
    } catch (cause) {
      setControllerGraph(null);
      setError(`图谱接口暂不可用，展示由记录血缘派生的只读视图：${errorText(cause)}`);
    }
  }, [request, rootId, depth, scope]);

  useEffect(() => { void load(); }, [load]);

  const base = controllerGraph ? memoryGraphView(controllerGraph) : memoryGraphFromSnapshot(view, { rootId, kind, scope });
  const graph: GraphView = {
    ...base,
    nodes: base.nodes.filter(node => kind === 'all' || node.kind === kind),
  };
  const layout = useMemo(() => memoryGraphLayout(graph), [graph]);
  const nodeById = new Map(layout.nodes.map(node => [node.id, node]));

  const openNode = (id: string) => {
    setSelectedNode(id);
    const record = view.recordById.get(id);
    if (record) openRecord(id);
  };

  return <div className="memory-center-graph">
    {error && <Notice message={error} onClose={() => setError('')} error />}
    <Card title="图谱筛选" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => void load()}>刷新图谱</button>}>
      <div className="memory-center-filter-grid">
        <Field label="按类型"><select value={kind} aria-label="图谱按类型筛选" onChange={event => setKind(event.target.value)}><option value="all">全部类型</option>{MEMORY_KIND_IDS.map(kindId => <option key={kindId} value={kindId}>{memoryKindLabel(kindId)}</option>)}</select></Field>
        <Field label="按范围"><select value={scope} aria-label="图谱按范围筛选" onChange={event => setScope(event.target.value)}><option value="all">全部范围</option><option value="project">本项目</option><option value="personal">个人</option></select></Field>
        <Field label="展开根记录"><select value={rootId} aria-label="图谱展开根记录" onChange={event => { setRootId(event.target.value); setSelectedNode(''); }}><option value="">全部记录</option>{view.records.map(record => <option key={String(record.id)} value={String(record.id)}>{String(record.title)}</option>)}</select></Field>
        <Field label="展开深度"><select value={depth} aria-label="图谱展开深度" onChange={event => setDepth(Number(event.target.value) || 1)}><option value={1}>1 跳</option><option value={2}>2 跳</option></select></Field>
      </div>
      <p className="hint">点击节点或下方列表可回到记录；图谱只读展示 subject/relation/lineage，不引入图形库。深度最多 2 跳。</p>
    </Card>
    {graph.nodes.length === 0 ? <Empty title="暂无可视关系">{memoryCenterEmptyMessage('graph', view)}</Empty> : <Card title={`关系图 · ${graph.nodes.length} 个节点 / ${graph.edges.length} 条关系`} actions={<span className="hint">{graph.source === 'snapshot' ? '血缘派生视图' : '控制器图谱'}</span>}>
      <div className="memory-center-graph-scroll">
        <svg className="memory-center-graph-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`记忆关系图，共 ${layout.nodes.length} 个节点、${layout.edges.length} 条关系；下方列表提供可键盘访问的节点操作`}>
          {layout.edges.map((edge, index) => <g key={`edge:${index}`}>
            <line x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
            <text x={edge.labelX} y={edge.labelY}>{edge.label}</text>
          </g>)}
          {layout.nodes.map(node => <g key={node.id} className={`memory-center-graph-node ${node.kind} ${selectedNode === node.id ? 'is-selected' : ''}`} onClick={() => openNode(node.id)}>
            <circle cx={node.x} cy={node.y} r={node.radius} />
            <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="middle">{String(node.title).slice(0, 12)}</text>
          </g>)}
        </svg>
      </div>
      <ul className="memory-center-graph-list">{layout.nodes.map(node => <li key={node.id}>
        <button type="button" disabled={busy} aria-label={`打开节点 ${node.title}`} onClick={() => openNode(node.id)}>
          <strong>{node.title}</strong><small>{node.label}</small>
        </button>
      </li>)}</ul>
      {layout.edges.length > 0 && <details><summary>关系列表 · {layout.edges.length}</summary>
        <ul className="memory-center-graph-edges">{layout.edges.map((edge, index) => <li key={`list:${index}`}><button type="button" onClick={() => openNode(edge.from)}>{nodeById.get(edge.from)?.title || edge.from}</button><span>{edge.label}</span><button type="button" onClick={() => openNode(edge.to)}>{nodeById.get(edge.to)?.title || edge.to}</button></li>)}</ul>
      </details>}
      {selectedNode && <p className="hint">已选择节点 <code>{selectedNode}</code>；若记录仍在当前快照中，已同步到记录页。</p>}
    </Card>}
  </div>;
}

/* ------------------------------------------------------------------------- */
/* Usage diagnosis                                                           */
/* ------------------------------------------------------------------------- */

function UsageTab({ view, request, pending, report, openRecord }: TabBase) {
  const [usageRaw, setUsageRaw] = useState<JsonObject | null>(null);
  const [boundary, setBoundary] = useState('');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [explainRaw, setExplainRaw] = useState<JsonObject | null>(null);
  const [explainError, setExplainError] = useState('');
  const [explainLoading, setExplainLoading] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(true);
  const busy = Boolean(pending);

  const load = useCallback(async () => {
    try {
      const result = asObject(await request('diagnostics', memoryDiagnosticsRequest()));
      setUsageRaw(asObject(result.usage));
      setBoundary(String(result.recallBoundary || ''));
      setError('');
    } catch (cause) {
      setError(`诊断接口暂不可用：${errorText(cause)}`);
      setUsageRaw(null);
      try {
        const usage = asObject(await request('usage', {}));
        setUsageRaw(usage);
        setError(`诊断接口暂不可用，已读取用量收据：${errorText(cause)}`);
      } catch { /* keep the original error */ }
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  const usage: UsageView = useMemo(() => memoryUsageView({ ...(usageRaw || {}), runId: (usageRaw?.runId as string) || undefined }), [usageRaw]);
  const explain = useMemo(() => memoryExplainView(explainRaw || {}), [explainRaw]);

  const runExplain = async () => {
    setExplainLoading(true);
    setExplainError('');
    try {
      const result = await request('search.explain', memoryExplainRequest(query, { scope: scope as MemoryRecordsScope }));
      setExplainRaw(asObject(result));
    } catch (cause) {
      setExplainRaw(null);
      setExplainError(errorText(cause));
      report(errorText(cause), true);
    } finally { setExplainLoading(false); }
  };

  return <div className="memory-center-usage">
    {error && <Notice message={error} onClose={() => setError('')} error />}
    <Card title="召回与使用阶段" actions={<button type="button" className="memory-center-link" disabled={busy} onClick={() => void load()}>刷新收据</button>}>
      <p className="hint">{usage.recorded ? '五阶段分别计数：召回候选、注入上下文、请求准备、响应观察、工具读取。读取收据不代表模型采纳，也不代表答案正确。' : memoryCenterEmptyMessage('usage', view)}</p>
      {usage.recorded && <>
        <div className="memory-center-stage-grid">{usage.stages.map(stage => <div key={stage.id} className="memory-center-stage">
          <span>{stage.label}</span><strong>{stage.count}</strong><small>{stage.description} · 收据 {stage.receiptCount}</small>
        </div>)}</div>
        <p className="hint">工具正文读取 {usage.toolReads} 条 · 响应观察 {usage.responseObserved} 条 · 来源原文读取 {usage.sourceReads} 次 · 原始收据 {usage.rawReceipts} 条{usage.runId ? ` · 运行 ${usage.runId}` : ''}</p>
      </>}
      <p className="hint">{boundary || usage.boundary}</p>
      {usage.omissions.length > 0 ? <details open={feedbackOpen} onToggle={event => setFeedbackOpen(event.currentTarget.open)}>
        <summary>自动召回未入正文的原因 · {usage.omissions.length}</summary>
        <ul className="memory-center-rejection-list">{usage.omissions.map((item, index) => <li key={`${item.id}:${index}`}>
          <strong>{item.id}{item.revision !== undefined ? ` · v${item.revision}` : ''}</strong>
          <span>{item.label}</span>
          {item.readRef && <small>分页引用：{JSON.stringify(item.readRef)}</small>}
        </li>)}</ul>
      </details> : <p className="hint">没有记录到召回省略原因。没有收据不代表历史中没有相关内容。</p>}
      {usage.rawReceipts > 0 && <details><summary>原始收据</summary><JsonView value={usageRaw || {}} /></details>}
    </Card>
    <Card title="检索解释 · 为什么召回 / 为什么没召回">
      <form className="search-row" onSubmit={event => { event.preventDefault(); if (query.trim()) void runExplain(); }}>
        <input aria-label="检索解释关键词" placeholder="输入要解释的检索词" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="检索解释范围" value={scope} onChange={event => setScope(event.target.value)}><option value="all">全部</option><option value="project">本项目</option><option value="personal">个人</option></select>
        <button type="submit" disabled={busy || explainLoading || !query.trim()}>{explainLoading ? '解释中…' : '解释检索'}</button>
      </form>
      {explainError && <p className="memory-center-warning" role="alert">{explainError}</p>}
      {!explain.available && !explainError && <p className="hint">输入检索词后查看命中词、特征分与排除原因。</p>}
      {explain.available && <>
        <p className="hint">规则版本 {memoryCountText(explain.ruleVersion)} · 查询 {explain.queryId || '未记录'}{explain.intent ? ` · 意图 ${explain.intent}` : ''} · 命中词 {explain.terms.length ? explain.terms.join('、') : '未记录'}</p>
        {explain.terms.length > 0 && <div className="memory-center-terms">{explain.terms.map(term => <span key={term}>{term}</span>)}</div>}
        {explain.empty ? <Empty title="零命中">{explain.guidance}</Empty> : <ul className="memory-center-explain-list">{explain.matches.map(match => <li key={`${match.id}:${match.revision}`}>
          <div className="memory-center-record-head"><button type="button" className="memory-center-link" onClick={() => openRecord(match.id)}>{String(view.recordById.get(match.id)?.title || match.id)}</button><span className="hint">v{memoryCountText(match.revision)} · 综合分 {memoryCountText(match.score)}</span></div>
          {match.matchedTerms.length > 0 && <p className="hint">命中词：{match.matchedTerms.join('、')}</p>}
          {match.fields.length > 0 && <p className="hint">命名字段：{match.fields.map(field => `${field.field}（${field.terms.join('、')}）`).join('；')}</p>}
          {match.features.length > 0 && <dl className="memory-center-features">{match.features.map(feature => <div key={feature.key}><dt>{feature.label}</dt><dd>{feature.value}</dd></div>)}</dl>}
          {match.reasons.length > 0 && <p className="hint">排序原因：{match.reasons.join('；')}</p>}
        </li>)}</ul>}
        {explain.excluded.length > 0 && <details><summary>未召回原因 · {explain.excluded.length}</summary><ul className="memory-center-rejection-list">{explain.excluded.map((item, index) => <li key={`${item.id}:${index}`}><strong>{item.id || '记录'}</strong><span>{item.label}</span></li>)}</ul></details>}
        {explain.guidance && <p className="hint">{explain.guidance}</p>}
        <p className="hint">{explain.note}</p>
      </>}
    </Card>
  </div>;
}

type MemoryRecordsScope = 'all' | 'project' | 'personal';

/* ------------------------------------------------------------------------- */
/* Settings                                                                  */
/* ------------------------------------------------------------------------- */

function SettingsTab({ view, sessionId, request, perform, pending, report, refresh, openRecord }: TabBase) {
  const [status, setStatus] = useState<JsonObject | null>(null);
  const [statusError, setStatusError] = useState('');
  const [mode, setMode] = useState<string>(view.autoPublish.policy.mode || 'standard');
  const [minScore, setMinScore] = useState<string>(view.autoPublish.policy.minScore !== undefined ? String(view.autoPublish.policy.minScore) : '70');
  const [maxAutoPerDay, setMaxAutoPerDay] = useState<string>(view.autoPublish.policy.maxAutoPerDay !== undefined ? String(view.autoPublish.policy.maxAutoPerDay) : '100');
  const [requireReview, setRequireReview] = useState<boolean>(view.autoPublish.policy.requireReview);
  const [saveError, setSaveError] = useState('');
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [notice, setNotice] = useState('');
  const [revoke, setRevoke] = useState<{ ids: string[]; reason: string; batchKey: string } | null>(null);
  const busy = Boolean(pending);

  const loadStatus = useCallback(async () => {
    try {
      const result = asObject(await request('autoPublish.status', {}));
      setStatus(result);
      setStatusError('');
      const policy = memoryAutoPublishView(result).policy;
      if (policy.available) {
        setMode(policy.mode);
        if (policy.minScore !== undefined) setMinScore(String(policy.minScore));
        if (policy.maxAutoPerDay !== undefined) setMaxAutoPerDay(String(policy.maxAutoPerDay));
        setRequireReview(policy.requireReview);
      }
    } catch (cause) {
      setStatus(null);
      setStatusError(`自动发布策略读取失败：${errorText(cause)}`);
    }
  }, [request]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const autoPublish = useMemo(() => memoryAutoPublishView(status || view.autoPublish), [status, view]);
  const audit = useMemo(() => memoryAuditView(autoPublish.audit), [autoPublish.audit]);
  const kindPolicies = useMemo(() => memoryKindPolicyRows(status || view), [status, view]);
  const [selectedAudit, setSelectedAudit] = useState<string[]>([]);

  const savePolicy = async () => {
    setSaveError('');
    try {
      const input = memoryAutoPublishSettingsInput(autoPublish, {
        mode,
        minScore: Number(minScore),
        maxAutoPerDay: Number(maxAutoPerDay),
        requireReview,
      });
      await perform('autoPublish.settings', input, '自动发布策略已保存。');
      await loadStatus();
    } catch (error) {
      setSaveError(errorText(error));
      report(errorText(error), true);
    }
  };

  const runRevoke = async () => {
    if (!revoke) return;
    try {
      const input = memoryAutoPublishRevokeInput({ ids: revoke.ids.length ? revoke.ids : undefined, batchKey: revoke.batchKey || undefined, reason: revoke.reason }, audit);
      await perform('autoPublish.revoke', input, '已撤销所选自动发布并写入审计。');
      setRevoke(null);
      setSelectedAudit([]);
      await loadStatus();
      await refresh();
    } catch (error) {
      report(errorText(error), true);
    }
  };

  const runImport = async () => {
    setImportError('');
    try {
      const input = memoryImportInput(importText);
      const result = asObject(await perform('import', input, '导入完成；记录一律为候选，不自动生效。'));
      setImportText('');
      setNotice(`已导入 ${asList(result.records).length || (input.records as unknown[]).length} 条记录为候选。`);
      await refresh();
    } catch (error) {
      setImportError(errorText(error));
    }
  };

  const exported = async () => {
    try {
      const result = asObject(await perform('export', memoryExportInput(), ''));
      report(`已导出：${String(result.path || '')}（${String(result.count ?? '?')} 条）`);
    } catch { /* reported by perform */ }
  };

  const batchKeys = [...new Set(audit.map(row => row.batchKey).filter((value): value is string => typeof value === 'string' && value.length > 0))];

  return <div className="memory-center-settings">
    {statusError && <Notice message={statusError} onClose={() => setStatusError('')} error />}
    <Card title="自动发布策略" actions={<span className="hint">{autoPublish.available ? `${autoPublish.policy.modeLabel} · 版本 v${memoryCountText(autoPublish.policy.version)}` : '策略未读取'}</span>}>
      <div className="memory-center-mode-grid" role="radiogroup" aria-label="自动发布模式">
        {AUTO_PUBLISH_MODES.map(option => <button type="button" role="radio" key={option.id} aria-checked={mode === option.id} disabled={busy || !autoPublish.available} onClick={() => setMode(option.id)}>
          <strong>{option.label}</strong><small>{option.description}</small>
        </button>)}
      </div>
      <div className="memory-center-filter-grid">
        <Field label="置信阈值（0-100）"><input type="number" min={0} max={100} value={minScore} disabled={busy} onChange={event => setMinScore(event.target.value)} /></Field>
        <Field label="每日自动发布上限"><input type="number" min={0} max={10000} value={maxAutoPerDay} disabled={busy} onChange={event => setMaxAutoPerDay(event.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={requireReview} disabled={busy} onChange={event => setRequireReview(event.target.checked)} />自动发布前必须人工复核</label>
      </div>
      {autoPublish.available && <p className="hint">策略版本 v{memoryCountText(autoPublish.policy.version)} · 更新于 {autoPublish.policy.updatedAt || '未记录'}。保存使用版本 CAS，过期会要求刷新后重试。</p>}
      {saveError && <p className="memory-center-warning" role="alert">{saveError}</p>}
      <div className="memory-center-record-actions">
        <button type="button" className="primary" disabled={busy || !autoPublish.available} onClick={() => void savePolicy()}>保存策略</button>
        <button type="button" disabled={busy} onClick={() => void loadStatus()}>刷新策略</button>
      </div>
      <dl className="memory-center-facts">
        <div><dt>已自动发布</dt><dd>{memoryCountText(autoPublish.stats.autoPublished)}</dd></div>
        <div><dt>已撤销</dt><dd>{memoryCountText(autoPublish.stats.revoked)}</dd></div>
        <div><dt>已更正</dt><dd>{memoryCountText(autoPublish.stats.corrected)}</dd></div>
      </dl>
    </Card>

    <Card title="自动发布审计与撤销" actions={<span className="hint">撤销前必须选择明确范围</span>}>
      {audit.length === 0 ? <Empty title="暂无自动发布审计" /> : <>
        <div className="memory-center-table-scroll"><table className="memory-center-table">
          <caption className="memory-center-visually-hidden">自动发布审计记录</caption>
          <thead><tr><th scope="col">选择</th><th scope="col">时间</th><th scope="col">操作</th><th scope="col">记录</th><th scope="col">分数</th><th scope="col">门禁</th><th scope="col">策略</th><th scope="col">信任</th><th scope="col">状态</th></tr></thead>
          <tbody>{audit.map(row => <tr key={row.id}>
            <td><input type="checkbox" aria-label={`选择审计 ${row.id}`} checked={selectedAudit.includes(row.id)} disabled={busy || !row.revocable} onChange={event => setSelectedAudit(previous => event.target.checked ? [...new Set([...previous, row.id])] : previous.filter(value => value !== row.id))} /></td>
            <td>{row.createdAt || '未记录'}</td>
            <td>{row.actionLabel}</td>
            <td><button type="button" className="memory-center-link" disabled={busy || !row.memoryId} onClick={() => row.memoryId && openRecord(row.memoryId)}>{row.memoryId || '未记录'}</button></td>
            <td>{memoryCountText(row.score)}</td>
            <td>{row.gatesSummary}</td>
            <td>v{memoryCountText(row.policyVersion)} · {row.modeLabel}</td>
            <td>{row.trustLabel}</td>
            <td>{row.revoked ? `已撤销${row.revokeReason ? `：${row.revokeReason}` : ''}` : row.revocable ? '可撤销' : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        {selectedAudit.length > 0 && <div className="memory-center-bulk" role="region" aria-label="撤销自动发布">
          <span>已选择 {selectedAudit.length} 条</span>
          <button type="button" disabled={busy} onClick={() => setRevoke({ ids: selectedAudit, reason: '', batchKey: '' })}>撤销所选</button>
          <button type="button" disabled={busy} onClick={() => setSelectedAudit([])}>取消选择</button>
        </div>}
        {batchKeys.length > 0 && <div className="memory-center-batch-list" role="group" aria-label="按批次撤销">
          <span>按批撤销：</span>
          {batchKeys.map(batchKey => <button type="button" key={batchKey} disabled={busy} onClick={() => setRevoke({ ids: [], reason: '', batchKey })}>{batchKey.slice(0, 16)}</button>)}
        </div>}
        {revoke && <section className="memory-center-inline-confirm" aria-label="确认撤销自动发布">
          <p>将撤销 {revoke.ids.length ? `${revoke.ids.length} 条所选审计` : `批次 ${revoke.batchKey}`}。撤销会停用对应自动发布记录并使其派生内容失效，操作会写入审计且可回滚（rollbackToken）。</p>
          <Field label="撤销原因（写入审计）"><input value={revoke.reason} onChange={event => setRevoke({ ...revoke, reason: event.target.value })} /></Field>
          <div className="button-row"><button type="button" className="danger" disabled={busy} onClick={() => void runRevoke()}>确认撤销</button><button type="button" disabled={busy} onClick={() => setRevoke(null)}>取消</button></div>
        </section>}
      </>}
      {notice && <Notice message={notice} onClose={() => setNotice('')} />}
    </Card>

    <Card title="置顶记忆" actions={<span className="hint">稳定前缀上限 {PINNED_CHAR_LIMIT} 字符</span>}>
      <BudgetBar used={view.pinned.used} limit={view.pinned.limit} label="置顶字符预算" />
      {view.pinned.records.length === 0 ? <p className="hint">{view.pinned.available ? '暂无置顶记忆。' : '置顶接口尚未接线；预算与置顶列表暂不可用。'}</p> : <ul className="memory-center-pinned-list">{view.pinned.records.map(record => <li key={String(record.id)}>
        <button type="button" className="memory-center-link" disabled={busy} onClick={() => openRecord(String(record.id))}>{String(record.title)}</button>
        <small>{memoryPinnedChars(record)} 字符 · 置顶后优先进入稳定前缀</small>
        <button type="button" className="danger-text" disabled={busy} onClick={() => void perform('unpin', { id: String(record.id), expectedRevision: Number(record.revision) }, '已取消置顶。').then(() => refresh()).catch(() => {})}>取消置顶</button>
      </li>)}</ul>}
      {view.pinned.unresolved > 0 && <p className="memory-center-warning">{view.pinned.unresolved} 条置顶记录不在当前快照中，请刷新核对。</p>}
    </Card>

    <Card title="导入 / 导出">
      <div className="memory-center-columns">
        <section>
          <h4>导出</h4>
          <p className="hint">导出当前项目生效记忆为 Markdown（含 ID、版本、范围、来源）。</p>
          <button type="button" disabled={busy} onClick={() => void exported()}>导出 Markdown</button>
        </section>
        <section>
          <h4>导入</h4>
          <p className="hint">粘贴记录数组或 {'{"records":[...]}'}。导入记录一律为候选并停用，来源与权限由控制器校验，不会自动生效；模型声称的 trust/score 会被移除。</p>
          <Field label="导入 JSON"><textarea rows={5} className="mono" value={importText} onChange={event => { setImportText(event.target.value); setImportError(''); }} placeholder='[{"title":"...","content":"..."}]' /></Field>
          {importError && <p className="memory-center-warning" role="alert">{importError}</p>}
          <button type="button" disabled={busy || !importText.trim()} onClick={() => void runImport()}>导入为候选</button>
        </section>
      </div>
    </Card>

    <Card title="类型策略（只读）">
      {kindPolicies.length === 0 ? <p className="hint">类型策略由 P1 kind policy 提供；当前快照未包含策略明细，因此只读展示不可用。7 类记忆的默认标签仍在上方计数中展示。</p> : <div className="memory-center-table-scroll"><table className="memory-center-table">
        <caption className="memory-center-visually-hidden">记忆类型策略</caption>
        <thead><tr><th scope="col">类型</th><th scope="col">范围</th><th scope="col">权威</th><th scope="col">TTL</th><th scope="col">复审</th><th scope="col">可置顶</th><th scope="col">需条件</th></tr></thead>
        <tbody>{kindPolicies.map(row => <tr key={row.kind}><th scope="row">{row.label}</th><td>{row.scopes.map(scopeId => memoryScopeLabel(scopeId)).join('、') || '未记录'}</td><td>{row.authority || '未记录'}</td><td>{memoryCountText(row.ttlDays)} 天</td><td>{memoryCountText(row.reviewAfterDays)} 天</td><td>{row.pinnedEligible === undefined ? '未记录' : row.pinnedEligible ? '是' : '否'}</td><td>{row.conditionsRequired === undefined ? '未记录' : row.conditionsRequired ? '是' : '否'}</td></tr>)}</tbody>
      </table></div>}
      <p className="hint">类型策略当前只读；如需调整请在 P1 controller 配置中修改，UI 不直接写入策略。</p>
    </Card>
  </div>;
}

/* ------------------------------------------------------------------------- */
/* Root                                                                      */
/* ------------------------------------------------------------------------- */

export function MemoryCenter({ sessionId, goal, report, onClose, initialTab = 'overview', className = '' }: MemoryCenterProps) {
  const [tab, setTab] = useState<MemoryCenterTabId>(initialTab);
  const [snapshot, setSnapshot] = useState<JsonObject>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [focusRecord, setFocusRecord] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const previousFocus = useRef<HTMLElement | null>(null);
  const tabRefs = useRef(new Map<MemoryCenterTabId, HTMLButtonElement>());
  const mounted = useRef(true);
  const generation = useRef(0);

  const request = useCallback(<T,>(action: string, input: JsonObject = {}) => window.friendPi.request<T>('plugin.call', { sessionId, plugin: 'memory', action, input }), [sessionId]);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const next = asObject(await request('snapshot'));
    if (!mounted.current || current !== generation.current) return;
    setSnapshot(next);
    setError('');
  }, [request]);

  const perform = useCallback(async <T,>(action: string, input: JsonObject = {}, success?: string) => {
    setPending(action);
    try {
      const result = await request<T>(action, input);
      await refresh();
      if (success && mounted.current) setNotice(success);
      return result;
    } catch (failure) {
      const text = errorText(failure);
      if (mounted.current) { setNotice(text); setError(''); }
      report(text, true);
      throw failure;
    } finally {
      if (mounted.current) setPending('');
    }
  }, [request, refresh, report]);

  useEffect(() => {
    mounted.current = true;
    previousFocus.current = document.activeElement as HTMLElement | null;
    setLoading(true);
    void refresh().catch(cause => { if (mounted.current) setError(errorText(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => {
      mounted.current = false;
      generation.current++;
      previousFocus.current?.focus?.();
    };
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = window.friendPi.onEvent(event => {
      if (event.type !== 'plugin') return;
      if (event.sessionId && event.sessionId !== sessionId) return;
      const data = asObject(event.data);
      if (!String(data.pluginEvent || '').startsWith('memory.')) return;
      const payload = asObject(data.data);
      if (Array.isArray(data.data) || (Array.isArray(payload.memories) || Array.isArray(payload.candidates))) { setSnapshot(payload); return; }
      void refresh().catch(() => {});
    });
    return unsubscribe;
  }, [refresh, sessionId]);

  useEffect(() => {
    requestAnimationFrame(() => tabRefs.current.get(tab)?.focus());
    // Focus the active tab on open; do not steal focus on every tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useMemo(() => memoryCenterSnapshotView(snapshot), [snapshot]);
  const dataState = useMemo(() => memoryCenterDataState({ loading, error, snapshot }), [loading, error, snapshot]);
  const openTab = (next: MemoryCenterTabId) => { setTab(next); setNotice(''); };
  const openRecord = (id: string) => { setFocusRecord(id); setTab('records'); };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || [])].filter(control => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? MEMORY_CENTER_TAB_IDS[0] : event.key === 'End' ? MEMORY_CENTER_TAB_IDS[MEMORY_CENTER_TAB_IDS.length - 1] : memoryCenterTabNeighbor(tab, event.key === 'ArrowRight' ? 1 : -1);
    openTab(next);
    requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
  };

  const base: TabBase = {
    sessionId,
    goal,
    view,
    pending,
    request,
    perform,
    refresh,
    report,
    openRecord,
    openTab,
    focusId: focusRecord,
  };
  const tabLabel = memoryCenterTabLabel(tab);
  const panelId = `memory-center-panel-${tab}`;

  return createPortal(<div className="memory-center-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className={`memory-center ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown}>
      <header className="memory-center-heading">
        <div>
          <h2 id={titleId}>记忆中心</h2>
          <p>九页签核对记录的来源、条件、候选门禁、冲突、复审、学习、图谱与用量；写操作都需要用户确认。</p>
        </div>
        <div className="memory-center-heading-actions">
          <button type="button" disabled={loading || Boolean(pending)} onClick={() => { setLoading(false); void refresh().catch(cause => { setError(errorText(cause)); report(errorText(cause), true); }); }}>{loading ? '读取中…' : '刷新'}</button>
          <button type="button" className="memory-center-close" aria-label="关闭记忆中心" onClick={onClose}>×</button>
        </div>
      </header>
      <nav className="memory-center-tabs" role="tablist" aria-label="记忆中心页签" onKeyDown={onTabKeyDown}>
        {MEMORY_CENTER_TABS.map(item => {
          const badge = memoryCenterTabBadge(item.id, view);
          return <button type="button" role="tab" key={item.id} id={`memory-center-tab-${item.id}`} ref={element => { if (element) tabRefs.current.set(item.id, element); else tabRefs.current.delete(item.id); }} aria-selected={tab === item.id} aria-controls={tab === item.id ? `memory-center-panel-${item.id}` : undefined} tabIndex={tab === item.id ? 0 : -1} title={item.description} onClick={() => openTab(item.id)}>
            {item.label}{badge !== undefined ? <span className="memory-center-tab-badge" aria-label={`${badge} 项`}>{badge}</span> : null}
          </button>;
        })}
      </nav>
      <div className="memory-center-body" id={panelId} role="tabpanel" aria-labelledby={`memory-center-tab-${tab}`}>
        {notice && <Notice message={notice} onClose={() => setNotice('')} />}
        {dataState.kind === 'loading' && <p className="memory-center-loading" role="status">正在读取记忆中心…</p>}
        {dataState.kind === 'error' && <div className="memory-center-error" role="alert">
          <strong>记忆中心读取失败</strong>
          <p>{dataState.message}</p>
          <p className="hint">{memoryCenterErrorHint(dataState.message)}</p>
          <button type="button" onClick={() => { setLoading(true); setError(''); void refresh().catch(cause => setError(errorText(cause))).finally(() => setLoading(false)); }}>重新读取</button>
        </div>}
        {dataState.kind !== 'loading' && dataState.kind !== 'error' && (!view.hasSnapshot
          ? <Empty title={memoryCenterEmptyMessage(tab, view)} />
          : <>
            {tab === 'overview' && <OverviewTab {...base} />}
            {tab === 'records' && <RecordsTab key="records" {...base} />}
            {tab === 'candidates' && <CandidatesTab {...base} />}
            {tab === 'conflicts' && <ConflictsTab {...base} />}
            {tab === 'reviews' && <ReviewsTab {...base} />}
            {tab === 'learning' && <LearningTab {...base} />}
            {tab === 'graph' && <GraphTab {...base} />}
            {tab === 'usage' && <UsageTab {...base} />}
            {tab === 'settings' && <SettingsTab {...base} />}
          </>)}
      </div>
      <footer className="memory-center-footer">
        <span>当前页签：{tabLabel} · 候选不会显示为生效 · 命中不等于权威</span>
        <span>{view.epoch !== undefined ? `epoch ${view.epoch}` : 'epoch 未记录'}{view.schemaVersion !== undefined ? ` · schema v${view.schemaVersion}` : ''}{pending ? ` · 正在处理 ${pending}` : ''}</span>
      </footer>
    </section>
  </div>, document.body);
}

