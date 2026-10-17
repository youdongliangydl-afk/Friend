import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { CapabilityError, digest } from '@friend-pi/core';
import type {
  SwarmV2Actor, SwarmV2ApplyReceipt, SwarmV2Binding, SwarmV2CheckResult, SwarmV2MergeDecision,
  SwarmV2MergeGate, SwarmV2Risk, SwarmV2Verdict, SwarmV2VerdictKind,
  SwarmV2Verification, SwarmV2VerificationStatus,
} from './types.js';
import {
  arrayText, gate, MERGE_GATE_CODES, optionalText, text, V2Store, v2Now,
  type MergeGateCode,
} from './store.js';
import { budgetExhausted, getBudgetByScope } from './budget.js';

/**
 * Swarm v2 verification, structured sealed verdicts and merge gates
 * (SPEC §2D, invariants I11/I12/I13/I17/I18).
 *
 * Determinism rules enforced here:
 * - `runChecks` never executes anything: `command.exit` only consumes a
 *   caller-supplied `{exitCode,stdout,stderr}` result (or an executor callback
 *   the caller owns); every result is persisted as a `swarm_v2_evidence` row.
 * - A verdict is structured, sealed and bound to an exact candidate tip.
 *   Reviewer independence (role, author, owner, session) is validated before
 *   the row is written; stale tips are rejected and journaled.
 * - `evaluateMergeGates` returns exactly G01–G20 in MERGE_GATE_CODES order,
 *   computed from store state + caller-supplied observations, and never writes.
 * - `integrateTask` can only apply an allowed candidate that carries a sealed,
 *   applied verdict; rejection keeps the task untouched and writes a receipt.
 *   A silently merged candidate is impossible: `assertNoSilentMerge` must be 0.
 */

export const CHECK_KINDS = ['file.exists', 'file.hash', 'json.schema', 'source.coverage', 'command.exit'] as const;
export type CheckKind = typeof CHECK_KINDS[number];
export const RISK_LEVELS: SwarmV2Risk[] = ['V0', 'V1', 'V2', 'V3'];

const DEFAULT_ACTOR: SwarmV2Actor = { kind: 'system', id: 'swarm-v2-verification' };
const MAX_FINDINGS = 50;
const MAX_CHECKS = 256;
const STALE = { binding: 'stale-tip' as SwarmV2Binding };

export interface CommandResultInput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface SwarmV2CheckSpec {
  checkId?: string;
  id?: string;
  kind: string;
  path?: string;
  expected?: string;
  expectedExitCode?: number;
  requiredKeys?: string[];
  data?: unknown;
  sourceIds?: string[];
  requiredSourceIds?: string[];
  claims?: (string | { claim: string; sourceIds: string[] })[];
  claimSources?: Record<string, string[]>;
  result?: CommandResultInput;
  command?: string;
  detail?: string;
}

export interface RunChecksInput {
  teamId: string;
  taskId?: string | null;
  attemptId?: string | null;
  verificationId?: string | null;
  checks: SwarmV2CheckSpec[];
  artifacts?: Record<string, unknown>;
  files?: Record<string, unknown>;
  /** Caller-owned resolver for command.exit results; runChecks itself never executes commands. */
  executor?: (spec: SwarmV2CheckSpec) => CommandResultInput | undefined;
  producer?: string;
  actor?: SwarmV2Actor;
}

export interface StartVerificationInput {
  teamId: string;
  taskId: string;
  attemptId?: string | null;
  candidateDigest: string;
  level: SwarmV2Risk;
  checks?: (SwarmV2CheckSpec | SwarmV2CheckResult)[];
  actor?: SwarmV2Actor;
}

export interface SubmitVerdictInput {
  verificationId: string;
  kind: SwarmV2VerdictKind;
  reviewerMemberId: string;
  sessionId?: string | null;
  sessionFile?: string | null;
  approved: boolean;
  findings?: string[];
  taskIds: string[];
  resultVersions: Record<string, number>;
  candidateDigest: string;
  reviewedTip: string;
  binding?: SwarmV2Binding;
  actor?: SwarmV2Actor;
}

export interface MergeGateInput {
  taskId: string;
  candidateDigest: string;
  verdictId?: string | null;
  targetBase?: string | null;
  targetHead?: string | null;
  workspaceClean?: boolean;
  humanApproval?: boolean;
  protectedPaths?: string[];
  changedPaths?: string[];
  workspaceReadable?: boolean;
  evidenceComplete?: boolean;
  receiptUnknown?: boolean;
}

export interface IntegrateFileInput {
  path: string;
  content?: string;
  digest?: string;
}

export interface IntegrateTaskInput {
  taskId: string;
  candidateDigest: string;
  verdictId?: string | null;
  gateInput?: Omit<MergeGateInput, 'taskId' | 'candidateDigest'>;
  files?: IntegrateFileInput[];
  operationId?: string;
  actor?: SwarmV2Actor;
}

interface TeamRow { team_id: string; status: string; policy_json: string }
interface TaskRow {
  task_id: string; team_id: string; revision: number; mode: string; risk: string; status: string;
  owner_member_id: string | null; current_attempt_id: string | null; result_revision: number;
  rework_count: number; requirement_version: number; acceptance_json: string; checks_ref: string | null;
  workspace_policy: string; logical_step_id: string; created_at: string; updated_at: string;
}
interface AttemptRow {
  attempt_id: string; task_id: string; number: number; status: string; member_id: string | null;
  generation: number; workspace_id: string | null; base_rev: string | null; requirement_version: number;
  started_at: string; finished_at: string | null; terminal_reason: string | null; summary: string | null;
  session_id: string | null; session_file: string | null; commit_sha: string | null;
  result_digest: string | null; candidate_tip: string | null; evidence_refs_json: string;
}
interface MemberRow { member_id: string; team_id: string; role: string; phase: string; session_id: string | null }
interface VerificationRow {
  verification_id: string; team_id: string; task_id: string; attempt_id: string | null;
  candidate_digest: string; contract_digest: string; level: string; status: string;
  checks_json: string; findings_json: string; created_at: string; updated_at: string;
}
interface VerdictRow {
  verdict_id: string; verification_id: string; team_id: string; task_id: string; kind: string;
  approved: number; findings_json: string; task_ids_json: string; result_versions_json: string;
  candidate_digest: string; reviewed_tip: string; binding: string; reviewer_member_id: string;
  session_id: string | null; session_file: string | null; sealed: number; created_at: string;
}
interface ReceiptRow {
  task_id: string; team_id: string; operation_id: string; status: string; files_json: string;
  candidate_digest: string; verdict_id: string | null; baseline_digest: string | null; applied_at: string;
}

function plainMap(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new CapabilityError('VALIDATION_ERROR', `${field} 必须是对象`);
  return value as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDigest(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase().replace(/^sha256:/u, '');
  return /^[0-9a-f]{64}$/u.test(trimmed) ? trimmed : undefined;
}

function requireTeam(store: V2Store, teamId: string): TeamRow {
  const row = store.row<TeamRow>('SELECT team_id,status,policy_json FROM swarm_v2_teams WHERE team_id=?', teamId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '团队不存在');
  return row;
}

function readTask(store: V2Store, taskId: string): TaskRow {
  const row = store.row<TaskRow>('SELECT * FROM swarm_v2_tasks WHERE task_id=? AND tombstone=0', taskId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '任务不存在');
  return row;
}

function taskScopes(store: V2Store, taskId: string): string[] {
  return store.rows<{ scope: string }>('SELECT scope FROM swarm_v2_task_scopes WHERE task_id=? ORDER BY scope', taskId).map(row => String(row.scope));
}

function taskDependencies(store: V2Store, taskId: string): string[] {
  return store.rows<{ depends_on: string }>('SELECT depends_on FROM swarm_v2_task_dependencies WHERE task_id=? ORDER BY depends_on', taskId).map(row => String(row.depends_on));
}

function taskAcceptance(store: V2Store, taskId: string, task: TaskRow): string[] {
  try {
    const parsed = JSON.parse(String(task.acceptance_json));
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function contractDigest(store: V2Store, task: TaskRow): string {
  // Contract identity excludes the task's mutable revision/result counters: those are
  // bound separately by the sealed verdict (resultVersions) and never define the
  // acceptable requirement shape.
  return digest({
    v: 1, taskId: task.task_id,
    mode: task.mode, risk: task.risk, acceptance: taskAcceptance(store, task.task_id, task),
    checksRef: task.checks_ref, writeScopes: taskScopes(store, task.task_id),
    dependencies: taskDependencies(store, task.task_id), requirementVersion: Number(task.requirement_version),
    logicalStepId: task.logical_step_id, workspacePolicy: task.workspace_policy,
  });
}

function attemptsFor(store: V2Store, taskId: string): AttemptRow[] {
  return store.rows<AttemptRow>('SELECT * FROM swarm_v2_attempts WHERE task_id=? ORDER BY number DESC', taskId);
}

function latestAttempt(store: V2Store, taskId: string): AttemptRow | undefined {
  const attempts = attemptsFor(store, taskId);
  return attempts.find(attempt => attempt.status === 'completed') ?? attempts[0];
}

function mapVerification(row: VerificationRow): SwarmV2Verification {
  return {
    verificationId: String(row.verification_id),
    teamId: String(row.team_id),
    taskId: String(row.task_id),
    attemptId: row.attempt_id === null ? null : String(row.attempt_id),
    candidateDigest: String(row.candidate_digest),
    contractDigest: String(row.contract_digest),
    level: String(row.level) as SwarmV2Risk,
    status: String(row.status) as SwarmV2VerificationStatus,
    checks: JSON.parse(String(row.checks_json)) as SwarmV2CheckResult[],
    findings: JSON.parse(String(row.findings_json)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapVerdict(row: VerdictRow): SwarmV2Verdict {
  return {
    verdictId: String(row.verdict_id),
    verificationId: String(row.verification_id),
    teamId: String(row.team_id),
    taskId: String(row.task_id),
    kind: String(row.kind) as SwarmV2VerdictKind,
    approved: Number(row.approved) === 1,
    findings: JSON.parse(String(row.findings_json)) as string[],
    taskIds: JSON.parse(String(row.task_ids_json)) as string[],
    resultVersions: JSON.parse(String(row.result_versions_json)) as Record<string, number>,
    candidateDigest: String(row.candidate_digest),
    reviewedTip: String(row.reviewed_tip),
    binding: String(row.binding) as SwarmV2Binding,
    reviewerMemberId: String(row.reviewer_member_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    sessionFile: row.session_file === null ? null : String(row.session_file),
    sealed: Number(row.sealed) === 1,
    createdAt: String(row.created_at),
  };
}

function mapReceipt(row: ReceiptRow): SwarmV2ApplyReceipt {
  return {
    taskId: String(row.task_id),
    operationId: String(row.operation_id),
    status: String(row.status) as SwarmV2ApplyReceipt['status'],
    files: JSON.parse(String(row.files_json)) as SwarmV2ApplyReceipt['files'],
    candidateDigest: String(row.candidate_digest),
    verdictId: row.verdict_id === null ? null : String(row.verdict_id),
    baselineDigest: row.baseline_digest === null ? null : String(row.baseline_digest),
    at: String(row.applied_at),
  };
}

function readVerificationRow(store: V2Store, verificationId: string): VerificationRow {
  const row = store.row<VerificationRow>('SELECT * FROM swarm_v2_verifications WHERE verification_id=?', verificationId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '验证记录不存在');
  return row;
}

export function readVerification(store: V2Store, verificationId: string): SwarmV2Verification {
  return mapVerification(readVerificationRow(store, text(verificationId, 'verificationId')));
}

function readVerdictRow(store: V2Store, verdictId: string): VerdictRow {
  const row = store.row<VerdictRow>('SELECT * FROM swarm_v2_verdicts WHERE verdict_id=?', verdictId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', '裁决不存在');
  return row;
}

function verdictsFor(store: V2Store, verificationId: string): SwarmV2Verdict[] {
  return store.rows<VerdictRow>('SELECT * FROM swarm_v2_verdicts WHERE verification_id=? ORDER BY created_at ASC', verificationId).map(mapVerdict);
}

function journal(store: V2Store, teamId: string, type: string, actor: SwarmV2Actor | undefined, aggregate: { kind: string; id: string; revision?: number }, data: Record<string, unknown>): void {
  store.journal(teamId, type, actor ?? DEFAULT_ACTOR, aggregate, data);
}

// ---------------------------------------------------------------------------
// Check registry (deterministic, never runs commands itself)
// ---------------------------------------------------------------------------

interface FileFact { exists: boolean; digest?: string; content?: string }

function fileFact(value: unknown, fromArtifacts: boolean): FileFact | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const digestValue = normalizeDigest(value);
    return digestValue ? { exists: true, digest: digestValue } : { exists: true, digest: digest(value), content: value };
  }
  if (!isObject(value)) return undefined;
  const digestValue = normalizeDigest(value.digest) ?? normalizeDigest(value.sha256);
  const content = typeof value.content === 'string' ? value.content : typeof value.text === 'string' ? value.text : undefined;
  if (digestValue || content !== undefined) return { exists: true, digest: digestValue ?? digest(content!), content };
  // Presence in an artifact map or an explicit exists/state field proves existence.
  if (fromArtifacts || value.exists === true || typeof value.state === 'string') return { exists: true };
  return undefined;
}

function lookupFile(files: Record<string, unknown>, artifacts: Record<string, unknown>, path: string): FileFact | undefined {
  const direct = fileFact(files[path], false);
  if (direct) return direct;
  for (const [key, value] of Object.entries(artifacts)) {
    if (key === path) return fileFact(value, true);
    if (isObject(value) && (value.path === path || value.target === path)) return fileFact(value, true);
  }
  return undefined;
}

function hasKey(value: unknown, dotted: string): boolean {
  let cursor: unknown = value;
  for (const part of dotted.split('.')) {
    if (!isObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return false;
    cursor = cursor[part];
  }
  return true;
}

interface CheckOutcome { passed: boolean; detail: string; exitCode?: number }

function evaluateCheck(input: RunChecksInput, spec: SwarmV2CheckSpec, files: Record<string, unknown>, artifacts: Record<string, unknown>): CheckOutcome {
  switch (spec.kind) {
    case 'file.exists': {
      const path = text(spec.path, 'file.exists.path', 1000);
      const fact = lookupFile(files, artifacts, path);
      return fact?.exists ? { passed: true, detail: `存在：${path}` } : { passed: false, detail: `缺失：${path}` };
    }
    case 'file.hash': {
      const path = text(spec.path, 'file.hash.path', 1000);
      const expected = normalizeDigest(spec.expected);
      if (!expected) throw new CapabilityError('VALIDATION_ERROR', 'file.hash.expected 必须是 sha256 摘要');
      const fact = lookupFile(files, artifacts, path);
      if (!fact?.digest) return { passed: false, detail: `无法读取摘要：${path}` };
      return fact.digest === expected
        ? { passed: true, detail: `${path} sha256 匹配` }
        : { passed: false, detail: `${path} 摘要不匹配（期望 ${expected.slice(0, 12)}…，实际 ${fact.digest.slice(0, 12)}…）` };
    }
    case 'json.schema': {
      const requiredKeys = arrayText(spec.requiredKeys, 'json.schema.requiredKeys', 64, 200);
      if (!requiredKeys.length) throw new CapabilityError('VALIDATION_ERROR', 'json.schema.requiredKeys 不能为空');
      let data: unknown = spec.data;
      if (data === undefined) {
        const path = text(spec.path, 'json.schema.path', 1000);
        const fact = lookupFile(files, artifacts, path);
        if (!fact?.content) return { passed: false, detail: `无法读取 JSON 文档：${path}` };
        try {
          data = JSON.parse(fact.content);
        } catch {
          return { passed: false, detail: `JSON 解析失败：${path}` };
        }
      }
      const missing = requiredKeys.filter(key => !hasKey(data, key));
      return missing.length
        ? { passed: false, detail: `缺少必需键：${missing.join(',')}` }
        : { passed: true, detail: `必需键齐全：${requiredKeys.length}` };
    }
    case 'source.coverage': {
      const sourceIds = arrayText(spec.sourceIds, 'source.coverage.sourceIds', 256, 300);
      const requiredSourceIds = arrayText(spec.requiredSourceIds, 'source.coverage.requiredSourceIds', 256, 300);
      const claims = spec.claims ?? [];
      if (!Array.isArray(claims) || claims.length > 256) throw new CapabilityError('VALIDATION_ERROR', 'source.coverage.claims 必须是有界数组');
      if (!sourceIds.length) return { passed: false, detail: '缺少 sourceIds' };
      const declared = new Set(sourceIds);
      const missingRequired = requiredSourceIds.filter(id => !declared.has(id));
      if (missingRequired.length) return { passed: false, detail: `缺少必需来源：${missingRequired.join(',')}` };
      for (const [index, claim] of claims.entries()) {
        if (typeof claim === 'string') {
          const mapped = spec.claimSources?.[claim];
          const ids = Array.isArray(mapped) ? mapped.filter(value => typeof value === 'string' && value.trim()) : [];
          if (!ids.length) return { passed: false, detail: `claim 缺少来源映射：${claim}` };
          const undeclared = ids.filter(id => !declared.has(id));
          if (undeclared.length) return { passed: false, detail: `claim 来源未声明：${undeclared.join(',')}` };
        } else if (isObject(claim) && typeof claim.claim === 'string') {
          const ids = Array.isArray(claim.sourceIds) ? claim.sourceIds.filter(value => typeof value === 'string' && value.trim()) : [];
          if (!ids.length) return { passed: false, detail: `claim 缺少来源：${claim.claim}` };
          const undeclared = ids.filter(id => !declared.has(id));
          if (undeclared.length) return { passed: false, detail: `claim 来源未声明：${undeclared.join(',')}` };
        } else {
          return { passed: false, detail: `非法 claim 条目 #${index + 1}` };
        }
      }
      return { passed: true, detail: `${sourceIds.length} 个来源覆盖 ${claims.length} 条 claim` };
    }
    case 'command.exit': {
      let result: unknown = spec.result;
      let source = '调用方提供';
      if (result === undefined && typeof input.executor === 'function') {
        try {
          result = input.executor(spec);
          source = 'executor 提供';
        } catch (error) {
          return { passed: false, detail: `executor 失败：${(error as Error).message}` };
        }
      }
      if (!isObject(result)) return { passed: false, detail: '缺少调用方提供的命令结果（本检查不执行命令）' };
      const exitCode = Number(result.exitCode);
      if (!Number.isInteger(exitCode)) return { passed: false, detail: '命令结果缺少整数 exitCode' };
      const expected = spec.expectedExitCode === undefined ? 0 : spec.expectedExitCode;
      if (!Number.isInteger(expected)) throw new CapabilityError('VALIDATION_ERROR', 'command.exit.expectedExitCode 必须是整数');
      const tail = typeof result.stderr === 'string' && result.stderr.trim() ? ` stderr=${result.stderr.trim().slice(0, 200)}` : '';
      return exitCode === expected
        ? { passed: true, exitCode, detail: `${source} exit=${exitCode}（期望 ${expected}）${tail}` }
        : { passed: false, exitCode, detail: `${source} exit=${exitCode}（期望 ${expected}）${tail}` };
    }
    default:
      return { passed: false, detail: `未知检查类型：${String(spec.kind)}` };
  }
}

/**
 * Run registered checks deterministically and persist every result as evidence.
 * `command.exit` consumes a caller-supplied result; no command is ever spawned.
 */
export function runChecks(store: V2Store, input: RunChecksInput): SwarmV2CheckResult[] {
  const teamId = text(input.teamId, 'teamId');
  requireTeam(store, teamId);
  const taskId = optionalText(input.taskId ?? null, 'taskId');
  const attemptId = optionalText(input.attemptId ?? null, 'attemptId');
  const verificationId = optionalText(input.verificationId ?? null, 'verificationId');
  const specs = input.checks;
  if (!Array.isArray(specs) || specs.length > MAX_CHECKS) throw new CapabilityError('VALIDATION_ERROR', 'checks 必须是有界数组');
  const files = plainMap(input.files, 'files');
  const artifacts = plainMap(input.artifacts, 'artifacts');
  const results: SwarmV2CheckResult[] = [];
  store.transaction(() => {
    for (const [index, raw] of specs.entries()) {
      if (!isObject(raw)) throw new CapabilityError('VALIDATION_ERROR', `checks[${index}] 必须是对象`);
      const spec = raw as unknown as SwarmV2CheckSpec;
      const checkId = text(spec.checkId ?? spec.id ?? `check-${index + 1}`, 'checkId', 200);
      const kind = typeof spec.kind === 'string' ? spec.kind.trim() : '';
      if (!kind) throw new CapabilityError('VALIDATION_ERROR', `checks[${index}] 缺少 kind`);
      const outcome = evaluateCheck(input, spec, files, artifacts);
      const evidenceId = randomUUID();
      const payload = {
        v: 1, teamId, taskId, attemptId, verificationId, checkId, kind,
        passed: outcome.passed, detail: outcome.detail, exitCode: outcome.exitCode ?? null,
        spec: { ...spec, result: spec.result === undefined ? undefined : { exitCode: spec.result.exitCode } },
      };
      store.db.prepare(`INSERT INTO swarm_v2_evidence(evidence_id,team_id,task_id,attempt_id,kind,ref,digest,producer,payload_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(evidenceId, teamId, taskId, attemptId, 'check', checkId, digest(payload), input.producer ?? 'swarm-v2-checks', JSON.stringify(payload), v2Now());
      results.push({
        checkId, kind, passed: outcome.passed,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        detail: outcome.detail, evidenceRef: evidenceId,
      });
    }
  });
  return results;
}

/** Start (or reuse) the verification of one delivered candidate. */
export function startVerification(store: V2Store, input: StartVerificationInput): SwarmV2Verification {
  const teamId = text(input.teamId, 'teamId');
  requireTeam(store, teamId);
  const taskId = text(input.taskId, 'taskId');
  const task = readTask(store, taskId);
  if (task.team_id !== teamId) throw new CapabilityError('VALIDATION_ERROR', '任务不属于该团队');
  if (task.status !== 'delivered') throw new CapabilityError('VALIDATION_ERROR', `任务必须处于 delivered 才能开始验证（当前 ${task.status}）`);
  const candidateDigest = text(input.candidateDigest, 'candidateDigest', 500);
  const level = input.level;
  if (!RISK_LEVELS.includes(level)) throw new CapabilityError('VALIDATION_ERROR', '验证等级必须是 V0/V1/V2/V3');
  const checksInput = input.checks ?? [];
  if (!Array.isArray(checksInput) || checksInput.length > MAX_CHECKS) throw new CapabilityError('VALIDATION_ERROR', 'checks 必须是有界数组');
  let attemptId: string | null = null;
  const requested = optionalText(input.attemptId ?? null, 'attemptId');
  if (requested) {
    const attempt = store.row<AttemptRow>('SELECT * FROM swarm_v2_attempts WHERE attempt_id=?', requested);
    if (!attempt || attempt.task_id !== taskId) throw new CapabilityError('VALIDATION_ERROR', 'attempt 不属于该任务');
    attemptId = requested;
  } else {
    const current = task.current_attempt_id
      ? store.row<AttemptRow>('SELECT * FROM swarm_v2_attempts WHERE attempt_id=?', task.current_attempt_id)
      : undefined;
    attemptId = current?.attempt_id ?? latestAttempt(store, taskId)?.attempt_id ?? null;
  }
  return store.transaction(() => {
    const existing = store.row<VerificationRow>("SELECT * FROM swarm_v2_verifications WHERE team_id=? AND task_id=? AND candidate_digest=? ORDER BY created_at DESC LIMIT 1", teamId, taskId, candidateDigest);
    if (existing) return mapVerification(existing);
    // A caller may hand already-produced results (has `passed`) to seed the record; runChecks/recordChecks remain the normal path.
    const seeded = checksInput.filter((check): check is SwarmV2CheckResult => isObject(check) && typeof check.passed === 'boolean');
    const verificationId = randomUUID();
    const now = v2Now();
    store.db.prepare(`INSERT INTO swarm_v2_verifications(verification_id,team_id,task_id,attempt_id,candidate_digest,contract_digest,level,status,checks_json,findings_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'checking',?, '[]',?,?)`)
      .run(verificationId, teamId, taskId, attemptId, candidateDigest, contractDigest(store, task), level, JSON.stringify(seeded), now, now);
    journal(store, teamId, 'verification.started', input.actor, { kind: 'verification', id: verificationId }, {
      taskId, attemptId, candidateDigest, level, checks: checksInput.length,
    });
    return mapVerification(readVerificationRow(store, verificationId));
  });
}

/** Append/replace check results. Any failure moves the verification to failed. */
export function recordChecks(store: V2Store, verificationId: string, results: SwarmV2CheckResult[]): SwarmV2Verification {
  const id = text(verificationId, 'verificationId');
  if (!Array.isArray(results) || results.length > MAX_CHECKS) throw new CapabilityError('VALIDATION_ERROR', 'results 必须是有界数组');
  const normalized = results.map((raw, index) => {
    if (!isObject(raw)) throw new CapabilityError('VALIDATION_ERROR', `results[${index}] 必须是对象`);
    const checkId = text(raw.checkId, 'checkId', 200);
    const kind = text(raw.kind, 'kind', 100);
    if (typeof raw.passed !== 'boolean') throw new CapabilityError('VALIDATION_ERROR', `results[${index}].passed 必须是布尔值`);
    if (raw.exitCode !== undefined && !Number.isInteger(raw.exitCode)) throw new CapabilityError('VALIDATION_ERROR', `results[${index}].exitCode 必须是整数`);
    if (raw.detail !== undefined && typeof raw.detail !== 'string') throw new CapabilityError('VALIDATION_ERROR', `results[${index}].detail 必须是字符串`);
    if (raw.evidenceRef !== undefined && typeof raw.evidenceRef !== 'string') throw new CapabilityError('VALIDATION_ERROR', `results[${index}].evidenceRef 必须是字符串`);
    return { ...raw, checkId, kind } as SwarmV2CheckResult;
  });
  return store.transaction(() => {
    const current = mapVerification(readVerificationRow(store, id));
    if (current.status === 'passed' || current.status === 'stale') throw new CapabilityError('VERSION_CONFLICT', '验证已终态，不能追加检查结果');
    if (!normalized.length) return current;
    const merged = new Map<string, SwarmV2CheckResult>();
    for (const check of current.checks) merged.set(check.checkId, check);
    for (const check of normalized) merged.set(check.checkId, check);
    const checks = [...merged.values()];
    const failed = checks.filter(check => !check.passed).length;
    const status: SwarmV2VerificationStatus = failed ? 'failed' : 'reviewing';
    store.db.prepare('UPDATE swarm_v2_verifications SET checks_json=?,status=?,updated_at=? WHERE verification_id=?')
      .run(JSON.stringify(checks), status, v2Now(), id);
    journal(store, current.teamId, 'verification.checked', undefined, { kind: 'verification', id }, {
      taskId: current.taskId, checks: checks.length, failed, status,
    });
    return mapVerification(readVerificationRow(store, id));
  });
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** Verdict kinds required to apply a verified candidate at each risk level. */
export function requiredVerdictKinds(risk: SwarmV2Risk): SwarmV2VerdictKind[] {
  switch (risk) {
    case 'V0': return [];
    case 'V1': return ['reviewer'];
    case 'V2': return ['reviewer', 'verifier'];
    case 'V3': return ['reviewer', 'verifier'];
    default: throw new CapabilityError('VALIDATION_ERROR', '未知风险等级');
  }
}

/** Independent reviewer verdicts required per risk (V3 needs a second reviewer). */
export function requiredVerdictReviewers(risk: SwarmV2Risk): number {
  switch (risk) {
    case 'V0': return 0;
    case 'V1': return 1;
    case 'V2': return 1;
    case 'V3': return 2;
    default: throw new CapabilityError('VALIDATION_ERROR', '未知风险等级');
  }
}

/**
 * Reviewers are only independent when they run in a distinct session. The
 * session is mandatory (a missing sessionId must never bypass independence) and
 * is compared with both the attempt session and the author member's session.
 */
function requireIndependentReviewer(store: V2Store, teamId: string, task: TaskRow, attempt: AttemptRow | undefined, input: SubmitVerdictInput, kind: SwarmV2VerdictKind): {member: MemberRow; sessionId: string; sessionFile: string | null} {
  const reviewerMemberId = text(input.reviewerMemberId, 'reviewerMemberId');
  const member = store.row<MemberRow>('SELECT * FROM swarm_v2_members WHERE member_id=?', reviewerMemberId);
  if (!member) throw new CapabilityError('PERMISSION_DENIED', '复核成员不存在');
  if (member.team_id !== teamId) throw new CapabilityError('PERMISSION_DENIED', '复核成员不属于该团队');
  const expectedRole = kind === 'reviewer' ? 'reviewer' : 'verifier';
  if (member.role !== expectedRole) throw new CapabilityError('PERMISSION_DENIED', `${kind} 裁决需要 ${expectedRole} 角色`);
  if (attempt?.member_id && attempt.member_id === member.member_id) throw new CapabilityError('PERMISSION_DENIED', '作者不能复核自己的交付物');
  if (task.owner_member_id && task.owner_member_id === member.member_id) throw new CapabilityError('PERMISSION_DENIED', '任务 owner 不能复核自己的任务');
  const sessionId = text(input.sessionId, 'sessionId', 400);
  const sessionFile = input.sessionFile === undefined || input.sessionFile === null ? null : text(input.sessionFile, 'sessionFile', 2000);
  if (attempt?.session_id && sessionId === attempt.session_id) throw new CapabilityError('PERMISSION_DENIED', '复核会话必须独立于作者会话');
  const authorMember = attempt?.member_id ? store.row<MemberRow>('SELECT * FROM swarm_v2_members WHERE member_id=?', attempt.member_id) : undefined;
  if (authorMember?.session_id && sessionId === authorMember.session_id) throw new CapabilityError('PERMISSION_DENIED', '复核会话必须独立于作者成员会话');
  return {member, sessionId, sessionFile};
}

function validateResultVersions(store: V2Store, taskIds: string[], versions: Record<string, number>): Record<string, number> {
  const entries = Object.entries(versions);
  if (!entries.length) throw new CapabilityError('VALIDATION_ERROR', 'resultVersions 不能为空');
  const normalized: Record<string, number> = {};
  for (const [taskId, revision] of entries) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new CapabilityError('VALIDATION_ERROR', 'resultVersions 必须是正整数');
    const task = readTask(store, taskId);
    if (Number(task.result_revision) !== revision) throw new CapabilityError('VERSION_CONFLICT', `resultVersions 与任务当前结果版本不一致：${taskId}`);
    normalized[taskId] = revision;
  }
  return normalized;
}

function validateFindings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) throw new CapabilityError('VALIDATION_ERROR', `findings 必须是不超过 ${MAX_FINDINGS} 条的数组`);
  return value.map((finding, index) => {
    if (typeof finding !== 'string' || !finding.trim()) throw new CapabilityError('VALIDATION_ERROR', `findings[${index}] 必须是非空字符串`);
    if (finding.length > 2000) throw new CapabilityError('VALIDATION_ERROR', `findings[${index}] 过长`);
    return finding.trim();
  });
}

/** Persist a stale-tip rejection in its own transaction so a later clean-rebase waiver can cite it. */
function recordStaleTipRejection(store: V2Store, verification: { teamId: string; verificationId: string; candidateDigest: string }, reviewedTip: string, currentTip: string | null): void {
  store.transaction(() => {
    journal(store, verification.teamId, 'verdict.stale_rejected', undefined, { kind: 'verification', id: verification.verificationId }, {
      reviewedTip, currentTip, candidateDigest: verification.candidateDigest, binding: 'stale-tip',
    });
  });
}

/**
 * Submit one structured, sealed verdict. Free text is never accepted; the
 * verdict is bound to the exact candidate tip unless a clean-rebase waiver was
 * preceded by a recorded stale-tip rejection.
 */
export function submitVerdict(store: V2Store, input: SubmitVerdictInput): SwarmV2Verdict {
  const verificationId = text(input.verificationId, 'verificationId');
  const kind = input.kind;
  if (kind !== 'reviewer' && kind !== 'verifier') throw new CapabilityError('VALIDATION_ERROR', '裁决 kind 必须是 reviewer/verifier');
  const ver = mapVerification(readVerificationRow(store, verificationId));
  const task = readTask(store, ver.taskId);
  if (task.team_id !== ver.teamId) throw new CapabilityError('VALIDATION_ERROR', '验证任务不属于团队');
  if (ver.status === 'failed') throw new CapabilityError('VERSION_CONFLICT', '客观检查未通过，不能提交复核裁决');
  if (ver.status === 'passed') throw new CapabilityError('VERSION_CONFLICT', '验证已通过，不能追加裁决');
  if (ver.status === 'stale') throw new CapabilityError('VERSION_CONFLICT', '验证已失效，请重新开始验证');
  if (ver.status !== 'reviewing') throw new CapabilityError('VALIDATION_ERROR', '客观检查尚未完成，不能提交裁决');
  const attempt = ver.attemptId ? store.row<AttemptRow>('SELECT * FROM swarm_v2_attempts WHERE attempt_id=?', ver.attemptId) : latestAttempt(store, ver.taskId);
  if (!attempt) throw new CapabilityError('VALIDATION_ERROR', '缺少 attempt 记录，无法绑定 exact-tip');
  const {member, sessionId, sessionFile} = requireIndependentReviewer(store, ver.teamId, task, attempt, input, kind);
  if (typeof input.approved !== 'boolean') throw new CapabilityError('VALIDATION_ERROR', 'approved 必须是布尔值');
  const findings = validateFindings(input.findings);
  const candidateDigest = text(input.candidateDigest, 'candidateDigest', 500);
  if (candidateDigest !== ver.candidateDigest) throw new CapabilityError('VERSION_CONFLICT', '候选摘要与验证记录不一致');
  const taskIds = arrayText(input.taskIds, 'taskIds', 64, 200);
  if (!taskIds.length) throw new CapabilityError('VALIDATION_ERROR', 'taskIds 不能为空');
  if (!taskIds.includes(ver.taskId)) throw new CapabilityError('VALIDATION_ERROR', 'taskIds 必须包含被裁决任务');
  for (const taskId of taskIds) {
    const target = store.row<{ team_id: string }>('SELECT team_id FROM swarm_v2_tasks WHERE task_id=? AND tombstone=0', taskId);
    if (!target || target.team_id !== ver.teamId) throw new CapabilityError('VALIDATION_ERROR', `归因任务不存在或不属于团队：${taskId}`);
  }
  const resultVersions = validateResultVersions(store, taskIds, input.resultVersions ?? {});
  if (!Object.prototype.hasOwnProperty.call(resultVersions, ver.taskId)) throw new CapabilityError('VALIDATION_ERROR', 'resultVersions 必须包含被裁决任务');
  const reviewedTip = text(input.reviewedTip, 'reviewedTip', 500);
  const requestedBinding = input.binding ?? 'exact-tip';
  if (requestedBinding !== 'exact-tip' && requestedBinding !== 'clean-rebase-waived' && requestedBinding !== 'stale-tip') {
    throw new CapabilityError('VALIDATION_ERROR', 'binding 必须是 exact-tip/clean-rebase-waived');
  }
  if (requestedBinding === 'stale-tip') throw new CapabilityError('VALIDATION_ERROR', '不能用 stale-tip 封存裁决');
  const currentTip = attempt.candidate_tip === null ? null : String(attempt.candidate_tip);
  // Fail closed: a write task cannot be sealed against a missing candidate tip.
  if (task.mode === 'write' && (currentTip === null || !currentTip.trim())) {
    throw new CapabilityError('VALIDATION_ERROR', 'exact-tip 需要候选 tip');
  }
  if (currentTip !== null && reviewedTip !== currentTip) {
    // A stale verdict is never stored; the rejection itself is journaled (own
    // transaction, so it survives the throw) so a later clean-rebase waiver can cite it.
    recordStaleTipRejection(store, { teamId: ver.teamId, verificationId, candidateDigest: ver.candidateDigest }, reviewedTip, currentTip);
    throw new CapabilityError('STALE_TIP' as never, '复核 tip 已变化，旧裁决不能封存', { binding: STALE.binding, reviewedTip, currentTip });
  }
  return store.transaction(() => {
    const recheckTip = attempt.candidate_tip === null ? null : String(attempt.candidate_tip);
    if (task.mode === 'write' && (recheckTip === null || !recheckTip.trim())) {
      throw new CapabilityError('VALIDATION_ERROR', 'exact-tip 需要候选 tip');
    }
    if (recheckTip !== null && reviewedTip !== recheckTip) {
      throw new CapabilityError('STALE_TIP' as never, '复核 tip 在提交期间发生变化', { binding: STALE.binding, reviewedTip, currentTip: recheckTip });
    }
    let binding: SwarmV2Binding = 'exact-tip';
    if (requestedBinding === 'clean-rebase-waived') {
      const prior = store.row<{ n: number }>("SELECT COUNT(*) AS n FROM swarm_v2_journal WHERE team_id=? AND type='verdict.stale_rejected' AND aggregate_id=?", ver.teamId, verificationId);
      if (Number(prior?.n ?? 0) < 1) throw new CapabilityError('VALIDATION_ERROR', 'clean-rebase waive 需要先前的 stale-tip 拒绝记录');
      binding = 'clean-rebase-waived';
    }
    const sameKind = verdictsFor(store, verificationId).filter(verdict => verdict.kind === kind);
    if (kind === 'reviewer' && ver.level === 'V3' && sameKind.length < requiredVerdictReviewers(ver.level)) {
      const sessions = new Set(sameKind.filter(verdict => verdict.approved && verdict.sessionId).map(verdict => verdict.sessionId));
      if (input.sessionId && sessions.has(input.sessionId)) throw new CapabilityError('PERMISSION_DENIED', 'V3 第二复核必须使用不同会话');
    }
    const reviewersNeeded = requiredVerdictReviewers(ver.level);
    const secondIndependentReviewer = ver.level === 'V3' && kind === 'reviewer' && sameKind.length < reviewersNeeded
      && sameKind.every(verdict => verdict.reviewerMemberId !== member.member_id);
    if (sameKind.length && !secondIndependentReviewer) throw new CapabilityError('VERSION_CONFLICT', '同一 verification 同 kind 只接受一次封存裁决');
    const verdictId = randomUUID();
    store.db.prepare(`INSERT INTO swarm_v2_verdicts(verdict_id,verification_id,team_id,task_id,kind,approved,findings_json,task_ids_json,result_versions_json,candidate_digest,reviewed_tip,binding,reviewer_member_id,session_id,session_file,sealed,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(verdictId, verificationId, ver.teamId, ver.taskId, kind, input.approved ? 1 : 0, JSON.stringify(findings), JSON.stringify(taskIds), JSON.stringify(resultVersions), candidateDigest, reviewedTip, binding, member.member_id, sessionId, sessionFile, v2Now());
    journal(store, ver.teamId, 'verdict.recorded', input.actor, { kind: 'verification', id: verificationId }, {
      verdictId, kind, approved: input.approved, reviewerMemberId: member.member_id, binding, reviewedTip, candidateDigest, taskIds, resultVersions,
    });
    return mapVerdict(readVerdictRow(store, verdictId));
  });
}

interface ApplyReason { code: string; detail: string }

function collectApplyReasons(store: V2Store, ver: SwarmV2Verification, task: TaskRow, attempt: AttemptRow | undefined): ApplyReason[] {
  const reasons: ApplyReason[] = [];
  // The contract captured when verification started is frozen; task requirement
  // changes (revision/requirementVersion scopes/acceptance) invalidate the verdict.
  if (contractDigest(store, task) !== ver.contractDigest) reasons.push({ code: 'contract-stale', detail: '任务契约在验证后发生变化' });
  if (!ver.checks.length) reasons.push({ code: 'checks-missing', detail: '缺少客观检查结果' });
  else {
    const failed = ver.checks.filter(check => !check.passed);
    if (failed.length) reasons.push({ code: 'checks-failed', detail: `客观检查未通过：${failed.map(check => check.checkId).join(',')}` });
  }
  const verdicts = verdictsFor(store, ver.verificationId);
  const required = requiredVerdictKinds(ver.level);
  const approved = verdicts.filter(verdict => verdict.approved && verdict.sealed);
  for (const kind of required) {
    const ofKind = verdicts.filter(verdict => verdict.kind === kind);
    if (!ofKind.some(verdict => verdict.approved && verdict.sealed)) reasons.push({ code: `verdict-missing-${kind}`, detail: `缺少通过的 ${kind} 裁决` });
    const rejected = ofKind.filter(verdict => !verdict.approved);
    if (rejected.length) reasons.push({ code: `verdict-rejected-${kind}`, detail: `${kind} 裁决未通过：${rejected.flatMap(verdict => verdict.findings).join('；').slice(0, 300)}` });
  }
  if (requiredVerdictReviewers(ver.level) >= 2) {
    const reviewerMembers = new Set(approved.filter(verdict => verdict.kind === 'reviewer').map(verdict => verdict.reviewerMemberId));
    if (reviewerMembers.size < requiredVerdictReviewers(ver.level)) reasons.push({ code: 'verdict-missing-second-reviewer', detail: 'V3 需要第二位独立 reviewer' });
  }
  // Independence is re-checked at apply time because members/tasks may change.
  const attemptMember = attempt?.member_id ?? null;
  for (const verdict of approved) {
    if (attemptMember && verdict.reviewerMemberId === attemptMember) reasons.push({ code: 'verdict-not-independent', detail: '复核者与作者相同' });
    if (task.owner_member_id && verdict.reviewerMemberId === task.owner_member_id) reasons.push({ code: 'verdict-not-independent', detail: '复核者是任务 owner' });
  }
  const reviewerSessions = new Set(approved.filter(verdict => verdict.kind === 'reviewer' && verdict.sessionId).map(verdict => verdict.sessionId));
  const verifierSessions = new Set(approved.filter(verdict => verdict.kind === 'verifier' && verdict.sessionId).map(verdict => verdict.sessionId));
  if (required.includes('verifier') && reviewerSessions.size && verifierSessions.size) {
    for (const session of reviewerSessions) if (verifierSessions.has(session)) reasons.push({ code: 'verdict-shared-session', detail: 'reviewer 与 verifier 必须使用不同会话' });
  }
  const currentTip = attempt?.candidate_tip === null || attempt === undefined ? null : String(attempt.candidate_tip);
  for (const verdict of approved) {
    if (verdict.binding === 'stale-tip') reasons.push({ code: 'verdict-stale-tip', detail: '存在 stale-tip 裁决' });
    if (currentTip !== null && verdict.binding !== 'clean-rebase-waived' && verdict.reviewedTip !== currentTip) {
      reasons.push({ code: 'verdict-stale-tip', detail: '候选 tip 已变化，旧裁决失效' });
    }
    for (const [taskId, revision] of Object.entries(verdict.resultVersions)) {
      const target = store.row<{ result_revision: number }>('SELECT result_revision FROM swarm_v2_tasks WHERE task_id=?', taskId);
      if (!target || Number(target.result_revision) !== revision) reasons.push({ code: 'verdict-stale-versions', detail: `结果版本已变化：${taskId}` });
    }
    if (verdict.candidateDigest !== ver.candidateDigest) reasons.push({ code: 'verdict-candidate-mismatch', detail: '裁决候选与验证候选不一致' });
  }
  return reasons;
}

/**
 * Recompute the terminal verification state from checks + verdicts. Passing
 * moves the delivered task to verified; missing/invalid evidence never passes.
 */
export function applyVerdict(store: V2Store, verdictId: string): SwarmV2Verification {
  const id = text(verdictId, 'verdictId');
  const verdict = mapVerdict(readVerdictRow(store, id));
  if (!verdict.sealed) throw new CapabilityError('VALIDATION_ERROR', '未封存裁决不能应用');
  const ver = mapVerification(readVerificationRow(store, verdict.verificationId));
  const task = readTask(store, ver.taskId);
  if (ver.status === 'passed') return ver;
  if (ver.status === 'checking') throw new CapabilityError('VALIDATION_ERROR', '检查尚未完成，不能应用裁决');
  const attempt = ver.attemptId ? store.row<AttemptRow>('SELECT * FROM swarm_v2_attempts WHERE attempt_id=?', ver.attemptId) : latestAttempt(store, ver.taskId);
  return store.transaction(() => {
    // Re-read inside the transaction so a concurrent requirement change (CAS
    // revision / requirement version) is detected by the frozen contract digest.
    const currentTask = readTask(store, ver.taskId);
    const reasons = collectApplyReasons(store, ver, currentTask, attempt);
    const now = v2Now();
    if (reasons.length) {
      const stale = reasons.some(reason => reason.code === 'verdict-stale-tip' || reason.code === 'verdict-stale-versions' || reason.code === 'verdict-candidate-mismatch' || reason.code === 'contract-stale');
      const status: SwarmV2VerificationStatus = stale ? 'stale' : 'failed';
      store.db.prepare('UPDATE swarm_v2_verifications SET status=?,findings_json=?,updated_at=? WHERE verification_id=?')
        .run(status, JSON.stringify([...new Set(reasons.map(reason => reason.detail))]), now, ver.verificationId);
      journal(store, ver.teamId, 'verification.rejected', undefined, { kind: 'verification', id: ver.verificationId }, {
        taskId: ver.taskId, status, reasons,
      });
      return mapVerification(readVerificationRow(store, ver.verificationId));
    }
    store.db.prepare("UPDATE swarm_v2_verifications SET status='passed',findings_json='[]',updated_at=? WHERE verification_id=?").run(now, ver.verificationId);
    if (currentTask.status === 'delivered') {
      // A read-only task has nothing to merge: verification completes it directly.
      const targetStatus = currentTask.mode === 'read' ? 'done' : 'verified';
      store.db.prepare("UPDATE swarm_v2_tasks SET status=?,revision=revision+1,updated_at=? WHERE task_id=? AND status='delivered'").run(targetStatus, now, currentTask.task_id);
      journal(store, ver.teamId, 'task.transitioned', undefined, { kind: 'task', id: currentTask.task_id, revision: Number(currentTask.revision) + 1 }, {
        from: 'delivered', to: targetStatus, action: 'verify', verificationId: ver.verificationId,
      });
    }
    journal(store, ver.teamId, 'verification.applied', undefined, { kind: 'verification', id: ver.verificationId }, {
      taskId: ver.taskId, verdictId: id, verdictIds: verdictsFor(store, ver.verificationId).filter(item => item.approved).map(item => item.verdictId), taskStatus: 'verified',
    });
    return mapVerification(readVerificationRow(store, ver.verificationId));
  });
}

/** Summarize how complete the verdict set is for a risk level. */
export function verificationStatusFor(risk: SwarmV2Risk, verdicts: SwarmV2Verdict[]): SwarmV2VerificationStatus {
  const required = requiredVerdictKinds(risk);
  const approved = verdicts.filter(verdict => verdict.approved && verdict.sealed);
  if (verdicts.some(verdict => verdict.binding === 'stale-tip')) return 'stale';
  if (!required.length) return 'passed';
  if (verdicts.some(verdict => !verdict.approved)) return 'failed';
  for (const kind of required) if (!approved.some(verdict => verdict.kind === kind)) return 'reviewing';
  if (requiredVerdictReviewers(risk) >= 2) {
    const reviewers = new Set(approved.filter(verdict => verdict.kind === 'reviewer').map(verdict => verdict.reviewerMemberId));
    if (reviewers.size < requiredVerdictReviewers(risk)) return 'reviewing';
  }
  return 'passed';
}

// ---------------------------------------------------------------------------
// Merge gates G01–G20
// ---------------------------------------------------------------------------

/** Directory/file scope containment (mirrors write-claim scope semantics). */
function normalizeScopePath(value: string): string | null {
  const normalized = posix.normalize(value.replace(/\/+$/u, ''));
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized;
}

function scopeCovers(scope: string, path: string): boolean {
  const normalized = scope.replace(/\/+$/u, '');
  if (!normalized || normalized === '.') return true;
  const base = normalizeScopePath(normalized);
  const target = normalizeScopePath(path);
  if (!base || !target) return false;
  return target === base || target.startsWith(`${base}/`);
}

function scopeOverlap(left: string, right: string): boolean {
  return scopeCovers(left, right.replace(/\/+$/u, '')) || scopeCovers(right, left.replace(/\/+$/u, ''));
}

function resultVersionsMatch(store: V2Store, versions: Record<string, number>): boolean {
  const entries = Object.entries(versions);
  if (!entries.length) return false;
  return entries.every(([taskId, revision]) => {
    const task = store.row<{ result_revision: number }>('SELECT result_revision FROM swarm_v2_tasks WHERE task_id=? AND tombstone=0', taskId);
    return !!task && Number(task.result_revision) === revision;
  });
}

function protectedPathList(team: TeamRow, input: MergeGateInput): string[] {
  const policy = (() => { try { return JSON.parse(String(team.policy_json)) as Record<string, unknown>; } catch { return {}; } })();
  const fromPolicy = Array.isArray(policy.protectedPaths) ? policy.protectedPaths.filter((value): value is string => typeof value === 'string') : [];
  return [...new Set([...fromPolicy, ...(input.protectedPaths ?? []).filter(value => typeof value === 'string' && value.trim())])];
}

function receiptsFor(store: V2Store, taskId: string): ReceiptRow | undefined {
  return store.row<ReceiptRow>('SELECT * FROM swarm_v2_apply_receipts WHERE task_id=?', taskId);
}

/**
 * Evaluate all 20 merge gates in MERGE_GATE_CODES order from store state plus
 * caller-supplied observations. Any state that cannot be read fails the gate.
 */
export function evaluateMergeGates(store: V2Store, input: MergeGateInput): SwarmV2MergeDecision {
  const taskId = text(input.taskId, 'taskId');
  const candidateDigest = text(input.candidateDigest, 'candidateDigest', 500);
  const task = readTask(store, taskId);
  const team = requireTeam(store, task.team_id);
  const attempts = attemptsFor(store, taskId);
  const latest = latestAttempt(store, taskId);
  const deps = taskDependencies(store, taskId);
  const changedPaths = input.changedPaths === undefined ? undefined : arrayText(input.changedPaths, 'changedPaths', 512, 1000);
  const scopes = taskScopes(store, taskId);
  const protectedPaths = protectedPathList(team, input);

  const verification = (() => {
    if (input.verdictId) {
      const verdictRow = store.row<VerdictRow>('SELECT * FROM swarm_v2_verdicts WHERE verdict_id=?', input.verdictId);
      if (!verdictRow || String(verdictRow.task_id) !== taskId) return undefined;
      return mapVerification(readVerificationRow(store, String(verdictRow.verification_id)));
    }
    const rows = store.rows<VerificationRow>('SELECT * FROM swarm_v2_verifications WHERE team_id=? AND task_id=? ORDER BY created_at DESC', task.team_id, taskId).map(mapVerification);
    return rows.find(row => row.candidateDigest === candidateDigest) ?? rows[0];
  })();
  const verdicts = verification ? verdictsFor(store, verification.verificationId) : [];
  const verdict = (() => {
    if (input.verdictId) {
      const row = store.row<VerdictRow>('SELECT * FROM swarm_v2_verdicts WHERE verdict_id=?', input.verdictId);
      return row && String(row.task_id) === taskId ? mapVerdict(row) : undefined;
    }
    return verdicts.find(item => item.approved) ?? verdicts[0];
  })();

  const gates: SwarmV2MergeGate[] = [];
  const add = (code: MergeGateCode, passed: boolean, detail: string) => gates.push(gate(code, passed, detail));

  // G01 task_not_done: only a verified write task may be merged.
  add('G01', task.mode === 'write' && task.status === 'verified', `mode=${task.mode} status=${task.status}`);
  // G02 open_dependencies: every dependency is done or deleted.
  const openDeps = deps.filter(depTaskId => {
    const dep = store.row<{ status: string }>('SELECT status FROM swarm_v2_tasks WHERE task_id=?', depTaskId);
    return !dep || !['done', 'deleted'].includes(dep.status);
  });
  add('G02', openDeps.length === 0, openDeps.length ? `未完成依赖：${openDeps.join(',')}` : `${deps.length} 个依赖已完成`);
  // G03 attempt_running: no running attempt on this task.
  add('G03', !attempts.some(attempt => attempt.status === 'running'), attempts.some(attempt => attempt.status === 'running') ? '存在 running attempt' : '无运行中 attempt');
  // G04 unknown_side_effects: no unknown attempt on this task.
  add('G04', !attempts.some(attempt => attempt.status === 'unknown'), attempts.some(attempt => attempt.status === 'unknown') ? '存在 unknown attempt' : '无 unknown 副作用');
  // G05 deps_unmerged: write dependencies prove their merge (receipt or commit sha).
  const unmergedDeps = deps.filter(depTaskId => {
    const dep = store.row<{ status: string; mode: string }>('SELECT status,mode FROM swarm_v2_tasks WHERE task_id=?', depTaskId);
    if (!dep || dep.status === 'deleted') return false;
    if (dep.mode !== 'write') return false;
    if (dep.status !== 'done') return true;
    const receipt = receiptsFor(store, depTaskId);
    if (receipt && receipt.status === 'applied') return false;
    return !attemptsFor(store, depTaskId).some(attempt => attempt.commit_sha);
  });
  add('G05', unmergedDeps.length === 0, unmergedDeps.length ? `依赖未合并：${unmergedDeps.join(',')}` : '依赖已进入基线');
  // G06 branch_missing: candidate workspace/branch readable from recorded state.
  const workspace = latest?.workspace_id
    ? store.row<{ state: string; path: string }>('SELECT state,path FROM swarm_v2_workspaces WHERE workspace_id=?', latest.workspace_id)
    : undefined;
  const workspacePass = input.workspaceReadable === true
    || (!!latest?.candidate_tip || !!latest?.result_digest || !!latest?.commit_sha)
    || (workspace !== undefined && workspace.state !== 'unknown');
  add('G06', workspacePass, workspacePass ? (workspace ? `workspace state=${workspace.state}` : '候选结果可读') : '缺少可读的工作树/分支记录');
  // G07 read_only_survey: read-only tasks never merge.
  add('G07', task.mode === 'write', task.mode === 'write' ? '写任务' : '只读任务不得合并');
  // G08 stale_base: candidate base equals the target current head.
  const base = optionalText(input.targetBase ?? latest?.base_rev ?? null, 'targetBase', 500);
  const head = optionalText(input.targetHead ?? null, 'targetHead', 500);
  add('G08', base !== null && head !== null && base === head, base === null ? '候选 base 未知' : head === null ? '目标 head 未知' : `base=${base} head=${head}`);
  // G09 no_verdict: an applied (passed) verification with an approved verdict exists.
  add('G09', !!verification && verification.status === 'passed' && !!verdict?.approved, verification ? `verification status=${verification.status}` : '无验证记录');
  // G10 verdict_rejected: the verdict is approved.
  add('G10', verdict?.approved === true, verdict ? (verdict.approved ? '裁决通过' : `裁决未通过：${verdict.findings.join('；').slice(0, 200)}`) : '无裁决');
  // G11 verdict_stale_tip: binding is not stale-tip and the tip still matches.
  const tip = latest?.candidate_tip === null || latest === undefined ? null : String(latest.candidate_tip);
  const tipPass = !!verdict && verdict.binding !== 'stale-tip'
    && (tip === null || verdict.binding === 'clean-rebase-waived' || verdict.reviewedTip === tip);
  add('G11', tipPass, verdict ? `binding=${verdict.binding}` : '无裁决可校验 tip');
  // G12 verdict_mismatch: verdict candidate + result versions match current state.
  const versionsMatch = !!verdict && verdict.candidateDigest === candidateDigest && resultVersionsMatch(store, verdict.resultVersions);
  add('G12', versionsMatch, versionsMatch ? '候选与结果版本匹配' : '裁决候选或结果版本与当前不一致');
  // G13 out_of_scope: changed paths are all inside the declared write scopes.
  const outOfScope = changedPaths === undefined
    ? ['未知变更路径']
    : changedPaths.filter(path => !scopes.some(scope => scopeCovers(scope, path)));
  add('G13', changedPaths !== undefined && outOfScope.length === 0, changedPaths === undefined ? '无法读取候选 diff' : outOfScope.length ? `越界路径：${outOfScope.join(',')}` : `${changedPaths.length} 个路径均在 scope 内`);
  // G14 base_dirty: the target workspace is clean.
  add('G14', input.workspaceClean === true, input.workspaceClean === true ? '目标工作区干净' : '目标工作区状态未知或未提交改动');
  // G15 duplicate_writer: no other unmerged concurrent writer owns overlapping scopes.
  const ownAttempts = new Set(attempts.map(attempt => attempt.attempt_id));
  const conflictingClaims = store.rows<{ attempt_id: string; scopes_json: string }>("SELECT attempt_id,scopes_json FROM swarm_v2_write_claims WHERE team_id=? AND state='active'", task.team_id)
    .filter(claim => !ownAttempts.has(String(claim.attempt_id)))
    .filter(claim => {
      const claimScopes = JSON.parse(String(claim.scopes_json)) as string[];
      return claimScopes.some(claimScope => scopes.some(scope => scopeOverlap(scope, claimScope)));
    });
  const otherRunning = store.rows<{ task_id: string; scopes_json: string }>(`SELECT t.task_id,COALESCE(s.scopes,'[]') AS scopes_json FROM swarm_v2_attempts a
      JOIN swarm_v2_tasks t ON t.task_id=a.task_id
      LEFT JOIN (SELECT task_id,json_group_array(scope) AS scopes FROM swarm_v2_task_scopes GROUP BY task_id) s ON s.task_id=t.task_id
      WHERE a.status='running' AND t.team_id=? AND t.task_id<>?`, task.team_id, taskId)
    .filter(row => (JSON.parse(String(row.scopes_json)) as string[]).some(scope => scopes.some(taskScope => scopeOverlap(scope, taskScope))));
  add('G15', conflictingClaims.length === 0 && otherRunning.length === 0, conflictingClaims.length ? `存在并发写声明：${conflictingClaims.map(claim => claim.attempt_id).join(',')}` : otherRunning.length ? `存在并发运行写任务：${otherRunning.map(row => row.task_id).join(',')}` : '无并发写者');
  // G16 budget_exhausted: team (and, when present, task) budgets are not exhausted.
  const teamBudget = getBudgetByScope(store, task.team_id, 'team', task.team_id);
  const taskBudget = getBudgetByScope(store, task.team_id, 'task', taskId);
  const budgetPass = !!teamBudget && !budgetExhausted(store, teamBudget) && !(taskBudget && budgetExhausted(store, taskBudget));
  add('G16', budgetPass, !teamBudget ? '团队预算缺失' : taskBudget && budgetExhausted(store, taskBudget) ? '任务预算已耗尽' : budgetExhausted(store, teamBudget) ? '团队预算已耗尽' : '预算充足');
  // G17 human_approval_missing: V2+ needs a recorded human approval.
  const needsApproval = task.risk === 'V2' || task.risk === 'V3';
  add('G17', !needsApproval || input.humanApproval === true, needsApproval ? (input.humanApproval === true ? '已记录人工批准' : '缺少人工批准') : `${task.risk} 无需人工批准`);
  // G18 policy_blocked: protected paths must not be touched.
  const protectedHit = (changedPaths ?? []).filter(path => protectedPaths.some(protectedPath => scopeCovers(protectedPath, path) || path === protectedPath));
  add('G18', changedPaths !== undefined && protectedHit.length === 0, changedPaths === undefined ? '无法校验受保护路径' : protectedHit.length ? `命中受保护路径：${protectedHit.join(',')}` : '未触碰受保护路径');
  // G19 evidence_missing: checks + verdicts + evidence rows are complete.
  // G19: each check must be backed by a check evidence row for this task, and when
  // the check carries an evidenceRef that exact row must match. Rows written by a
  // different verification (payload verificationId set and different) cannot validate
  // a reused checkId; legacy rows without a verificationId remain valid for this task.
  const evidenceRows = verification
    ? store.rows<{ evidence_id: string; ref: string; verification_id: string | null }>("SELECT evidence_id,ref,json_extract(payload_json,'$.verificationId') AS verification_id FROM swarm_v2_evidence WHERE team_id=? AND kind='check' AND json_extract(payload_json,'$.passed')=1 AND (task_id=? OR (task_id IS NULL AND attempt_id IN (SELECT attempt_id FROM swarm_v2_attempts WHERE task_id=?)))", task.team_id, taskId, taskId)
    : [];
  const evidencePass = !!verification && verification.status === 'passed'
    && verification.checks.length > 0
    && verification.checks.every(check => {
      const rows = evidenceRows.filter(row => row.ref === check.checkId && (row.verification_id === null || row.verification_id === verification.verificationId));
      if (!rows.length) return false;
      return check.evidenceRef === undefined || rows.some(row => row.evidence_id === check.evidenceRef);
    })
    && verificationStatusFor(task.risk as SwarmV2Risk, verdicts) === 'passed';
  add('G19', evidencePass, evidencePass ? '检查/复核证据链完整' : '证据链不完整（检查、裁决或 evidence 行缺失）');
  // G20 apply_receipt_unknown: no unknown file application receipt.
  const receipt = receiptsFor(store, taskId);
  const receiptPass = input.receiptUnknown !== true && receipt?.status !== 'unknown';
  add('G20', receiptPass, receipt?.status === 'unknown' || input.receiptUnknown === true ? '存在 unknown 应用回执' : '无未知应用回执');

  const failed = gates.filter(item => !item.passed);
  if (gates.length !== MERGE_GATE_CODES.length || gates.some((item, index) => item.code !== MERGE_GATE_CODES[index])) {
    throw new CapabilityError('VALIDATION_ERROR', '合并门禁顺序违反 MERGE_GATE_CODES 契约');
  }
  return {
    allowed: failed.length === 0,
    gates,
    failed,
    candidateDigest,
    verdictId: verdict?.verdictId ?? optionalText(input.verdictId ?? null, 'verdictId'),
  };
}

/** True when the caller-supplied file facts can be applied as per-file receipts. */
function normalizeApplyFiles(files: IntegrateFileInput[] | undefined): { path: string; digest: string; content?: string }[] {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > 512) throw new CapabilityError('VALIDATION_ERROR', 'files 必须是有界数组');
  return files.map((file, index) => {
    if (!isObject(file)) throw new CapabilityError('VALIDATION_ERROR', `files[${index}] 必须是对象`);
    const path = text(file.path, 'files.path', 1000);
    const provided = normalizeDigest(file.digest);
    const content = typeof file.content === 'string' ? file.content : undefined;
    if (!provided && content === undefined) throw new CapabilityError('VALIDATION_ERROR', `files[${index}] 需要 digest 或 content`);
    return { path, digest: provided ?? digest(content!), ...(content === undefined ? {} : { content }) };
  });
}

/**
 * Integrate one verified candidate. Allowed only when every merge gate passes;
 * a rejection writes a receipt and leaves task/state untouched. Never silently
 * merges: a missing verdict is a rejection, not an application.
 */
export function integrateTask(store: V2Store, input: IntegrateTaskInput): SwarmV2ApplyReceipt {
  const taskId = text(input.taskId, 'taskId');
  const candidateDigest = text(input.candidateDigest, 'candidateDigest', 500);
  const task = readTask(store, taskId);
  const files = normalizeApplyFiles(input.files);
  if (task.mode === 'write' && !files.length) throw new CapabilityError('VALIDATION_ERROR', '写任务集成必须提供 files 逐文件应用回执');
  const existing = receiptsFor(store, taskId);
  if (existing) {
    const stillCurrent = existing.status === 'applied' && task.status === 'done' && !task.rework_count;
    if (existing.status === 'applied' && stillCurrent && existing.candidate_digest !== candidateDigest) throw new CapabilityError('VERSION_CONFLICT', '任务已应用另一候选');
    if (existing.status === 'applied' && stillCurrent) return mapReceipt(existing);
    if (existing.status === 'unknown') throw new CapabilityError('VERSION_CONFLICT', '存在 unknown 应用回执，须先只读核对');
  }
  // Gate observations come from an explicit allowlist only: identity (taskId /
  // candidateDigest / verdictId) is bound here, never overridable. Changed paths
  // are the union of supplied diff paths and per-file receipt paths so a caller
  // cannot conceal out-of-scope files behind changedPaths: [].
  const rawGate = input.gateInput ?? {};
  const suppliedChangedPaths = rawGate.changedPaths;
  if (suppliedChangedPaths !== undefined && !Array.isArray(suppliedChangedPaths)) {
    throw new CapabilityError('VALIDATION_ERROR', 'gateInput.changedPaths 必须是数组');
  }
  const gateInput: MergeGateInput = {
    taskId,
    candidateDigest,
    verdictId: input.verdictId ?? undefined,
    changedPaths: [...new Set([...(suppliedChangedPaths ?? []), ...files.map(file => file.path)])],
  };
  if (rawGate.targetBase !== undefined) gateInput.targetBase = rawGate.targetBase;
  if (rawGate.targetHead !== undefined) gateInput.targetHead = rawGate.targetHead;
  if (rawGate.workspaceClean !== undefined) gateInput.workspaceClean = rawGate.workspaceClean;
  if (rawGate.humanApproval !== undefined) gateInput.humanApproval = rawGate.humanApproval;
  if (rawGate.protectedPaths !== undefined) gateInput.protectedPaths = rawGate.protectedPaths;
  if (rawGate.workspaceReadable !== undefined) gateInput.workspaceReadable = rawGate.workspaceReadable;
  if (rawGate.evidenceComplete !== undefined) gateInput.evidenceComplete = rawGate.evidenceComplete;
  if (rawGate.receiptUnknown !== undefined) gateInput.receiptUnknown = rawGate.receiptUnknown;
  const decision = evaluateMergeGates(store, gateInput);
  const operationId = optionalText(input.operationId ?? null, 'operationId', 200) ?? randomUUID();
  const baselineDigest = optionalText(input.gateInput?.targetBase ?? latestAttempt(store, taskId)?.base_rev ?? null, 'baselineDigest', 500);
  const now = v2Now();
  if (!decision.allowed) {
    const receipt: SwarmV2ApplyReceipt = {
      taskId, operationId, status: 'rejected', files: [], candidateDigest,
      verdictId: decision.verdictId, baselineDigest, at: now,
    };
    return store.transaction(() => {
      store.db.prepare(`INSERT INTO swarm_v2_apply_receipts(task_id,team_id,operation_id,status,files_json,candidate_digest,verdict_id,baseline_digest,applied_at)
        VALUES(?,?,?,'rejected','[]',?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET operation_id=excluded.operation_id,status='rejected',files_json='[]',candidate_digest=excluded.candidate_digest,verdict_id=excluded.verdict_id,baseline_digest=excluded.baseline_digest,applied_at=excluded.applied_at`)
        .run(taskId, task.team_id, operationId, candidateDigest, receipt.verdictId, baselineDigest, now);
      journal(store, task.team_id, 'task.merge_rejected', input.actor, { kind: 'task', id: taskId, revision: Number(task.revision) }, {
        candidateDigest, verdictId: receipt.verdictId, failed: decision.failed.map(item => ({ code: item.code, detail: item.detail })),
      });
      return receipt;
    });
  }
  const verdictId = decision.verdictId;
  if (!verdictId) throw new CapabilityError('VALIDATION_ERROR', '合并门禁通过但缺少封存裁决（静默合并被禁止）');
  const verdictRow = readVerdictRow(store, verdictId);
  if (String(verdictRow.task_id) !== taskId) throw new CapabilityError('VERSION_CONFLICT', '裁决不属于当前任务');
  if (Number(verdictRow.sealed) !== 1 || Number(verdictRow.approved) !== 1) throw new CapabilityError('VALIDATION_ERROR', '应用必须具备封存且通过的裁决');
  const frozenVerification = mapVerification(readVerificationRow(store, String(verdictRow.verification_id)));
  if (contractDigest(store, readTask(store, taskId)) !== frozenVerification.contractDigest) throw new CapabilityError('VERSION_CONFLICT', '任务契约在验证后发生变化，必须重新验证');
  const receipt: SwarmV2ApplyReceipt = {
    taskId, operationId, status: 'applied',
    files: files.map(file => ({ path: file.path, digest: file.digest, state: 'applied' })),
    candidateDigest, verdictId, baselineDigest, at: now,
  };
  return store.transaction(() => {
    const current = store.row<{ status: string }>('SELECT status FROM swarm_v2_tasks WHERE task_id=?', taskId);
    if (current?.status !== 'verified') throw new CapabilityError('VERSION_CONFLICT', '任务状态在集成期间发生变化');
    const verification = mapVerification(readVerificationRow(store, String(verdictRow.verification_id)));
    if (verification.status !== 'passed') throw new CapabilityError('VALIDATION_ERROR', '裁决对应的验证未通过，不能应用');
    store.db.prepare(`INSERT INTO swarm_v2_apply_receipts(task_id,team_id,operation_id,status,files_json,candidate_digest,verdict_id,baseline_digest,applied_at)
      VALUES(?,?,?,'applied',?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET operation_id=excluded.operation_id,status='applied',files_json=excluded.files_json,candidate_digest=excluded.candidate_digest,verdict_id=excluded.verdict_id,baseline_digest=excluded.baseline_digest,applied_at=excluded.applied_at`)
      .run(taskId, task.team_id, operationId, JSON.stringify(receipt.files), candidateDigest, verdictId, baselineDigest, now);
    store.db.prepare("UPDATE swarm_v2_tasks SET status='done',revision=revision+1,updated_at=? WHERE task_id=? AND status='verified'").run(now, taskId);
    journal(store, task.team_id, 'task.merged', input.actor, { kind: 'task', id: taskId, revision: Number(task.revision) + 1 }, {
      candidateDigest, verdictId, operationId, files: receipt.files.map(file => ({ path: file.path, digest: file.digest })), status: 'done',
    });
    journal(store, task.team_id, 'workspace.applied', input.actor, { kind: 'workspace', id: latestAttempt(store, taskId)?.workspace_id ?? `staging:${taskId}` }, {
      taskId, operationId, files: receipt.files.map(file => ({ path: file.path, digest: file.digest })),
    });
    return receipt;
  });
}

/**
 * Acceptance helper: applied receipts must all carry a verdict. Returns 0 when
 * clean; throws with the offending task ids otherwise (silent merge = 0).
 */
export function assertNoSilentMerge(store: V2Store, teamId: string): number {
  const rows = store.rows<{ task_id: string }>("SELECT task_id FROM swarm_v2_apply_receipts WHERE team_id=? AND status='applied' AND (verdict_id IS NULL OR verdict_id='')", text(teamId, 'teamId'));
  if (rows.length) throw new CapabilityError('VALIDATION_ERROR', `存在静默合并回执：${rows.map(row => row.task_id).join(',')}`);
  return 0;
}

