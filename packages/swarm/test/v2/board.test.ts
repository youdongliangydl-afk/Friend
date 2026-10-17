import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordStore} from '@friend-pi/core';
import {V2Store} from '../../src/v2/store.js';
import {
  addRequirementVersion, addWriteScopes, boardActor, completeAttempt, createTask, createTeam, failAttempt,
  getAttempt, getTask, getTeam, listAttempts, listTasks, markAttemptRunning, markAttemptUnknown, prepareAttempt,
  recoverStaleAttempts, removeWriteScopes, setDependencies, setTeamStatus, setWriteScopes, startRework,
  transitionTask, updateTask, updateTeam,
} from '../../src/v2/task-board.js';
import {
  activeClaims, acquireClaim, claimPreflight, normalizeScope, releaseClaim, scopesOverlap, validateScopes,
} from '../../src/v2/write-claims.js';
import {readyFrontier, runningAttempts, scheduleOnce} from '../../src/v2/scheduler.js';
import type {SwarmV2Task, SwarmV2TaskDraft, SwarmV2Team} from '../../src/v2/types.js';

interface Fixture {
  dir: string;
  record: RecordStore;
  store: V2Store;
  cleanup(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-v2-board-'));
  const record = new RecordStore('swarm', dir);
  const store = V2Store.open(record);
  return {dir, record, store, cleanup: () => { record.close(); rmSync(dir, {recursive: true, force: true}); }};
}

let teamSequence = 0;
function team(store: V2Store): SwarmV2Team {
  teamSequence += 1;
  return createTeam(store, {projectId: `project-${teamSequence}`, rootSessionId: `session-${teamSequence}`, workspaceRoot: '/tmp/swarm-workspace'});
}

function draft(over: Partial<SwarmV2TaskDraft> = {}): SwarmV2TaskDraft {
  return {title: '任务标题', description: '任务描述与要求', mode: 'read', risk: 'V0', acceptance: ['产出可验证'], ...over};
}

function createRead(store: V2Store, teamId: string, over: Partial<SwarmV2TaskDraft> = {}): SwarmV2Task {
  return createTask(store, teamId, draft({mode: 'read', risk: 'V0', ...over}), 'lead');
}

function createWrite(store: V2Store, teamId: string, scopes: string[], over: Partial<SwarmV2TaskDraft> = {}): SwarmV2Task {
  return createTask(store, teamId, draft({mode: 'write', risk: 'V1', acceptance: ['写入可验证'], writeScopes: scopes, ...over}), 'lead');
}

/** Walk a ready read task through the whole board machine without a real attempt. */
function finishReadTask(store: V2Store, task: SwarmV2Task): SwarmV2Task {
  let current = task;
  for (const action of ['claim', 'admit', 'deliver', 'verify', 'complete']) {
    current = transitionTask(store, current.taskId, current.revision, action, 'lead');
  }
  return current;
}

function addMember(store: V2Store, teamId: string, memberId: string, role = 'worker', phase = 'active', generation = 0): void {
  const at = new Date().toISOString();
  store.db.prepare(`INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,model_ref,generation,phase,status,session_id,session_file,capability_json,write_scopes_json,lease_expires_at,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,'fresh',NULL,?,?,'idle',NULL,NULL,'{}','[]',NULL,1,?,?)`)
    .run(memberId, teamId, memberId, `members/${memberId}`, role, generation, phase, at, at);
}

function setCreated(store: V2Store, taskId: string, at: string): void {
  store.db.prepare('UPDATE swarm_v2_tasks SET created_at=? WHERE task_id=?').run(at, taskId);
}

function eventTypes(store: V2Store, teamId: string): string[] {
  return store.events(teamId, 0, 2000).map(event => event.type);
}

// ---------------------------------------------------------------------------
// I4: team/task CAS and the 8-state machine
// ---------------------------------------------------------------------------

test('team creation, CAS updates and status changes are journaled exactly once per mutation', () => {
  const f = fixture();
  try {
    const created = createTeam(f.store, {projectId: 'p', rootSessionId: 's', workspaceRoot: '/ws'});
    assert.equal(created.status, 'created');
    assert.equal(created.revision, 1);
    assert.equal(created.reworkRound, 0);
    assert.deepEqual(created.failureFingerprints, []);
    assert.equal(getTeam(f.store, created.teamId).teamId, created.teamId);
    assert.deepEqual(eventTypes(f.store, created.teamId), ['team.created']);

    assert.throws(() => updateTeam(f.store, created.teamId, 99, {autonomyLevel: 2}), {code: 'VERSION_CONFLICT'});
    const updated = updateTeam(f.store, created.teamId, 1, {autonomyLevel: 2, policy: {mode: 'strict'}});
    assert.equal(updated.revision, 2);
    assert.equal(updated.autonomyLevel, 2);
    assert.deepEqual(updated.policy, {mode: 'strict'});
    const teamUpdated = f.store.events(created.teamId).find(event => event.type === 'team.updated')!;
    assert.equal((teamUpdated.data.values as Record<string, unknown>).autonomyLevel, 2);
    assert.deepEqual((teamUpdated.data.values as Record<string, unknown>).policy, {mode: 'strict'});

    assert.throws(() => setTeamStatus(f.store, created.teamId, 1, 'running'), {code: 'VERSION_CONFLICT'});
    const running = setTeamStatus(f.store, created.teamId, 2, 'running');
    assert.equal(running.status, 'running');
    assert.equal(running.revision, 3);
    assert.equal(setTeamStatus(f.store, created.teamId, 3, 'running').revision, 3, 'same status is a no-op');
    assert.deepEqual(eventTypes(f.store, created.teamId), ['team.created', 'team.updated', 'team.status_changed']);

    assert.throws(() => setTeamStatus(f.store, created.teamId, 3, 'flying' as SwarmV2Team['status']), {code: 'VALIDATION_ERROR'});
    assert.throws(() => getTeam(f.store, 'missing-team'), {code: 'VALIDATION_ERROR'});
  } finally { f.cleanup(); }
});

test('task creation validates every contract field and normalizes scopes', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const task = createTask(f.store, t.teamId, draft({title: '只读任务', description: '读取并总结', acceptance: ['结论明确']}), 'user-1');
    assert.equal(task.revision, 1);
    assert.equal(task.status, 'ready');
    assert.equal(task.mode, 'read');
    assert.deepEqual(task.writeScopes, []);
    assert.equal(task.logicalStepId, task.taskId);
    assert.equal(task.requirementVersion, 1);
    assert.equal(task.createdBy, 'user-1');
    assert.deepEqual(eventTypes(f.store, t.teamId), ['team.created', 'task.created']);
    const requirement = f.store.row<{version: number; prompt: string; automatic: number}>('SELECT version,prompt,automatic FROM swarm_v2_task_requirements WHERE task_id=?', task.taskId)!;
    assert.deepEqual([Number(requirement.version), requirement.prompt, Number(requirement.automatic)], [1, '读取并总结', 0]);

    assert.throws(() => createTask(f.store, t.teamId, draft({title: 'x'.repeat(201)}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({description: 'x'.repeat(16385)}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({mode: 'both' as 'read'}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({risk: 'V9' as 'V0'}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({risk: 'V1', acceptance: []}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({writeScopes: ['src']}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({mode: 'write', risk: 'V1', writeScopes: []}), 'lead'), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createTask(f.store, t.teamId, draft({workspacePolicy: 'cloud' as 'worktree'}), 'lead'), {code: 'VALIDATION_ERROR'});
    const write = createWrite(f.store, t.teamId, [' ./src/ ', 'docs//guide', 'src'], {title: '写任务'});
    assert.deepEqual(write.writeScopes, ['src', 'docs/guide']);
    assert.equal(write.risk, 'V1');
    assert.throws(() => getTask(f.store, 'missing-task'), {code: 'VALIDATION_ERROR'});
  } finally { f.cleanup(); }
});

test('the 8-state machine is table-driven, CAS-guarded and tombstones delete only leaf tasks', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const task = createRead(f.store, t.teamId);
    let current = transitionTask(f.store, task.taskId, 1, 'claim', 'worker-1');
    assert.equal(current.status, 'claimed');
    assert.throws(() => transitionTask(f.store, task.taskId, 1, 'admit', 'worker-1'), {code: 'VERSION_CONFLICT'});
    assert.throws(() => transitionTask(f.store, task.taskId, current.revision, 'complete', 'lead'), {code: 'VALIDATION_ERROR'});
    current = transitionTask(f.store, task.taskId, current.revision, 'admit', 'worker-1');
    current = transitionTask(f.store, task.taskId, current.revision, 'deliver', 'worker-1');
    assert.equal(current.status, 'delivered');
    current = transitionTask(f.store, task.taskId, current.revision, 'verify', 'reviewer-1');
    current = transitionTask(f.store, task.taskId, current.revision, 'complete', 'lead');
    assert.equal(current.status, 'done');
    assert.throws(() => transitionTask(f.store, task.taskId, current.revision, 'cancel', 'lead'), {code: 'VALIDATION_ERROR'});
    assert.equal(getTask(f.store, task.taskId).revision, current.revision, 'rejected transitions never bump revision');
    assert.deepEqual(eventTypes(f.store, t.teamId), ['team.created', 'task.created', 'task.transitioned', 'task.transitioned', 'task.transitioned', 'task.transitioned', 'task.transitioned']);

    const leaf = createRead(f.store, t.teamId);
    const blocked = transitionTask(f.store, leaf.taskId, leaf.revision, 'block', 'lead');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason?.kind, 'policy');
    const unblocked = transitionTask(f.store, blocked.taskId, blocked.revision, 'unblock', 'lead');
    assert.equal(unblocked.status, 'ready');
    assert.equal(unblocked.blockedReason, null);

    const parent = createRead(f.store, t.teamId);
    const child = createRead(f.store, t.teamId, {dependencies: [parent.taskId]});
    assert.throws(() => transitionTask(f.store, parent.taskId, parent.revision, 'delete', 'lead'), {code: 'VALIDATION_ERROR'});
    const deletedChild = transitionTask(f.store, child.taskId, child.revision, 'delete', 'lead');
    assert.equal(deletedChild.status, 'deleted');
    assert.equal(deletedChild.tombstone, true);
    assert.ok(deletedChild.deletedAt);
    assert.deepEqual(listTasks(f.store, t.teamId).map(task => task.taskId).includes(child.taskId), false);
    assert.deepEqual(listTasks(f.store, t.teamId, {includeDeleted: true}).map(task => task.taskId).includes(child.taskId), true);
    const deletedParent = transitionTask(f.store, parent.taskId, parent.revision, 'delete', 'lead');
    assert.equal(deletedParent.tombstone, true);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// I5: DAG validation and blocked/ready derivation
// ---------------------------------------------------------------------------

test('dependencies must exist, belong to the team, be live and acyclic', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const otherTeam = team(f.store);
    const a = createRead(f.store, t.teamId);
    const other = createRead(f.store, otherTeam.teamId);

    assert.throws(() => createRead(f.store, t.teamId, {dependencies: ['missing']}), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createRead(f.store, t.teamId, {dependencies: [other.taskId]}), {code: 'VALIDATION_ERROR'});
    const deduped = createRead(f.store, t.teamId, {dependencies: [a.taskId, a.taskId]});
    assert.deepEqual(deduped.dependencies, [a.taskId]);

    const b = createRead(f.store, t.teamId);
    const aBlocked = setDependencies(f.store, a.taskId, a.revision, [b.taskId]);
    assert.equal(aBlocked.status, 'blocked');
    assert.throws(() => setDependencies(f.store, b.taskId, b.revision, [a.taskId]), /形成环/u);
    assert.throws(() => setDependencies(f.store, a.taskId, getTask(f.store, a.taskId).revision, [a.taskId]), /依赖自己/u);
    assert.throws(() => setDependencies(f.store, b.taskId, b.revision, ['missing']), {code: 'VALIDATION_ERROR'});

    const pending = createRead(f.store, t.teamId, {dependencies: [a.taskId]});
    assert.equal(pending.status, 'blocked');
    assert.equal(pending.blockedReason?.kind, 'dependency');
    assert.match(String(pending.blockedReason?.cause), /等待依赖完成/u);
    assert.throws(() => transitionTask(f.store, pending.taskId, pending.revision, 'unblock', 'lead'), {code: 'VALIDATION_ERROR'});
    const doneB = finishReadTask(f.store, getTask(f.store, b.taskId));
    assert.equal(doneB.status, 'done');
    const aReady = transitionTask(f.store, a.taskId, getTask(f.store, a.taskId).revision, 'unblock', 'lead');
    assert.equal(aReady.status, 'ready');
    const doneA = finishReadTask(f.store, aReady);
    assert.equal(doneA.status, 'done');
    const unblocked = transitionTask(f.store, pending.taskId, pending.revision, 'unblock', 'lead');
    assert.equal(unblocked.status, 'ready');
    assert.equal(unblocked.blockedReason, null);

    const deletedDep = createRead(f.store, t.teamId);
    transitionTask(f.store, deletedDep.taskId, deletedDep.revision, 'delete', 'lead');
    assert.throws(() => createRead(f.store, t.teamId, {dependencies: [deletedDep.taskId]}), /已删除/u);
  } finally { f.cleanup(); }
});

test('the active task cap is 256 and tombstones free capacity', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const at = new Date().toISOString();
    for (let index = 0; index < 256; index++) {
      f.store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,owner_member_id,current_attempt_id,logical_step_id,result_revision,result_artifact_ids_json,rework_count,requirement_version,acceptance_json,checks_ref,workspace_policy,blocked_reason_json,created_by,created_at,updated_at,deleted_at,tombstone)
        VALUES(?,?,1,'t','d','read','V0','ready',NULL,NULL,?,0,'[]',0,1,'[]',NULL,'worktree',NULL,'lead',?,?,NULL,0)`)
        .run(`filler-${index}`, t.teamId, `filler-${index}`, at, at);
    }
    assert.throws(() => createRead(f.store, t.teamId), {code: 'VALIDATION_ERROR'});
    f.store.db.prepare("UPDATE swarm_v2_tasks SET status='deleted',tombstone=1 WHERE task_id='filler-0'").run();
    assert.equal(createRead(f.store, t.teamId).status, 'ready');
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Requirements / repair
// ---------------------------------------------------------------------------

test('requirement versions append monotonically without rewriting the original prompt', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const task = createRead(f.store, t.teamId, {description: '原始需求'});
    assert.throws(() => addRequirementVersion(f.store, task.taskId, 99, {prompt: '新需求', automatic: false}), {code: 'VERSION_CONFLICT'});
    const v2 = addRequirementVersion(f.store, task.taskId, 1, {prompt: '追加需求', reason: '用户补充', automatic: false}, 'user-1');
    assert.equal(v2.requirementVersion, 2);
    assert.equal(v2.revision, 2);
    const v3 = addRequirementVersion(f.store, task.taskId, 2, {prompt: '再追加', automatic: true});
    assert.equal(v3.requirementVersion, 3);
    const rows = f.store.rows<{version: number; prompt: string; automatic: number}>('SELECT version,prompt,automatic FROM swarm_v2_task_requirements WHERE task_id=? ORDER BY version', task.taskId);
    assert.deepEqual(rows.map(row => [Number(row.version), row.prompt, Number(row.automatic)]), [[1, '原始需求', 0], [2, '追加需求', 0], [3, '再追加', 1]]);
    assert.ok(eventTypes(f.store, t.teamId).filter(type => type === 'task.requirement_added').length === 2);
  } finally { f.cleanup(); }
});

test('updateTask is CAS-guarded, re-validates acceptance and reparses the blocked state on dependency change', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const dependency = createRead(f.store, t.teamId);
    const task = createRead(f.store, t.teamId, {risk: 'V1', acceptance: ['初始验收'], dependencies: [dependency.taskId]});
    assert.equal(task.status, 'blocked');
    assert.throws(() => updateTask(f.store, task.taskId, 99, {title: 'x'}), {code: 'VERSION_CONFLICT'});
    const updated = updateTask(f.store, task.taskId, task.revision, {title: '新标题', description: '新描述', acceptance: ['新验收']}, 'lead');
    assert.equal(updated.title, '新标题');
    assert.deepEqual(updated.acceptance, ['新验收']);
    assert.equal(updated.status, 'blocked', 'unresolved dependencies stay blocked');
    assert.throws(() => updateTask(f.store, task.taskId, updated.revision, {acceptance: []}), {code: 'VALIDATION_ERROR'});
    assert.throws(() => updateTask(f.store, task.taskId, updated.revision, {bogus: true} as never), {code: 'VALIDATION_ERROR'});
    const taskUpdated = f.store.events(t.teamId).findLast(event => event.type === 'task.updated')!;
    const taskValues = taskUpdated.data.values as Record<string, unknown>;
    assert.equal(taskValues.title, '新标题');
    assert.equal(taskValues.description, '新描述');
    assert.deepEqual(taskValues.acceptance, ['新验收']);
    assert.deepEqual(taskUpdated.data.fields, ['title', 'description', 'acceptance']);

    const writeTask = createWrite(f.store, t.teamId, ['src']);
    const writeUpdated = updateTask(f.store, writeTask.taskId, writeTask.revision, {writeScopes: ['src', 'docs/guide']}, 'lead');
    assert.deepEqual(writeUpdated.writeScopes, ['src', 'docs/guide']);
    const scopeUpdated = f.store.events(t.teamId).findLast(event => event.type === 'task.updated')!;
    assert.deepEqual((scopeUpdated.data.values as Record<string, unknown>).writeScopes, ['src', 'docs/guide']);

    const ready = setDependencies(f.store, task.taskId, updated.revision, []);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.blockedReason, null);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// I6: attempts/result separation + one running attempt
// ---------------------------------------------------------------------------

test('attempt lifecycle: prepared -> running -> completed delivers a result version', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const task = createRead(f.store, t.teamId);
    assert.throws(() => prepareAttempt(f.store, task.taskId, 99, {memberId: null}), {code: 'VERSION_CONFLICT'});
    const prepared = prepareAttempt(f.store, task.taskId, 1, {memberId: 'worker-1', generation: 3, workspaceId: 'ws-1', baseRev: 'abc'});
    assert.equal(prepared.status, 'prepared');
    assert.equal(prepared.number, 1);
    assert.equal(prepared.memberId, 'worker-1');
    assert.equal(prepared.generation, 3);
    assert.equal(prepared.requirementVersion, 1);
    assert.equal(getTask(f.store, task.taskId).status, 'claimed');
    assert.equal(getTask(f.store, task.taskId).currentAttemptId, prepared.attemptId);
    assert.equal(getTask(f.store, task.taskId).ownerMemberId, 'worker-1');
    assert.throws(() => prepareAttempt(f.store, task.taskId, 2, {memberId: null}), {code: 'VERSION_CONFLICT'});

    assert.throws(() => completeAttempt(f.store, prepared.attemptId, {summary: '提前完成'}), {code: 'VERSION_CONFLICT'});
    const running = markAttemptRunning(f.store, prepared.attemptId, {generation: 4, workspaceId: 'ws-1'});
    assert.equal(running.status, 'running');
    assert.equal(getTask(f.store, task.taskId).status, 'in_progress');
    const completed = completeAttempt(f.store, prepared.attemptId, {summary: '实现完成', commitSha: 'deadbeef', candidateTip: 'tip-1', artifactIds: ['artifact-1', 'artifact-2'], evidenceRefs: ['evidence-1']});
    assert.equal(completed.status, 'completed');
    assert.equal(completed.terminalReason, 'completed');
    assert.equal(completed.sessionId, null);
    const delivered = getTask(f.store, task.taskId);
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.resultRevision, 1);
    assert.deepEqual(delivered.resultArtifactIds, ['artifact-1', 'artifact-2']);
    assert.deepEqual(listAttempts(f.store, t.teamId).map(attempt => attempt.status), ['completed']);
    assert.throws(() => completeAttempt(f.store, prepared.attemptId, {summary: '再次完成'}), {code: 'VERSION_CONFLICT'});
    assert.equal(eventTypes(f.store, t.teamId).filter(type => type === 'attempt.prepared').length, 1);
    assert.equal(eventTypes(f.store, t.teamId).filter(type => type === 'attempt.started').length, 1);
    assert.equal(eventTypes(f.store, t.teamId).filter(type => type === 'attempt.delivered').length, 1);
  } finally { f.cleanup(); }
});

test('at most one running attempt per task is enforced by the partial unique index', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const task = createRead(f.store, t.teamId);
    const attempt = prepareAttempt(f.store, task.taskId, task.revision, {memberId: null});
    markAttemptRunning(f.store, attempt.attemptId, {generation: 0, workspaceId: null});
    const insert = () => f.store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,workspace_id,base_rev,deps_digest,requirement_version,budget_reservation_id,started_at,finished_at,terminal_reason,summary,session_id,session_file,commit_sha,result_digest,candidate_tip,evidence_refs_json)
      VALUES('raw-duplicate',?,2,'running',NULL,0,NULL,NULL,NULL,1,NULL,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]')`).run(task.taskId, new Date().toISOString());
    assert.throws(insert, /UNIQUE constraint failed/u);
    assert.equal(runningAttempts(f.store, t.teamId).length, 1);
    assert.equal(runningAttempts(f.store, t.teamId)[0]!.attemptId, attempt.attemptId);
  } finally { f.cleanup(); }
});

test('failed and unknown attempts block the task; unknown also pauses the team and never replays', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    setTeamStatus(f.store, t.teamId, 1, 'running');
    const failedTask = createRead(f.store, t.teamId);
    const failedAttempt = prepareAttempt(f.store, failedTask.taskId, failedTask.revision, {memberId: 'worker-1'});
    markAttemptRunning(f.store, failedAttempt.attemptId, {generation: 0, workspaceId: null});
    const failed = failAttempt(f.store, failedAttempt.attemptId, {reason: '命令退出码非零'});
    assert.equal(failed.status, 'failed');
    const blocked = getTask(f.store, failedTask.taskId);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.currentAttemptId, null);
    assert.equal(blocked.blockedReason?.kind, 'policy');
    assert.equal(getTeam(f.store, t.teamId).status, 'running', 'plain failure does not pause the team');

    const unknownTask = createRead(f.store, t.teamId);
    const unknownAttempt = prepareAttempt(f.store, unknownTask.taskId, unknownTask.revision, {memberId: 'worker-2'});
    markAttemptRunning(f.store, unknownAttempt.attemptId, {generation: 0, workspaceId: null});
    const unknown = failAttempt(f.store, unknownAttempt.attemptId, {reason: '宿主崩溃', unknown: true});
    assert.equal(unknown.status, 'unknown');
    const unknownBlocked = getTask(f.store, unknownTask.taskId);
    assert.equal(unknownBlocked.status, 'blocked');
    assert.equal(unknownBlocked.blockedReason?.kind, 'unknown');
    assert.equal(getTeam(f.store, t.teamId).status, 'paused');
    assert.ok(eventTypes(f.store, t.teamId).includes('team.status_changed'));

    const thirdTask = createRead(f.store, t.teamId);
    const thirdAttempt = prepareAttempt(f.store, thirdTask.taskId, thirdTask.revision, {memberId: 'worker-3'});
    markAttemptRunning(f.store, thirdAttempt.attemptId, {generation: 0, workspaceId: null});
    assert.equal(markAttemptUnknown(f.store, thirdAttempt.attemptId, '工具调用结果未知').status, 'unknown');
    assert.equal(getTask(f.store, thirdTask.taskId).blockedReason?.kind, 'unknown');
  } finally { f.cleanup(); }
});

test('recoverStaleAttempts marks expired running attempts unknown, blocks the task and pauses the team', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    setTeamStatus(f.store, t.teamId, 1, 'running');
    const fresh = createRead(f.store, t.teamId);
    const freshAttempt = prepareAttempt(f.store, fresh.taskId, fresh.revision, {memberId: 'worker-1'});
    markAttemptRunning(f.store, freshAttempt.attemptId, {generation: 0, workspaceId: null});
    const recovered = recoverStaleAttempts(f.store, t.teamId, {leaseMs: 0});
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.attemptId, freshAttempt.attemptId);
    assert.equal(recovered[0]!.status, 'unknown');
    assert.equal(recovered[0]!.terminalReason, 'interrupted');
    assert.equal(getTask(f.store, fresh.taskId).status, 'blocked');
    assert.equal(getTask(f.store, fresh.taskId).blockedReason?.kind, 'unknown');
    assert.equal(getTeam(f.store, t.teamId).status, 'paused');
    assert.deepEqual(recoverStaleAttempts(f.store, t.teamId, {leaseMs: 0}), []);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// I7: write scopes / claims
// ---------------------------------------------------------------------------

test('scope normalization, containment and validation are exact', () => {
  assert.equal(normalizeScope('src/'), 'src');
  assert.equal(normalizeScope('./src//a.ts'), 'src/a.ts');
  assert.equal(normalizeScope('src/./a'), 'src/a');
  assert.equal(normalizeScope('./src'), 'src');
  assert.equal(normalizeScope('src/././a/'), 'src/a');
  assert.equal(normalizeScope('src/.'), 'src');
  assert.deepEqual(validateScopes(['src/./a'], 'write'), ['src/a']);
  assert.equal(scopesOverlap('src/./a', 'src/a'), true);
  assert.equal(scopesOverlap('src/./lib/a.ts', 'src/lib'), true);
  assert.equal(normalizeScope('.'), '.');
  assert.equal(normalizeScope('./'), '.');
  assert.equal(scopesOverlap('src', 'src/a.ts'), true);
  assert.equal(scopesOverlap('src/a.ts', 'src'), true);
  assert.equal(scopesOverlap('src', 'srcx'), false);
  assert.equal(scopesOverlap('src', 'src-other/a'), false);
  assert.equal(scopesOverlap('.', 'anything'), true);
  assert.deepEqual(validateScopes(['src/', './src'], 'write'), ['src']);
  assert.throws(() => validateScopes(['/abs'], 'write'), {code: 'VALIDATION_ERROR'});
  assert.throws(() => validateScopes(['a/../b'], 'write'), {code: 'VALIDATION_ERROR'});
  assert.throws(() => validateScopes(['..'], 'write'), {code: 'VALIDATION_ERROR'});
  assert.throws(() => validateScopes([], 'write'), {code: 'VALIDATION_ERROR'});
  assert.throws(() => validateScopes(['src'], 'read'), {code: 'VALIDATION_ERROR'});
  assert.deepEqual(validateScopes([], 'read'), []);
});

test('independent write tasks may not overlap scopes, ordered writers may', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const first = createWrite(f.store, t.teamId, ['src']);
    assert.throws(() => createWrite(f.store, t.teamId, ['src/lib/a.ts']), {code: 'VALIDATION_ERROR'});
    assert.throws(() => createWrite(f.store, t.teamId, ['.']), {code: 'VALIDATION_ERROR'});
    const ordered = createWrite(f.store, t.teamId, ['src'], {dependencies: [first.taskId]});
    assert.deepEqual(ordered.dependencies, [first.taskId]);
    const docs = createWrite(f.store, t.teamId, ['docs']);
    assert.throws(() => addWriteScopes(f.store, docs.taskId, docs.revision, ['src']), {code: 'VALIDATION_ERROR'});
    assert.throws(() => setWriteScopes(f.store, docs.taskId, docs.revision, ['src']), {code: 'VALIDATION_ERROR'});
    const narrowed = removeWriteScopes(f.store, docs.taskId, docs.revision, ['.']);
    assert.deepEqual(narrowed.writeScopes, ['docs']);
    assert.throws(() => removeWriteScopes(f.store, docs.taskId, narrowed.revision, ['docs']), {code: 'VALIDATION_ERROR'});
    assert.throws(() => transitionTask(f.store, ordered.taskId, ordered.revision, 'unblock', 'lead'), {code: 'VALIDATION_ERROR'});
    const readTask = createRead(f.store, t.teamId);
    assert.throws(() => addWriteScopes(f.store, readTask.taskId, readTask.revision, ['src']), {code: 'VALIDATION_ERROR'});
  } finally { f.cleanup(); }
});

test('claim preflight and acquire/release keep overlapping writers out and journal conflicts', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const first = createWrite(f.store, t.teamId, ['src']);
    const second = createWrite(f.store, t.teamId, ['docs'], {dependencies: [first.taskId]});
    const firstAttempt = prepareAttempt(f.store, first.taskId, first.revision, {memberId: null});
    mkRunning(f.store, firstAttempt.attemptId);
    const acquired = acquireClaim(f.store, {teamId: t.teamId, attemptId: firstAttempt.attemptId, taskId: first.taskId, scopes: ['src']});
    assert.equal(acquired.held, false);
    if (acquired.held) throw new Error('unreachable');
    assert.deepEqual(activeClaims(f.store, t.teamId).map(claim => claim.claimId), [acquired.claim.claimId]);
    assert.deepEqual(claimPreflight(f.store, t.teamId, ['src/lib.ts']), {held: true, cause: 'write-scope', by: {attemptId: firstAttempt.attemptId, taskId: first.taskId, scopes: ['src']}});
    assert.deepEqual(claimPreflight(f.store, t.teamId, ['src/lib.ts'], {attemptId: firstAttempt.attemptId}), {held: false});
    assert.deepEqual(claimPreflight(f.store, t.teamId, ['docs']), {held: false});

    // Acquire is idempotent for the same attempt/scopes.
    const repeated = acquireClaim(f.store, {teamId: t.teamId, attemptId: firstAttempt.attemptId, taskId: first.taskId, scopes: ['src']});
    assert.equal(repeated.held, false);
    if (!repeated.held) assert.equal(repeated.claim.claimId, acquired.claim.claimId);
    // A different attempt for the same task cannot take a second claim.
    assert.throws(() => acquireClaim(f.store, {teamId: t.teamId, attemptId: firstAttempt.attemptId, taskId: second.taskId, scopes: ['docs']}), {code: 'VALIDATION_ERROR'});

    const released = releaseClaim(f.store, firstAttempt.attemptId, 'released');
    assert.equal(released.state, 'released');
    assert.deepEqual(activeClaims(f.store, t.teamId), []);
    // Running attempts are also fenced even without an active claim row.
    assert.deepEqual(claimPreflight(f.store, t.teamId, ['src']), {held: true, cause: 'write-scope', by: {attemptId: firstAttempt.attemptId, taskId: first.taskId, scopes: ['src']}});
    assert.throws(() => releaseClaim(f.store, firstAttempt.attemptId), {code: 'VALIDATION_ERROR'});

    // A race that bypasses the board still fails closed and journals the conflict.
    const racer = createWrite(f.store, t.teamId, ['build']);
    f.store.db.prepare("UPDATE swarm_v2_task_scopes SET scope='src' WHERE task_id=?").run(racer.taskId);
    const racerAttempt = prepareAttempt(f.store, racer.taskId, racer.revision, {memberId: null});
    const conflicted = acquireClaim(f.store, {teamId: t.teamId, attemptId: racerAttempt.attemptId, taskId: racer.taskId, scopes: ['src']});
    assert.equal(conflicted.held, true);
    assert.ok(eventTypes(f.store, t.teamId).includes('workspace.conflict.held'));
    assert.deepEqual(activeClaims(f.store, t.teamId), []);
    assert.equal(second.status, 'blocked');
  } finally { f.cleanup(); }
});

function mkRunning(store: V2Store, attemptId: string): void {
  markAttemptRunning(store, attemptId, {generation: 0, workspaceId: null});
}

// ---------------------------------------------------------------------------
// Rework: closure, quotas, fingerprint
// ---------------------------------------------------------------------------

test('rework applies the downstream closure, appends requirements and enforces quotas and fingerprints', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    setTeamStatus(f.store, t.teamId, 1, 'running');
    const root = createRead(f.store, t.teamId, {title: '根任务', description: '根需求'});
    const middle = createRead(f.store, t.teamId, {title: '中间任务', description: '中间需求', dependencies: [root.taskId]});
    const leaf = createRead(f.store, t.teamId, {title: '叶子任务', description: '叶子需求', dependencies: [middle.taskId]});
    const unrelated = createRead(f.store, t.teamId, {title: '无关任务', description: '无关需求'});
    const receipt = startRework(f.store, t.teamId, [root.taskId], '验收失败：结果不正确');
    assert.deepEqual(receipt.taskIds, [root.taskId]);
    assert.deepEqual(receipt.affected, [leaf.taskId, middle.taskId, root.taskId].sort());
    assert.equal(receipt.reworkRound, 1);
    assert.equal(receipt.fingerprint.length, 64);
    const reworkedRoot = getTask(f.store, root.taskId);
    assert.equal(reworkedRoot.status, 'ready');
    assert.equal(reworkedRoot.reworkCount, 1);
    assert.equal(reworkedRoot.requirementVersion, 2);
    assert.equal(getTask(f.store, middle.taskId).status, 'ready');
    assert.equal(getTask(f.store, leaf.taskId).status, 'ready');
    assert.equal(getTask(f.store, unrelated.taskId).requirementVersion, 1);
    const teamAfter = getTeam(f.store, t.teamId);
    assert.equal(teamAfter.reworkRound, 1);
    assert.deepEqual(teamAfter.failureFingerprints, [receipt.fingerprint]);
    assert.equal(eventTypes(f.store, t.teamId).filter(type => type === 'task.rework_applied').length, 3);
    // Automatic requirement version: the prompt is preserved but marked automatic.
    const requirement = f.store.row<{prompt: string; automatic: number}>('SELECT prompt,automatic FROM swarm_v2_task_requirements WHERE task_id=? AND version=2', root.taskId)!;
    assert.deepEqual([requirement.prompt, Number(requirement.automatic)], ['根需求', 1]);

    // The same failure fingerprint without changes pauses the team and rejects.
    assert.throws(() => startRework(f.store, t.teamId, [root.taskId], '验收失败：结果不正确'), {code: 'BUDGET_EXHAUSTED'});
    assert.equal(getTeam(f.store, t.teamId).status, 'paused');
    assert.equal(getTeam(f.store, t.teamId).reworkRound, 1, 'rejected repeat does not advance rounds');

    // A new change produces a new fingerprint and a second round.
    const current = getTeam(f.store, t.teamId);
    setTeamStatus(f.store, t.teamId, current.revision, 'running');
    const second = startRework(f.store, t.teamId, [root.taskId], '验收失败：结果不正确', {[root.taskId]: '修正后的根需求'});
    assert.equal(second.reworkRound, 2);
    assert.notEqual(second.fingerprint, receipt.fingerprint);
    const changed = f.store.row<{prompt: string; automatic: number}>('SELECT prompt,automatic FROM swarm_v2_task_requirements WHERE task_id=? AND version=3', root.taskId)!;
    assert.deepEqual([changed.prompt, Number(changed.automatic)], ['修正后的根需求', 0]);
    assert.equal(getTask(f.store, root.taskId).reworkCount, 2);

    // Third rework exceeds the per-task quota; a fresh task also exceeds the graph quota.
    assert.equal(getTeam(f.store, t.teamId).status, 'running');
    assert.throws(() => startRework(f.store, t.teamId, [root.taskId], '第三次返工', {[root.taskId]: '第三次需求'}), {code: 'BUDGET_EXHAUSTED'});
    const fresh = createRead(f.store, t.teamId);
    assert.throws(() => startRework(f.store, t.teamId, [fresh.taskId], '图级返工上限'), {code: 'BUDGET_EXHAUSTED'});
  } finally { f.cleanup(); }
});

test('rework terminates a running attempt, releases its claim and allows a fresh attempt', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const writer = createWrite(f.store, t.teamId, ['src']);
    const first = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(first.dispatched.map(item => item.taskId), [writer.taskId]);
    const firstAttemptId = first.dispatched[0]!.attemptId;
    assert.equal(getAttempt(f.store, firstAttemptId).status, 'running');
    assert.equal(activeClaims(f.store, t.teamId).length, 1);

    const receipt = startRework(f.store, t.teamId, [writer.taskId], '返工：实现与验收不符');
    assert.deepEqual(receipt.affected, [writer.taskId]);
    const interrupted = getAttempt(f.store, firstAttemptId);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.terminalReason, 'interrupted');
    assert.deepEqual(activeClaims(f.store, t.teamId), [], 'rework releases the interrupted attempt write claim');
    const ready = getTask(f.store, writer.taskId);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.currentAttemptId, null);
    assert.equal(ready.ownerMemberId, null);
    assert.ok(eventTypes(f.store, t.teamId).includes('attempt.interrupted'));

    const second = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(second.dispatched.map(item => item.taskId), [writer.taskId]);
    const fresh = getAttempt(f.store, second.dispatched[0]!.attemptId);
    assert.equal(fresh.status, 'running');
    assert.equal(fresh.number, 2);
    assert.deepEqual(listAttempts(f.store, t.teamId).map(attempt => attempt.status).sort(), ['failed', 'running']);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// I13: journal is the authority and is written in the same transaction
// ---------------------------------------------------------------------------

test('journal events are appended atomically with state and rolled back with failed transactions', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const before = f.store.events(t.teamId).length;
    const task = createRead(f.store, t.teamId);
    assert.equal(f.store.events(t.teamId).length, before + 1);
    const afterCreate = f.store.events(t.teamId).length;

    assert.throws(() => transitionTask(f.store, task.taskId, 99, 'claim', 'lead'), {code: 'VERSION_CONFLICT'});
    assert.equal(f.store.events(t.teamId).length, afterCreate, 'rejected CAS writes no journal');
    assert.throws(() => updateTask(f.store, task.taskId, afterCreate, {title: 'x'}), {code: 'VERSION_CONFLICT'});
    assert.equal(f.store.events(t.teamId).length, afterCreate);

    // A scheduler callback failure rolls back attempts, claims, team auto-start and journal.
    const scheduled = readyFrontier(f.store, t.teamId);
    assert.equal(scheduled.length, 1);
    assert.equal(getTeam(f.store, t.teamId).status, 'created');
    assert.throws(() => scheduleOnce(f.store, t.teamId, {reserve: () => { throw new Error('budget backend down'); }}), /budget backend down/u);
    assert.equal(f.store.events(t.teamId).length, afterCreate);
    assert.equal(getTask(f.store, task.taskId).status, 'ready');
    assert.equal(getTask(f.store, task.taskId).currentAttemptId, null);
    assert.deepEqual(listAttempts(f.store, t.teamId), []);
    assert.equal(getTeam(f.store, t.teamId).status, 'created');

    // Sequence numbers are contiguous and monotonic for the team.
    const events = f.store.events(t.teamId, 0, 2000);
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1));
    assert.deepEqual(boardActor('lead'), {kind: 'lead', id: 'lead'});
    assert.deepEqual(boardActor('worker-9'), {kind: 'member', id: 'worker-9'});
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Scheduler: deterministic frontier, caps, preflight skip, member assignment
// ---------------------------------------------------------------------------

test('readyFrontier orders by topological depth then creation time and excludes blocked tasks', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    setTeamStatus(f.store, t.teamId, 1, 'running');
    const root = createRead(f.store, t.teamId, {title: 'root'});
    finishReadTask(f.store, root);
    const middle = createRead(f.store, t.teamId, {title: 'middle', dependencies: [root.taskId]});
    const leaf = createRead(f.store, t.teamId, {title: 'leaf', dependencies: [middle.taskId]});
    const independent = createRead(f.store, t.teamId, {title: 'independent'});
    assert.equal(middle.status, 'ready');
    assert.equal(leaf.status, 'blocked');
    setCreated(f.store, middle.taskId, '2026-01-01T00:00:00.000Z');
    setCreated(f.store, independent.taskId, '2026-01-02T00:00:00.000Z');
    setCreated(f.store, leaf.taskId, '2026-01-03T00:00:00.000Z');
    // Depth 0 before depth 1 even though `middle` was created earlier.
    const frontier = readyFrontier(f.store, t.teamId).map(task => task.taskId);
    assert.deepEqual(frontier, [independent.taskId, middle.taskId]);
    assert.ok(!frontier.includes(leaf.taskId));
  } finally { f.cleanup(); }
});

test('scheduleOnce dispatches the deterministic frontier within maxWorkers and reports running count', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const first = createRead(f.store, t.teamId, {title: 'first'});
    const second = createRead(f.store, t.teamId, {title: 'second'});
    const third = createRead(f.store, t.teamId, {title: 'third'});
    setCreated(f.store, first.taskId, '2026-01-01T00:00:00.000Z');
    setCreated(f.store, second.taskId, '2026-01-02T00:00:00.000Z');
    setCreated(f.store, third.taskId, '2026-01-03T00:00:00.000Z');
    assert.deepEqual(runningAttempts(f.store, t.teamId), []);
    const result = scheduleOnce(f.store, t.teamId, {maxWorkers: 2});
    assert.deepEqual(result.dispatched.map(item => item.taskId), [first.taskId, second.taskId]);
    assert.deepEqual(result.blocked, []);
    assert.equal(result.running, 2);
    assert.equal(result.exhausted, false);
    assert.equal(getTeam(f.store, t.teamId).status, 'running', 'created team auto-starts');
    for (const dispatched of result.dispatched) {
      const attempt = getAttempt(f.store, dispatched.attemptId);
      assert.equal(attempt.status, 'running');
      assert.equal(getTask(f.store, dispatched.taskId).status, 'in_progress');
    }
    assert.deepEqual(runningAttempts(f.store, t.teamId).map(attempt => attempt.taskId), [first.taskId, second.taskId]);
    const saturated = scheduleOnce(f.store, t.teamId, {maxWorkers: 2});
    assert.deepEqual(saturated.dispatched, []);
    assert.equal(saturated.running, 2);
    const failed = failAttempt(f.store, result.dispatched[0]!.attemptId, {reason: '工具失败'});
    assert.equal(failed.status, 'failed');
    const next = scheduleOnce(f.store, t.teamId, {maxWorkers: 2});
    assert.deepEqual(next.dispatched.map(item => item.taskId), [third.taskId]);
    assert.equal(next.running, 2);
    assert.throws(() => scheduleOnce(f.store, t.teamId, {maxWorkers: 0}), {code: 'VALIDATION_ERROR'});
    assert.throws(() => scheduleOnce(f.store, t.teamId, {maxWorkers: 17}), {code: 'VALIDATION_ERROR'});
  } finally { f.cleanup(); }
});

test('scheduleOnce skips a write preflight conflict and still dispatches independent tasks', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const writer = createWrite(f.store, t.teamId, ['src']);
    const dependentWriter = createWrite(f.store, t.teamId, ['src'], {title: '后续写任务', dependencies: [writer.taskId]});
    assert.equal(dependentWriter.status, 'blocked');
    const reader = createRead(f.store, t.teamId, {title: '独立只读'});
    setCreated(f.store, writer.taskId, '2026-01-01T00:00:00.000Z');
    setCreated(f.store, dependentWriter.taskId, '2026-01-02T00:00:00.000Z');
    setCreated(f.store, reader.taskId, '2026-01-03T00:00:00.000Z');
    const first = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(first.dispatched.map(item => item.taskId), [writer.taskId, reader.taskId]);
    assert.ok(first.dispatched.find(item => item.taskId === writer.taskId)!.writeClaimId);
    // Finish the writer attempt, but leave its claim active to simulate a crashed service.
    const writerAttempt = first.dispatched.find(item => item.taskId === writer.taskId)!;
    completeAttempt(f.store, writerAttempt.attemptId, {summary: '写完成'});
    for (const action of ['verify', 'complete']) {
      const task = getTask(f.store, writer.taskId);
      transitionTask(f.store, task.taskId, task.revision, action, 'lead');
    }
    assert.equal(getTask(f.store, writer.taskId).status, 'done');
    const blockedWriter = getTask(f.store, dependentWriter.taskId);
    assert.equal(blockedWriter.status, 'blocked');
    transitionTask(f.store, dependentWriter.taskId, blockedWriter.revision, 'unblock', 'lead');
    assert.equal(getTask(f.store, dependentWriter.taskId).status, 'ready');
    const blockedResult = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(blockedResult.dispatched, []);
    assert.deepEqual(blockedResult.blocked, [{taskId: dependentWriter.taskId, reason: {kind: 'resource', cause: 'write-scope', by: writerAttempt.attemptId}}]);
    releaseClaim(f.store, writerAttempt.attemptId, 'released');
    const unblocked = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(unblocked.dispatched.map(item => item.taskId), [dependentWriter.taskId]);
    assert.ok(unblocked.dispatched[0]!.writeClaimId);
    assert.deepEqual(claimPreflight(f.store, t.teamId, ['src'], {attemptId: unblocked.dispatched[0]!.attemptId}), {held: false});
  } finally { f.cleanup(); }
});

test('budget reserve hook blocks only the affected task and a paused team reports exhausted', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    const budgeted = createRead(f.store, t.teamId, {title: 'budgeted'});
    const free = createRead(f.store, t.teamId, {title: 'free'});
    setCreated(f.store, budgeted.taskId, '2026-01-01T00:00:00.000Z');
    setCreated(f.store, free.taskId, '2026-01-02T00:00:00.000Z');
    const calls: string[] = [];
    const result = scheduleOnce(f.store, t.teamId, {
      maxWorkers: 4,
      reserve: task => { calls.push(task.taskId); return task.taskId === budgeted.taskId ? null : {tokens: 1, costMicros: 0}; },
    });
    assert.deepEqual(calls, [budgeted.taskId, free.taskId]);
    assert.deepEqual(result.dispatched.map(item => item.taskId), [free.taskId]);
    assert.deepEqual(result.blocked, [{taskId: budgeted.taskId, reason: {kind: 'budget', cause: '预算预留失败'}}]);
    const paused = getTeam(f.store, t.teamId);
    setTeamStatus(f.store, t.teamId, paused.revision, 'paused');
    const afterPause = scheduleOnce(f.store, t.teamId, {maxWorkers: 4});
    assert.deepEqual(afterPause.dispatched, []);
    assert.equal(afterPause.exhausted, true);
  } finally { f.cleanup(); }
});

test('memberIdForTask assigns prepared attempt/task owners and validates member existence and role', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    addMember(f.store, t.teamId, 'worker-1');
    addMember(f.store, t.teamId, 'reviewer-1', 'reviewer');
    const first = createRead(f.store, t.teamId, {title: 'assigned'});
    const second = createRead(f.store, t.teamId, {title: 'fallback'});
    setCreated(f.store, first.taskId, '2026-01-01T00:00:00.000Z');
    setCreated(f.store, second.taskId, '2026-01-02T00:00:00.000Z');
    assert.throws(() => scheduleOnce(f.store, t.teamId, {memberIdForTask: {[second.taskId]: 'reviewer-1'}}), /角色/u);
    assert.deepEqual(listAttempts(f.store, t.teamId), [], 'invalid assignment rolls back the whole call');
    assert.throws(() => scheduleOnce(f.store, t.teamId, {memberIdForTask: {[second.taskId]: 'missing-member'}}), /不存在/u);
    const result = scheduleOnce(f.store, t.teamId, {maxWorkers: 4, memberIdForTask: {[first.taskId]: 'worker-1'}});
    assert.deepEqual(result.dispatched.map(item => item.taskId), [first.taskId, second.taskId]);
    assert.deepEqual(result.dispatched.map(item => item.memberId), ['worker-1', null]);
    const attempt = getAttempt(f.store, result.dispatched.find(item => item.taskId === first.taskId)!.attemptId);
    assert.equal(attempt.memberId, 'worker-1');
    assert.equal(getTask(f.store, first.taskId).ownerMemberId, 'worker-1');
    assert.equal(getTask(f.store, second.taskId).ownerMemberId, null);
  } finally { f.cleanup(); }
});

test('scheduler rejects non-active members and records the member real generation', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    addMember(f.store, t.teamId, 'provisioning-1', 'worker', 'provisioning');
    const task = createRead(f.store, t.teamId);
    assert.throws(() => scheduleOnce(f.store, t.teamId, {memberIdForTask: {[task.taskId]: 'provisioning-1'}}), /尚未就绪|provisioning/u);
    assert.deepEqual(listAttempts(f.store, t.teamId), []);
    assert.equal(getTeam(f.store, t.teamId).status, 'created', 'failed member validation rolls the whole call back');

    addMember(f.store, t.teamId, 'worker-gen', 'worker', 'active', 7);
    const result = scheduleOnce(f.store, t.teamId, {memberIdForTask: {[task.taskId]: 'worker-gen'}});
    assert.deepEqual(result.dispatched.map(item => item.taskId), [task.taskId]);
    const attempt = getAttempt(f.store, result.dispatched[0]!.attemptId);
    assert.equal(attempt.memberId, 'worker-gen');
    assert.equal(attempt.generation, 7);
    assert.equal(getTask(f.store, task.taskId).ownerMemberId, 'worker-gen');
  } finally { f.cleanup(); }
});

test('scheduleOnce caps workers at 16 and leaves undiminished ready tasks in place', () => {
  const f = fixture();
  try {
    const t = team(f.store);
    for (let index = 0; index < 5; index++) createRead(f.store, t.teamId, {title: `task-${index}`});
    const result = scheduleOnce(f.store, t.teamId);
    assert.equal(result.dispatched.length, 4, 'default call dispatches at most DEFAULT_MAX_WORKERS');
    assert.equal(result.running, 4);
    assert.equal(readyFrontier(f.store, t.teamId).length, 1, 'the fifth task stays ready');
  } finally { f.cleanup(); }
});
