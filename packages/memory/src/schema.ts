/**
 * Memory schema v4 (P0-S).
 *
 * The v4 migration is intentionally kept out of the controller: the DDL, the
 * backfill rules and the legacy-subject dedupe are pure database work that can
 * be unit tested on a throw-away SQLite file. Behavior that belongs to the
 * controller (how a record's semantic identity is computed, how a subject is
 * normalized, how a conflict side is fingerprinted) is injected through
 * {@link MemoryMigrationHooks} so this module never imports the controller.
 *
 * Contract (P0-SPEC.md §2):
 *  - the migration is idempotent (`memory_migrations.version = 4` short-circuits);
 *  - the database is backed up with `VACUUM INTO` in 0700 directory before any
 *    mutation, and a backup failure aborts the whole migration;
 *  - everything except the backup happens in one `BEGIN IMMEDIATE` transaction,
 *    so a failure never leaves a half-migrated schema;
 *  - the migration does NOT run the older v2/v3 migrations (still in
 *    `packages/memory/src/index.ts`) but must work on an empty database where
 *    those versions were never recorded (fresh installs).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Version written into `memory_migrations` once the latest schema has been applied. */
export const MEMORY_SCHEMA_VERSION = 5;
/** Old writers fail closed through `friend_pi_writer_version()` triggers. */
export const MEMORY_WRITER_VERSION = 6;
/** Digest input of the `memory_migrations.checksum` value for v4. */
export const MEMORY_V4_MIGRATION_CHECKSUM_INPUT = 'memory-v4';
/** Digest input of the `memory_migrations.checksum` value for v5. */
export const MEMORY_V5_MIGRATION_CHECKSUM_INPUT = 'memory-v5';
/** documents(namespace='memory') key that carries the install profile. */
export const MEMORY_INSTALL_PROFILE_KEY = 'install-profile';
export const MEMORY_INSTALL_PROFILE_NAMESPACE = 'memory';
/** Private directory (mode 0700) that holds `VACUUM INTO` migration backups. */
export const MEMORY_MIGRATION_BACKUP_DIR = 'memory-migration-backups';

export type MemoryInstallProfile = 'fresh' | 'upgraded';

export interface MemoryMigrationHooks {
  dataDir: string;
  now(): string;
  digest(value: unknown): string;
  /** Must be byte-for-byte identical to index.ts `memorySemanticDigest(record)`. */
  semanticDigest(record: {id:string;revision:number;content:string;conditions:string[];validFrom:string|null;validTo:string|null;scope:string}): string;
  /** subjects.ts normalizeSubjectKey: undefined for empty/invalid/missing subjects. */
  normalizeSubjectKey(subject: unknown): string | undefined;
  /** subjects.ts normalizeSubjectValue: used for conflict equality. */
  normalizeSubjectValue(value: string): string;
  /** subjects.ts subjectClaimHash: identity of one conflict side. */
  recordClaim(record: {id:string;content:string;conditions:string[]}): string;
}

export interface MemorySchemaResult {
  version: 5;
  /** True when at least one schema version was applied on this call. */
  migrated: boolean;
  installProfile: MemoryInstallProfile;
  /** Backwards-compatible: the v4 backup path when v4 was applied. */
  backupPath?: string;
  v4BackupPath?: string;
  v5BackupPath?: string;
  migrations: {v4: boolean; v5: boolean};
}
/** @deprecated kept for older imports; use MemorySchemaResult. */
export type MemoryV4Result = MemorySchemaResult;

/** Every table guarded by requireSchemaWriter(..., MEMORY_WRITER_VERSION, ...). */
export const MEMORY_SCHEMA_TABLES: string[] = [
  'memory_records',
  'memory_versions',
  'memory_jobs',
  'memory_suppression',
  'memory_usage',
  'memory_evidence',
  'memory_dependencies',
  'memory_operations',
  'memory_projection_outbox',
  'memory_migrations',
  'memory_events',
  'memory_queries',
  'memory_subjects',
  'memory_conflicts',
  'memory_conflict_sides',
  'memory_policies',
  'memory_autopublish_audit',
  'memory_reviews',
  'memory_relations',
  'memory_consolidations',
];

/** Tables introduced by v4 (blueprint §13.2 / spec §2.4). */
export const MEMORY_V4_TABLES: string[] = [
  'memory_subjects',
  'memory_conflicts',
  'memory_conflict_sides',
  'memory_policies',
  'memory_autopublish_audit',
  'memory_reviews',
  'memory_relations',
  'memory_consolidations',
];

/** Columns added to memory_records by v4 (spec §2.3). */
export const MEMORY_RECORD_COLUMNS: ReadonlyArray<{name: string; declaration: string}> = [
  {name:'kind_v2', declaration:'TEXT'},
  {name:'subject_key', declaration:'TEXT'},
  {name:'subject_cardinality', declaration:'TEXT'},
  {name:'trust', declaration:'TEXT'},
  {name:'authority', declaration:'TEXT'},
  {name:'auto_published', declaration:'INTEGER NOT NULL DEFAULT 0'},
  {name:'policy_id', declaration:'TEXT'},
  {name:'policy_version', declaration:'INTEGER'},
  {name:'score', declaration:'INTEGER'},
  {name:'conflict_state', declaration:'TEXT'},
  {name:'lineage_root', declaration:'TEXT'},
  {name:'semantic_digest', declaration:'TEXT'},
  {name:'last_used_at', declaration:'TEXT'},
  {name:'use_count', declaration:'INTEGER NOT NULL DEFAULT 0'},
  {name:'feedback_score', declaration:'REAL NOT NULL DEFAULT 0'},
  {name:'expires_at', declaration:'TEXT'},
  {name:'deleted_at', declaration:'TEXT'},
];

/** Indexes on memory_records introduced by v4. Created after dedupe so the unique one cannot fail. */
export const MEMORY_RECORD_INDEX_DDL: string[] = [
  'CREATE INDEX IF NOT EXISTS memory_records_subject_active ON memory_records(project_id,scope,subject_key)',
  "CREATE UNIQUE INDEX IF NOT EXISTS memory_records_single_subject ON memory_records(project_id,scope,subject_key) WHERE status='active' AND subject_cardinality='single' AND subject_key IS NOT NULL AND auto_published=1",
  'CREATE INDEX IF NOT EXISTS memory_records_kind_status ON memory_records(project_id,status,kind_v2)',
  'CREATE INDEX IF NOT EXISTS memory_records_last_used ON memory_records(last_used_at)',
];

/** Tables introduced by v5 (Dream v2 lineage/consolidation audit, relations graph). */
export const MEMORY_V5_TABLES: string[] = ['memory_relations', 'memory_consolidations'];

/** Columns added to memory_records by v5 (pin/decay/consolidation/cross-project knowledge). */
export const MEMORY_V5_RECORD_COLUMNS: ReadonlyArray<{name: string; declaration: string}> = [
  {name:'pinned', declaration:'INTEGER NOT NULL DEFAULT 0'},
  {name:'pinned_at', declaration:'TEXT'},
  {name:'decay_score', declaration:'REAL'},
  {name:'consolidation_id', declaration:'TEXT'},
  {name:'project_ids_json', declaration:'TEXT'},
];

/** Indexes on memory_records introduced by v5. */
export const MEMORY_V5_RECORD_INDEX_DDL: string[] = [
  'CREATE INDEX IF NOT EXISTS memory_records_pinned ON memory_records(project_id,pinned,status)',
  'CREATE INDEX IF NOT EXISTS memory_records_consolidation ON memory_records(consolidation_id)',
];

/** v5 tables and their secondary indexes (idempotent). */
export const MEMORY_V5_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS memory_relations(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_relations_from ON memory_relations(project_id,from_id,kind);
CREATE INDEX IF NOT EXISTS memory_relations_to ON memory_relations(project_id,to_id,kind);
CREATE TABLE IF NOT EXISTS memory_consolidations(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  actor TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT, rolled_back_at TEXT,
  diff_json TEXT NOT NULL, parent_ids_json TEXT NOT NULL, child_ids_json TEXT NOT NULL,
  rollback_token TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_consolidations_project ON memory_consolidations(project_id,status,created_at);
`;

/** New tables, their secondary indexes and the documents/migrations bootstrap. */
export const MEMORY_V4_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS documents(namespace TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,key));
CREATE TABLE IF NOT EXISTS memory_migrations(version INTEGER PRIMARY KEY,checksum TEXT,applied_at TEXT);
CREATE TABLE IF NOT EXISTS memory_subjects(
  project_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]', cardinality TEXT NOT NULL DEFAULT 'single',
  value_type TEXT NOT NULL DEFAULT 'freeform', sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(project_id,scope,key));
CREATE TABLE IF NOT EXISTS memory_conflicts(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, subject_key TEXT NOT NULL,
  status TEXT NOT NULL, resolution TEXT, opened_at TEXT NOT NULL, opened_by TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT, policy_version INTEGER, notes TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_conflicts_open ON memory_conflicts(project_id,status,subject_key);
CREATE TABLE IF NOT EXISTS memory_conflict_sides(
  conflict_id TEXT NOT NULL, side TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  claim_hash TEXT NOT NULL, support_score INTEGER NOT NULL, evidence_json TEXT NOT NULL,
  PRIMARY KEY(conflict_id,side));
CREATE TABLE IF NOT EXISTS memory_policies(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '*', scope TEXT NOT NULL DEFAULT '*',
  kind TEXT NOT NULL DEFAULT '*', mode TEXT NOT NULL, min_score INTEGER NOT NULL,
  max_auto_per_day INTEGER NOT NULL, allowed_trust_json TEXT NOT NULL,
  require_review INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_autopublish_audit(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  action TEXT NOT NULL, mode TEXT NOT NULL, policy_id TEXT NOT NULL, policy_version INTEGER NOT NULL,
  score INTEGER, gates_json TEXT NOT NULL, trust TEXT, authority TEXT, job_id TEXT,
  actor TEXT NOT NULL, before_json TEXT, after_json TEXT, rollback_token TEXT,
  batch_key TEXT, created_at TEXT NOT NULL, revoked_at TEXT, revoke_reason TEXT);
CREATE INDEX IF NOT EXISTS memory_audit_memory ON memory_autopublish_audit(project_id,memory_id,created_at);
CREATE INDEX IF NOT EXISTS memory_audit_batch ON memory_autopublish_audit(project_id,batch_key);
CREATE TABLE IF NOT EXISTS memory_reviews(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  reason TEXT NOT NULL, priority INTEGER NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT, notes TEXT);
CREATE INDEX IF NOT EXISTS memory_reviews_due ON memory_reviews(project_id,status,due_at);
`;

const MIGRATION_BACKUP_PREFIX = 'before-';

interface LegacyEvidence { kind?: unknown; sourceRole?: unknown; source?: unknown; relation?: unknown }
interface LegacyRecord {
  id?: unknown; revision?: unknown; projectId?: unknown; scope?: unknown; kind?: unknown;
  content?: unknown; conditions?: unknown; parentIds?: unknown; subject?: unknown; confirmedBy?: unknown;
  validFrom?: unknown; validTo?: unknown; updatedAt?: unknown; createdAt?: unknown; sources?: unknown; evidence?: unknown;
}
interface RecordRow { id: string; project_id: string; scope: string; revision: number; json: string; subject_key: string }

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as {name?: unknown}[];
  return new Set(rows.map(row => String(row.name)));
}
function countRows(db: DatabaseSync, table: string): number {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count?: unknown} | undefined;
  return Number(row?.count ?? 0);
}

/** upgraded iff any memory row exists or the v2/v3 migrations already ran. */
export function detectMemoryInstallProfile(db: DatabaseSync): MemoryInstallProfile {
  if (!tableExists(db, 'memory_migrations')) return 'fresh';
  if (countRows(db, 'memory_records') > 0) return 'upgraded';
  return db.prepare('SELECT 1 FROM memory_migrations WHERE version IN (2,3)').get() ? 'upgraded' : 'fresh';
}

/** Reads the persisted install profile when a previous open already wrote it. */
export function readMemoryInstallProfile(db: DatabaseSync): MemoryInstallProfile | undefined {
  if (!tableExists(db, 'documents')) return undefined;
  const row = db.prepare("SELECT json FROM documents WHERE namespace=? AND key=?").get(MEMORY_INSTALL_PROFILE_NAMESPACE, MEMORY_INSTALL_PROFILE_KEY) as {json?: unknown} | undefined;
  if (!row) return undefined;
  try {
    const value = JSON.parse(String(row.json)) as {profile?: unknown};
    return value.profile === 'fresh' || value.profile === 'upgraded' ? value.profile : undefined;
  } catch { return undefined; }
}

/** Backup-first: `VACUUM INTO <dataDir>/memory-migration-backups/before-<version>-<uuid>.sqlite`. */
function backupBefore(db: DatabaseSync, dataDir: string, version: 'v4' | 'v5'): string {
  const root = join(dataDir, MEMORY_MIGRATION_BACKUP_DIR);
  mkdirSync(root, {recursive:true, mode:0o700});
  try { chmodSync(root, 0o700); } catch { /* Best effort on filesystems that ignore modes. */ }
  const path = join(root, `${MIGRATION_BACKUP_PREFIX}${version}-${randomUUID()}.sqlite`);
  // VACUUM INTO must run outside the migration transaction; a failure aborts everything.
  db.prepare('VACUUM INTO ?').run(path);
  return path;
}

function addMissingV5Columns(db: DatabaseSync): void {
  if (!tableExists(db, 'memory_records')) return;
  const existing = columnNames(db, 'memory_records');
  for (const column of MEMORY_V5_RECORD_COLUMNS) {
    if (existing.has(column.name)) continue;
    db.exec(`ALTER TABLE memory_records ADD COLUMN ${column.name} ${column.declaration}`);
  }
}

/** Idempotently apply v4 only; used by ensureMemorySchema and by migration tests. */
function ensureMemoryV4(db: DatabaseSync, hooks: MemoryMigrationHooks): {migrated:boolean; installProfile: MemoryInstallProfile; backupPath?:string} {
  db.exec(MEMORY_V4_TABLE_DDL);
  if (db.prepare('SELECT 1 FROM memory_migrations WHERE version=4').get()) {
    return {migrated:false, installProfile: readMemoryInstallProfile(db) ?? detectMemoryInstallProfile(db)};
  }
  const installProfile = detectMemoryInstallProfile(db);
  const backupPath = backupBefore(db, hooks.dataDir, 'v4');
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (ownTransaction && db.prepare('SELECT 1 FROM memory_migrations WHERE version=4').get()) {
      db.exec('ROLLBACK');
      try { rmSync(backupPath, {force:true}); } catch { /* Another reader may hold the file; harmless. */ }
      return {migrated:false, installProfile: readMemoryInstallProfile(db) ?? installProfile};
    }
    db.exec(MEMORY_V4_TABLE_DDL);
    if (tableExists(db, 'memory_records')) {
      addMissingColumns(db);
      backfillRecords(db, hooks);
      registerLegacySubjects(db, hooks);
      isolateDuplicateActiveSubjects(db, hooks);
      db.exec(MEMORY_RECORD_INDEX_DDL.join(';\n'));
    }
    writeInstallProfile(db, hooks, installProfile);
    db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(?,?,?)')
      .run(4, hooks.digest(MEMORY_V4_MIGRATION_CHECKSUM_INPUT), hooks.now());
    if (ownTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownTransaction && db.isTransaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw error;
  }
  return {migrated:true, installProfile, backupPath};
}

/** Idempotently apply v5 only (pin/decay/consolidation columns, relations + consolidations tables). */
function ensureMemoryV5(db: DatabaseSync, hooks: MemoryMigrationHooks): {migrated:boolean; backupPath?:string} {
  db.exec(MEMORY_V5_TABLE_DDL);
  addMissingV5Columns(db);
  if (db.prepare('SELECT 1 FROM memory_migrations WHERE version=5').get()) return {migrated:false};
  const backupPath = backupBefore(db, hooks.dataDir, 'v5');
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    if (ownTransaction && db.prepare('SELECT 1 FROM memory_migrations WHERE version=5').get()) {
      db.exec('ROLLBACK');
      try { rmSync(backupPath, {force:true}); } catch { /* Another reader may hold the file; harmless. */ }
      return {migrated:false};
    }
    db.exec(MEMORY_V5_TABLE_DDL);
    addMissingV5Columns(db);
    if (tableExists(db, 'memory_records')) db.exec(MEMORY_V5_RECORD_INDEX_DDL.join(';\n'));
    db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(?,?,?)')
      .run(5, hooks.digest(MEMORY_V5_MIGRATION_CHECKSUM_INPUT), hooks.now());
    if (ownTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownTransaction && db.isTransaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ } }
    throw error;
  }
  return {migrated:true, backupPath};
}

/**
 * Idempotently bring the database to the latest memory schema (currently v5).
 *
 * The caller must have created the v2/v3 base tables (index.ts does this before
 * calling); on a completely empty database only the new tables and the install
 * profile are created. Never runs v2/v3. v4 and v5 are separately backed up and
 * applied transactionally, so a failure leaves the last committed version intact.
 */
export function ensureMemorySchema(db: DatabaseSync, hooks: MemoryMigrationHooks): MemorySchemaResult {
  if (!hooks || typeof hooks.dataDir !== 'string' || !hooks.dataDir) throw new Error('内存迁移缺少数据目录');
  if (typeof hooks.now !== 'function' || typeof hooks.digest !== 'function' || typeof hooks.semanticDigest !== 'function'
    || typeof hooks.normalizeSubjectKey !== 'function' || typeof hooks.normalizeSubjectValue !== 'function' || typeof hooks.recordClaim !== 'function') {
    throw new Error('内存迁移回调不完整');
  }
  const v4 = ensureMemoryV4(db, hooks);
  const v5 = ensureMemoryV5(db, hooks);
  return {
    version: MEMORY_SCHEMA_VERSION,
    migrated: v4.migrated || v5.migrated,
    installProfile: v4.installProfile,
    ...(v4.backupPath ? {backupPath: v4.backupPath, v4BackupPath: v4.backupPath} : {}),
    ...(v5.backupPath ? {v5BackupPath: v5.backupPath} : {}),
    migrations: {v4: v4.migrated, v5: v5.migrated},
  };
}


function addMissingColumns(db: DatabaseSync): void {
  const existing = columnNames(db, 'memory_records');
  for (const column of MEMORY_RECORD_COLUMNS) {
    if (existing.has(column.name)) continue;
    db.exec(`ALTER TABLE memory_records ADD COLUMN ${column.name} ${column.declaration}`);
  }
}

function evidenceList(record: LegacyRecord): LegacyEvidence[] {
  return Array.isArray(record.evidence) ? record.evidence.filter((item): item is LegacyEvidence => !!item && typeof item === 'object') : [];
}

/** Spec §2.3 trust backfill. `method` is a legacy read-only kind and gets no trust. */
function legacyTrust(record: LegacyRecord): string | null {
  if (record.kind === 'method') return null;
  const evidence = evidenceList(record);
  const hasEvidence = evidence.length > 0 || (!Array.isArray(record.evidence) && Array.isArray(record.sources) && record.sources.length > 0);
  if (record.confirmedBy === 'user') return 'user_explicit';
  if (record.confirmedBy === 'system') {
    const pi = evidence.filter(item => item.kind === 'pi');
    if (pi.some(item => item.sourceRole === 'user')) return 'source_verified';
    if (pi.some(item => item.sourceRole === 'toolResult')) return 'tool_verified';
    return 'model_supported';
  }
  return hasEvidence ? 'model_supported' : 'model_inferred';
}

/** Spec §2.3 authority derived from the backfilled trust. */
function authorityForTrust(trust: string | null): string | null {
  switch (trust) {
    case 'user_explicit': case 'user_confirmed': return 'user';
    case 'source_verified': return 'source';
    case 'tool_verified': return 'tool';
    case 'quote_verified': case 'model_supported': case 'model_inferred': return 'model';
    case 'external_import': return 'external';
    default: return null;
  }
}

function legacySubjectKey(hooks: MemoryMigrationHooks, subject: unknown): string | null {
  const key = hooks.normalizeSubjectKey(subject);
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function backfillRecords(db: DatabaseSync, hooks: MemoryMigrationHooks): void {
  const rows = db.prepare('SELECT id,json FROM memory_records').all() as {id: string; json: string}[];
  const update = db.prepare('UPDATE memory_records SET kind_v2=?,subject_key=?,subject_cardinality=?,trust=?,authority=?,semantic_digest=?,lineage_root=? WHERE id=?');
  for (const row of rows) {
    // A corrupt record must abort the whole migration (transaction rolls back, no v4 row).
    const record = JSON.parse(String(row.json)) as LegacyRecord;
    const id = typeof record.id === 'string' && record.id ? record.id : String(row.id);
    const kindV2 = record.kind === 'method' ? null : typeof record.kind === 'string' && record.kind ? record.kind : null;
    const subjectKey = legacySubjectKey(hooks, record.subject);
    const trust = legacyTrust(record);
    const authority = authorityForTrust(trust);
    const conditions = Array.isArray(record.conditions) ? record.conditions.map(value => String(value)) : [];
    const semanticDigest = hooks.semanticDigest({
      id,
      revision: Number.isInteger(record.revision) ? Number(record.revision) : 0,
      content: typeof record.content === 'string' ? record.content : '',
      conditions,
      validFrom: typeof record.validFrom === 'string' ? record.validFrom : null,
      validTo: typeof record.validTo === 'string' ? record.validTo : null,
      scope: typeof record.scope === 'string' ? record.scope : 'project',
    });
    const parentIds = Array.isArray(record.parentIds) ? record.parentIds : [];
    const firstParent = parentIds.find(value => typeof value === 'string' && value) as string | undefined;
    const lineageRoot = firstParent ?? id;
    update.run(kindV2, subjectKey, subjectKey ? 'single' : null, trust, authority, semanticDigest, lineageRoot, String(row.id));
  }
}

function keeperRank(row: RecordRow): {user: number; updated: number; id: string} {
  let json: LegacyRecord = {};
  try { json = JSON.parse(row.json) as LegacyRecord; } catch { /* A corrupt record already failed the backfill. */ }
  const updated = typeof json.updatedAt === 'string' ? Date.parse(json.updatedAt) : Number.NaN;
  return {
    user: json.confirmedBy === 'user' ? 1 : 0,
    updated: Number.isFinite(updated) ? updated : Number.NEGATIVE_INFINITY,
    id: row.id,
  };
}

/**
 * A record can only stay active for a single-cardinality subject once. Keep
 * "user confirmed first, newest updatedAt next" and isolate every other active
 * row as a candidate with an open migration conflict (spec §2.3).
 */
function isolateDuplicateActiveSubjects(db: DatabaseSync, hooks: MemoryMigrationHooks): void {
  const rows = db.prepare("SELECT id,project_id,scope,revision,json,subject_key FROM memory_records WHERE status='active' AND subject_key IS NOT NULL").all() as unknown as RecordRow[];
  const groups = new Map<string, RecordRow[]>();
  for (const row of rows) {
    const key = `${row.project_id}\u0000${row.scope}\u0000${row.subject_key}`;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const isolate = db.prepare("UPDATE memory_records SET status='candidate',conflict_state='open',json=? WHERE id=?");
  const insertConflict = db.prepare(`INSERT INTO memory_conflicts(id,project_id,scope,subject_key,status,resolution,opened_at,opened_by,resolved_at,resolved_by,policy_version,notes,json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  const insertSide = db.prepare(`INSERT INTO memory_conflict_sides(conflict_id,side,memory_id,revision,claim_hash,support_score,evidence_json)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(conflict_id,side) DO NOTHING`);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a,b) => {
      const ra = keeperRank(a), rb = keeperRank(b);
      if (ra.user !== rb.user) return rb.user - ra.user;
      if (ra.updated !== rb.updated) return rb.updated > ra.updated ? 1 : -1;
      return ra.id.localeCompare(rb.id);
    });
    const keeper = sorted[0];
    const isolated = sorted.slice(1);
    for (const row of isolated) {
      const record = JSON.parse(row.json) as LegacyRecord;
      const next = {...record, status:'candidate', invalidatedReason:'迁移：同 subject 多 active，已隔离待裁决'};
      isolate.run(JSON.stringify(next), row.id);
    }
    const conflictId = hooks.digest(['legacy-subject', keeper.project_id, keeper.scope, keeper.subject_key]);
    const openedAt = hooks.now();
    const notes = '迁移：同 subject 多 active，已隔离待裁决';
    const claim = (row: RecordRow) => {
      const record = JSON.parse(row.json) as LegacyRecord;
      return hooks.recordClaim({
        id: row.id,
        content: typeof record.content === 'string' ? record.content : '',
        conditions: Array.isArray(record.conditions) ? record.conditions.map(value => String(value)) : [],
      });
    };
    const sides = [
      {side:'left' as const, memoryId:keeper.id, revision:Number(keeper.revision), claimHash:claim(keeper), supportScore:0, evidence:[]},
      {side:'right' as const, memoryId:isolated[0].id, revision:Number(isolated[0].revision), claimHash:claim(isolated[0]), supportScore:0, evidence:[]},
    ];
    const conflict = {
      id: conflictId, projectId: keeper.project_id, scope: keeper.scope, subjectKey: keeper.subject_key,
      status: 'open', resolution: null, openedAt, openedBy: 'migration', notes, sides,
    };
    insertConflict.run(conflictId, keeper.project_id, keeper.scope, keeper.subject_key, 'open', null, openedAt, 'migration', null, null, null, notes, JSON.stringify(conflict));
    for (const side of sides) insertSide.run(conflictId, side.side, side.memoryId, side.revision, side.claimHash, side.supportScore, JSON.stringify(side.evidence));
  }
}

/**
 * Register one memory_subjects definition for each distinct legacy
 * (project, scope, subject_key) so later conflict detection can find a
 * definition. The label keeps the first (oldest created_at) original subject
 * string; existing registry rows always win (ON CONFLICT DO NOTHING).
 */
function registerLegacySubjects(db: DatabaseSync, hooks: MemoryMigrationHooks): void {
  const rows = db.prepare('SELECT project_id,scope,json FROM memory_records WHERE subject_key IS NOT NULL').all() as {project_id: string; scope: string; json: string}[];
  if (!rows.length) return;
  const definitions = new Map<string, {projectId: string; scope: string; key: string; label: string; createdAt: string}>();
  for (const row of rows) {
    const record = JSON.parse(String(row.json)) as LegacyRecord;
    const key = legacySubjectKey(hooks, record.subject);
    if (!key) continue;
    const projectId = String(row.project_id), scope = String(row.scope);
    const bucket = `${projectId}\u0000${scope}\u0000${key}`;
    const label = typeof record.subject === 'string' && record.subject.trim() ? record.subject.trim() : key;
    const createdAt = typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : '';
    const existing = definitions.get(bucket);
    if (!existing) definitions.set(bucket, {projectId, scope, key, label, createdAt});
    else if (createdAt && (!existing.createdAt || createdAt < existing.createdAt)) {
      existing.label = label;
      existing.createdAt = createdAt;
    }
  }
  const insert = db.prepare(`INSERT INTO memory_subjects(project_id,scope,key,label,aliases_json,cardinality,value_type,sensitivity,created_at,updated_at)
    VALUES(?,?,?,?,'[]','single','freeform','normal',?,?) ON CONFLICT(project_id,scope,key) DO NOTHING`);
  const registeredAt = hooks.now();
  for (const definition of definitions.values()) {
    insert.run(definition.projectId, definition.scope, definition.key, definition.label.slice(0, 200), registeredAt, registeredAt);
  }
}

function writeInstallProfile(db: DatabaseSync, hooks: MemoryMigrationHooks, profile: MemoryInstallProfile): void {
  if (readMemoryInstallProfile(db) !== undefined) return;
  db.prepare('INSERT INTO documents(namespace,key,revision,json) VALUES(?,?,?,?)')
    .run(MEMORY_INSTALL_PROFILE_NAMESPACE, MEMORY_INSTALL_PROFILE_KEY, 1, JSON.stringify({v:1, profile, at:hooks.now()}));
}

/**
 * Idempotently bring the database to memory schema v4.
 *
 * The caller must have created the v2/v3 base tables (index.ts does this before
 * calling); on a completely empty database only the v4 tables and the install
 * profile are created. Never runs v2/v3.
 */
