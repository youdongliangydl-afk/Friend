/**
 * Swarm v2 scheduler (P0-B): deterministic ready frontier, one-transaction
 * dispatch with write preflight, worker/attempt caps and budget reservation hook.
 *
 * The scheduler never executes a member turn. It atomically prepares + starts an
 * attempt (and takes the attempt's write claim) so the service layer can hand the
 * task to a member; every effect happens in one transaction, so a crash leaves
 * either the whole dispatch or none of it.
 */
import {CapabilityError} from '@friend-pi/core';
import type {V2Store} from './store.js';
import {intOrNull, optionalText} from './store.js';
import {
  DEFAULT_MAX_WORKERS, MAX_WORKERS,
  type SwarmV2Attempt, type SwarmV2BlockedReason, type SwarmV2Task,
} from './types.js';
import {
  attemptFromRow, getTeam, getTask, listTasks, markAttemptRunning, prepareAttempt, setTeamStatus,
} from './task-board.js';
import {acquireClaim, claimPreflight} from './write-claims.js';

export interface ScheduleEstimate {
  tokens: number;
  costMicros: number;
}

/** Caller-provided budget reservation hook. `null` means "budget unavailable". */
export type ScheduleReserve = (task: SwarmV2Task, estimate: ScheduleEstimate) => {tokens: number; costMicros: number} | null;

export interface ScheduleInput {
  /** Defaults to 4; hard cap 16. Consumed by this call only as a per-call cap. */
  maxWorkers?: number;
  /** Optional logical clock for callers/tests; journal timestamps stay authoritative. */
  now?: string;
  /** Fallback member id for every dispatched attempt (must exist in swarm_v2_members). */
  memberId?: string | null;
  /** Per-task member assignment; wins over `memberId`. */
  memberIdForTask?: Record<string, string>;
  /** Workspace id recorded on the prepared attempt. */
  workspaceId?: string | null;
  /** Reserve budget before dispatch; `null` blocks the task with kind 'budget'. */
  reserve?: ScheduleReserve;
}

export interface ScheduleDispatched {
  taskId: string;
  attemptId: string;
  memberId: string | null;
  writeClaimId?: string;
  budgetReservationId?: string;
}

export interface ScheduleBlocked {
  taskId: string;
  reason: SwarmV2BlockedReason;
}

export interface ScheduleResult {
  dispatched: ScheduleDispatched[];
  blocked: ScheduleBlocked[];
  running: number;
  exhausted: boolean;
}

const SCHEDULE_ESTIMATE: ScheduleEstimate = {tokens: 0, costMicros: 0};
const TERMINAL_OR_DELETED = new Set(['done', 'cancelled', 'deleted']);

function dependencyAdjacency(store: V2Store, teamId: string): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const row of store.rows<{task_id: string; depends_on: string}>(
    'SELECT d.task_id,d.depends_on FROM swarm_v2_task_dependencies d JOIN swarm_v2_tasks t ON t.task_id=d.task_id WHERE t.team_id=? ORDER BY d.rowid',
    teamId,
  )) {
    const id = String(row.task_id);
    edges.set(id, [...(edges.get(id) ?? []), String(row.depends_on)]);
  }
  return edges;
}

function topologicalDepth(edges: Map<string, string[]>, taskId: string, cache: Map<string, number>, visiting: Set<string>): number {
  const cached = cache.get(taskId);
  if (cached !== undefined) return cached;
  if (visiting.has(taskId)) throw new CapabilityError('VALIDATION_ERROR', `任务依赖形成环：${taskId}`);
  visiting.add(taskId);
  let depth = 0;
  for (const dependency of edges.get(taskId) ?? []) depth = Math.max(depth, topologicalDepth(edges, dependency, cache, visiting) + 1);
  visiting.delete(taskId);
  cache.set(taskId, depth);
  return depth;
}

function dependenciesSatisfied(store: V2Store, taskId: string): boolean {
  const rows = store.rows<{status: string; tombstone: number}>(
    'SELECT t.status,t.tombstone FROM swarm_v2_task_dependencies d JOIN swarm_v2_tasks t ON t.task_id=d.depends_on WHERE d.task_id=?',
    taskId,
  );
  return rows.every(row => Number(row.tombstone) === 1 || String(row.status) === 'deleted' || String(row.status) === 'done');
}

/**
 * Ready tasks whose dependencies are all done (or deleted), ordered by
 * topological depth then creation time then task id. Deterministic across runs.
 */
export function readyFrontier(store: V2Store, teamId: string): SwarmV2Task[] {
  const team = getTeam(store, teamId);
  const edges = dependencyAdjacency(store, team.teamId);
  const depthCache = new Map<string, number>();
  return listTasks(store, team.teamId)
    .filter(task => task.status === 'ready' && !task.tombstone && dependenciesSatisfied(store, task.taskId))
    .map(task => ({task, depth: topologicalDepth(edges, task.taskId, depthCache, new Set())}))
    .sort((a, b) => a.depth - b.depth || a.task.createdAt.localeCompare(b.task.createdAt) || a.task.taskId.localeCompare(b.task.taskId))
    .map(entry => entry.task);
}

/** Attempts currently executing for the team, oldest first. */
export function runningAttempts(store: V2Store, teamId: string): SwarmV2Attempt[] {
  const team = getTeam(store, teamId);
  return store.rows<Parameters<typeof attemptFromRow>[0]>(
    `SELECT a.* FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id
      WHERE t.team_id=? AND a.status='running' ORDER BY a.started_at ASC,t.created_at ASC,a.attempt_id ASC`,
    team.teamId,
  ).map(attemptFromRow);
}

function activeAttemptCount(store: V2Store, teamId: string): number {
  return Number((store.row<{n: number}>(
    `SELECT COUNT(*) AS n FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id
      WHERE t.team_id=? AND a.status IN ('prepared','running')`,
    teamId,
  ))!.n);
}

function resolveMemberGeneration(store: V2Store, teamId: string, memberId: string): number {
  const row = store.row<{team_id: string; role: string; phase: string; generation: number}>('SELECT team_id,role,phase,generation FROM swarm_v2_members WHERE member_id=?', memberId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', `成员不存在：${memberId}`);
  if (String(row.team_id) !== teamId) throw new CapabilityError('VALIDATION_ERROR', `成员不属于该团队：${memberId}`);
  if (!['worker', 'lead'].includes(String(row.role))) throw new CapabilityError('VALIDATION_ERROR', `成员角色 ${row.role} 不能领取任务：${memberId}`);
  if (String(row.phase) !== 'active') throw new CapabilityError('VALIDATION_ERROR', `成员 ${memberId} 尚未就绪（phase=${row.phase}）`);
  return Number(row.generation);
}

function memberAssignments(input: ScheduleInput): Record<string, string> {
  if (input.memberIdForTask === undefined) return {};
  if (!input.memberIdForTask || typeof input.memberIdForTask !== 'object' || Array.isArray(input.memberIdForTask)) {
    throw new CapabilityError('VALIDATION_ERROR', 'memberIdForTask 必须是任务→成员编号的对象');
  }
  const entries = Object.entries(input.memberIdForTask);
  if (entries.length > 256) throw new CapabilityError('VALIDATION_ERROR', 'memberIdForTask 条目过多');
  const result: Record<string, string> = {};
  for (const [taskId, memberId] of entries) {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new CapabilityError('VALIDATION_ERROR', 'memberIdForTask 任务编号无效');
    if (typeof memberId !== 'string' || !memberId.trim()) throw new CapabilityError('VALIDATION_ERROR', 'memberIdForTask 成员编号无效');
    result[taskId.trim()] = memberId.trim();
  }
  return result;
}

/**
 * Dispatch the current ready frontier once.
 *
 * All effects (team auto-start, attempts, task state, write claims, journal) are
 * applied in a single transaction. Candidates that lose the write preflight or
 * the budget reservation are reported as `blocked` and the loop continues with
 * the next independent task, so one conflict never starves the frontier.
 */
export function scheduleOnce(store: V2Store, teamId: string, input: ScheduleInput = {}): ScheduleResult {
  const maxWorkers = intOrNull(input.maxWorkers, 'maxWorkers', 1, MAX_WORKERS) ?? DEFAULT_MAX_WORKERS;
  if (input.now !== undefined && (typeof input.now !== 'string' || !Number.isFinite(Date.parse(input.now)))) {
    throw new CapabilityError('VALIDATION_ERROR', 'now 必须是有效时间');
  }
  const workspaceId = optionalText(input.workspaceId, 'workspaceId', 200);
  const fallbackMemberId = input.memberId === undefined || input.memberId === null ? null : optionalText(input.memberId, 'memberId', 200);
  const assignments = memberAssignments(input);
  return store.transaction(() => {
    let team = getTeam(store, teamId);
    if (team.status === 'created') team = setTeamStatus(store, team.teamId, team.revision, 'running');
    const dispatched: ScheduleDispatched[] = [];
    const blocked: ScheduleBlocked[] = [];
    if (team.status !== 'running') {
      return {dispatched, blocked, running: activeAttemptCount(store, team.teamId), exhausted: true};
    }
    const memberGenerations = new Map<string, number>();
    for (const memberId of Object.values(assignments)) if (!memberGenerations.has(memberId)) memberGenerations.set(memberId, resolveMemberGeneration(store, team.teamId, memberId));
    if (fallbackMemberId !== null && !memberGenerations.has(fallbackMemberId)) memberGenerations.set(fallbackMemberId, resolveMemberGeneration(store, team.teamId, fallbackMemberId));
    const active = activeAttemptCount(store, team.teamId);
    const capacity = Math.max(0, Math.min(maxWorkers, MAX_WORKERS) - active);
    if (capacity === 0) return {dispatched, blocked, running: active, exhausted: false};
    for (const task of readyFrontier(store, team.teamId)) {
      if (dispatched.length >= capacity) break;
      if (task.mode === 'write') {
        const preflight = claimPreflight(store, team.teamId, task.writeScopes);
        if (preflight.held) {
          blocked.push({
            taskId: task.taskId,
            reason: {kind: 'resource', cause: 'write-scope', by: preflight.by.attemptId},
          });
          continue;
        }
      }
      if (input.reserve) {
        let reservation: {tokens: number; costMicros: number} | null;
        try {
          reservation = input.reserve(task, {...SCHEDULE_ESTIMATE});
        } catch (error) {
          if (error instanceof CapabilityError && error.code === 'BUDGET_EXHAUSTED') {
            blocked.push({taskId: task.taskId, reason: {kind: 'budget', cause: error.message}});
            continue;
          }
          throw error;
        }
        if (reservation === null) {
          blocked.push({taskId: task.taskId, reason: {kind: 'budget', cause: '预算预留失败'}});
          continue;
        }
      }
      const memberId = assignments[task.taskId] ?? fallbackMemberId;
      const generation = memberId === null ? 0 : memberGenerations.get(memberId) ?? 0;
      const attempt = prepareAttempt(store, task.taskId, task.revision, {memberId, generation, workspaceId});
      markAttemptRunning(store, attempt.attemptId, {generation, workspaceId});
      let writeClaimId: string | undefined;
      if (task.mode === 'write') {
        const acquired = acquireClaim(store, {
          teamId: team.teamId, attemptId: attempt.attemptId, taskId: task.taskId, memberId, scopes: task.writeScopes,
        });
        if (acquired.held) throw new CapabilityError('VERSION_CONFLICT', '调度写声明时发现并发冲突');
        writeClaimId = acquired.claim.claimId;
      }
      dispatched.push({taskId: task.taskId, attemptId: attempt.attemptId, memberId, ...(writeClaimId ? {writeClaimId} : {})});
    }
    return {dispatched, blocked, running: activeAttemptCount(store, team.teamId), exhausted: false};
  });
}
