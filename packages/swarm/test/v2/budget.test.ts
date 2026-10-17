import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityError, RecordStore } from '@friend-pi/core';
import { V2Store } from '../../src/v2/store.js';
import {
  assertTeamBudget, budgetExhausted, createBudget, getBudgetByScope, getTeamBudgets,
  readBudget, release, reserve, settle,
} from '../../src/v2/budget.js';

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fixture(createdAt = iso()) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-v2-budget-'));
  const recordStore = new RecordStore('swarm', dir);
  const store = V2Store.open(recordStore);
  store.db.prepare(`INSERT INTO swarm_v2_teams(team_id,project_id,root_session_id,workspace_root,status,autonomy_level,policy_json,revision,rework_round,failure_fingerprints_json,created_at,updated_at)
    VALUES('t1','p1','s1',?,'running',1,'{}',1,0,'[]',?,?)`).run(dir, createdAt, createdAt);
  store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,logical_step_id,acceptance_json,created_by,created_at,updated_at)
    VALUES('task-1','t1',1,'build','build it','write','V1','ready','task-1','["works"]','lead-1',?,?)`).run(createdAt, createdAt);
  store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,logical_step_id,acceptance_json,created_by,created_at,updated_at)
    VALUES('task-2','t1',1,'other','other team task','write','V1','ready','task-2','["works"]','lead-1',?,?)`).run(createdAt, createdAt);
  store.db.prepare(`INSERT INTO swarm_v2_tasks(task_id,team_id,revision,title,description,mode,risk,status,logical_step_id,acceptance_json,created_by,created_at,updated_at)
    VALUES('task-9','t9',1,'foreign','other team','write','V1','ready','task-9','["works"]','lead-1',?,?)`).run(createdAt, createdAt);
  store.db.prepare(`INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,generation,phase,status,capability_json,write_scopes_json,revision,created_at,updated_at)
    VALUES('m1','t1','worker','/team/worker','worker','fresh',1,'active','idle','{}','[]',1,?,?)`).run(createdAt, createdAt);
  store.db.prepare(`INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,generation,phase,status,capability_json,write_scopes_json,revision,created_at,updated_at)
    VALUES('m9','t9','foreign','/team/foreign','worker','fresh',1,'active','idle','{}','[]',1,?,?)`).run(createdAt, createdAt);
  return {
    dir, store, recordStore,
    close() {
      recordStore.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function events(store: V2Store, type?: string): { type: string; seq: number }[] {
  const rows = store.rows<{ type: string; seq: number }>('SELECT type,seq FROM swarm_v2_journal WHERE team_id=? ORDER BY seq', 't1');
  return type ? rows.filter(row => row.type === type) : rows;
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, String(error));
    assert.equal((error as CapabilityError).code, code);
    return true;
  });
}

function teamBudget(store: V2Store, limits: { token?: number | null; cost?: number | null; time?: number | null } = {}) {
  return createBudget(store, {
    teamId: 't1', scope: 'team', scopeId: 't1',
    tokenLimit: limits.token ?? null, costLimitMicros: limits.cost ?? null, timeLimitMs: limits.time ?? null,
  });
}

test('createBudget creates a revision-1 team budget with defaults and journals budget.created', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store);
    assert.match(budget.budgetId, /^[0-9a-f-]{36}$/u);
    assert.equal(budget.teamId, 't1');
    assert.equal(budget.scope, 'team');
    assert.equal(budget.scopeId, 't1');
    assert.equal(budget.revision, 1);
    assert.equal(budget.tokenLimit, null);
    assert.equal(budget.tokenUsed, 0);
    assert.equal(budget.tokenReserved, 0);
    assert.equal(budget.costLimitMicros, null);
    assert.equal(budget.costUsed, 0);
    assert.equal(budget.timeLimitMs, null);
    assert.equal(budget.concurrencyLimit, null);
    assert.equal(budget.unknown, false);
    assert.equal(budget.paused, false);
    assert.deepEqual(events(f.store).map(row => row.type), ['budget.created']);
    const stored = f.store.row<{ budget_id: string }>('SELECT budget_id FROM swarm_v2_budgets WHERE budget_id=?', budget.budgetId);
    assert.equal(stored?.budget_id, budget.budgetId);
  } finally { f.close(); }
});

test('createBudget persists explicit token/cost/time/concurrency limits', () => {
  const f = fixture();
  try {
    const budget = createBudget(f.store, {
      teamId: 't1', scope: 'team', scopeId: 't1',
      tokenLimit: 120000, costLimitMicros: 8_000_000, timeLimitMs: 3_600_000, concurrencyLimit: 4,
    });
    assert.equal(budget.tokenLimit, 120000);
    assert.equal(budget.costLimitMicros, 8_000_000);
    assert.equal(budget.timeLimitMs, 3_600_000);
    assert.equal(budget.concurrencyLimit, 4);
  } finally { f.close(); }
});

test('createBudget rejects duplicate (team, scope, scopeId)', () => {
  const f = fixture();
  try {
    teamBudget(f.store);
    expectCode('VALIDATION_ERROR', () => teamBudget(f.store));
    assert.equal(events(f.store).filter(row => row.type === 'budget.created').length, 1);
  } finally { f.close(); }
});

test('createBudget validates scope, scopeId and limits', () => {
  const f = fixture();
  try {
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'global' as never, scopeId: 'x' }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'team', scopeId: 'other' }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 'missing', scope: 'team', scopeId: 'missing' }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'team', scopeId: 't1', tokenLimit: -1 }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'team', scopeId: 't1', concurrencyLimit: 1.5 }));
  } finally { f.close(); }
});

test('createBudget ties task/member budgets to the same team', () => {
  const f = fixture();
  try {
    const taskBudget = createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'task-1', tokenLimit: 48000 });
    const memberBudget = createBudget(f.store, { teamId: 't1', scope: 'member', scopeId: 'm1', tokenLimit: 160000 });
    assert.equal(taskBudget.scopeId, 'task-1');
    assert.equal(memberBudget.scopeId, 'm1');
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'task-9' }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'member', scopeId: 'm9' }));
    expectCode('VALIDATION_ERROR', () => createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'missing' }));
  } finally { f.close(); }
});

test('readBudget and getTeamBudgets/getBudgetByScope read exact rows only', () => {
  const f = fixture();
  try {
    const team = teamBudget(f.store, { token: 1000 });
    const task = createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'task-1', tokenLimit: 200 });
    const member = createBudget(f.store, { teamId: 't1', scope: 'member', scopeId: 'm1', tokenLimit: 100 });
    assert.deepEqual(readBudget(f.store, team.budgetId), team);
    assert.deepEqual(getTeamBudgets(f.store, 't1').map(budget => budget.budgetId), [member.budgetId, task.budgetId, team.budgetId]);
    assert.deepEqual(getTeamBudgets(f.store, 'missing'), []);
    assert.equal(getBudgetByScope(f.store, 't1', 'task', 'task-1')?.budgetId, task.budgetId);
    assert.equal(getBudgetByScope(f.store, 't1', 'task', 'task-2'), undefined);
    expectCode('VALIDATION_ERROR', () => readBudget(f.store, 'missing'));
  } finally { f.close(); }
});

test('reserve freezes an upper bound, grows tokenReserved and journals budget.reserved', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000, cost: 5000 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'attempt-1', tokens: 200, costMicros: 300 });
    assert.equal(entry.state, 'reserved');
    assert.equal(entry.upperBoundTokens, 200);
    assert.equal(entry.upperBoundCostMicros, 300);
    assert.equal(entry.tokens, null);
    assert.equal(entry.attemptId, 'attempt-1');
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenReserved, 200);
    assert.equal(after.tokenUsed, 0);
    assert.equal(after.revision, 2);
    assert.deepEqual(events(f.store).map(row => row.type), ['budget.created', 'budget.reserved']);
    const journalData = JSON.parse(String(f.store.row<{ data_json: string }>("SELECT data_json FROM swarm_v2_journal WHERE type='budget.reserved'")!.data_json));
    assert.equal(journalData.reservationId, entry.reservationId);
    assert.equal(journalData.upperBoundTokens, 200);
  } finally { f.close(); }
});

test('reserve supports cost-only and zero-bound reservations', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 100, cost: 1000 });
    const costOnly = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', costMicros: 400 });
    assert.equal(costOnly.upperBoundTokens, 0);
    assert.equal(costOnly.upperBoundCostMicros, 400);
    assert.equal(readBudget(f.store, budget.budgetId).tokenReserved, 0);
    const zero = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2' });
    assert.equal(zero.upperBoundTokens, 0);
    assert.equal(zero.upperBoundCostMicros, 0);
  } finally { f.close(); }
});

test('reserve enforces the token hard limit without writing an entry or journal', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 100 });
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 90 });
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 11 }));
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenReserved, 90);
    assert.equal(after.revision, 2);
    assert.equal(events(f.store).filter(row => row.type === 'budget.reserved').length, 1);
    assert.equal(f.store.rows<{ n: number }>('SELECT COUNT(*) AS n FROM swarm_v2_budget_entries')[0]!.n, 1);
  } finally { f.close(); }
});

test('reserve allows an exact-fit upper bound and then reports exhaustion', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 100 });
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 100 });
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 1 }));
    assert.equal(budgetExhausted(f.store, readBudget(f.store, budget.budgetId)), true);
  } finally { f.close(); }
});

test('reserve enforces the cost hard limit across reserved entries', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { cost: 1000 });
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', costMicros: 700 });
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', costMicros: 301 }));
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a3', costMicros: 300 });
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a4', costMicros: 1 }));
  } finally { f.close(); }
});

test('reserve refuses unknown, paused, team-paused and deadline-exhausted budgets', () => {
  const f = fixture();
  try {
    const unknown = teamBudget(f.store);
    f.store.db.prepare('UPDATE swarm_v2_budgets SET unknown=1 WHERE budget_id=?').run(unknown.budgetId);
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: unknown.budgetId, attemptId: 'a1', tokens: 1 }));

    const paused = createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'task-1' });
    f.store.db.prepare('UPDATE swarm_v2_budgets SET paused=1 WHERE budget_id=?').run(paused.budgetId);
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: paused.budgetId, attemptId: 'a1', tokens: 1 }));

    const member = createBudget(f.store, { teamId: 't1', scope: 'member', scopeId: 'm1' });
    f.store.db.prepare("UPDATE swarm_v2_teams SET status='paused' WHERE team_id='t1'").run();
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: member.budgetId, attemptId: 'a1', tokens: 1 }));
  } finally { f.close(); }
});

test('reserve treats an expired wall-clock deadline as exhausted', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { time: 1000 });
    // Age the budget so its wall-clock deadline has elapsed.
    f.store.db.prepare('UPDATE swarm_v2_budgets SET created_at=? WHERE budget_id=?').run(iso(-60_000), budget.budgetId);
    expectCode('BUDGET_EXHAUSTED', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 1 }));
    assert.equal(budgetExhausted(f.store, readBudget(f.store, budget.budgetId)), true);
  } finally { f.close(); }
});

test('reserve validates team ownership, attemptId and attempts/team ids', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store);
    expectCode('VALIDATION_ERROR', () => reserve(f.store, { teamId: 't9', budgetId: budget.budgetId, attemptId: 'a1', tokens: 1 }));
    expectCode('VALIDATION_ERROR', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: '', tokens: 1 }));
    expectCode('VALIDATION_ERROR', () => reserve(f.store, { teamId: 't1', budgetId: 'missing', attemptId: 'a1', tokens: 1 }));
    expectCode('VALIDATION_ERROR', () => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: -1 }));
  } finally { f.close(); }
});

test('three-layer reserve chain records one entry per layer with independent journals', () => {
  const f = fixture();
  try {
    const team = teamBudget(f.store, { token: 10_000 });
    const task = createBudget(f.store, { teamId: 't1', scope: 'task', scopeId: 'task-1', tokenLimit: 5_000 });
    const member = createBudget(f.store, { teamId: 't1', scope: 'member', scopeId: 'm1', tokenLimit: 2_000 });
    const entries = [team, task, member].map((budget, index) => reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'attempt-1', tokens: 100 + index }));
    assert.deepEqual(entries.map(entry => entry.budgetId), [team.budgetId, task.budgetId, member.budgetId]);
    assert.deepEqual([team, task, member].map(budget => readBudget(f.store, budget.budgetId).tokenReserved), [100, 101, 102]);
    assert.equal(events(f.store).filter(row => row.type === 'budget.reserved').length, 3);
    for (const budget of [team, task, member]) {
      const list = f.store.rows<{ state: string }>('SELECT state FROM swarm_v2_budget_entries WHERE budget_id=?', budget.budgetId);
      assert.deepEqual(list.map(row => row.state), ['reserved']);
    }
  } finally { f.close(); }
});

test('settle with known usage moves reserved to used and journals budget.settled', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000, cost: 5000 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 400, costMicros: 900 });
    const settled = settle(f.store, { entryId: entry.reservationId, tokens: 250, costMicros: 600 });
    assert.equal(settled.state, 'settled');
    assert.equal(settled.tokens, 250);
    assert.equal(settled.costMicros, 600);
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenReserved, 0);
    assert.equal(after.tokenUsed, 250);
    assert.equal(after.costUsed, 600);
    assert.equal(after.revision, 3);
    const journalRow = f.store.row<{ data_json: string }>("SELECT data_json FROM swarm_v2_journal WHERE type='budget.settled'")!;
    const data = JSON.parse(String(journalRow.data_json));
    assert.equal(data.reservationId, entry.reservationId);
    assert.equal(data.tokens, 250);
    assert.equal(data.tokenUsed, 250);
  } finally { f.close(); }
});

test('settle defaults actual usage to the reserved upper bound', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000, cost: 5000 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 300, costMicros: 120 });
    const settled = settle(f.store, { entryId: entry.reservationId });
    assert.equal(settled.tokens, 300);
    assert.equal(settled.costMicros, 120);
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenUsed, 300);
    assert.equal(after.costUsed, 120);
    assert.equal(after.tokenReserved, 0);
  } finally { f.close(); }
});

test('settle is idempotent for identical terminal values and VERSION_CONFLICT for different ones', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 100 });
    settle(f.store, { entryId: entry.reservationId, tokens: 80 });
    const snapshot = readBudget(f.store, budget.budgetId);
    const journalCount = events(f.store).length;
    const replay = settle(f.store, { entryId: entry.reservationId, tokens: 80 });
    assert.equal(replay.tokens, 80);
    assert.deepEqual(readBudget(f.store, budget.budgetId), snapshot);
    assert.equal(events(f.store).length, journalCount);
    expectCode('VERSION_CONFLICT', () => settle(f.store, { entryId: entry.reservationId, tokens: 81 }));
    expectCode('VERSION_CONFLICT', () => settle(f.store, { entryId: entry.reservationId, unknown: true }));
  } finally { f.close(); }
});

test('settle unknown freezes the budget without inventing usage', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 300 });
    const unknown = settle(f.store, { entryId: entry.reservationId, unknown: true });
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.tokens, null);
    assert.equal(unknown.costMicros, null);
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.unknown, true);
    assert.equal(after.tokenReserved, 0);
    assert.equal(after.tokenUsed, 0);
    assert.equal(budgetExhausted(f.store, after), true);
    assert.equal(events(f.store).filter(row => row.type === 'budget.settled').length, 1);
    expectCode('VERSION_CONFLICT', () => settle(f.store, { entryId: entry.reservationId, tokens: 300 }));
  } finally { f.close(); }
});

test('release only frees reserved entries and is a no-op for terminal entries', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000, cost: 2000 });
    const reserved = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 200, costMicros: 500 });
    const released = release(f.store, reserved.reservationId);
    assert.equal(released.state, 'released');
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenReserved, 0);
    assert.equal(after.tokenUsed, 0);
    assert.equal(after.costUsed, 0);
    const journalCount = events(f.store).length;
    assert.deepEqual(release(f.store, reserved.reservationId), released);
    assert.equal(events(f.store).length, journalCount, 'releasing twice must not journal twice');

    const settled = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 10 });
    settle(f.store, { entryId: settled.reservationId, tokens: 10 });
    const before = readBudget(f.store, budget.budgetId);
    assert.equal(release(f.store, settled.reservationId).state, 'settled');
    assert.deepEqual(readBudget(f.store, budget.budgetId), before);
    expectCode('VALIDATION_ERROR', () => release(f.store, 'missing'));
  } finally { f.close(); }
});

test('settled overrun is recorded rather than hidden and exhausts the budget', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 100 });
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 100 });
    const settled = settle(f.store, { entryId: entry.reservationId, tokens: 150, costMicros: 0 });
    assert.equal(settled.tokens, 150);
    const after = readBudget(f.store, budget.budgetId);
    assert.equal(after.tokenUsed, 150);
    assert.ok(after.tokenUsed > after.tokenLimit!);
    assert.equal(budgetExhausted(f.store, after), true);
  } finally { f.close(); }
});

test('budgetExhausted reports limit/deadline/frozen states and is false while headroom remains', () => {
  const f = fixture(iso(-5000));
  try {
    const budget = teamBudget(f.store, { token: 1000, time: 60_000 });
    assert.equal(budgetExhausted(f.store, budget), false);
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 900 });
    assert.equal(budgetExhausted(f.store, readBudget(f.store, budget.budgetId)), false);
    reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 100 });
    assert.equal(budgetExhausted(f.store, readBudget(f.store, budget.budgetId)), true);

    f.store.db.prepare("UPDATE swarm_v2_budgets SET token_reserved=0,token_used=0 WHERE budget_id=?").run(budget.budgetId);
    f.store.db.prepare("UPDATE swarm_v2_budgets SET paused=1 WHERE budget_id=?").run(budget.budgetId);
    assert.equal(budgetExhausted(f.store, readBudget(f.store, budget.budgetId)), true);
  } finally { f.close(); }
});

test('assertTeamBudget requires a healthy team budget', () => {
  const f = fixture();
  try {
    expectCode('BUDGET_EXHAUSTED', () => assertTeamBudget(f.store, 't1'));
    const budget = teamBudget(f.store, { token: 100 });
    assert.deepEqual(assertTeamBudget(f.store, 't1'), readBudget(f.store, budget.budgetId));
    const entry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 100 });
    settle(f.store, { entryId: entry.reservationId });
    expectCode('BUDGET_EXHAUSTED', () => assertTeamBudget(f.store, 't1'));
    f.store.db.prepare("UPDATE swarm_v2_budgets SET paused=1 WHERE budget_id=?").run(budget.budgetId);
    expectCode('BUDGET_EXHAUSTED', () => assertTeamBudget(f.store, 't1'));
  } finally { f.close(); }
});

test('budget revision increases monotonically across reserve/settle/release', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000 });
    const revisions: number[] = [readBudget(f.store, budget.budgetId).revision];
    const first = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 10 });
    revisions.push(readBudget(f.store, budget.budgetId).revision);
    const second = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 10 });
    revisions.push(readBudget(f.store, budget.budgetId).revision);
    settle(f.store, { entryId: first.reservationId });
    revisions.push(readBudget(f.store, budget.budgetId).revision);
    release(f.store, second.reservationId);
    revisions.push(readBudget(f.store, budget.budgetId).revision);
    for (let index = 1; index < revisions.length; index++) assert.ok(revisions[index]! > revisions[index - 1]!, revisions.join(','));
    assert.deepEqual(events(f.store).map(row => row.seq), events(f.store).map((_, index) => index + 1));
  } finally { f.close(); }
});

test('settle retries with identical terminal intent are idempotent for settled and unknown entries', () => {
  const f = fixture();
  try {
    const budget = teamBudget(f.store, { token: 1000 });
    const settledEntry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a1', tokens: 100 });
    settle(f.store, { entryId: settledEntry.reservationId, tokens: 60 });
    const settledSnapshot = readBudget(f.store, budget.budgetId);
    const settledJournal = events(f.store).length;
    const replay = settle(f.store, { entryId: settledEntry.reservationId, tokens: 60 });
    assert.equal(replay.state, 'settled');
    assert.equal(replay.tokens, 60);
    assert.equal(replay.costMicros, 0);
    assert.deepEqual(readBudget(f.store, budget.budgetId), settledSnapshot);
    assert.equal(events(f.store).length, settledJournal);
    expectCode('VERSION_CONFLICT', () => settle(f.store, { entryId: settledEntry.reservationId, tokens: 61 }));

    const unknownEntry = reserve(f.store, { teamId: 't1', budgetId: budget.budgetId, attemptId: 'a2', tokens: 50 });
    const unknown = settle(f.store, { entryId: unknownEntry.reservationId, unknown: true });
    const unknownSnapshot = readBudget(f.store, budget.budgetId);
    const unknownJournal = events(f.store).length;
    const unknownReplay = settle(f.store, { entryId: unknownEntry.reservationId, unknown: true });
    assert.deepEqual(unknownReplay, unknown);
    assert.deepEqual(readBudget(f.store, budget.budgetId), unknownSnapshot);
    assert.equal(events(f.store).length, unknownJournal);
    expectCode('VERSION_CONFLICT', () => settle(f.store, { entryId: unknownEntry.reservationId, tokens: 10 }));
  } finally { f.close(); }
});
