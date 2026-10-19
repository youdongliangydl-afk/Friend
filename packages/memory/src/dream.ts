/**
 * Dream v2 — auditable memory consolidation (blueprint §9, P1-P4-SPEC §1.4).
 *
 * This module is deliberately controller-free: it is a mix of pure planning /
 * validation functions and `DatabaseSync` data access. It never imports
 * `index.ts`, never calls a model and never calls controller policy code.
 *
 * Safety model:
 *  - planning is deterministic: the same input produces a byte-identical plan
 *    and the same `consolidationId`; operations are sorted by canonical id and
 *    bounded by `maxOps`;
 *  - no false merges: two records merge only when project scope, subject key and
 *    the complete claim (normalized content + normalized conditions) are equal;
 *    different values or different applicability conditions never merge;
 *  - model proposals can only split/distill/profile; they are validated against
 *    the deterministic plan and the parent sources, and every model-derived
 *    record stays a `candidate` (a model proposal never becomes `active`);
 *  - applying a plan is one `BEGIN IMMEDIATE` transaction (unless the caller is
 *    already inside one, then it is nested-safe) that writes the consolidated
 *    records, retires the parents, stores relations and one immutable audit row;
 *  - rollback restores the parents, retires the derived records, removes the
 *    relations and is idempotent.
 *
 * The controller owns everything that is not plain SQL: search index rebuild,
 * source-policy dependencies/grants, projection outbox, events and memory_fts.
 * After {@link applyDreamPlan} / {@link rollbackConsolidation} commit it must
 * re-project the returned ids through its normal write-side indexers.
 */
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

/** Rule revision stored in consolidation rows / diffs. */
export const DREAM_RULE_VERSION = 1;

export type DreamRelationKind = 'same-subject' | 'derived-from' | 'related';
export type DreamArchiveReason = 'expired' | 'low-retention';
/** `model` results stay candidates; `user` results may become active. */
export type DreamOrigin = 'model' | 'user';

/** Minimal record projection the Dream planner works on. */
export interface DreamRecord {
  id:string;
  projectId:string;
  scope:string;
  kind:string;
  subjectKey?:string|null;
  title:string;
  content:string;
  conditions:string[];
  status:string;
  enabled:boolean;
  revision:number;
  trust?:string|null;
  updatedAt:string;
  expiresAt?:string|null;
  useCount?:number;
  lastUsedAt?:string|null;
  feedbackScore?:number;
  sources:unknown[];
  /** Additive (not in spec §1.4's literal shape): lineage used for relations. */
  parentIds?:string[];
}

export interface DreamProposalPart {
  title:string;
  content:string;
  conditions:string[];
  sourceIds:string[];
}

/** A model (or user-confirmed) consolidation proposal before validation. */
export interface DreamProposal {
  kind:'split' | 'distill' | 'profile';
  parentIds:string[];
  parts?:DreamProposalPart[];
  title?:string;
  content?:string;
  conditions?:string[];
  sourceIds?:string[];
  reason?:string;
  origin?:DreamOrigin;
}

export type DreamOperation =
  | {kind:'merge'; parentIds:string[]; title:string; content:string; conditions:string[]; sourceIds:string[]}
  | {kind:'archive'; memoryId:string; reason:DreamArchiveReason}
  | {kind:'relation'; fromId:string; toId:string; relation:DreamRelationKind}
  | {kind:'split'; parentId:string; parts:DreamProposalPart[]; origin?:DreamOrigin}
  | {kind:'profile'; parentIds:string[]; content:string; conditions:string[]; origin?:DreamOrigin}
  | {kind:'distill'; parentIds:string[]; title:string; content:string; conditions:string[]; origin?:DreamOrigin};

export interface DreamPlan {
  consolidationId:string;
  projectId:string;
  operations:DreamOperation[];
  proposals:DreamProposal[];
}

export interface PlanDreamInput {
  projectId:string;
  records:DreamRecord[];
  conflictIds?:string[];
  now?:string;
  maxOps?:number;
}

/** One operation that was applied; ids are useful for the controller's re-projection. */
export interface AppliedDreamOperation {
  op:DreamOperation;
  parentIds:string[];
  childIds:string[];
  relationIds:string[];
}

export interface ApplyDreamPlanResult {
  consolidationId:string;
  applied:DreamOperation[];
  skipped:{op:DreamOperation; reason:string}[];
  parentIds:string[];
  childIds:string[];
}

export interface ApplyDreamPlanInput {
  plan:DreamPlan;
  now:()=>string;
  /** Controller digest (same SHA-256 semantics as core.digest); defaults to sha256 JSON. */
  digest?:(value:unknown)=>string;
  /** Audit actor, default `dream`. */
  actor?:string;
}

export interface RollbackConsolidationInput {
  consolidationId:string;
  projectId:string;
  now:()=>string;
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MERGE_MIN_PARENTS = 2;
const PROFILE_MIN_PARENTS = 1;
const DISTILL_MIN_PARENTS = 2;
const LOW_RETENTION_THRESHOLD = 0.25;
const MAX_PARENTS = 12;
const MAX_PARTS = 12;
const MAX_CONDITIONS = 50;
const MAX_CONTENT = 50000;
const MAX_TITLE = 200;
const DEFAULT_MAX_OPS = 24;

const TRUST_RANK:Readonly<Record<string,number>> = {
  user_explicit:8, user_confirmed:7, source_verified:6, quote_verified:5,
  tool_verified:4, model_supported:3, model_inferred:2, external_import:1,
};
const AUTHORITY_BY_TRUST:Readonly<Record<string,string>> = {
  user_explicit:'user', user_confirmed:'user', source_verified:'source', quote_verified:'model',
  tool_verified:'tool', model_supported:'model', model_inferred:'none', external_import:'external',
};
const TRUST_WEIGHT:Readonly<Record<string,number>> = {
  user_explicit:1, user_confirmed:0.9, source_verified:0.8, tool_verified:0.75,
  quote_verified:1, model_supported:0.4, model_inferred:0.25, external_import:0.6,
};
const HALF_LIFE_DAYS:Readonly<Record<string,number>> = {
  episode:60, task:60, fact:90, experience:90, preference:180, profile:180, knowledge:180,
};
const TTL_DAYS:Readonly<Record<string,number>> = {
  episode:60, task:14, fact:90, experience:90, preference:180, profile:180, knowledge:180,
};
const RELATION_KINDS = new Set<DreamRelationKind>(['same-subject', 'derived-from', 'related']);
const ARCHIVE_REASONS = new Set<DreamArchiveReason>(['expired', 'low-retention']);

/** Same canonical digest semantics as `core.digest`: sha256 of a string or its JSON. */
function sha(value:unknown):string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

/** Deterministic RFC-4122-shaped id; version/variant bits set so it is a valid uuid. */
function uuidFrom(seed:unknown):string {
  const hex = sha(seed);
  const variant = '89ab'[Number.parseInt(hex[16]!, 16) & 0x3]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Stable JSON: object keys sorted recursively; array order preserved. */
function stableStringify(value:unknown):string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string,unknown>;
    const sorted:Record<string,unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortKeysDeep(source[key]);
    return sorted;
  }
  return value;
}

const normalize = (value:string):string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

function sortStrings(values:Iterable<string>):string[] {
  const unique = [...new Set(values)];
  unique.sort((a, b) => {
    const na = normalize(a), nb = normalize(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return unique;
}

function stringList(value:unknown, max = MAX_CONDITIONS, maxLength = MAX_CONTENT):string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out:string[] = [];
  for (const item of value.slice(0, max * 2)) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text || text.length > maxLength || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function textOrEmpty(value:unknown, max = MAX_CONTENT):string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function requireText(value:unknown, message:string):string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(message);
  return text;
}

function isoNow(value:unknown, message = '时间无效'):string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(message);
  return new Date(value).toISOString();
}

function currentIso():string {
  return new Date().toISOString();
}

function codedError(code:string, message:string):Error {
  const error = new Error(message);
  (error as Error & {code?:string}).code = code;
  return error;
}

function parseIso(value:unknown):number | undefined {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function ageDaysOf(record:DreamRecord, nowMs:number):number {
  const updated = parseIso(record.updatedAt);
  if (updated === undefined) return 0;
  return Math.max(0, (nowMs - updated) / DAY_MS);
}

function trustRank(trust:string|null|undefined):number {
  return trust ? (TRUST_RANK[trust] ?? 0) : 0;
}

function isUserTrust(trust:string|null|undefined):boolean {
  return trust === 'user_explicit' || trust === 'user_confirmed';
}

function compareRepresentative(a:DreamRecord, b:DreamRecord):number {
  const rank = trustRank(b.trust) - trustRank(a.trust);
  if (rank !== 0) return rank;
  const ua = parseIso(a.updatedAt) ?? 0, ub = parseIso(b.updatedAt) ?? 0;
  if (ua !== ub) return ub - ua;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function representative(records:DreamRecord[]):DreamRecord {
  return [...records].sort(compareRepresentative)[0]!;
}

function byId(a:{id:string}, b:{id:string}):number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Retention score shared by the archive trigger and lifecycle wiring (0..1). */
export function dreamRetentionScore(record:DreamRecord, now?:string):number {
  const nowMs = now === undefined ? Date.now() : Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('now 必须是有效时间');
  const halfLife = HALF_LIFE_DAYS[record.kind] ?? 180;
  const decay = Math.pow(0.5, ageDaysOf(record, nowMs) / halfLife);
  const usage = Math.min(1, 0.5 + 0.1 * Math.max(0, record.useCount ?? 0));
  const feedback = Math.min(1.5, Math.max(0.5, 1 + 0.1 * Math.min(5, Math.max(-5, record.feedbackScore ?? 0))));
  const usedAt = parseIso(record.lastUsedAt);
  const recency = usedAt === undefined ? 1 : Math.pow(0.5, Math.max(0, (nowMs - usedAt) / DAY_MS) / 180);
  const trust = TRUST_WEIGHT[record.trust ?? ''] ?? 0.5;
  const score = trust * decay * usage * feedback * recency;
  return Math.max(0, Math.min(1, score));
}

function isExpiredRecord(record:DreamRecord, nowMs:number):boolean {
  const expiresAt = parseIso(record.expiresAt);
  return expiresAt !== undefined && expiresAt <= nowMs;
}

function needsLowRetentionArchive(record:DreamRecord, nowMs:number):boolean {
  if (isExpiredRecord(record, nowMs)) return false;
  const ttl = TTL_DAYS[record.kind] ?? 180;
  if (ageDaysOf(record, nowMs) < ttl) return false;
  return dreamRetentionScore(record, new Date(nowMs).toISOString()) < LOW_RETENTION_THRESHOLD;
}

/** One stable identity for a source-like value; tolerant of string identities. */
function sourceIdentity(source:unknown):string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    const value = source as Record<string,unknown>;
    return sha(stableStringify({
      sessionId:typeof value.sessionId === 'string' ? value.sessionId : null,
      entryId:typeof value.entryId === 'string' ? value.entryId : null,
      start:typeof value.start === 'number' ? value.start : null,
      end:typeof value.end === 'number' ? value.end : null,
      hash:typeof value.hash === 'string' ? value.hash : null,
      factId:typeof value.factId === 'string' ? value.factId : null,
    }));
  }
  return sha(stableStringify(source ?? null));
}

function sourceIdentifiers(source:unknown):string[] {
  const out = new Set<string>([sourceIdentity(source)]);
  if (source && typeof source === 'object') {
    const value = source as Record<string,unknown>;
    if (typeof value.sessionId === 'string' && typeof value.entryId === 'string') out.add(`${value.sessionId}:${value.entryId}`);
    if (typeof value.factId === 'string') out.add(value.factId);
    if (typeof value.hash === 'string') out.add(value.hash);
  }
  return [...out];
}

function sourceMatches(source:unknown, identity:string):boolean {
  return sourceIdentifiers(source).includes(identity);
}

function unionValues(values:unknown[]):unknown[] {
  const seen = new Set<string>();
  const out:unknown[] = [];
  for (const value of values) {
    const key = stableStringify(value ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function claimOf(record:DreamRecord):string {
  return sha(stableStringify({
    content:normalize(record.content),
    conditions:sortStrings(record.conditions.map(normalize)),
  }));
}

function compareByUpdatedAtDesc(a:DreamRecord, b:DreamRecord):number {
  const ua = parseIso(a.updatedAt) ?? 0, ub = parseIso(b.updatedAt) ?? 0;
  if (ua !== ub) return ub - ua;
  return byId(a, b);
}

// ---------------------------------------------------------------------------
// Planning (deterministic)
// ---------------------------------------------------------------------------

function normalizeDreamRecord(raw:unknown, fallbackNow:string):DreamRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string,unknown>;
  const id = textOrEmpty(value.id, 200);
  if (!id) return undefined;
  const projectId = textOrEmpty(value.projectId, 200);
  return {
    id,
    projectId,
    scope:value.scope === 'personal' ? 'personal' : 'project',
    kind:textOrEmpty(value.kind, 100) || 'fact',
    subjectKey:typeof value.subjectKey === 'string' && value.subjectKey.trim() ? value.subjectKey.trim() : null,
    title:textOrEmpty(value.title, MAX_TITLE),
    content:textOrEmpty(value.content, MAX_CONTENT),
    conditions:stringList(value.conditions),
    status:textOrEmpty(value.status, 50) || 'candidate',
    enabled:value.enabled !== false,
    revision:Number.isInteger(value.revision) && (value.revision as number) > 0 ? (value.revision as number) : 1,
    trust:typeof value.trust === 'string' && value.trust ? value.trust : null,
    updatedAt:parseIso(value.updatedAt) === undefined ? fallbackNow : new Date(value.updatedAt as string).toISOString(),
    expiresAt:parseIso(value.expiresAt) === undefined ? null : new Date(value.expiresAt as string).toISOString(),
    useCount:Number.isFinite(value.useCount) ? Math.max(0, Math.trunc(value.useCount as number)) : 0,
    lastUsedAt:parseIso(value.lastUsedAt) === undefined ? null : new Date(value.lastUsedAt as string).toISOString(),
    feedbackScore:Number.isFinite(value.feedbackScore) ? Math.min(5, Math.max(-5, value.feedbackScore as number)) : 0,
    sources:Array.isArray(value.sources) ? value.sources.slice(0, 200) : [],
    parentIds:stringList(value.parentIds, 24, 200),
  };
}

/** Deduplicate records by id order-independently (shuffled input must not matter). */
function normalizeRecords(raw:unknown[] | undefined, fallbackNow:string):DreamRecord[] {
  const byRecordId = new Map<string,DreamRecord>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const record = normalizeDreamRecord(item, fallbackNow);
    if (!record) continue;
    const existing = byRecordId.get(record.id);
    if (!existing || stableStringify(record) < stableStringify(existing)) byRecordId.set(record.id, record);
  }
  return [...byRecordId.values()].sort(byId);
}

function operationKey(op:DreamOperation):string {
  switch (op.kind) {
    case 'merge': return `merge:${[...op.parentIds].sort().join(',')}`;
    case 'archive': return `archive:${op.memoryId}`;
    case 'relation': return `relation:${op.fromId}:${op.toId}:${op.relation}`;
    case 'split': return `split:${op.parentId}`;
    case 'profile': return `profile:${[...op.parentIds].sort().join(',')}`;
    case 'distill': return `distill:${[...op.parentIds].sort().join(',')}`;
  }
}

function sortOperations(operations:DreamOperation[]):DreamOperation[] {
  const deduped = new Map<string,DreamOperation>();
  for (const op of operations) {
    const key = operationKey(op);
    if (!deduped.has(key)) deduped.set(key, op);
  }
  return [...deduped.values()].sort((a, b) => {
    const ka = operationKey(a), kb = operationKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function canonicalProposal(proposal:DreamProposal):unknown {
  return {
    kind:proposal.kind,
    parentIds:[...proposal.parentIds].sort(),
    ...(proposal.parts ? {parts:proposal.parts.map(part => ({
      title:part.title,
      content:part.content,
      conditions:sortStrings(part.conditions),
      sourceIds:sortStrings(part.sourceIds),
    }))} : {}),
    title:proposal.title ?? null,
    content:proposal.content ?? null,
    conditions:sortStrings(proposal.conditions ?? []),
    sourceIds:sortStrings(proposal.sourceIds ?? []),
    origin:proposal.origin ?? null,
  };
}

function consolidationIdFor(projectId:string, operations:DreamOperation[], proposals:DreamProposal[]):string {
  return uuidFrom(['friend-pi-memory-dream', DREAM_RULE_VERSION, projectId, {
    operations:operations.map(canonicalOperation),
    proposals:[...proposals].map(canonicalProposal).sort((a, b) => { const left = stableStringify(a), right = stableStringify(b); return left < right ? -1 : left > right ? 1 : 0; }),
  }]);
}

function canonicalOperation(op:DreamOperation):unknown {
  switch (op.kind) {
    case 'merge':
      return {kind:'merge', parentIds:[...op.parentIds].sort(), title:op.title, content:op.content, conditions:sortStrings(op.conditions), sourceIds:sortStrings(op.sourceIds)};
    case 'archive':
      return {kind:'archive', memoryId:op.memoryId, reason:op.reason};
    case 'relation':
      return {kind:'relation', fromId:op.fromId, toId:op.toId, relation:op.relation};
    case 'split':
      return {kind:'split', parentId:op.parentId, origin:op.origin ?? 'model', parts:op.parts.map(part => ({
        title:part.title, content:part.content, conditions:sortStrings(part.conditions), sourceIds:sortStrings(part.sourceIds),
      }))};
    case 'profile':
      return {kind:'profile', parentIds:[...op.parentIds].sort(), content:op.content, conditions:sortStrings(op.conditions), origin:op.origin ?? 'user'};
    case 'distill':
      return {kind:'distill', parentIds:[...op.parentIds].sort(), title:op.title, content:op.content, conditions:sortStrings(op.conditions), origin:op.origin ?? 'model'};
  }
}

/**
 * Deterministic consolidation plan for one project.
 *
 * - merge: active records with the same scope + subject key + complete claim
 *   (normalized content and normalized conditions) are collapsed into one;
 * - archive: expired or low-retention active records are retired without being
 *   deleted (rollback can restore them);
 * - relation: `derived-from` for `parentIds`, `same-subject` between conflicting
 *   claims of one subject, `related` for the supplied open-conflict sides;
 * - proposals are only filled in by {@link validateDreamProposal}.
 *
 * Output order is canonical (`operationKey` order) so the same records in any
 * input order produce byte-identical plans and the same `consolidationId`.
 */
export function planDream(input:PlanDreamInput):DreamPlan {
  if (!input || typeof input !== 'object') throw new Error('planDream 需要输入对象');
  const projectId = requireText(input.projectId, 'planDream 需要项目编号');
  const fallbackNow = input.now === undefined ? currentIso() : isoNow(input.now, 'planDream now 无效');
  const nowMs = Date.parse(fallbackNow);
  const maxOps = Number.isInteger(input.maxOps) ? Math.min(100, Math.max(1, input.maxOps as number)) : DEFAULT_MAX_OPS;
  const records = normalizeRecords(input.records, fallbackNow);
  const operations:DreamOperation[] = [];

  // 1) Archive first: archived records never take part in merging/relations.
  const archived = new Set<string>();
  for (const record of records.filter(record => record.status === 'active' && record.enabled)) {
    if (isExpiredRecord(record, nowMs)) {
      archived.add(record.id);
      operations.push({kind:'archive', memoryId:record.id, reason:'expired'});
    } else if (needsLowRetentionArchive(record, nowMs)) {
      archived.add(record.id);
      operations.push({kind:'archive', memoryId:record.id, reason:'low-retention'});
    }
  }
  const live = records.filter(record => record.status === 'active' && record.enabled && !archived.has(record.id));

  // 2) Merge equivalent claims of one subject.
  const mergeGroups = new Map<string,DreamRecord[]>();
  for (const record of live) {
    if (!record.subjectKey) continue;
    const key = [record.scope, record.subjectKey, claimOf(record)].join('\u0000');
    const group = mergeGroups.get(key);
    if (group) group.push(record); else mergeGroups.set(key, [record]);
  }
  const merged = new Set<string>();
  for (const key of [...mergeGroups.keys()].sort()) {
    const group = mergeGroups.get(key)!.sort(byId);
    if (group.length < MERGE_MIN_PARENTS) continue;
    for (const record of group) merged.add(record.id);
    const rep = representative(group);
    operations.push({
      kind:'merge',
      parentIds:group.map(record => record.id),
      title:rep.title,
      content:rep.content,
      conditions:sortStrings(group.flatMap(record => record.conditions)),
      sourceIds:sortStrings(group.flatMap(record => record.sources.map(sourceIdentity))),
    });
  }

  // 3) Relation: parent lineage (child derived-from parent).
  for (const record of live) {
    for (const parentId of sortStrings(record.parentIds ?? [])) {
      if (parentId === record.id || archived.has(parentId)) continue;
      operations.push({kind:'relation', fromId:record.id, toId:parentId, relation:'derived-from'});
    }
  }

  // 4) Relation: conflicting claims of the same subject stay connected.
  const subjectGroups = new Map<string,DreamRecord[]>();
  for (const record of live) {
    if (!record.subjectKey || merged.has(record.id)) continue;
    const key = [record.scope, record.subjectKey].join('\u0000');
    const group = subjectGroups.get(key);
    if (group) group.push(record); else subjectGroups.set(key, [record]);
  }
  for (const key of [...subjectGroups.keys()].sort()) {
    const group = subjectGroups.get(key)!.sort(byId);
    for (let index = 0; index + 1 < group.length; index += 1) {
      const left = group[index]!, right = group[index + 1]!;
      if (claimOf(left) === claimOf(right)) continue;
      const [fromId, toId] = [left.id, right.id].sort();
      operations.push({kind:'relation', fromId:fromId!, toId:toId!, relation:'same-subject'});
    }
  }

  // 5) Relation: supplied open-conflict sides are paired deterministically.
  const liveIds = new Set(live.map(record => record.id));
  const conflictIds = sortStrings(stringList(input.conflictIds, 64, 200).filter(id => liveIds.has(id)));
  for (let index = 0; index + 1 < conflictIds.length; index += 2) {
    operations.push({kind:'relation', fromId:conflictIds[index]!, toId:conflictIds[index + 1]!, relation:'related'});
  }

  const sorted = sortOperations(operations).slice(0, maxOps);
  const proposals:DreamProposal[] = [];
  return {consolidationId:consolidationIdFor(projectId, sorted, proposals), projectId, operations:sorted, proposals};
}

// ---------------------------------------------------------------------------
// Proposal validation (model split/distill/profile only)
// ---------------------------------------------------------------------------

function normalizeOperation(raw:unknown):DreamOperation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string,unknown>;
  switch (value.kind) {
    case 'merge': {
      const parentIds = stringList(value.parentIds, MAX_PARENTS, 200);
      if (parentIds.length < MERGE_MIN_PARENTS) return undefined;
      const title = textOrEmpty(value.title, MAX_TITLE);
      const content = textOrEmpty(value.content, MAX_CONTENT);
      if (!title && !content) return undefined;
      return {kind:'merge', parentIds, title, content, conditions:stringList(value.conditions), sourceIds:stringList(value.sourceIds, 200, 500)};
    }
    case 'archive': {
      const memoryId = textOrEmpty(value.memoryId, 200);
      const reason = value.reason as DreamArchiveReason;
      if (!memoryId || !ARCHIVE_REASONS.has(reason)) return undefined;
      return {kind:'archive', memoryId, reason};
    }
    case 'relation': {
      const fromId = textOrEmpty(value.fromId, 200), toId = textOrEmpty(value.toId, 200);
      const relation = value.relation as DreamRelationKind;
      if (!fromId || !toId || fromId === toId || !RELATION_KINDS.has(relation)) return undefined;
      return {kind:'relation', fromId, toId, relation};
    }
    case 'split': {
      const parentId = textOrEmpty(value.parentId, 200);
      const parts = normalizeParts(value.parts);
      if (!parentId || parts.length < 2) return undefined;
      return {kind:'split', parentId, parts, ...(value.origin === 'user' ? {origin:'user' as const} : {origin:'model' as const})};
    }
    case 'profile': {
      const parentIds = stringList(value.parentIds, MAX_PARENTS, 200);
      const content = textOrEmpty(value.content, MAX_CONTENT);
      if (parentIds.length < PROFILE_MIN_PARENTS || !content) return undefined;
      return {kind:'profile', parentIds, content, conditions:stringList(value.conditions), ...(value.origin === 'model' ? {origin:'model' as const} : {origin:'user' as const})};
    }
    case 'distill': {
      const parentIds = stringList(value.parentIds, MAX_PARENTS, 200);
      const content = textOrEmpty(value.content, MAX_CONTENT);
      if (parentIds.length < 1 || !content) return undefined;
      return {kind:'distill', parentIds, title:textOrEmpty(value.title, MAX_TITLE), content, conditions:stringList(value.conditions), ...(value.origin === 'user' ? {origin:'user' as const} : {origin:'model' as const})};
    }
    default:
      return undefined;
  }
}

function normalizeParts(raw:unknown):DreamProposalPart[] {
  if (!Array.isArray(raw)) return [];
  const parts:DreamProposalPart[] = [];
  for (const item of raw.slice(0, MAX_PARTS)) {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string,unknown>;
    const title = textOrEmpty(value.title, MAX_TITLE), content = textOrEmpty(value.content, MAX_CONTENT);
    if (!title || !content) return [];
    parts.push({title, content, conditions:stringList(value.conditions), sourceIds:stringList(value.sourceIds, 50, 500)});
  }
  return parts;
}

function normalizeProposal(raw:unknown):DreamProposal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string,unknown>;
  const kind = value.kind ?? value.type;
  if (kind !== 'split' && kind !== 'distill' && kind !== 'profile') return undefined;
  const parentIds = stringList(value.parentIds, MAX_PARENTS, 200);
  if (!parentIds.length) return undefined;
  const origin:DreamOrigin = value.origin === 'user' ? 'user' : 'model';
  const proposal:DreamProposal = {
    kind,
    parentIds,
    origin,
    ...(typeof value.reason === 'string' && value.reason.trim() ? {reason:value.reason.trim().slice(0, 500)} : {}),
  };
  if (kind === 'split') {
    const parts = normalizeParts(value.parts);
    if (parts.length < 2) return undefined;
    proposal.parts = parts;
  } else {
    const title = textOrEmpty(value.title, MAX_TITLE), content = textOrEmpty(value.content, MAX_CONTENT);
    if (!content) return undefined;
    proposal.title = title;
    proposal.content = content;
    proposal.conditions = stringList(value.conditions);
    proposal.sourceIds = stringList(value.sourceIds, 200, 500);
  }
  return proposal;
}

/** Tokens used to prove a distilled claim is grounded in parent text (CJK bigrams). */
function significantTokens(content:string):string[] {
  const normalized = normalize(content);
  const tokens:string[] = [];
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/gu)) tokens.push(match[0]);
  for (const run of normalized.match(/[\u4e00-\u9fff]+/gu) ?? []) {
    if (run.length === 2) tokens.push(run);
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return [...new Set(tokens)].slice(0, 400);
}

function sharesLiteral(content:string, parent:DreamRecord):boolean {
  const haystack = normalize(`${parent.title} ${parent.content}`);
  if (!haystack) return false;
  return significantTokens(content).some(token => haystack.includes(token));
}

function resolveProposalSourceIds(rawIds:string[], parentSources:unknown[]):string[] {
  const known = new Set(parentSources.flatMap(sourceIdentifiers));
  return rawIds.filter(id => known.has(id));
}

function partSourceSetsIndependent(parts:DreamProposalPart[]):boolean {
  // Each part must own at least one source id that no other part cites.
  return parts.every((part, index) => part.sourceIds.some(id => parts.every((other, otherIndex) => otherIndex === index || !other.sourceIds.includes(id))));
}

/**
 * Validate model proposals against the deterministic plan, the known parent
 * records and their sources. Only split/distill/profile survive; every rejected
 * entry is dropped (never partially applied). The returned plan has a
 * recomputed `consolidationId` over deterministic + validated operations.
 */
export function validateDreamProposal(input:{plan:DreamPlan; proposals:unknown[]; records:DreamRecord[]}):DreamPlan {
  if (!input || typeof input !== 'object') throw new Error('validateDreamProposal 需要输入对象');
  const plan = input.plan;
  if (!plan || typeof plan !== 'object') throw new Error('validateDreamProposal 缺少计划');
  const projectId = requireText(plan.projectId, '计划缺少项目编号');
  const fallbackNow = currentIso();
  const records = normalizeRecords(input.records, fallbackNow);
  const byRecordId = new Map(records.map(record => [record.id, record]));
  const operations = Array.isArray(plan.operations)
    ? plan.operations.map(normalizeOperation).filter((op):op is DreamOperation => op !== undefined)
    : [];
  const accepted:DreamProposal[] = [];
  const rawProposals = Array.isArray(input.proposals) ? input.proposals : [];

  for (const raw of rawProposals) {
    const proposal = normalizeProposal(raw);
    if (!proposal) continue;
    const parents = proposal.parentIds.map(id => byRecordId.get(id));
    if (parents.some(parent => parent === undefined)) continue;
    const known = parents as DreamRecord[];
    // Never consolidate records of another project.
    if (known.some(parent => parent.projectId !== projectId && parent.scope !== 'personal')) continue;
    // Only live records are consolidation parents.
    if (known.some(parent => !parent.enabled || parent.status !== 'active')) continue;

    if (proposal.kind === 'split') {
      const parts = proposal.parts ?? [];
      const parent = known[0]!;
      if (proposal.parentIds.length !== 1) continue;
      const resolved:DreamProposalPart[] = [];
      let valid = true;
      for (const part of parts) {
        const sourceIds = resolveProposalSourceIds(part.sourceIds, parent.sources);
        if (sourceIds.length !== part.sourceIds.length) { valid = false; break; }
        resolved.push({...part, sourceIds});
      }
      if (!valid || !partSourceSetsIndependent(resolved)) continue;
      operations.push({kind:'split', parentId:parent.id, parts:resolved, origin:proposal.origin ?? 'model'});
      accepted.push({...proposal, parentIds:[parent.id], parts:resolved});
      continue;
    }

    if (proposal.kind === 'distill') {
      if (known.length < DISTILL_MIN_PARENTS) continue;
      const content = proposal.content!;
      const independentSources = new Set(known.flatMap(parent => parent.sources.map(sourceIdentity))).size;
      const userConfirmed = known.every(parent => isUserTrust(parent.trust));
      const groundedParents = known.filter(parent => sharesLiteral(content, parent)).length;
      const requestedSources = proposal.sourceIds ?? [];
      if (requestedSources.length && resolveProposalSourceIds(requestedSources, known.flatMap(parent => parent.sources)).length !== requestedSources.length) continue;
      if (!userConfirmed && (independentSources < 2 || groundedParents < DISTILL_MIN_PARENTS)) continue;
      if (userConfirmed && groundedParents < 1) continue;
      operations.push({
        kind:'distill',
        parentIds:[...proposal.parentIds].sort(),
        title:proposal.title || content.slice(0, 80),
        content,
        conditions:proposal.conditions ?? [],
        origin:proposal.origin ?? 'model',
      });
      accepted.push(proposal);
      continue;
    }

    // Trusted parents do not confirm new wording supplied by a proposal.
    if (!known.every(parent => isUserTrust(parent.trust))) continue;
    const content = proposal.content!;
    const requestedSources = proposal.sourceIds ?? [];
    if (requestedSources.length && resolveProposalSourceIds(requestedSources, known.flatMap(parent => parent.sources)).length !== requestedSources.length) continue;
    operations.push({
      kind:'profile',
      parentIds:[...proposal.parentIds].sort(),
      content,
      conditions:proposal.conditions ?? [],
      origin:'model',
    });
    accepted.push(proposal);
  }

  const sorted = sortOperations(operations);
  const proposals = accepted
    .map(canonicalProposal)
    .map((canonical, index) => ({canonical, index}))
    .sort((a, b) => {
      const left = stableStringify(a.canonical), right = stableStringify(b.canonical);
      return left < right ? -1 : left > right ? 1 : a.index - b.index;
    })
    .map(({index}) => accepted[index]!);
  return {consolidationId:consolidationIdFor(projectId, sorted, proposals), projectId, operations:sorted, proposals};
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

interface StoredMemoryRecord {
  id:string;
  projectId:string;
  scope:string;
  status:string;
  enabled:boolean;
  revision:number;
  trust:string | null;
  json:Record<string, unknown>;
}

function tableExists(db:DatabaseSync, table:string):boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function requireTable(db:DatabaseSync, table:string):void {
  if (!tableExists(db, table)) throw codedError('SCHEMA_VERSION_MISMATCH', `Dream 需要数据库表 ${table}（schema v5）`);
}

let columnCache = new WeakMap<DatabaseSync,Map<string,Set<string>>>();

function tableColumns(db:DatabaseSync, table:string):Set<string> {
  let perDb = columnCache.get(db);
  if (!perDb) { perDb = new Map(); columnCache.set(db, perDb); }
  let columns = perDb.get(table);
  if (!columns) {
    columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map(row => String(row.name)));
    perDb.set(table, columns);
  }
  return columns;
}

function parseJsonObject(raw:unknown):Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseStringArray(raw:unknown):string[] {
  if (Array.isArray(raw)) return raw.filter((item):item is string => typeof item === 'string');
  if (typeof raw === 'string' && raw) {
    try {
      const value:unknown = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item):item is string => typeof item === 'string') : [];
    } catch { return []; }
  }
  return [];
}

function selectRecord(db:DatabaseSync, id:string):StoredMemoryRecord | undefined {
  const row = db.prepare('SELECT * FROM memory_records WHERE id=?').get(id) as SqlRow | undefined;
  if (!row) return undefined;
  const json = parseJsonObject(row.json);
  return {
    id:String(row.id),
    projectId:typeof row.project_id === 'string' ? row.project_id : String(json.projectId ?? ''),
    scope:typeof row.scope === 'string' ? row.scope : (json.scope === 'personal' ? 'personal' : 'project'),
    status:typeof row.status === 'string' ? row.status : String(json.status ?? 'candidate'),
    enabled:Number(row.enabled ?? json.enabled ?? 1) !== 0,
    revision:Number.isInteger(row.revision) ? Number(row.revision) : Number(json.revision ?? 1),
    trust:typeof row.trust === 'string' ? row.trust : (typeof json.trust === 'string' ? json.trust : null),
    json,
  };
}

function inPlanProject(record:StoredMemoryRecord, projectId:string):boolean {
  return record.scope === 'personal' || record.projectId === projectId;
}

function loadActiveRecord(db:DatabaseSync, id:string, projectId:string):StoredMemoryRecord | undefined {
  const record = selectRecord(db, id);
  if (!record || !inPlanProject(record, projectId)) return undefined;
  return record.status === 'active' && record.enabled ? record : undefined;
}

function consolidationMarker(record:StoredMemoryRecord):string | null {
  if (typeof record.json.consolidationId === 'string' && record.json.consolidationId) return record.json.consolidationId;
  return null;
}

function toSqlValue(value:unknown):string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function semanticDigestOf(json:Record<string, unknown>, hash:(value:unknown)=>string):string {
  return hash({
    id:json.id,
    revision:json.revision,
    content:json.content,
    conditions:json.conditions ?? [],
    validFrom:json.validFrom ?? null,
    validTo:json.validTo ?? null,
    scope:json.scope,
  });
}

function appendVersion(db:DatabaseSync, json:Record<string, unknown>):void {
  if (!tableExists(db, 'memory_versions')) return;
  db.prepare('INSERT OR REPLACE INTO memory_versions(id,revision,json) VALUES(?,?,?)')
    .run(String(json.id), Number(json.revision ?? 1), JSON.stringify(json));
}

function insertMemoryRecord(db:DatabaseSync, json:Record<string, unknown>, consolidationId:string, hash:(value:unknown)=>string):void {
  const columns = tableColumns(db, 'memory_records');
  const content = typeof json.content === 'string' ? json.content : '';
  const candidates:Record<string, unknown> = {
    id:json.id,
    project_id:json.projectId,
    scope:json.scope,
    status:json.status,
    enabled:json.enabled,
    revision:json.revision,
    json:JSON.stringify(json),
    kind_v2:json.kind === 'method' ? null : json.kind,
    subject_key:json.subjectKey ?? null,
    subject_cardinality:json.subjectCardinality ?? (json.subjectKey ? 'single' : null),
    trust:json.trust ?? null,
    authority:json.authority ?? null,
    auto_published:0,
    policy_id:null,
    policy_version:null,
    score:null,
    conflict_state:null,
    lineage_root:Array.isArray(json.parentIds) && json.parentIds.length ? json.parentIds[0] : json.id,
    semantic_digest:semanticDigestOf(json, hash),
    last_used_at:json.lastUsedAt ?? null,
    use_count:json.useCount ?? 0,
    feedback_score:json.feedbackScore ?? 0,
    expires_at:json.expiresAt ?? null,
    deleted_at:null,
    pinned:0,
    pinned_at:null,
    decay_score:null,
    consolidation_id:consolidationId,
    project_ids_json:Array.isArray(json.projectIds) ? JSON.stringify(json.projectIds) : null,
  };
  const present = Object.keys(candidates).filter(key => columns.has(key));
  const sql = `INSERT INTO memory_records(${present.join(',')}) VALUES(${present.map(() => '?').join(',')})`;
  db.prepare(sql).run(...present.map(key => toSqlValue(candidates[key])));
  appendVersion(db, json);
}

function updateMemoryRecord(db:DatabaseSync, record:StoredMemoryRecord, next:Record<string, unknown>, markConsolidation?:string | null):void {
  const columns = tableColumns(db, 'memory_records');
  if (markConsolidation !== undefined && columns.has('consolidation_id')) {
    db.prepare('UPDATE memory_records SET status=?,enabled=?,revision=?,json=?,consolidation_id=? WHERE id=?')
      .run(String(next.status), next.enabled ? 1 : 0, Number(next.revision ?? record.revision + 1), JSON.stringify(next), markConsolidation, record.id);
  } else {
    db.prepare('UPDATE memory_records SET status=?,enabled=?,revision=?,json=? WHERE id=?')
      .run(String(next.status), next.enabled ? 1 : 0, Number(next.revision ?? record.revision + 1), JSON.stringify(next), record.id);
  }
  appendVersion(db, next);
}

function retireRecord(db:DatabaseSync, record:StoredMemoryRecord, reason:string, consolidationId:string, at:string):Record<string, unknown> {
  const next:Record<string, unknown> = {
    ...record.json,
    id:record.id,
    revision:record.revision + 1,
    status:'inactive',
    enabled:false,
    updatedAt:at,
    invalidatedReason:reason,
    consolidationId,
  };
  updateMemoryRecord(db, record, next, consolidationId);
  return next;
}

function restoreRecord(db:DatabaseSync, record:StoredMemoryRecord, at:string):Record<string, unknown> {
  const next:Record<string, unknown> = {
    ...record.json,
    id:record.id,
    revision:record.revision + 1,
    status:'active',
    enabled:true,
    updatedAt:at,
    consolidationId:undefined,
    invalidatedReason:undefined,
  };
  updateMemoryRecord(db, record, next, null);
  return next;
}

function revokeRecord(db:DatabaseSync, record:StoredMemoryRecord, at:string, reason:string):Record<string, unknown> {
  const next:Record<string, unknown> = {
    ...record.json,
    id:record.id,
    revision:record.revision + 1,
    status:'inactive',
    enabled:false,
    updatedAt:at,
    invalidatedReason:reason,
  };
  updateMemoryRecord(db, record, next);
  return next;
}

// ---------------------------------------------------------------------------
// Record assembly for each operation
// ---------------------------------------------------------------------------

function latestIso(values:unknown[]):string | null {
  let latest:number | undefined;
  for (const value of values) {
    const parsed = parseIso(value);
    if (parsed !== undefined && (latest === undefined || parsed > latest)) latest = parsed;
  }
  return latest === undefined ? null : new Date(latest).toISOString();
}

function earliestIso(values:unknown[]):string | null {
  let earliest:number | undefined;
  for (const value of values) {
    const parsed = parseIso(value);
    if (parsed !== undefined && (earliest === undefined || parsed < earliest)) earliest = parsed;
  }
  return earliest === undefined ? null : new Date(earliest).toISOString();
}

function unionField(records:StoredMemoryRecord[], field:string):unknown[] {
  return unionValues(records.flatMap(record => Array.isArray(record.json[field]) ? record.json[field] as unknown[] : []));
}

function recordKind(record:StoredMemoryRecord):string {
  return typeof record.json.kind === 'string' && record.json.kind ? record.json.kind : 'fact';
}

function recordTrust(record:StoredMemoryRecord):string | null {
  return isUserTrust(record.trust) ? record.trust : (typeof record.json.trust === 'string' ? record.json.trust : null);
}

/** Same ranking as planDream's representative: trust, newest, id. */
function storedRepresentative(records:StoredMemoryRecord[]):StoredMemoryRecord {
  return [...records].sort((a, b) => {
    const rank = trustRank(recordTrust(b)) - trustRank(recordTrust(a));
    if (rank !== 0) return rank;
    const ua = parseIso(a.json.updatedAt) ?? 0, ub = parseIso(b.json.updatedAt) ?? 0;
    if (ua !== ub) return ub - ua;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0]!;
}

function strongestRecordTrust(records:StoredMemoryRecord[]):string | null {
  let best:string | null = null;
  for (const record of records) {
    const trust = recordTrust(record);
    if (!trust) continue;
    if (best === null || trustRank(trust) > trustRank(best) || (trustRank(trust) === trustRank(best) && trust < best)) best = trust;
  }
  return best;
}

function buildMergedRecord(input:{
  childId:string;
  consolidationId:string;
  projectId:string;
  op:Extract<DreamOperation, {kind:'merge'}>;
  parents:StoredMemoryRecord[];
  at:string;
  hash:(value:unknown)=>string;
}):Record<string, unknown> {
  const {childId, consolidationId, projectId, op, parents, at, hash} = input;
  const rep = storedRepresentative(parents);
  const trust = strongestRecordTrust(parents);
  const content = op.content || (typeof rep.json.content === 'string' ? rep.json.content : '');
  const useCount = parents.reduce((sum, record) => sum + (Number.isFinite(record.json.useCount) ? Number(record.json.useCount) : 0), 0);
  const feedback = parents.reduce((sum, record) => sum + (Number.isFinite(record.json.feedbackScore) ? Number(record.json.feedbackScore) : 0), 0);
  return {
    id:childId,
    revision:1,
    projectId,
    scope:rep.scope,
    schemaVersion:2,
    kind:recordKind(rep),
    title:op.title || (typeof rep.json.title === 'string' ? rep.json.title : ''),
    content,
    status:'active',
    enabled:true,
    sources:unionField(parents, 'sources'),
    parentIds:[...op.parentIds],
    fingerprint:hash(normalize(content)),
    hash:hash(content),
    createdAt:at,
    updatedAt:at,
    confirmedBy:isUserTrust(trust) ? 'user' : 'system',
    conditions:op.conditions,
    aliases:sortStrings(parents.flatMap(record => stringList(record.json.aliases))),
    validFrom:latestIso(parents.map(record => record.json.validFrom)),
    validTo:earliestIso(parents.map(record => record.json.validTo)),
    expiresAt:earliestIso(parents.map(record => record.json.expiresAt ?? null)),
    evidence:unionField(parents, 'evidence'),
    dependencies:unionField(parents, 'dependencies'),
    sourceEpoch:0,
    policyEpoch:0,
    trust,
    authority:trust ? (AUTHORITY_BY_TRUST[trust] ?? null) : null,
    subjectKey:typeof rep.json.subjectKey === 'string' ? rep.json.subjectKey : null,
    subjectCardinality:typeof rep.json.subjectCardinality === 'string' ? rep.json.subjectCardinality : null,
    autoPublished:false,
    consolidationId,
    useCount,
    feedbackScore:Math.round((feedback / parents.length) * 1000) / 1000,
    lastUsedAt:latestIso(parents.map(record => record.json.lastUsedAt)),
  };
}

/** Shared fields of every record Dream creates; keeps histories stable. */
function buildDerivedRecord(input:{
  id:string;
  consolidationId:string;
  projectId:string;
  scope:string;
  kind:string;
  title:string;
  content:string;
  conditions:string[];
  status:'active' | 'candidate';
  sources:unknown[];
  parentIds:string[];
  trust:string | null;
  confirmedBy?:'user' | 'system';
  origin:DreamOrigin;
  at:string;
  hash:(value:unknown)=>string;
  extra?:Record<string, unknown>;
}):Record<string, unknown> {
  const authority = input.trust ? (AUTHORITY_BY_TRUST[input.trust] ?? null) : null;
  return {
    id:input.id,
    revision:1,
    projectId:input.projectId,
    scope:input.scope,
    schemaVersion:2,
    kind:input.kind,
    title:input.title,
    content:input.content,
    conditions:input.conditions,
    status:input.status,
    enabled:true,
    sources:input.sources,
    parentIds:[...input.parentIds],
    fingerprint:input.hash(normalize(input.content)),
    hash:input.hash(input.content),
    createdAt:input.at,
    updatedAt:input.at,
    aliases:[],
    evidence:[],
    dependencies:[],
    sourceEpoch:0,
    policyEpoch:0,
    trust:input.trust,
    authority,
    autoPublished:false,
    consolidationId:input.consolidationId,
    origin:input.origin,
    ...(input.confirmedBy ? {confirmedBy:input.confirmedBy} : {}),
    ...input.extra,
  };
}

function resolvePartSources(sources:unknown[], sourceIds:string[]):unknown[] {
  return sources.filter(source => sourceIds.some(id => sourceMatches(source, id)));
}

function distillKind(parents:StoredMemoryRecord[], scope:string):string {
  if (scope === 'personal') return 'preference';
  const kinds = new Set(parents.map(recordKind));
  if (kinds.has('experience') || kinds.has('episode')) return 'experience';
  if (kinds.size === 1 && kinds.has('knowledge')) return 'knowledge';
  return 'fact';
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

interface ApplyContext {
  db:DatabaseSync;
  plan:DreamPlan;
  projectId:string;
  consolidationId:string;
  hash:(value:unknown)=>string;
  stamp:()=>string;
  actor:string;
  created:Set<string>;
}

type OperationOutcome = {ok:true; parentIds:string[]; childIds:string[]; relationIds:string[]} | {ok:false; reason:string};

function applyOperation(context:ApplyContext, op:DreamOperation):OperationOutcome {
  switch (op.kind) {
    case 'merge': return applyMerge(context, op);
    case 'archive': return applyArchive(context, op);
    case 'relation': return applyRelation(context, op);
    case 'split': return applySplit(context, op);
    case 'profile': return applyProfile(context, op);
    case 'distill': return applyDistill(context, op);
  }
}

function applyMerge(context:ApplyContext, op:Extract<DreamOperation, {kind:'merge'}>):OperationOutcome {
  const parentIds = [...op.parentIds].sort();
  if (parentIds.length < MERGE_MIN_PARENTS) return {ok:false, reason:'merge-needs-parents'};
  const parents:StoredMemoryRecord[] = [];
  for (const id of parentIds) {
    const record = loadActiveRecord(context.db, id, context.projectId);
    if (!record) return {ok:false, reason:'parent-missing-or-inactive'};
    parents.push(record);
  }
  const childId = uuidFrom(['merge', context.consolidationId, ...parentIds]);
  if (selectRecord(context.db, childId)) return {ok:false, reason:'child-exists'};
  const at = context.stamp();
  const json = buildMergedRecord({childId, consolidationId:context.consolidationId, projectId:context.projectId, op, parents, at, hash:context.hash});
  insertMemoryRecord(context.db, json, context.consolidationId, context.hash);
  context.created.add(childId);
  const retiredAt = context.stamp();
  for (const parent of parents) retireRecord(context.db, parent, 'Dream 合并：父记录已合并为同主题单条记录', context.consolidationId, retiredAt);
  return {ok:true, parentIds, childIds:[childId], relationIds:[]};
}

function applyArchive(context:ApplyContext, op:Extract<DreamOperation, {kind:'archive'}>):OperationOutcome {
  const record = loadActiveRecord(context.db, op.memoryId, context.projectId);
  if (!record) return {ok:false, reason:'parent-missing-or-inactive'};
  const reason = op.reason === 'expired' ? 'Dream 归档：已过期' : 'Dream 归档：留存分低';
  retireRecord(context.db, record, reason, context.consolidationId, context.stamp());
  return {ok:true, parentIds:[op.memoryId], childIds:[], relationIds:[]};
}

function applyRelation(context:ApplyContext, op:Extract<DreamOperation, {kind:'relation'}>):OperationOutcome {
  requireTable(context.db, 'memory_relations');
  for (const id of [op.fromId, op.toId]) {
    const exists = context.created.has(id) || !!selectRecord(context.db, id);
    if (!exists) return {ok:false, reason:'relation-endpoint-missing'};
  }
  const relationId = uuidFrom(['relation', context.consolidationId, op.fromId, op.toId, op.relation]);
  const at = context.stamp();
  const json = JSON.stringify({
    v:1,
    projectId:context.projectId,
    consolidationId:context.consolidationId,
    fromId:op.fromId,
    toId:op.toId,
    relation:op.relation,
    actor:context.actor,
    createdAt:at,
  });
  context.db.prepare('INSERT INTO memory_relations(id,project_id,from_id,to_id,kind,created_at,json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
    .run(relationId, context.projectId, op.fromId, op.toId, op.relation, at, json);
  return {ok:true, parentIds:[], childIds:[], relationIds:[relationId]};
}

function applySplit(context:ApplyContext, op:Extract<DreamOperation, {kind:'split'}>):OperationOutcome {
  const parent = loadActiveRecord(context.db, op.parentId, context.projectId);
  if (!parent) return {ok:false, reason:'parent-missing-or-inactive'};
  const parts = normalizeParts(op.parts);
  if (parts.length < 2) return {ok:false, reason:'invalid-parts'};
  const origin:DreamOrigin = op.origin === 'user' ? 'user' : 'model';
  const active = origin === 'user' && (isUserTrust(parent.trust) || parent.json.confirmedBy === 'user');
  const childIds:string[] = [];
  const children:Record<string, unknown>[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const sources = resolvePartSources(Array.isArray(parent.json.sources) ? parent.json.sources : [], part.sourceIds);
    if (!sources.length) return {ok:false, reason:'split-part-unsourced'};
    const childId = uuidFrom(['split', context.consolidationId, parent.id, String(index)]);
    if (selectRecord(context.db, childId)) return {ok:false, reason:'child-exists'};
    childIds.push(childId);
    children.push({id:childId, part, sources});
  }
  const at = context.stamp();
  for (const child of children) {
    const part = child.part as DreamProposalPart;
    const json = buildDerivedRecord({
      id:child.id as string,
      consolidationId:context.consolidationId,
      projectId:context.projectId,
      scope:parent.scope,
      kind:recordKind(parent),
      title:part.title,
      content:part.content,
      conditions:part.conditions,
      status:active ? 'active' : 'candidate',
      sources:child.sources as unknown[],
      parentIds:[parent.id],
      trust:active ? (isUserTrust(parent.trust) ? parent.trust : 'user_confirmed') : (parent.trust ?? 'model_supported'),
      confirmedBy:active ? 'user' : 'system',
      origin,
      at,
      hash:context.hash,
      extra:{
        validFrom:parent.json.validFrom ?? null,
        validTo:parent.json.validTo ?? null,
        expiresAt:parent.json.expiresAt ?? null,
        sourceIds:part.sourceIds,
      },
    });
    insertMemoryRecord(context.db, json, context.consolidationId, context.hash);
    context.created.add(json.id as string);
  }
  // A model-proposed split only creates candidates; the still-valid parent must remain
  // active until the user confirms the split. User-confirmed splits retire it immediately.
  if (origin === 'user') retireRecord(context.db, parent, 'Dream 拆分：父记录已拆分为多条单主张记录', context.consolidationId, context.stamp());
  return {ok:true, parentIds:origin === 'user' ? [parent.id] : [], childIds, relationIds:[]};
}

function applyProfile(context:ApplyContext, op:Extract<DreamOperation, {kind:'profile'}>):OperationOutcome {
  const userConfirmed = op.origin !== 'model';
  const parentIds = [...op.parentIds].sort();
  const parents:StoredMemoryRecord[] = [];
  for (const id of parentIds) {
    const record = loadActiveRecord(context.db, id, context.projectId);
    if (!record) return {ok:false, reason:'parent-missing-or-inactive'};
    parents.push(record);
  }
  // A profile may only aggregate user-confirmed material.
  if (!parents.every(record => isUserTrust(record.trust) || record.json.confirmedBy === 'user')) return {ok:false, reason:'profile-requires-user-confirmed-parent'};
  const childId = uuidFrom(['profile', context.consolidationId, ...parentIds]);
  if (selectRecord(context.db, childId)) return {ok:false, reason:'child-exists'};
  const at = context.stamp();
  const rep = storedRepresentative(parents);
  const repTitle = typeof rep.json.title === 'string' ? rep.json.title.slice(0, MAX_TITLE) : '';
  const json = buildDerivedRecord({
    id:childId,
    consolidationId:context.consolidationId,
    projectId:context.projectId,
    scope:'personal',
    kind:'profile',
    title:repTitle || '个人画像',
    content:op.content,
    conditions:op.conditions.length ? op.conditions : sortStrings(parents.flatMap(record => stringList(record.json.conditions))),
    status:userConfirmed ? 'active' : 'candidate',
    sources:unionField(parents, 'sources'),
    parentIds,
    trust:userConfirmed ? 'user_confirmed' : 'model_supported',
    ...(userConfirmed ? {confirmedBy:'user' as const} : {}),
    origin:op.origin === 'model' ? 'model' : 'user',
    at,
    hash:context.hash,
    extra:{
      aliases:sortStrings(parents.flatMap(record => stringList(record.json.aliases))),
      evidence:unionField(parents, 'evidence'),
      dependencies:unionField(parents, 'dependencies'),
      validFrom:latestIso(parents.map(record => record.json.validFrom)),
      validTo:earliestIso(parents.map(record => record.json.validTo)),
    },
  });
  insertMemoryRecord(context.db, json, context.consolidationId, context.hash);
  context.created.add(childId);
  const retiredAt = context.stamp();
  if (userConfirmed) for (const parent of parents) retireRecord(context.db, parent, 'Dream 画像更新：已聚合为用户确认的新画像', context.consolidationId, retiredAt);
  return {ok:true, parentIds:userConfirmed ? parentIds : [], childIds:[childId], relationIds:[]};
}

function applyDistill(context:ApplyContext, op:Extract<DreamOperation, {kind:'distill'}>):OperationOutcome {
  const parentIds = [...op.parentIds].sort();
  if (parentIds.length < DISTILL_MIN_PARENTS) return {ok:false, reason:'distill-needs-parents'};
  const parents:StoredMemoryRecord[] = [];
  for (const id of parentIds) {
    const record = loadActiveRecord(context.db, id, context.projectId);
    if (!record) return {ok:false, reason:'parent-missing-or-inactive'};
    parents.push(record);
  }
  const childId = uuidFrom(['distill', context.consolidationId, ...parentIds]);
  if (selectRecord(context.db, childId)) return {ok:false, reason:'child-exists'};
  const at = context.stamp();
  const scope = parents.every(record => record.scope === 'personal') ? 'personal' : 'project';
  const json = buildDerivedRecord({
    id:childId,
    consolidationId:context.consolidationId,
    projectId:context.projectId,
    scope,
    kind:distillKind(parents, scope),
    title:op.title || op.content.slice(0, 80),
    content:op.content,
    conditions:op.conditions.length ? op.conditions : sortStrings(parents.flatMap(record => stringList(record.json.conditions))),
    status:'candidate',
    sources:unionField(parents, 'sources'),
    parentIds,
    trust:'model_supported',
    origin:op.origin === 'user' ? 'user' : 'model',
    at,
    hash:context.hash,
    extra:{
      evidence:unionField(parents, 'evidence'),
      dependencies:unionField(parents, 'dependencies'),
    },
  });
  insertMemoryRecord(context.db, json, context.consolidationId, context.hash);
  context.created.add(childId);
  // Parents stay active: distillation only proposes a candidate.
  return {ok:true, parentIds, childIds:[childId], relationIds:[]};
}

function normalizePlan(raw:DreamPlan):DreamPlan {
  if (!raw || typeof raw !== 'object') throw new Error('applyDreamPlan 需要计划');
  const projectId = requireText(raw.projectId, '计划缺少项目编号');
  const operations = Array.isArray(raw.operations)
    ? raw.operations.map(normalizeOperation).filter((op):op is DreamOperation => op !== undefined)
    : [];
  const sorted = sortOperations(operations);
  const proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const consolidationId = typeof raw.consolidationId === 'string' && raw.consolidationId.trim()
    ? raw.consolidationId.trim()
    : consolidationIdFor(projectId, sorted, proposals);
  return {consolidationId, projectId, operations:sorted, proposals};
}

function consolidationRow(db:DatabaseSync, consolidationId:string):SqlRow | undefined {
  return db.prepare('SELECT * FROM memory_consolidations WHERE id=?').get(consolidationId) as SqlRow | undefined;
}

function auditKind(applied:AppliedDreamOperation[]):string {
  const kinds = sortStrings(applied.map(item => item.op.kind));
  return kinds.length ? kinds.join('+') : 'dream';
}

function insertConsolidation(input:{
  db:DatabaseSync;
  plan:DreamPlan;
  applied:AppliedDreamOperation[];
  skipped:{op:DreamOperation; reason:string}[];
  actor:string;
  at:string;
  hash:(value:unknown)=>string;
}):string {
  const {db, plan, applied, skipped, actor, at, hash} = input;
  const parentIds = [...new Set(applied.flatMap(item => item.parentIds))].sort();
  const childIds = [...new Set(applied.flatMap(item => item.childIds))].sort();
  const relationIds = [...new Set(applied.flatMap(item => item.relationIds))].sort();
  const rollbackToken = hash(stableStringify(['dream-rollback', plan.consolidationId]));
  const diff = {
    v:1,
    ruleVersion:DREAM_RULE_VERSION,
    projectId:plan.projectId,
    consolidationId:plan.consolidationId,
    applied:applied.map(item => ({
      kind:item.op.kind,
      parentIds:item.parentIds,
      childIds:item.childIds,
      relationIds:item.relationIds,
    })),
    skipped:skipped.map(item => ({kind:item.op.kind, reason:item.reason})),
    relationIds,
  };
  const row = {
    v:1,
    ruleVersion:DREAM_RULE_VERSION,
    plan,
    applied:diff.applied,
    skipped:diff.skipped,
    actor,
    createdAt:at,
  };
  db.prepare(`INSERT INTO memory_consolidations(id,project_id,kind,status,actor,created_at,applied_at,rolled_back_at,diff_json,parent_ids_json,child_ids_json,rollback_token,json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    plan.consolidationId,
    plan.projectId,
    auditKind(applied),
    'applied',
    actor,
    at,
    at,
    null,
    JSON.stringify(diff),
    JSON.stringify(parentIds),
    JSON.stringify(childIds),
    rollbackToken,
    JSON.stringify(row),
  );
  return rollbackToken;
}

/**
 * Apply a plan inside one transaction.
 *
 * Returns the applied operations, per-operation skip reasons (stale parents,
 * already materialised children, ...), the parent ids that were retired and the
 * derived record ids. Applying the same `consolidationId` twice is a no-op
 * (`already-applied`) and never duplicates rows.
 *
 * The caller must run its own re-projection (FTS/policy/projection/events) after
 * this returns; Dream only performs plain SQLite writes.
 */
export function applyDreamPlan(db:DatabaseSync, input:ApplyDreamPlanInput):ApplyDreamPlanResult {
  if (!db || typeof db.prepare !== 'function') throw new Error('applyDreamPlan 需要 DatabaseSync');
  if (!input || typeof input.now !== 'function') throw new Error('applyDreamPlan 需要 now()');
  const plan = normalizePlan(input.plan);
  const hash = typeof input.digest === 'function' ? input.digest : sha;
  const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim().slice(0, 64) : 'dream';
  requireTable(db, 'memory_records');
  requireTable(db, 'memory_consolidations');

  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (consolidationRow(db, plan.consolidationId)) {
      const skipped = plan.operations.map(op => ({op, reason:'already-applied'}));
      if (ownTransaction) db.exec('COMMIT');
      return {consolidationId:plan.consolidationId, applied:[], skipped, parentIds:[], childIds:[]};
    }
    const context:ApplyContext = {
      db,
      plan,
      projectId:plan.projectId,
      consolidationId:plan.consolidationId,
      hash,
      stamp:() => isoNow(input.now(), 'applyDreamPlan now() 无效'),
      actor,
      created:new Set<string>(),
    };
    const applied:AppliedDreamOperation[] = [];
    const skipped:{op:DreamOperation; reason:string}[] = [];
    for (const op of plan.operations) {
      const outcome = applyOperation(context, op);
      if (outcome.ok) applied.push({op, parentIds:outcome.parentIds, childIds:outcome.childIds, relationIds:outcome.relationIds});
      else skipped.push({op, reason:outcome.reason});
    }
    if (applied.length) {
      insertConsolidation({db, plan, applied, skipped, actor, at:context.stamp(), hash});
    }
    const parentIds = [...new Set(applied.flatMap(item => item.parentIds))].sort();
    const childIds = [...new Set(applied.flatMap(item => item.childIds))].sort();
    if (ownTransaction) db.exec('COMMIT');
    return {consolidationId:plan.consolidationId, applied:applied.map(item => item.op), skipped, parentIds, childIds};
  } catch (error) {
    if (ownTransaction && db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Roll a consolidation back: every parent retired by the plan becomes active
 * again, every derived record becomes inactive and the plan's relations are
 * deleted. The audit row moves to `rolled_back`; repeated rollbacks are a no-op.
 */
export function rollbackConsolidation(db:DatabaseSync, input:RollbackConsolidationInput):{restored:string[]; revoked:string[]} {
  if (!db || typeof db.prepare !== 'function') throw new Error('rollbackConsolidation 需要 DatabaseSync');
  if (!input || typeof input.now !== 'function') throw new Error('rollbackConsolidation 需要 now()');
  const consolidationId = requireText(input.consolidationId, 'rollbackConsolidation 需要巩固编号');
  const projectId = requireText(input.projectId, 'rollbackConsolidation 需要项目编号');
  requireTable(db, 'memory_records');
  requireTable(db, 'memory_consolidations');
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const row = consolidationRow(db, consolidationId);
    if (!row) {
      if (ownTransaction) db.exec('COMMIT');
      return {restored:[], revoked:[]};
    }
    if (String(row.project_id) !== projectId) throw codedError('PERMISSION_DENIED', '巩固记录不属于当前项目');
    if (String(row.status) === 'rolled_back') {
      if (ownTransaction) db.exec('COMMIT');
      return {restored:[], revoked:[]};
    }
    const at = isoNow(input.now(), 'rollbackConsolidation now() 无效');
    const parentIds = parseStringArray(row.parent_ids_json);
    const childIds = parseStringArray(row.child_ids_json);
    const restored:string[] = [];
    const revoked:string[] = [];
    for (const id of parentIds) {
      const record = selectRecord(db, id);
      if (!record || record.status === 'active') continue;
      if (consolidationMarker(record) !== consolidationId) continue;
      restoreRecord(db, record, at);
      restored.push(id);
    }
    for (const id of childIds) {
      const record = selectRecord(db, id);
      if (!record) continue;
      if (record.status !== 'active' && record.status !== 'candidate' && record.status !== 'invalidated') continue;
      if (consolidationMarker(record) !== consolidationId) continue;
      revokeRecord(db, record, at, 'Dream 巩固已回滚，派生记录停用');
      revoked.push(id);
    }
    if (tableExists(db, 'memory_relations')) {
      const relations = db.prepare('SELECT * FROM memory_relations WHERE project_id=?').all(projectId) as SqlRow[];
      const remove = db.prepare('DELETE FROM memory_relations WHERE id=?');
      for (const relation of relations) {
        const json = parseJsonObject(relation.json);
        if (json.consolidationId !== consolidationId) continue;
        remove.run(String(relation.id));
      }
    }
    db.prepare("UPDATE memory_consolidations SET status='rolled_back',rolled_back_at=? WHERE id=?").run(at, consolidationId);
    if (ownTransaction) db.exec('COMMIT');
    return {restored, revoked};
  } catch (error) {
    if (ownTransaction && db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}
