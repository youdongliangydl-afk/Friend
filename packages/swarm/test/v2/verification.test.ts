import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityError, RecordStore, digest } from '@friend-pi/core';
import { MERGE_GATE_CODES, V2Store } from '../../src/v2/store.js';
import { createBudget } from '../../src/v2/budget.js';
import {
  CHECK_KINDS, applyVerdict, assertNoSilentMerge, evaluateMergeGates, integrateTask,
  recordChecks, requiredVerdictKinds, requiredVerdictReviewers, runChecks, startVerification,
  submitVerdict, verificationStatusFor,
  type MergeGateInput, type SwarmV2CheckSpec, type SubmitVerdictInput,
} from '../../src/v2/verification.js';
import type { SwarmV2CheckResult, SwarmV2Risk, SwarmV2Verdict, SwarmV2Verification } from '../../src/v2/types.js';

const CANDIDATE = 'candidate-digest-1';
const TIP = 'tip-1';
const BASE = 'base-1';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface FixtureOptions {
  risk?: SwarmV2Risk;
  mode?: 'read' | 'write';
  status?: string;
  resultRevision?: number;
  candidateTip?: string | null;
  baseRev?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
  writeScopes?: string[];
}

function fixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-v2-verification-'));
  const recordStore = new RecordStore('swarm', dir);
  const store = V2Store.open(recordStore);
  const now = iso();
  const risk = options.risk ?? 'V1';
  const mode = options.mode ?? 'write';
  const status = options.status ?? 'delivered';
  const resultRevision = options.resultRevision ?? 1;
  const scopes = options.writeScopes ?? (mode === 'write' ? ['src'] : []);
  store.db.prepare(`INSERT INTO swarm_v2_teams(team_id,project_id,root_session_id,workspace_root,status,autonomy_level,policy_json,revision,rework_round,failure_fingerprints_json,created_at,updated_at)
    VALUES('t1','p1','s1',?,'running',1,'{}',1,0,'[]',?,?)`).run(dir, now, now);
  const insertMember = (memberId: string, role: string, sessionId: string) => {
    store.db.prepare(`INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,generation,phase,status,capability_json,write_scopes_json,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,'fresh',1,'active','idle','{}','[]',1,?,?)`).run(memberId, 't1', memberId, `/team/${memberId}`, role, now, now);
    store.db.prepare('UPDATE swarm_v2_members SET session_id=? WHERE member_id=?').run(sessionId, memberId);
  };
  insertMember('l1', 'lead', 'lead-session');
  insertMember('w1', 'worker', 'author-session');
  insertMember('r1', 'reviewer', 'review-session-1');
  insertMember('r2', 'reviewer', 'review-session-2');
  insertMember('v1', 'verifier', 'verify-session-1');
  const insertTask = (input: { taskId: string; status?: string; mode?: 'read' | 'write'; taskRisk?: SwarmV2Risk; resultRevision?: number; acceptance?: string[] }) => {
    const taskMode = input.mode ?? 'write';
    store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,owner_member_id,current_attempt_id,logical_step_id,result_revision,result_artifact_ids_json,rework_count,requirement_version,acceptance_json,checks_ref,workspace_policy,blocked_reason_json,created_by,created_at,updated_at,deleted_at,tombstone)
      VALUES(?,? ,1,?,?,?,?,?,?,?,?,?,'[]',0,1,?,NULL,'worktree',NULL,'lead-1',?,?,NULL,0)`)
      .run(input.taskId, 't1', input.taskId, input.taskId, taskMode, input.taskRisk ?? 'V1', input.status ?? 'ready', null, null, input.taskId, input.resultRevision ?? 0, JSON.stringify(input.acceptance ?? ['works']), now, now);
    for (const scope of taskMode === 'write' ? ['src'] : []) store.db.prepare('INSERT OR IGNORE INTO swarm_v2_task_scopes(task_id,scope) VALUES(?,?)').run(input.taskId, scope);
  };
  insertTask({ taskId: 'dep-read', mode: 'read', status: 'done' });
  insertTask({ taskId: 'dep-write', mode: 'write', status: 'ready' });
  store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,owner_member_id,current_attempt_id,logical_step_id,result_revision,result_artifact_ids_json,rework_count,requirement_version,acceptance_json,checks_ref,workspace_policy,blocked_reason_json,created_by,created_at,updated_at,deleted_at,tombstone)
    VALUES('task-1','t1',1,'task','task',?,?,'delivered','w1','a1','task-1',?, '[]',0,1,'["works"]',NULL,'worktree',NULL,'lead-1',?,?,NULL,0)`)
    .run(mode, risk, resultRevision, now, now);
  for (const scope of scopes) store.db.prepare('INSERT OR IGNORE INTO swarm_v2_task_scopes(task_id,scope) VALUES(?,?)').run('task-1', scope);
  store.db.prepare('UPDATE swarm_v2_tasks SET status=? WHERE task_id=?').run(status, 'task-1');
  const attemptId = 'a1';
  store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,workspace_id,base_rev,deps_digest,requirement_version,budget_reservation_id,started_at,finished_at,terminal_reason,summary,session_id,session_file,commit_sha,result_digest,candidate_tip,evidence_refs_json)
    VALUES(?,'task-1',1,'completed','w1',1,?,?,NULL,1,NULL,?,?,NULL,'done',?,NULL,NULL,NULL,?, '[]')`)
    .run(attemptId, options.workspaceId === undefined ? 'ws1' : options.workspaceId, options.baseRev === undefined ? BASE : options.baseRev, now, now, options.sessionId === undefined ? 'author-session' : options.sessionId, options.candidateTip === undefined ? TIP : options.candidateTip);
  store.db.prepare(`INSERT INTO swarm_v2_workspaces(workspace_id,team_id,attempt_id,member_id,kind,path,branch,base_commit,state,lease_owner,lease_expires_at,created_at,released_at)
    VALUES('ws1','t1','a1','w1','worktree',?,'swarm/task-1',?,'active','w1',NULL,?,NULL)`).run(dir, BASE, now);
  const helper = {
    dir, store, recordStore, risk,
    get resultRevision(): number { return Number(store.row<{ result_revision: number }>('SELECT result_revision FROM swarm_v2_tasks WHERE task_id=?', 'task-1')!.result_revision); },
    close() { recordStore.close(); rmSync(dir, { recursive: true, force: true }); },
    sql(sql: string, ...args: (string | number | null)[]) { store.db.prepare(sql).run(...args); },
    journalTypes(): string[] { return store.rows<{ type: string }>('SELECT type FROM swarm_v2_journal WHERE team_id=? ORDER BY seq', 't1').map(row => String(row.type)); },
    journalCount(): number { return Number(store.row<{ n: number }>('SELECT COUNT(*) AS n FROM swarm_v2_journal WHERE team_id=?', 't1')!.n); },
    addBudget(tokenLimit: number | null = 1_000_000, costLimit: number | null = 100_000_000) { return createBudget(store, { teamId: 't1', scope: 'team', scopeId: 't1', tokenLimit, costLimitMicros: costLimit }); },
    addDependency(depTaskId: string, options: { mode?: 'read' | 'write'; status?: string; commitSha?: string | null } = {}) {
      const depMode = options.mode ?? 'write';
      const depStatus = options.status ?? 'done';
      if (!store.row('SELECT 1 AS n FROM swarm_v2_tasks WHERE task_id=?', depTaskId)) {
        store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,logical_step_id,result_revision,result_artifact_ids_json,rework_count,requirement_version,acceptance_json,created_by,created_at,updated_at,tombstone)
          VALUES(?, 't1',1,?,?,?, 'V1', ?, ?,0,'[]',0,1,'["works"]','lead-1',?,?,0)`).run(depTaskId, depTaskId, depTaskId, depMode, depStatus, depTaskId, now, now);
      } else {
        store.db.prepare('UPDATE swarm_v2_tasks SET mode=?,status=? WHERE task_id=?').run(depMode, depStatus, depTaskId);
      }
      store.db.prepare('INSERT OR IGNORE INTO swarm_v2_task_dependencies(task_id,depends_on) VALUES(?,?)').run('task-1', depTaskId);
      if (options.commitSha) {
        store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,workspace_id,base_rev,requirement_version,started_at,finished_at,commit_sha,candidate_tip,evidence_refs_json)
          VALUES(?,?,1,'completed','w1',1,NULL,?,1,?,?,?,'dep-tip','[]')`).run(`attempt-${depTaskId}`, depTaskId, BASE, now, now, options.commitSha);
      }
      return depTaskId;
    },
    insertRunningAttempt(attemptId = 'a-running', number = 2) {
      store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,requirement_version,started_at,evidence_refs_json)
        VALUES(?,'task-1',?,'running','w2',1,1,?,'[]')`).run(attemptId, number, now);
    },
    insertUnknownAttempt(attemptId = 'a-unknown', number = 3) {
      store.db.prepare(`INSERT INTO swarm_v2_attempts(attempt_id,task_id,number,status,member_id,generation,requirement_version,started_at,evidence_refs_json)
        VALUES(?,'task-1',?,'unknown','w2',1,1,?,'[]')`).run(attemptId, number, now);
    },
    insertReceipt(row: { taskId: string; status: string; verdictId?: string | null; candidateDigest?: string }) {
      store.db.prepare(`INSERT INTO swarm_v2_apply_receipts(task_id,team_id,operation_id,status,files_json,candidate_digest,verdict_id,baseline_digest,applied_at)
        VALUES(?,'t1',?,?,'[]',?,?,NULL,?)`).run(row.taskId, `op-${row.taskId}`, row.status, row.candidateDigest ?? CANDIDATE, row.verdictId ?? null, now);
    },
    insertClaim(attemptId: string, scopes: string[], taskId = 'other-task') {
      store.db.prepare(`INSERT INTO swarm_v2_write_claims(claim_id,team_id,attempt_id,task_id,member_id,scopes_json,state,acquired_at,released_at)
        VALUES(?,'t1',?,?,'w2',?,'active',?,NULL)`).run(`claim-${attemptId}`, attemptId, taskId, JSON.stringify(scopes), now);
    },
    insertVerdict(verificationId: string, overrides: Partial<{ kind: string; approved: number; binding: string; resultVersions: Record<string, number>; reviewerMemberId: string; sessionId: string }> = {}) {
      const verdictId = `verdict-${verificationId}-${overrides.kind ?? 'reviewer'}-${Math.random().toString(16).slice(2, 8)}`;
      store.db.prepare(`INSERT INTO swarm_v2_verdicts(verdict_id,verification_id,team_id,task_id,kind,approved,findings_json,task_ids_json,result_versions_json,candidate_digest,reviewed_tip,binding,reviewer_member_id,session_id,session_file,sealed,created_at)
        VALUES(?,?,'t1','task-1',?,?, '[]','["task-1"]',?,?,?,?,?,?,NULL,1,?)`)
        .run(verdictId, verificationId, overrides.kind ?? 'reviewer', overrides.approved ?? 1, JSON.stringify(overrides.resultVersions ?? { 'task-1': 1 }), CANDIDATE, TIP, overrides.binding ?? 'exact-tip', overrides.reviewerMemberId ?? 'r1', overrides.sessionId ?? 'review-session-1', now);
      return verdictId;
    },
    checks(checks?: SwarmV2CheckSpec[], files?: Record<string, unknown>): SwarmV2CheckResult[] {
      return runChecks(store, {
        teamId: 't1', taskId: 'task-1',
        checks: checks ?? [{ checkId: 'check-1', kind: 'file.exists', path: 'src/a.ts' }],
        files: files ?? { 'src/a.ts': 'export const a = 1;' },
      });
    },
    start(level: SwarmV2Risk = risk, candidateDigest = CANDIDATE): SwarmV2Verification {
      return startVerification(store, { teamId: 't1', taskId: 'task-1', candidateDigest, level });
    },
    /** complete the objective-check stage, leaving the verification in reviewing */
    checkPass(level: SwarmV2Risk = risk): SwarmV2Verification {
      const verification = helper.start(level);
      const reviewing = recordChecks(store, verification.verificationId, helper.checks());
      assert.equal(reviewing.status, 'reviewing');
      return reviewing;
    },
    submit(verificationId: string, kind: 'reviewer' | 'verifier', reviewerMemberId: string, overrides: Partial<SubmitVerdictInput> = {}): SwarmV2Verdict {
      const sessionId = kind === 'verifier' ? 'verify-session-1' : reviewerMemberId === 'r2' ? 'review-session-2' : 'review-session-1';
      return submitVerdict(store, {
        verificationId, kind, reviewerMemberId, sessionId, approved: true, findings: ['ok'],
        taskIds: ['task-1'], resultVersions: { 'task-1': helper.resultRevision }, candidateDigest: CANDIDATE,
        reviewedTip: TIP, ...overrides,
      });
    },
    submitAll(level: SwarmV2Risk = risk, verificationId: string): SwarmV2Verdict[] {
      const verdicts = [helper.submit(verificationId, 'reviewer', 'r1')];
      if (level === 'V2' || level === 'V3') verdicts.push(helper.submit(verificationId, 'verifier', 'v1'));
      if (level === 'V3') verdicts.push(helper.submit(verificationId, 'reviewer', 'r2'));
      return verdicts;
    },
    gateInput(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
      return {
        taskId: 'task-1', candidateDigest: CANDIDATE,
        targetBase: BASE, targetHead: BASE, workspaceClean: true,
        changedPaths: ['src/a.ts'], protectedPaths: [], humanApproval: true,
        ...overrides,
      };
    },
    /** Full happy path: checks -> verdicts -> apply -> team budget. Returns the sealed verdict and gate input. */
    approved(level: SwarmV2Risk = risk) {
      const verification = helper.checkPass(level);
      const verdicts = helper.submitAll(level, verification.verificationId);
      const applied = applyVerdict(store, verdicts.at(-1)!.verdictId);
      assert.equal(applied.status, 'passed');
      helper.addBudget();
      return { verification, verdicts, verdict: verdicts.at(-1)!, gate: helper.gateInput(), applied };
    },
    gates(overrides: Partial<MergeGateInput> = {}) {
      return evaluateMergeGates(store, helper.gateInput(overrides));
    },
  };
  return helper;
}

function gateOf(decision: { gates: { code: string; passed: boolean; detail: string }[] }, code: string) {
  assert.equal(decision.gates.length, MERGE_GATE_CODES.length);
  assert.deepEqual(decision.gates.map(item => item.code), [...MERGE_GATE_CODES]);
  const item = decision.gates.find(entry => entry.code === code);
  assert.ok(item, `${code} missing`);
  return item!;
}

function expectGate(decision: { gates: { code: string; passed: boolean; detail: string }[]; allowed: boolean }, code: string, passed: boolean, pattern?: RegExp) {
  const item = gateOf(decision, code);
  assert.equal(item.passed, passed, `${code}: ${item.detail}`);
  if (pattern) assert.match(item.detail, pattern);
  return decision;
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, String(error));
    assert.equal((error as CapabilityError).code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Check registry
// ---------------------------------------------------------------------------

test('CHECK_KINDS exposes exactly the five registered deterministic checks', () => {
  assert.deepEqual([...CHECK_KINDS], ['file.exists', 'file.hash', 'json.schema', 'source.coverage', 'command.exit']);
});

test('file.exists passes from files/artifacts maps and writes evidence rows', () => {
  const f = fixture();
  try {
    const results = f.checks([{ checkId: 'c1', kind: 'file.exists', path: 'src/a.ts' }], { 'src/a.ts': 'content' });
    assert.equal(results.length, 1);
    assert.ok(results.every(result => result.passed === true && result.kind === 'file.exists'));
    assert.match(results[0]!.evidenceRef!, /^[0-9a-f-]{36}$/u);
    assert.equal(f.store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM swarm_v2_evidence WHERE kind='check'")[0]!.n, 1);
    assert.equal(f.store.row<{ digest: string }>('SELECT digest FROM swarm_v2_evidence WHERE ref=?', 'c1')!.digest.length, 64);
    const artifact = runChecks(f.store, { teamId: 't1', checks: [{ checkId: 'c3', kind: 'file.exists', path: 'artifact.md' }], artifacts: { artifact: { path: 'artifact.md' } } });
    assert.equal(artifact[0]!.passed, true);
    const missing = runChecks(f.store, { teamId: 't1', checks: [{ checkId: 'c4', kind: 'file.exists', path: 'missing.ts' }] });
    assert.equal(missing[0]!.passed, false);
    assert.match(missing[0]!.detail!, /缺失/u);
  } finally { f.close(); }
});

test('file.hash matches sha256 digests and accepts the sha256: prefix', () => {
  const f = fixture();
  try {
    const content = 'export const a = 1;';
    const expected = digest(content);
    const results = f.checks([
      { checkId: 'h1', kind: 'file.hash', path: 'src/a.ts', expected },
      { checkId: 'h2', kind: 'file.hash', path: 'src/a.ts', expected: `sha256:${expected.toUpperCase()}` },
      { checkId: 'h3', kind: 'file.hash', path: 'src/a.ts', expected: digest('other') },
    ]);
    assert.deepEqual(results.map(result => result.passed), [true, true, false]);
    assert.match(results[2]!.detail!, /摘要不匹配/u);
    expectCode('VALIDATION_ERROR', () => f.checks([{ checkId: 'h4', kind: 'file.hash', path: 'src/a.ts', expected: 'short' }]));
  } finally { f.close(); }
});

test('json.schema validates required keys (including dotted paths) and rejects invalid JSON', () => {
  const f = fixture();
  try {
    const files = { 'data.json': JSON.stringify({ a: 1, nested: { b: 2 } }), 'bad.json': '{nope' };
    const [ok, missing, nested, invalid] = f.checks([
      { checkId: 'j1', kind: 'json.schema', path: 'data.json', requiredKeys: ['a', 'nested'] },
      { checkId: 'j2', kind: 'json.schema', path: 'data.json', requiredKeys: ['missing'] },
      { checkId: 'j3', kind: 'json.schema', path: 'data.json', requiredKeys: ['nested.b'] },
      { checkId: 'j4', kind: 'json.schema', path: 'bad.json', requiredKeys: ['a'] },
    ], files);
    assert.deepEqual([ok, missing, nested, invalid].map(result => result!.passed), [true, false, true, false]);
    expectCode('VALIDATION_ERROR', () => f.checks([{ checkId: 'j5', kind: 'json.schema', path: 'data.json', requiredKeys: [] }]));
    const inline = runChecks(f.store, { teamId: 't1', checks: [{ checkId: 'j6', kind: 'json.schema', data: { x: 1 }, requiredKeys: ['x'] }] });
    assert.equal(inline[0]!.passed, true);
  } finally { f.close(); }
});

test('source.coverage requires declared sources and claim coverage', () => {
  const f = fixture();
  try {
    const results = f.checks([
      { checkId: 's1', kind: 'source.coverage', sourceIds: ['src-1', 'src-2'], requiredSourceIds: ['src-1'], claims: [{ claim: 'claim-a', sourceIds: ['src-1'] }, 'claim-b'], claimSources: { 'claim-b': ['src-2'] } },
      { checkId: 's2', kind: 'source.coverage', sourceIds: [] },
      { checkId: 's3', kind: 'source.coverage', sourceIds: ['src-1'], requiredSourceIds: ['src-9'] },
      { checkId: 's4', kind: 'source.coverage', sourceIds: ['src-1'], claims: ['uncovered'] },
      { checkId: 's5', kind: 'source.coverage', sourceIds: ['src-1'], claims: [{ claim: 'x', sourceIds: ['src-9'] }] },
    ]);
    assert.deepEqual(results.map(result => result.passed), [true, false, false, false, false]);
    assert.match(results[3]!.detail!, /缺少来源映射/u);
  } finally { f.close(); }
});

test('command.exit only consumes a caller result and never executes a command', () => {
  const f = fixture();
  const marker = join(f.dir, 'must-not-exist');
  try {
    const results = f.checks([
      { checkId: 'e1', kind: 'command.exit', command: `touch ${marker}`, result: { exitCode: 0, stdout: 'ok' } },
      { checkId: 'e2', kind: 'command.exit', command: `touch ${marker}`, result: { exitCode: 2, stderr: 'boom' } },
      { checkId: 'e3', kind: 'command.exit', command: `touch ${marker}` },
      { checkId: 'e4', kind: 'command.exit', result: { exitCode: 7 }, expectedExitCode: 7 },
    ]);
    assert.deepEqual(results.map(result => result.passed), [true, false, false, true]);
    assert.equal(results[0]!.exitCode, 0);
    assert.equal(results[1]!.exitCode, 2);
    assert.match(results[2]!.detail!, /不执行命令/u);
    assert.match(results[1]!.detail!, /stderr=boom/u);
    assert.equal(existsSync(marker), false);
    const viaExecutor = runChecks(f.store, { teamId: 't1', checks: [{ checkId: 'e5', kind: 'command.exit' }], executor: () => ({ exitCode: 0 }) });
    assert.equal(viaExecutor[0]!.passed, true);
    const executorError = runChecks(f.store, { teamId: 't1', checks: [{ checkId: 'e6', kind: 'command.exit' }], executor: () => { throw new Error('not captured'); } });
    assert.equal(executorError[0]!.passed, false);
  } finally { f.close(); }
});

test('unknown check kinds fail closed, results keep declaration order and evidence is always persisted', () => {
  const f = fixture();
  try {
    const results = f.checks([{ checkId: 'u1', kind: 'http.status' }, { checkId: 'u2', kind: 'file.exists', path: 'src/a.ts' }]);
    assert.deepEqual(results.map(result => [result.checkId, result.passed]), [['u1', false], ['u2', true]]);
    assert.match(results[0]!.detail!, /未知检查类型/u);
    assert.equal(f.store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM swarm_v2_evidence WHERE kind='check'")[0]!.n, 2);
    expectCode('VALIDATION_ERROR', () => runChecks(f.store, { teamId: 'missing', checks: [] }));
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// startVerification / recordChecks
// ---------------------------------------------------------------------------

test('startVerification requires a delivered task and a valid level', () => {
  const ready = fixture({ status: 'ready' });
  try { expectCode('VALIDATION_ERROR', () => ready.start()); } finally { ready.close(); }
  const verified = fixture({ status: 'verified' });
  try { expectCode('VALIDATION_ERROR', () => verified.start()); } finally { verified.close(); }
  const f = fixture();
  try {
    expectCode('VALIDATION_ERROR', () => f.start('V9' as SwarmV2Risk));
    expectCode('VALIDATION_ERROR', () => startVerification(f.store, { teamId: 't1', taskId: 'task-1', candidateDigest: '', level: 'V1' }));
    expectCode('VALIDATION_ERROR', () => startVerification(f.store, { teamId: 't1', taskId: 'missing', candidateDigest: CANDIDATE, level: 'V1' }));
  } finally { f.close(); }
});

test('startVerification creates a checking record with contract digest and journal', () => {
  const f = fixture();
  try {
    const verification = f.start();
    assert.equal(verification.status, 'checking');
    assert.equal(verification.teamId, 't1');
    assert.equal(verification.taskId, 'task-1');
    assert.equal(verification.attemptId, 'a1');
    assert.equal(verification.candidateDigest, CANDIDATE);
    assert.equal(verification.level, 'V1');
    assert.match(verification.contractDigest, /^[0-9a-f]{64}$/u);
    assert.deepEqual(verification.checks, []);
    assert.ok(f.journalTypes().includes('verification.started'));
  } finally { f.close(); }
});

test('startVerification reuses the verification for the same candidate and creates a new one for a different candidate', () => {
  const f = fixture();
  try {
    const first = f.start();
    const again = f.start();
    assert.equal(again.verificationId, first.verificationId);
    assert.equal(f.store.rows<{ n: number }>('SELECT COUNT(*) AS n FROM swarm_v2_verifications')[0]!.n, 1);
    const other = f.start('V1', 'candidate-digest-2');
    assert.notEqual(other.verificationId, first.verificationId);
    expectCode('VALIDATION_ERROR', () => startVerification(f.store, { teamId: 't1', taskId: 'task-1', candidateDigest: 'cand', level: 'V1', attemptId: 'missing' }));
  } finally { f.close(); }
});

test('recordChecks passes to reviewing, failure to failed and keeps concrete check rows', () => {
  const f = fixture();
  try {
    const verification = f.start();
    const reviewing = recordChecks(f.store, verification.verificationId, f.checks());
    assert.equal(reviewing.status, 'reviewing');
    assert.equal(reviewing.checks.length, 1);
    assert.equal(reviewing.checks[0]!.checkId, 'check-1');
    assert.ok(f.journalTypes().includes('verification.checked'));
    const failed = recordChecks(f.store, verification.verificationId, [{ checkId: 'check-2', kind: 'command.exit', passed: false, detail: 'exit 1' }]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.checks.length, 2);
  } finally { f.close(); }
});

test('recordChecks replaces a checkId in place and recomputes status from the merged set', () => {
  const f = fixture();
  try {
    const verification = f.start();
    recordChecks(f.store, verification.verificationId, [{ checkId: 'c1', kind: 'file.exists', passed: false }]);
    const replaced = recordChecks(f.store, verification.verificationId, [{ checkId: 'c1', kind: 'file.exists', passed: true }]);
    assert.equal(replaced.status, 'reviewing');
    assert.equal(replaced.checks.length, 1);
    assert.equal(replaced.checks[0]!.passed, true);
  } finally { f.close(); }
});

test('recordChecks rejects terminal verification states and malformed results', () => {
  const f = fixture();
  try {
    const terminal = f.start();
    f.sql("UPDATE swarm_v2_verifications SET status='passed' WHERE verification_id=?", terminal.verificationId);
    expectCode('VERSION_CONFLICT', () => recordChecks(f.store, terminal.verificationId, [{ checkId: 'c9', kind: 'file.exists', passed: true }]));
    const fresh = f.start('V1', 'candidate-digest-3');
    expectCode('VALIDATION_ERROR', () => recordChecks(f.store, fresh.verificationId, [{ checkId: 'c', kind: 'file.exists' } as unknown as SwarmV2CheckResult]));
    expectCode('VALIDATION_ERROR', () => recordChecks(f.store, 'missing', []));
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// submitVerdict
// ---------------------------------------------------------------------------

test('submitVerdict stores a sealed exact-tip verdict and journals verdict.recorded', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    const verdict = f.submit(verification.verificationId, 'reviewer', 'r1');
    assert.equal(verdict.kind, 'reviewer');
    assert.equal(verdict.approved, true);
    assert.equal(verdict.binding, 'exact-tip');
    assert.equal(verdict.reviewedTip, TIP);
    assert.equal(verdict.sealed, true);
    assert.equal(verdict.reviewerMemberId, 'r1');
    assert.deepEqual(verdict.taskIds, ['task-1']);
    assert.deepEqual(verdict.resultVersions, { 'task-1': 1 });
    assert.equal(f.store.row<{ sealed: number }>('SELECT sealed FROM swarm_v2_verdicts WHERE verdict_id=?', verdict.verdictId)!.sealed, 1);
    assert.ok(f.journalTypes().includes('verdict.recorded'));
  } finally { f.close(); }
});

test('reviewer independence rejects the author, the task owner, wrong roles and shared sessions', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'w1'));
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'verifier', 'r1'));
    f.sql("UPDATE swarm_v2_tasks SET owner_member_id='r1' WHERE task_id='task-1'");
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'r1'));
    f.sql("UPDATE swarm_v2_tasks SET owner_member_id='w1' WHERE task_id='task-1'");
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'author-session' }));
  } finally { f.close(); }
});

test('reviewer independence rejects a reviewer that authored the attempt', () => {
  const f = fixture();
  try {
    f.sql("UPDATE swarm_v2_attempts SET member_id='r1' WHERE attempt_id='a1'");
    const verification = f.checkPass();
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'r1'));
  } finally { f.close(); }
});

test('a stale reviewed tip is rejected, journaled and never stored as a verdict', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    expectCode('STALE_TIP', () => f.submit(verification.verificationId, 'reviewer', 'r1', { reviewedTip: 'old-tip' }));
    assert.equal(f.store.rows<{ n: number }>('SELECT COUNT(*) AS n FROM swarm_v2_verdicts')[0]!.n, 0);
    assert.ok(f.journalTypes().includes('verdict.stale_rejected'));
    const accepted = f.submit(verification.verificationId, 'reviewer', 'r1');
    assert.equal(accepted.binding, 'exact-tip');
  } finally { f.close(); }
});

test('clean-rebase waiver requires a prior stale rejection and a matching tip', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { binding: 'clean-rebase-waived' }));
    expectCode('STALE_TIP', () => f.submit(verification.verificationId, 'reviewer', 'r1', { reviewedTip: 'old-tip' }));
    const waived = f.submit(verification.verificationId, 'reviewer', 'r1', { binding: 'clean-rebase-waived' });
    assert.equal(waived.binding, 'clean-rebase-waived');
  } finally { f.close(); }
});

test('submitVerdict rejects verification in the wrong state and duplicate same-kind submissions', () => {
  const checking = fixture();
  try {
    const verification = checking.start();
    expectCode('VALIDATION_ERROR', () => checking.submit(verification.verificationId, 'reviewer', 'r1'));
    recordChecks(checking.store, verification.verificationId, [{ checkId: 'c', kind: 'file.exists', passed: false }]);
    expectCode('VERSION_CONFLICT', () => checking.submit(verification.verificationId, 'reviewer', 'r1'));
  } finally { checking.close(); }
  const f = fixture();
  try {
    const verification = f.checkPass();
    f.submit(verification.verificationId, 'reviewer', 'r1');
    expectCode('VERSION_CONFLICT', () => f.submit(verification.verificationId, 'reviewer', 'r1'));
  } finally { f.close(); }
});

test('submitVerdict validates candidate digest, result versions, task attribution and findings bounds', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    expectCode('VERSION_CONFLICT', () => f.submit(verification.verificationId, 'reviewer', 'r1', { candidateDigest: 'other-candidate' }));
    expectCode('VERSION_CONFLICT', () => f.submit(verification.verificationId, 'reviewer', 'r1', { resultVersions: { 'task-1': 7 } }));
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { resultVersions: {} }));
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { taskIds: ['dep-read'] }));
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { taskIds: ['missing'] }));
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { findings: Array.from({ length: 51 }, () => 'f') }));
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { approved: 'yes' as never }));
  } finally { f.close(); }
});

test('a rejected verdict is sealed but blocks verification application', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    const rejected = f.submit(verification.verificationId, 'reviewer', 'r1', { approved: false, findings: ['tests missing'] });
    assert.equal(rejected.approved, false);
    assert.equal(rejected.sealed, true);
    const applied = applyVerdict(f.store, rejected.verdictId);
    assert.equal(applied.status, 'failed');
    assert.match(applied.findings.join('；'), /tests missing/u);
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'delivered');
  } finally { f.close(); }
});

test('requiredVerdictKinds/requiredVerdictReviewers/verificationStatusFor map V0-V3 requirements', () => {
  assert.deepEqual(requiredVerdictKinds('V0'), []);
  assert.deepEqual(requiredVerdictKinds('V1'), ['reviewer']);
  assert.deepEqual(requiredVerdictKinds('V2'), ['reviewer', 'verifier']);
  assert.deepEqual(requiredVerdictKinds('V3'), ['reviewer', 'verifier']);
  assert.deepEqual([requiredVerdictReviewers('V0'), requiredVerdictReviewers('V1'), requiredVerdictReviewers('V2'), requiredVerdictReviewers('V3')], [0, 1, 1, 2]);
  const f = fixture();
  try {
    const base: SwarmV2Verdict = {
      verdictId: 'v', verificationId: 'ver', teamId: 't1', taskId: 'task-1', kind: 'reviewer', approved: true,
      findings: [], taskIds: ['task-1'], resultVersions: { 'task-1': 1 }, candidateDigest: CANDIDATE,
      reviewedTip: TIP, binding: 'exact-tip', reviewerMemberId: 'r1', sessionId: null, sessionFile: null, sealed: true, createdAt: iso(),
    };
    assert.equal(verificationStatusFor('V0', []), 'passed');
    assert.equal(verificationStatusFor('V1', [base]), 'passed');
    assert.equal(verificationStatusFor('V2', [base]), 'reviewing');
    assert.equal(verificationStatusFor('V2', [base, { ...base, verdictId: 'v2', kind: 'verifier', reviewerMemberId: 'v1' }]), 'passed');
    assert.equal(verificationStatusFor('V1', [{ ...base, approved: false }]), 'failed');
    assert.equal(verificationStatusFor('V1', [{ ...base, binding: 'stale-tip' }]), 'stale');
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// applyVerdict
// ---------------------------------------------------------------------------

test('applyVerdict requires objective checks and the required verdict kinds', () => {
  const missing = fixture();
  try {
    const verification = missing.start();
    missing.sql("UPDATE swarm_v2_verifications SET status='reviewing' WHERE verification_id=?", verification.verificationId);
    const verdictId = missing.insertVerdict(verification.verificationId);
    const applied = applyVerdict(missing.store, verdictId);
    assert.equal(applied.status, 'failed');
    assert.match(applied.findings.join('；'), /缺少客观检查结果/u);
  } finally { missing.close(); }
  const noVerifier = fixture({ risk: 'V2' });
  try {
    const verification = noVerifier.checkPass('V2');
    const reviewer = noVerifier.submit(verification.verificationId, 'reviewer', 'r1');
    const applied = applyVerdict(noVerifier.store, reviewer.verdictId);
    assert.equal(applied.status, 'failed');
    assert.match(applied.findings.join('；'), /verifier/u);
  } finally { noVerifier.close(); }
});

test('V2 needs independent reviewer+verifier; same session is not independent', () => {
  const shared = fixture({ risk: 'V2' });
  try {
    const verification = shared.checkPass('V2');
    shared.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'shared-session' });
    const verifier = shared.submit(verification.verificationId, 'verifier', 'v1', { sessionId: 'shared-session' });
    const applied = applyVerdict(shared.store, verifier.verdictId);
    assert.equal(applied.status, 'failed');
    assert.match(applied.findings.join('；'), /不同会话/u);
  } finally { shared.close(); }
  const independent = fixture({ risk: 'V2' });
  try {
    const verification = independent.checkPass('V2');
    independent.submit(verification.verificationId, 'reviewer', 'r1');
    const verifier = independent.submit(verification.verificationId, 'verifier', 'v1');
    const applied = applyVerdict(independent.store, verifier.verdictId);
    assert.equal(applied.status, 'passed');
    assert.equal(independent.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
  } finally { independent.close(); }
});

test('V3 requires a second independent reviewer verdict', () => {
  const missing = fixture({ risk: 'V3' });
  try {
    const verification = missing.checkPass('V3');
    missing.submit(verification.verificationId, 'reviewer', 'r1');
    const verifier = missing.submit(verification.verificationId, 'verifier', 'v1');
    const missingSecond = applyVerdict(missing.store, verifier.verdictId);
    assert.equal(missingSecond.status, 'failed');
    assert.match(missingSecond.findings.join('；'), /第二位/u);
  } finally { missing.close(); }
  const f = fixture({ risk: 'V3' });
  try {
    const verification = f.checkPass('V3');
    f.submit(verification.verificationId, 'reviewer', 'r1');
    f.submit(verification.verificationId, 'verifier', 'v1');
    const second = f.submit(verification.verificationId, 'reviewer', 'r2');
    assert.equal(second.kind, 'reviewer');
    const applied = applyVerdict(f.store, second.verdictId);
    assert.equal(applied.status, 'passed');
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
  } finally { f.close(); }
});

test('applyVerdict marks the verification stale when the candidate tip or result version changes', () => {
  const tip = fixture();
  try {
    const verification = tip.checkPass();
    const verdict = tip.submit(verification.verificationId, 'reviewer', 'r1');
    tip.sql("UPDATE swarm_v2_attempts SET candidate_tip='tip-2' WHERE attempt_id='a1'");
    const applied = applyVerdict(tip.store, verdict.verdictId);
    assert.equal(applied.status, 'stale');
    assert.match(applied.findings.join('；'), /tip 已变化/u);
  } finally { tip.close(); }
  const versions = fixture();
  try {
    const verification = versions.checkPass();
    const verdict = versions.submit(verification.verificationId, 'reviewer', 'r1');
    versions.sql("UPDATE swarm_v2_tasks SET result_revision=2 WHERE task_id='task-1'");
    assert.equal(applyVerdict(versions.store, verdict.verdictId).status, 'stale');
  } finally { versions.close(); }
});

test('applyVerdict is idempotent after passing and rejects unfinished verifications', () => {
  const f = fixture();
  try {
    const { verdict, applied } = f.approved();
    assert.equal(applied.status, 'passed');
    const journalCount = f.journalCount();
    assert.deepEqual(applyVerdict(f.store, verdict.verdictId), applied);
    assert.equal(f.journalCount(), journalCount);
  } finally { f.close(); }
  const unfinished = fixture();
  try {
    const checking = unfinished.start();
    const raw = unfinished.insertVerdict(checking.verificationId);
    expectCode('VALIDATION_ERROR', () => applyVerdict(unfinished.store, raw));
    expectCode('VALIDATION_ERROR', () => applyVerdict(unfinished.store, 'missing'));
  } finally { unfinished.close(); }
});

// ---------------------------------------------------------------------------
// Merge gates: happy path + one focused test per gate code
// ---------------------------------------------------------------------------

test('all 20 merge gates pass in order for a fully evidenced candidate', () => {
  const f = fixture();
  try {
    const { gate } = f.approved();
    const journalCount = f.journalCount();
    const decision = evaluateMergeGates(f.store, gate);
    assert.equal(decision.gates.length, 20);
    assert.deepEqual(decision.gates.map(item => item.code), [...MERGE_GATE_CODES]);
    assert.deepEqual(decision.failed, []);
    assert.equal(decision.allowed, true);
    assert.equal(decision.verdictId, f.store.row<{ verdict_id: string }>('SELECT verdict_id FROM swarm_v2_verdicts')!.verdict_id);
    assert.equal(f.journalCount(), journalCount, 'gate evaluation must be read-only');
  } finally { f.close(); }
});

test('G01 fails for a task that is not verified', () => {
  const f = fixture();
  try {
    const { gate } = f.approved();
    f.sql("UPDATE swarm_v2_tasks SET status='delivered' WHERE task_id='task-1'");
    expectGate(f.gates(), 'G01', false, /delivered/u);
  } finally { f.close(); }
});

test('G02 fails while a dependency is not done/deleted', () => {
  const failing = fixture();
  try {
    failing.approved();
    failing.addDependency('dep-pending', { mode: 'write', status: 'ready' });
    expectGate(failing.gates(), 'G02', false, /未完成依赖/u);
  } finally { failing.close(); }
  const passing = fixture();
  try {
    passing.approved();
    passing.addDependency('dep-done', { mode: 'read', status: 'done' });
    passing.addDependency('dep-deleted', { mode: 'write', status: 'deleted' });
    expectGate(passing.gates(), 'G02', true);
  } finally { passing.close(); }
});

test('G03 fails while any attempt of the task is running', () => {
  const f = fixture();
  try {
    f.approved();
    f.insertRunningAttempt();
    expectGate(f.gates(), 'G03', false, /running attempt/u);
  } finally { f.close(); }
});

test('G04 fails on unknown side effects', () => {
  const f = fixture();
  try {
    f.approved();
    f.insertUnknownAttempt();
    expectGate(f.gates(), 'G04', false, /unknown attempt/u);
  } finally { f.close(); }
});

test('G05 requires write dependencies to prove they reached the baseline', () => {
  const failing = fixture();
  try {
    failing.approved();
    failing.addDependency('dep-write', { mode: 'write', status: 'done', commitSha: null });
    expectGate(failing.gates(), 'G05', false, /依赖未合并/u);
  } finally { failing.close(); }
  const passing = fixture();
  try {
    passing.approved();
    passing.addDependency('dep-read', { mode: 'read', status: 'done' });
    passing.addDependency('dep-write', { mode: 'write', status: 'done', commitSha: 'commit-dep' });
    expectGate(passing.gates(), 'G05', true);
  } finally { passing.close(); }
});

test('G06 fails when no workspace/candidate state is readable', () => {
  const f = fixture();
  try {
    f.approved();
    f.sql('UPDATE swarm_v2_attempts SET candidate_tip=NULL,result_digest=NULL,commit_sha=NULL,workspace_id=NULL WHERE attempt_id=\'a1\'');
    expectGate(f.gates(), 'G06', false, /可读/u);
    expectGate(f.gates({ workspaceReadable: true }), 'G06', true);
  } finally { f.close(); }
});

test('G07 refuses to merge read-only survey tasks', () => {
  const f = fixture();
  try {
    f.approved();
    f.sql("UPDATE swarm_v2_tasks SET mode='read',status='verified' WHERE task_id='task-1'");
    expectGate(f.gates(), 'G07', false, /只读/u);
  } finally { f.close(); }
});

test('G08 fails when candidate base differs from the target head or head is unknown', () => {
  const f = fixture();
  try {
    f.approved();
    expectGate(f.gates({ targetHead: 'base-2' }), 'G08', false, /head/u);
    expectGate(f.gates({ targetBase: 'base-0', targetHead: 'base-1' }), 'G08', false);
    expectGate(f.gates({ targetHead: undefined }), 'G08', false, /未知/u);
    expectGate(f.gates(), 'G08', true);
  } finally { f.close(); }
});

test('G09 fails without an applied passing verdict', () => {
  const f = fixture({ status: 'verified' });
  try {
    f.addBudget();
    expectGate(f.gates(), 'G09', false, /无验证记录|verification/u);
  } finally { f.close(); }
});

test('G10 fails when the verdict was rejected', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    const rejected = f.submit(verification.verificationId, 'reviewer', 'r1', { approved: false, findings: ['needs work'] });
    f.addBudget();
    const decision = f.gates({ verdictId: rejected.verdictId });
    expectGate(decision, 'G10', false, /needs work/u);
  } finally { f.close(); }
});

test('G11 fails for a stale-tip binding and for a changed candidate tip', () => {
  const f = fixture();
  try {
    const { verification, verdict } = f.approved();
    f.sql('UPDATE swarm_v2_verdicts SET binding=? WHERE verdict_id=?', 'stale-tip', verdict.verdictId);
    expectGate(f.gates(), 'G11', false, /stale-tip/u);
    f.sql('UPDATE swarm_v2_verdicts SET binding=? WHERE verdict_id=?', 'exact-tip', verdict.verdictId);
    f.sql("UPDATE swarm_v2_attempts SET candidate_tip='moved-tip' WHERE attempt_id='a1'");
    expectGate(f.gates(), 'G11', false, /tip/u);
  } finally { f.close(); }
});

test('G12 fails when the verdict candidate or result versions no longer match', () => {
  const f = fixture();
  try {
    const { verdict } = f.approved();
    f.sql('UPDATE swarm_v2_verdicts SET result_versions_json=? WHERE verdict_id=?', '{"task-1":99}', verdict.verdictId);
    expectGate(f.gates(), 'G12', false, /结果版本/u);
    f.sql('UPDATE swarm_v2_verdicts SET result_versions_json=? WHERE verdict_id=?', '{"task-1":1}', verdict.verdictId);
    expectGate(f.gates({ candidateDigest: 'another-candidate' }), 'G12', false);
  } finally { f.close(); }
});

test('G13 fails for out-of-scope paths and unknown diffs', () => {
  const f = fixture();
  try {
    f.approved();
    expectGate(f.gates({ changedPaths: ['src/a.ts', 'other/b.ts'] }), 'G13', false, /越界/u);
    expectGate(f.gates({ changedPaths: undefined }), 'G13', false, /diff/u);
    expectGate(f.gates({ changedPaths: [] }), 'G13', true);
    expectGate(f.gates(), 'G13', true);
  } finally { f.close(); }
});

test('G14 fails unless the target workspace is explicitly clean', () => {
  const f = fixture();
  try {
    f.approved();
    expectGate(f.gates({ workspaceClean: false }), 'G14', false);
    expectGate(f.gates({ workspaceClean: undefined }), 'G14', false);
    expectGate(f.gates({ workspaceClean: true }), 'G14', true);
  } finally { f.close(); }
});

test('G15 fails when an unmerged concurrent writer owns overlapping scopes', () => {
  const f = fixture();
  try {
    f.approved();
    f.insertClaim('attempt-other', ['src/nested']);
    expectGate(f.gates(), 'G15', false, /并发写声明/u);
    f.sql('UPDATE swarm_v2_write_claims SET scopes_json=? WHERE attempt_id=?', '["docs"]', 'attempt-other');
    expectGate(f.gates(), 'G15', true);
  } finally { f.close(); }
});

test('G16 fails when the team budget is missing or exhausted', () => {
  const missing = fixture();
  try {
    missing.checkPass();
    const verdict = missing.submitAll('V1', f_verificationId(missing));
    applyVerdict(missing.store, verdict[0]!.verdictId);
    expectGate(missing.gates(), 'G16', false, /团队预算缺失/u);
  } finally { missing.close(); }
  const exhausted = fixture();
  try {
    exhausted.approved();
    exhausted.sql("UPDATE swarm_v2_budgets SET token_limit=1,token_used=1 WHERE scope='team'");
    expectGate(exhausted.gates(), 'G16', false, /团队预算已耗尽/u);
  } finally { exhausted.close(); }
});

function f_verificationId(f: ReturnType<typeof fixture>): string {
  return f.store.row<{ verification_id: string }>('SELECT verification_id FROM swarm_v2_verifications LIMIT 1')!.verification_id;
}

test('G17 requires recorded human approval for V2+ only', () => {
  const v2 = fixture({ risk: 'V2' });
  try {
    v2.approved('V2');
    expectGate(v2.gates({ humanApproval: false }), 'G17', false, /人工批准/u);
    expectGate(v2.gates({ humanApproval: true }), 'G17', true);
  } finally { v2.close(); }
  const v1 = fixture();
  try {
    v1.approved();
    expectGate(v1.gates({ humanApproval: false }), 'G17', true);
  } finally { v1.close(); }
});

test('G18 fails when protected paths would be touched', () => {
  const f = fixture();
  try {
    f.approved();
    expectGate(f.gates({ protectedPaths: ['src'] }), 'G18', false, /受保护路径/u);
    expectGate(f.gates({ protectedPaths: ['docs'] }), 'G18', true);
    f.sql("UPDATE swarm_v2_teams SET policy_json='{\"protectedPaths\":[\"src\"]}' WHERE team_id='t1'");
    expectGate(f.gates(), 'G18', false, /受保护路径/u);
  } finally { f.close(); }
});

test('G19 requires complete check/verdict/evidence chains', () => {
  const f = fixture();
  try {
    f.approved();
    expectGate(f.gates(), 'G19', true);
    f.sql("DELETE FROM swarm_v2_evidence WHERE kind='check'");
    expectGate(f.gates(), 'G19', false, /证据链/u);
  } finally { f.close(); }
});

test('G20 fails on an unknown application receipt', () => {
  const f = fixture();
  try {
    f.approved();
    f.insertReceipt({ taskId: 'task-1', status: 'unknown' });
    expectGate(f.gates(), 'G20', false, /unknown 应用回执/u);
    expectGate(f.gates({ receiptUnknown: true }), 'G20', false);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// integrateTask
// ---------------------------------------------------------------------------

test('integrateTask applies per-file receipts, marks the task done and journals both merges', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const content = 'export const a = 2;';
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true },
      files: [{ path: 'src/a.ts', content }],
    });
    assert.equal(receipt.status, 'applied');
    assert.equal(receipt.verdictId, verdict.verdictId);
    assert.deepEqual(receipt.files, [{ path: 'src/a.ts', digest: digest(content), state: 'applied' }]);
    assert.equal(receipt.baselineDigest, BASE);
    assert.match(receipt.operationId, /^[0-9a-f-]{36}$/u);
    const task = f.store.row<{ status: string; revision: number }>("SELECT status,revision FROM swarm_v2_tasks WHERE task_id='task-1'")!;
    assert.equal(task.status, 'done');
    assert.equal(task.revision, 3);
    const types = f.journalTypes();
    assert.ok(types.includes('task.merged'));
    assert.ok(types.includes('workspace.applied'));
    assert.equal(assertNoSilentMerge(f.store, 't1'), 0);
    const stored = JSON.parse(String(f.store.row<{ files_json: string }>("SELECT files_json FROM swarm_v2_apply_receipts WHERE task_id='task-1'")!.files_json));
    assert.deepEqual(stored, [{ path: 'src/a.ts', digest: digest(content), state: 'applied' }]);
  } finally { f.close(); }
});

test('integrateTask rejects on a dirty workspace without touching the verified task', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const journalCount = f.journalCount();
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: false },
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(receipt.status, 'rejected');
    assert.deepEqual(receipt.files, []);
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
    assert.ok(f.journalTypes().slice(journalCount).includes('task.merge_rejected'));
    assert.equal(assertNoSilentMerge(f.store, 't1'), 0);
  } finally { f.close(); }
});

test('integrateTask never silently merges a task without a verdict', () => {
  const f = fixture({ status: 'verified' });
  try {
    f.addBudget();
    f.sql("UPDATE swarm_v2_tasks SET result_artifact_ids_json='[]' WHERE task_id='task-1'");
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE,
      gateInput: { targetBase: BASE, targetHead: BASE, workspaceClean: true, humanApproval: true },
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.verdictId, null);
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
    assert.equal(assertNoSilentMerge(f.store, 't1'), 0);
  } finally { f.close(); }
});

test('integrateTask is idempotent for the same candidate and conflicts on a different candidate', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const input = {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true },
      files: [{ path: 'src/a.ts', content: 'x' }],
    };
    const first = integrateTask(f.store, input);
    const journalCount = f.journalCount();
    assert.deepEqual(integrateTask(f.store, input), first);
    assert.equal(f.journalCount(), journalCount, 'idempotent replay must not journal again');
    expectCode('VERSION_CONFLICT', () => integrateTask(f.store, { ...input, candidateDigest: 'candidate-digest-2' }));
  } finally { f.close(); }
});

test('integrateTask requires files for write tasks and rejects unknown receipts', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    expectCode('VALIDATION_ERROR', () => integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true },
    }));
    f.insertReceipt({ taskId: 'task-1', status: 'unknown', verdictId: verdict.verdictId });
    expectCode('VERSION_CONFLICT', () => integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true },
      files: [{ path: 'src/a.ts', content: 'x' }],
    }));
  } finally { f.close(); }
});

test('integrateTask can replace a rejected receipt after the evidence is fixed', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const baseInput = {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      files: [{ path: 'src/a.ts', content: 'x' }],
    };
    const rejected = integrateTask(f.store, { ...baseInput, gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: false } });
    assert.equal(rejected.status, 'rejected');
    const applied = integrateTask(f.store, { ...baseInput, gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true } });
    assert.equal(applied.status, 'applied');
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_apply_receipts WHERE task_id='task-1'")!.status, 'applied');
  } finally { f.close(); }
});

test('integrateTask rejects a stale verdict instead of applying it', () => {
  const f = fixture();
  try {
    const { verdicts, gate } = f.approved();
    f.sql("UPDATE swarm_v2_attempts SET candidate_tip='moved' WHERE attempt_id='a1'");
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdicts.at(-1)!.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: true },
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(receipt.status, 'rejected');
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
    assert.equal(assertNoSilentMerge(f.store, 't1'), 0);
  } finally { f.close(); }
});

test('integrateTask enforces V2 human approval', () => {
  const f = fixture({ risk: 'V2' });
  try {
    const { verdict, gate } = f.approved('V2');
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { targetBase: gate.targetBase, targetHead: gate.targetHead, workspaceClean: true, humanApproval: false },
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(receipt.status, 'rejected');
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
  } finally { f.close(); }
});

test('assertNoSilentMerge throws for an artificially silent applied receipt', () => {
  const f = fixture();
  try {
    assert.equal(assertNoSilentMerge(f.store, 't1'), 0);
    f.insertReceipt({ taskId: 'task-1', status: 'applied', verdictId: null });
    assert.throws(() => assertNoSilentMerge(f.store, 't1'), /静默合并/u);
    f.insertReceipt({ taskId: 'dep-read', status: 'rejected', verdictId: null });
    assert.equal(f.store.rows<{ n: number }>("SELECT COUNT(*) AS n FROM swarm_v2_apply_receipts WHERE status='applied'")[0]!.n, 1);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Codex review hardening (session independence, exact-tip fail-closed,
// frozen contract digest, identity-bound integration)
// ---------------------------------------------------------------------------

test('reviewer independence cannot be bypassed by omitting the session id', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    expectCode('VALIDATION_ERROR', () => f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: undefined }));
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'author-session' }));
    const accepted = f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'independent-review-session' });
    assert.equal(accepted.binding, 'exact-tip');
    assert.equal(accepted.sealed, true);
    assert.equal(accepted.sessionId, 'independent-review-session');
  } finally { f.close(); }
});

test('reviewer session must differ from the author member session even when the attempt session is null', () => {
  const f = fixture({ sessionId: null });
  try {
    const verification = f.checkPass();
    expectCode('PERMISSION_DENIED', () => f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'author-session' }));
    const accepted = f.submit(verification.verificationId, 'reviewer', 'r1', { sessionId: 'fresh-review-session' });
    assert.equal(accepted.sessionId, 'fresh-review-session');
  } finally { f.close(); }
});

test('exact-tip fails closed for write tasks without a candidate tip but read-only tasks may proceed', () => {
  const write = fixture({ candidateTip: null });
  try {
    const verification = write.checkPass();
    expectCode('VALIDATION_ERROR', () => write.submit(verification.verificationId, 'reviewer', 'r1'));
    assert.equal(write.store.rows<{ n: number }>('SELECT COUNT(*) AS n FROM swarm_v2_verdicts')[0]!.n, 0);
  } finally { write.close(); }
  const read = fixture({ mode: 'read', candidateTip: null });
  try {
    const verification = read.checkPass();
    const verdict = read.submit(verification.verificationId, 'reviewer', 'r1');
    assert.equal(verdict.binding, 'exact-tip');
    assert.equal(verdict.sealed, true);
  } finally { read.close(); }
});

test('applyVerdict goes stale when the frozen task contract changed after verification started', () => {
  const f = fixture();
  try {
    const verification = f.checkPass();
    const verdict = f.submit(verification.verificationId, 'reviewer', 'r1');
    f.sql("UPDATE swarm_v2_tasks SET revision=revision+1,requirement_version=2 WHERE task_id='task-1'");
    const applied = applyVerdict(f.store, verdict.verdictId);
    assert.equal(applied.status, 'stale');
    assert.match(applied.findings.join('；'), /契约/u);
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'delivered');
  } finally { f.close(); }
});

test('integrateTask binds identity itself and ignores caller gateInput identity overrides', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const receipt = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { ...gate, taskId: 'other-task', candidateDigest: 'other-candidate' } as never,
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(receipt.taskId, 'task-1');
    assert.equal(receipt.candidateDigest, CANDIDATE);
    assert.equal(receipt.status, 'applied');
  } finally { f.close(); }
});

test('integrateTask cannot conceal out-of-scope files behind an empty changedPaths', () => {
  const f = fixture();
  try {
    const { verdict, gate } = f.approved();
    const concealed = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { ...gate, changedPaths: [] },
      files: [{ path: 'src/a.ts', content: 'x' }, { path: 'other/b.ts', content: 'y' }],
    });
    assert.equal(concealed.status, 'rejected');
    assert.equal(f.store.row<{ status: string }>("SELECT status FROM swarm_v2_tasks WHERE task_id='task-1'")!.status, 'verified');
    const applied = integrateTask(f.store, {
      taskId: 'task-1', candidateDigest: CANDIDATE, verdictId: verdict.verdictId,
      gateInput: { ...gate, changedPaths: ['src/a.ts'] },
      files: [{ path: 'src/a.ts', content: 'x' }],
    });
    assert.equal(applied.status, 'applied');
  } finally { f.close(); }
});
