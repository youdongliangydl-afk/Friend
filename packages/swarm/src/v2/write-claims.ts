/**
 * Swarm v2 write claims (P0-B): normalized workspace scopes, overlap detection,
 * preflight and acquisition/release of an attempt's write claim.
 *
 * A write claim is the durable statement "this attempt may write these paths".
 * The scheduler preflights before dispatching; acquisition re-runs the same
 * check inside its own transaction so a race can never grant two overlapping
 * writers. Every mutation appends a journal event in the same transaction.
 */
import {randomUUID} from 'node:crypto';
import {CapabilityError} from '@friend-pi/core';
import type {V2Store} from './store.js';
import {v2Now} from './store.js';

export type SwarmV2WriteClaimState = 'active' | 'released' | 'unknown';

export interface SwarmV2WriteClaim {
  claimId: string;
  teamId: string;
  attemptId: string;
  taskId: string;
  memberId: string | null;
  scopes: string[];
  state: SwarmV2WriteClaimState;
  acquiredAt: string;
  releasedAt: string | null;
}

/** Structurally identical to `Held{Cause,By}` used by scheduler diagnostics. */
export interface WriteClaimHeld {
  held: true;
  cause: 'write-scope';
  by: {attemptId: string; taskId: string; scopes: string[]};
}
export type WriteClaimPreflight = {held: false} | WriteClaimHeld;

export interface AcquireClaimInput {
  teamId: string;
  attemptId: string;
  taskId: string;
  memberId?: string | null;
  scopes: string[];
}
export type AcquireClaimResult = {held: false; claim: SwarmV2WriteClaim} | WriteClaimHeld;

export interface ClaimPreflightOptions {
  /** The attempt being checked itself must not count as a conflict. */
  attemptId?: string;
}

const MAX_SCOPES = 64;
const MAX_SCOPE_LENGTH = 500;

function scopesFromJson(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw ?? '[]')) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function claimFromRow(row: Record<string, unknown>): SwarmV2WriteClaim {
  return {
    claimId: String(row.claim_id),
    teamId: String(row.team_id),
    attemptId: String(row.attempt_id),
    taskId: String(row.task_id),
    memberId: row.member_id === null || row.member_id === undefined ? null : String(row.member_id),
    scopes: scopesFromJson(row.scopes_json),
    state: String(row.state) as SwarmV2WriteClaimState,
    acquiredAt: String(row.acquired_at),
    releasedAt: row.released_at === null || row.released_at === undefined ? null : String(row.released_at),
  };
}

/**
 * Canonical form of a workspace-relative scope: forward slashes, no duplicate
 * separators, no trailing slash, no leading "./". `"."` means the whole
 * workspace and is never rewritten.
 */
export function normalizeScope(scope: string): string {
  if (typeof scope !== 'string') throw new CapabilityError('VALIDATION_ERROR', 'scope 必须是字符串');
  let value = scope.trim().replace(/\\/gu, '/');
  if (!value) throw new CapabilityError('VALIDATION_ERROR', 'scope 不能为空');
  value = value.replace(/\/{2,}/gu, '/');
  if (value === '.' || value === './') return '.';
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/\/{2,}/gu, '/');
  // Collapse internal "." segments so `src/./a` cannot evade scope overlap checks.
  value = value.split('/').filter(segment => segment !== '.').join('/');
  if (value.length > 1) value = value.replace(/\/+$/u, '');
  if (!value) value = '.';
  if (value !== '.' && value.length > MAX_SCOPE_LENGTH) throw new CapabilityError('VALIDATION_ERROR', 'scope 过长');
  return value;
}

/** Reject absolute paths, parent traversal and empty scopes; normalize + dedupe. */
export function validateScopes(scopes: unknown, mode: 'read' | 'write'): string[] {
  if (!Array.isArray(scopes)) throw new CapabilityError('VALIDATION_ERROR', 'scopes 必须是字符串数组');
  if (scopes.length > MAX_SCOPES) throw new CapabilityError('VALIDATION_ERROR', `scopes 不能超过 ${MAX_SCOPES} 项`);
  const normalized: string[] = [];
  for (const raw of scopes) {
    if (typeof raw !== 'string') throw new CapabilityError('VALIDATION_ERROR', 'scopes 必须是字符串数组');
    const value = normalizeScope(raw);
    if (value.startsWith('/') || /^[A-Za-z]:\//u.test(value) || value.split('/').includes('..')) {
      throw new CapabilityError('VALIDATION_ERROR', `scope 不能是绝对路径或包含 ..：${raw}`);
    }
    normalized.push(value);
  }
  const unique = [...new Set(normalized)];
  if (mode === 'write' && !unique.length) throw new CapabilityError('VALIDATION_ERROR', '写任务必须声明至少一个 writeScope');
  if (mode === 'read' && unique.length) throw new CapabilityError('VALIDATION_ERROR', '只读任务不能声明 writeScope');
  return unique;
}

/** Two scopes overlap when equal, when one is the other's directory, or when either is ".". */
export function scopesOverlap(a: string, b: string): boolean {
  const left = normalizeScope(a), right = normalizeScope(b);
  if (left === '.' || right === '.') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertTeam(store: V2Store, teamId: string): void {
  if (!store.row('SELECT 1 FROM swarm_v2_teams WHERE team_id=?', teamId)) {
    throw new CapabilityError('VALIDATION_ERROR', '团队不存在');
  }
}

/**
 * Read a point-in-time preflight answer: active claims first, then the task
 * scopes of attempts that are currently running. Deterministic order so the
 * scheduler's Held{By} is stable.
 */
export function claimPreflight(store: V2Store, teamId: string, scopes: string[], options: ClaimPreflightOptions = {}): WriteClaimPreflight {
  const mine = validateScopes(scopes, 'write');
  assertTeam(store, teamId);
  const exclude = options.attemptId;
  const claims = store.rows<Record<string, unknown>>(
    "SELECT claim_id,attempt_id,task_id,scopes_json,acquired_at FROM swarm_v2_write_claims WHERE team_id=? AND state='active' ORDER BY acquired_at ASC,claim_id ASC",
    teamId,
  );
  for (const row of claims) {
    const attemptId = String(row.attempt_id);
    if (exclude !== undefined && attemptId === exclude) continue;
    const held = scopesFromJson(row.scopes_json);
    if (held.some(scope => mine.some(candidate => scopesOverlap(scope, candidate)))) {
      return {held: true, cause: 'write-scope', by: {attemptId, taskId: String(row.task_id), scopes: held}};
    }
  }
  const running = store.rows<Record<string, unknown>>(
    `SELECT a.attempt_id AS attempt_id, a.task_id AS task_id, s.scope AS scope
       FROM swarm_v2_attempts a
       JOIN swarm_v2_tasks t ON t.task_id=a.task_id
       LEFT JOIN swarm_v2_task_scopes s ON s.task_id=t.task_id
      WHERE t.team_id=? AND a.status='running'
      ORDER BY a.started_at ASC, a.attempt_id ASC, s.scope ASC`,
    teamId,
  );
  const byAttempt = new Map<string, {taskId: string; scopes: string[]}>();
  for (const row of running) {
    const attemptId = String(row.attempt_id);
    const entry = byAttempt.get(attemptId) ?? {taskId: String(row.task_id), scopes: []};
    if (row.scope !== null && row.scope !== undefined) entry.scopes.push(String(row.scope));
    byAttempt.set(attemptId, entry);
  }
  for (const [attemptId, entry] of byAttempt) {
    if (exclude !== undefined && attemptId === exclude) continue;
    if (entry.scopes.some(scope => mine.some(candidate => scopesOverlap(scope, candidate)))) {
      return {held: true, cause: 'write-scope', by: {attemptId, taskId: entry.taskId, scopes: entry.scopes}};
    }
  }
  return {held: false};
}

/**
 * Acquire one active claim for an attempt. Re-runs the preflight inside the
 * write transaction; a conflict is journaled as `workspace.conflict.held` and
 * returned (never partially written).
 */
export function acquireClaim(store: V2Store, input: AcquireClaimInput): AcquireClaimResult {
  const teamId = String(input?.teamId ?? '').trim();
  const attemptId = String(input?.attemptId ?? '').trim();
  const taskId = String(input?.taskId ?? '').trim();
  if (!teamId || !attemptId || !taskId) throw new CapabilityError('VALIDATION_ERROR', '写声明缺少团队/任务/尝试编号');
  const scopes = validateScopes(input.scopes, 'write');
  const memberId = input.memberId === undefined || input.memberId === null ? null : String(input.memberId);
  return store.transaction(() => {
    assertTeam(store, teamId);
    const attempt = store.row<{task_id: string; status: string}>('SELECT task_id,status FROM swarm_v2_attempts WHERE attempt_id=?', attemptId);
    if (!attempt) throw new CapabilityError('VALIDATION_ERROR', '尝试不存在');
    if (attempt.task_id !== taskId) throw new CapabilityError('VALIDATION_ERROR', '尝试与任务不匹配');
    if (!['prepared', 'running'].includes(attempt.status)) throw new CapabilityError('VERSION_CONFLICT', `尝试状态 ${attempt.status} 不能申请写声明`);
    const task = store.row<{team_id: string; current_attempt_id: string | null}>('SELECT team_id,current_attempt_id FROM swarm_v2_tasks WHERE task_id=?', taskId);
    if (!task || task.team_id !== teamId) throw new CapabilityError('VALIDATION_ERROR', '任务不存在或不属于该团队');
    if (task.current_attempt_id !== attemptId) throw new CapabilityError('VERSION_CONFLICT', '尝试不是任务当前尝试');
    const declared = store.rows<{scope: string}>('SELECT scope FROM swarm_v2_task_scopes WHERE task_id=?', taskId).map(row => normalizeScope(String(row.scope)));
    if (!declared.length) throw new CapabilityError('VALIDATION_ERROR', '写任务没有声明写范围');
    const outside = scopes.filter(scope => !declared.some(base => normalizeScope(base) === '.' || scope === normalizeScope(base) || scope.startsWith(`${normalizeScope(base)}/`)));
    if (outside.length) throw new CapabilityError('VALIDATION_ERROR', `写声明超出任务声明范围：${outside.join(',')}`);
    const existing = store.row<Record<string, unknown>>("SELECT * FROM swarm_v2_write_claims WHERE team_id=? AND attempt_id=? AND state='active'", teamId, attemptId);
    if (existing) {
      const claim = claimFromRow(existing);
      if (JSON.stringify(claim.scopes) === JSON.stringify(scopes)) return {held: false as const, claim};
      throw new CapabilityError('VERSION_CONFLICT', '同一尝试的写声明范围已变化');
    }
    const preflight = claimPreflight(store, teamId, scopes, {attemptId});
    if (preflight.held) {
      store.journal(teamId, 'workspace.conflict.held', {kind: 'system', id: 'write-claims'}, {kind: 'write-claim', id: attemptId}, {
        attemptId, taskId, cause: preflight.cause, by: preflight.by,
      });
      return preflight;
    }
    const claimId = randomUUID(), acquiredAt = v2Now();
    store.db.prepare('INSERT INTO swarm_v2_write_claims(claim_id,team_id,attempt_id,task_id,member_id,scopes_json,state,acquired_at,released_at) VALUES(?,?,?,?,?,?,?,?,NULL)')
      .run(claimId, teamId, attemptId, taskId, memberId, JSON.stringify(scopes), 'active', acquiredAt);
    store.journal(teamId, 'workspace.claimed', {kind: 'member', id: memberId ?? attemptId}, {kind: 'write-claim', id: claimId}, {
      claimId, attemptId, taskId, scopes,
    });
    return {held: false as const, claim: {claimId, teamId, attemptId, taskId, memberId, scopes, state: 'active', acquiredAt, releasedAt: null}};
  });
}

/** Release one active claim as normally released or unknown (crash/timeout). */
export function releaseClaim(store: V2Store, attemptId: string, state: 'released' | 'unknown' = 'released'): SwarmV2WriteClaim {
  const id = String(attemptId ?? '').trim();
  if (!id) throw new CapabilityError('VALIDATION_ERROR', '缺少尝试编号');
  if (state !== 'released' && state !== 'unknown') throw new CapabilityError('VALIDATION_ERROR', '写声明释放状态无效');
  return store.transaction(() => {
    const row = store.row<Record<string, unknown>>("SELECT * FROM swarm_v2_write_claims WHERE attempt_id=? AND state='active'", id);
    if (!row) throw new CapabilityError('VALIDATION_ERROR', '写声明不存在或已释放');
    const claim = claimFromRow(row);
    const releasedAt = v2Now();
    store.db.prepare("UPDATE swarm_v2_write_claims SET state=?,released_at=? WHERE claim_id=?").run(state, releasedAt, claim.claimId);
    store.journal(claim.teamId, 'workspace.released', {kind: 'system', id: 'write-claims'}, {kind: 'write-claim', id: claim.claimId}, {
      claimId: claim.claimId, attemptId: claim.attemptId, taskId: claim.taskId, state,
    });
    return {...claim, state, releasedAt};
  });
}

/** Active claims of a team, deterministic by acquisition order. */
export function activeClaims(store: V2Store, teamId: string): SwarmV2WriteClaim[] {
  return store.rows<Record<string, unknown>>(
    "SELECT * FROM swarm_v2_write_claims WHERE team_id=? AND state='active' ORDER BY acquired_at ASC,claim_id ASC",
    teamId,
  ).map(claimFromRow);
}
