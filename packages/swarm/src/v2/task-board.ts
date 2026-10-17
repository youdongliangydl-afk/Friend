/**
 * Swarm v2 task board (P0-A): 8-state task machine with tombstones and CAS
 * revisions, DAG validation, requirement versions, attempt lifecycle, rework
 * quotas/failure fingerprints and stale-attempt recovery.
 *
 * Invariants owned here (blueprint I4/I5/I6/I13):
 *  - every task mutation is a single transaction with a compare-and-swap revision;
 *  - dependencies must exist, not be deleted, and stay acyclic;
 *  - a task has at most one non-terminal attempt and at most one running attempt;
 *  - completion is split from results: attempts carry the result data, the task
 *    only points at the current attempt / result revision;
 *  - every state change appends exactly one journal event in the same transaction.
 */
import {randomUUID} from 'node:crypto';
import {CapabilityError} from '@friend-pi/core';
import type {V2Store} from './store.js';
import {arrayText, failureFingerprint, intOrNull, optionalText, text, v2Now} from './store.js';
import {
  DEFAULT_MAX_TASKS, MAX_GRAPH_REWORK, MAX_TASK_REWORK, TASK_TRANSITIONS,
  type SwarmV2Actor, type SwarmV2Attempt, type SwarmV2AttemptStatus, type SwarmV2BlockedReason,
  type SwarmV2Mode, type SwarmV2ReworkReceipt, type SwarmV2Task, type SwarmV2TaskDraft, type SwarmV2TaskStatus,
  type SwarmV2Team, type SwarmV2TeamStatus, type SwarmV2WorkspaceKind,
} from './types.js';
import {scopesOverlap, validateScopes} from './write-claims.js';

const MAX_DESCRIPTION = 16384;
const MAX_ACCEPTANCE_ITEMS = 32;
const MAX_ACCEPTANCE_ITEM_LENGTH = 2000;
const MAX_SUMMARY = 16384;
const MAX_RESULT_ARTIFACTS = 64;
const RISKS = new Set(['V0', 'V1', 'V2', 'V3']);
const WORKSPACE_KINDS = new Set(['worktree', 'staging', 'readonly', 'shared']);
const TEAM_STATUSES = new Set(['created', 'running', 'paused', 'stopping', 'stopped', 'completed']);

// ---------------------------------------------------------------------------
// Input contracts (names final; exported for the service layer)
// ---------------------------------------------------------------------------

export interface CreateTeamInput {
  teamId?: string;
  projectId: string;
  rootSessionId: string;
  workspaceRoot: string;
  autonomyLevel?: number;
  policy?: Record<string, unknown>;
}

export interface UpdateTeamPatch {
  autonomyLevel?: number;
  policy?: Record<string, unknown>;
}

export interface UpdateTaskPatch {
  title?: string;
  description?: string;
  acceptance?: string[] | string;
  checksRef?: string | null;
  workspacePolicy?: SwarmV2WorkspaceKind;
  writeScopes?: string[];
  dependencies?: string[];
}

export interface AddRequirementInput {
  prompt: string;
  reason?: string;
  automatic: boolean;
}

export interface PrepareAttemptInput {
  memberId: string | null;
  generation?: number;
  workspaceId?: string | null;
  baseRev?: string | null;
  depsDigest?: string | null;
}

export interface AttemptRunningInput {
  generation: number;
  workspaceId: string | null;
}

export interface CompleteAttemptInput {
  summary: string;
  commitSha?: string | null;
  candidateTip?: string | null;
  resultDigest?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
  evidenceRefs?: string[];
  artifactIds?: string[];
}

export interface FailAttemptInput {
  reason: string;
  unknown?: boolean;
}

export interface RecoverStaleInput {
  leaseMs?: number;
}

export interface ListTaskOptions {
  includeDeleted?: boolean;
  status?: SwarmV2TaskStatus;
}

export interface ListAttemptOptions {
  taskId?: string;
  status?: SwarmV2AttemptStatus;
}

// ---------------------------------------------------------------------------
// Row decode helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  try {
    const value = JSON.parse(String(raw)) as T;
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function teamFromRow(row: Record<string, unknown>): SwarmV2Team {
  return {
    teamId: String(row.team_id),
    projectId: String(row.project_id),
    rootSessionId: String(row.root_session_id),
    workspaceRoot: String(row.workspace_root),
    status: String(row.status) as SwarmV2TeamStatus,
    autonomyLevel: Number(row.autonomy_level),
    policy: parseJson<Record<string, unknown>>(row.policy_json, {}),
    revision: Number(row.revision),
    reworkRound: Number(row.rework_round),
    failureFingerprints: parseJson<string[]>(row.failure_fingerprints_json, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function blockedReasonFromJson(raw: unknown): SwarmV2BlockedReason | null {
  const value = parseJson<SwarmV2BlockedReason | null>(raw, null);
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind);
  if (!['dependency', 'budget', 'resource', 'unknown', 'policy', 'human'].includes(kind)) return null;
  return {kind: kind as SwarmV2BlockedReason['kind'], cause: String(value.cause), ...(typeof value.by === 'string' ? {by: value.by} : {})};
}

/** Keep journal payloads bounded but carry the actual changed values, not just field names. */
function boundedJournalValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value ?? null;
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 64).map(item => boundedJournalValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 32)
      .map(([key, item]) => [String(key).slice(0, 100), boundedJournalValue(item, depth + 1)]));
  }
  return String(value).slice(0, 500);
}

interface TaskBaseRow {
  task_id: string;
  team_id: string;
  revision: number;
  title: string;
  description: string;
  mode: string;
  risk: string;
  status: string;
  owner_member_id: string | null;
  current_attempt_id: string | null;
  logical_step_id: string;
  result_revision: number;
  result_artifact_ids_json: string;
  rework_count: number;
  requirement_version: number;
  acceptance_json: string;
  checks_ref: string | null;
  workspace_policy: string;
  blocked_reason_json: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tombstone: number;
}

function taskFromRow(row: TaskBaseRow): SwarmV2Task {
  return {
    taskId: String(row.task_id),
    teamId: String(row.team_id),
    revision: Number(row.revision),
    title: String(row.title),
    description: String(row.description),
    mode: String(row.mode) as SwarmV2Mode,
    risk: String(row.risk) as SwarmV2Task['risk'],
    status: String(row.status) as SwarmV2TaskStatus,
    ownerMemberId: row.owner_member_id === null ? null : String(row.owner_member_id),
    currentAttemptId: row.current_attempt_id === null ? null : String(row.current_attempt_id),
    logicalStepId: String(row.logical_step_id),
    resultRevision: Number(row.result_revision),
    resultArtifactIds: parseJson<string[]>(row.result_artifact_ids_json, []),
    reworkCount: Number(row.rework_count),
    requirementVersion: Number(row.requirement_version),
    acceptance: parseJson<string[]>(row.acceptance_json, []),
    checksRef: row.checks_ref === null ? null : String(row.checks_ref),
    workspacePolicy: String(row.workspace_policy) as SwarmV2WorkspaceKind,
    dependencies: [],
    writeScopes: [],
    blockedReason: blockedReasonFromJson(row.blocked_reason_json),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
    tombstone: Number(row.tombstone) === 1,
  };
}

interface AttemptBaseRow {
  attempt_id: string;
  task_id: string;
  number: number;
  status: string;
  member_id: string | null;
  generation: number;
  workspace_id: string | null;
  base_rev: string | null;
  deps_digest: string | null;
  requirement_version: number;
  budget_reservation_id: string | null;
  started_at: string;
  finished_at: string | null;
  terminal_reason: string | null;
  summary: string | null;
  session_id: string | null;
  session_file: string | null;
  commit_sha: string | null;
  result_digest: string | null;
  candidate_tip: string | null;
  evidence_refs_json: string;
}

export function attemptFromRow(row: AttemptBaseRow): SwarmV2Attempt {
  return {
    attemptId: String(row.attempt_id),
    taskId: String(row.task_id),
    number: Number(row.number),
    status: String(row.status) as SwarmV2Attempt['status'],
    memberId: row.member_id === null ? null : String(row.member_id),
    generation: Number(row.generation),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    baseRev: row.base_rev === null ? null : String(row.base_rev),
    depsDigest: row.deps_digest === null ? null : String(row.deps_digest),
    requirementVersion: Number(row.requirement_version),
    budgetReservationId: row.budget_reservation_id === null ? null : String(row.budget_reservation_id),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    terminalReason: row.terminal_reason === null ? null : (String(row.terminal_reason) as SwarmV2Attempt['terminalReason']),
    summary: row.summary === null ? null : String(row.summary),
    sessionId: row.session_id === null ? null : String(row.session_id),
    sessionFile: row.session_file === null ? null : String(row.session_file),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    resultDigest: row.result_digest === null ? null : String(row.result_digest),
    candidateTip: row.candidate_tip === null ? null : String(row.candidate_tip),
    evidenceRefs: parseJson<string[]>(row.evidence_refs_json, []),
  };
}

/** Journal actor for a caller-provided identity string. */
export function boardActor(actorId: string): SwarmV2Actor {
  const id = String(actorId ?? '').trim() || 'lead';
  return id === 'lead' ? {kind: 'lead', id} : {kind: 'member', id};
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function getTeam(store: V2Store, teamId: string): SwarmV2Team {
  const id = String(teamId ?? '').trim();
  if (!id) throw new CapabilityError('VALIDATION_ERROR', '缺少团队编号');
  const row = store.row<TaskBaseRow & Record<string, unknown>>('SELECT * FROM swarm_v2_teams WHERE team_id=?', id);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '团队不存在');
  return teamFromRow(row);
}

function saveTeam(store: V2Store, team: SwarmV2Team): void {
  store.db.prepare(`UPDATE swarm_v2_teams SET project_id=?,root_session_id=?,workspace_root=?,status=?,autonomy_level=?,policy_json=?,revision=?,rework_round=?,failure_fingerprints_json=?,created_at=?,updated_at=? WHERE team_id=?`)
    .run(team.projectId, team.rootSessionId, team.workspaceRoot, team.status, team.autonomyLevel, JSON.stringify(team.policy), team.revision, team.reworkRound, JSON.stringify(team.failureFingerprints), team.createdAt, team.updatedAt, team.teamId);
}

export function createTeam(store: V2Store, input: CreateTeamInput): SwarmV2Team {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '团队参数必须是对象');
  const projectId = text(input.projectId, 'projectId', 200);
  const rootSessionId = text(input.rootSessionId, 'rootSessionId', 200);
  const workspaceRoot = text(input.workspaceRoot, 'workspaceRoot', 2000);
  const teamId = optionalText(input.teamId, 'teamId', 200) ?? randomUUID();
  const autonomyLevel = intOrNull(input.autonomyLevel, 'autonomyLevel', 0, 3) ?? 1;
  const policy = input.policy ?? {};
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new CapabilityError('VALIDATION_ERROR', 'policy 必须是对象');
  return store.transaction(() => {
    if (store.row('SELECT 1 FROM swarm_v2_teams WHERE team_id=?', teamId)) throw new CapabilityError('VERSION_CONFLICT', '团队编号已存在');
    const at = v2Now();
    const team: SwarmV2Team = {
      teamId, projectId, rootSessionId, workspaceRoot, status: 'created', autonomyLevel,
      policy: structuredClone(policy), revision: 1, reworkRound: 0, failureFingerprints: [],
      createdAt: at, updatedAt: at,
    };
    store.db.prepare('INSERT INTO swarm_v2_teams(team_id,project_id,root_session_id,workspace_root,status,autonomy_level,policy_json,revision,rework_round,failure_fingerprints_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(team.teamId, team.projectId, team.rootSessionId, team.workspaceRoot, team.status, team.autonomyLevel, JSON.stringify(team.policy), team.revision, team.reworkRound, JSON.stringify(team.failureFingerprints), team.createdAt, team.updatedAt);
    store.journal(teamId, 'team.created', {kind: 'lead', id: 'lead'}, {kind: 'team', id: teamId, revision: team.revision}, {projectId, rootSessionId, workspaceRoot});
    return getTeam(store, teamId);
  });
}

export function updateTeam(store: V2Store, teamId: string, expectedRevision: number, patch: UpdateTeamPatch): SwarmV2Team {
  const revision = intOrNull(expectedRevision, 'expectedRevision', 0) ?? -1;
  if (!patch || typeof patch !== 'object') throw new CapabilityError('VALIDATION_ERROR', '团队更新参数必须是对象');
  for (const key of Object.keys(patch)) if (!['autonomyLevel', 'policy'].includes(key)) throw new CapabilityError('VALIDATION_ERROR', `团队更新不支持字段：${key}`);
  return store.transaction(() => {
    const team = getTeam(store, teamId);
    if (team.revision !== revision) throw new CapabilityError('VERSION_CONFLICT', `团队版本已变化：期望 ${revision}，当前 ${team.revision}`);
    const next: SwarmV2Team = {...team, revision: team.revision + 1, updatedAt: v2Now()};
    if (patch.autonomyLevel !== undefined) next.autonomyLevel = intOrNull(patch.autonomyLevel, 'autonomyLevel', 0, 3) ?? 1;
    if (patch.policy !== undefined) {
      if (!patch.policy || typeof patch.policy !== 'object' || Array.isArray(patch.policy)) throw new CapabilityError('VALIDATION_ERROR', 'policy 必须是对象');
      next.policy = structuredClone(patch.policy);
    }
    saveTeam(store, next);
    const changed = Object.fromEntries(Object.keys(patch).map(key => [key, (next as unknown as Record<string, unknown>)[key]]));
    store.journal(teamId, 'team.updated', {kind: 'lead', id: 'lead'}, {kind: 'team', id: teamId, revision: next.revision}, {
      revision: next.revision, fields: Object.keys(patch), values: boundedJournalValue(changed),
    });
    return next;
  });
}

export function setTeamStatus(store: V2Store, teamId: string, expectedRevision: number, status: SwarmV2TeamStatus): SwarmV2Team {
  const revision = intOrNull(expectedRevision, 'expectedRevision', 0) ?? -1;
  const nextStatus = String(status ?? '').trim();
  if (!TEAM_STATUSES.has(nextStatus)) throw new CapabilityError('VALIDATION_ERROR', `未知团队状态：${nextStatus}`);
  return store.transaction(() => {
    const team = getTeam(store, teamId);
    if (team.revision !== revision) throw new CapabilityError('VERSION_CONFLICT', `团队版本已变化：期望 ${revision}，当前 ${team.revision}`);
    if (team.status === nextStatus) return team;
    const next: SwarmV2Team = {...team, status: nextStatus as SwarmV2TeamStatus, revision: team.revision + 1, updatedAt: v2Now()};
    saveTeam(store, next);
    store.journal(teamId, 'team.status_changed', {kind: 'lead', id: 'lead'}, {kind: 'team', id: teamId, revision: next.revision}, {from: team.status, to: next.status});
    return next;
  });
}

function pauseTeam(store: V2Store, team: SwarmV2Team, cause: string): SwarmV2Team {
  if (team.status === 'paused') return team;
  const next: SwarmV2Team = {...team, status: 'paused', revision: team.revision + 1, updatedAt: v2Now()};
  saveTeam(store, next);
  store.journal(next.teamId, 'team.status_changed', {kind: 'system', id: 'task-board'}, {kind: 'team', id: next.teamId, revision: next.revision}, {from: team.status, to: 'paused', cause});
  return next;
}

// ---------------------------------------------------------------------------
// Task read/validate helpers
// ---------------------------------------------------------------------------

function hydrateTask(store: V2Store, task: SwarmV2Task): SwarmV2Task {
  task.dependencies = store.rows<{depends_on: string}>('SELECT depends_on FROM swarm_v2_task_dependencies WHERE task_id=? ORDER BY rowid', task.taskId).map(row => String(row.depends_on));
  task.writeScopes = store.rows<{scope: string}>('SELECT scope FROM swarm_v2_task_scopes WHERE task_id=? ORDER BY rowid', task.taskId).map(row => String(row.scope));
  return task;
}

export function getTask(store: V2Store, taskId: string): SwarmV2Task {
  const id = String(taskId ?? '').trim();
  if (!id) throw new CapabilityError('VALIDATION_ERROR', '缺少任务编号');
  const row = store.row<TaskBaseRow>('SELECT * FROM swarm_v2_tasks WHERE task_id=?', id);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '任务不存在');
  return hydrateTask(store, taskFromRow(row));
}

export function getAttempt(store: V2Store, attemptId: string): SwarmV2Attempt {
  const id = String(attemptId ?? '').trim();
  if (!id) throw new CapabilityError('VALIDATION_ERROR', '缺少尝试编号');
  const row = store.row<AttemptBaseRow>('SELECT * FROM swarm_v2_attempts WHERE attempt_id=?', id);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '尝试不存在');
  return attemptFromRow(row);
}

export function listAttempts(store: V2Store, teamId: string, options: ListAttemptOptions = {}): SwarmV2Attempt[] {
  const team = getTeam(store, teamId);
  const filters = ['t.team_id=?'];
  const args: (string | number | null)[] = [team.teamId];
  if (options.taskId !== undefined) { filters.push('a.task_id=?'); args.push(String(options.taskId)); }
  if (options.status !== undefined) { filters.push('a.status=?'); args.push(String(options.status)); }
  return store.rows<AttemptBaseRow>(`SELECT a.* FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id WHERE ${filters.join(' AND ')} ORDER BY a.task_id ASC,a.number ASC`, ...args).map(attemptFromRow);
}

export function listTasks(store: V2Store, teamId: string, options: ListTaskOptions = {}): SwarmV2Task[] {
  const team = getTeam(store, teamId);
  const filters = ['team_id=?'];
  const args: (string | number | null)[] = [team.teamId];
  if (!options.includeDeleted) { filters.push('tombstone=0'); }
  if (options.status !== undefined) { filters.push('status=?'); args.push(String(options.status)); }
  return store.rows<TaskBaseRow>(`SELECT * FROM swarm_v2_tasks WHERE ${filters.join(' AND ')} ORDER BY created_at ASC,task_id ASC`, ...args).map(row => hydrateTask(store, taskFromRow(row)));
}

function saveTask(store: V2Store, task: SwarmV2Task): void {
  store.db.prepare(`UPDATE swarm_v2_tasks SET revision=?,title=?,description=?,mode=?,risk=?,status=?,owner_member_id=?,current_attempt_id=?,logical_step_id=?,result_revision=?,result_artifact_ids_json=?,rework_count=?,requirement_version=?,acceptance_json=?,checks_ref=?,workspace_policy=?,blocked_reason_json=?,updated_at=?,deleted_at=?,tombstone=? WHERE task_id=?`)
    .run(task.revision, task.title, task.description, task.mode, task.risk, task.status, task.ownerMemberId, task.currentAttemptId, task.logicalStepId, task.resultRevision, JSON.stringify(task.resultArtifactIds), task.reworkCount, task.requirementVersion, JSON.stringify(task.acceptance), task.checksRef, task.workspacePolicy, task.blockedReason ? JSON.stringify(task.blockedReason) : null, task.updatedAt, task.deletedAt, task.tombstone ? 1 : 0, task.taskId);
}

function saveTaskDependencies(store: V2Store, taskId: string, dependencies: string[]): void {
  store.db.prepare('DELETE FROM swarm_v2_task_dependencies WHERE task_id=?').run(taskId);
  for (const dependency of dependencies) store.db.prepare('INSERT INTO swarm_v2_task_dependencies(task_id,depends_on) VALUES(?,?)').run(taskId, dependency);
}

function saveTaskScopes(store: V2Store, taskId: string, scopes: string[]): void {
  store.db.prepare('DELETE FROM swarm_v2_task_scopes WHERE task_id=?').run(taskId);
  for (const scope of scopes) store.db.prepare('INSERT INTO swarm_v2_task_scopes(task_id,scope) VALUES(?,?)').run(taskId, scope);
}

function assertExpectedRevision(task: SwarmV2Task, expectedRevision: number): void {
  const revision = intOrNull(expectedRevision, 'expectedRevision', 0) ?? -1;
  if (task.revision !== revision) throw new CapabilityError('VERSION_CONFLICT', `任务版本已变化：期望 ${revision}，当前 ${task.revision}`);
}

function parseAcceptance(raw: unknown, risk: SwarmV2Task['risk']): string[] {
  const items = raw === undefined || raw === null ? [] : arrayText(raw, 'acceptance', MAX_ACCEPTANCE_ITEMS, MAX_ACCEPTANCE_ITEM_LENGTH);
  if (!items.length && risk !== 'V0') throw new CapabilityError('VALIDATION_ERROR', 'V1+ 任务至少需要一条 acceptance');
  return items;
}

function parseRisk(raw: unknown): SwarmV2Task['risk'] {
  const risk = String(raw ?? '').trim();
  if (!RISKS.has(risk)) throw new CapabilityError('VALIDATION_ERROR', `未知风险等级：${risk}`);
  return risk as SwarmV2Task['risk'];
}

function parseWorkspacePolicy(raw: unknown): SwarmV2WorkspaceKind {
  if (raw === undefined || raw === null) return 'worktree';
  const value = String(raw ?? '').trim();
  if (!WORKSPACE_KINDS.has(value)) throw new CapabilityError('VALIDATION_ERROR', `未知 workspacePolicy：${value}`);
  return value as SwarmV2WorkspaceKind;
}

function parseMode(raw: unknown): SwarmV2Mode {
  if (raw !== 'read' && raw !== 'write') throw new CapabilityError('VALIDATION_ERROR', '任务 mode 必须是 read 或 write');
  return raw;
}

// ---------------------------------------------------------------------------
// DAG helpers
// ---------------------------------------------------------------------------

function graphEdges(store: V2Store, teamId: string): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const rows = store.rows<{task_id: string; depends_on: string}>(
    'SELECT d.task_id,d.depends_on FROM swarm_v2_task_dependencies d JOIN swarm_v2_tasks t ON t.task_id=d.task_id WHERE t.team_id=? ORDER BY d.rowid',
    teamId,
  );
  for (const row of rows) {
    const id = String(row.task_id);
    edges.set(id, [...(edges.get(id) ?? []), String(row.depends_on)]);
  }
  return edges;
}

function edgesWith(edges: Map<string, string[]>, taskId: string, dependencies: string[]): Map<string, string[]> {
  const next = new Map(edges);
  next.set(taskId, [...dependencies]);
  return next;
}

function reaches(edges: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [...(edges.get(from) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) ?? []));
  }
  return false;
}

function assertAcyclic(store: V2Store, teamId: string, taskId: string, dependencies: string[]): void {
  const edges = edgesWith(graphEdges(store, teamId), taskId, dependencies);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) throw new CapabilityError('VALIDATION_ERROR', `任务依赖形成环：${[...stack, id].join(' -> ')}`);
    if (mark === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const dependency of edges.get(id) ?? []) visit(dependency);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) if (!state.has(id)) visit(id);
}

function validateDependencyIds(store: V2Store, teamId: string, taskId: string | null, raw: unknown): string[] {
  const dependencies = arrayText(raw, 'dependencies', 64, 200);
  if (taskId !== null && dependencies.includes(taskId)) throw new CapabilityError('VALIDATION_ERROR', '任务不能依赖自己');
  for (const dependency of dependencies) {
    const row = store.row<{team_id: string; status: string; tombstone: number}>('SELECT team_id,status,tombstone FROM swarm_v2_tasks WHERE task_id=?', dependency);
    if (!row) throw new CapabilityError('VALIDATION_ERROR', `依赖任务不存在：${dependency}`);
    if (String(row.team_id) !== teamId) throw new CapabilityError('VALIDATION_ERROR', `依赖任务不属于同一团队：${dependency}`);
    if (Number(row.tombstone) === 1 || String(row.status) === 'deleted') throw new CapabilityError('VALIDATION_ERROR', `依赖任务已删除：${dependency}`);
  }
  return dependencies;
}

function dependencyStateFor(store: V2Store, dependencies: string[]): {satisfied: boolean; pending: string[]} {
  const pending: string[] = [];
  for (const dependency of dependencies) {
    const row = store.row<{status: string; tombstone: number}>('SELECT status,tombstone FROM swarm_v2_tasks WHERE task_id=?', dependency);
    if (!row) continue;
    if (Number(row.tombstone) === 1 || String(row.status) === 'deleted') continue;
    if (String(row.status) !== 'done') pending.push(dependency);
  }
  return {satisfied: pending.length === 0, pending};
}

function dependencyState(store: V2Store, taskId: string): {satisfied: boolean; pending: string[]} {
  return dependencyStateFor(store, store.rows<{depends_on: string}>('SELECT depends_on FROM swarm_v2_task_dependencies WHERE task_id=? ORDER BY rowid', taskId).map(row => String(row.depends_on)));
}

function dependencyBlockedReason(pending: string[]): SwarmV2BlockedReason {
  return {kind: 'dependency', cause: `等待依赖完成：${pending.join(',')}`};
}

/**
 * Independent write tasks may not claim overlapping workspace scopes: only an
 * ordering edge (direct or transitive dependency either way) makes sharing safe.
 * Write tasks that already finished (done/cancelled/deleted) do not conflict.
 */
function assertScopeIsolation(store: V2Store, teamId: string, taskId: string, proposed: {mode: SwarmV2Mode; writeScopes: string[]; dependencies: string[]}): void {
  if (proposed.mode !== 'write' || proposed.writeScopes.length === 0) return;
  const edges = edgesWith(graphEdges(store, teamId), taskId, proposed.dependencies);
  const others = store.rows<{task_id: string}>(
    "SELECT task_id FROM swarm_v2_tasks WHERE team_id=? AND tombstone=0 AND mode='write' AND status NOT IN ('done','cancelled','deleted')",
    teamId,
  );
  for (const row of others) {
    const other = String(row.task_id);
    if (other === taskId) continue;
    const scopes = store.rows<{scope: string}>('SELECT scope FROM swarm_v2_task_scopes WHERE task_id=?', other).map(item => String(item.scope));
    for (const mine of proposed.writeScopes) {
      for (const theirs of scopes) {
        if (!scopesOverlap(mine, theirs)) continue;
        if (reaches(edges, taskId, other) || reaches(edges, other, taskId)) continue;
        throw new CapabilityError('VALIDATION_ERROR', `独立写任务 scope 重叠：${taskId}:${mine} 与 ${other}:${theirs}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Task create/update
// ---------------------------------------------------------------------------

export function createTask(store: V2Store, teamId: string, draft: SwarmV2TaskDraft, actorId: string): SwarmV2Task {
  if (!draft || typeof draft !== 'object') throw new CapabilityError('VALIDATION_ERROR', '任务参数必须是对象');
  return store.transaction(() => {
    const team = getTeam(store, teamId);
    const active = Number((store.row<{n: number}>("SELECT COUNT(*) AS n FROM swarm_v2_tasks WHERE team_id=? AND tombstone=0 AND status NOT IN ('cancelled','deleted')", team.teamId))!.n);
    if (active >= DEFAULT_MAX_TASKS) throw new CapabilityError('VALIDATION_ERROR', `活跃任务已达上限 ${DEFAULT_MAX_TASKS}`);
    const title = text(draft.title, 'title', 200);
    const description = typeof draft.description === 'string' ? draft.description : '';
    if (description.length > MAX_DESCRIPTION) throw new CapabilityError('VALIDATION_ERROR', `description 超过 ${MAX_DESCRIPTION} 字符`);
    const mode = parseMode(draft.mode);
    const risk = parseRisk(draft.risk);
    const acceptance = parseAcceptance(draft.acceptance, risk);
    const writeScopes = validateScopes(draft.writeScopes ?? [], mode);
    const dependencies = validateDependencyIds(store, team.teamId, null, draft.dependencies ?? []);
    const workspacePolicy = parseWorkspacePolicy(draft.workspacePolicy);
    const checksRef = optionalText(draft.checksRef, 'checksRef', 500);
    const taskId = randomUUID();
    assertAcyclic(store, team.teamId, taskId, dependencies);
    assertScopeIsolation(store, team.teamId, taskId, {mode, writeScopes, dependencies});
    const {satisfied, pending} = dependencyStateFor(store, dependencies);
    const at = v2Now();
    const logicalStepId = optionalText(draft.logicalStepId, 'logicalStepId', 200) ?? taskId;
    const task: SwarmV2Task = {
      taskId, teamId: team.teamId, revision: 1, title, description, mode, risk,
      status: satisfied ? 'ready' : 'blocked', ownerMemberId: null, currentAttemptId: null,
      logicalStepId, resultRevision: 0, resultArtifactIds: [], reworkCount: 0, requirementVersion: 1,
      acceptance, checksRef, workspacePolicy, dependencies, writeScopes,
      blockedReason: satisfied ? null : dependencyBlockedReason(pending),
      createdBy: String(actorId ?? 'lead'), createdAt: at, updatedAt: at, deletedAt: null, tombstone: false,
    };
    store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,owner_member_id,current_attempt_id,logical_step_id,result_revision,result_artifact_ids_json,rework_count,requirement_version,acceptance_json,checks_ref,workspace_policy,blocked_reason_json,created_by,created_at,updated_at,deleted_at,tombstone)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(task.taskId, task.teamId, task.revision, task.title, task.description, task.mode, task.risk, task.status, null, null, task.logicalStepId, 0, '[]', 0, 1, JSON.stringify(task.acceptance), task.checksRef, task.workspacePolicy, task.blockedReason ? JSON.stringify(task.blockedReason) : null, task.createdBy, task.createdAt, task.updatedAt, null, 0);
    saveTaskDependencies(store, taskId, dependencies);
    saveTaskScopes(store, taskId, writeScopes);
    store.db.prepare('INSERT INTO swarm_v2_task_requirements(task_id,version,prompt,reason,automatic,created_at) VALUES(?,?,?,?,?,?)')
      .run(taskId, 1, description.trim() || title, null, 0, at);
    store.journal(team.teamId, 'task.created', boardActor(task.createdBy), {kind: 'task', id: taskId, revision: 1}, {
      title, mode, risk, status: task.status, dependencies, writeScopes, requirementVersion: 1,
    });
    return getTask(store, taskId);
  });
}

export function updateTask(store: V2Store, taskId: string, expectedRevision: number, patch: UpdateTaskPatch, actorId = 'lead'): SwarmV2Task {
  if (!patch || typeof patch !== 'object') throw new CapabilityError('VALIDATION_ERROR', '任务更新参数必须是对象');
  const allowed = ['title', 'description', 'acceptance', 'checksRef', 'workspacePolicy', 'writeScopes', 'dependencies'];
  for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw new CapabilityError('VALIDATION_ERROR', `任务更新不支持字段：${key}`);
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除，不能更新');
    const next: SwarmV2Task = {...task, revision: task.revision + 1, updatedAt: v2Now()};
    if (patch.title !== undefined) next.title = text(patch.title, 'title', 200);
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') throw new CapabilityError('VALIDATION_ERROR', 'description 必须是字符串');
      if (patch.description.length > MAX_DESCRIPTION) throw new CapabilityError('VALIDATION_ERROR', `description 超过 ${MAX_DESCRIPTION} 字符`);
      next.description = patch.description;
    }
    if (patch.acceptance !== undefined) next.acceptance = parseAcceptance(patch.acceptance, next.risk);
    if (patch.checksRef !== undefined) next.checksRef = optionalText(patch.checksRef, 'checksRef', 500);
    if (patch.workspacePolicy !== undefined) next.workspacePolicy = parseWorkspacePolicy(patch.workspacePolicy);
    let writeScopes = task.writeScopes;
    if (patch.writeScopes !== undefined) writeScopes = validateScopes(patch.writeScopes, next.mode);
    let dependencies = task.dependencies;
    if (patch.dependencies !== undefined) {
      dependencies = validateDependencyIds(store, task.teamId, task.taskId, patch.dependencies);
      assertAcyclic(store, task.teamId, task.taskId, dependencies);
    }
    assertScopeIsolation(store, task.teamId, task.taskId, {mode: next.mode, writeScopes, dependencies});
    if (patch.dependencies !== undefined && (task.status === 'ready' || task.status === 'blocked')) {
      const {satisfied, pending} = dependencyStateFor(store, dependencies);
      next.status = satisfied ? 'ready' : 'blocked';
      next.blockedReason = satisfied ? null : dependencyBlockedReason(pending);
    }
    next.writeScopes = writeScopes;
    next.dependencies = dependencies;
    saveTask(store, next);
    if (patch.dependencies !== undefined) saveTaskDependencies(store, task.taskId, dependencies);
    if (patch.writeScopes !== undefined) saveTaskScopes(store, task.taskId, writeScopes);
    const changed = Object.fromEntries(Object.keys(patch).map(key => [key, (next as unknown as Record<string, unknown>)[key]]));
    store.journal(task.teamId, 'task.updated', boardActor(actorId), {kind: 'task', id: task.taskId, revision: next.revision}, {
      fields: Object.keys(patch), values: boundedJournalValue(changed),
    });
    return getTask(store, task.taskId);
  });
}

export function transitionTask(store: V2Store, taskId: string, expectedRevision: number, action: string, actorId: string): SwarmV2Task {
  const verb = String(action ?? '').trim();
  if (!verb) throw new CapabilityError('VALIDATION_ERROR', '缺少任务动作');
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除');
    const target = TASK_TRANSITIONS[task.status]?.[verb];
    if (!target) throw new CapabilityError('VALIDATION_ERROR', `非法任务迁移：${task.status} --${verb}-->`);
    let blockedReason: SwarmV2BlockedReason | null = task.blockedReason;
    let tombstone: boolean = task.tombstone;
    let deletedAt: string | null = task.deletedAt;
    if (target === 'ready') {
      const {satisfied, pending} = dependencyState(store, task.taskId);
      if (!satisfied) throw new CapabilityError('VALIDATION_ERROR', `依赖未完成，不能进入 ready：${pending.join(',')}`);
      blockedReason = null;
    }
    if (verb === 'block') blockedReason = {kind: 'policy', cause: '任务被阻塞'};
    if (verb === 'delete') {
      const dependents = store.rows<{task_id: string; status: string}>(
        "SELECT t.task_id,t.status FROM swarm_v2_task_dependencies d JOIN swarm_v2_tasks t ON t.task_id=d.task_id WHERE d.depends_on=? AND t.tombstone=0 AND t.status NOT IN ('cancelled','deleted','done')",
        task.taskId,
      );
      if (dependents.length) throw new CapabilityError('VALIDATION_ERROR', `任务仍有未完成依赖者：${dependents.map(row => String(row.task_id)).join(',')}`);
      tombstone = true;
      deletedAt = v2Now();
      blockedReason = null;
    }
    const clearsAttempt = ['claim', 'release', 'retry', 'unblock', 'block', 'cancel', 'delete'].includes(verb);
    if (clearsAttempt && task.currentAttemptId) {
      // Blocking/cancelling while an attempt is live must terminate it, otherwise the
      // one-running partial index and its write claim survive the transition.
      const live = store.row<{status: string}>('SELECT status FROM swarm_v2_attempts WHERE attempt_id=?', task.currentAttemptId);
      if (live && ['prepared', 'running'].includes(String(live.status))) {
        const at = v2Now();
        store.db.prepare('UPDATE swarm_v2_attempts SET status=?,finished_at=?,terminal_reason=?,summary=? WHERE attempt_id=?')
          .run('failed', at, 'interrupted', `任务迁移中断：${verb}`, task.currentAttemptId);
        store.db.prepare("UPDATE swarm_v2_write_claims SET state='released',released_at=? WHERE attempt_id=? AND state='active'").run(at, task.currentAttemptId);
        store.journal(task.teamId, 'attempt.interrupted', boardActor(actorId), {kind: 'attempt', id: task.currentAttemptId}, {taskId: task.taskId, reason: verb});
      }
    }
    const next: SwarmV2Task = {
      ...task, status: target, revision: task.revision + 1, updatedAt: v2Now(),
      blockedReason, tombstone, deletedAt,
      currentAttemptId: clearsAttempt ? null : task.currentAttemptId,
      ownerMemberId: target === 'ready' || target === 'blocked' || target === 'cancelled' || target === 'deleted' ? null : task.ownerMemberId,
    };
    saveTask(store, next);
    store.journal(task.teamId, 'task.transitioned', boardActor(actorId), {kind: 'task', id: task.taskId, revision: next.revision}, {from: task.status, action: verb, to: target});
    return getTask(store, task.taskId);
  });
}

// ---------------------------------------------------------------------------
// Requirements / dependencies / scopes
// ---------------------------------------------------------------------------

export function addRequirementVersion(store: V2Store, taskId: string, expectedRevision: number, input: AddRequirementInput, actorId = 'lead'): SwarmV2Task {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '需求参数必须是对象');
  const prompt = text(input.prompt, 'prompt', MAX_DESCRIPTION);
  const reason = optionalText(input.reason, 'reason', 2000);
  const automatic = input.automatic === true;
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除，不能追加需求');
    const version = task.requirementVersion + 1;
    store.db.prepare('INSERT INTO swarm_v2_task_requirements(task_id,version,prompt,reason,automatic,created_at) VALUES(?,?,?,?,?,?)')
      .run(task.taskId, version, prompt, reason, automatic ? 1 : 0, v2Now());
    const next: SwarmV2Task = {...task, requirementVersion: version, revision: task.revision + 1, updatedAt: v2Now()};
    saveTask(store, next);
    store.journal(task.teamId, 'task.requirement_added', boardActor(actorId), {kind: 'task', id: task.taskId, revision: next.revision}, {version, reason, automatic});
    return getTask(store, task.taskId);
  });
}

export function setDependencies(store: V2Store, taskId: string, expectedRevision: number, dependencies: string[], actorId = 'lead'): SwarmV2Task {
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除，不能修改依赖');
    const nextDependencies = validateDependencyIds(store, task.teamId, task.taskId, dependencies);
    assertAcyclic(store, task.teamId, task.taskId, nextDependencies);
    assertScopeIsolation(store, task.teamId, task.taskId, {mode: task.mode, writeScopes: task.writeScopes, dependencies: nextDependencies});
    saveTaskDependencies(store, task.taskId, nextDependencies);
    const next: SwarmV2Task = {...task, dependencies: nextDependencies, revision: task.revision + 1, updatedAt: v2Now()};
    if (task.status === 'ready' || task.status === 'blocked') {
      const {satisfied, pending} = dependencyStateFor(store, nextDependencies);
      next.status = satisfied ? 'ready' : 'blocked';
      next.blockedReason = satisfied ? null : dependencyBlockedReason(pending);
    }
    saveTask(store, next);
    store.journal(task.teamId, 'task.dependencies_changed', boardActor(actorId), {kind: 'task', id: task.taskId, revision: next.revision}, {dependencies: nextDependencies});
    return getTask(store, task.taskId);
  });
}

function assertWriteTask(task: SwarmV2Task): void {
  if (task.mode !== 'write') throw new CapabilityError('VALIDATION_ERROR', '只读任务不能声明 writeScopes');
}

export function setWriteScopes(store: V2Store, taskId: string, expectedRevision: number, scopes: string[], actorId = 'lead'): SwarmV2Task {
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除，不能修改 writeScopes');
    assertWriteTask(task);
    const nextScopes = validateScopes(scopes, 'write');
    assertScopeIsolation(store, task.teamId, task.taskId, {mode: task.mode, writeScopes: nextScopes, dependencies: task.dependencies});
    saveTaskScopes(store, task.taskId, nextScopes);
    const next: SwarmV2Task = {...task, writeScopes: nextScopes, revision: task.revision + 1, updatedAt: v2Now()};
    saveTask(store, next);
    store.journal(task.teamId, 'task.scopes_changed', boardActor(actorId), {kind: 'task', id: task.taskId, revision: next.revision}, {writeScopes: nextScopes});
    return getTask(store, task.taskId);
  });
}

export function addWriteScopes(store: V2Store, taskId: string, expectedRevision: number, scopes: string[], actorId = 'lead'): SwarmV2Task {
  const task = getTask(store, taskId);
  const merged = [...task.writeScopes, ...(Array.isArray(scopes) ? scopes : [])];
  return setWriteScopes(store, taskId, expectedRevision, merged, actorId);
}

export function removeWriteScopes(store: V2Store, taskId: string, expectedRevision: number, scopes: string[], actorId = 'lead'): SwarmV2Task {
  const task = getTask(store, taskId);
  const remove = new Set((Array.isArray(scopes) ? scopes : []).map(scope => String(scope).trim()));
  const remaining = task.writeScopes.filter(scope => !remove.has(scope));
  return setWriteScopes(store, taskId, expectedRevision, remaining, actorId);
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export function prepareAttempt(store: V2Store, taskId: string, expectedRevision: number, input: PrepareAttemptInput): SwarmV2Attempt {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '尝试参数必须是对象');
  const memberId = input.memberId === undefined || input.memberId === null ? null : text(input.memberId, 'memberId', 200);
  const generation = intOrNull(input.generation, 'generation', 0) ?? 0;
  const workspaceId = optionalText(input.workspaceId, 'workspaceId', 200);
  const baseRev = optionalText(input.baseRev, 'baseRev', 200);
  const depsDigest = optionalText(input.depsDigest, 'depsDigest', 500);
  return store.transaction(() => {
    const task = getTask(store, taskId);
    assertExpectedRevision(task, expectedRevision);
    if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', '任务已删除，不能认领');
    if (task.status !== 'ready') throw new CapabilityError('VERSION_CONFLICT', `任务当前状态 ${task.status}，仅 ready 可认领`);
    if (store.row("SELECT 1 FROM swarm_v2_attempts WHERE task_id=? AND status='running'", task.taskId)) throw new CapabilityError('VERSION_CONFLICT', '任务已有运行中的尝试');
    if (store.row("SELECT 1 FROM swarm_v2_attempts WHERE task_id=? AND status='prepared'", task.taskId)) throw new CapabilityError('VERSION_CONFLICT', '任务已有待运行的尝试');
    const number = Number((store.row<{n: number}>('SELECT COALESCE(MAX(number),0)+1 AS n FROM swarm_v2_attempts WHERE task_id=?', task.taskId))!.n);
    const attemptId = randomUUID(), startedAt = v2Now();
    store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,workspace_id,base_rev,deps_digest,requirement_version,budget_reservation_id,started_at,finished_at,terminal_reason,summary,session_id,session_file,commit_sha,result_digest,candidate_tip,evidence_refs_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]')`)
      .run(attemptId, task.taskId, number, 'prepared', memberId, generation, workspaceId, baseRev, depsDigest, task.requirementVersion, startedAt);
    const next: SwarmV2Task = {
      ...task, status: 'claimed', ownerMemberId: memberId, currentAttemptId: attemptId,
      blockedReason: null, revision: task.revision + 1, updatedAt: v2Now(),
    };
    saveTask(store, next);
    store.journal(task.teamId, 'attempt.prepared', {kind: 'member', id: memberId ?? 'lead'}, {kind: 'attempt', id: attemptId}, {
      taskId: task.taskId, taskRevision: next.revision, number, memberId, generation,
    });
    return getAttempt(store, attemptId);
  });
}

export function markAttemptRunning(store: V2Store, attemptId: string, input: AttemptRunningInput): SwarmV2Attempt {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '尝试启动参数必须是对象');
  const generation = intOrNull(input.generation, 'generation', 0) ?? 0;
  const workspaceId = optionalText(input.workspaceId, 'workspaceId', 200);
  return store.transaction(() => {
    const attempt = getAttempt(store, attemptId);
    if (attempt.status !== 'prepared') throw new CapabilityError('VERSION_CONFLICT', `尝试状态 ${attempt.status}，仅 prepared 可启动`);
    const task = getTask(store, attempt.taskId);
    if (task.currentAttemptId !== attempt.attemptId) throw new CapabilityError('VERSION_CONFLICT', '尝试不再是任务当前尝试');
    if (store.row("SELECT 1 FROM swarm_v2_attempts WHERE task_id=? AND status='running'", attempt.taskId)) throw new CapabilityError('VERSION_CONFLICT', '任务已有运行中的尝试');
    const startedAt = v2Now();
    store.db.prepare('UPDATE swarm_v2_attempts SET status=?,generation=?,workspace_id=?,started_at=? WHERE attempt_id=?')
      .run('running', generation, workspaceId, startedAt, attempt.attemptId);
    const next: SwarmV2Task = {...task, status: 'in_progress', revision: task.revision + 1, updatedAt: startedAt};
    saveTask(store, next);
    store.journal(task.teamId, 'attempt.started', {kind: 'member', id: attempt.memberId ?? 'lead'}, {kind: 'attempt', id: attempt.attemptId}, {
      taskId: task.taskId, taskRevision: next.revision, generation, workspaceId,
    });
    return getAttempt(store, attempt.attemptId);
  });
}

export function completeAttempt(store: V2Store, attemptId: string, result: CompleteAttemptInput): SwarmV2Attempt {
  if (!result || typeof result !== 'object') throw new CapabilityError('VALIDATION_ERROR', '尝试结果必须是对象');
  const summary = text(result.summary, 'summary', MAX_SUMMARY);
  const commitSha = optionalText(result.commitSha, 'commitSha', 200);
  const candidateTip = optionalText(result.candidateTip, 'candidateTip', 200);
  const resultDigest = optionalText(result.resultDigest, 'resultDigest', 500);
  const sessionId = optionalText(result.sessionId, 'sessionId', 200);
  const sessionFile = optionalText(result.sessionFile, 'sessionFile', 2000);
  const evidenceRefs = arrayText(result.evidenceRefs ?? [], 'evidenceRefs', 64, 1000);
  const artifactIds = arrayText(result.artifactIds ?? [], 'artifactIds', MAX_RESULT_ARTIFACTS, 200);
  return store.transaction(() => {
    const attempt = getAttempt(store, attemptId);
    if (attempt.status !== 'running') throw new CapabilityError('VERSION_CONFLICT', `尝试状态 ${attempt.status}，仅 running 可完成`);
    const task = getTask(store, attempt.taskId);
    if (task.currentAttemptId !== attempt.attemptId) throw new CapabilityError('VERSION_CONFLICT', '尝试不再是任务当前尝试');
    if (task.status !== 'in_progress') throw new CapabilityError('VERSION_CONFLICT', `任务状态 ${task.status}，不能交付结果`);
    const finishedAt = v2Now();
    store.db.prepare('UPDATE swarm_v2_attempts SET status=?,finished_at=?,terminal_reason=?,summary=?,commit_sha=?,candidate_tip=?,result_digest=?,session_id=?,session_file=?,evidence_refs_json=? WHERE attempt_id=?')
      .run('completed', finishedAt, 'completed', summary, commitSha, candidateTip, resultDigest, sessionId, sessionFile, JSON.stringify(evidenceRefs), attempt.attemptId);
    const next: SwarmV2Task = {
      ...task, status: 'delivered', resultRevision: task.resultRevision + 1, resultArtifactIds: artifactIds,
      revision: task.revision + 1, updatedAt: finishedAt,
    };
    saveTask(store, next);
    store.journal(task.teamId, 'attempt.delivered', {kind: 'member', id: attempt.memberId ?? 'lead'}, {kind: 'attempt', id: attempt.attemptId}, {
      taskId: task.taskId, resultRevision: next.resultRevision, artifactIds, summary,
    });
    store.journal(task.teamId, 'task.transitioned', {kind: 'member', id: attempt.memberId ?? 'lead'}, {kind: 'task', id: task.taskId, revision: next.revision}, {
      from: task.status, action: 'deliver', to: 'delivered',
    });
    return getAttempt(store, attempt.attemptId);
  });
}

export function failAttempt(store: V2Store, attemptId: string, input: FailAttemptInput): SwarmV2Attempt {
  if (!input || typeof input !== 'object') throw new CapabilityError('VALIDATION_ERROR', '尝试失败参数必须是对象');
  const reason = text(input.reason, 'reason', 2000);
  const unknown = input.unknown === true;
  return store.transaction(() => {
    const attempt = getAttempt(store, attemptId);
    if (attempt.status !== 'running') throw new CapabilityError('VERSION_CONFLICT', `尝试状态 ${attempt.status}，仅 running 可失败`);
    const task = getTask(store, attempt.taskId);
    if (task.currentAttemptId !== attempt.attemptId) throw new CapabilityError('VERSION_CONFLICT', '尝试不再是任务当前尝试');
    const finishedAt = v2Now();
    store.db.prepare('UPDATE swarm_v2_attempts SET status=?,finished_at=?,terminal_reason=?,summary=? WHERE attempt_id=?')
      .run(unknown ? 'unknown' : 'failed', finishedAt, unknown ? 'unknown' : 'failed', reason, attempt.attemptId);
    const blockedReason: SwarmV2BlockedReason = unknown
      ? {kind: 'unknown', cause: reason, by: attempt.attemptId}
      : {kind: 'policy', cause: `尝试失败：${reason}`, by: attempt.attemptId};
    const next: SwarmV2Task = {
      ...task, status: 'blocked', blockedReason, currentAttemptId: null, ownerMemberId: null,
      revision: task.revision + 1, updatedAt: finishedAt,
    };
    saveTask(store, next);
    if (unknown) pauseTeam(store, getTeam(store, task.teamId), `尝试结果未知：${reason}`);
    store.journal(task.teamId, 'attempt.failed', {kind: 'member', id: attempt.memberId ?? 'lead'}, {kind: 'attempt', id: attempt.attemptId}, {
      taskId: task.taskId, unknown, reason, taskRevision: next.revision,
    });
    return getAttempt(store, attempt.attemptId);
  });
}

export function markAttemptUnknown(store: V2Store, attemptId: string, reason = '尝试结果未知，禁止自动重放'): SwarmV2Attempt {
  return failAttempt(store, attemptId, {reason, unknown: true});
}

/** Recover attempts whose lease expired: mark unknown, block the task, pause the team. Never replays. */
export function recoverStaleAttempts(store: V2Store, teamId: string, input: RecoverStaleInput = {}): SwarmV2Attempt[] {
  const leaseMs = intOrNull(input.leaseMs, 'leaseMs', 0, 24 * 60 * 60 * 1000) ?? 15 * 60 * 1000;
  return store.transaction(() => {
    const team = getTeam(store, teamId);
    const rows = store.rows<AttemptBaseRow>(
      'SELECT a.* FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id WHERE t.team_id=? AND a.status=? ORDER BY a.started_at ASC,a.attempt_id ASC',
      team.teamId, 'running',
    );
    const recovered: SwarmV2Attempt[] = [];
    const nowMs = Date.now();
    let currentTeam = team;
    for (const row of rows) {
      const attempt = attemptFromRow(row);
      const startedMs = Date.parse(attempt.startedAt);
      if (Number.isFinite(startedMs) && nowMs - startedMs < leaseMs) continue;
      const finishedAt = v2Now();
      store.db.prepare('UPDATE swarm_v2_attempts SET status=?,finished_at=?,terminal_reason=?,summary=? WHERE attempt_id=?')
        .run('unknown', finishedAt, 'interrupted', '租约过期，结果未知', attempt.attemptId);
      const task = getTask(store, attempt.taskId);
      if (task.currentAttemptId === attempt.attemptId) {
        const next: SwarmV2Task = {
          ...task, status: 'blocked', blockedReason: {kind: 'unknown', cause: '尝试租约过期，结果未知', by: attempt.attemptId},
          currentAttemptId: null, ownerMemberId: null, revision: task.revision + 1, updatedAt: finishedAt,
        };
        saveTask(store, next);
      }
      currentTeam = pauseTeam(store, currentTeam, `尝试租约过期：${attempt.attemptId}`);
      store.journal(team.teamId, 'attempt.recovered', {kind: 'system', id: 'task-board'}, {kind: 'attempt', id: attempt.attemptId}, {
        taskId: attempt.taskId, reason: 'lease-expired',
      });
      recovered.push(getAttempt(store, attempt.attemptId));
    }
    return recovered;
  });
}

// ---------------------------------------------------------------------------
// Rework
// ---------------------------------------------------------------------------

function latestRequirementPrompt(store: V2Store, taskId: string): string | undefined {
  const row = store.row<{prompt: string}>('SELECT prompt FROM swarm_v2_task_requirements WHERE task_id=? ORDER BY version DESC LIMIT 1', taskId);
  return row ? String(row.prompt) : undefined;
}

function downstreamClosure(store: V2Store, teamId: string, roots: string[]): string[] {
  const dependents = new Map<string, string[]>();
  for (const row of store.rows<{task_id: string; depends_on: string}>(
    'SELECT d.task_id,d.depends_on FROM swarm_v2_task_dependencies d JOIN swarm_v2_tasks t ON t.task_id=d.task_id WHERE t.team_id=? ORDER BY d.rowid',
    teamId,
  )) {
    const dependency = String(row.depends_on);
    dependents.set(dependency, [...(dependents.get(dependency) ?? []), String(row.task_id)]);
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of dependents.get(id) ?? []) if (!seen.has(next)) queue.push(next);
  }
  return [...seen].sort();
}

/**
 * Apply a rework round per blueprint §6.5: expand the requested tasks to their
 * downstream dependency closure, append exactly one requirement version per
 * affected task, reset them to ready, bump quotas, and detect repeated failures.
 * A repeated fingerprint without new requirement changes pauses the team and
 * rejects with BUDGET_EXHAUSTED (the pause is committed before the rejection).
 */
export function startRework(store: V2Store, teamId: string, taskIds: string[], reason: string, changes: Record<string, string> = {}): SwarmV2ReworkReceipt {
  if (!Array.isArray(taskIds) || !taskIds.length) throw new CapabilityError('VALIDATION_ERROR', 'taskIds 不能为空');
  const requested = [...new Set(taskIds.map(id => text(id, 'taskId', 200)))];
  const reasonText = text(reason, 'reason', 2000);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new CapabilityError('VALIDATION_ERROR', 'changes 必须是任务→需求文本的对象');
  const changeMap = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, text(value, `changes.${key}`, MAX_DESCRIPTION)]));
  const outcome = store.transaction(() => {
    const team = getTeam(store, teamId);
    for (const id of requested) {
      const task = getTask(store, id);
      if (task.teamId !== team.teamId) throw new CapabilityError('VALIDATION_ERROR', `任务不属于该团队：${id}`);
      if (task.tombstone) throw new CapabilityError('VALIDATION_ERROR', `已删除任务不能返工：${id}`);
    }
    const affected = downstreamClosure(store, team.teamId, requested);
    const applicable = affected
      .map(id => getTask(store, id))
      .filter(task => !task.tombstone && task.status !== 'cancelled' && task.status !== 'deleted');
    if (!applicable.length) throw new CapabilityError('VALIDATION_ERROR', '没有可返工的任务');
    const fingerprints = applicable.flatMap(task => task.resultArtifactIds);
    const fingerprint = failureFingerprint({
      logicalSteps: applicable.map(task => task.logicalStepId),
      requirement: applicable.map(task => changeMap[task.taskId] ?? latestRequirementPrompt(store, task.taskId) ?? task.title),
      failure: reasonText,
      artifacts: fingerprints,
    });
    const hasChanges = Object.keys(changeMap).length > 0;
    const repeated = team.failureFingerprints.includes(fingerprint);
    if (repeated && !hasChanges) {
      pauseTeam(store, team, '返工指纹重复且无新变更');
      return {repeated: true as const};
    }
    if (team.status !== 'running') throw new CapabilityError('BUDGET_EXHAUSTED', `团队状态 ${team.status}，不能开始返工`);
    for (const task of applicable) {
      if (task.reworkCount >= MAX_TASK_REWORK) throw new CapabilityError('BUDGET_EXHAUSTED', `任务返工轮次已达上限 ${MAX_TASK_REWORK}：${task.taskId}`);
    }
    if (team.reworkRound >= MAX_GRAPH_REWORK) throw new CapabilityError('BUDGET_EXHAUSTED', `团队返工轮次已达上限 ${MAX_GRAPH_REWORK}`);
    const at = v2Now();
    // A rework invalidates the current work: terminate live attempts and release their
    // write claims before the task returns to ready, otherwise the one-running partial
    // index (and a lingering claim) would block the fresh attempt.
    for (const task of applicable) {
      if (!task.currentAttemptId) continue;
      const live = store.row<{status: string}>('SELECT status FROM swarm_v2_attempts WHERE attempt_id=?', task.currentAttemptId);
      if (!live || !['prepared', 'running'].includes(String(live.status))) continue;
      store.db.prepare('UPDATE swarm_v2_attempts SET status=?,finished_at=?,terminal_reason=?,summary=? WHERE attempt_id=?')
        .run('failed', at, 'interrupted', `返工中断：${reasonText}`, task.currentAttemptId);
      const released = store.db.prepare("UPDATE swarm_v2_write_claims SET state='released',released_at=? WHERE attempt_id=? AND state='active'")
        .run(at, task.currentAttemptId);
      if (Number(released.changes) > 0) {
        store.journal(team.teamId, 'workspace.released', {kind: 'system', id: 'task-board'}, {kind: 'write-claim', id: task.currentAttemptId}, {
          attemptId: task.currentAttemptId, taskId: task.taskId, reason: 'rework',
        });
      }
      store.journal(team.teamId, 'attempt.interrupted', {kind: 'system', id: 'task-board'}, {kind: 'attempt', id: task.currentAttemptId}, {
        taskId: task.taskId, reason: reasonText,
      });
    }
    // Release any active claim left by completed/failed attempts of affected tasks.
    for (const task of applicable) {
      const released = store.db.prepare("UPDATE swarm_v2_write_claims SET state='released',released_at=? WHERE task_id=? AND state='active'").run(at, task.taskId);
      if (Number(released.changes) > 0) store.journal(team.teamId, 'workspace.released', {kind: 'system', id: 'task-board'}, {kind: 'write-claim', id: task.taskId}, {taskId: task.taskId, reason: 'rework'});
    }
    for (const task of applicable) {
      const prompt = changeMap[task.taskId] ?? latestRequirementPrompt(store, task.taskId) ?? task.title;
      const automatic = changeMap[task.taskId] === undefined;
      const version = task.requirementVersion + 1;
      store.db.prepare('INSERT INTO swarm_v2_task_requirements(task_id,version,prompt,reason,automatic,created_at) VALUES(?,?,?,?,?,?)')
        .run(task.taskId, version, prompt, `返工：${reasonText}`, automatic ? 1 : 0, at);
      const next: SwarmV2Task = {
        ...task, status: 'ready', currentAttemptId: null, ownerMemberId: null, blockedReason: null,
        requirementVersion: version, reworkCount: task.reworkCount + 1, revision: task.revision + 1, updatedAt: at,
      };
      saveTask(store, next);
      store.journal(team.teamId, 'task.rework_applied', {kind: 'lead', id: 'lead'}, {kind: 'task', id: task.taskId, revision: next.revision}, {
        reason: reasonText, automatic, requirementVersion: version, reworkCount: next.reworkCount,
      });
    }
    const nextTeam: SwarmV2Team = {
      ...team, reworkRound: team.reworkRound + 1, updatedAt: at, revision: team.revision + 1,
      failureFingerprints: repeated ? team.failureFingerprints : [...team.failureFingerprints, fingerprint],
    };
    saveTeam(store, nextTeam);
    const receipt: SwarmV2ReworkReceipt = {
      taskIds: requested, affected, reason: reasonText, fingerprint, reworkRound: nextTeam.reworkRound, created: [],
    };
    return {receipt};
  });
  if ('repeated' in outcome) {
    throw new CapabilityError('BUDGET_EXHAUSTED', '返工失败指纹重复且没有新变更，团队已暂停等待人工裁决');
  }
  return outcome.receipt;
}
