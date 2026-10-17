/**
 * Memory P2 retrieval: intent-aware ranking, pinned/body/directory budgets and
 * explain output (P1-P4-SPEC §2.1, blueprint §10 "检索、排序与注入（无向量）").
 *
 * This module is deliberately PURE: it has no runtime import from `./index.js`
 * or `packages/core` and never tokenizes, queries SQLite or calls a model. The
 * controller keeps ownership of candidate generation (FTS5 BM25, exact tiers,
 * task context, feedback, conflict/stale/duplicate flags, lifecycle columns) and
 * passes the already computed features in as {@link RankCandidate}s. That lets
 * the Lead wire ranking/budget/explain into `query()`/`select()`/`recall()`
 * incrementally while all P0 retrieval semantics stay in one place.
 *
 * Ranking formula (blueprint §10.3, weights are overridable by policy):
 *
 *   score = 4.0*exact + 3.0*subject + 2.0*bm25Normalized + 2.0*taskContextMatch
 *         + 1.5*feedback + 1.5*scopePrecedence + 1.0*trust + 1.0*recency
 *         - 3.0*conflict - 2.0*stale - 1.0*duplicate
 *         + intentType(0.75) * graded intent/type priority
 *         + lifecycle adjustment for recallWeight/decay (neutral at 1.0/1.0)
 *
 * `DEFAULT_RANK_WEIGHTS` mirrors the blueprint exactly (penalty weights are
 * stored as positive magnitudes and subtracted). With neutral lifecycle inputs
 * (`recallWeight: 1`, `decay: 1`) the total equals the blueprint formula plus
 * the intent boost, so the controller can choose whether to expose lifecycle
 * downranking here or pre-normalize the features before calling.
 *
 * Budget contract (blueprint §10.5):
 * - pinned is a separate stable tier (<=1500 chars) and never counts against
 *   the body budget or the body record count;
 * - directory entries are pointers with a `readRef` and never contain a body;
 * - body + complete conditions are admitted together or omitted with a
 *   `readRef` — no truncation and no condition dropping;
 * - count default 6, hard max 8; preference priority hook moves up to 2
 *   applicable explicit preferences to the front of the body tier.
 */

/** Query intent used for type prioritisation (blueprint §10.4 intent table). */
export type RecallIntent = 'how-to' | 'decision' | 'identity' | 'current-task' | 'cross-project' | 'general';

/**
 * Preferred memory kinds per intent, in priority order (blueprint §10.4).
 * `general` has no specific priority, so every kind receives no intent boost.
 */
export const INTENT_TYPES: Record<RecallIntent, string[]> = {
  'how-to': ['experience', 'fact', 'episode'],
  decision: ['fact', 'episode', 'knowledge'],
  identity: ['profile', 'preference'],
  'current-task': ['task', 'episode', 'fact'],
  'cross-project': ['knowledge', 'profile'],
  general: [],
};

/**
 * Deterministic first-match precedence for {@link detectIntent}: earlier intents
 * win when a query contains cues for several of them (e.g. "当前任务为什么…"
 * is a current-task question, "其他项目怎么做" is cross-project).
 */
export const INTENT_PRECEDENCE: readonly RecallIntent[] = [
  'current-task',
  'identity',
  'cross-project',
  'decision',
  'how-to',
];

interface IntentPattern {
  intent: RecallIntent;
  pattern: RegExp;
}

const INTENT_PATTERNS: readonly IntentPattern[] = [
  {
    intent: 'current-task',
    pattern:
      /(?:当前任务|现在的任务|当前目标|正在做|做到哪|还没(?:有)?完成|未完成|下一步|接下来(?:做|要)|待办|检查点|进度|继续上次|继续上一步|上次做到|current\s+task|next\s+step|todo|remaining|checkpoint|where\s+(?:were|are)\s+we)/iu,
  },
  {
    intent: 'identity',
    pattern:
      /(?:我是谁|我的(?:偏好|习惯|风格|语言|角色|身份|目标)|关于我|称呼我|怎么称呼我|和我(?:合作|沟通|相处)|沟通(?:方式|风格)|回答(?:风格|格式|语言)|个人偏好|who\s+am\s+i|about\s+me|my\s+(?:preference|preferences|style|language|role|habit)|how\s+should\s+you\s+(?:work|talk|communicate)\s+with\s+me|call\s+me)/iu,
  },
  {
    intent: 'cross-project',
    pattern:
      /(?:其他项目|别的项目|另一个项目|其它项目|以前的?项目|之前的?项目|跨项目|通用(?:经验|知识|做法|模式|规则)|可复用|复用|在别处|other\s+projects?|another\s+project|cross[-\s]?project|elsewhere|reus(?:e|able)|general\s+pattern)/iu,
  },
  {
    intent: 'decision',
    pattern:
      /(?:决定了?什么|决定|决策|选定|选择了?|采用|为什么(?:用|选)|架构选型|技术选型|方案|约定|规范|decid(?:e|ed|ing)|decision|chose|chosen|agreed|agreement|we\s+picked|why\s+(?:did\s+we|do\s+we)\s+(?:choose|pick|use))/iu,
  },
  {
    intent: 'how-to',
    pattern:
      /(?:怎么|如何|怎样|咋|报错|错误|异常|失败|排查|修复|解决|配置|设置|安装|运行|调试|命令|步骤|流程|how\s+(?:to|do|can|should)|troubleshoot|error|exception|failure|fix|configure|setup|debug|command|step)/iu,
  },
];

/**
 * Classify a search query into one of the six recall intents. Pure lexical rules
 * (no model, no rewriting) so the result is deterministic and explainable.
 */
export function detectIntent(query: string): RecallIntent {
  const text = normalizeQueryText(query);
  if (!text) return 'general';
  for (const entry of INTENT_PATTERNS) {
    if (entry.pattern.test(text)) return entry.intent;
  }
  return 'general';
}

function normalizeQueryText(query: unknown): string {
  if (typeof query !== 'string') return '';
  return query.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Everything the controller knows about a retrieval candidate. All numeric
 * features must already be normalized by the caller:
 * - `exact` 0..4 (controller exact/literal tiers, higher is better),
 * - `subjectMatch`/`taskContextMatch`/`scopePrecedence`/`recency` 0..1,
 * - `bm25` normalized 0..1 (translate the FTS rank/score once, not here),
 * - `feedbackScore` -1..1 (relevant +1 / irrelevant -1 / outdated <0 / none 0),
 * - `recallWeight` kind recall weight (neutral 1), `decay` retention 0..1
 *   (neutral 1; only values below 1 downrank).
 */
export interface RankCandidate {
  id: string;
  kind: string;
  scope: string;
  status: string;
  subjectKey?: string | null;
  aliases: string[];
  title: string;
  content: string;
  conditions: string[];
  trust?: string | null;
  bm25: number;
  exact: number;
  subjectMatch: number;
  taskContextMatch: number;
  feedbackScore: number;
  scopePrecedence: number;
  recency: number;
  conflict: boolean;
  stale: boolean;
  duplicate: boolean;
  pinned: boolean;
  pinnedChars: number;
  recallWeight: number;
  decay: number;
  useCount: number;
}

/** Policy-tunable ranking weights (blueprint §10.3). */
export interface RankWeights {
  exact: number;
  subject: number;
  bm25: number;
  context: number;
  feedback: number;
  scope: number;
  trust: number;
  recency: number;
  conflict: number;
  stale: number;
  duplicate: number;
  intentType: number;
}

/**
 * Blueprint §10.3 weights plus the P2 `intentType` boost (0.75).
 * `conflict`/`stale`/`duplicate` are positive penalty magnitudes and are
 * subtracted from the score.
 */
export const DEFAULT_RANK_WEIGHTS: RankWeights = {
  exact: 4,
  subject: 3,
  bm25: 2,
  context: 2,
  feedback: 1.5,
  scope: 1.5,
  trust: 1,
  recency: 1,
  conflict: 3,
  stale: 2,
  duplicate: 1,
  intentType: 0.75,
};

/**
 * Graded boost per position in {@link INTENT_TYPES}[intent]; keeps the
 * blueprint "A > B > C" priority semantics without a binary tie.
 */
export const INTENT_TYPE_PRIORITY_BOOSTS: readonly number[] = [1, 0.6, 0.3];

/**
 * Fixed trust feature values 0..1. Controller should pass the record trust tier
 * (`user_explicit`/`user_confirmed`/...); legacy records without a tier fall
 * back to `unknown` (0.2), never to the strongest tier.
 */
export const TRUST_SCORE: Record<string, number> = {
  user_explicit: 1,
  user_confirmed: 0.9,
  source_verified: 0.8,
  tool_verified: 0.75,
  quote_verified: 0.5,
  model_supported: 0.4,
  model_inferred: 0.2,
  external_import: 0.1,
  unknown: 0.2,
};

/**
 * Additive lifecycle adjustments outside the blueprint formula. Neutral inputs
 * (recallWeight 1, decay 1) contribute exactly 0, so the blueprint formula is
 * reproduced; `decay < 1` downranks low-retention records (P1-P4-SPEC §2.2).
 */
export const LIFECYCLE_WEIGHTS = { recallWeight: 1, decay: 1 } as const;

/** Ranking/budget/explain rule version exposed by search.explain (spec: 3). */
export const RETRIEVAL_RULE_VERSION = 3;

/** Round scores to 6 decimals so repeated runs and JSON output are identical. */
function roundScore(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function trustScore(trust: string | null | undefined): number {
  if (typeof trust !== 'string' || !trust) return TRUST_SCORE.unknown!;
  return TRUST_SCORE[trust.toLowerCase()] ?? TRUST_SCORE.unknown!;
}

function intentTypeBoost(kind: string, intent: RecallIntent): number {
  if (typeof kind !== 'string' || !kind) return 0;
  const index = INTENT_TYPES[intent].indexOf(kind.toLowerCase());
  if (index < 0) return 0;
  return INTENT_TYPE_PRIORITY_BOOSTS[index] ?? 0;
}

interface Evaluation {
  score: number;
  features: Record<string, number>;
  contributions: Record<string, number>;
}

const SCORE_CONTRIBUTION_KEYS = [
  'exact',
  'subject',
  'bm25',
  'context',
  'feedback',
  'scope',
  'trust',
  'recency',
  'conflict',
  'stale',
  'duplicate',
  'intentType',
  'recallWeight',
  'decay',
] as const;

function evaluateCandidate(candidate: RankCandidate, intent: RecallIntent, weights: RankWeights): Evaluation {
  const exact = clamp(finiteNumber(candidate.exact, 0), 0, 4);
  const subject = clamp(finiteNumber(candidate.subjectMatch, 0), 0, 1);
  const bm25 = clamp(finiteNumber(candidate.bm25, 0), 0, 1);
  const context = clamp(finiteNumber(candidate.taskContextMatch, 0), 0, 1);
  const feedback = clamp(finiteNumber(candidate.feedbackScore, 0), -1, 1);
  const scope = clamp(finiteNumber(candidate.scopePrecedence, 0), 0, 1);
  const trust = trustScore(candidate.trust);
  const recency = clamp(finiteNumber(candidate.recency, 0), 0, 1);
  const conflict = candidate.conflict === true ? 1 : 0;
  const stale = candidate.stale === true ? 1 : 0;
  const duplicate = candidate.duplicate === true ? 1 : 0;
  const intentBoost = intentTypeBoost(candidate.kind, intent);
  const recallWeight = clamp(finiteNumber(candidate.recallWeight, 1), 0, 2);
  const decay = clamp(finiteNumber(candidate.decay, 1), 0, 1);

  // Feature keys mirror the RankCandidate field names so downstream explain
  // rendering (desktop Memory Center) can label them without a translation map.
  // `subject`/`context`/`feedback`/`scope` are the RankWeights names, the raw
  // values stay `subjectMatch`/`taskContextMatch`/`feedbackScore`/`scopePrecedence`.
  const features: Record<string, number> = {
    exact,
    subjectMatch: subject,
    bm25,
    taskContextMatch: context,
    feedbackScore: feedback,
    scopePrecedence: scope,
    trust,
    recency,
    conflict,
    stale,
    duplicate,
    intentType: intentBoost,
    recallWeight,
    decay,
    pinned: candidate.pinned === true ? 1 : 0,
    pinnedChars: finiteNumber(candidate.pinnedChars, 0),
    useCount: finiteNumber(candidate.useCount, 0),
  };

  const contributions: Record<string, number> = {
    exact: weights.exact * exact,
    subject: weights.subject * subject,
    bm25: weights.bm25 * bm25,
    context: weights.context * context,
    feedback: weights.feedback * feedback,
    scope: weights.scope * scope,
    trust: weights.trust * trust,
    recency: weights.recency * recency,
    conflict: -weights.conflict * conflict,
    stale: -weights.stale * stale,
    duplicate: -weights.duplicate * duplicate,
    intentType: weights.intentType * intentBoost,
    recallWeight: LIFECYCLE_WEIGHTS.recallWeight * (recallWeight - 1),
    decay: LIFECYCLE_WEIGHTS.decay * (decay - 1),
  };

  let total = 0;
  for (const key of SCORE_CONTRIBUTION_KEYS) total += contributions[key]!;
  return { score: roundScore(total), features, contributions };
}

function resolveWeights(overrides?: Partial<RankWeights>): RankWeights {
  const resolved: RankWeights = { ...DEFAULT_RANK_WEIGHTS };
  if (overrides === undefined) return resolved;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!(key in DEFAULT_RANK_WEIGHTS)) throw new RangeError(`未知的排名权重：${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new RangeError(`排名权重 ${key} 必须为非负有限数字`);
    }
    resolved[key as keyof RankWeights] = value;
  }
  return resolved;
}

/** Score one candidate; returns the score and the raw feature values used. */
export function scoreCandidate(
  candidate: RankCandidate,
  intent: RecallIntent,
  weights?: Partial<RankWeights>,
): { score: number; features: Record<string, number> } {
  if (!isRecallIntent(intent)) throw new RangeError(`未知的召回意图：${String(intent)}`);
  const evaluation = evaluateCandidate(candidate, intent, resolveWeights(weights));
  return { score: evaluation.score, features: { ...evaluation.features } };
}

function isRecallIntent(value: unknown): value is RecallIntent {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTENT_TYPES, value);
}

function formatSigned(value: number): string {
  const magnitude = Math.abs(value) < 0.005 ? 0 : value;
  return `${magnitude >= 0 ? '+' : ''}${magnitude.toFixed(2)}`;
}

function explainReasons(
  candidate: RankCandidate,
  intent: RecallIntent,
  evaluation: Evaluation,
  weights: RankWeights,
): string[] {
  const { features, contributions } = evaluation;
  const reasons: string[] = [];
  const push = (key: keyof typeof contributions, label: string): void => {
    const contribution = contributions[key]!;
    if (Math.abs(contribution) < 1e-9) return;
    reasons.push(`${label} ${formatSigned(contribution)}`);
  };
  push('exact', `精确匹配（tier ${features.exact}）`);
  push('subject', `subject 主题命中（${features.subjectMatch.toFixed(2)}）`);
  push('bm25', `BM25 词法相关（${features.bm25.toFixed(3)}）`);
  push('context', `任务上下文匹配（${features.taskContextMatch.toFixed(2)}）`);
  push('feedback', `用户反馈（${features.feedbackScore.toFixed(2)}）`);
  push('scope', `范围优先级（${features.scopePrecedence.toFixed(2)}）`);
  push('trust', `信任层级 ${candidate.trust ?? 'unknown'}（${features.trust.toFixed(2)}）`);
  push('recency', `新鲜度（${features.recency.toFixed(2)}）`);
  if (features.conflict > 0) reasons.push(`存在未裁决冲突，扣分 ${formatSigned(contributions.conflict!)}`);
  if (features.stale > 0) reasons.push(`记录已过时，扣分 ${formatSigned(contributions.stale!)}`);
  if (features.duplicate > 0) reasons.push(`重复记录，扣分 ${formatSigned(contributions.duplicate!)}`);
  const intentIndex = INTENT_TYPES[intent].indexOf(candidate.kind);
  if (Math.abs(contributions.intentType!) >= 1e-9) {
    reasons.push(
      `意图 ${intent} 的优先类型 ${candidate.kind}（第 ${intentIndex + 1} 位），加权 ${formatSigned(contributions.intentType!)}`,
    );
  }
  if (Math.abs(contributions.recallWeight!) >= 1e-9) {
    reasons.push(`类型召回权重 ×${features.recallWeight.toFixed(2)}，调整 ${formatSigned(contributions.recallWeight!)}`);
  }
  if (Math.abs(contributions.decay!) >= 1e-9) {
    reasons.push(`生命周期衰减 ×${features.decay.toFixed(2)}，调整 ${formatSigned(contributions.decay!)}`);
  }
  if (candidate.pinned === true) {
    reasons.push(`置顶候选（独立稳定前缀，${formatChars(features.pinnedChars)}，不计入正文预算）`);
  }
  if (candidate.duplicate === true && weights.duplicate === 0) reasons.push('重复标记已命中（当前策略未扣分）');
  reasons.push(`综合分 ${evaluation.score.toFixed(2)}（检索规则 v${RETRIEVAL_RULE_VERSION}）`);
  return reasons;
}

function formatChars(value: number): string {
  return `${Math.round(value)} 字符`;
}

/**
 * Rank candidates by the blueprint formula (+ intent/lifecycle adjustments) and
 * return an explain entry per returned candidate. Stable and deterministic:
 * ties fall back to exact tier, subject match, BM25 and then id.
 */
export function rankCandidates<T extends RankCandidate>(
  candidates: T[],
  input: { intent: RecallIntent; weights?: Partial<RankWeights>; limit?: number },
): {
  ranked: T[];
  explain: { id: string; score: number; features: Record<string, number>; reasons: string[] }[];
} {
  if (!Array.isArray(candidates)) throw new RangeError('candidates 必须为数组');
  if (!input || !isRecallIntent(input.intent)) throw new RangeError(`未知的召回意图：${String(input?.intent)}`);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new RangeError('limit 必须为非负整数');
  }
  const weights = resolveWeights(input.weights);
  const evaluated = candidates.map(candidate => ({ candidate, evaluation: evaluateCandidate(candidate, input.intent, weights) }));
  evaluated.sort((left, right) => {
    const a = left.evaluation;
    const b = right.evaluation;
    return (
      b.score - a.score ||
      b.features.exact! - a.features.exact! ||
      b.features.subjectMatch! - a.features.subjectMatch! ||
      b.features.bm25! - a.features.bm25! ||
      left.candidate.id.localeCompare(right.candidate.id)
    );
  });
  const selected = input.limit === undefined ? evaluated : evaluated.slice(0, input.limit);
  return {
    ranked: selected.map(entry => entry.candidate),
    explain: selected.map(entry => ({
      id: entry.candidate.id,
      score: entry.evaluation.score,
      features: { ...entry.evaluation.features },
      reasons: explainReasons(entry.candidate, input.intent, entry.evaluation, weights),
    })),
  };
}

/** Budget tiers from blueprint §10.5 (characters for the three char budgets). */
export interface BudgetTiers {
  pinned: number;
  directory: number;
  body: number;
  count: number;
}

/** Blueprint §10.5 defaults: pinned 1500 / directory 1500 / body 3500 / 6 records. */
export const DEFAULT_BUDGETS: BudgetTiers = { pinned: 1500, directory: 1500, body: 3500, count: 6 };

/** Blueprint §10.5 hard maximum record count ("≤6，最多 8"). */
export const MAX_BUDGET_COUNT = 8;

/** Personal preference priority hook: at most 2 applicable preferences first. */
export const MAX_PRIORITY_PREFERENCES = 2;

const CONDITIONS_LABEL = '\n适用条件：';

/**
 * Characters a whole record costs in pinned/body tiers: the complete body plus
 * its complete conditions (matches the existing `select()` body accounting).
 * Export this so the controller can also populate `RankCandidate.pinnedChars`
 * and usage receipts from the same definition.
 */
export function renderedRecordChars(record: { content: string; conditions?: string[] }): number {
  const content = typeof record.content === 'string' ? record.content : '';
  const conditions = Array.isArray(record.conditions)
    ? record.conditions.filter((condition): condition is string => typeof condition === 'string')
    : [];
  return content.length + (conditions.length ? CONDITIONS_LABEL.length + conditions.join('；').length : 0);
}

/** Minimum shape applyBudget needs; extra metadata is copied to pointers. */
export interface BudgetRecord {
  id: string;
  revision: number;
  content: string;
  /** Optional so existing `MemoryRecord` (conditions?: string[]) is accepted. */
  conditions?: string[];
  pinned?: boolean;
  title?: string;
  kind?: string;
  scope?: string;
  subjectKey?: string | null;
  aliases?: string[];
  trust?: string | null;
  expiresAt?: string | null;
  reviewAfter?: string;
}

/** Directory pointer: visible pointer/conditions only, body stays behind readRef. */
export interface BudgetDirectoryPointer {
  id: string;
  revision: number;
  fullLength: number;
  readRef: { action: 'read.range'; id: string; revision: number };
  title?: string;
  kind?: string;
  scope?: string;
  subjectKey?: string;
  aliases?: string[];
  conditions?: string[];
  /** Warning only (e.g. `review-due`/`expired`), never an exclusion. */
  reason?: string;
}

/** Body omission: no truncation, the exact revision is read via readRef. */
export interface BudgetOmission {
  id: string;
  reason: string;
  readRef: { action: 'read.range'; id: string; revision: number };
}

export interface BudgetResult<T> {
  pinned: T[];
  directory: BudgetDirectoryPointer[];
  body: T[];
  omitted: BudgetOmission[];
  used: { pinned: number; directory: number; body: number };
}

export interface BudgetMeasure<T> {
  pinned?: (record: T) => number;
  directory?: (record: T) => number;
  body?: (record: T) => number;
}

export interface BudgetInput<T> {
  budget?: Partial<BudgetTiers>;
  /**
   * Applicable explicit preference ids, in priority order. The first up to
   * {@link MAX_PRIORITY_PREFERENCES} are moved to the front of the body tier.
   * When provided, a `kind === 'preference'` record that is not listed is
   * treated as applicability-unknown: directory pointer only, omitted with
   * reason `preference-applicability-unknown` (existing P0 select semantics).
   */
  preferenceIds?: string[];
  /** Deterministic clock for directory review/expiry warnings. */
  now?: number;
  /** Optional measurement hooks (e.g. size the full directory entry). */
  measure?: BudgetMeasure<T>;
}

function resolveBudgetTiers(partial?: Partial<BudgetTiers>): BudgetTiers {
  const resolved: BudgetTiers = { ...DEFAULT_BUDGETS };
  if (partial === undefined) return resolved;
  for (const key of ['pinned', 'directory', 'body', 'count'] as const) {
    const value = partial[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new RangeError(`budget.${key} 必须为非负整数`);
    }
    resolved[key] = key === 'count' ? Math.min(value, MAX_BUDGET_COUNT) : value;
  }
  return resolved;
}

function measureTier<T>(measure: (record: T) => number, record: T, label: string): number {
  const value = measure(record);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} 必须返回非负有限数字`);
  }
  return value;
}

function pointerWarningReason(record: BudgetRecord, now: number): string | undefined {
  if (typeof record.expiresAt === 'string') {
    const expiresAt = Date.parse(record.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return 'expired';
  }
  if (typeof record.reviewAfter === 'string') {
    const reviewAfter = Date.parse(record.reviewAfter);
    if (Number.isFinite(reviewAfter) && reviewAfter <= now) return 'review-due';
  }
  return undefined;
}

function directoryPointer<T extends BudgetRecord>(record: T, now: number): BudgetDirectoryPointer {
  const pointer: BudgetDirectoryPointer = {
    id: record.id,
    revision: record.revision,
    fullLength: typeof record.content === 'string' ? record.content.length : 0,
    readRef: { action: 'read.range', id: record.id, revision: record.revision },
  };
  if (typeof record.title === 'string') pointer.title = record.title;
  if (typeof record.kind === 'string') pointer.kind = record.kind;
  if (typeof record.scope === 'string') pointer.scope = record.scope;
  if (typeof record.subjectKey === 'string' && record.subjectKey) pointer.subjectKey = record.subjectKey;
  if (Array.isArray(record.aliases) && record.aliases.length) {
    pointer.aliases = record.aliases.filter((alias): alias is string => typeof alias === 'string');
  }
  if (Array.isArray(record.conditions) && record.conditions.length) pointer.conditions = [...record.conditions];
  const reason = pointerWarningReason(record, now);
  if (reason) pointer.reason = reason;
  return pointer;
}

const readRefFor = (record: BudgetRecord): BudgetDirectoryPointer['readRef'] => ({
  action: 'read.range',
  id: record.id,
  revision: record.revision,
});

/**
 * Apply the three budget tiers to an already ranked candidate list.
 *
 * 1. pinned first (separate stable prefix; never counted in body/directory);
 * 2. directory pointers for all non-pinned records that fit (readRef included);
 * 3. body records with complete conditions, count limit, and preference
 *    priority; anything that does not fit is omitted with a readRef instead of
 *    being truncated.
 */
export function applyBudget<T extends BudgetRecord>(records: T[], input: BudgetInput<T> = {}): BudgetResult<T> {
  if (!Array.isArray(records)) throw new RangeError('records 必须为数组');
  const tiers = resolveBudgetTiers(input.budget);
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  let preferenceIds: string[] | undefined;
  if (input.preferenceIds !== undefined) {
    if (!Array.isArray(input.preferenceIds)) throw new RangeError('preferenceIds 必须为字符串数组');
    preferenceIds = [
      ...new Set(input.preferenceIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
    ];
  }
  const pinnedCharsOf = input.measure?.pinned ?? renderedRecordChars;
  const bodyCharsOf = input.measure?.body ?? renderedRecordChars;
  const directoryCharsOf = input.measure?.directory ?? ((record: T) => JSON.stringify(directoryPointer(record, now)).length);

  const pinned: T[] = [];
  const directory: BudgetDirectoryPointer[] = [];
  const body: T[] = [];
  const omitted: BudgetOmission[] = [];
  const used = { pinned: 0, directory: 0, body: 0 };
  const nonPinned: T[] = [];

  for (const record of records) {
    if (record.pinned !== true) {
      nonPinned.push(record);
      continue;
    }
    const cost = measureTier(pinnedCharsOf, record, 'measure.pinned');
    if (used.pinned + cost <= tiers.pinned) {
      pinned.push(record);
      used.pinned += cost;
    } else {
      omitted.push({ id: record.id, reason: 'pinned-budget', readRef: readRefFor(record) });
    }
  }

  for (const record of nonPinned) {
    const cost = measureTier(directoryCharsOf, record, 'measure.directory');
    if (used.directory + cost <= tiers.directory) {
      directory.push(directoryPointer(record, now));
      used.directory += cost;
    } else {
      omitted.push({ id: record.id, reason: 'directory-budget', readRef: readRefFor(record) });
    }
  }

  const priority: T[] = [];
  const byId = new Map<string, T>();
  for (const record of nonPinned) if (!byId.has(record.id)) byId.set(record.id, record);
  if (preferenceIds !== undefined) {
    for (const id of preferenceIds) {
      if (priority.length >= MAX_PRIORITY_PREFERENCES) break;
      const record = byId.get(id);
      if (record && !priority.some(item => item.id === record.id)) priority.push(record);
    }
  }
  const priorityIds = new Set(priority.map(record => record.id));
  const ordered: T[] = [...priority, ...nonPinned.filter(record => !priorityIds.has(record.id))];
  const applicablePreferences = new Set(preferenceIds ?? []);

  for (const record of ordered) {
    if (preferenceIds !== undefined && record.kind === 'preference' && !applicablePreferences.has(record.id)) {
      omitted.push({ id: record.id, reason: 'preference-applicability-unknown', readRef: readRefFor(record) });
      continue;
    }
    if (body.length >= tiers.count) {
      omitted.push({ id: record.id, reason: 'record-limit', readRef: readRefFor(record) });
      continue;
    }
    const cost = measureTier(bodyCharsOf, record, 'measure.body');
    if (used.body + cost > tiers.body) {
      omitted.push({ id: record.id, reason: 'body-budget', readRef: readRefFor(record) });
      continue;
    }
    body.push(record);
    used.body += cost;
  }

  return { pinned, directory, body, omitted, used };
}

/** Fixed boundary text for a zero-hit search (no invented memories/values). */
export const ZERO_HIT_BOUNDARY =
  '零命中：当前项目记忆库没有与本次查询匹配的已登记有效记录。这不代表历史不存在，也不代表用户没有说过；不得据此编造原始值、记忆或扩大范围搜索。';

/** At most this many suggested keywords/aliases/subjects are echoed back. */
export const MAX_GUIDANCE_SUGGESTIONS = 8;

/**
 * Explain a zero-hit search without fabricating: boundary text plus only the
 * candidate keywords/aliases/subjects the caller already knows (from the query
 * or the subject registry). Never invents a memory id, value or claim.
 */
export function zeroHitGuidance(input: { terms: string[]; subjects: string[]; aliases: string[] }): string {
  const terms = uniqueSuggestions(input?.terms);
  const subjects = uniqueSuggestions(input?.subjects);
  const aliases = uniqueSuggestions(input?.aliases);
  const lines = [ZERO_HIT_BOUNDARY];
  if (terms.length) lines.push(`建议关键词：${terms.join('、')}`);
  if (subjects.length) lines.push(`建议 subject：${subjects.join('、')}`);
  if (aliases.length) lines.push(`建议别名：${aliases.join('、')}`);
  if (!terms.length && !subjects.length && !aliases.length) {
    lines.push('建议提供 1–3 个有区分度关键词（实体、错误码、函数名或代码路径）后重试；不要猜测原始值。');
  }
  lines.push('命中仍须核对来源、适用条件与当前版本；可用 read.range 读取完整正文与全部条件。');
  return lines.join('\n');
}

function uniqueSuggestions(values: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  if (!Array.isArray(values)) return result;
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const value = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_GUIDANCE_SUGGESTIONS) break;
  }
  return result;
}

/** search.explain rule version (spec §2.1: 3). */
export function explainRuleVersion(): number {
  return RETRIEVAL_RULE_VERSION;
}
