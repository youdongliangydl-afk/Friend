/**
 * Memory Center view models — pure functions only (no React, no DOM).
 *
 * The Memory Center talks to the Memory plugin controller through the renderer
 * bridge: `window.friendPi.request('plugin.call',{sessionId,plugin:'memory',action,input})`.
 * sdk-worker forwards that to the plugin as `origin:'user'` (see apps/desktop/src/sdk-worker.ts
 * `method==='plugin'`), so the actions listed in MEMORY_CENTER_ACTIONS are user-origin actions.
 *
 * Everything here is defensive about snapshot shapes: P1/P2 add fields (pinned, reviews,
 * graph, explain features, kind policies) on top of the P0 snapshot. A missing field must
 * degrade to an explicit "未提供/未记录" state, never to a fabricated zero or an "active"
 * claim. Candidates are NEVER reported as active — see memoryRecordIsActive and
 * memoryCandidateView.
 */
import { asList, asObject, type JsonObject } from './types.js';
import { memoryImpactChanged, memoryImpactMutation, memorySummary } from './memory-view.js';

/* ------------------------------------------------------------------------- */
/* Tabs                                                                      */
/* ------------------------------------------------------------------------- */

export type MemoryCenterTabId =
  | 'overview'
  | 'records'
  | 'candidates'
  | 'conflicts'
  | 'reviews'
  | 'learning'
  | 'graph'
  | 'usage'
  | 'settings';

export interface MemoryCenterTab {
  id: MemoryCenterTabId;
  label: string;
  description: string;
}

/** Exact nine tabs, in product order (spec §3 / blueprint §15). */
export const MEMORY_CENTER_TABS: readonly MemoryCenterTab[] = [
  { id: 'overview', label: '概览', description: '类型、范围、状态计数与需要处理的问题' },
  { id: 'records', label: '记录', description: '筛选、搜索、详情、版本、来源与反馈' },
  { id: 'candidates', label: '候选', description: '按学习批次分组，查看门禁明细并接受或拒绝' },
  { id: 'conflicts', label: '冲突', description: '同主题不同值并列核对并裁决' },
  { id: 'reviews', label: '复审', description: '按优先级处理到期复审' },
  { id: 'learning', label: '学习', description: '后台学习批次、预算、提案与源区间' },
  { id: 'graph', label: '图谱', description: '主题、关系与血缘的只读视图' },
  { id: 'usage', label: '用量诊断', description: '召回收据阶段计数与检索解释' },
  { id: 'settings', label: '设置', description: '自动发布策略、置顶预算、审计与导入导出' },
];

export const MEMORY_CENTER_TAB_IDS: readonly MemoryCenterTabId[] = MEMORY_CENTER_TABS.map(tab => tab.id);

export function memoryCenterTab(id: unknown): MemoryCenterTab | undefined {
  return MEMORY_CENTER_TABS.find(tab => tab.id === id);
}

/** Arrow-key tab navigation (wraps at both ends). */
export function memoryCenterTabNeighbor(id: MemoryCenterTabId, delta: number): MemoryCenterTabId {
  const index = MEMORY_CENTER_TAB_IDS.indexOf(id);
  const size = MEMORY_CENTER_TAB_IDS.length;
  if (index < 0) return MEMORY_CENTER_TAB_IDS[0];
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return MEMORY_CENTER_TAB_IDS[(((index + step) % size) + size) % size];
}

/* ------------------------------------------------------------------------- */
/* Labels and constants                                                      */
/* ------------------------------------------------------------------------- */

export const MEMORY_KIND_LABELS: Record<string, string> = {
  profile: '画像',
  preference: '偏好',
  fact: '事实',
  experience: '经验',
  episode: '情节',
  task: '任务',
  knowledge: '知识',
  method: '旧方法',
};

export const MEMORY_KIND_IDS = ['profile', 'preference', 'fact', 'experience', 'episode', 'task', 'knowledge'] as const;

export const MEMORY_SCOPE_LABELS: Record<string, string> = { project: '本项目', personal: '个人' };

export const MEMORY_STATUS_LABELS: Record<string, string> = {
  active: '生效',
  candidate: '候选',
  inactive: '已停用',
  invalidated: '来源已失效',
};

export type MemoryTone = 'active' | 'candidate' | 'inactive' | 'invalidated';

export const MEMORY_TRUST_LABELS: Record<string, string> = {
  user_explicit: '用户明确',
  user_confirmed: '用户确认',
  source_verified: '来源核验',
  tool_verified: '工具核验',
  quote_verified: '引文核验',
  model_supported: '模型支持',
  model_inferred: '模型推断',
  external_import: '外部导入',
};

export const MEMORY_AUTHORITY_LABELS: Record<string, string> = {
  user: '用户',
  source: '来源',
  tool: '工具',
  model: '模型',
  external: '外部',
  none: '无',
};

export const PINNED_CHAR_LIMIT = 1500;

export interface ModeOption {
  id: string;
  label: string;
  description: string;
}

export const AUTO_PUBLISH_MODES: readonly ModeOption[] = [
  { id: 'off', label: '关闭', description: '不自动发布；全部进入候选，由用户确认' },
  { id: 'conservative', label: '保守', description: '仅用户明确/确认的内容可按分数自动发布' },
  { id: 'standard', label: '标准', description: '来源与工具核验的事实/经验可按门禁发布' },
  { id: 'aggressive', label: '积极', description: '更多类型允许自动发布；跨项目与安全门禁仍生效' },
];

export const AUTO_PUBLISH_MODE_LABELS: Record<string, string> = Object.fromEntries(AUTO_PUBLISH_MODES.map(mode => [mode.id, mode.label]));

export const AUTO_PUBLISH_GATE_LABELS: Record<number, string> = {
  1: '权威',
  2: '逐字引文',
  3: '主题',
  4: '安全',
  5: '类型',
  6: '置信分',
  7: '新颖性',
  8: '用户策略',
  9: '跨项目',
  10: '运行时',
};

export const REVIEW_REASON_LABELS: Record<string, string> = {
  expired: '已过期',
  'review-after': '到期复核',
  'low-use': '长期未使用',
  'negative-feedback': '负向反馈',
  'autopublish-sample': '自动发布抽样',
  'conflict-open': '冲突待裁决',
  'dream-proposal': '巩固提案',
  'stale-source': '来源已变化',
};

export const REVIEW_RESOLUTION_LABELS: Record<string, string> = {
  confirm: '确认',
  correct: '更正',
  merge: '合并',
  split: '拆分',
  disable: '停用',
  forget: '遗忘',
  defer: '稍后',
};

export type ConflictResolution = 'keep_left' | 'keep_right' | 'merge' | 'both' | 'neither' | 'defer';

export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] = ['keep_left', 'keep_right', 'merge', 'both', 'neither', 'defer'];

export const CONFLICT_RESOLUTION_LABELS: Record<string, string> = {
  keep_left: '保留左侧',
  keep_right: '保留右侧',
  merge: '合并为一条',
  both: '两侧都保留',
  neither: '两侧都不适用',
  defer: '稍后处理',
};

export const LEARNING_STAGE_LABELS: Record<string, string> = {
  extract: '提取来源',
  validate: '核对提案',
  publish: '发布记忆',
  compact: '可选整理',
  reflection: '旧版提取',
  dream: '旧版整理',
  consolidate: '巩固整理',
  review: '复审抽样',
};

export const EXPLAIN_FEATURE_ORDER: readonly string[] = [
  'intentType',
  'exact',
  'subjectMatch',
  'bm25',
  'taskContextMatch',
  'feedbackScore',
  'scopePrecedence',
  'trust',
  'recency',
  'conflict',
  'stale',
  'duplicate',
  'recallWeight',
  'decay',
  'pinned',
];

export const EXPLAIN_FEATURE_LABELS: Record<string, string> = {
  intentType: '意图类型',
  exact: '精确匹配',
  subjectMatch: '主题匹配',
  bm25: 'BM25',
  taskContextMatch: '任务上下文',
  feedbackScore: '反馈',
  scopePrecedence: '范围优先',
  trust: '信任层级',
  recency: '时间新近',
  conflict: '冲突扣分',
  stale: '过时扣分',
  duplicate: '重复扣分',
  recallWeight: '类型权重',
  decay: '衰减',
  pinned: '置顶',
};

export const EXPLAIN_EXCLUDED_LABELS: Record<string, string> = {
  scope: '不属于当前范围',
  inactive: '未生效或已停用',
  validity: '不在有效期内',
  conflict: '存在待裁决冲突',
  secret: '包含已脱敏内容',
  'source-unavailable': '来源不可用',
  'artifact-unavailable': '产物来源不可用',
  'personal-source': '个人来源授权不足',
  'legacy-method': '旧方法不参与召回',
  expired: '已过期',
  stale: '已过时',
  forgotten: '已遗忘',
  duplicate: '与已选内容重复',
  'body-budget': '正文与完整条件超出预算',
  'directory-budget': '目录超出预算',
  'record-limit': '本轮正文条数已满',
  'preference-applicability-unknown': '长期偏好的适用范围待核对',
};

export const GRAPH_EDGE_LABELS: Record<string, string> = {
  'parent-child': '父子派生',
  'same-subject': '同主题',
  'derived-from': '派生自',
  related: '相关',
  supersedes: '替代',
  'split-from': '拆分自',
  contradicts: '冲突',
};

/* ------------------------------------------------------------------------- */
/* Small normalizers                                                         */
/* ------------------------------------------------------------------------- */

const object = (value: unknown): JsonObject => asObject(value) as JsonObject;
const objects = (value: unknown): JsonObject[] => asList<unknown>(value).map(object);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const integer = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined);
const truth = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const numericList = (value: unknown): number[] => (Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : []);

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const valueAt = Date.parse(value);
  return Number.isFinite(valueAt) ? valueAt : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------------- */
/* Record state and safety                                                   */
/* ------------------------------------------------------------------------- */

/** A record may only be called "生效" (active) when every gate agrees. Candidates never qualify. */
export function memoryRecordIsActive(record: unknown): boolean {
  const value = object(record);
  return text(value.status) === 'active' && value.enabled !== false && !text(value.invalidatedReason);
}

export function memoryRecordStatusTone(record: unknown): MemoryTone {
  const status = text(object(record).status);
  if (status === 'candidate') return 'candidate';
  if (status === 'invalidated') return 'invalidated';
  if (status === 'inactive') return 'inactive';
  return memoryRecordIsActive(record) ? 'active' : 'inactive';
}

export function memoryKindLabel(kind: unknown): string {
  const value = text(kind);
  if (!value) return '未记录类型';
  return MEMORY_KIND_LABELS[value] || `未知类型 ${value}`;
}

export function memoryScopeLabel(scope: unknown): string {
  const value = text(scope);
  if (!value) return '未记录范围';
  return MEMORY_SCOPE_LABELS[value] || value;
}

export function memoryStatusLabel(status: unknown): string {
  const value = text(status);
  if (!value) return '状态未记录';
  return MEMORY_STATUS_LABELS[value] || `未知状态 ${value}`;
}

export function memoryTrustLabel(trust: unknown): string {
  const value = text(trust);
  return value ? MEMORY_TRUST_LABELS[value] || value : '信任未记录';
}

export function memoryAuthorityLabel(authority: unknown): string {
  const value = text(authority);
  return value ? MEMORY_AUTHORITY_LABELS[value] || value : '权威来源未记录';
}

export interface RecordStateView {
  status: string;
  label: string;
  tone: MemoryTone;
  active: boolean;
  safety: string;
  pinned: boolean;
  autoPublished: boolean;
}

/** UI-facing state badge. A candidate is rendered as 候选（未生效） and marked active:false. */
export function memoryRecordStateView(record: unknown): RecordStateView {
  const value = object(record);
  const status = text(value.status);
  const active = memoryRecordIsActive(value);
  const safety = status === 'candidate'
    ? '候选未采用：不参与召回，也不能当作已生效记忆。'
    : status === 'invalidated'
      ? '来源已失效：不会参与召回，需核对后再决定。'
      : status === 'inactive'
        ? '已停用：不会参与召回。'
        : active
          ? '当前生效：可被检索，结论仍受来源与条件约束。'
          : '记录状态未完整确认，不作为生效记忆。';
  return {
    status: status || 'unknown',
    label: status === 'candidate' ? `${MEMORY_STATUS_LABELS.candidate}（未生效）` : memoryStatusLabel(status),
    tone: memoryRecordStatusTone(value),
    active,
    safety,
    pinned: value.pinned === true,
    autoPublished: value.autoPublished === true,
  };
}

/* ------------------------------------------------------------------------- */
/* Snapshot view                                                             */
/* ------------------------------------------------------------------------- */

export interface CountRow {
  key: string;
  label: string;
  total: number;
}

export interface KindCountRow extends CountRow {
  kind: string;
  active: number;
  candidate: number;
}

export interface ProblemShortcut {
  id: string;
  label: string;
  count: number;
  tab: MemoryCenterTabId;
  tone: 'warning' | 'info';
}

export interface BudgetRow {
  id: string;
  label: string;
  used: number | undefined;
  limit: number | undefined;
  unit: string;
  over: boolean;
  available: boolean;
}

export interface PinnedView {
  available: boolean;
  ids: string[];
  records: JsonObject[];
  used: number;
  limit: number;
  remaining: number;
  overBudget: boolean;
  unresolved: number;
}

export interface LearningQueueView {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  queued: number;
  failed: number;
  completed: number;
  jobs: JsonObject[];
  calls: number | undefined;
  maxCalls: number | undefined;
  tokens: number | undefined;
  usageUnknown: boolean;
}

export interface ReviewItemView {
  id: string;
  memoryId: string;
  revision: number | undefined;
  reason: string;
  reasonLabel: string;
  priority: number;
  dueAt: string;
  overdue: boolean;
  notes: string;
  status: string;
  record: JsonObject | undefined;
  recordTitle: string;
}

export interface AutoPublishPolicyView {
  available: boolean;
  id: string;
  mode: string;
  modeLabel: string;
  minScore: number | undefined;
  maxAutoPerDay: number | undefined;
  requireReview: boolean;
  version: number | undefined;
  updatedAt: string;
}

export interface AutoPublishView {
  available: boolean;
  policy: AutoPublishPolicyView;
  stats: { autoPublished: number | undefined; revoked: number | undefined; corrected: number | undefined };
  audit: JsonObject[];
}

export interface MemoryCenterSnapshotView {
  hasSnapshot: boolean;
  epoch: number | undefined;
  schemaVersion: number | undefined;
  records: JsonObject[];
  candidates: JsonObject[];
  allRecords: JsonObject[];
  recordById: Map<string, JsonObject>;
  counts: { total: number; active: number; candidate: number; inactive: number; invalidated: number };
  byKind: KindCountRow[];
  byScope: CountRow[];
  byStatus: CountRow[];
  conflicts: JsonObject[];
  openConflicts: JsonObject[];
  reviews: ReviewItemView[];
  reviewsDue: number;
  reviewSummary: { available: boolean; open: number; deferred: number; resolved: number; overdue: number };
  learning: LearningQueueView;
  autoPublish: AutoPublishView;
  pinned: PinnedView;
  problems: ProblemShortcut[];
  budget: BudgetRow[];
  derivedRefs: JsonObject[];
  feedbackCount: number;
  kindPolicies: JsonObject[];
}

function newestRecords(values: JsonObject[]): JsonObject[] {
  const byId = new Map<string, JsonObject>();
  for (const value of values) {
    const id = text(value.id);
    if (!id) continue;
    const previous = byId.get(id);
    const revision = finite(value.revision) ?? 0;
    const previousRevision = finite(previous?.revision) ?? -1;
    if (!previous || revision >= previousRevision) byId.set(id, value);
  }
  return [...byId.values()];
}

export function memoryPinnedChars(record: unknown): number {
  const value = object(record);
  // Mirrors the controller's pinned-budget accounting: content + conditions joined by '；'.
  return text(value.content).length + stringList(value.conditions).join('；').length;
}

/** Pin eligibility: only active, enabled, conflict-free profile/preference/fact/knowledge records. */
export function memoryPinEligible(record: unknown): { eligible: boolean; reason: string } {
  const value = object(record);
  if (!value.id) return { eligible: false, reason: '记录缺少编号，不能置顶。' };
  if (!memoryRecordIsActive(value)) return { eligible: false, reason: '只有当前生效的记忆可以置顶；候选、停用或失效记录不会进入稳定前缀。' };
  const kind = text(value.kindV2) || text(value.kind);
  if (kind === 'episode' || kind === 'task' || kind === 'method') {
    return { eligible: false, reason: '情节、任务与旧方法不进入置顶稳定前缀。' };
  }
  if (!MEMORY_KIND_IDS.includes(kind as (typeof MEMORY_KIND_IDS)[number])) {
    return { eligible: false, reason: `未知类型 ${kind || '（空）'} 不进入置顶稳定前缀。` };
  }
  if (Array.isArray(value.conflictIds) && value.conflictIds.length > 0) {
    return { eligible: false, reason: '存在待核验冲突的记忆不能置顶，请先裁决冲突。' };
  }
  return { eligible: true, reason: '' };
}

export function memoryPinnedView(snapshot: unknown): PinnedView {
  const root = object(snapshot);
  const raw = root.pinned;
  let ids: string[] = [];
  let records: JsonObject[] = [];
  let limit = PINNED_CHAR_LIMIT;
  let available = raw !== undefined && raw !== null;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') ids.push(entry);
      else {
        const value = object(entry);
        const record = text(value.content) || text(value.title) ? value : undefined;
        if (record) records.push(record);
        if (value.id) ids.push(text(value.id));
      }
    }
  } else if (raw && typeof raw === 'object') {
    const value = object(raw);
    available = true;
    ids = stringList(value.ids ?? value.items).map(item => (typeof item === 'string' ? item : text(object(item).id))).filter(Boolean);
    records = objects(value.records ?? value.items).filter(item => text(item.content) || text(item.title));
    limit = finite(value.limit) ?? limit;
    for (const entry of asList<unknown>(value.ids ?? value.items)) {
      if (entry && typeof entry === 'object') {
        const item = object(entry);
        if (item.id) ids.push(text(item.id));
      }
    }
  } else if (Array.isArray(root.pinnedIds)) {
    available = true;
    ids = stringList(root.pinnedIds);
  }
  ids = [...new Set(ids.filter(Boolean))];
  if (records.length === 0 && ids.length > 0) {
    const catalog = new Map(newestRecords([...objects(root.memories), ...objects(root.candidates)]).map(record => [text(record.id), record]));
    records = ids.flatMap(id => (catalog.has(id) ? [catalog.get(id)!] : []));
  }
  if (records.length === 0 && ids.length === 0 && raw === undefined) available = false;
  const recordIds = new Set(records.map(record => text(record.id)));
  const unresolved = ids.filter(id => !recordIds.has(id)).length;
  const used = records.reduce((total, record) => total + memoryPinnedChars(record), 0);
  const remaining = Math.max(0, limit - used);
  return { available, ids, records, used, limit, remaining, overBudget: used > limit, unresolved };
}

function reviewRecords(value: unknown, now = Date.now()): ReviewItemView[] {
  const container = object(value);
  const source = Array.isArray(value)
    ? value
    : container.items ?? container.reviews ?? container.queue ?? container.candidates ?? container.reviewQueue;
  return objects(source).map((item, index) => {
    const reason = text(item.reason) || text(item.reviewReason);
    const dueAt = text(item.dueAt) || text(item.due_at) || text(item.due);
    const dueValue = parseTime(dueAt);
    const priority = finite(item.priority) ?? 0;
    const createdAt = parseTime(item.createdAt) ?? parseTime(item.created_at) ?? 0;
    const embedded = item.record && typeof item.record === 'object' ? object(item.record) : undefined;
    const status = text(item.status) || 'open';
    return {
      id: text(item.id) || text(item.reviewId) || text(item.memoryId) || `review-${index}`,
      memoryId: text(item.memoryId) || text(item.memory_id) || text(item.id),
      revision: integer(item.revision),
      reason: reason || 'unknown',
      reasonLabel: REVIEW_REASON_LABELS[reason] || reason || '原因未记录',
      priority,
      dueAt,
      overdue: status === 'open' && dueValue !== undefined && dueValue <= now,
      notes: text(item.notes) || text(item.note),
      status,
      record: embedded,
      recordTitle: embedded ? text(embedded.title) : text(item.title),
      // Stable tie-breaker so a review list does not jump around between renders.
      _createdAt: createdAt,
    } as ReviewItemView & { _createdAt: number };
  }).sort((left, right) => {
    const byPriority = right.priority - left.priority;
    if (byPriority) return byPriority;
    const leftDue = parseTime(left.dueAt) ?? Number.POSITIVE_INFINITY;
    const rightDue = parseTime(right.dueAt) ?? Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    const tie = (right as ReviewItemView & { _createdAt: number })._createdAt - (left as ReviewItemView & { _createdAt: number })._createdAt;
    if (tie) return tie;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  }).map(({ _createdAt, ...view }) => view);
}

export function memoryReviewItems(value: unknown, now = Date.now()): ReviewItemView[] {
  return reviewRecords(value, now);
}

function autoPublishPolicyView(value: unknown): AutoPublishPolicyView {
  const policy = object(value);
  const mode = text(policy.mode);
  return {
    available: Object.keys(policy).length > 0,
    id: text(policy.id),
    mode,
    modeLabel: AUTO_PUBLISH_MODE_LABELS[mode] || (mode ? `未知模式 ${mode}` : '策略未读取'),
    minScore: finite(policy.minScore),
    maxAutoPerDay: finite(policy.maxAutoPerDay),
    requireReview: policy.requireReview === true,
    version: integer(policy.version),
    updatedAt: text(policy.updatedAt),
  };
}

export function memoryAutoPublishView(value: unknown): AutoPublishView {
  const root = object(value);
  const nested = object(root.autoPublish);
  const source = Object.keys(object(root.policy)).length || Array.isArray(root.audit) ? root : nested;
  const policy = autoPublishPolicyView(source.policy);
  const stats = object(source.stats);
  const audit = objects(source.audit);
  return {
    available: policy.available || audit.length > 0 || Object.keys(stats).length > 0,
    policy,
    stats: {
      autoPublished: finite(stats.autoPublished),
      revoked: finite(stats.revoked),
      corrected: finite(stats.corrected),
    },
    audit,
  };
}

function learningView(root: JsonObject): LearningQueueView {
  const learning = object(root.learning);
  const jobs = objects(learning.jobs);
  let calls = 0;
  let maxCalls = 0;
  let tokens = 0;
  let callsKnown = false;
  let maxCallsKnown = false;
  let tokensKnown = false;
  let usageUnknown = false;
  for (const job of jobs) {
    const budget = object(job.budget);
    const jobCalls = finite(budget.calls);
    const jobMax = finite(budget.maxCalls);
    const jobTokens = finite(budget.tokens);
    if (jobCalls !== undefined) { calls += jobCalls; callsKnown = true; }
    if (jobMax !== undefined) { maxCalls += jobMax; maxCallsKnown = true; }
    if (jobTokens !== undefined) { tokens += jobTokens; tokensKnown = true; }
    if (budget.usageUnknown === true || budget.unknown === true) usageUnknown = true;
  }
  const failed = finite(learning.failed) ?? jobs.filter(job => text(job.state) === 'failed').length;
  const completed = finite(learning.completed) ?? jobs.filter(job => text(job.state) === 'completed').length;
  return {
    enabled: learning.enabled !== false,
    paused: learning.paused === true,
    running: learning.running === true,
    queued: finite(learning.queued) ?? 0,
    failed,
    completed,
    jobs,
    calls: callsKnown ? calls : undefined,
    maxCalls: maxCallsKnown ? maxCalls : undefined,
    tokens: tokensKnown ? tokens : undefined,
    usageUnknown,
  };
}

function kindCountRows(records: JsonObject[]): KindCountRow[] {
  const kinds = [...MEMORY_KIND_IDS];
  const extra = [...new Set(records.map(record => text(record.kindV2) || text(record.kind)).filter(kind => kind && !kinds.includes(kind as (typeof MEMORY_KIND_IDS)[number])))].sort();
  return [...kinds, ...extra].map(kind => {
    const matches = records.filter(record => (text(record.kindV2) || text(record.kind)) === kind);
    return {
      key: kind,
      kind,
      label: memoryKindLabel(kind),
      total: matches.length,
      active: matches.filter(memoryRecordIsActive).length,
      candidate: matches.filter(record => text(record.status) === 'candidate').length,
    };
  });
}

function scopeCountRows(records: JsonObject[]): CountRow[] {
  return ['project', 'personal'].map(scope => ({
    key: scope,
    label: memoryScopeLabel(scope),
    total: records.filter(record => text(record.scope) === scope).length,
  }));
}

function statusCountRows(records: JsonObject[]): CountRow[] {
  return ['active', 'candidate', 'inactive', 'invalidated'].map(status => ({
    key: status,
    label: memoryStatusLabel(status),
    total: records.filter(record => text(record.status) === status).length,
  }));
}

function problemShortcuts(view: Omit<MemoryCenterSnapshotView, 'problems' | 'budget'>): ProblemShortcut[] {
  const problems: ProblemShortcut[] = [];
  if (view.openConflicts.length) problems.push({ id: 'conflicts', label: '待裁决冲突', count: view.openConflicts.length, tab: 'conflicts', tone: 'warning' });
  if (view.reviewsDue) problems.push({ id: 'reviews', label: '到期复审', count: view.reviewsDue, tab: 'reviews', tone: 'warning' });
  if (view.candidates.length) problems.push({ id: 'candidates', label: '待处理候选', count: view.candidates.length, tab: 'candidates', tone: 'info' });
  const invalidated = view.allRecords.filter(record => text(record.status) === 'invalidated').length;
  if (invalidated) problems.push({ id: 'invalidated', label: '来源失效记录', count: invalidated, tab: 'records', tone: 'warning' });
  if (view.learning.failed) problems.push({ id: 'learning-failed', label: '学习失败批次', count: view.learning.failed, tab: 'learning', tone: 'warning' });
  const unresolvedPinned = view.pinned.unresolved;
  if (unresolvedPinned) problems.push({ id: 'pinned-unresolved', label: '置顶记录待核对', count: unresolvedPinned, tab: 'settings', tone: 'info' });
  return problems;
}

function budgetRows(view: Omit<MemoryCenterSnapshotView, 'problems' | 'budget'>): BudgetRow[] {
  const rows: BudgetRow[] = [
    {
      id: 'pinned',
      label: '置顶字符预算',
      used: view.pinned.available ? view.pinned.used : undefined,
      limit: view.pinned.available ? view.pinned.limit : undefined,
      unit: '字符',
      over: view.pinned.overBudget,
      available: view.pinned.available,
    },
  ];
  const policy = view.autoPublish.policy;
  const stats = view.autoPublish.stats;
  rows.push({
    id: 'autopublish-daily',
    label: '今日自动发布额度',
    used: stats.autoPublished,
    limit: policy.maxAutoPerDay,
    unit: '条',
    over: stats.autoPublished !== undefined && policy.maxAutoPerDay !== undefined ? stats.autoPublished >= policy.maxAutoPerDay : false,
    available: stats.autoPublished !== undefined || policy.maxAutoPerDay !== undefined,
  });
  rows.push({
    id: 'learning-calls',
    label: '学习模型调用',
    used: view.learning.calls,
    limit: view.learning.maxCalls,
    unit: '次',
    over: false,
    available: view.learning.calls !== undefined || view.learning.maxCalls !== undefined,
  });
  rows.push({
    id: 'learning-tokens',
    label: '学习 Token',
    used: view.learning.tokens,
    limit: undefined,
    unit: 'token',
    over: false,
    available: view.learning.tokens !== undefined,
  });
  return rows;
}

export function memoryCenterSnapshotView(snapshot: unknown, options: { now?: number } = {}): MemoryCenterSnapshotView {
  const root = object(snapshot);
  const memories = objects(root.memories);
  const candidates = objects(root.candidates);
  const allRecords = newestRecords([...memories, ...candidates]);
  const byId = new Map(allRecords.map(record => [text(record.id), record]));
  const now = options.now ?? Date.now();
  const reviewContainer = root.reviews;
  const reviewArraySource = Array.isArray(reviewContainer)
    ? reviewContainer
    : Array.isArray(object(root.learning).reviews) ? object(root.learning).reviews : undefined;
  const reviewsById = new Map<string, ReviewItemView>();
  for (const review of reviewRecords(reviewArraySource, now)) {
    if (!reviewsById.has(review.id)) reviewsById.set(review.id, review);
  }
  const reviews = [...reviewsById.values()];
  const summaryValue = object(reviewContainer);
  const reviewSummary = {
    available: Object.keys(summaryValue).length > 0,
    open: finite(summaryValue.open) ?? reviews.filter(review => review.status === 'open').length,
    deferred: finite(summaryValue.deferred) ?? reviews.filter(review => review.status === 'deferred').length,
    resolved: finite(summaryValue.resolved) ?? reviews.filter(review => review.status === 'resolved').length,
    overdue: finite(summaryValue.overdue) ?? reviews.filter(review => review.overdue).length,
  };
  const reviewsDue = reviewSummary.overdue;
  const conflicts = objects(root.conflicts);
  const learning = learningView(root);
  const pinned = memoryPinnedView(root);
  const autoPublish = memoryAutoPublishView(root);
  const derivedRefs = objects(root.derivedRefs).map(ref => ({ ...ref }));
  const base = {
    hasSnapshot: Object.keys(root).length > 0,
    epoch: integer(root.epoch),
    schemaVersion: integer(root.schemaVersion),
    records: memories.filter(record => text(record.status) === 'active' || text(record.status) === 'inactive'),
    candidates: candidates.filter(record => text(record.status) === 'candidate' || text(record.status) === 'invalidated'),
    allRecords,
    recordById: byId,
    counts: {
      total: allRecords.length,
      active: allRecords.filter(memoryRecordIsActive).length,
      candidate: allRecords.filter(record => text(record.status) === 'candidate').length,
      inactive: allRecords.filter(record => text(record.status) === 'inactive').length,
      invalidated: allRecords.filter(record => text(record.status) === 'invalidated').length,
    },
    byKind: kindCountRows(allRecords),
    byScope: scopeCountRows(allRecords),
    byStatus: statusCountRows(allRecords),
    conflicts,
    openConflicts: conflicts.filter(conflict => text(conflict.status) === 'open'),
    reviews,
    reviewsDue,
    reviewSummary,
    learning,
    autoPublish,
    pinned,
    derivedRefs,
    feedbackCount: objects(root.feedback).length,
    kindPolicies: objects(root.kindPolicies ?? root.kindPolicy ?? root.policies),
  };
  return { ...base, problems: problemShortcuts(base), budget: budgetRows(base) };
}

/* ------------------------------------------------------------------------- */
/* Overview counts helper                                                    */
/* ------------------------------------------------------------------------- */

export function memoryCenterTabBadge(tab: MemoryCenterTabId, view: MemoryCenterSnapshotView): number | undefined {
  switch (tab) {
    case 'records': return view.records.length;
    case 'candidates': return view.candidates.length;
    case 'conflicts': return view.openConflicts.length;
    case 'reviews': return view.reviewsDue;
    case 'learning': return view.learning.queued + view.learning.failed;
    default: return undefined;
  }
}

/* ------------------------------------------------------------------------- */
/* Record filters / paging / inputs                                          */
/* ------------------------------------------------------------------------- */

export interface MemoryRecordFilters {
  kind: string;
  scope: 'all' | 'project' | 'personal';
  status: 'all' | 'active' | 'inactive';
  subject: string;
  query: string;
}

export const EMPTY_RECORD_FILTERS: MemoryRecordFilters = { kind: 'all', scope: 'all', status: 'all', subject: '', query: '' };

export const RECORD_SCOPE_OPTIONS: readonly { id: MemoryRecordFilters['scope']; label: string }[] = [
  { id: 'all', label: '全部范围' },
  { id: 'project', label: '本项目' },
  { id: 'personal', label: '个人' },
];

export const RECORD_STATUS_OPTIONS: readonly { id: MemoryRecordFilters['status']; label: string }[] = [
  { id: 'all', label: '生效与停用' },
  { id: 'active', label: '仅生效' },
  { id: 'inactive', label: '仅停用' },
];

function recordSearchText(record: JsonObject): string {
  return [record.title, record.content, ...stringList(record.aliases), ...stringList(record.conditions), record.subject, record.subjectKey]
    .map(value => text(value))
    .join(' ')
    .toLowerCase();
}

export function memoryRecordMatchesFilters(record: unknown, filters: Partial<MemoryRecordFilters> = {}): boolean {
  const value = object(record);
  const merged = { ...EMPTY_RECORD_FILTERS, ...filters };
  const kind = text(value.kindV2) || text(value.kind);
  if (merged.kind !== 'all' && kind !== merged.kind) return false;
  if (merged.scope !== 'all' && text(value.scope) !== merged.scope) return false;
  if (merged.status === 'active' && !memoryRecordIsActive(value)) return false;
  if (merged.status === 'inactive' && !(text(value.status) === 'inactive' || (text(value.status) === 'active' && value.enabled === false))) return false;
  const subject = merged.subject.trim().toLowerCase();
  if (subject && !recordSearchText(value).includes(subject)) return false;
  const query = merged.query.trim().toLowerCase();
  if (query) {
    const tokens = query.split(/\s+/u).filter(Boolean);
    const haystack = recordSearchText(value);
    if (!tokens.every(token => haystack.includes(token))) return false;
  }
  return true;
}

/** Records-tab list: candidates are never rendered here even if a filter degenerates. */
export function memoryRecordList(records: JsonObject[], filters: Partial<MemoryRecordFilters> = {}): JsonObject[] {
  return records
    .filter(record => text(record.status) !== 'candidate' && text(record.status) !== 'invalidated')
    .filter(record => memoryRecordMatchesFilters(record, filters))
    .sort((left, right) => {
      const leftAt = parseTime(left.updatedAt) ?? 0;
      const rightAt = parseTime(right.updatedAt) ?? 0;
      if (leftAt !== rightAt) return rightAt - leftAt;
      return text(left.id) < text(right.id) ? -1 : text(left.id) > text(right.id) ? 1 : 0;
    });
}

export interface RecordPage {
  items: JsonObject[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
  hasPrevious: boolean;
  hasNext: boolean;
  omitted: number;
}

export function memoryRecordPage(records: JsonObject[], page: number, pageSize = 20): RecordPage {
  const total = records.length;
  const size = Math.max(1, Math.min(100, Math.trunc(pageSize) || 20));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.max(0, Math.min(pageCount - 1, Math.trunc(page) || 0));
  const start = current * size;
  const items = records.slice(start, start + size);
  return {
    items,
    page: current,
    pageSize: size,
    pageCount,
    total,
    start: total === 0 ? 0 : start + 1,
    end: start + items.length,
    hasPrevious: current > 0,
    hasNext: current < pageCount - 1,
    omitted: Math.max(0, total - items.length),
  };
}

function pruneUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** `list` accepts scope/status/cursor/limit; kind/subject are filtered client-side (see API gaps). */
export function memoryListInput(filters: Partial<MemoryRecordFilters> = {}, page = 0, pageSize = 100): JsonObject {
  const size = Math.max(1, Math.min(100, Math.trunc(pageSize) || 100));
  const cursor = Math.max(0, Math.trunc(page) || 0) * size;
  return pruneUndefined({
    scope: filters.scope && filters.scope !== 'all' ? filters.scope : undefined,
    status: filters.status && filters.status !== 'all' ? filters.status : undefined,
    cursor,
    limit: size,
  });
}

export function memorySearchInput(query: string, filters: Partial<MemoryRecordFilters> = {}, limit = 20): JsonObject {
  return pruneUndefined({
    query,
    limit: Math.max(1, Math.min(100, Math.trunc(limit) || 20)),
    match: 'adaptive',
    scope: filters.scope && filters.scope !== 'all' ? filters.scope : undefined,
  });
}

export function memorySearchExplainInput(query: string, filters: Partial<MemoryRecordFilters> = {}): JsonObject {
  if (!query.trim()) throw new Error('请先输入要解释的检索词。');
  return pruneUndefined({
    query: query.trim(),
    limit: 12,
    match: 'adaptive',
    scope: filters.scope && filters.scope !== 'all' ? filters.scope : undefined,
  });
}

export function memoryReadInput(id: string, revision?: number): JsonObject {
  if (!id) throw new Error('缺少记忆编号。');
  return pruneUndefined({ id, revision: integer(revision) });
}

export function memoryReadSourcesInput(id: string, revision?: number): JsonObject {
  if (!id) throw new Error('缺少记忆编号。');
  return pruneUndefined({ id, revision: integer(revision), source: true });
}

export function memoryVersionsInput(id: string): JsonObject {
  if (!id) throw new Error('缺少记忆编号。');
  return { id };
}

export function memoryReadRangeInput(id: string, revision: number, cursor = 0): JsonObject {
  if (!id) throw new Error('缺少记忆编号。');
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('分页读取需要实际版本号。');
  return { id, revision, cursor: Math.max(0, Math.trunc(cursor) || 0) };
}

export function memoryBulkToggleRequests(records: JsonObject[], enabled: boolean): { action: 'toggle'; input: JsonObject }[] {
  return records.flatMap(record => {
    const id = text(record.id);
    const revision = integer(record.revision);
    return id && revision !== undefined ? [{ action: 'toggle' as const, input: { id, revision, enabled } }] : [];
  });
}

/* ------------------------------------------------------------------------- */
/* Pin requests                                                              */
/* ------------------------------------------------------------------------- */

export function memoryPinRequest(record: unknown, pinned: PinnedView | JsonObject[] = []): { action: 'pin' | 'unpin'; input: JsonObject } {
  const value = object(record);
  const id = text(value.id);
  const revision = integer(value.revision);
  if (!id || revision === undefined) throw new Error('缺少记忆编号或版本，无法置顶。');
  const pinnedIds = Array.isArray(pinned) ? pinned.map(item => text(item.id)) : pinned.ids;
  if (pinnedIds.includes(id)) return { action: 'unpin', input: { id, expectedRevision: revision } };
  const eligibility = memoryPinEligible(value);
  if (!eligibility.eligible) throw new Error(eligibility.reason);
  const pinnedView = Array.isArray(pinned) ? memoryPinnedView({ pinned }) : pinned;
  const chars = memoryPinnedChars(value);
  if (pinnedView.used + chars > pinnedView.limit) {
    throw new Error(`置顶预算不足：已用 ${pinnedView.used} / ${pinnedView.limit} 字符，本条需要 ${chars} 字符。请先取消部分置顶。`);
  }
  return { action: 'pin', input: { id, revision, expectedRevision: revision } };
}

export interface BulkPinResult {
  actions: { action: 'pin' | 'unpin'; input: JsonObject }[];
  skipped: { id: string; reason: string }[];
  used: number;
  limit: number;
  overBudget: boolean;
}

/** Bulk pin/unpin keeps the 1500-character budget: over-budget records are skipped, never silently dropped. */
export function memoryBulkPinRequests(records: JsonObject[], pinned: PinnedView, enable: boolean): BulkPinResult {
  const actions: { action: 'pin' | 'unpin'; input: JsonObject }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  let used = pinned.used;
  const pinnedIds = new Set(pinned.ids);
  for (const record of records) {
    const id = text(record.id);
    const revision = integer(record.revision);
    if (!id || revision === undefined) { skipped.push({ id: id || '（无编号）', reason: '缺少编号或版本' }); continue; }
    if (!enable) {
      if (!pinnedIds.has(id)) { skipped.push({ id, reason: '不在置顶列表中' }); continue; }
      actions.push({ action: 'unpin', input: { id, expectedRevision: revision } });
      pinnedIds.delete(id);
      continue;
    }
    if (pinnedIds.has(id)) { skipped.push({ id, reason: '已经在置顶列表' }); continue; }
    const eligibility = memoryPinEligible(record);
    if (!eligibility.eligible) { skipped.push({ id, reason: eligibility.reason }); continue; }
    const chars = memoryPinnedChars(record);
    if (used + chars > pinned.limit) { skipped.push({ id, reason: `置顶预算不足：本条需要 ${chars} 字符，剩余 ${Math.max(0, pinned.limit - used)} 字符` }); continue; }
    used += chars;
    pinnedIds.add(id);
    actions.push({ action: 'pin', input: { id, revision, expectedRevision: revision } });
  }
  return { actions, skipped, used, limit: pinned.limit, overBudget: used > pinned.limit };
}

/* ------------------------------------------------------------------------- */
/* Impact preview                                                            */
/* ------------------------------------------------------------------------- */

export interface MemoryImpactView {
  available: boolean;
  action: string;
  id: string;
  revision: number | undefined;
  previewToken: string;
  conclusion: string;
  evidenceBoundary: string;
  counts: { affected: number; derived: number; sources: number; artifacts: number; dependencies: number };
  affected: { id: string; revision: number | undefined; status: string; statusLabel: string }[];
  sourceValidity: { valid: number; invalid: number; unknown: number };
  invalidSources: string[];
  error: string;
}

export function memoryImpactView(preview: unknown): MemoryImpactView {
  const value = object(preview);
  const affected = objects(value.affected);
  const sources = objects(value.sources);
  const previewToken = text(value.previewToken);
  const revision = integer(value.revision);
  const available = Boolean(previewToken) && revision !== undefined && revision > 0;
  const invalidSources = sources.filter(source => source.valid === false).map(source => text(object(source.source).entryId) || text(source.reason) || '来源不可用');
  return {
    available,
    action: text(value.action),
    id: text(value.id),
    revision,
    previewToken,
    conclusion: text(value.conclusion) || '请核对影响后确认操作。',
    evidenceBoundary: text(value.evidenceBoundary) || '只读预览，不修改记录。',
    counts: {
      affected: affected.length,
      derived: Math.max(0, affected.length - 1),
      sources: sources.length,
      artifacts: objects(value.artifacts).length,
      dependencies: objects(value.dependencies).length,
    },
    affected: affected.map(item => {
      const status = text(item.status);
      return { id: text(item.id), revision: integer(item.revision), status, statusLabel: memoryStatusLabel(status) };
    }),
    sourceValidity: {
      valid: sources.filter(source => source.valid === true).length,
      invalid: sources.filter(source => source.valid === false).length,
      unknown: sources.filter(source => typeof source.valid !== 'boolean').length,
    },
    invalidSources,
    error: available ? '' : '影响预览缺少 previewToken 或版本；请重新预览后再确认。',
  };
}

/** Commit input for update/forget always carries the frozen preview token and revision. */
export function memoryImpactCommitInput(preview: unknown, action: 'update' | 'forget', id: string, patch?: JsonObject): JsonObject {
  return memoryImpactMutation(preview, action, id, patch);
}

export function memoryImpactStale(preview: unknown, snapshot: unknown): boolean {
  return memoryImpactChanged(preview, snapshot);
}

/* ------------------------------------------------------------------------- */
/* Candidates                                                                */
/* ------------------------------------------------------------------------- */

export interface CandidateGateItem {
  id: number;
  name: string;
  label: string;
  pass: boolean;
  reason: string;
}

export interface CandidateGateView {
  available: boolean;
  items: CandidateGateItem[];
  passed: number;
  total: number;
  failed: CandidateGateItem[];
  summary: string;
}

export interface CandidateView {
  id: string;
  revision: number | undefined;
  title: string;
  summary: string;
  kind: string;
  kindLabel: string;
  scope: string;
  scopeLabel: string;
  status: string;
  statusLabel: string;
  active: false;
  trust: string;
  trustLabel: string;
  authority: string;
  score: number | undefined;
  rejectionReason: string;
  gate: CandidateGateView;
  jobId: string;
  jobLabel: string;
  createdAt: string;
  conditions: string[];
  sources: number;
  conflict: boolean;
}

export interface CandidateGroup {
  key: string;
  label: string;
  candidates: CandidateView[];
  rejected: number;
  jobState: string;
}

function gateItems(value: unknown): CandidateGateItem[] {
  return objects(value).map((gate, index) => {
    const id = integer(gate.id) ?? integer(gate.gateId) ?? index + 1;
    const name = text(gate.name) || text(gate.gate) || `gate-${id}`;
    return {
      id,
      name,
      label: AUTO_PUBLISH_GATE_LABELS[id] || name,
      pass: gate.pass !== false && gate.ok !== false,
      reason: text(gate.reason) || text(gate.detail),
    };
  });
}

function candidateGateSource(candidate: JsonObject, context: { audit?: JsonObject[]; jobs?: JsonObject[] }): CandidateGateItem[] {
  const direct = [
    candidate.gates,
    candidate.gateDetails,
    object(candidate.autoPublish).gates,
    object(candidate.decision).gates,
    object(candidate.autopublish).gates,
  ];
  for (const value of direct) {
    const items = gateItems(value);
    if (items.length) return items;
  }
  const audits = (context.audit || []).filter(row => text(row.memoryId) === text(candidate.id) || text(row.memory_id) === text(candidate.id));
  audits.sort((left, right) => (parseTime(right.createdAt) ?? 0) - (parseTime(left.createdAt) ?? 0));
  for (const row of audits) {
    const items = gateItems(row.gates ?? row.gatesJson ?? row.gates_json);
    if (items.length) return items;
  }
  for (const job of context.jobs || []) {
    for (const proposal of objects(job.proposalLedger ?? job.proposals)) {
      if (text(proposal.memoryId) !== text(candidate.id)) continue;
      const items = gateItems(proposal.gates ?? object(proposal.decision).gates);
      if (items.length) return items;
    }
  }
  return [];
}

export function memoryCandidateGateView(candidate: unknown, context: { audit?: JsonObject[]; jobs?: JsonObject[] } = {}): CandidateGateView {
  const items = candidateGateSource(object(candidate), context);
  const failed = items.filter(item => !item.pass);
  return {
    available: items.length > 0,
    items,
    passed: items.length - failed.length,
    total: items.length,
    failed,
    summary: items.length === 0
      ? '门禁明细未记录'
      : failed.length === 0
        ? `通过全部 ${items.length} 道门禁`
        : `未通过门禁 ${failed.map(item => `#${item.id} ${item.label}${item.reason ? `（${item.reason}）` : ''}`).join('；')}`,
  };
}

function auditFor(candidate: JsonObject, audit: JsonObject[]): JsonObject | undefined {
  const rows = audit.filter(row => text(row.memoryId) === text(candidate.id));
  rows.sort((left, right) => (parseTime(right.createdAt) ?? 0) - (parseTime(left.createdAt) ?? 0));
  return rows[0];
}

export function memoryCandidateView(candidate: unknown, context: { audit?: JsonObject[]; jobs?: JsonObject[] } = {}): CandidateView {
  const value = object(candidate);
  const audit = auditFor(value, context.audit || []);
  const jobId = text(value.jobId) || text(value.job_id) || text(audit?.jobId);
  const kind = text(value.kindV2) || text(value.kind);
  const rejectionReason = text(value.invalidatedReason) || text(object(audit?.after).reason) || text(value.reason) || '未记录拒绝原因';
  return {
    id: text(value.id),
    revision: integer(value.revision),
    title: text(value.title) || '未命名候选',
    summary: memorySummary(text(value.content)),
    kind,
    kindLabel: memoryKindLabel(kind),
    scope: text(value.scope),
    scopeLabel: memoryScopeLabel(value.scope),
    status: text(value.status),
    statusLabel: memoryStatusLabel(value.status),
    active: false,
    trust: text(value.trust),
    trustLabel: memoryTrustLabel(value.trust),
    authority: text(value.authority),
    score: finite(value.score) ?? finite(audit?.score),
    rejectionReason,
    gate: memoryCandidateGateView(value, context),
    jobId,
    jobLabel: jobId ? `学习批次 ${jobId.slice(0, 12)}` : '未关联学习批次',
    createdAt: text(value.createdAt),
    conditions: stringList(value.conditions),
    sources: objects(value.sources).length,
    conflict: value.conflictState === 'open' || (Array.isArray(value.conflictIds) && value.conflictIds.length > 0),
  };
}

export function memoryCandidateGroups(view: MemoryCenterSnapshotView): CandidateGroup[] {
  const jobs = view.learning.jobs;
  const context = { audit: view.autoPublish.audit, jobs };
  const groups = new Map<string, CandidateView[]>();
  for (const candidate of view.candidates) {
    const item = memoryCandidateView(candidate, context);
    const key = item.jobId || 'unassigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return [...groups.entries()].map(([key, candidates]) => {
    const job = jobs.find(entry => text(entry.id) === key);
    const source = objects(job?.sources)[0];
    const sourceLabel = source && text(source.entryId) ? ` · 来源 ${text(source.sessionId)}/${text(source.entryId)}` : '';
    return {
      key,
      label: key === 'unassigned' ? '未关联学习批次（历史候选）' : `学习批次 ${key.slice(0, 12)}${sourceLabel}`,
      candidates: candidates.sort((left, right) => left.title.localeCompare(right.title, 'zh')),
      rejected: candidates.filter(candidate => candidate.gate.failed.length > 0).length,
      jobState: text(job?.state),
    };
  }).sort((left, right) => {
    if (left.key === 'unassigned') return 1;
    if (right.key === 'unassigned') return -1;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });
}

export function memoryCandidateAcceptRequest(candidate: unknown): { action: 'accept'; input: JsonObject } {
  const value = object(candidate);
  const id = text(value.id);
  const revision = integer(value.revision);
  if (!id) throw new Error('候选缺少编号，不能接受。');
  return { action: 'accept', input: pruneUndefined({ id, revision, expectedRevision: revision }) };
}

/** Rejection is a stop, not an activation: there is no dedicated controller action yet, so the
 * candidate is disabled (never marked active) and the UI reports the API gap. */
export function memoryCandidateRejectRequest(candidate: unknown): { action: 'toggle'; input: JsonObject } {
  const value = object(candidate);
  const id = text(value.id);
  const revision = integer(value.revision);
  if (!id) throw new Error('候选缺少编号，不能拒绝。');
  return { action: 'toggle', input: pruneUndefined({ id, revision, expectedRevision: revision, enabled: false }) };
}

/** Candidate edit is an explicit user correction via update; the impact preview token is mandatory. */
export function memoryCandidateEditRequest(candidate: unknown, preview: unknown, patch: JsonObject): { action: 'update'; input: JsonObject } {
  const value = object(candidate);
  const id = text(value.id);
  if (!id) throw new Error('候选缺少编号，不能编辑。');
  if (!patch || (patch.content === undefined && patch.title === undefined && patch.conditions === undefined)) {
    throw new Error('请先填写要更正的内容或条件。');
  }
  return { action: 'update', input: memoryImpactCommitInput(preview, 'update', id, patch) };
}

/* ------------------------------------------------------------------------- */
/* Conflicts                                                                 */
/* ------------------------------------------------------------------------- */

export interface ConflictSideView {
  side: 'left' | 'right';
  memoryId: string;
  revision: number | undefined;
  found: boolean;
  title: string;
  claim: string;
  kind: string;
  kindLabel: string;
  scope: string;
  scopeLabel: string;
  status: string;
  statusLabel: string;
  conditions: string[];
  sources: number;
  supportScore: number | undefined;
  trustLabel: string;
  conflictOpen: boolean;
}

export interface ConflictView {
  id: string;
  status: string;
  statusLabel: string;
  subjectKey: string;
  scope: string;
  openedAt: string;
  openedBy: string;
  notes: string;
  resolution: string;
  resolutionLabel: string;
  resolvedAt: string;
  left: ConflictSideView;
  right: ConflictSideView;
  affectedRecordIds: string[];
}

const CONFLICT_STATUS_LABELS: Record<string, string> = { open: '待裁决', deferred: '已延后', resolved: '已裁决', superseded: '已取代' };

function conflictSide(side: 'left' | 'right', raw: JsonObject, findRecord: (id: string) => JsonObject | undefined): ConflictSideView {
  const memoryId = text(raw.memoryId) || text(raw.id);
  const record = memoryId ? findRecord(memoryId) : undefined;
  const recordValue = record || {};
  return {
    side,
    memoryId,
    revision: integer(raw.revision) ?? integer(recordValue.revision),
    found: Boolean(record),
    title: text(recordValue.title) || (record ? '未命名记录' : '记录不在当前快照'),
    claim: memorySummary(text(recordValue.content) || text(raw.claim) || text(raw.claimHash)),
    kind: text(recordValue.kindV2) || text(recordValue.kind),
    kindLabel: memoryKindLabel(text(recordValue.kindV2) || text(recordValue.kind)),
    scope: text(recordValue.scope),
    scopeLabel: memoryScopeLabel(recordValue.scope),
    status: text(recordValue.status),
    statusLabel: memoryStatusLabel(recordValue.status),
    conditions: stringList(recordValue.conditions),
    sources: objects(recordValue.sources).length,
    supportScore: finite(raw.supportScore),
    trustLabel: memoryTrustLabel(recordValue.trust),
    conflictOpen: recordValue.conflictState === 'open',
  };
}

export function memoryConflictView(conflict: unknown, view: Pick<MemoryCenterSnapshotView, 'recordById'>): ConflictView {
  const value = object(conflict);
  const sides = objects(value.sides);
  const findRecord = (id: string) => view.recordById.get(id);
  const left = conflictSide('left', sides.find(side => text(side.side) === 'left') || sides[0] || {}, findRecord);
  const right = conflictSide('right', sides.find(side => text(side.side) === 'right') || sides[1] || {}, findRecord);
  const resolution = text(value.resolution);
  return {
    id: text(value.id),
    status: text(value.status) || 'open',
    statusLabel: CONFLICT_STATUS_LABELS[text(value.status)] || text(value.status) || '状态未记录',
    subjectKey: text(value.subjectKey),
    scope: text(value.scope),
    openedAt: text(value.openedAt),
    openedBy: text(value.openedBy),
    notes: text(value.notes),
    resolution,
    resolutionLabel: resolution ? CONFLICT_RESOLUTION_LABELS[resolution] || resolution : '',
    resolvedAt: text(value.resolvedAt),
    left,
    right,
    affectedRecordIds: [left.memoryId, right.memoryId].filter(Boolean),
  };
}

export function memoryConflictViews(view: MemoryCenterSnapshotView, status: 'all' | 'open' | 'deferred' | 'resolved' = 'all'): ConflictView[] {
  return view.conflicts
    .map(conflict => memoryConflictView(conflict, view))
    .filter(conflict => status === 'all' || conflict.status === status)
    .sort((left, right) => {
      const order = (status: string) => (status === 'open' ? 0 : status === 'deferred' ? 1 : 2);
      const byStatus = order(left.status) - order(right.status);
      if (byStatus) return byStatus;
      return (parseTime(right.openedAt) ?? 0) - (parseTime(left.openedAt) ?? 0);
    });
}

export function memoryConflictResolveAllowed(conflict: ConflictView, resolution: string): { allowed: boolean; reason: string } {
  if (!CONFLICT_RESOLUTIONS.includes(resolution as ConflictResolution)) return { allowed: false, reason: '未知的冲突裁决方式。' };
  if (conflict.status !== 'open' && conflict.status !== 'deferred') return { allowed: false, reason: '该冲突已裁决或已取代，不能再次裁决。' };
  if (resolution === 'both') {
    if (!conflict.left.conditions.length || !conflict.right.conditions.length) {
      return { allowed: false, reason: '“两侧都保留”要求两侧都有可区分的适用条件；请先补充条件或选择其他裁决。' };
    }
    if (conflict.left.conditions.join('|') === conflict.right.conditions.join('|')) {
      return { allowed: false, reason: '两侧适用条件相同，无法同时保留；请选择保留一侧或合并。' };
    }
  }
  if (resolution === 'merge' && (!conflict.left.found || !conflict.right.found)) {
    return { allowed: false, reason: '合并需要两侧记录都在当前快照中。' };
  }
  return { allowed: true, reason: '' };
}

export function memoryConflictResolveInput(
  conflict: ConflictView | JsonObject,
  resolution: string,
  options: { content?: string; title?: string; notes?: string } = {},
): JsonObject {
  const view = 'left' in conflict && 'right' in conflict ? conflict as ConflictView : memoryConflictView(conflict, { recordById: new Map() });
  if (!CONFLICT_RESOLUTIONS.includes(resolution as ConflictResolution)) throw new Error('未知的冲突裁决方式。');
  const check = memoryConflictResolveAllowed(view, resolution);
  if (!check.allowed) throw new Error(check.reason);
  const content = (options.content || '').trim();
  if (resolution === 'merge' && !content) throw new Error('合并需要填写合并后的完整正文。');
  return pruneUndefined({
    id: view.id,
    resolution,
    expectedStatus: view.status,
    notes: (options.notes || '').trim() || undefined,
    content: resolution === 'merge' ? content : undefined,
    title: resolution === 'merge' && options.title?.trim() ? options.title.trim() : undefined,
  });
}

export interface ConflictImpactView {
  affectedRecords: { id: string; title: string; status: string; statusLabel: string; role: string }[];
  derived: number;
  retrieval: string;
  requiresConfirmation: boolean;
}

/** Client-side impact summary shown before resolve. The controller also returns affected ids after commit. */
export function memoryConflictImpactView(view: MemoryCenterSnapshotView, conflict: ConflictView, resolution: string): ConflictImpactView {
  const affected = new Map<string, { id: string; title: string; status: string; statusLabel: string; role: string }>();
  for (const side of [conflict.left, conflict.right]) {
    if (!side.memoryId) continue;
    const record = view.recordById.get(side.memoryId) || {};
    const role = resolution === 'keep_left' && side.side === 'right'
      ? '将停用'
      : resolution === 'keep_right' && side.side === 'left'
        ? '将停用'
        : resolution === 'neither'
          ? '将停用'
          : resolution === 'merge'
            ? '将被合并并停用'
            : resolution === 'both'
              ? '保持生效（需可区分条件）'
              : resolution === 'defer'
                ? '保持不变'
                : '保持生效';
    affected.set(side.memoryId, { id: side.memoryId, title: side.title, status: text(record.status), statusLabel: memoryStatusLabel(record.status), role });
  }
  const derivedIds = new Set<string>();
  for (const record of view.allRecords) {
    const parents = stringList(record.parentIds);
    if (parents.includes(conflict.left.memoryId) || parents.includes(conflict.right.memoryId)) derivedIds.add(text(record.id));
  }
  for (const ref of view.derivedRefs) {
    const parents = stringList(ref.parentIds);
    if (parents.includes(conflict.left.memoryId) || parents.includes(conflict.right.memoryId)) derivedIds.add(text(ref.id));
  }
  const derived = [...derivedIds];
  const retrieval = resolution === 'keep_left'
    ? '左侧版本继续生效，右侧停用；检索只会返回保留的一侧。'
    : resolution === 'keep_right'
      ? '右侧版本继续生效，左侧停用；检索只会返回保留的一侧。'
      : resolution === 'merge'
        ? '生成一条用户确认的新记录并停用两侧；新记录替代两侧参与检索。'
        : resolution === 'both'
          ? '两侧都生效，但需要可区分的适用条件；检索按条件选择。'
          : resolution === 'neither'
            ? '两侧都停用，该主题暂无生效值；派生内容同步失效。'
            : '不做变更，冲突保持待裁决。';
  return {
    affectedRecords: [...affected.values()],
    derived: derived.length,
    retrieval,
    requiresConfirmation: resolution !== 'defer',
  };
}

/* ------------------------------------------------------------------------- */
/* Reviews                                                                   */
/* ------------------------------------------------------------------------- */

export function memoryReviewResolveInput(
  review: ReviewItemView | JsonObject,
  action: string,
  options: { patch?: JsonObject; notes?: string; confirmed?: boolean; previewToken?: string; expectedRevision?: number } = {},
): JsonObject {
  const value = object(review);
  const id = text(value.id);
  if (!id) throw new Error('复审条目缺少编号。');
  if (!Object.hasOwn(REVIEW_RESOLUTION_LABELS, action)) throw new Error('未知的复审操作。');
  if (['forget', 'disable', 'correct', 'merge', 'split'].includes(action) && options.confirmed !== true) {
    throw new Error('该复审操作会影响生效记录，请先查看影响预览并确认。');
  }
  const patch = action === 'correct'
    ? (options.patch && Object.keys(options.patch).length ? options.patch : undefined)
    : options.patch;
  if (action === 'correct' && !patch) throw new Error('更正复审需要提供正文或条件补丁。');
  const previewToken = options.previewToken || text(value.previewToken);
  return pruneUndefined({
    id,
    action,
    patch,
    notes: (options.notes || '').trim() || undefined,
    expectedRevision: integer(options.expectedRevision ?? value.revision),
    previewToken: previewToken || undefined,
  });
}

/** Batch review actions are limited to non-destructive, per-record-safe transitions. */
export function memoryReviewBatchInputs(reviews: ReviewItemView[], action: 'confirm' | 'disable' | 'defer', options: { notes?: string; confirmed?: boolean } = {}): { action: 'review.resolve'; input: JsonObject }[] {
  if (!['confirm', 'disable', 'defer'].includes(action)) throw new Error('批量复审仅支持确认、停用与稍后。');
  if (action === 'disable' && options.confirmed !== true) throw new Error('批量停用前请先确认影响。');
  return reviews.flatMap(review => {
    if (!review.id) return [];
    return [{ action: 'review.resolve' as const, input: memoryReviewResolveInput(review, action, options) }];
  });
}

export function memoryReviewListInput(options: { status?: string; reason?: string; limit?: number } = {}): JsonObject {
  return pruneUndefined({
    status: options.status || undefined,
    reason: options.reason || undefined,
    limit: Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50) || 50)),
  });
}

export function memoryReviewActions(review: ReviewItemView | JsonObject): string[] {
  const value = object(review);
  if (!value.memoryId && !value.memory_id && !value.id) return [];
  // Matches controller review.resolve: merge/split are independent record actions, not review transitions.
  return ['confirm', 'correct', 'disable', 'forget', 'defer'];
}

export function memoryReviewsDue(view: MemoryCenterSnapshotView, now = Date.now()): ReviewItemView[] {
  return view.reviews.filter(review => {
    const due = parseTime(review.dueAt);
    return due === undefined ? true : due <= now;
  });
}

/* ------------------------------------------------------------------------- */
/* Learning                                                                  */
/* ------------------------------------------------------------------------- */

export interface LearningJobView {
  id: string;
  stage: string;
  stageLabel: string;
  state: string;
  stateLabel: string;
  attempts: number | undefined;
  updatedAt: string;
  proposals: { total: number; processed: number; published: number; candidates: number; rejected: number; pending: number };
  budget: { calls: number | undefined; maxCalls: number | undefined; tokens: number | undefined; usageUnknown: boolean };
  error: string;
  rejections: { id: string; title: string; reason: string }[];
  sourceRanges: string[];
  sourceCount: number;
  canRetry: boolean;
  canPause: boolean;
  proposalCount: number;
}

const LEARNING_STATE_LABELS: Record<string, string> = {
  queued: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  waiting_configuration: '等待模型配置',
  operation_unknown: '调用结果待核对',
  invalidated: '来源已失效',
};

function sourceRangeLabel(source: JsonObject): string {
  const sessionId = text(source.sessionId);
  const entryId = text(source.entryId);
  const start = integer(source.start);
  const end = integer(source.end);
  const range = start !== undefined || end !== undefined ? `[${start ?? 0}-${end ?? ''}]` : '';
  return `${sessionId || '未知会话'}/${entryId || '未知条目'}${range}`;
}

export function memoryLearningJobView(job: unknown): LearningJobView {
  const value = object(job);
  const progress = object(value.progress);
  const budget = object(value.budget);
  const ledger = objects(value.proposalLedger);
  const state = text(value.state);
  const total = finite(progress.proposals) ?? ledger.length;
  const rejections = ledger.filter(item => text(item.state) === 'rejected' || text(item.state) === 'candidate').map(item => ({
    id: text(item.id),
    title: text(object(item.original).title) || '未命名提案',
    reason: text(item.reason) || '等待核对',
  }));
  const sources = objects(value.sources);
  const ranges = [
    ...sources,
    ...objects(value.pendingRanges),
  ].map(sourceRangeLabel);
  const uniqueRanges = [...new Set(ranges)];
  const usageUnknown = budget.usageUnknown === true || budget.unknown === true;
  const calls = finite(budget.calls);
  const maxCalls = finite(budget.maxCalls);
  const tokens = finite(budget.tokens);
  return {
    id: text(value.id),
    stage: text(value.stage),
    stageLabel: LEARNING_STAGE_LABELS[text(value.stage)] || text(value.stage) || '阶段未记录',
    state,
    stateLabel: LEARNING_STATE_LABELS[state] || state || '状态未记录',
    attempts: integer(value.attempts),
    updatedAt: text(value.updatedAt),
    proposals: {
      total,
      processed: finite(progress.processed) ?? 0,
      published: finite(progress.published) ?? 0,
      candidates: finite(progress.candidates) ?? 0,
      rejected: finite(progress.rejected) ?? 0,
      pending: finite(progress.pending) ?? Math.max(0, total - (finite(progress.processed) ?? 0)),
    },
    budget: { calls, maxCalls, tokens, usageUnknown },
    error: text(value.error),
    rejections,
    sourceRanges: uniqueRanges,
    sourceCount: uniqueRanges.length,
    canRetry: state === 'failed' || state === 'operation_unknown',
    canPause: state === 'queued' || state === 'running',
    proposalCount: ledger.length,
  };
}

export function memoryLearningJobViews(view: MemoryCenterSnapshotView): LearningJobView[] {
  return view.learning.jobs
    .map(job => memoryLearningJobView(job))
    .sort((left, right) => (parseTime(right.updatedAt) ?? 0) - (parseTime(left.updatedAt) ?? 0));
}

export function memoryLearningControlRequest(action: 'run' | 'retry' | 'pause' | 'resume', jobId?: string): { action: string; input: JsonObject } {
  switch (action) {
    case 'run':
      return { action: 'learning.run', input: {} };
    case 'retry': {
      if (!jobId) throw new Error('重试需要具体的学习批次。');
      return { action: 'learning.retry', input: { jobId } };
    }
    case 'pause':
      return { action: 'learning.pause', input: {} };
    case 'resume':
      return { action: 'learning.resume', input: {} };
    default:
      throw new Error('未知的学习控制操作。');
  }
}

/* ------------------------------------------------------------------------- */
/* Graph                                                                     */
/* ------------------------------------------------------------------------- */

export interface GraphNodeView {
  id: string;
  kind: string;
  title: string;
  status: string;
  label: string;
}

export interface GraphEdgeView {
  from: string;
  to: string;
  kind: string;
  label: string;
}

export interface GraphView {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  rootId: string;
  subjectKey: string;
  available: boolean;
  source: 'controller' | 'snapshot' | 'empty';
}

function graphNode(value: unknown): GraphNodeView {
  const node = object(value);
  const kind = text(node.kind) || text(node.kindV2);
  return {
    id: text(node.id),
    kind,
    title: text(node.title) || text(node.id) || '未命名记录',
    status: text(node.status),
    label: `${memoryKindLabel(kind)} · ${memoryStatusLabel(text(node.status))}`,
  };
}

function graphEdge(value: unknown): GraphEdgeView {
  const edge = object(value);
  const kind = text(edge.kind) || text(edge.relation) || 'related';
  return { from: text(edge.from), to: text(edge.to), kind, label: GRAPH_EDGE_LABELS[kind] || kind };
}

export function memoryGraphView(value: unknown): GraphView {
  const root = object(value);
  const nodes = objects(root.nodes).map(graphNode).filter(node => node.id);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = objects(root.edges ?? root.relations).map(graphEdge).filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to);
  return {
    nodes,
    edges,
    rootId: text(root.rootId),
    subjectKey: text(root.subjectKey),
    available: nodes.length > 0,
    source: Object.keys(root).length ? 'controller' : 'empty',
  };
}

/** Fallback lineage view when the controller `graph` action is unavailable: parentIds + 1 hop. */
export function memoryGraphFromSnapshot(view: MemoryCenterSnapshotView, options: { rootId?: string; kind?: string; scope?: string } = {}): GraphView {
  const byId = new Map(view.allRecords.map(record => [text(record.id), record]));
  const rootId = options.rootId || '';
  let selected = view.allRecords;
  if (rootId) {
    const root = byId.get(rootId);
    if (root) {
      const parents = stringList(root.parentIds);
      selected = [root, ...parents.flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))];
    } else selected = [];
  }
  if (options.kind && options.kind !== 'all') selected = selected.filter(record => (text(record.kindV2) || text(record.kind)) === options.kind);
  if (options.scope && options.scope !== 'all') selected = selected.filter(record => text(record.scope) === options.scope);
  const nodes = selected.map(record => graphNode(record));
  const ids = new Set(nodes.map(node => node.id));
  const edges: GraphEdgeView[] = [];
  for (const record of selected) {
    for (const parent of stringList(record.parentIds)) {
      if (ids.has(parent)) edges.push({ from: parent, to: text(record.id), kind: 'parent-child', label: GRAPH_EDGE_LABELS['parent-child'] });
    }
  }
  return {
    nodes,
    edges,
    rootId,
    subjectKey: text(byId.get(rootId)?.subjectKey),
    available: nodes.length > 0,
    source: nodes.length ? 'snapshot' : 'empty',
  };
}

export function memoryGraphRequest(input: { rootId?: string; subjectKey?: string; scope?: string; depth?: number } = {}): JsonObject {
  const depth = input.depth === undefined ? undefined : Math.trunc(input.depth);
  if (depth !== undefined && (depth < 1 || depth > 2)) throw new Error('图谱展开深度只能是 1 或 2 跳。');
  return pruneUndefined({
    rootId: input.rootId?.trim() || undefined,
    subjectKey: input.subjectKey?.trim() || undefined,
    scope: input.scope && input.scope !== 'all' ? input.scope : undefined,
    depth,
  });
}

export interface LaidOutNode extends GraphNodeView {
  x: number;
  y: number;
  radius: number;
}

export interface LaidOutEdge extends GraphEdgeView {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

/** Deterministic SVG layout: sorted nodes on a circle, no physics, no external library. */
export function memoryGraphLayout(graph: GraphView, options: { width?: number; height?: number } = {}): GraphLayout {
  const width = Math.max(320, Math.trunc(options.width ?? 720));
  const height = Math.max(240, Math.trunc(options.height ?? 420));
  const nodes = [...graph.nodes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(60, Math.min(width, height) / 2 - 70);
  const positioned: LaidOutNode[] = nodes.map((node, index) => {
    if (nodes.length === 1) return { ...node, x: centerX, y: centerY, radius: 26 };
    const angle = (Math.PI * 2 * index) / nodes.length - Math.PI / 2;
    return {
      ...node,
      x: Math.round((centerX + radius * Math.cos(angle)) * 100) / 100,
      y: Math.round((centerY + radius * Math.sin(angle)) * 100) / 100,
      radius: 24,
    };
  });
  const positions = new Map(positioned.map(node => [node.id, node]));
  const edges: LaidOutEdge[] = graph.edges.flatMap(edge => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return [];
    return [{
      ...edge,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      labelX: Math.round(((from.x + to.x) / 2) * 100) / 100,
      labelY: Math.round(((from.y + to.y) / 2) * 100) / 100,
    }];
  });
  return { width, height, nodes: positioned, edges };
}

/* ------------------------------------------------------------------------- */
/* Usage and search explain                                                  */
/* ------------------------------------------------------------------------- */

export const RECEIPT_STAGE_VIEWS: readonly { id: string; label: string; description: string; stages: string[] }[] = [
  { id: 'recall', label: '召回候选', description: '检索命中的候选记录（目录可见）', stages: ['prepared', 'retrieved'] },
  { id: 'inject', label: '注入上下文', description: '实际进入模型上下文的记录', stages: ['injected-to-context'] },
  { id: 'request', label: '请求已准备', description: '发出请求前已准备的记录', stages: ['request-prepared'] },
  { id: 'response', label: '响应已观察', description: '观察到响应阶段的记录（不代表采用）', stages: ['response-observed'] },
  { id: 'tool', label: '工具读取', description: '模型通过工具正文读取的记录', stages: ['tool-read'] },
];

export interface StageCount {
  id: string;
  label: string;
  description: string;
  count: number;
  receiptCount: number;
}

export interface OmissionView {
  id: string;
  revision: number | undefined;
  reason: string;
  label: string;
  readRef: JsonObject | undefined;
}

export interface UsageView {
  recorded: boolean;
  runId: string;
  stages: StageCount[];
  rawReceipts: number;
  sourceReads: number;
  omissions: OmissionView[];
  toolReads: number;
  responseObserved: number;
  boundary: string;
}

function usageReceipts(usage: unknown): JsonObject[] {
  const root = object(usage);
  const rows = [...objects(root.receipts), ...objects(root.stageReceipts)];
  const seen = new Map<string, JsonObject>();
  rows.forEach((row, index) => {
    const key = row.operationId ? `${text(row.operationId)}:${text(row.stage)}` : `unkeyed:${index}`;
    if (!seen.has(key)) seen.set(key, row);
  });
  return [...seen.values()];
}

function uniqueRecordKeys(receipts: JsonObject[], stages: string[]): Set<string> {
  const keys = new Set<string>();
  for (const receipt of receipts) {
    if (!stages.includes(text(receipt.stage))) continue;
    for (const record of [...objects(receipt.records), ...objects(receipt.directory)]) {
      const id = text(record.id);
      if (id) keys.add(`${id}:${integer(record.revision) ?? ''}`);
    }
  }
  return keys;
}

export function memoryUsageView(usage: unknown): UsageView {
  const root = object(usage);
  const receipts = usageReceipts(root);
  const stages = RECEIPT_STAGE_VIEWS.map(stage => ({
    id: stage.id,
    label: stage.label,
    description: stage.description,
    count: uniqueRecordKeys(receipts, stage.stages).size,
    receiptCount: receipts.filter(receipt => stage.stages.includes(text(receipt.stage))).length,
  }));
  const omissions = new Map<string, OmissionView>();
  for (const receipt of receipts) {
    for (const omitted of objects(receipt.omitted)) {
      const readRef = object(omitted.readRef);
      const revision = integer(readRef.revision);
      const key = `${text(omitted.id)}:${revision ?? ''}:${text(omitted.reason)}`;
      if (omissions.has(key)) continue;
      const reason = text(omitted.reason) || 'reason-unknown';
      omissions.set(key, {
        id: text(omitted.id),
        revision,
        reason,
        label: EXPLAIN_EXCLUDED_LABELS[reason] || reason,
        readRef: Object.keys(readRef).length ? readRef : undefined,
      });
    }
  }
  return {
    recorded: receipts.length > 0,
    runId: text(root.runId),
    stages,
    rawReceipts: receipts.length + objects(root.sourceReceipts).length,
    sourceReads: objects(root.sourceReceipts).length,
    omissions: [...omissions.values()],
    toolReads: stages.find(stage => stage.id === 'tool')?.count ?? 0,
    responseObserved: stages.find(stage => stage.id === 'response')?.count ?? 0,
    boundary: text(root.evidenceBoundary) || '分别记录召回、注入、请求、响应与工具读取；读取收据不代表模型采纳或答案正确。',
  };
}

export interface ExplainFeatureRow {
  key: string;
  label: string;
  value: number;
}

export interface ExplainMatchView {
  id: string;
  revision: number | undefined;
  score: number | undefined;
  matchedTerms: string[];
  fields: { field: string; terms: string[] }[];
  features: ExplainFeatureRow[];
  reasons: string[];
}

export interface ExplainView {
  available: boolean;
  queryId: string;
  ruleVersion: number | undefined;
  terms: string[];
  intent: string;
  matches: ExplainMatchView[];
  excluded: { id: string; reason: string; label: string }[];
  guidance: string;
  empty: boolean;
  note: string;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function explainFeatures(value: unknown): ExplainFeatureRow[] {
  const features = object(value);
  const rows: ExplainFeatureRow[] = [];
  for (const [key, raw] of Object.entries(features)) {
    const numeric = toNumber(raw);
    if (numeric === undefined) continue;
    rows.push({ key, label: EXPLAIN_FEATURE_LABELS[key] || key, value: Math.round(numeric * 1000) / 1000 });
  }
  return rows.sort((left, right) => {
    const leftIndex = EXPLAIN_FEATURE_ORDER.indexOf(left.key);
    const rightIndex = EXPLAIN_FEATURE_ORDER.indexOf(right.key);
    if (leftIndex !== rightIndex) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    return left.key.localeCompare(right.key);
  });
}

function explainMatch(value: unknown): ExplainMatchView {
  const item = object(value);
  const id = text(item.id) || text(item.recordId) || text(item.memoryId);
  const fields = Object.entries(object(item.fields)).map(([field, terms]) => ({ field, terms: stringList(terms) }));
  const matchedTerms = stringList(item.matchedTerms ?? item.terms).length
    ? stringList(item.matchedTerms ?? item.terms)
    : [...new Set(fields.flatMap(field => field.terms))];
  return {
    id,
    revision: integer(item.revision),
    score: finite(item.score),
    matchedTerms,
    fields,
    features: explainFeatures(item.features ?? object(item.explain).features),
    reasons: stringList(item.reasons ?? object(item.explain).reasons),
  };
}

export function memoryExplainView(value: unknown): ExplainView {
  const root = object(value);
  const matchesRaw = Array.isArray(root.matches) ? root.matches : Array.isArray(root.ranked) ? root.ranked : Array.isArray(root.explain) ? root.explain : [];
  const matches = objects(matchesRaw).map(explainMatch).filter(match => match.id);
  const excluded = objects(root.excluded).map(item => {
    const reason = text(item.reason) || 'reason-unknown';
    return { id: text(item.id) || text(item.recordId), reason, label: EXPLAIN_EXCLUDED_LABELS[reason] || reason };
  });
  const terms = stringList(root.terms ?? root.queryTerms);
  const available = Object.keys(root).length > 0;
  const guidance = text(root.zeroHitGuidance) || text(root.guidance) || (available && matches.length === 0 ? '零命中不代表历史中不存在；尝试更具体的关键词、别名或主题。' : '');
  return {
    available,
    queryId: text(root.queryId),
    ruleVersion: integer(root.ruleVersion),
    terms,
    intent: text(root.intent) || text(object(root.features).intent),
    matches,
    excluded,
    guidance,
    empty: available && matches.length === 0,
    note: '解释只说明排序与排除依据；命中不等于权威，读取收据不代表模型采纳。',
  };
}

export function memoryExplainRequest(query: string, filters: Partial<MemoryRecordFilters> = {}, mode: 'search' | 'explain' = 'explain'): JsonObject {
  return mode === 'explain' ? memorySearchExplainInput(query, filters) : memorySearchInput(query, filters);
}

export function memoryUsageRequest(runId?: string): JsonObject {
  return pruneUndefined({ runId: runId?.trim() || undefined });
}

export function memoryDiagnosticsRequest(runId?: string): JsonObject {
  return pruneUndefined({ runId: runId?.trim() || undefined });
}

/* ------------------------------------------------------------------------- */
/* Settings: auto-publish policy, audit, import/export                       */
/* ------------------------------------------------------------------------- */

export interface AuditView {
  id: string;
  memoryId: string;
  revision: number | undefined;
  action: string;
  actionLabel: string;
  mode: string;
  modeLabel: string;
  score: number | undefined;
  gatesSummary: string;
  trustLabel: string;
  authorityLabel: string;
  policyVersion: number | undefined;
  actor: string;
  createdAt: string;
  revoked: boolean;
  revokedAt: string;
  revokeReason: string;
  revocable: boolean;
  rollbackToken: boolean;
  batchKey: string;
}

const AUDIT_ACTION_LABELS: Record<string, string> = {
  publish: '自动发布',
  candidate: '进入候选',
  downgrade: '策略降级',
  revoke: '撤销发布',
  corrected: '用户更正',
  'auto-revoked': '用户撤销',
};

export function memoryAuditView(value: unknown): AuditView[] {
  return objects(value).map(row => {
    const action = text(row.action);
    const gates = objects(row.gates ?? row.gatesJson ?? row.gates_json);
    const failed = gates.filter(gate => gate.pass === false);
    const revoked = Boolean(text(row.revokedAt) || row.revoked === true);
    return {
      id: text(row.id),
      memoryId: text(row.memoryId) || text(row.memory_id),
      revision: integer(row.revision),
      action,
      actionLabel: AUDIT_ACTION_LABELS[action] || action || '操作未记录',
      mode: text(row.mode),
      modeLabel: AUTO_PUBLISH_MODE_LABELS[text(row.mode)] || text(row.mode) || '模式未记录',
      score: finite(row.score),
      gatesSummary: gates.length === 0 ? '门禁未记录' : failed.length ? `未通过 ${failed.map(gate => `#${integer(gate.id) ?? '?'} ${AUTO_PUBLISH_GATE_LABELS[integer(gate.id) ?? -1] || text(gate.name)}`).join('、')}` : `通过 ${gates.length} 道门禁`,
      trustLabel: memoryTrustLabel(row.trust),
      authorityLabel: memoryAuthorityLabel(row.authority),
      policyVersion: integer(row.policyVersion) ?? integer(row.policy_version),
      actor: text(row.actor),
      createdAt: text(row.createdAt) || text(row.created_at),
      revoked,
      revokedAt: text(row.revokedAt) || text(row.revoked_at),
      revokeReason: text(row.revokeReason) || text(row.revoke_reason),
      revocable: !revoked && action === 'publish',
      rollbackToken: Boolean(text(row.rollbackToken) || text(row.rollback_token)),
      batchKey: text(row.batchKey) || text(row.batch_key),
    };
  }).sort((left, right) => (parseTime(right.createdAt) ?? 0) - (parseTime(left.createdAt) ?? 0));
}

export function memoryAutoPublishSettingsInput(view: AutoPublishView, patch: { mode?: string; minScore?: number; maxAutoPerDay?: number; requireReview?: boolean }): JsonObject {
  const policy = view.policy;
  if (!policy.available || policy.version === undefined) throw new Error('自动发布策略尚未读取，请刷新后再保存。');
  const changes: JsonObject = {};
  if (patch.mode !== undefined) {
    if (!Object.hasOwn(AUTO_PUBLISH_MODE_LABELS, patch.mode)) throw new Error('未知的自动发布模式。');
    changes.mode = patch.mode;
  }
  if (patch.minScore !== undefined) {
    if (!Number.isFinite(patch.minScore) || patch.minScore < 0 || patch.minScore > 100) throw new Error('置信阈值必须在 0 到 100 之间。');
    changes.minScore = Math.round(patch.minScore);
  }
  if (patch.maxAutoPerDay !== undefined) {
    if (!Number.isSafeInteger(patch.maxAutoPerDay) || patch.maxAutoPerDay < 0 || patch.maxAutoPerDay > 10000) throw new Error('每日自动发布上限必须是 0 到 10000 的整数。');
    changes.maxAutoPerDay = patch.maxAutoPerDay;
  }
  if (patch.requireReview !== undefined) {
    if (typeof patch.requireReview !== 'boolean') throw new Error('人工复核开关必须是布尔值。');
    changes.requireReview = patch.requireReview;
  }
  if (Object.keys(changes).length === 0) throw new Error('没有要保存的策略变更。');
  return { expectedVersion: policy.version, ...changes };
}

export interface RevokeSelection {
  ids?: string[];
  batchKey?: string;
  since?: string;
  policyVersion?: number;
  reason?: string;
}

export function memoryAutoPublishRevokeInput(selection: RevokeSelection, audit: AuditView[] = []): JsonObject {
  const ids = [...new Set((selection.ids || []).map(id => id.trim()).filter(Boolean))];
  const batchKey = selection.batchKey?.trim() || '';
  const since = selection.since?.trim() || '';
  if (!ids.length && !batchKey && !since) {
    throw new Error('撤销必须明确选择具体记录、批次或起始时间；不会默认撤销全部自动发布。');
  }
  if (since && !parseTime(since)) throw new Error('撤销起始时间必须是有效时间。');
  if (ids.length) {
    const rows = new Map(audit.map(row => [row.id, row]));
    const unknown = ids.filter(id => rows.size && !rows.has(id) && !audit.some(row => row.memoryId === id));
    if (unknown.length) throw new Error(`撤销列表中有 ${unknown.length} 条不在当前审计中，请刷新后重试。`);
    const locked = audit.filter(row => (ids.includes(row.id) || ids.includes(row.memoryId)) && !row.revocable);
    if (locked.length) throw new Error(`所选记录中有 ${locked.length} 条不可撤销（已撤销或不是自动发布记录）。`);
  }
  return pruneUndefined({
    ids: ids.length ? ids : undefined,
    batchKey: batchKey || undefined,
    since: since || undefined,
    reason: selection.reason?.trim() || undefined,
  });
}

export function memoryExportInput(id?: string): JsonObject {
  if (id !== undefined && !id.trim()) throw new Error('导出指定记录时编号不能为空。');
  return pruneUndefined({ id: id?.trim() || undefined });
}

/** Import never becomes active: status/enabled are forced to candidate/false and actor metadata is stripped. */
export function memoryImportInput(value: unknown): JsonObject {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown; } catch { throw new Error('导入内容不是有效 JSON。'); } })() : value;
  const root = object(parsed);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(root.records) ? root.records : undefined;
  if (!rows) throw new Error('导入内容必须是记录数组，或 {"records":[...]}。');
  if (!rows.length) throw new Error('导入列表为空。');
  if (rows.length > 500) throw new Error('单次最多导入 500 条记录。');
  const records = rows.map((row, index) => {
    const record = object(row);
    const title = text(record.title).trim();
    const content = text(record.content).trim();
    if (!title) throw new Error(`第 ${index + 1} 条缺少标题。`);
    if (!content) throw new Error(`第 ${index + 1} 条缺少正文。`);
    if (content.length > 50000) throw new Error(`第 ${index + 1} 条正文超过 50000 字符。`);
    const {
      trust: _trust, authority: _authority, score: _score, autoPublished: _autoPublished,
      confirmedBy: _confirmedBy, confirmedAt: _confirmedAt, policyId: _policyId, policyVersion: _policyVersion,
      ...safe
    } = record;
    return { ...safe, title, content, status: 'candidate', enabled: false };
  });
  return { records };
}

export interface KindPolicyRow {
  kind: string;
  label: string;
  scopes: string[];
  authority: string;
  ttlDays: number | undefined;
  reviewAfterDays: number | undefined;
  pinnedEligible: boolean | undefined;
  conditionsRequired: boolean | undefined;
  readOnly: true;
}

export function memoryKindPolicyRows(snapshot: unknown): KindPolicyRow[] {
  const root = object(snapshot);
  const source = Array.isArray(root.kindPolicies)
    ? root.kindPolicies
    : Array.isArray(root.kindPolicy)
      ? root.kindPolicy
      : Object.entries(object(root.kindPolicies)).map(([kind, value]) => ({ kind, ...object(value) }));
  return objects(source).map(row => {
    const kind = text(row.kind);
    const scopesValue = row.scopes;
    const scopes = Array.isArray(scopesValue) ? stringList(scopesValue) : [text(row.scope)].filter(Boolean);
    return {
      kind,
      label: memoryKindLabel(kind),
      scopes,
      authority: text(row.authority),
      ttlDays: finite(row.ttlDays),
      reviewAfterDays: finite(row.reviewAfterDays),
      pinnedEligible: truth(row.pinnedEligible),
      conditionsRequired: truth(row.conditionsRequired),
      readOnly: true as const,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Loading / empty / error states                                            */
/* ------------------------------------------------------------------------- */

export type MemoryCenterDataKind = 'loading' | 'error' | 'empty' | 'ready';

export interface MemoryCenterDataState {
  kind: MemoryCenterDataKind;
  message: string;
  retry: boolean;
}

export function memoryCenterEmptyMessage(tab: MemoryCenterTabId, view: MemoryCenterSnapshotView): string {
  switch (tab) {
    case 'overview':
      return view.hasSnapshot
        ? '还没有任何记忆。完成一次会话后，后台学习会在这里生成候选。'
        : '正在读取记忆中心…';
    case 'records':
      return '没有符合筛选条件的记忆。候选与失效记录在“候选”页；检索零命中不代表历史中不存在。';
    case 'candidates':
      return '暂无待处理候选。后台学习完成后，候选会按学习批次分组显示在这里。';
    case 'conflicts':
      return '暂无冲突。同主题不同值的观察会在这里等待裁决。';
    case 'reviews':
      return '暂无到期复审。过期、低用量与自动发布抽样会进入这里。';
    case 'learning':
      return '暂无学习批次。可在会话结束后自动学习，或点击“立即学习”。';
    case 'graph':
      return '暂无可视关系。记录产生父子派生或同主题关系后会显示在这里。';
    case 'usage':
      return '本会话尚无召回收据。没有收据不代表历史中没有相关内容。';
    case 'settings':
      return '自动发布策略尚未读取；刷新后可查看策略、审计与置顶预算。';
  }
}

export function memoryCenterErrorHint(error: string): string {
  const value = error || '';
  if (value.includes('VERSION_CONFLICT') || value.includes('版本已变化') || value.includes('状态已变化')) return '内容或策略版本已变化，请刷新并重新预览后确认。';
  if (value.includes('OPERATION_UNKNOWN')) return '原操作结果未知，先只读核对，不要盲目重放。';
  if (value.includes('BUDGET_EXHAUSTED') || value.includes('预算')) return '预算不足，请缩小范围或先取消部分置顶。';
  if (value.includes('PERMISSION_DENIED')) return '该操作需要用户入口或更高权限。';
  if (value.includes('SOURCE_UNAVAILABLE') || value.includes('来源')) return '来源或依赖不可用，请核对后再继续。';
  if (value.includes('CAPABILITY_UNAVAILABLE')) return '宿主能力暂不可用，请稍后重试或检查配置。';
  if (value.includes('插件不可用') || value.includes('current session')) return '当前会话未启用 Memory；请在设置中开启后重试。';
  if (value.includes('归档会话为只读')) return '归档会话为只读；恢复会话后才能修改记忆。';
  return '操作未完成。请重试；若持续失败，请核对来源与权限。';
}

export function memoryCenterDataState(input: { loading?: boolean; error?: string; snapshot?: unknown; tab?: MemoryCenterTabId }): MemoryCenterDataState {
  const view = memoryCenterSnapshotView(input.snapshot);
  if (input.error) return { kind: 'error', message: input.error, retry: true };
  if (input.loading && !view.hasSnapshot) return { kind: 'loading', message: '正在读取记忆中心…', retry: false };
  if (!view.hasSnapshot) return { kind: 'empty', message: input.tab ? memoryCenterEmptyMessage(input.tab, view) : '尚无记忆数据。', retry: true };
  const tab = input.tab ?? 'overview';
  const empty = tab === 'records' ? view.records.length === 0
    : tab === 'candidates' ? view.candidates.length === 0
      : tab === 'conflicts' ? view.conflicts.length === 0
        : tab === 'reviews' ? view.reviews.length === 0
          : tab === 'learning' ? view.learning.jobs.length === 0
            : false;
  if (empty) return { kind: 'empty', message: memoryCenterEmptyMessage(tab, view), retry: false };
  return { kind: 'ready', message: '', retry: false };
}

/* ------------------------------------------------------------------------- */
/* Action manifest used by the UI and the integration allowlist              */
/* ------------------------------------------------------------------------- */

export type MemoryCenterActionKind = 'read' | 'preview' | 'write';

export interface MemoryCenterAction {
  action: string;
  kind: MemoryCenterActionKind;
  purpose: string;
}

/** Every controller action the Memory Center calls. Lead: verify the desktop allowlist/mutation policy
 * accepts these from `plugin.call` on the user origin (sdk-worker already forwards origin:'user'). */
export const MEMORY_CENTER_ACTIONS: readonly MemoryCenterAction[] = [
  { action: 'snapshot', kind: 'read', purpose: '全量快照（概览/记录/候选/学习/冲突/置顶/自动发布）' },
  { action: 'list', kind: 'read', purpose: '按范围/状态分页列出记录' },
  { action: 'search', kind: 'read', purpose: '记录页搜索' },
  { action: 'search.explain', kind: 'read', purpose: '用量诊断：检索解释与未召回原因' },
  { action: 'read', kind: 'read', purpose: '记录详情与来源原文' },
  { action: 'read.range', kind: 'read', purpose: '分页读取超预算正文' },
  { action: 'versions', kind: 'read', purpose: 'revision 历史与 diff' },
  { action: 'conflict.list', kind: 'read', purpose: '冲突页' },
  { action: 'conflict.resolve', kind: 'write', purpose: '冲突裁决' },
  { action: 'review.list', kind: 'read', purpose: '复审页' },
  { action: 'review.resolve', kind: 'write', purpose: '复审处理（含批量逐条）' },
  { action: 'autoPublish.status', kind: 'read', purpose: '自动发布策略/统计/审计' },
  { action: 'autoPublish.settings', kind: 'write', purpose: '保存自动发布模式/阈值/日限额（CAS expectedVersion）' },
  { action: 'autoPublish.revoke', kind: 'write', purpose: '按记录/批次撤销自动发布' },
  { action: 'feedback', kind: 'write', purpose: '相关/不相关/过时反馈（复用 MemoryFeedbackButtons）' },
  { action: 'pin', kind: 'write', purpose: '置顶（稳定前缀 ≤1500 字符）' },
  { action: 'unpin', kind: 'write', purpose: '取消置顶' },
  { action: 'update', kind: 'write', purpose: '更正（必须携带 previewToken）' },
  { action: 'accept', kind: 'write', purpose: '接受候选' },
  { action: 'toggle', kind: 'write', purpose: '停用/启用（候选拒绝以停用实现）' },
  { action: 'forget', kind: 'write', purpose: '遗忘（必须携带 previewToken）' },
  { action: 'impact.preview', kind: 'preview', purpose: '更正/遗忘影响预览与 token' },
  { action: 'merge', kind: 'write', purpose: '合并两条记录' },
  { action: 'split', kind: 'write', purpose: '拆分记录' },
  { action: 'supersede', kind: 'write', purpose: '用新记录替代旧记录' },
  { action: 'graph', kind: 'read', purpose: '图谱页（rootId/subjectKey/scope/depth≤2）' },
  { action: 'usage', kind: 'read', purpose: '用量诊断收据' },
  { action: 'diagnostics', kind: 'read', purpose: '用量诊断：学习 job 与召回边界' },
  { action: 'learning.status', kind: 'read', purpose: '学习页刷新' },
  { action: 'learning.run', kind: 'write', purpose: '立即学习' },
  { action: 'learning.retry', kind: 'write', purpose: '重试失败批次' },
  { action: 'learning.pause', kind: 'write', purpose: '暂停学习' },
  { action: 'learning.resume', kind: 'write', purpose: '恢复学习' },
  { action: 'export', kind: 'read', purpose: '导出 Markdown' },
  { action: 'import', kind: 'write', purpose: '导入记录（一律候选，不自动生效）' },
];

export function memoryCenterActionKind(action: string): MemoryCenterActionKind | undefined {
  return MEMORY_CENTER_ACTIONS.find(item => item.action === action)?.kind;
}

export function memoryCenterActionsOfKind(kind: MemoryCenterActionKind): string[] {
  return MEMORY_CENTER_ACTIONS.filter(item => item.kind === kind).map(item => item.action);
}

/* ------------------------------------------------------------------------- */
/* Misc helpers                                                              */
/* ------------------------------------------------------------------------- */

export function memoryRecordSummary(record: unknown, max = 120): string {
  return memorySummary(text(object(record).content), max);
}

export function memoryRecordSubject(record: unknown): string {
  const value = object(record);
  return text(value.subjectKey) || text(value.subject) || '未登记主题';
}

/** Stable sort helper for audit rows displayed in the settings table. */
export function memoryAuditRows(view: MemoryCenterSnapshotView): AuditView[] {
  return memoryAuditView(view.autoPublish.audit);
}

export function memoryDetailRevisionDiff(record: unknown, versions: unknown): { available: boolean; currentRevision: number; previousRevision: number | undefined; before: string; after: string; summary: string; changedFields: string[] } {
  const current = object(record);
  const revision = integer(current.revision) ?? 0;
  const history = objects(versions)
    .filter(version => integer(version.revision) !== undefined && (integer(version.revision) as number) < revision)
    .sort((left, right) => (integer(right.revision) as number) - (integer(left.revision) as number));
  const previous = history[0];
  if (!previous) {
    return { available: false, currentRevision: revision, previousRevision: undefined, before: '', after: '', summary: '仅有一个版本，暂无可对比的历史修订。', changedFields: [] };
  }
  const build = (value: JsonObject) => [text(value.title), text(value.content), `条件：${stringList(value.conditions).join('；') || '无'}`, `有效期：${text(value.validFrom) || '未指定'} 至 ${text(value.validTo) || '未指定'}`].join('\n');
  const before = build(previous);
  const after = build(current);
  const changedFields: string[] = [];
  if (text(previous.title) !== text(current.title)) changedFields.push('标题');
  if (text(previous.content) !== text(current.content)) changedFields.push('正文');
  if (stringList(previous.conditions).join('|') !== stringList(current.conditions).join('|')) changedFields.push('适用条件');
  if (text(previous.validFrom) !== text(current.validFrom) || text(previous.validTo) !== text(current.validTo)) changedFields.push('有效期');
  return {
    available: before !== after,
    currentRevision: revision,
    previousRevision: integer(previous.revision),
    before,
    after,
    summary: changedFields.length ? `v${integer(previous.revision)} → v${revision}：${changedFields.join('、')}已变化` : `v${integer(previous.revision)} → v${revision}：内容相同`,
    changedFields,
  };
}

export function memoryDetailSources(record: unknown, originals?: unknown): { sources: { sessionId: string; entryId: string; label: string }[]; originals: { title: string; text: string; error: string }[] } {
  const value = object(record);
  const sources = objects(value.sources).map(source => ({
    sessionId: text(source.sessionId),
    entryId: text(source.entryId),
    label: `${text(source.sessionId) || '未知会话'}/${text(source.entryId) || '未知条目'}`,
  }));
  const result = object(originals);
  const rows = Array.isArray(result.originals) ? result.originals : Array.isArray(originals) ? originals : [];
  return {
    sources,
    originals: objects(rows).map((row, index) => ({
      title: `来源 ${index + 1}`,
      text: text(object(row.item).text),
      error: text(row.error),
    })),
  };
}

export function memoryDerivedRefs(view: MemoryCenterSnapshotView, recordId: string): JsonObject[] {
  return view.derivedRefs.filter(ref => stringList(ref.parentIds).includes(recordId));
}

export function memoryMergeInput(leftId: string, rightId: string, content?: string): JsonObject {
  if (!leftId || !rightId) throw new Error('合并需要两条记录。');
  if (leftId === rightId) throw new Error('不能把一条记录与自身合并。');
  return pruneUndefined({ leftId, rightId, content: content?.trim() || undefined });
}

export interface SplitPartDraft {
  title: string;
  content: string;
  conditions?: string[];
}

export function memorySplitInput(id: string, parts: SplitPartDraft[]): JsonObject {
  if (!id) throw new Error('拆分需要指定记录。');
  if (!Array.isArray(parts) || parts.length < 2) throw new Error('拆分至少需要两个部分。');
  const normalized = parts.map((part, index) => {
    const title = part.title?.trim();
    const content = part.content?.trim();
    if (!title) throw new Error(`第 ${index + 1} 个部分缺少标题。`);
    if (!content) throw new Error(`第 ${index + 1} 个部分缺少正文。`);
    return { title, content, conditions: part.conditions ?? [], sources: [] };
  });
  return { id, parts: normalized };
}

export function memorySupersedeInput(oldId: string, newId: string): JsonObject {
  if (!oldId || !newId) throw new Error('替代需要旧记录与新记录。');
  if (oldId === newId) throw new Error('旧记录与新记录不能相同。');
  return { oldId, newId };
}

export function memoryRecordById(view: MemoryCenterSnapshotView, id: string | undefined): JsonObject | undefined {
  if (!id) return undefined;
  return view.recordById.get(id);
}

export function memoryCountText(value: number | undefined): string {
  return value === undefined ? '未记录' : String(value);
}

export { safeJson as memorySafeJson };
