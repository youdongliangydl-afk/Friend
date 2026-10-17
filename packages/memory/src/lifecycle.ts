/**
 * P1 lifecycle: expiry, retention/decay scoring, archive threshold and the
 * review queue candidate builder (P1-P4-SPEC §1.2, blueprint-v1 §11 + §15).
 *
 * Standalone and deterministic: no controller/database import, `now` is always
 * injectable as epoch milliseconds. The controller maps its rows into
 * `LifecycleRecord` and turns the returned candidates into `memory_reviews`
 * rows; it remains the only writer.
 */
import { kindPolicy } from './kinds.js';

export interface LifecycleRecord {
  id: string;
  kind: string;
  status: string;
  enabled: boolean;
  trust?: string | null;
  conditions?: string[];
  reviewAfter?: string;
  expiresAt?: string;
  useCount?: number;
  lastUsedAt?: string;
  feedbackScore?: number;
  updatedAt: string;
  validFrom?: string | null;
  validTo?: string | null;
  /**
   * Additive P1 extension: DB rows always carry a monotonically increasing
   * `revision` and `ReviewCandidate` needs it. Defaults to 1 when omitted so
   * hand-built fixtures stay valid.
   */
  revision?: number;
}

export type ReviewReason =
  | 'expired'
  | 'review-after'
  | 'low-use'
  | 'negative-feedback'
  | 'autopublish-sample'
  | 'conflict-open'
  | 'dream-proposal'
  | 'stale-source';

export interface ReviewCandidate {
  memoryId: string;
  revision: number;
  reason: ReviewReason;
  priority: number;
  dueAt: string;
  notes?: string;
}

/** All review reasons in stable order; controllers/UI use it for filters. */
export const REVIEW_REASONS: ReviewReason[] = [
  'expired', 'review-after', 'low-use', 'negative-feedback',
  'autopublish-sample', 'conflict-open', 'dream-proposal', 'stale-source',
];

/** Deterministic priority per reason (higher = review sooner). */
const REVIEW_PRIORITY: Record<ReviewReason, number> = {
  expired: 90,
  'stale-source': 85,
  'conflict-open': 80,
  'review-after': 70,
  'negative-feedback': 60,
  'dream-proposal': 50,
  'low-use': 40,
  'autopublish-sample': 30,
};

/** Below this retention an active record becomes archive-eligible (after its TTL). */
export const ARCHIVE_RETENTION_THRESHOLD = 0.25;
/** Default review queue limit (P1-P4-SPEC §1.2). */
export const DEFAULT_REVIEW_LIMIT = 50;
/** Records used fewer than this many times and older than the low-use window need review. */
export const LOW_USE_MAX = 2;
/** Feedback at or below this score (2 net negative signals) triggers review. */
export const NEGATIVE_FEEDBACK_THRESHOLD = -2;

const DAY_MS = 86_400_000;

const TRUST_RETENTION: Record<string, number> = {
  user_explicit: 1.0,
  user_confirmed: 0.9,
  source_verified: 0.8,
  tool_verified: 0.75,
  quote_verified: 0.6,
  model_supported: 0.4,
  model_inferred: 0.25,
  external_import: 0.3,
};
const DEFAULT_TRUST_RETENTION = 0.5;

/** Half-life used by the age decay factor; blueprint §11: 180d (episode 60d). */
const DECAY_HALF_LIFE_DAYS: Record<string, number> = {
  profile: 180, preference: 180, fact: 180, experience: 90,
  episode: 60, task: 14, knowledge: 180,
};
const DEFAULT_DECAY_HALF_LIFE_DAYS = 180;
/** Half-life of the last-used recency factor (older use fades, floored at 0.5). */
const RECENCY_HALF_LIFE_DAYS = 90;
const RECENCY_NEVER_USED = 0.8;
const RECENCY_FLOOR = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function normalizeNow(now: unknown): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function recordRevision(record: LifecycleRecord): number {
  return typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1;
}

/** True when `expiresAt <= now` (invalid/missing expiry is not expired). */
export function isExpired(record: LifecycleRecord, now: number = Date.now()): boolean {
  if (!record || typeof record !== 'object') return false;
  const expires = parseTime(record.expiresAt);
  return expires !== undefined && expires <= normalizeNow(now);
}

function decayHalfLifeDays(kind: string): number {
  return DECAY_HALF_LIFE_DAYS[kind] ?? DEFAULT_DECAY_HALF_LIFE_DAYS;
}

function ageDaysAt(record: LifecycleRecord, now: number): number {
  const anchor = parseTime(record.updatedAt);
  if (anchor === undefined) return 0;
  return Math.max(0, (now - anchor) / DAY_MS);
}

function recencyFactor(lastUsedAt: unknown, now: number): number {
  const used = parseTime(lastUsedAt);
  if (used === undefined) return RECENCY_NEVER_USED;
  const ageDays = Math.max(0, (now - used) / DAY_MS);
  return clamp(Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS), RECENCY_FLOOR, 1);
}

/**
 * Retention score in [0,1] = trust × age decay × usage × feedback × recency
 * (blueprint §11 / P1-P4-SPEC §1.2). Pure, total and monotone in every factor:
 * higher trust/use/feedback and newer age/last-use never lower the score.
 */
export function retentionScore(record: LifecycleRecord, now: number = Date.now()): number {
  if (!record || typeof record !== 'object') return 0;
  const nowMs = normalizeNow(now);
  const trust = TRUST_RETENTION[typeof record.trust === 'string' ? record.trust : ''] ?? DEFAULT_TRUST_RETENTION;
  const decay = Math.pow(0.5, ageDaysAt(record, nowMs) / decayHalfLifeDays(record.kind));
  const usage = Math.min(1, 0.5 + 0.1 * count(record.useCount));
  const rawFeedback = typeof record.feedbackScore === 'number' && Number.isFinite(record.feedbackScore) ? record.feedbackScore : 0;
  const feedback = clamp(1 + 0.1 * rawFeedback, 0.5, 1.5);
  const recency = recencyFactor(record.lastUsedAt, nowMs);
  return clamp(trust * decay * usage * feedback * recency, 0, 1);
}

/**
 * Archive eligibility (blueprint §11): active, retention below the threshold
 * and older than the kind TTL. Archive is not deletion; it only sets inactive
 * and keeps the record restorable.
 */
export function needsArchive(record: LifecycleRecord, now: number = Date.now()): boolean {
  if (!record || typeof record !== 'object') return false;
  if (record.status !== 'active' || record.enabled === false) return false;
  const policy = kindPolicy(record.kind);
  if (!policy || policy.ttlDays === null) return false;
  const nowMs = normalizeNow(now);
  if (!(ageDaysAt(record, nowMs) > policy.ttlDays)) return false;
  return retentionScore(record, nowMs) < ARCHIVE_RETENTION_THRESHOLD;
}

/** Deterministic review priority (higher = sooner). Unknown reasons score 0. */
export function reviewPriority(reason: ReviewReason): number {
  return typeof reason === 'string' && reason in REVIEW_PRIORITY ? REVIEW_PRIORITY[reason as ReviewReason] : 0;
}

/** Low-use review starts after the kind's TTL, capped at 60 days. */
function lowUseAgeDays(kind: string): number {
  const policy = kindPolicy(kind);
  if (!policy || policy.ttlDays === null) return 60;
  return Math.min(60, policy.ttlDays);
}

function dueAtFor(record: LifecycleRecord, reason: ReviewReason, nowMs: number): string {
  if (reason === 'expired') return iso(parseTime(record.expiresAt) ?? nowMs);
  if (reason === 'review-after') return iso(parseTime(record.reviewAfter) ?? nowMs);
  if (reason === 'low-use' || reason === 'negative-feedback' || reason === 'stale-source') {
    return iso(parseTime(record.updatedAt) ?? nowMs);
  }
  return iso(nowMs);
}

interface MutableCandidate extends ReviewCandidate {
  notes?: string;
}

function compareCandidates(left: ReviewCandidate, right: ReviewCandidate): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  const leftDue = Date.parse(left.dueAt);
  const rightDue = Date.parse(right.dueAt);
  const leftTime = Number.isFinite(leftDue) ? leftDue : 0;
  const rightTime = Number.isFinite(rightDue) ? rightDue : 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.memoryId < right.memoryId ? -1 : left.memoryId > right.memoryId ? 1 : 0;
}

/**
 * Build the deterministic review queue (blueprint §11): expired, review-after,
 * low-use, negative feedback, open conflicts, auto-publish samples and Dream
 * consolidation candidates. Each memory appears at most once with its highest
 * priority reason. Sorting: priority desc → dueAt asc → memoryId asc, then the
 * queue is limited (default 50).
 *
 * `stale-source` candidates are not derivable from `LifecycleRecord` (it has no
 * source state); the controller emits those rows directly using
 * `reviewPriority('stale-source')`.
 */
export function reviewCandidates(input: {
  records: LifecycleRecord[];
  now?: number;
  openConflictIds?: string[];
  autopublishSampleIds?: string[];
  consolidationIds?: string[];
  limit?: number;
}): ReviewCandidate[] {
  if (!input || typeof input !== 'object') return [];
  const nowMs = normalizeNow(input.now);
  const records = Array.isArray(input.records) ? input.records.filter(record => !!record && typeof record === 'object' && typeof record.id === 'string' && record.id.length > 0) : [];
  const explicitSets: { ids: string[]; reason: ReviewReason }[] = [
    { ids: Array.isArray(input.openConflictIds) ? input.openConflictIds : [], reason: 'conflict-open' },
    { ids: Array.isArray(input.autopublishSampleIds) ? input.autopublishSampleIds : [], reason: 'autopublish-sample' },
    { ids: Array.isArray(input.consolidationIds) ? input.consolidationIds : [], reason: 'dream-proposal' },
  ];
  const explicitReasons = new Map<string, { reason: ReviewReason; notes?: string }[]>();
  for (const set of explicitSets) {
    for (const id of set.ids) {
      if (typeof id !== 'string' || !id) continue;
      const list = explicitReasons.get(id) ?? [];
      if (!list.some(item => item.reason === set.reason)) list.push({ reason: set.reason });
      explicitReasons.set(id, list);
    }
  }

  const chosen = new Map<string, MutableCandidate>();
  const consider = (candidate: MutableCandidate): void => {
    const existing = chosen.get(candidate.memoryId);
    if (!existing) {
      chosen.set(candidate.memoryId, candidate);
      return;
    }
    if (candidate.priority > existing.priority) {
      chosen.set(candidate.memoryId, {...candidate, ...(candidate.notes ? {notes: candidate.notes} : {})});
    } else if (candidate.priority === existing.priority && !existing.notes && candidate.notes) {
      existing.notes = candidate.notes;
    }
  };
  const add = (record: LifecycleRecord, reason: ReviewReason, notes?: string): void => {
    consider({
      memoryId: record.id,
      revision: recordRevision(record),
      reason,
      priority: reviewPriority(reason),
      dueAt: dueAtFor(record, reason, nowMs),
      ...(notes ? {notes} : {}),
    });
  };

  for (const record of records) {
    if (record.status === 'invalidated') continue;
    const enabled = record.enabled !== false;
    const active = record.status === 'active';
    if (active && enabled) {
      if (isExpired(record, nowMs)) add(record, 'expired');
      const reviewAfter = parseTime(record.reviewAfter);
      if (reviewAfter !== undefined && reviewAfter <= nowMs) add(record, 'review-after');
      const ageDays = ageDaysAt(record, nowMs);
      if (count(record.useCount) < LOW_USE_MAX && ageDays >= lowUseAgeDays(record.kind)) add(record, 'low-use');
      if (typeof record.feedbackScore === 'number' && Number.isFinite(record.feedbackScore) && record.feedbackScore <= NEGATIVE_FEEDBACK_THRESHOLD) {
        add(record, 'negative-feedback');
      }
    } else if (enabled && active === false) {
      // Candidates/inactive records only surface through explicit feedback signals.
      if (typeof record.feedbackScore === 'number' && Number.isFinite(record.feedbackScore) && record.feedbackScore <= NEGATIVE_FEEDBACK_THRESHOLD) {
        add(record, 'negative-feedback');
      }
    }
    for (const explicitReason of explicitReasons.get(record.id) ?? []) add(record, explicitReason.reason, explicitReason.notes);
  }

  const limit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : DEFAULT_REVIEW_LIMIT;
  return [...chosen.values()].sort(compareCandidates).slice(0, limit).map(candidate => ({...candidate}));
}
