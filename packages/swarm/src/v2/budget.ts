import { randomUUID } from 'node:crypto';
import { CapabilityError, digest } from '@friend-pi/core';
import type {
  SwarmV2Actor, SwarmV2Budget, SwarmV2BudgetEntry, SwarmV2BudgetScope,
} from './types.js';
import { intOrNull, text, V2Store, v2Now } from './store.js';

/**
 * Swarm v2 three-layer budgets (SPEC §2C / invariant I16).
 *
 * One budget row exists per (team, scope, scopeId). Callers reserve against
 * team, then task, then member budgets; this module validates a single budget
 * per call and keeps the boundary invariants here so every layer fails closed:
 *
 *   reserve  -> entry reserved, upper bounds frozen, token/cost reserved counters grow
 *   settle   -> known usage: reserved -> settled, used += actual (overrun is recorded, not hidden)
 *               unknown usage: reserved -> unknown, budget.unknown=1, used is NOT invented
 *   release  -> only a still-reserved entry can be released
 *
 * Frozen/unknown/paused/deadline budgets refuse new reservations. All writes are
 * transactional and journaled; `revision` increments on every mutation.
 */

export const BUDGET_SCOPES: SwarmV2BudgetScope[] = ['team', 'task', 'member'];
const DEFAULT_ACTOR: SwarmV2Actor = { kind: 'system', id: 'swarm-v2-budget' };

export interface CreateBudgetInput {
  teamId: string;
  scope: SwarmV2BudgetScope;
  scopeId: string;
  tokenLimit?: number | null;
  costLimitMicros?: number | null;
  timeLimitMs?: number | null;
  concurrencyLimit?: number | null;
  actor?: SwarmV2Actor;
}

export interface ReserveBudgetInput {
  teamId: string;
  budgetId: string;
  attemptId: string;
  tokens?: number;
  costMicros?: number;
  actor?: SwarmV2Actor;
}

export interface SettleBudgetInput {
  entryId: string;
  tokens?: number;
  costMicros?: number;
  unknown?: boolean;
  actor?: SwarmV2Actor;
}

interface BudgetRow {
  budget_id: string; team_id: string; scope: string; scope_id: string;
  token_limit: number | null; token_used: number; token_reserved: number;
  cost_limit_micros: number | null; cost_used: number;
  time_limit_ms: number | null; time_used_ms: number;
  concurrency_limit: number | null; unknown: number; paused: number;
  revision: number; created_at: string; updated_at: string;
}

interface EntryRow {
  reservation_id: string; budget_id: string; attempt_id: string;
  upper_bound_tokens: number; upper_bound_cost_micros: number;
  state: string; tokens: number | null; cost_micros: number | null;
  created_at: string; updated_at: string;
}

function mapBudget(row: BudgetRow): SwarmV2Budget {
  return {
    budgetId: String(row.budget_id),
    teamId: String(row.team_id),
    scope: String(row.scope) as SwarmV2BudgetScope,
    scopeId: String(row.scope_id),
    tokenLimit: row.token_limit === null ? null : Number(row.token_limit),
    tokenUsed: Number(row.token_used),
    tokenReserved: Number(row.token_reserved),
    costLimitMicros: row.cost_limit_micros === null ? null : Number(row.cost_limit_micros),
    costUsed: Number(row.cost_used),
    timeLimitMs: row.time_limit_ms === null ? null : Number(row.time_limit_ms),
    timeUsedMs: Number(row.time_used_ms),
    concurrencyLimit: row.concurrency_limit === null ? null : Number(row.concurrency_limit),
    unknown: Number(row.unknown) === 1,
    paused: Number(row.paused) === 1,
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEntry(row: EntryRow): SwarmV2BudgetEntry {
  return {
    reservationId: String(row.reservation_id),
    budgetId: String(row.budget_id),
    attemptId: String(row.attempt_id),
    upperBoundTokens: Number(row.upper_bound_tokens),
    upperBoundCostMicros: Number(row.upper_bound_cost_micros),
    state: String(row.state) as SwarmV2BudgetEntry['state'],
    tokens: row.tokens === null ? null : Number(row.tokens),
    costMicros: row.cost_micros === null ? null : Number(row.cost_micros),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function budgetRow(store: V2Store, budgetId: string): BudgetRow | undefined {
  return store.row<BudgetRow>('SELECT * FROM swarm_v2_budgets WHERE budget_id=?', budgetId);
}

function entryRow(store: V2Store, entryId: string): EntryRow | undefined {
  return store.row<EntryRow>('SELECT * FROM swarm_v2_budget_entries WHERE reservation_id=?', entryId);
}

function requireBudgetRow(store: V2Store, budgetId: string): BudgetRow {
  const row = budgetRow(store, budgetId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '预算不存在');
  return row;
}

function requireEntryRow(store: V2Store, entryId: string): EntryRow {
  const row = entryRow(store, entryId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '预算预留不存在');
  return row;
}

function bound(value: unknown, field: string): number {
  const parsed = intOrNull(value ?? 0, field, 0);
  return parsed === null ? 0 : parsed;
}

function teamPaused(store: V2Store, teamId: string): boolean {
  const row = store.row<{ status: string }>('SELECT status FROM swarm_v2_teams WHERE team_id=?', teamId);
  return row?.status === 'paused';
}

function reservedCost(store: V2Store, budgetId: string): number {
  const row = store.row<{ n: number }>("SELECT COALESCE(SUM(upper_bound_cost_micros),0) AS n FROM swarm_v2_budget_entries WHERE budget_id=? AND state='reserved'", budgetId);
  return Number(row?.n ?? 0);
}

function elapsedMs(budget: { createdAt: string }): number {
  const started = Date.parse(budget.createdAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Date.now() - started);
}

function timeExhausted(budget: SwarmV2Budget): boolean {
  if (budget.timeLimitMs === null) return false;
  return budget.timeUsedMs + elapsedMs(budget) >= budget.timeLimitMs;
}

/** Frozen budgets (unknown / paused / past deadline) refuse new reservations. */
function frozen(store: V2Store, budget: SwarmV2Budget): boolean {
  return budget.unknown || budget.paused || teamPaused(store, budget.teamId) || timeExhausted(budget);
}

function journal(store: V2Store, teamId: string, type: string, actor: SwarmV2Actor | undefined, budget: ScalarBudgetRef, data: Record<string, unknown>): void {
  store.journal(teamId, type, actor ?? DEFAULT_ACTOR, { kind: 'budget', id: budget.budgetId, revision: budget.revision }, data);
}

interface ScalarBudgetRef { budgetId: string; revision: number }

/** Create exactly one budget per (team, scope, scopeId). `revision` starts at 1. */
export function createBudget(store: V2Store, input: CreateBudgetInput): SwarmV2Budget {
  const teamId = text(input.teamId, 'teamId');
  const team = store.row<{ team_id: string }>('SELECT team_id FROM swarm_v2_teams WHERE team_id=?', teamId);
  if (!team) throw new CapabilityError('VALIDATION_ERROR', '团队不存在');
  const scope = input.scope;
  if (!BUDGET_SCOPES.includes(scope)) throw new CapabilityError('VALIDATION_ERROR', '预算 scope 必须是 team/task/member');
  const scopeId = text(input.scopeId, 'scopeId');
  if (scope === 'team' && scopeId !== teamId) throw new CapabilityError('VALIDATION_ERROR', 'team 预算 scopeId 必须等于 teamId');
  if (scope === 'task') {
    const task = store.row<{ team_id: string }>('SELECT team_id FROM swarm_v2_tasks WHERE task_id=?', scopeId);
    if (!task || task.team_id !== teamId) throw new CapabilityError('VALIDATION_ERROR', 'task 预算关联的任务不属于该团队');
  }
  if (scope === 'member') {
    const member = store.row<{ team_id: string }>('SELECT team_id FROM swarm_v2_members WHERE member_id=?', scopeId);
    if (!member || member.team_id !== teamId) throw new CapabilityError('VALIDATION_ERROR', 'member 预算关联的成员不属于该团队');
  }
  const tokenLimit = intOrNull(input.tokenLimit, 'tokenLimit', 0);
  const costLimitMicros = intOrNull(input.costLimitMicros, 'costLimitMicros', 0);
  const timeLimitMs = intOrNull(input.timeLimitMs, 'timeLimitMs', 0);
  const concurrencyLimit = intOrNull(input.concurrencyLimit, 'concurrencyLimit', 0);
  const budgetId = randomUUID();
  return store.transaction(() => {
    const existing = store.row<{ budget_id: string }>('SELECT budget_id FROM swarm_v2_budgets WHERE team_id=? AND scope=? AND scope_id=?', teamId, scope, scopeId);
    if (existing) throw new CapabilityError('VALIDATION_ERROR', '同一团队/作用域的预算已存在');
    const now = v2Now();
    store.db.prepare(`INSERT INTO swarm_v2_budgets(budget_id,team_id,scope,scope_id,token_limit,token_used,token_reserved,cost_limit_micros,cost_used,time_limit_ms,time_used_ms,concurrency_limit,unknown,paused,revision,created_at,updated_at)
      VALUES(?,?,?,?,?,0,0,?,0,?,0,?,0,0,1,?,?)`)
      .run(budgetId, teamId, scope, scopeId, tokenLimit, costLimitMicros, timeLimitMs, concurrencyLimit, now, now);
    const budget = mapBudget(requireBudgetRow(store, budgetId));
    journal(store, teamId, 'budget.created', input.actor, budget, {
      scope, scopeId, tokenLimit, costLimitMicros, timeLimitMs, concurrencyLimit,
    });
    return budget;
  });
}

/** Read one budget; missing ids fail closed. */
export function readBudget(store: V2Store, budgetId: string): SwarmV2Budget {
  return mapBudget(requireBudgetRow(store, text(budgetId, 'budgetId')));
}

/** All budgets of one team, sorted by scope then scopeId for deterministic output. */
export function getTeamBudgets(store: V2Store, teamId: string): SwarmV2Budget[] {
  return store.rows<BudgetRow>('SELECT * FROM swarm_v2_budgets WHERE team_id=? ORDER BY scope ASC,scope_id ASC', text(teamId, 'teamId')).map(mapBudget);
}

/** Read the single budget of a scope target (used by gates and the integration service). */
export function getBudgetByScope(store: V2Store, teamId: string, scope: SwarmV2BudgetScope, scopeId: string): SwarmV2Budget | undefined {
  const row = store.row<BudgetRow>('SELECT * FROM swarm_v2_budgets WHERE team_id=? AND scope=? AND scope_id=?', text(teamId, 'teamId'), scope, text(scopeId, 'scopeId'));
  return row ? mapBudget(row) : undefined;
}

/**
 * Reserve an upper bound against one budget. The caller must reserve the same
 * operation against team, task and member budgets itself. Hard limits are
 * checked against used+reserved+upper; frozen budgets fail with BUDGET_EXHAUSTED.
 */
export function reserve(store: V2Store, input: ReserveBudgetInput): SwarmV2BudgetEntry {
  const teamId = text(input.teamId, 'teamId');
  const budgetId = text(input.budgetId, 'budgetId');
  const attemptId = text(input.attemptId, 'attemptId');
  const tokens = bound(input.tokens, 'tokens');
  const costMicros = bound(input.costMicros, 'costMicros');
  const reservationId = randomUUID();
  return store.transaction(() => {
    const current = mapBudget(requireBudgetRow(store, budgetId));
    if (current.teamId !== teamId) throw new CapabilityError('VALIDATION_ERROR', '预算不属于该团队');
    if (frozen(store, current)) throw new CapabilityError('BUDGET_EXHAUSTED', '预算已冻结或已耗尽');
    if (current.tokenLimit !== null && current.tokenUsed + current.tokenReserved + tokens > current.tokenLimit) {
      throw new CapabilityError('BUDGET_EXHAUSTED', 'token 预算不足以覆盖本次预留');
    }
    if (current.costLimitMicros !== null && current.costUsed + reservedCost(store, budgetId) + costMicros > current.costLimitMicros) {
      throw new CapabilityError('BUDGET_EXHAUSTED', '成本预算不足以覆盖本次预留');
    }
    const now = v2Now();
    store.db.prepare(`INSERT INTO swarm_v2_budget_entries(reservation_id,budget_id,attempt_id,upper_bound_tokens,upper_bound_cost_micros,state,tokens,cost_micros,created_at,updated_at)
      VALUES(?,?,?,?,?,'reserved',NULL,NULL,?,?)`).run(reservationId, budgetId, attemptId, tokens, costMicros, now, now);
    store.db.prepare('UPDATE swarm_v2_budgets SET token_reserved=token_reserved+?,revision=revision+1,updated_at=? WHERE budget_id=?').run(tokens, now, budgetId);
    const updated = mapBudget(requireBudgetRow(store, budgetId));
    journal(store, teamId, 'budget.reserved', input.actor, updated, {
      reservationId, attemptId, upperBoundTokens: tokens, upperBoundCostMicros: costMicros,
      tokenReserved: updated.tokenReserved, tokenUsed: updated.tokenUsed,
    });
    return mapEntry(requireEntryRow(store, reservationId));
  });
}

/**
 * Settle a reservation.
 * - known usage: reserved -> settled; used += actual (defaults to the upper bound).
 *   Actual overrun is recorded verbatim (blueprint overrun accounting).
 * - unknown usage: reserved -> unknown; budget.unknown=1; used is NOT invented.
 * Re-settling with identical values is idempotent; any different/repeat terminal
 * settlement is VERSION_CONFLICT.
 */
export function settle(store: V2Store, input: SettleBudgetInput): SwarmV2BudgetEntry {
  const entryId = text(input.entryId, 'entryId');
  const unknown = input.unknown === true;
  return store.transaction(() => {
    const entry = requireEntryRow(store, entryId);
    const budget = mapBudget(requireBudgetRow(store, entry.budget_id));
    const isUnknown = entry.state === 'unknown';
    const isSettled = entry.state === 'settled';
    if (isSettled || isUnknown) {
      // Retrying a terminal settlement with identical intent is idempotent:
      // settled + same actual values -> entry; unknown + unknown -> entry.
      // Any different intent (e.g. unknown after settled) is VERSION_CONFLICT.
      if (isUnknown && unknown) return mapEntry(entry);
      if (isSettled && !unknown) {
        const replayTokens = input.tokens === undefined ? Number(entry.upper_bound_tokens) : bound(input.tokens, 'tokens');
        const replayCost = input.costMicros === undefined ? Number(entry.upper_bound_cost_micros) : bound(input.costMicros, 'costMicros');
        if (replayTokens === entry.tokens && replayCost === entry.cost_micros) return mapEntry(entry);
      }
      throw new CapabilityError('VERSION_CONFLICT', '预算预留已结算，不能再次结算为不同值');
    }
    if (entry.state !== 'reserved') throw new CapabilityError('VERSION_CONFLICT', '预算预留已释放或状态未知');
    const now = v2Now();
    if (unknown) {
      store.db.prepare("UPDATE swarm_v2_budget_entries SET state='unknown',tokens=NULL,cost_micros=NULL,updated_at=? WHERE reservation_id=?").run(now, entryId);
      store.db.prepare('UPDATE swarm_v2_budgets SET token_reserved=MAX(0,token_reserved-?),unknown=1,revision=revision+1,updated_at=? WHERE budget_id=?').run(Number(entry.upper_bound_tokens), now, entry.budget_id);
    } else {
      const tokens = input.tokens === undefined ? Number(entry.upper_bound_tokens) : bound(input.tokens, 'tokens');
      const costMicros = input.costMicros === undefined ? Number(entry.upper_bound_cost_micros) : bound(input.costMicros, 'costMicros');
      store.db.prepare("UPDATE swarm_v2_budget_entries SET state='settled',tokens=?,cost_micros=?,updated_at=? WHERE reservation_id=?").run(tokens, costMicros, now, entryId);
      store.db.prepare('UPDATE swarm_v2_budgets SET token_reserved=MAX(0,token_reserved-?),token_used=token_used+?,cost_used=cost_used+?,revision=revision+1,updated_at=? WHERE budget_id=?').run(Number(entry.upper_bound_tokens), tokens, costMicros, now, entry.budget_id);
    }
    const updated = mapBudget(requireBudgetRow(store, entry.budget_id));
    const settled = mapEntry(requireEntryRow(store, entryId));
    journal(store, budget.teamId, 'budget.settled', input.actor, updated, {
      reservationId: entryId, unknown: unknown || undefined, tokens: settled.tokens, costMicros: settled.costMicros,
      tokenUsed: updated.tokenUsed, costUsed: updated.costUsed, budgetUnknown: updated.unknown,
    });
    return settled;
  });
}

/**
 * Release a still-reserved entry (e.g. dispatch failed before usage).
 * Settled/unknown/released entries are returned unchanged; an unknown entry id
 * is a validation error.
 */
export function release(store: V2Store, entryId: string, actor?: SwarmV2Actor): SwarmV2BudgetEntry {
  const id = text(entryId, 'entryId');
  return store.transaction(() => {
    const entry = requireEntryRow(store, id);
    if (entry.state !== 'reserved') return mapEntry(entry);
    const now = v2Now();
    store.db.prepare("UPDATE swarm_v2_budget_entries SET state='released',updated_at=? WHERE reservation_id=?").run(now, id);
    store.db.prepare('UPDATE swarm_v2_budgets SET token_reserved=MAX(0,token_reserved-?),revision=revision+1,updated_at=? WHERE budget_id=?').run(Number(entry.upper_bound_tokens), now, entry.budget_id);
    const budget = mapBudget(requireBudgetRow(store, entry.budget_id));
    journal(store, budget.teamId, 'budget.released', actor, budget, { reservationId: id, tokenReserved: budget.tokenReserved });
    return mapEntry(requireEntryRow(store, id));
  });
}

/**
 * True when a budget can no longer be used: unknown usage, paused, team paused,
 * token/cost upper bound reached, or the wall-clock deadline is consumed.
 */
export function budgetExhausted(store: V2Store, budget: SwarmV2Budget): boolean {
  const fresh = budgetRow(store, budget.budgetId);
  const current = fresh ? mapBudget(fresh) : budget;
  if (current.unknown || current.paused) return true;
  if (teamPaused(store, current.teamId)) return true;
  if (current.tokenLimit !== null && current.tokenUsed + current.tokenReserved >= current.tokenLimit) return true;
  if (current.costLimitMicros !== null && current.costUsed + reservedCost(store, current.budgetId) >= current.costLimitMicros) return true;
  return timeExhausted(current);
}

/**
 * Scheduling/integration guard: the team budget must exist and must not be
 * exhausted (unknown/paused/deadline/limit). Returns the budget for callers.
 */
export function assertTeamBudget(store: V2Store, teamId: string): SwarmV2Budget {
  const id = text(teamId, 'teamId');
  const budget = getBudgetByScope(store, id, 'team', id);
  if (!budget) throw new CapabilityError('BUDGET_EXHAUSTED', '团队预算不存在');
  if (budgetExhausted(store, budget)) throw new CapabilityError('BUDGET_EXHAUSTED', '团队预算已耗尽或被冻结');
  return readBudget(store, budget.budgetId);
}
