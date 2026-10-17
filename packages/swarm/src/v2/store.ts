import {randomUUID} from 'node:crypto';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {CapabilityError,RecordStore,digest,requireSchemaWriter,type JsonObject} from '@friend-pi/core';
import type {
  SwarmV2Actor, SwarmV2Aggregate, SwarmV2JournalEvent, SwarmV2MergeGate,
  SwarmV2StateSummary, SwarmV2TaskStatus, SwarmV2AttemptStatus, SwarmV2MessageState,
} from './types.js';
import {TASK_STATUSES,ATTEMPT_STATUSES,MESSAGE_STATES} from './types.js';

export const SWARM_V2_SCHEMA_VERSION = 1;
export const SWARM_V2_TABLES = [
  'swarm_v2_migrations', 'swarm_v2_teams', 'swarm_v2_members', 'swarm_v2_tasks',
  'swarm_v2_task_dependencies', 'swarm_v2_task_scopes', 'swarm_v2_task_requirements',
  'swarm_v2_attempts', 'swarm_v2_budgets', 'swarm_v2_budget_entries', 'swarm_v2_messages',
  'swarm_v2_verifications', 'swarm_v2_verdicts', 'swarm_v2_evidence', 'swarm_v2_journal',
  'swarm_v2_workspaces', 'swarm_v2_stop_receipts', 'swarm_v2_write_claims',
  'swarm_v2_apply_receipts', 'swarm_v2_shadow_journal', 'swarm_v2_projections',
] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS swarm_v2_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,source_digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_teams(team_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,root_session_id TEXT NOT NULL,workspace_root TEXT NOT NULL,status TEXT NOT NULL,autonomy_level INTEGER NOT NULL DEFAULT 1,policy_json TEXT NOT NULL,revision INTEGER NOT NULL,rework_round INTEGER NOT NULL DEFAULT 0,failure_fingerprints_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_members(member_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,name TEXT NOT NULL,member_path TEXT NOT NULL,role TEXT NOT NULL,context_mode TEXT NOT NULL,model_ref TEXT,generation INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT,session_file TEXT,capability_json TEXT NOT NULL,write_scopes_json TEXT NOT NULL,lease_expires_at TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(team_id,name),UNIQUE(team_id,member_path));
CREATE TABLE IF NOT EXISTS swarm_v2_tasks(task_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,mode TEXT NOT NULL,risk TEXT NOT NULL,status TEXT NOT NULL,owner_member_id TEXT,current_attempt_id TEXT,logical_step_id TEXT NOT NULL,result_revision INTEGER NOT NULL DEFAULT 0,result_artifact_ids_json TEXT NOT NULL DEFAULT '[]',rework_count INTEGER NOT NULL DEFAULT 0,requirement_version INTEGER NOT NULL DEFAULT 1,acceptance_json TEXT NOT NULL,checks_ref TEXT,workspace_policy TEXT NOT NULL DEFAULT 'worktree',blocked_reason_json TEXT,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,tombstone INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS swarm_v2_tasks_frontier ON swarm_v2_tasks(team_id,status,created_at);
CREATE TABLE IF NOT EXISTS swarm_v2_task_dependencies(task_id TEXT NOT NULL,depends_on TEXT NOT NULL,PRIMARY KEY(task_id,depends_on));
CREATE TABLE IF NOT EXISTS swarm_v2_task_scopes(task_id TEXT NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(task_id,scope));
CREATE TABLE IF NOT EXISTS swarm_v2_task_requirements(task_id TEXT NOT NULL,version INTEGER NOT NULL,prompt TEXT NOT NULL,reason TEXT,automatic INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,PRIMARY KEY(task_id,version));
CREATE TABLE IF NOT EXISTS swarm_v2_attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,number INTEGER NOT NULL,status TEXT NOT NULL,member_id TEXT,generation INTEGER NOT NULL DEFAULT 0,workspace_id TEXT,base_rev TEXT,deps_digest TEXT,requirement_version INTEGER NOT NULL,budget_reservation_id TEXT,started_at TEXT NOT NULL,finished_at TEXT,terminal_reason TEXT,summary TEXT,session_id TEXT,session_file TEXT,commit_sha TEXT,result_digest TEXT,candidate_tip TEXT,evidence_refs_json TEXT NOT NULL DEFAULT '[]',UNIQUE(task_id,number));
CREATE UNIQUE INDEX IF NOT EXISTS swarm_v2_attempts_one_running ON swarm_v2_attempts(task_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS swarm_v2_budgets(budget_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL,token_limit INTEGER,token_used INTEGER NOT NULL DEFAULT 0,token_reserved INTEGER NOT NULL DEFAULT 0,cost_limit_micros INTEGER,cost_used INTEGER NOT NULL DEFAULT 0,time_limit_ms INTEGER,time_used_ms INTEGER NOT NULL DEFAULT 0,concurrency_limit INTEGER,unknown INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(team_id,scope,scope_id));
CREATE TABLE IF NOT EXISTS swarm_v2_budget_entries(reservation_id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,attempt_id TEXT NOT NULL,upper_bound_tokens INTEGER NOT NULL,upper_bound_cost_micros INTEGER NOT NULL,state TEXT NOT NULL,tokens INTEGER,cost_micros INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_messages(message_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,sender_kind TEXT NOT NULL,sender_id TEXT,sender_generation INTEGER,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,type TEXT NOT NULL,delivery_mode TEXT NOT NULL,sequence INTEGER NOT NULL,body_digest TEXT NOT NULL,body_length INTEGER NOT NULL,body TEXT NOT NULL,provenance_json TEXT NOT NULL,state TEXT NOT NULL,accepted_at TEXT NOT NULL,queued_at TEXT,delivered_at TEXT,incorporated_at TEXT,native_entry_id TEXT,attempt_id TEXT,generation INTEGER,expires_at TEXT,UNIQUE(team_id,target_id,sequence));
CREATE TABLE IF NOT EXISTS swarm_v2_verifications(verification_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT NOT NULL,attempt_id TEXT,candidate_digest TEXT NOT NULL,contract_digest TEXT NOT NULL,level TEXT NOT NULL,status TEXT NOT NULL,checks_json TEXT NOT NULL DEFAULT '[]',findings_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS swarm_v2_verification_candidate ON swarm_v2_verifications(team_id,task_id,candidate_digest);
CREATE TABLE IF NOT EXISTS swarm_v2_verdicts(verdict_id TEXT PRIMARY KEY,verification_id TEXT NOT NULL,team_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,approved INTEGER NOT NULL,findings_json TEXT NOT NULL,task_ids_json TEXT NOT NULL,result_versions_json TEXT NOT NULL,candidate_digest TEXT NOT NULL,reviewed_tip TEXT NOT NULL,binding TEXT NOT NULL,reviewer_member_id TEXT NOT NULL,session_id TEXT,session_file TEXT,sealed INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_evidence(evidence_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,task_id TEXT,attempt_id TEXT,kind TEXT NOT NULL,ref TEXT NOT NULL,digest TEXT NOT NULL,producer TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_journal(team_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,actor_kind TEXT NOT NULL,actor_id TEXT NOT NULL,actor_generation INTEGER,aggregate_kind TEXT NOT NULL,aggregate_id TEXT NOT NULL,aggregate_revision INTEGER,at TEXT NOT NULL,payload_digest TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(team_id,seq),UNIQUE(event_id));
CREATE TABLE IF NOT EXISTS swarm_v2_workspaces(workspace_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,attempt_id TEXT,member_id TEXT,kind TEXT NOT NULL,path TEXT NOT NULL,branch TEXT,base_commit TEXT,state TEXT NOT NULL,lease_owner TEXT,lease_expires_at TEXT,created_at TEXT NOT NULL,released_at TEXT);
CREATE TABLE IF NOT EXISTS swarm_v2_stop_receipts(receipt_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,objects_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_write_claims(claim_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,attempt_id TEXT NOT NULL,task_id TEXT NOT NULL,member_id TEXT,scopes_json TEXT NOT NULL,state TEXT NOT NULL,acquired_at TEXT NOT NULL,released_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS swarm_v2_write_claims_active ON swarm_v2_write_claims(team_id,attempt_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS swarm_v2_apply_receipts(task_id TEXT PRIMARY KEY,team_id TEXT NOT NULL,operation_id TEXT NOT NULL,status TEXT NOT NULL,files_json TEXT NOT NULL,candidate_digest TEXT NOT NULL,verdict_id TEXT,baseline_digest TEXT,applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS swarm_v2_shadow_journal(team_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,type TEXT NOT NULL,digest TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(team_id,seq));
CREATE TABLE IF NOT EXISTS swarm_v2_projections(team_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,digest TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL);
`;

export function v2Now(): string { return new Date().toISOString(); }
export function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CapabilityError('VALIDATION_ERROR', '参数必须是对象'); return v as Record<string, unknown>; }
export function text(value: unknown, field: string, max = 200): string { const v = String(value ?? '').trim(); if (!v) throw new CapabilityError('VALIDATION_ERROR', `${field}不能为空`); if (v.length > max) throw new CapabilityError('VALIDATION_ERROR', `${field}过长`); return v; }
export function optionalText(value: unknown, field: string, max = 200): string | null { if (value === undefined || value === null || value === '') return null; return text(value, field, max); }
export function arrayText(value: unknown, field: string, maxItems = 64, maxLength = 500): string[] { if (value === undefined || value === null) return []; if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || !item.trim() || item.length > maxLength)) throw new CapabilityError('VALIDATION_ERROR', `${field}必须是有界字符串数组`); return [...new Set(value.map(item => (item as string).trim()))]; }
export function intOrNull(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | null { if (value === undefined || value === null) return null; const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new CapabilityError('VALIDATION_ERROR', `${field}必须是 ${min}..${max} 的整数`); return n; }

/** Normalize failure evidence so the same failure with different ids/whitespace is a repeat. */
export function failureFingerprint(input: {logicalSteps: string[]; requirement: string[]; failure: string; artifacts: string[]}): string {
  const normalize = (s: string) => s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '<id>')
    .replace(/\b[0-9a-f]{32,64}\b/giu, '<digest>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, '<time>')
    .replace(/\s+/gu, ' ').trim().toLowerCase();
  return digest({v: 1, logicalSteps: [...input.logicalSteps].sort().map(normalize), requirement: [...input.requirement].sort().map(normalize), failure: normalize(input.failure), artifacts: [...input.artifacts].sort()});
}

export class V2Store {
  private static ensured = new WeakSet<RecordStore>();
  readonly db: RecordStore['db'];
  private constructor(readonly store: RecordStore) { this.db = store.db; }
  static open(store: RecordStore): V2Store {
    if (!V2Store.ensured.has(store)) {
      const hasMigration = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='swarm_v2_migrations'").get();
      const hasRow = hasMigration && !!store.db.prepare('SELECT 1 FROM swarm_v2_migrations WHERE version=?').get(SWARM_V2_SCHEMA_VERSION);
      if (!hasRow) {
        // Snapshot before the first additive v2 migration; never rewrite existing swarm documents.
        const backups = readdirSync(store.dataDir).filter(name => name.startsWith('swarm-pre-v2-') && name.endsWith('.sqlite'));
        if (!backups.length) store.db.prepare('VACUUM INTO ?').run(join(store.dataDir, `swarm-pre-v2-${randomUUID()}.sqlite`));
        store.transaction(() => {
          store.db.exec(DDL);
          store.db.prepare('INSERT OR IGNORE INTO swarm_v2_migrations VALUES(?,?,?)').run(SWARM_V2_SCHEMA_VERSION, v2Now(), digest('friend-pi-swarm-v2-p0'));
        });
      } else {
        store.db.exec(DDL);
      }
      requireSchemaWriter(store, 'swarm', 5, [...SWARM_V2_TABLES]);
      V2Store.ensured.add(store);
    }
    return new V2Store(store);
  }
  get dataDir(): string { return this.store.dataDir; }
  transaction<T>(fn: () => T): T { return this.store.transaction(fn); }
  /** Append one journal event inside the caller's transaction; sequence is per team and monotonic. */
  journal(teamId: string, type: string, actor: SwarmV2Actor, aggregate: SwarmV2Aggregate, data: Record<string, unknown> = {}): SwarmV2JournalEvent {
    const seq = Number((this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM swarm_v2_journal WHERE team_id=?').get(teamId) as {n: number}).n);
    const eventId = randomUUID(), at = v2Now(), payloadDigest = digest({type, actor, aggregate, data});
    this.db.prepare('INSERT INTO swarm_v2_journal VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(teamId, seq, eventId, type, actor.kind, actor.id, actor.generation ?? null, aggregate.kind, aggregate.id, aggregate.revision ?? null, at, payloadDigest, JSON.stringify(data));
    // Best-effort projection refresh; projections are disposable read models.
    this.refreshProjection(teamId);
    return {eventId, seq, type, actor, aggregate, at, payloadDigest, data};
  }
  events(teamId: string, afterSeq = 0, limit = 500): SwarmV2JournalEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new CapabilityError('VALIDATION_ERROR', 'journal 分页参数无效');
    return (this.db.prepare('SELECT * FROM swarm_v2_journal WHERE team_id=? AND seq>? ORDER BY seq LIMIT ?').all(teamId, afterSeq, limit) as Record<string, unknown>[]).map(row => ({
      eventId: String(row.event_id), seq: Number(row.seq), type: String(row.type),
      actor: {kind: String(row.actor_kind) as SwarmV2Actor['kind'], id: String(row.actor_id), generation: row.actor_generation === null ? undefined : Number(row.actor_generation)},
      aggregate: {kind: String(row.aggregate_kind), id: String(row.aggregate_id), revision: row.aggregate_revision === null ? undefined : Number(row.aggregate_revision)},
      at: String(row.at), payloadDigest: String(row.payload_digest), data: JSON.parse(String(row.data_json)),
    }));
  }
  /** Recompute the read projection from current-state tables; never writes business state. */
  refreshProjection(teamId: string): SwarmV2StateSummary {
    const team = this.db.prepare('SELECT * FROM swarm_v2_teams WHERE team_id=?').get(teamId) as Record<string, unknown> | undefined;
    if (!team) throw new CapabilityError('VALIDATION_ERROR', '团队不存在');
    const count = (sql: string, ...args: (string|number|null)[]) => Number((this.db.prepare(sql).get(...args) as {n: number}).n);
    const by = <T extends string>(sql: string, keys: readonly T[], ...args: (string|number|null)[]): Record<T, number> => {
      const out = Object.fromEntries(keys.map(key => [key, 0])) as Record<T, number>;
      for (const row of this.db.prepare(sql).all(...args) as {k: string; n: number}[]) if (row.k in out) out[row.k as T] = Number(row.n);
      return out;
    };
    const tasks = this.db.prepare('SELECT status AS k,COUNT(*) AS n FROM swarm_v2_tasks WHERE team_id=? GROUP BY status').all(teamId) as {k: string; n: number}[];
    const taskCounts = Object.fromEntries(TASK_STATUSES.map(status => [status, 0])) as Record<SwarmV2TaskStatus, number>;
    for (const row of tasks) if (row.k in taskCounts) taskCounts[row.k as SwarmV2TaskStatus] = Number(row.n);
    const attempts = this.db.prepare("SELECT a.status AS k,COUNT(*) AS n FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id WHERE t.team_id=? GROUP BY a.status").all(teamId) as {k: string; n: number}[];
    const attemptCounts = Object.fromEntries(ATTEMPT_STATUSES.map(status => [status, 0])) as Record<SwarmV2AttemptStatus, number>;
    for (const row of attempts) if (row.k in attemptCounts) attemptCounts[row.k as SwarmV2AttemptStatus] = Number(row.n);
    const messages = this.db.prepare('SELECT state AS k,COUNT(*) AS n FROM swarm_v2_messages WHERE team_id=? GROUP BY state').all(teamId) as {k: string; n: number}[];
    const messageCounts = Object.fromEntries(MESSAGE_STATES.map(state => [state, 0])) as Record<SwarmV2MessageState, number>;
    for (const row of messages) if (row.k in messageCounts) messageCounts[row.k as SwarmV2MessageState] = Number(row.n);
    const silentMerge = count("SELECT COUNT(*) AS n FROM swarm_v2_apply_receipts WHERE team_id=? AND status='applied' AND (verdict_id IS NULL OR verdict_id='')", teamId);
    const summary: SwarmV2StateSummary = {
      schemaVersion: SWARM_V2_SCHEMA_VERSION,
      teams: 1,
      members: count('SELECT COUNT(*) AS n FROM swarm_v2_members WHERE team_id=?', teamId),
      tasks: taskCounts, attempts: attemptCounts, messages: messageCounts,
      budgets: count('SELECT COUNT(*) AS n FROM swarm_v2_budgets WHERE team_id=?', teamId),
      verifications: count('SELECT COUNT(*) AS n FROM swarm_v2_verifications WHERE team_id=?', teamId),
      verdicts: count('SELECT COUNT(*) AS n FROM swarm_v2_verdicts WHERE team_id=?', teamId),
      journalEvents: count('SELECT COUNT(*) AS n FROM swarm_v2_journal WHERE team_id=?', teamId),
      silentMerge,
      baselineDigest: digest({teamId, revision: Number(team.revision), tasks: taskCounts, attempts: attemptCounts, messages: messageCounts, silentMerge}),
    };
    this.db.prepare('INSERT INTO swarm_v2_projections(team_id,revision,digest,json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,json=excluded.json,updated_at=excluded.updated_at')
      .run(teamId, Number(team.revision), summary.baselineDigest, JSON.stringify(summary), v2Now());
    return summary;
  }
  projection(teamId: string): {revision: number; digest: string; json: SwarmV2StateSummary} | undefined {
    const row = this.db.prepare('SELECT revision,digest,json FROM swarm_v2_projections WHERE team_id=?').get(teamId) as {revision: number; digest: string; json: string} | undefined;
    return row ? {revision: Number(row.revision), digest: String(row.digest), json: JSON.parse(row.json)} : undefined;
  }
  row<T>(sql: string, ...args: (string|number|null)[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  rows<T>(sql: string, ...args: (string|number|null)[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  exec(sql: string): void { this.db.exec(sql); }
}

/** Merge gate codes from the blueprint (G01–G20). Stable order is part of the contract. */
export const MERGE_GATE_CODES = ['G01','G02','G03','G04','G05','G06','G07','G08','G09','G10','G11','G12','G13','G14','G15','G16','G17','G18','G19','G20'] as const;
export type MergeGateCode = typeof MERGE_GATE_CODES[number];
export function gate(code: MergeGateCode, passed: boolean, detail: string): SwarmV2MergeGate { return {code, passed, detail}; }
