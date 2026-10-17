/**
 * Memory P0 auto-publish skeleton (P0-SPEC §4).
 *
 * Auto-publish is not "let the model confirm itself". The model only produces a
 * proposal; whether it becomes active is decided by deterministic gates in this
 * module. Everything the gates need is passed in as `CandidateFacts`, so the
 * controller (MemoryController) keeps ownership of how facts are observed and
 * this module stays pure for scoring/deciding:
 *
 *   facts = controller.observe(proposal)   // trust/quote/conflict/audit inputs
 *   decision = decideAutoPublish(facts, policy)
 *   if (decision.status === 'active') store.record({action:'publish', ...})
 *
 * Trust tiers follow blueprint §5.1 and the scoring/gates blueprint §7.3. Policy
 * defaults are the install-profile defaults from P0-SPEC §4.1:
 * fresh installation -> standard, upgraded installation -> conservative.
 *
 * Schema dependency: this store expects the `memory_policies` and
 * `memory_autopublish_audit` tables (and the shared `documents` table for rolling
 * stats) to exist. In production they are created by `ensureMemorySchema`
 * (schema v4); tests create the same DDL locally.
 */
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {CapabilityError,ConflictError,digest} from '../../core/src/index.js';

/** Automatic publication modes, ordered by permissiveness (off < conservative < standard < aggressive). */
export type AutoPublishMode = 'off' | 'conservative' | 'standard' | 'aggressive';

/** Trust tiers from blueprint §5.1, ordered from weakest to strongest. */
export type TrustLevel =
  | 'external_import'
  | 'model_inferred'
  | 'model_supported'
  | 'quote_verified'
  | 'tool_verified'
  | 'source_verified'
  | 'user_confirmed'
  | 'user_explicit';

/** Which capability ultimately backs the record (used for metadata and score sanity). */
export type Authority = 'user' | 'source' | 'tool' | 'model' | 'external' | 'none';

export const AUTO_PUBLISH_MODES: readonly AutoPublishMode[] = ['off', 'conservative', 'standard', 'aggressive'];
export const TRUST_LEVELS: readonly TrustLevel[] = [
  'external_import', 'model_inferred', 'model_supported', 'quote_verified',
  'tool_verified', 'source_verified', 'user_confirmed', 'user_explicit',
];

/** Default daily auto-publish quota (P0-SPEC §4.1). */
export const DEFAULT_MAX_AUTO_PER_DAY = 100;
/** Rolling window used by the automatic downgrade rule (P0-SPEC §4.1). */
export const AUTO_DOWNGRADE_WINDOW_DAYS = 7;
/** `corrected + revoked` in the rolling window that triggers a downgrade. */
export const AUTO_DOWNGRADE_THRESHOLD = 5;

/**
 * Deterministic confidence thresholds (blueprint §7.3): conservative 90,
 * standard 70, aggressive 55. `off` never auto-publishes, so its numeric
 * threshold is +Infinity (the decision short-circuits to candidate first).
 */
export const MODE_THRESHOLDS: Record<AutoPublishMode, number> = {
  off: Number.POSITIVE_INFINITY,
  conservative: 90,
  standard: 70,
  aggressive: 55,
};

/**
 * Trust tiers that may become active in each mode (blueprint §7.1/§7.2).
 * model_inferred / external_import are never auto-published.
 * Type-specific restrictions for model_supported live in gate 5.
 */
export const MODE_ALLOWED_TRUST: Record<AutoPublishMode, TrustLevel[]> = {
  off: [],
  conservative: ['user_explicit', 'user_confirmed'],
  standard: ['user_explicit', 'user_confirmed', 'source_verified', 'tool_verified', 'quote_verified', 'model_supported'],
  aggressive: ['user_explicit', 'user_confirmed', 'source_verified', 'tool_verified', 'quote_verified', 'model_supported'],
};

const MODE_RANK: Record<AutoPublishMode, number> = {off: 0, conservative: 1, standard: 2, aggressive: 3};
const MODEL_TRUST: ReadonlySet<TrustLevel> = new Set(['model_inferred', 'model_supported', 'quote_verified']);
const STRONG_TRUST: ReadonlySet<TrustLevel> = new Set(['user_explicit', 'user_confirmed', 'source_verified', 'tool_verified']);
const KNOWN_KINDS: ReadonlySet<string> = new Set(['fact', 'experience', 'preference', 'profile', 'episode', 'task', 'knowledge']);

const AUTHORITY_SCORE: Record<TrustLevel, number> = {
  user_explicit: 40,
  user_confirmed: 35,
  source_verified: 35,
  tool_verified: 30,
  quote_verified: 10,
  model_supported: 10,
  model_inferred: 0,
  external_import: 0,
};

export interface AutoPublishPolicy {
  id: string;
  projectId: string;
  mode: AutoPublishMode;
  minScore: number;
  maxAutoPerDay: number;
  requireReview: boolean;
  version: number;
  updatedAt: string;
}

/**
 * Everything the deterministic gates are allowed to look at. The controller is
 * responsible for observing these values; the model can never set them.
 *
 * Polarity notes (important for integration):
 * - `quoteVerbatim` / `quoteUnique` / `conditionsComplete` / `correctionEvidence`
 *   / `secretFree` / `piiFree` / `promptInjectionFree` / `userPolicyEnabled` /
 *   `runtimeHealthy` are POSITIVE flags: `true` means "good".
 * - `subjectConflict` is NEGATIVE: `true` means "the candidate conflicts with an
 *   active record of the same subject" (it then needs correction evidence or a
 *   multi cardinality to pass gate 3).
 * - `crossProjectLeak` is NEGATIVE: `true` means "a cross-project leak was
 *   detected" and gate 4 rejects the candidate. Set it to `false` for the
 *   normal in-project/personal case.
 * - `novelty`: 'new' | 'duplicate' | 'merge'; only 'new' passes gate 7.
 * - `subjectCardinality`: 'single' | 'multi' | null (null behaves as 'single'
 *   for conflict gating).
 */
export interface CandidateFacts {
  kind: string;
  trust: TrustLevel;
  authority: Authority;
  quoteVerbatim: boolean;
  quoteUnique: boolean;
  conditionsComplete: boolean;
  subjectKey?: string | null;
  subjectCardinality: 'single' | 'multi' | null;
  subjectConflict: boolean;
  correctionEvidence: boolean;
  secretFree: boolean;
  piiFree: boolean;
  promptInjectionFree: boolean;
  crossProjectLeak: boolean;
  novelty: 'new' | 'duplicate' | 'merge';
  independentSources: number;
  independentProjects: number;
  userPolicyEnabled: boolean;
  autoPublishedToday: number;
  runtimeHealthy: boolean;
}

export interface GateResult {
  id: number;
  name: string;
  pass: boolean;
  reason?: string;
}

export interface ScoreBreakdown {
  authority: number;
  quote: number;
  subject: number;
  independence: number;
  novelty: number;
  total: number;
}

export interface AutoPublishDecision {
  status: 'active' | 'candidate';
  score: number;
  breakdown: ScoreBreakdown;
  gates: GateResult[];
  /** Snapshot of the policy that was evaluated (contains id/version/mode used for the audit row). */
  policy: AutoPublishPolicy;
  reason?: string;
  /** Safety gate 4 failed: never auto-fixable, do not retry without a new proposal. */
  rejected: boolean;
}

/** Input accepted by `evaluateGates`. `dateLimits` extras are optional so the §4.1 signature still works. */
export interface GateContext {
  mode: AutoPublishMode;
  minScore: number;
  /** Daily quota; defaults to DEFAULT_MAX_AUTO_PER_DAY when omitted. */
  maxAutoPerDay?: number;
}

const MODE_SET: ReadonlySet<string> = new Set(AUTO_PUBLISH_MODES);
const TRUST_SET: ReadonlySet<string> = new Set(TRUST_LEVELS);

export function isAutoPublishMode(value: unknown): value is AutoPublishMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

function requireMode(value: unknown, name = '自动发布模式'): AutoPublishMode {
  if (!isAutoPublishMode(value)) throw new CapabilityError('VALIDATION_ERROR', `${name}无效`);
  return value;
}

function requireCount(value: unknown, name: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new CapabilityError('VALIDATION_ERROR', `${name}必须是 0 到 ${max} 的整数`);
  }
  return value;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Subject keys are normalized by the subject registry; this only rejects malformed facts. */
export function isValidAutoPublishSubjectKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('..') && /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function gate(id: number, name: string, pass: boolean, reason?: string): GateResult {
  return pass ? {id, name, pass} : {id, name, pass, reason: reason || '未通过'};
}

/** Deterministic score (blueprint §7.3). Never derived from model self-assessment. */
export function scoreCandidate(facts: CandidateFacts): ScoreBreakdown {
  const authority = TRUST_SET.has(facts.trust) ? AUTHORITY_SCORE[facts.trust] : 0;
  const verbatim = facts.quoteVerbatim === true;
  const unique = facts.quoteUnique === true;
  const conditions = facts.conditionsComplete === true;
  const quote = verbatim && unique && conditions ? 20 : verbatim || unique || conditions ? 10 : 0;
  const rawSubject = typeof facts.subjectKey === 'string' ? facts.subjectKey : '';
  const subject = facts.subjectConflict === true
    ? 0
    : rawSubject.trim().length === 0
      ? 10
      : isValidAutoPublishSubjectKey(rawSubject) ? 20 : 0;
  const independent = Math.max(count(facts.independentSources), count(facts.independentProjects));
  const independence = independent >= 2 ? 10 : independent >= 1 ? 5 : 0;
  const novelty = facts.novelty === 'new' ? 10 : 0;
  return {authority, quote, subject, independence, novelty, total: authority + quote + subject + independence + novelty};
}

/**
 * The ten fixed gates in order. Gate IDs are part of the contract: tests,
 * audit rows and the Memory Center display address gates by ID.
 *
 * 1 authority   - user/source/tool verified; a quote-verified model proposal counts,
 *                 plain model inference/self-assessment and imports do not.
 * 2 quote       - verbatim + unique + complete conditions.
 * 3 subject     - malformed key fails; unresolved single-cardinality conflict fails
 *                 unless the candidate carries correction evidence (supersede) or
 *                 the subject is multi. An absent subject is allowed (scores 10):
 *                 P0-SPEC §4.1 does not gate on subject presence.
 * 4 safety      - secret/PII/prompt-injection/cross-project leak: hard reject.
 * 5 type        - standard: model-sourced profile/preference never auto-publishes;
 *                 aggressive: model-sourced profile/preference needs >=2 independent
 *                 observations. knowledge is handled by gate 9.
 * 6 confidence  - deterministic score >= minScore.
 * 7 novelty     - only 'new' passes; duplicate/merge mean "merge evidence only".
 * 8 user policy - learning/user policy enabled and today's quota not consumed.
 * 9 cross-project - knowledge requires explicit user promotion or >=2 projects.
 * 10 runtime    - healthy learning/runtime state.
 */
export function evaluateGates(facts: CandidateFacts, input: GateContext): GateResult[] {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '门禁参数无效');
  const mode = requireMode(input.mode);
  const minScore = input.minScore;
  if (typeof minScore !== 'number' || Number.isNaN(minScore) || minScore < 0 || minScore > 100) {
    throw new CapabilityError('VALIDATION_ERROR', 'minScore 必须是 0 到 100 的数值');
  }
  const maxAutoPerDay = input.maxAutoPerDay === undefined ? DEFAULT_MAX_AUTO_PER_DAY : requireCount(input.maxAutoPerDay, 'maxAutoPerDay', 10000);
  const kind = typeof facts.kind === 'string' ? facts.kind.trim().toLowerCase() : '';
  const trust = facts.trust;
  const breakdown = scoreCandidate(facts);
  const quoted = facts.quoteVerbatim === true && facts.quoteUnique === true;

  // 1. authority
  const authorityPass = TRUST_SET.has(trust) && (STRONG_TRUST.has(trust) || (trust === 'quote_verified' || trust === 'model_supported') && quoted);
  const authorityReason = !TRUST_SET.has(trust)
    ? `未知信任层级：${String(trust)}`
    : trust === 'model_inferred' || trust === 'external_import'
      ? '模型推断或外部导入不构成自动发布权威'
      : '缺少逐字唯一引文，模型提案不能自证权威';

  // 2. quote
  const quotePass = facts.quoteVerbatim === true && facts.quoteUnique === true && facts.conditionsComplete === true;
  const quoteReason = facts.quoteVerbatim !== true
    ? '缺少逐字引文'
    : facts.quoteUnique !== true ? '引文未能在来源中唯一定位' : '适用条件不完整';

  // 3. subject (P0-SPEC §4.1): an absent subject is NOT a gate failure — the
  // score table gives 10 points for it and the pre-P0 controller already
  // publishes sourced facts without a subject. Gate 3 only rejects a malformed
  // key and unresolved single-cardinality conflicts (supersede needs correction
  // evidence). Requiring a subject for fact/preference/profile would regress the
  // existing 135 memory tests, so that blueprint §6.3 hardening stays P1.
  const hasSubject = typeof facts.subjectKey === 'string' && facts.subjectKey.trim().length > 0;
  const validSubject = hasSubject && isValidAutoPublishSubjectKey(facts.subjectKey);
  const conflict = facts.subjectConflict === true;
  const cardinality = facts.subjectCardinality === 'multi' ? 'multi' : 'single';
  const resolvedByCorrection = facts.correctionEvidence === true;
  const subjectPass = (!hasSubject || validSubject) && !(conflict && cardinality === 'single' && !resolvedByCorrection);
  const subjectReason = hasSubject && !validSubject
    ? 'subject 键未规范化'
    : conflict && cardinality === 'single' && !resolvedByCorrection
      ? '同 subject 单值冲突未裁决且缺少用户更正证据，新值只能作为候选'
      : '未通过';

  // 4. safety (any failure is an irreversible reject)
  const unsafe: string[] = [];
  if (facts.secretFree !== true) unsafe.push('密钥');
  if (facts.piiFree !== true) unsafe.push('PII');
  if (facts.promptInjectionFree !== true) unsafe.push('提示注入');
  if (facts.crossProjectLeak === true) unsafe.push('跨项目泄漏');
  const safetyPass = unsafe.length === 0;

  // 5. type
  const knownKind = KNOWN_KINDS.has(kind);
  const modelSourced = MODEL_TRUST.has(trust);
  const profileLike = kind === 'profile' || kind === 'preference';
  let typePass = knownKind;
  let typeReason = knownKind ? '未通过' : `未知或只读记忆类型：${kind || '(空)'}`;
  if (knownKind && profileLike && modelSourced) {
    if (mode === 'standard') {
      typePass = false;
      typeReason = 'standard 模式不自动发布模型提出的 profile/preference';
    } else if (mode === 'aggressive' && count(facts.independentSources) < 2) {
      typePass = false;
      typeReason = 'aggressive 模式要求模型提出的 profile/preference 具备 ≥2 独立观察';
    }
  }

  // 6. confidence
  const confidencePass = breakdown.total >= minScore;
  const confidenceReason = `确定性分数 ${breakdown.total} 低于阈值 ${minScore}`;

  // 7. novelty
  const noveltyPass = facts.novelty === 'new';
  const noveltyReason = facts.novelty === 'duplicate'
    ? '与已有记忆重复，只合并证据，不新建 active'
    : facts.novelty === 'merge' ? '需要合并到已有记忆，不新建 active' : `未知新颖度：${String(facts.novelty)}`;

  // 8. user policy + daily quota
  const today = count(facts.autoPublishedToday);
  const policyPass = facts.userPolicyEnabled === true && today < maxAutoPerDay;
  const policyReason = facts.userPolicyEnabled !== true
    ? '用户策略未开启该类型/项目的自动发布'
    : `今日自动发布额度已用完（${today}/${maxAutoPerDay}）`;

  // 9. cross-project knowledge
  const knowledgePass = kind !== 'knowledge' || trust === 'user_explicit' || count(facts.independentProjects) >= 2;
  const knowledgeReason = 'knowledge 需要用户显式提升或 ≥2 个项目独立支持';

  // 10. runtime
  const runtimePass = facts.runtimeHealthy === true;
  const runtimeReason = '学习运行态不健康（预算/租约/source fence/epoch）';

  return [
    gate(1, 'authority', authorityPass, authorityReason),
    gate(2, 'quote', quotePass, quoteReason),
    gate(3, 'subject', subjectPass, subjectReason),
    gate(4, 'safety', safetyPass, unsafe.length ? `检测到不可自动修复内容：${unsafe.join('、')}` : undefined),
    gate(5, 'type', typePass, typeReason),
    gate(6, 'confidence', confidencePass, confidenceReason),
    gate(7, 'novelty', noveltyPass, noveltyReason),
    gate(8, 'user-policy', policyPass, policyReason),
    gate(9, 'cross-project', knowledgePass, knowledgeReason),
    gate(10, 'runtime', runtimePass, runtimeReason),
  ].map(result => result);
}

function validatePolicy(policy: AutoPublishPolicy): void {
  if (!policy || typeof policy !== 'object') throw new CapabilityError('VALIDATION_ERROR', '自动发布策略无效');
  requireMode(policy.mode);
  // `off` short-circuits before the score gate, so MODE_THRESHOLDS.off (+Infinity)
  // is accepted there only; every publishing mode needs a real 0..100 threshold.
  const threshold = policy.minScore;
  const offInfinity = policy.mode === 'off' && threshold === Number.POSITIVE_INFINITY;
  if (!offInfinity && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)) {
    throw new CapabilityError('VALIDATION_ERROR', '策略 minScore 必须是 0 到 100 的数值');
  }
  requireCount(policy.maxAutoPerDay, '策略 maxAutoPerDay', 10000);
  if (typeof policy.requireReview !== 'boolean') throw new CapabilityError('VALIDATION_ERROR', '策略 requireReview 必须是布尔值');
}

function failureSummary(failed: GateResult[]): string {
  return failed.map(item => `#${item.id} ${item.name}${item.reason ? `（${item.reason}）` : ''}`).join('；');
}

/**
 * Final deterministic decision (blueprint §7.4):
 * - mode `off` -> always candidate;
 * - any gate failure -> candidate (safety failure also sets `rejected:true`);
 * - all gates pass but trust is not allowed in the mode -> candidate;
 * - policy requires human review -> candidate (P0 keeps the record out of active
 *   until a review queue exists, P1);
 * - otherwise active.
 */
export function decideAutoPublish(facts: CandidateFacts, policy: AutoPublishPolicy): AutoPublishDecision {
  validatePolicy(policy);
  const breakdown = scoreCandidate(facts);
  // `off` never auto-publishes; a finite threshold keeps gate telemetry well formed.
  const gateMinScore = Number.isFinite(policy.minScore) ? policy.minScore : 100;
  const gates = evaluateGates(facts, {mode: policy.mode, minScore: gateMinScore, maxAutoPerDay: policy.maxAutoPerDay});
  const failed = gates.filter(item => !item.pass);
  const rejected = failed.some(item => item.id === 4);
  const policySnapshot: AutoPublishPolicy = {...policy};
  if (policy.mode === 'off') {
    return {status: 'candidate', score: breakdown.total, breakdown, gates, policy: policySnapshot, reason: '自动发布模式为 off，全部进入候选', rejected: false};
  }
  if (failed.length) {
    return {status: 'candidate', score: breakdown.total, breakdown, gates, policy: policySnapshot, reason: `未通过门禁 ${failureSummary(failed)}`, rejected};
  }
  if (!MODE_ALLOWED_TRUST[policy.mode].includes(facts.trust)) {
    return {status: 'candidate', score: breakdown.total, breakdown, gates, policy: policySnapshot, reason: `信任层级 ${facts.trust} 不允许在 ${policy.mode} 模式自动发布`, rejected: false};
  }
  if (policy.requireReview) {
    return {status: 'candidate', score: breakdown.total, breakdown, gates, policy: policySnapshot, reason: '策略要求人工复核后才发布', rejected: false};
  }
  return {status: 'active', score: breakdown.total, breakdown, gates, policy: policySnapshot, rejected: false};
}

// ---------------------------------------------------------------------------
// Durable policy / audit store
// ---------------------------------------------------------------------------

/** One audit row. Field order mirrors `memory_autopublish_audit` (P0-SPEC §2.4). */
export interface AuditRow {
  id: string;
  projectId: string;
  memoryId: string;
  revision: number;
  action: string;
  mode: AutoPublishMode;
  policyId: string;
  policyVersion: number;
  score: number | null;
  gates: unknown[];
  trust: TrustLevel | null;
  authority: Authority | null;
  jobId: string | null;
  actor: string;
  before: unknown;
  after: unknown;
  rollbackToken: string | null;
  batchKey: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

/** Input accepted by `AutoPublishStore.record`. `publish` rows get a rollback token automatically. */
export interface AuditInput {
  projectId: string;
  memoryId: string;
  revision: number;
  /** 'publish' | 'candidate' | 'downgrade' | ... bounded lowercase token. */
  action: string;
  mode: AutoPublishMode;
  policyId: string;
  policyVersion: number;
  score?: number | null;
  gates?: readonly unknown[];
  trust?: TrustLevel | null;
  authority?: Authority | null;
  jobId?: string | null;
  actor: string;
  before?: unknown;
  after?: unknown;
  batchKey?: string | null;
}

export interface RevokeInput {
  projectId: string;
  /** Audit row ids or memory ids of publish rows. */
  ids?: string[];
  batchKey?: string;
  policyVersion?: number;
  since?: string;
  actor: 'user';
  reason?: string;
}

export interface AutoPublishStats {
  autoPublished: number;
  revoked: number;
  corrected: number;
  mode?: AutoPublishMode;
}

export interface RollingStats {corrected: number; revoked: number; windowStart: string}

const POLICY_TABLE = 'memory_policies';
const AUDIT_TABLE = 'memory_autopublish_audit';
const DOCUMENTS_TABLE = 'documents';
const STATS_KEY_PREFIX = 'autopublish-stats:';
const AUDIT_COLUMNS = 'id,project_id,memory_id,revision,action,mode,policy_id,policy_version,score,gates_json,trust,authority,job_id,actor,before_json,after_json,rollback_token,batch_key,created_at,revoked_at,revoke_reason';
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

function policyIdFor(projectId: string): string {
  return `autopublish:${projectId}`;
}

function modeFromRow(value: unknown): AutoPublishMode {
  return requireMode(value, '已存储的策略模式');
}

function trustOrNull(value: unknown): TrustLevel | null {
  return typeof value === 'string' && TRUST_SET.has(value) ? value as TrustLevel : null;
}

function authorityOrNull(value: unknown): Authority | null {
  return value === 'user' || value === 'source' || value === 'tool' || value === 'model' || value === 'external' || value === 'none' ? value : null;
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function policyFromRow(row: Record<string, unknown>): AutoPublishPolicy {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    mode: modeFromRow(row.mode),
    minScore: Number(row.min_score),
    maxAutoPerDay: Number(row.max_auto_per_day),
    requireReview: Number(row.require_review) === 1,
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
}

function auditFromRow(row: Record<string, unknown>): AuditRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    memoryId: String(row.memory_id),
    revision: Number(row.revision),
    action: String(row.action),
    mode: modeFromRow(row.mode),
    policyId: String(row.policy_id),
    policyVersion: Number(row.policy_version),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    gates: parseJsonArray(row.gates_json),
    trust: trustOrNull(row.trust),
    authority: authorityOrNull(row.authority),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    actor: String(row.actor),
    before: parseJsonValue(row.before_json),
    after: parseJsonValue(row.after_json),
    rollbackToken: row.rollback_token === null || row.rollback_token === undefined ? null : String(row.rollback_token),
    batchKey: row.batch_key === null || row.batch_key === undefined ? null : String(row.batch_key),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    revokeReason: row.revoke_reason === null || row.revoke_reason === undefined ? null : String(row.revoke_reason),
  };
}

/**
 * SQLite-backed policy, audit, rolling-stats and revoke store.
 *
 * The caller owns the transaction boundary: pass the controller's live
 * `RecordStore.db` connection so policy/audit writes commit atomically with the
 * memory record changes the controller performs around them. Nested transactions
 * are honored (`BEGIN IMMEDIATE` only when no transaction is active).
 */
export class AutoPublishStore {
  private readonly now: () => string;

  constructor(private readonly db: DatabaseSync, options: {now?: () => string} = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    for (const table of [DOCUMENTS_TABLE, POLICY_TABLE, AUDIT_TABLE]) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new CapabilityError('CAPABILITY_UNAVAILABLE', `自动发布需要 ${table} 表，请先执行 schema v4 迁移`);
      }
    }
  }

  private transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private projectId(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
      throw new CapabilityError('VALIDATION_ERROR', 'projectId 无效');
    }
    return value;
  }

  private policyRow(projectId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT id,project_id,mode,min_score,max_auto_per_day,require_review,version,updated_at FROM memory_policies WHERE id=?').get(policyIdFor(projectId)) as Record<string, unknown> | undefined;
  }

  private readStats(projectId: string): RollingStats | undefined {
    const row = this.db.prepare("SELECT json FROM documents WHERE namespace='memory' AND key=?").get(`${STATS_KEY_PREFIX}${projectId}`);
    if (!row) return undefined;
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(row.json));
      value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      throw new CapabilityError('VALIDATION_ERROR', '自动发布滚动统计记录已损坏');
    }
    const windowStart = typeof value.windowStart === 'string' && Number.isFinite(Date.parse(value.windowStart))
      ? value.windowStart
      : new Date(0).toISOString();
    return {corrected: count(value.corrected), revoked: count(value.revoked), windowStart};
  }

  private writeStats(projectId: string, stats: RollingStats): void {
    this.db.prepare("INSERT INTO documents(namespace,key,revision,json) VALUES('memory',?,1,?) ON CONFLICT(namespace,key) DO UPDATE SET revision=documents.revision+1,json=excluded.json")
      .run(`${STATS_KEY_PREFIX}${projectId}`, JSON.stringify({corrected: stats.corrected, revoked: stats.revoked, windowStart: stats.windowStart}));
  }

  private rollingStats(projectId: string, nowMs: number): RollingStats {
    const saved = this.readStats(projectId);
    const nowIso = new Date(nowMs).toISOString();
    if (!saved) return {corrected: 0, revoked: 0, windowStart: nowIso};
    const started = Date.parse(saved.windowStart);
    if (!Number.isFinite(started) || nowMs - started >= AUTO_DOWNGRADE_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return {corrected: 0, revoked: 0, windowStart: nowIso};
    }
    return saved;
  }

  /**
   * First call creates the install-profile default policy:
   * fresh -> standard (threshold 70), upgraded -> conservative (threshold 90).
   * Existing policies are never overwritten by a later install-profile guess.
   */
  resolvePolicy(projectId: string, installProfile: 'fresh' | 'upgraded'): AutoPublishPolicy {
    const project = this.projectId(projectId);
    if (installProfile !== 'fresh' && installProfile !== 'upgraded') {
      throw new CapabilityError('VALIDATION_ERROR', '安装画像必须是 fresh 或 upgraded');
    }
    const existing = this.policyRow(project);
    if (existing) return policyFromRow(existing);
    const mode: AutoPublishMode = installProfile === 'fresh' ? 'standard' : 'conservative';
    const minScore = MODE_THRESHOLDS[mode];
    return this.transaction(() => {
      const raced = this.policyRow(project);
      if (raced) return policyFromRow(raced);
      const id = policyIdFor(project);
      this.db.prepare('INSERT OR IGNORE INTO memory_policies(id,project_id,scope,kind,mode,min_score,max_auto_per_day,allowed_trust_json,require_review,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, project, '*', '*', mode, minScore, DEFAULT_MAX_AUTO_PER_DAY, JSON.stringify(MODE_ALLOWED_TRUST[mode]), 0, 1, this.now());
      const row = this.policyRow(project);
      if (!row) throw new CapabilityError('CAPABILITY_UNAVAILABLE', '自动发布策略写入失败');
      return policyFromRow(row);
    });
  }

  /**
   * Compare-and-swap policy update. When `mode` changes without an explicit
   * `minScore`, the mode's deterministic threshold is applied (aggressive -> 55,
   * standard -> 70, conservative -> 90); `off` keeps the stored threshold since
   * the decision short-circuits before the score gate.
   */
  updatePolicy(projectId: string, patch: {mode?: AutoPublishMode; minScore?: number; maxAutoPerDay?: number; requireReview?: boolean}, expectedVersion: number): AutoPublishPolicy {
    const project = this.projectId(projectId);
    if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new CapabilityError('VALIDATION_ERROR', 'expectedVersion 必须是正整数');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CapabilityError('VALIDATION_ERROR', '策略补丁必须是对象');
    const keys = Object.keys(patch);
    if (!keys.length) throw new CapabilityError('VALIDATION_ERROR', '策略补丁不能为空');
    const allowed = new Set(['mode', 'minScore', 'maxAutoPerDay', 'requireReview']);
    for (const key of keys) if (!allowed.has(key)) throw new CapabilityError('VALIDATION_ERROR', `未知策略字段：${key}`);
    if (patch.mode !== undefined) requireMode(patch.mode);
    if (patch.minScore !== undefined && (typeof patch.minScore !== 'number' || !Number.isSafeInteger(patch.minScore) || patch.minScore < 0 || patch.minScore > 100)) {
      throw new CapabilityError('VALIDATION_ERROR', 'minScore 必须是 0 到 100 的整数');
    }
    if (patch.maxAutoPerDay !== undefined) requireCount(patch.maxAutoPerDay, 'maxAutoPerDay', 10000);
    if (patch.requireReview !== undefined && typeof patch.requireReview !== 'boolean') throw new CapabilityError('VALIDATION_ERROR', 'requireReview 必须是布尔值');
    return this.transaction(() => {
      const row = this.policyRow(project);
      if (!row) throw new CapabilityError('VALIDATION_ERROR', '自动发布策略不存在，请先解析默认策略');
      const current = policyFromRow(row);
      if (current.version !== expectedVersion) throw new ConflictError();
      const mode = patch.mode ?? current.mode;
      const minScore = patch.minScore ?? (patch.mode !== undefined && mode !== 'off' ? MODE_THRESHOLDS[mode] : current.minScore);
      const maxAutoPerDay = patch.maxAutoPerDay ?? current.maxAutoPerDay;
      const requireReview = patch.requireReview ?? current.requireReview;
      this.db.prepare('UPDATE memory_policies SET mode=?,min_score=?,max_auto_per_day=?,allowed_trust_json=?,require_review=?,version=?,updated_at=? WHERE id=?')
        .run(mode, minScore, maxAutoPerDay, JSON.stringify(MODE_ALLOWED_TRUST[mode]), requireReview ? 1 : 0, current.version + 1, this.now(), row.id as string);
      const updated = this.policyRow(project);
      if (!updated) throw new CapabilityError('CAPABILITY_UNAVAILABLE', '自动发布策略更新失败');
      return policyFromRow(updated);
    });
  }

  /**
   * Number of auto-published audit rows created inside the current LOCAL day.
   * Revoked rows still count: the daily quota is consumption, not final state.
   */
  countAutoPublishedToday(projectId: string): number {
    const project = this.projectId(projectId);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new CapabilityError('VALIDATION_ERROR', '当前时间无效');
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 1);
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM memory_autopublish_audit WHERE project_id=? AND action='publish' AND created_at>=? AND created_at<?")
      .get(project, start.toISOString(), end.toISOString());
    return Number(row?.total ?? 0);
  }

  /** Append one audit row. `publish` rows receive the §4.1 rollback token. */
  record(input: AuditInput): AuditRow {
    const project = this.projectId(input.projectId);
    if (typeof input.action !== 'string' || !/^[a-z][a-z0-9._-]{0,39}$/.test(input.action)) {
      throw new CapabilityError('VALIDATION_ERROR', '审计动作无效');
    }
    if (typeof input.memoryId !== 'string' || input.memoryId.length === 0 || input.memoryId.length > 200) {
      throw new CapabilityError('VALIDATION_ERROR', '审计 memoryId 无效');
    }
    if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0) {
      throw new CapabilityError('VALIDATION_ERROR', '审计 revision 无效');
    }
    const mode = requireMode(input.mode);
    if (typeof input.policyId !== 'string' || input.policyId.length === 0 || input.policyId.length > 200) {
      throw new CapabilityError('VALIDATION_ERROR', '审计 policyId 无效');
    }
    if (typeof input.policyVersion !== 'number' || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1) {
      throw new CapabilityError('VALIDATION_ERROR', '审计 policyVersion 无效');
    }
    const score = input.score === undefined || input.score === null ? null : requireCount(input.score, '审计 score', 100);
    if (input.gates !== undefined && !Array.isArray(input.gates)) throw new CapabilityError('VALIDATION_ERROR', '审计 gates 必须是数组');
    const trust = input.trust === undefined || input.trust === null ? null : (TRUST_SET.has(input.trust) ? input.trust : (() => { throw new CapabilityError('VALIDATION_ERROR', '审计 trust 无效'); })());
    const authority = input.authority === undefined || input.authority === null ? null : input.authority;
    if (authority !== null && !['user', 'source', 'tool', 'model', 'external', 'none'].includes(authority)) throw new CapabilityError('VALIDATION_ERROR', '审计 authority 无效');
    if (typeof input.actor !== 'string' || input.actor.trim().length === 0 || input.actor.length > 100) {
      throw new CapabilityError('VALIDATION_ERROR', '审计 actor 无效');
    }
    const jobId = input.jobId === undefined || input.jobId === null ? null : String(input.jobId);
    const batchKey = input.batchKey === undefined || input.batchKey === null ? null : String(input.batchKey);
    if (jobId !== null && jobId.length > 200) throw new CapabilityError('VALIDATION_ERROR', '审计 jobId 无效');
    if (batchKey !== null && batchKey.length > 200) throw new CapabilityError('VALIDATION_ERROR', '审计 batchKey 无效');
    const id = randomUUID();
    const createdAt = this.now();
    const rollbackToken = input.action === 'publish' ? digest([project, input.memoryId, input.revision, input.policyVersion, createdAt]) : null;
    this.db.prepare('INSERT INTO memory_autopublish_audit(id,project_id,memory_id,revision,action,mode,policy_id,policy_version,score,gates_json,trust,authority,job_id,actor,before_json,after_json,rollback_token,batch_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, project, input.memoryId, input.revision, input.action, mode, input.policyId, input.policyVersion, score, JSON.stringify(input.gates ?? []), trust, authority, jobId, input.actor.trim(), input.before === undefined ? null : JSON.stringify(input.before), input.after === undefined ? null : JSON.stringify(input.after), rollbackToken, batchKey, createdAt);
    const row = this.db.prepare(`SELECT ${AUDIT_COLUMNS} FROM memory_autopublish_audit WHERE id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) throw new CapabilityError('CAPABILITY_UNAVAILABLE', '审计记录写入失败');
    return auditFromRow(row);
  }

  listAudit(projectId: string, options: {memoryId?: string; batchKey?: string; policyVersion?: number; since?: string; limit?: number} = {}): AuditRow[] {
    const project = this.projectId(projectId);
    const where = ['project_id=?'];
    const parameters: (string | number)[] = [project];
    if (options.memoryId !== undefined) {
      if (typeof options.memoryId !== 'string' || !options.memoryId) throw new CapabilityError('VALIDATION_ERROR', 'memoryId 无效');
      where.push('memory_id=?');
      parameters.push(options.memoryId);
    }
    if (options.batchKey !== undefined) {
      if (typeof options.batchKey !== 'string' || !options.batchKey) throw new CapabilityError('VALIDATION_ERROR', 'batchKey 无效');
      where.push('batch_key=?');
      parameters.push(options.batchKey);
    }
    if (options.policyVersion !== undefined) {
      if (typeof options.policyVersion !== 'number' || !Number.isSafeInteger(options.policyVersion) || options.policyVersion < 1) {
        throw new CapabilityError('VALIDATION_ERROR', 'policyVersion 无效');
      }
      where.push('policy_version=?');
      parameters.push(options.policyVersion);
    }
    if (options.since !== undefined) {
      const since = typeof options.since === 'string' ? Date.parse(options.since) : Number.NaN;
      if (!Number.isFinite(since)) throw new CapabilityError('VALIDATION_ERROR', 'since 必须是有效时间');
      where.push('created_at>=?');
      parameters.push(new Date(since).toISOString());
    }
    const limit = options.limit === undefined ? DEFAULT_LIST_LIMIT : (() => {
      if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIST_LIMIT) {
        throw new CapabilityError('VALIDATION_ERROR', `limit 必须是 1 到 ${MAX_LIST_LIMIT} 的整数`);
      }
      return options.limit;
    })();
    return (this.db.prepare(`SELECT ${AUDIT_COLUMNS} FROM memory_autopublish_audit WHERE ${where.join(' AND ')} ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(...parameters, limit) as Record<string, unknown>[]).map(auditFromRow);
  }

  /**
   * Revoke auto-published rows by audit id/memory id, batch, policy version or
   * time window. Only unrevoked `publish` rows are touched; repeated calls are
   * idempotent (they return an empty list). The store does NOT modify memory
   * records, versions or suppression: the controller applies inactive +
   * auto-revoked suppression after every returned row, in the same transaction.
   */
  revoke(input: RevokeInput): AuditRow[] {
    const project = this.projectId(input.projectId);
    if (input.actor !== 'user') throw new CapabilityError('PERMISSION_DENIED', '撤回自动发布必须由用户操作');
    const ids = input.ids;
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
        throw new CapabilityError('VALIDATION_ERROR', 'ids 必须是有界的非空字符串数组');
      }
    }
    const batchKey = input.batchKey;
    if (batchKey !== undefined && (typeof batchKey !== 'string' || !batchKey)) throw new CapabilityError('VALIDATION_ERROR', 'batchKey 无效');
    const policyVersion = input.policyVersion;
    if (policyVersion !== undefined && (typeof policyVersion !== 'number' || !Number.isSafeInteger(policyVersion) || policyVersion < 1)) {
      throw new CapabilityError('VALIDATION_ERROR', 'policyVersion 无效');
    }
    const since = input.since === undefined ? undefined : (() => {
      const parsed = typeof input.since === 'string' ? Date.parse(input.since) : Number.NaN;
      if (!Number.isFinite(parsed)) throw new CapabilityError('VALIDATION_ERROR', 'since 必须是有效时间');
      return new Date(parsed).toISOString();
    })();
    if (ids === undefined && batchKey === undefined && policyVersion === undefined && since === undefined) {
      throw new CapabilityError('VALIDATION_ERROR', '撤回必须指定 ids、batchKey、policyVersion 或 since');
    }
    const reason = input.reason === undefined ? null : (typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 500) : null);
    return this.transaction(() => {
      const where = ["project_id=?", "action='publish'", 'revoked_at IS NULL'];
      const parameters: (string | number)[] = [project];
      if (ids) {
        const placeholders = ids.map(() => '?').join(',');
        where.push(`(id IN (${placeholders}) OR memory_id IN (${placeholders}))`);
        parameters.push(...ids, ...ids);
      }
      if (batchKey !== undefined) { where.push('batch_key=?'); parameters.push(batchKey); }
      if (policyVersion !== undefined) { where.push('policy_version=?'); parameters.push(policyVersion); }
      if (since !== undefined) { where.push('created_at>=?'); parameters.push(since); }
      const matched = this.db.prepare(`SELECT id FROM memory_autopublish_audit WHERE ${where.join(' AND ')} ORDER BY created_at,rowid`).all(...parameters) as Record<string, unknown>[];
      const revokedAt = this.now();
      const update = this.db.prepare('UPDATE memory_autopublish_audit SET revoked_at=?,revoke_reason=? WHERE id=? AND revoked_at IS NULL');
      const rows: AuditRow[] = [];
      for (const match of matched) {
        update.run(revokedAt, reason, String(match.id));
        const row = this.db.prepare(`SELECT ${AUDIT_COLUMNS} FROM memory_autopublish_audit WHERE id=?`).get(String(match.id)) as Record<string, unknown> | undefined;
        if (row) rows.push(auditFromRow(row));
      }
      return rows;
    });
  }

  /** Totals plus the 7-day rolling corrected count and the current mode. */
  stats(projectId: string): AutoPublishStats {
    const project = this.projectId(projectId);
    const total = this.db.prepare("SELECT COUNT(*) AS total FROM memory_autopublish_audit WHERE project_id=? AND action='publish'").get(project);
    const revoked = this.db.prepare("SELECT COUNT(*) AS total FROM memory_autopublish_audit WHERE project_id=? AND action='publish' AND revoked_at IS NOT NULL").get(project);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new CapabilityError('VALIDATION_ERROR', '当前时间无效');
    const rolling = this.rollingStats(project, nowMs);
    const policy = this.policyRow(project);
    return {
      autoPublished: Number(total?.total ?? 0),
      revoked: Number(revoked?.total ?? 0),
      corrected: rolling.corrected,
      ...(policy ? {mode: policyFromRow(policy).mode} : {}),
    };
  }

  /** Record one user correction and apply the rolling automatic downgrade rule. */
  noteCorrection(projectId: string, memoryId: string): {downgraded: boolean; mode?: AutoPublishMode} {
    if (typeof memoryId !== 'string' || memoryId.length === 0 || memoryId.length > 200) {
      throw new CapabilityError('VALIDATION_ERROR', 'memoryId 无效');
    }
    return this.bumpRolling(projectId, 'corrected', 1);
  }

  /** Record `count` revoked auto-publications and apply the same rolling rule. */
  noteRevoke(projectId: string, countValue: number): {downgraded: boolean; mode?: AutoPublishMode} {
    const amount = requireCount(countValue, '撤回数量', 10000);
    if (amount === 0) {
      const project = this.projectId(projectId);
      const policy = this.policyRow(project);
      return {downgraded: false, ...(policy ? {mode: policyFromRow(policy).mode} : {})};
    }
    return this.bumpRolling(projectId, 'revoked', amount);
  }

  private bumpRolling(projectId: string, field: 'corrected' | 'revoked', amount: number): {downgraded: boolean; mode?: AutoPublishMode} {
    const project = this.projectId(projectId);
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new CapabilityError('VALIDATION_ERROR', '当前时间无效');
    return this.transaction(() => {
      const rolling = this.rollingStats(project, nowMs);
      const next: RollingStats = {...rolling, [field]: rolling[field] + amount};
      const row = this.policyRow(project);
      const currentMode = row ? policyFromRow(row).mode : undefined;
      let downgraded = false;
      let mode = currentMode;
      if (currentMode && MODE_RANK[currentMode] > MODE_RANK.conservative && next.corrected + next.revoked >= AUTO_DOWNGRADE_THRESHOLD) {
        mode = currentMode === 'aggressive' ? 'standard' : 'conservative';
        downgraded = true;
        const minScore = MODE_THRESHOLDS[mode];
        const nextVersion = policyFromRow(row!).version + 1;
        this.db.prepare('UPDATE memory_policies SET mode=?,min_score=?,allowed_trust_json=?,version=?,updated_at=? WHERE id=?')
          .run(mode, minScore, JSON.stringify(MODE_ALLOWED_TRUST[mode]), nextVersion, new Date(nowMs).toISOString(), row!.id as string);
        this.record({
          projectId: project,
          memoryId: '*',
          revision: 0,
          action: 'downgrade',
          mode,
          policyId: policyIdFor(project),
          policyVersion: nextVersion,
          actor: 'system',
          gates: [],
          after: {mode, minScore, corrected: next.corrected, revoked: next.revoked, windowStart: next.windowStart},
        });
        this.writeStats(project, {corrected: 0, revoked: 0, windowStart: new Date(nowMs).toISOString()});
        return {downgraded: true, mode};
      }
      this.writeStats(project, next);
      return {downgraded, ...(mode ? {mode} : {})};
    });
  }
}
