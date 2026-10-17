import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../../core/src/index.js';
import { isValidSubjectKey, type SubjectPeer } from './subjects.js';

/**
 * First-class subject conflict objects (blueprint §6, P0-SPEC §3.2).
 *
 * The conflict model is deliberately independent from the memory controller:
 * detection is a pure decision, and `ConflictStore` only owns the
 * memory_conflicts / memory_conflict_sides rows. Record status changes
 * (old active stays usable, new value isolated as candidate, keep/drop after a
 * ruling) are controller mutations and stay in `index.ts`.
 */

export type ConflictStatus = 'open' | 'deferred' | 'resolved' | 'superseded';
export type ConflictResolution = 'keep_left' | 'keep_right' | 'merge' | 'both' | 'neither';

export interface ConflictSide {
  side: 'left' | 'right';
  memoryId: string;
  revision: number;
  claimHash: string;
  supportScore: number;
  evidence: JsonObject[];
}

export interface ConflictRecord {
  id: string;
  projectId: string;
  scope: string;
  subjectKey: string;
  status: ConflictStatus;
  resolution: ConflictResolution | null;
  openedAt: string;
  openedBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
  policyVersion?: number;
  notes?: string;
  sides: ConflictSide[];
}

export type ConflictDecision =
  | { action: 'none' }
  | { action: 'merge'; peer: SubjectPeer }
  | { action: 'supersede'; peer: SubjectPeer }
  | { action: 'open'; peer?: SubjectPeer; reason: string };

export type ConflictSideInput = Omit<ConflictSide, 'side'>;

export interface ConflictOpenInput {
  projectId: string;
  scope: string;
  subjectKey: string;
  left: ConflictSideInput;
  right: ConflictSideInput;
  openedBy: 'learning' | 'user' | 'migration';
  policyVersion?: number;
  notes?: string;
}

export interface ConflictTransitionInput {
  resolution: ConflictResolution | 'defer';
  resolvedBy: 'user';
  notes?: string;
}

export interface DetectSubjectConflictInput {
  subjectKey?: string | null;
  claimHash: string;
  trust: string;
  kind: string;
  peers: SubjectPeer[];
  hasCorrectionEvidence: boolean;
  explicitSupersedeIntent: boolean;
}

const STATUSES = new Set<string>(['open', 'deferred', 'resolved', 'superseded']);
const RESOLUTIONS = new Set<string>(['keep_left', 'keep_right', 'merge', 'both', 'neither']);
const OPENED_BY = new Set<string>(['learning', 'user', 'migration']);
const MAX_NOTES_LENGTH = 4000;

function conflictError(code: 'VALIDATION_ERROR' | 'VERSION_CONFLICT', message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  if (code === 'VERSION_CONFLICT') error.name = 'ConflictError';
  return error;
}

function byUpdatedAt(peers: SubjectPeer[]): SubjectPeer[] {
  return [...peers].sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

/**
 * Decide how a newly published value relates to the active peers of its
 * subject. The caller supplies immutable observations: `claimHash` of the new
 * value, whether a user correction points at a peer, and whether the text has
 * explicit supersede intent. No subject key means candidate-only, never a
 * conflict: automatic publishing gates force it to stay a candidate.
 *
 * Blueprint §6.3 semantics (P0 simplification): same normalized value merges
 * evidence; an explicit user correction or user-authority supersede intent
 * replaces the peer; any other different value opens a conflict and leaves the
 * old active value usable.
 */
export function detectSubjectConflict(input: DetectSubjectConflictInput): ConflictDecision {
  const subjectKey = typeof input?.subjectKey === 'string' ? input.subjectKey.trim() : '';
  if (!subjectKey) return { action: 'none' };
  const claimHash = typeof input.claimHash === 'string' ? input.claimHash : '';
  const peers = Array.isArray(input.peers) ? byUpdatedAt(input.peers) : [];
  if (!peers.length) return { action: 'none' };
  const sameValue = peers.find(peer => peer.claimHash === claimHash);
  if (sameValue) return { action: 'merge', peer: sameValue };
  const latest = peers[0];
  if (input.hasCorrectionEvidence === true) return { action: 'supersede', peer: latest };
  const userAuthority = input.trust === 'user_explicit' || input.trust === 'user_confirmed';
  if (userAuthority && input.explicitSupersedeIntent === true) return { action: 'supersede', peer: latest };
  return { action: 'open', peer: latest, reason: `同一主题 ${subjectKey} 已存在不同的有效值` };
}

interface ConflictRow {
  id: string;
  project_id: string;
  scope: string;
  subject_key: string;
  status: string;
  resolution: string | null;
  opened_at: string;
  opened_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  policy_version: number | null;
  notes: string | null;
  json: string;
}

interface SideRow {
  side: string;
  memory_id: string;
  revision: number;
  claim_hash: string;
  support_score: number;
  evidence_json: string;
}

const CONFLICT_COLUMNS = 'id,project_id,scope,subject_key,status,resolution,opened_at,opened_by,resolved_at,resolved_by,policy_version,notes,json';

function normalizeSide(side: ConflictSideInput, label: string): ConflictSideInput {
  if (!side || typeof side !== 'object') throw conflictError('VALIDATION_ERROR', `冲突${label}侧无效`);
  const memoryId = typeof side.memoryId === 'string' ? side.memoryId.trim() : '';
  if (!memoryId) throw conflictError('VALIDATION_ERROR', `冲突${label}侧缺少记忆编号`);
  if (!Number.isSafeInteger(side.revision) || side.revision < 1) throw conflictError('VALIDATION_ERROR', `冲突${label}侧修订号无效`);
  const claimHash = typeof side.claimHash === 'string' ? side.claimHash.trim() : '';
  if (!claimHash) throw conflictError('VALIDATION_ERROR', `冲突${label}侧缺少声明摘要`);
  if (!Number.isSafeInteger(side.supportScore) || side.supportScore < 0) throw conflictError('VALIDATION_ERROR', `冲突${label}侧支持分无效`);
  const evidence = side.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 200 || evidence.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw conflictError('VALIDATION_ERROR', `冲突${label}侧证据必须是对象数组`);
  }
  return { memoryId, revision: side.revision, claimHash, supportScore: side.supportScore, evidence: structuredClone(evidence) as JsonObject[] };
}

function decodeSide(row: SideRow): ConflictSide {
  const side = String(row.side) === 'right' ? 'right' : 'left';
  let evidence: JsonObject[] = [];
  try {
    const parsed = JSON.parse(String(row.evidence_json));
    if (Array.isArray(parsed)) evidence = parsed as JsonObject[];
  } catch {
    evidence = [];
  }
  return {
    side,
    memoryId: String(row.memory_id),
    revision: Number(row.revision),
    claimHash: String(row.claim_hash),
    supportScore: Number(row.support_score),
    evidence,
  };
}

/**
 * One row per conflict plus a sides table. The dedicated columns are
 * authoritative for queryable state; `json` always persists the complete
 * record for audit/UI, matching the v4 DDL.
 */
export class ConflictStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => string;

  constructor(db: DatabaseSync, options: { now?: () => string } = {}) {
    if (!db || typeof db.prepare !== 'function') throw conflictError('VALIDATION_ERROR', '冲突存储需要数据库连接');
    this.db = db;
    this.clock = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
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

  private sides(conflictId: string): ConflictSide[] {
    const rows = this.db.prepare('SELECT side,memory_id,revision,claim_hash,support_score,evidence_json FROM memory_conflict_sides WHERE conflict_id=? ORDER BY side ASC').all(conflictId) as unknown as SideRow[];
    return rows.map(decodeSide);
  }

  private decode(row: ConflictRow): ConflictRecord {
    const record: ConflictRecord = {
      id: String(row.id),
      projectId: String(row.project_id),
      scope: String(row.scope),
      subjectKey: String(row.subject_key),
      status: (STATUSES.has(String(row.status)) ? String(row.status) : 'open') as ConflictStatus,
      resolution: (row.resolution === null || row.resolution === undefined ? null : String(row.resolution)) as ConflictResolution | null,
      openedAt: String(row.opened_at),
      openedBy: String(row.opened_by),
      sides: [],
    };
    if (row.resolved_at !== null && row.resolved_at !== undefined) record.resolvedAt = String(row.resolved_at);
    if (row.resolved_by !== null && row.resolved_by !== undefined) record.resolvedBy = String(row.resolved_by);
    if (row.policy_version !== null && row.policy_version !== undefined) record.policyVersion = Number(row.policy_version);
    if (row.notes !== null && row.notes !== undefined) record.notes = String(row.notes);
    const sides = this.sides(record.id);
    if (sides.length) {
      record.sides = sides;
    } else {
      try {
        const parsed = JSON.parse(String(row.json)) as { sides?: unknown };
        if (Array.isArray(parsed.sides)) record.sides = parsed.sides as ConflictSide[];
      } catch {
        record.sides = [];
      }
    }
    return record;
  }

  /** Open a new conflict object. The two sides are immutable once written. */
  open(input: ConflictOpenInput): ConflictRecord {
    if (!input || typeof input !== 'object') throw conflictError('VALIDATION_ERROR', '冲突参数必须是对象');
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    if (!projectId) throw conflictError('VALIDATION_ERROR', '冲突需要项目编号');
    const scope = input.scope;
    if (scope !== 'project' && scope !== 'personal') throw conflictError('VALIDATION_ERROR', '冲突 scope 必须是 project 或 personal');
    const subjectKey = typeof input.subjectKey === 'string' ? input.subjectKey : '';
    if (!isValidSubjectKey(subjectKey)) throw conflictError('VALIDATION_ERROR', '冲突 subject 键无效');
    if (typeof input.openedBy !== 'string' || !OPENED_BY.has(input.openedBy)) throw conflictError('VALIDATION_ERROR', '冲突开启方无效');
    if (input.policyVersion !== undefined && (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1)) {
      throw conflictError('VALIDATION_ERROR', '冲突策略版本无效');
    }
    if (input.notes !== undefined && typeof input.notes !== 'string') throw conflictError('VALIDATION_ERROR', '冲突备注必须是字符串');
    const left = normalizeSide(input.left, '左');
    const right = normalizeSide(input.right, '右');
    const openedAt = this.clock();
    const record: ConflictRecord = {
      id: randomUUID(),
      projectId,
      scope,
      subjectKey,
      status: 'open',
      resolution: null,
      openedAt,
      openedBy: input.openedBy,
      sides: [{ side: 'left', ...left }, { side: 'right', ...right }],
    };
    if (input.policyVersion !== undefined) record.policyVersion = input.policyVersion;
    if (input.notes !== undefined) record.notes = input.notes.slice(0, MAX_NOTES_LENGTH);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO memory_conflicts(${CONFLICT_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.projectId, record.scope, record.subjectKey, record.status, record.resolution,
        record.openedAt, record.openedBy, record.resolvedAt ?? null, record.resolvedBy ?? null,
        record.policyVersion ?? null, record.notes ?? null, JSON.stringify(record));
      const insert = this.db.prepare('INSERT INTO memory_conflict_sides(conflict_id,side,memory_id,revision,claim_hash,support_score,evidence_json) VALUES(?,?,?,?,?,?,?)');
      for (const side of record.sides) insert.run(record.id, side.side, side.memoryId, side.revision, side.claimHash, side.supportScore, JSON.stringify(side.evidence));
    });
    return record;
  }

  /** Read one conflict inside its project boundary. */
  get(id: string, projectId: string): ConflictRecord | undefined {
    if (typeof id !== 'string' || !id || typeof projectId !== 'string' || !projectId) return undefined;
    const row = this.db.prepare(`SELECT ${CONFLICT_COLUMNS} FROM memory_conflicts WHERE id=? AND project_id=?`).get(id, projectId);
    return row ? this.decode(row as unknown as ConflictRow) : undefined;
  }

  /** List conflicts of one project, newest first, optionally filtered by status. */
  list(projectId: string, options: { status?: ConflictStatus } = {}): ConflictRecord[] {
    if (typeof projectId !== 'string' || !projectId) throw conflictError('VALIDATION_ERROR', '列出冲突需要项目编号');
    const status = options.status;
    if (status !== undefined && !STATUSES.has(String(status))) throw conflictError('VALIDATION_ERROR', '冲突状态无效');
    const rows = status === undefined
      ? this.db.prepare(`SELECT ${CONFLICT_COLUMNS} FROM memory_conflicts WHERE project_id=? ORDER BY opened_at DESC,id ASC`).all(projectId)
      : this.db.prepare(`SELECT ${CONFLICT_COLUMNS} FROM memory_conflicts WHERE project_id=? AND status=? ORDER BY opened_at DESC,id ASC`).all(projectId, status);
    return (rows as unknown as ConflictRow[]).map(row => this.decode(row));
  }

  /**
   * User ruling. Only open/deferred conflicts can transition. `defer` keeps the
   * conflict `deferred` without a resolution; every other resolution closes it
   * as `resolved`. The UPDATE is the compare-and-swap: if the row moved to a
   * terminal state first, the caller gets VERSION_CONFLICT. This method does not
   * touch memory records; the controller applies the ruling to records.
   */
  transition(id: string, projectId: string, input: ConflictTransitionInput): ConflictRecord {
    if (typeof id !== 'string' || !id) throw conflictError('VALIDATION_ERROR', '冲突编号无效');
    if (typeof projectId !== 'string' || !projectId) throw conflictError('VALIDATION_ERROR', '冲突需要项目编号');
    if (!input || typeof input !== 'object') throw conflictError('VALIDATION_ERROR', '裁决参数必须是对象');
    const resolution = input.resolution;
    if (resolution !== 'defer' && (typeof resolution !== 'string' || !RESOLUTIONS.has(resolution))) {
      throw conflictError('VALIDATION_ERROR', '冲突裁决无效');
    }
    if (input.resolvedBy !== 'user') throw conflictError('VALIDATION_ERROR', '冲突裁决必须由用户操作');
    if (input.notes !== undefined && typeof input.notes !== 'string') throw conflictError('VALIDATION_ERROR', '裁决备注必须是字符串');
    return this.transaction(() => {
      const current = this.get(id, projectId);
      if (!current) throw conflictError('VALIDATION_ERROR', '冲突不存在');
      if (current.status !== 'open' && current.status !== 'deferred') throw conflictError('VERSION_CONFLICT', '冲突已裁决或已取代，不能再次迁移');
      const deferred = resolution === 'defer';
      const resolvedAt = deferred ? current.resolvedAt : this.clock();
      const resolvedBy = deferred ? current.resolvedBy : 'user';
      const finalResolution = deferred ? current.resolution : resolution;
      const notes = input.notes !== undefined ? input.notes.slice(0, MAX_NOTES_LENGTH) : current.notes;
      const next: ConflictRecord = {
        ...current,
        status: deferred ? 'deferred' : 'resolved',
        resolution: finalResolution,
        sides: current.sides,
      };
      if (resolvedAt !== undefined) next.resolvedAt = resolvedAt; else delete next.resolvedAt;
      if (resolvedBy !== undefined) next.resolvedBy = resolvedBy; else delete next.resolvedBy;
      if (notes !== undefined) next.notes = notes; else delete next.notes;
      const result = this.db.prepare(`UPDATE memory_conflicts SET status=?,resolution=?,resolved_at=?,resolved_by=?,notes=?,json=?
        WHERE id=? AND project_id=? AND status IN ('open','deferred')`).run(
        next.status, next.resolution, next.resolvedAt ?? null, next.resolvedBy ?? null, next.notes ?? null, JSON.stringify(next), id, projectId);
      if (Number(result.changes) === 0) throw conflictError('VERSION_CONFLICT', '冲突状态已变化，请刷新后重试');
      return next;
    });
  }
}
