/**
 * Memory v3→v5 / v4→v5 migration drill (blueprint §13.6, P4).
 *
 *   node --import tsx benchmarks/memory/migration-drill.mjs
 *
 * Builds two realistic SQLite fixtures in a throw-away directory:
 *   - v3: the shipped 2a1b8d0 schema with every record status, a legacy
 *         `method` row, completed/queued learning jobs with a proposal ledger,
 *         usage/suppression/operation rows and the v2/v3 migration rows;
 *   - v4: the same data after the P0-S v4 migration, plus v4-only policy,
 *         audit, review and conflict rows.
 * Each fixture is opened with the real MemoryController (which migrates it),
 * then the drill verifies:
 *   - a backup exists, is openable and keeps the pre-migration rows;
 *   - record/job/usage/suppression/operation content is preserved;
 *   - forget suppression survives and a re-learned proposal cannot revive it;
 *   - an old writer (friend_pi_writer_version() => 4) can read but not write;
 *   - a second open is idempotent (no migration row, no new backup, no dupes);
 *   - when schema v5 is present: version 5 row, writer 6 fence, v5 tables and
 *     columns. Otherwise those assertions are reported as PENDING_SCHEMA_V5.
 *
 * Evidence: `.artifacts/qa/memory-migration-drill.json`. Fixtures stay under
 * `.artifacts/qa/memory-migration-drill/<run-id>/` so the evidence is auditable.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MemoryController, memorySemanticDigest, peekLearningJob } from '../../packages/memory/src/index.ts';
// Namespace import: the drill must still load when an older checkout has not
// exported the v5 constants yet (they are then simply undefined and the v5
// assertions are reported as PENDING_SCHEMA_V5).
import * as memorySchema from '../../packages/memory/src/schema.ts';
import { normalizeSubjectKey } from '../../packages/memory/src/subjects.ts';
import { digest } from '../../packages/core/src/index.ts';

const MEMORY_MIGRATION_BACKUP_DIR = memorySchema.MEMORY_MIGRATION_BACKUP_DIR ?? 'memory-migration-backups';
const MEMORY_RECORD_COLUMNS = memorySchema.MEMORY_RECORD_COLUMNS ?? [];
const MEMORY_RECORD_INDEX_DDL = memorySchema.MEMORY_RECORD_INDEX_DDL ?? [];
const MEMORY_SCHEMA_VERSION = memorySchema.MEMORY_SCHEMA_VERSION ?? 4;
const MEMORY_V4_MIGRATION_CHECKSUM_INPUT = memorySchema.MEMORY_V4_MIGRATION_CHECKSUM_INPUT ?? 'memory-v4';
const MEMORY_V4_TABLE_DDL = memorySchema.MEMORY_V4_TABLE_DDL ?? '';
const MEMORY_V5_MIGRATION_CHECKSUM_INPUT = memorySchema.MEMORY_V5_MIGRATION_CHECKSUM_INPUT ?? 'memory-v5';
const MEMORY_V5_RECORD_COLUMNS = memorySchema.MEMORY_V5_RECORD_COLUMNS ?? [];
const MEMORY_V5_TABLES = memorySchema.MEMORY_V5_TABLES ?? ['memory_relations', 'memory_consolidations'];
const MEMORY_WRITER_VERSION = memorySchema.MEMORY_WRITER_VERSION ?? 5;

export const DEFAULT_OUT = '.artifacts/qa/memory-migration-drill.json';
const NOW = '2026-10-17T12:00:00.000Z';
const FORGOTTEN = '遗忘正文不得复活 BENCH_FORGET_9。';
const OLD_WRITER_VERSION = 4;
const PROJECT = 'p';

function normalizeContent(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Controller rule (P0): only ASCII legacy subjects become reliable subject keys. */
function normalizeMemorySubjectKeyForDrill(raw) {
  const value = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!value || /[^\x00-\x7F]/u.test(value)) return undefined;
  return normalizeSubjectKey(value);
}

function sourceOf(entryId, text) {
  return {sessionId: 's', entryId, start: 0, end: text.length, hash: digest(text)};
}

function legacyRecord(overrides) {
  const record = {
    revision: 1,
    projectId: PROJECT,
    scope: 'project',
    schemaVersion: 2,
    kind: 'fact',
    title: overrides.id,
    status: 'candidate',
    enabled: true,
    sources: [],
    parentIds: [],
    aliases: [],
    conditions: [],
    evidence: [],
    dependencies: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
  record.hash = digest(record.content);
  record.fingerprint = record.fingerprint ?? digest(record.content);
  record.semanticDigest = memorySemanticDigest(record);
  if (record.kind === 'method') record.legacy = true;
  return record;
}

const ENTRIES = [
  {id: 'user1', parentId: null, type: 'message', role: 'user', timestamp: NOW, text: '订单数据库必须使用 SQLite。仅测试环境。', userText: '订单数据库必须使用 SQLite。仅测试环境。'},
  {id: 'user2', parentId: 'user1', type: 'message', role: 'user', timestamp: NOW, text: '迁移任务读取旧表时必须使用只读事务。', userText: '迁移任务读取旧表时必须使用只读事务。'},
  {id: 'assistant1', parentId: 'user2', type: 'message', role: 'assistant', timestamp: NOW, text: '助手观察：迁移窗口内不要写业务数据。'},
  {id: 'forgotten', parentId: 'assistant1', type: 'message', role: 'user', timestamp: NOW, text: FORGOTTEN, userText: FORGOTTEN},
];

function fixtureRecords() {
  return [
    legacyRecord({
      id: 'fact-active',
      content: '订单数据库必须使用 SQLite。',
      title: '订单数据库引擎',
      status: 'active',
      confirmedBy: 'user',
      subject: 'orders.database.engine',
      conditions: ['仅测试环境'],
      sources: [sourceOf('user1', ENTRIES[0].text)],
      evidence: [{
        kind: 'pi', evidenceId: 'evidence-1', relation: 'supports', observedAt: NOW,
        source: sourceOf('user1', ENTRIES[0].text), sourceRole: 'user', visibility: 'native-text',
      }],
    }),
    legacyRecord({
      id: 'candidate-experience',
      content: '迁移任务读取旧表时必须使用只读事务。',
      title: '迁移只读经验',
      kind: 'experience',
      status: 'candidate',
      confirmedBy: 'system',
      sources: [sourceOf('user2', ENTRIES[1].text)],
      evidence: [{
        kind: 'pi', evidenceId: 'evidence-2', relation: 'supports', observedAt: NOW,
        source: sourceOf('user2', ENTRIES[1].text), sourceRole: 'assistant', visibility: 'native-text',
      }],
    }),
    legacyRecord({
      id: 'inactive-preference',
      content: '今后默认用中文解释。',
      title: '中文解释偏好',
      kind: 'preference',
      scope: 'personal',
      status: 'inactive',
      enabled: false,
      confirmedBy: 'user',
      sources: [sourceOf('user1', ENTRIES[0].text)],
      invalidatedReason: '用户已停用',
    }),
    legacyRecord({
      id: 'invalidated-derived',
      content: '派生自订单库迁移步骤。',
      title: '迁移步骤派生',
      status: 'invalidated',
      enabled: false,
      parentIds: ['fact-active'],
      invalidatedReason: '父记忆已纠正',
    }),
    legacyRecord({
      id: 'legacy-method',
      content: '旧方法：先备份再迁移。',
      title: '旧迁移方法',
      kind: 'method',
      status: 'inactive',
      enabled: false,
    }),
  ];
}

function fixtureJobs(records) {
  const completed = {
    id: 'job-completed',
    projectId: PROJECT,
    sessionId: 's',
    sources: [sourceOf('user1', ENTRIES[0].text)],
    fingerprint: digest('job-completed'),
    state: 'completed',
    stage: 'compact',
    attempts: 0,
    memoryIds: ['fact-active', 'candidate-experience'],
    createdAt: NOW,
    updatedAt: NOW,
    ruleVersion: 2,
    budgetId: 'budget-legacy',
    sourceRunId: 'run-1',
    operationId: 'operation-legacy',
    callIds: ['call-legacy'],
    sourceRanges: [sourceOf('user1', ENTRIES[0].text)],
    coveredRanges: [sourceOf('user1', ENTRIES[0].text)],
    pendingRanges: [],
    pendingArtifacts: [],
    proposalLedger: [
      {
        id: 'proposal-published', operationId: 'extract-legacy', ordinal: 0,
        contentHash: digest(records[0].content), original: {content: records[0].content, kind: 'fact'},
        state: 'published', groupId: 'group-legacy', memoryId: 'fact-active',
      },
      {
        id: 'proposal-candidate', operationId: 'extract-legacy', ordinal: 1,
        contentHash: digest(records[1].content), original: {content: records[1].content, kind: 'experience'},
        state: 'candidate', groupId: 'group-legacy', memoryId: 'candidate-experience', reason: '等待用户确认',
      },
    ],
    modelOperations: [{operationId: 'extract-legacy', stage: 'extract', callId: 'call-legacy'}],
    diagnostics: {v: 1, publication: {active: 1, candidates: 1}},
  };
  const queued = {
    id: 'job-queued',
    projectId: PROJECT,
    sessionId: 's',
    sources: [sourceOf('user2', ENTRIES[1].text)],
    fingerprint: digest('job-queued'),
    state: 'queued',
    stage: 'validate',
    attempts: 1,
    memoryIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ruleVersion: 2,
    budgetId: 'budget-queued',
    proposalLedger: [{
      id: 'proposal-pending', operationId: 'extract-queued', ordinal: 0,
      contentHash: digest('等待校验的提案'), original: {content: '等待校验的提案', kind: 'fact'},
      state: 'pending', groupId: 'group-queued',
    }],
    modelOperations: [{operationId: 'extract-queued', stage: 'extract', callId: 'call-queued'}],
    pendingRanges: [sourceOf('user2', ENTRIES[1].text)],
  };
  return [completed, queued];
}

function baseSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS documents(namespace TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,key));
CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,state TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_suppression(project_id TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,kind,hash));
CREATE TABLE IF NOT EXISTS memory_usage(receipt_id TEXT PRIMARY KEY,run_id TEXT,stage TEXT,json TEXT);
CREATE TABLE IF NOT EXISTS memory_operations(operation_id TEXT PRIMARY KEY,payload_hash TEXT,state TEXT,json TEXT);
CREATE TABLE IF NOT EXISTS memory_migrations(version INTEGER PRIMARY KEY,checksum TEXT,applied_at TEXT);
`);
}

function trustOf(record) {
  if (record.kind === 'method') return null;
  const evidence = Array.isArray(record.evidence) ? record.evidence.filter(item => item && typeof item === 'object') : [];
  const hasEvidence = evidence.length > 0 || (record.evidence === undefined && Array.isArray(record.sources) && record.sources.length > 0);
  if (record.confirmedBy === 'user') return 'user_explicit';
  if (record.confirmedBy === 'system') {
    const roles = evidence.filter(item => item.kind === 'pi').map(item => item.sourceRole);
    if (roles.includes('user')) return 'source_verified';
    if (roles.includes('toolResult')) return 'tool_verified';
    return 'model_supported';
  }
  return hasEvidence ? 'model_supported' : 'model_inferred';
}

const AUTHORITY = {
  user_explicit: 'user', user_confirmed: 'user', source_verified: 'source', tool_verified: 'tool',
  quote_verified: 'model', model_supported: 'model', model_inferred: 'model', external_import: 'external',
};

function v4Meta(record) {
  const trust = trustOf(record);
  const subjectKey = normalizeMemorySubjectKeyForDrill(record.subject);
  const parentIds = Array.isArray(record.parentIds) ? record.parentIds : [];
  return {
    kind_v2: record.kind === 'method' ? null : String(record.kind),
    subject_key: subjectKey ?? null,
    subject_cardinality: subjectKey ? 'single' : null,
    trust,
    authority: trust ? AUTHORITY[trust] ?? null : null,
    semantic_digest: memorySemanticDigest(record),
    lineage_root: parentIds.find(value => typeof value === 'string' && value) ?? record.id,
  };
}

/** Apply the shipped v4 DDL + backfill without touching v5. */
function applyV4(db, records) {
  db.exec(MEMORY_V4_TABLE_DDL);
  const columns = new Set(db.prepare('PRAGMA table_info(memory_records)').all().map(row => String(row.name)));
  for (const column of MEMORY_RECORD_COLUMNS) {
    if (columns.has(column.name)) continue;
    db.exec(`ALTER TABLE memory_records ADD COLUMN ${column.name} ${column.declaration}`);
  }
  const update = db.prepare(`UPDATE memory_records SET kind_v2=?,subject_key=?,subject_cardinality=?,trust=?,authority=?,semantic_digest=?,lineage_root=? WHERE id=?`);
  for (const record of records) {
    const meta = v4Meta(record);
    update.run(meta.kind_v2, meta.subject_key, meta.subject_cardinality, meta.trust, meta.authority, meta.semantic_digest, meta.lineage_root, record.id);
  }
  db.exec(MEMORY_RECORD_INDEX_DDL.join(';\n'));
  db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(4,?,?)').run(digest(MEMORY_V4_MIGRATION_CHECKSUM_INPUT), NOW);
  db.prepare("INSERT OR REPLACE INTO documents(namespace,key,revision,json) VALUES('memory','install-profile',1,?)").run(JSON.stringify({v: 1, profile: 'upgraded', at: NOW}));
  db.prepare(`INSERT OR REPLACE INTO memory_subjects(project_id,scope,key,label,aliases_json,cardinality,value_type,sensitivity,created_at,updated_at)
    VALUES(?,?,?,?,'[]','single','freeform','normal',?,?)`).run(PROJECT, 'project', 'orders.database.engine', 'Orders.Database.Engine', NOW, NOW);
  db.prepare(`INSERT OR REPLACE INTO memory_policies(id,project_id,scope,kind,mode,min_score,max_auto_per_day,allowed_trust_json,require_review,version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    `autopublish:${PROJECT}`, PROJECT, '*', '*', 'standard', 70, 100,
    JSON.stringify(['user_explicit', 'user_confirmed', 'source_verified', 'tool_verified', 'quote_verified', 'model_supported']),
    0, 1, NOW,
  );
  db.prepare(`INSERT OR REPLACE INTO memory_autopublish_audit(id,project_id,memory_id,revision,action,mode,policy_id,policy_version,score,gates_json,trust,authority,job_id,actor,before_json,after_json,rollback_token,batch_key,created_at,revoked_at,revoke_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'audit-legacy', PROJECT, 'fact-active', 2, 'publish', 'standard', `autopublish:${PROJECT}`, 1, 82,
    '[]', 'source_verified', 'source', 'job-completed', 'system', '{}', '{}', 'a'.repeat(64), 'job-completed', NOW, null, null,
  );
  db.prepare(`INSERT OR REPLACE INTO memory_reviews(id,project_id,memory_id,revision,reason,priority,due_at,status,created_at,resolved_at,resolution,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'review-legacy', PROJECT, 'candidate-experience', 1, 'review-after', 70, NOW, 'open', NOW, null, null, '迁移前到期复审',
  );
  const recordById = new Map(records.map(record => [record.id, record]));
  const left = recordById.get('fact-active');
  const right = recordById.get('invalidated-derived');
  const conflictJson = {
    id: 'conflict-legacy', projectId: PROJECT, scope: 'project', subjectKey: 'orders.database.engine',
    status: 'resolved', resolution: 'keep_left', openedAt: NOW, openedBy: 'user', resolvedAt: NOW, resolvedBy: 'user',
    policyVersion: 1, notes: '迁移前已裁决',
    sides: [
      {side: 'left', memoryId: left.id, revision: left.revision, claimHash: digest(left.content), supportScore: 0, evidence: []},
      {side: 'right', memoryId: right.id, revision: right.revision, claimHash: digest(right.content), supportScore: 0, evidence: []},
    ],
  };
  db.prepare(`INSERT OR REPLACE INTO memory_conflicts(id,project_id,scope,subject_key,status,resolution,opened_at,opened_by,resolved_at,resolved_by,policy_version,notes,json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    conflictJson.id, PROJECT, 'project', 'orders.database.engine', 'resolved', 'keep_left', NOW, 'user', NOW, 'user', 1, '迁移前已裁决', JSON.stringify(conflictJson),
  );
  for (const side of conflictJson.sides) {
    db.prepare(`INSERT OR REPLACE INTO memory_conflict_sides(conflict_id,side,memory_id,revision,claim_hash,support_score,evidence_json)
      VALUES(?,?,?,?,?,?,?)`).run(conflictJson.id, side.side, side.memoryId, side.revision, side.claimHash, side.supportScore, JSON.stringify(side.evidence));
  }
}

/**
 * Build one realistic fixture. `schema: 'v3'` stops at the shipped v3 schema;
 * `schema: 'v4'` additionally applies the v4 DDL/backfill and v4-only rows.
 */
export function createLegacyFixture({dir, schema = 'v3'}) {
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const path = join(dir, 'plugins.sqlite');
  const records = fixtureRecords();
  const jobs = fixtureJobs(records);
  const db = new DatabaseSync(path);
  try {
    baseSchema(db);
    const insertRecord = db.prepare('INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES(?,?,?,?,?,?,?)');
    for (const record of records) {
      insertRecord.run(record.id, record.projectId, record.scope, record.status, Number(record.enabled), record.revision, JSON.stringify(record));
      db.prepare('INSERT INTO memory_versions(id,revision,json) VALUES(?,?,?)').run(record.id, record.revision, JSON.stringify(record));
    }
    const insertJob = db.prepare('INSERT INTO memory_jobs(id,project_id,fingerprint,state,json) VALUES(?,?,?,?,?)');
    for (const job of jobs) insertJob.run(job.id, job.projectId, job.fingerprint, job.state, JSON.stringify(job));
    db.prepare('INSERT INTO memory_suppression(project_id,kind,hash,reason,created_at) VALUES(?,?,?,?,?)')
      .run(PROJECT, 'content', digest(normalizeContent(FORGOTTEN)), 'forgotten', NOW);
    db.prepare('INSERT INTO memory_suppression(project_id,kind,hash,reason,created_at) VALUES(?,?,?,?,?)')
      .run(PROJECT, 'family', digest(['family', FORGOTTEN]), 'forgotten', NOW);
    db.prepare('INSERT INTO memory_usage(receipt_id,run_id,stage,json) VALUES(?,?,?,?)').run(
      'receipt-legacy', 'run-1', 'prepared',
      JSON.stringify({v: 1, operationId: 'operation-legacy', projectId: PROJECT, sessionId: 's', runId: 'run-1', at: NOW, channel: 'context-recall', stage: 'prepared', records: [], budget: {unit: 'characters', limit: 3500, used: 0}}),
    );
    db.prepare('INSERT INTO memory_operations(operation_id,payload_hash,state,json) VALUES(?,?,?,?)').run(
      'operation-legacy', digest('operation-legacy'), 'committed', JSON.stringify({record: 'fact-active', content: records[0].content}),
    );
    db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(2,?,?)').run(digest('memory-v2'), NOW);
    db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(3,?,?)').run(digest('memory-durable-proposals-v1'), NOW);
    if (schema === 'v4') applyV4(db, records);
  } finally {
    db.close();
  }
  return {schema, dir, path, records, jobs, forgotten: FORGOTTEN};
}

function listBackups(dir) {
  const root = join(dir, MEMORY_MIGRATION_BACKUP_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => name.endsWith('.sqlite')).sort();
}

function readRows(db, statement, ...parameters) {
  return db.prepare(statement).all(...parameters).map(row => ({...row}));
}

function inspectDatabase(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const records = new Map(readRows(db, 'SELECT id,status,json FROM memory_records').map(row => [String(row.id), {status: String(row.status), json: String(row.json)}]));
    const jobs = new Map(readRows(db, 'SELECT id,state,json FROM memory_jobs').map(row => [String(row.id), {state: String(row.state), json: String(row.json)}]));
    const tables = new Set(readRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name)));
    const tableRows = (table, statement) => (tables.has(table) ? readRows(db, statement) : []);
    const migrations = readRows(db, 'SELECT version,checksum FROM memory_migrations ORDER BY version');
    const counts = {};
    for (const table of ['memory_records', 'memory_versions', 'memory_jobs', 'memory_suppression', 'memory_usage', 'memory_operations', 'memory_conflicts', 'memory_conflict_sides', 'memory_reviews', 'memory_policies', 'memory_autopublish_audit', 'memory_subjects']) {
      counts[table] = tables.has(table) ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : 0;
    }
    return {
      records,
      jobs,
      migrations,
      counts,
      tables: [...tables],
      suppressions: readRows(db, 'SELECT project_id,kind,hash,reason FROM memory_suppression ORDER BY kind,hash').map(row => ({...row})),
      usage: readRows(db, 'SELECT receipt_id,run_id,stage,json FROM memory_usage ORDER BY receipt_id').map(row => ({...row})),
      operations: readRows(db, 'SELECT operation_id,payload_hash,state,json FROM memory_operations ORDER BY operation_id').map(row => ({...row})),
      v4Only: {
        policy: tableRows('memory_policies', 'SELECT id,mode,version FROM memory_policies'),
        audit: tableRows('memory_autopublish_audit', 'SELECT id,action,rollback_token FROM memory_autopublish_audit'),
        review: tableRows('memory_reviews', 'SELECT id,status,reason FROM memory_reviews'),
        conflict: tableRows('memory_conflicts', 'SELECT id,status,resolution FROM memory_conflicts'),
      },
    };
  } finally {
    db.close();
  }
}

function check(checks, id, title, status, detail) {
  checks.push({id, title, status, detail});
  return status;
}

function pass(checks, id, title, detail) { return check(checks, id, title, 'PASS', detail); }
function fail(checks, id, title, detail) { return check(checks, id, title, 'FAIL', detail); }

function makeContext(dir) {
  const entries = ENTRIES.map(entry => ({...entry}));
  return {
    entries,
    ctx: {
      origin: 'user',
      dataDir: dir,
      projectDir: dir,
      projectId: PROJECT,
      sessionId: 's',
      runId: 'drill-run',
      modelId: 'fixture/offline',
      isIdle: () => true,
      history: () => entries,
      readSource(source) {
        const item = entries.find(entry => entry.id === source.entryId);
        if (!item) throw new Error(`来源不存在：${source.entryId}`);
        return item;
      },
      complete: async () => '{"memories":[]}',
      request: async () => { throw new Error('not installed'); },
      emit: () => {},
      notify: () => {},
      appendEntry: () => {},
      pushEntry: entry => entries.push(entry),
    },
  };
}

async function attemptRevival(controller, ctx) {
  ctx.pushEntry({id: 'revival', parentId: 'forgotten', type: 'message', role: 'user', timestamp: NOW, text: FORGOTTEN, userText: FORGOTTEN});
  ctx.sessionId = 'review-1';
  ctx.complete = async () => JSON.stringify({memories: [{
    kind: 'fact', title: '遗忘正文重学', content: FORGOTTEN,
    sourceEntryIds: ['revival'], sourceQuotes: {revival: FORGOTTEN},
  }]});
  await controller.settled(ctx);
  for (let round = 0; round < 10; round++) {
    const job = peekLearningJob(ctx.dataDir);
    if (!job) return;
    const result = await controller.executeLearningJob(job.id, ctx);
    if (!result.executed || result.job?.state === 'failed' || result.job?.state === 'waiting_configuration') return;
  }
}

function writerFenceCheck(checks, path, expectedRecords) {
  const raw = new DatabaseSync(path);
  try {
    raw.function('friend_pi_writer_version', {deterministic: true}, () => OLD_WRITER_VERSION);
    const readCount = Number(raw.prepare('SELECT COUNT(*) AS count FROM memory_records').get().count);
    if (readCount === expectedRecords) pass(checks, 'writer.old.read', 'old writer can read the migrated database', `records=${readCount}`);
    else fail(checks, 'writer.old.read', 'old writer can read the migrated database', `records=${readCount}, expected=${expectedRecords}`);
    const triggers = readRows(raw, "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'friend_memory%'");
    const minimums = triggers.map(row => Number(String(row.sql).match(/friend_pi_writer_version\(\)<(\d+)/)?.[1] ?? 0));
    const fence = minimums.length ? Math.max(...minimums) : 0;
    if (fence > OLD_WRITER_VERSION) pass(checks, 'writer.old.fence-installed', 'writer-version fence is installed', `minimum=${fence}`);
    else fail(checks, 'writer.old.fence-installed', 'writer-version fence is installed', `triggers=${triggers.length} minimum=${fence}`);

    let writeError;
    try {
      raw.prepare("INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES('intruder','p','project','candidate',1,1,'{}')").run();
    } catch (error) {
      writeError = error;
    }
    let updateError;
    try {
      raw.prepare("UPDATE memory_records SET status='inactive' WHERE id='fact-active'").run();
    } catch (error) {
      updateError = error;
    }
    const afterCount = Number(raw.prepare('SELECT COUNT(*) AS count FROM memory_records').get().count);
    const blocked = /newer writer/iu.test(String(writeError?.message ?? '')) && /newer writer/iu.test(String(updateError?.message ?? ''));
    if (blocked && afterCount === expectedRecords) pass(checks, 'writer.old.write-blocked', 'old writer writes fail closed', `error=${String(writeError?.message).slice(0, 80)}`);
    else fail(checks, 'writer.old.write-blocked', 'old writer writes fail closed', `insert=${String(writeError?.message ?? 'NO ERROR')} update=${String(updateError?.message ?? 'NO ERROR')} records=${afterCount}`);
  } finally {
    raw.close();
  }
}

function v5Checks(checks, path, inspect) {
  const version = MEMORY_SCHEMA_VERSION;
  if (version < 5) {
    const pending = [
      'v5.schema-version', 'v5.writer-version', 'v5.migration-row', 'v5.tables', 'v5.record-columns', 'v5.writer-fence',
    ];
    for (const id of pending) check(checks, id, 'schema v5 assertion', 'PENDING_SCHEMA_V5', `current schema version is ${version}`);
    return;
  }
  const tables = new Set(inspect.tables);
  const migration5 = inspect.migrations.find(row => Number(row.version) === 5);
  if (migration5 && migration5.checksum === digest(MEMORY_V5_MIGRATION_CHECKSUM_INPUT)) pass(checks, 'v5.migration-row', 'v5 migration row + checksum', migration5.checksum);
  else fail(checks, 'v5.migration-row', 'v5 migration row + checksum', JSON.stringify(migration5 ?? null));
  if (MEMORY_WRITER_VERSION === 6) pass(checks, 'v5.writer-version', 'writer version is 6', String(MEMORY_WRITER_VERSION));
  else fail(checks, 'v5.writer-version', 'writer version is 6', String(MEMORY_WRITER_VERSION));
  const missingTables = MEMORY_V5_TABLES.filter(table => !tables.has(table));
  if (!missingTables.length) pass(checks, 'v5.tables', 'v5 relations/consolidations tables exist', MEMORY_V5_TABLES.join(','));
  else fail(checks, 'v5.tables', 'v5 relations/consolidations tables exist', `missing=${missingTables.join(',')}`);
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const columns = new Set(readRows(db, 'PRAGMA table_info(memory_records)').map(row => String(row.name)));
    const missing = MEMORY_V5_RECORD_COLUMNS.filter(column => !columns.has(column.name)).map(column => column.name);
    if (!missing.length) pass(checks, 'v5.record-columns', 'v5 pinned/decay/consolidation columns exist', MEMORY_V5_RECORD_COLUMNS.map(column => column.name).join(','));
    else fail(checks, 'v5.record-columns', 'v5 pinned/decay/consolidation columns exist', `missing=${missing.join(',')}`);
    const triggers = readRows(db, "SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'friend_memory%'");
    const minimums = triggers.map(row => Number(String(row.sql).match(/friend_pi_writer_version\(\)<(\d+)/)?.[1] ?? 0));
    const fence = minimums.length ? Math.max(...minimums) : 0;
    if (fence === 6) pass(checks, 'v5.writer-fence', 'installed triggers require writer 6', `minimum=${fence}`);
    else fail(checks, 'v5.writer-fence', 'installed triggers require writer 6', `minimum=${fence}`);
  } finally {
    db.close();
  }
}

async function drillFixture(fixture) {
  const checks = [];
  const pre = inspectDatabase(fixture.path);
  const backupsBefore = listBackups(fixture.dir);
  const {ctx} = makeContext(fixture.dir);
  const controller = new MemoryController();
  let migration;
  try {
    controller.snapshot(ctx);
    migration = controller.schemaV4;
  } finally {
    await controller.dispose();
  }

  // --- schema reached + backup evidence ------------------------------------
  const post = inspectDatabase(fixture.path);
  const currentRow = post.migrations.find(row => Number(row.version) === MEMORY_SCHEMA_VERSION);
  if (currentRow) pass(checks, 'schema.version', `database reaches schema v${MEMORY_SCHEMA_VERSION}`, JSON.stringify(currentRow));
  else fail(checks, 'schema.version', `database reaches schema v${MEMORY_SCHEMA_VERSION}`, JSON.stringify(post.migrations));

  const backupsAfter = listBackups(fixture.dir);
  const created = backupsAfter.filter(name => !backupsBefore.includes(name));
  if (created.length && migration?.migrated === true) pass(checks, 'backup.created', 'migration created backup file(s)', created.join(','));
  else fail(checks, 'backup.created', 'migration created backup file(s)', JSON.stringify({created, migration}));
  if (existsSync(join(fixture.dir, MEMORY_MIGRATION_BACKUP_DIR))) {
    const mode = statSync(join(fixture.dir, MEMORY_MIGRATION_BACKUP_DIR)).mode & 0o777;
    if (mode === 0o700) pass(checks, 'backup.dir-mode', 'backup directory is 0700', mode.toString(8));
    else fail(checks, 'backup.dir-mode', 'backup directory is 0700', mode.toString(8));
  } else {
    fail(checks, 'backup.dir-mode', 'backup directory is 0700', 'missing');
  }
  for (const name of created) {
    const backupPath = join(fixture.dir, MEMORY_MIGRATION_BACKUP_DIR, name);
    const backup = new DatabaseSync(backupPath, {readOnly: true});
    try {
      const integrity = String(backup.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown');
      const count = Number(backup.prepare('SELECT COUNT(*) AS count FROM memory_records').get().count);
      const row = backup.prepare("SELECT json FROM memory_records WHERE id='fact-active'").get();
      const contentPreserved = !!row && String(row.json) === pre.records.get('fact-active')?.json;
      if (integrity === 'ok' && count >= pre.records.size && contentPreserved) pass(checks, `backup.openable:${name}`, 'backup opens and keeps pre-migration rows', `integrity=${integrity} records=${count}`);
      else fail(checks, `backup.openable:${name}`, 'backup opens and keeps pre-migration rows', `integrity=${integrity} records=${count} contentPreserved=${contentPreserved}`);
    } finally {
      backup.close();
    }
  }

  // --- row content is preserved ------------------------------------------
  const recordDrift = [];
  for (const [id, before] of pre.records) {
    const after = post.records.get(id);
    if (!after || after.json !== before.json || after.status !== before.status) recordDrift.push(id);
  }
  if (!recordDrift.length && post.records.size === pre.records.size) pass(checks, 'records.preserved', 'record json/status preserved', `${post.records.size} record(s)`);
  else fail(checks, 'records.preserved', 'record json/status preserved', `drift=${recordDrift.join(',')} count=${post.records.size}/${pre.records.size}`);

  const jobDrift = [];
  for (const [id, before] of pre.jobs) {
    const after = post.jobs.get(id);
    if (!after || after.json !== before.json) jobDrift.push(id);
  }
  if (!jobDrift.length && post.jobs.size === pre.jobs.size) pass(checks, 'jobs.preserved', 'learning jobs incl. proposalLedger preserved', `${post.jobs.size} job(s)`);
  else fail(checks, 'jobs.preserved', 'learning jobs incl. proposalLedger preserved', `drift=${jobDrift.join(',')}`);

  const postSuppressions = new Set(post.suppressions.map(row => JSON.stringify(row)));
  const missingSuppressions = pre.suppressions.filter(row => !postSuppressions.has(JSON.stringify(row)));
  if (!missingSuppressions.length) pass(checks, 'suppression.preserved', 'forget suppression rows survive migration', `${post.suppressions.length} row(s)`);
  else fail(checks, 'suppression.preserved', 'forget suppression rows survive migration', `missing=${missingSuppressions.length} post=${post.suppressions.length}`);
  const usagePreserved = JSON.stringify(pre.usage) === JSON.stringify(post.usage);
  if (usagePreserved) pass(checks, 'usage.preserved', 'usage receipts preserved', `${post.usage.length} row(s)`);
  else fail(checks, 'usage.preserved', 'usage receipts preserved', `pre=${pre.usage.length} post=${post.usage.length}`);
  const operationsPreserved = JSON.stringify(pre.operations) === JSON.stringify(post.operations);
  if (operationsPreserved) pass(checks, 'operations.preserved', 'operation ledger preserved', `${post.operations.length} row(s)`);
  else fail(checks, 'operations.preserved', 'operation ledger preserved', `pre=${pre.operations.length} post=${post.operations.length}`);

  // --- v4-only data survives a v5 migration (v4 fixture) -------------------
  if (fixture.schema === 'v4') {
    const policy = post.v4Only.policy.find(row => row.id === `autopublish:${PROJECT}`);
    const audit = post.v4Only.audit.find(row => row.id === 'audit-legacy');
    const review = post.v4Only.review.find(row => row.id === 'review-legacy');
    const conflict = post.v4Only.conflict.find(row => row.id === 'conflict-legacy');
    const sides = post.counts.memory_conflict_sides;
    if (policy?.mode === 'standard' && audit?.action === 'publish' && review?.status === 'open' && conflict?.status === 'resolved' && sides === 2) {
      pass(checks, 'v4.data.preserved', 'v4 policy/audit/review/conflict rows preserved', `sides=${sides}`);
    } else {
      fail(checks, 'v4.data.preserved', 'v4 policy/audit/review/conflict rows preserved', JSON.stringify({policy, audit, review, conflict, sides}));
    }
  }

  // --- forget suppression cannot be revived by a re-learned proposal -------
  const revivalController = new MemoryController();
  try {
    revivalController.snapshot(ctx);
    await attemptRevival(revivalController, ctx);
    const snapshot = revivalController.snapshot(ctx);
    const all = [...(snapshot.memories ?? []), ...(snapshot.candidates ?? [])];
    const revived = all.filter(record => String(record.content ?? '').includes('BENCH_FORGET_9'));
    if (!revived.length) pass(checks, 'suppression.no-revival', 'forgotten content cannot be re-learned into memory', `records=${all.length}`);
    else fail(checks, 'suppression.no-revival', 'forgotten content cannot be re-learned into memory', `revived=${revived.map(record => record.id).join(',')}`);
  } finally {
    await revivalController.dispose();
  }

  // --- old writer fence + second-open idempotence --------------------------
  writerFenceCheck(checks, fixture.path, post.records.size);

  const backupsBeforeReopen = listBackups(fixture.dir);
  const stateBeforeReopen = inspectDatabase(fixture.path);
  const migrationsBeforeReopen = stateBeforeReopen.migrations;
  const second = new MemoryController();
  let secondResult;
  try {
    second.snapshot(ctx);
    secondResult = second.schemaV4;
  } finally {
    await second.dispose();
  }
  const backupsAfterReopen = listBackups(fixture.dir);
  const stateAfterReopen = inspectDatabase(fixture.path);
  const migrationsAfterReopen = stateAfterReopen.migrations;
  const stableCountKeys = ['memory_records', 'memory_versions', 'memory_conflicts', 'memory_conflict_sides', 'memory_reviews', 'memory_suppression'];
  const countsStable = stableCountKeys.every(key => stateBeforeReopen.counts[key] === stateAfterReopen.counts[key]);
  const idempotent = secondResult?.migrated === false
    && JSON.stringify(backupsAfterReopen) === JSON.stringify(backupsBeforeReopen)
    && JSON.stringify(migrationsAfterReopen) === JSON.stringify(migrationsBeforeReopen)
    && countsStable;
  if (idempotent) pass(checks, 'reopen.idempotent', 'second open is a no-op', JSON.stringify({migrated: secondResult?.migrated, migrations: migrationsAfterReopen.length, countsStable}));
  else fail(checks, 'reopen.idempotent', 'second open is a no-op', JSON.stringify({secondResult, backupsBeforeReopen, backupsAfterReopen, countsStable}));

  v5Checks(checks, fixture.path, inspectDatabase(fixture.path));

  return {
    name: fixture.schema,
    dir: fixture.dir,
    checks,
    counts: {before: pre.counts, after: post.counts},
    backups: created.map(name => join(fixture.dir, MEMORY_MIGRATION_BACKUP_DIR, name)),
    migration: migration ?? null,
  };
}

/** Run both fixtures and return the evidence report. */
export async function runMigrationDrill(options = {}) {
  const baseDir = resolve(options.baseDir ?? join(tmpdir(), `friend-pi-memory-drill-${Date.now()}`));
  mkdirSync(baseDir, {recursive: true, mode: 0o700});
  const fixtures = [];
  try {
    for (const schema of ['v3', 'v4']) {
      const dir = join(baseDir, schema);
      rmSync(dir, {recursive: true, force: true});
      const fixture = createLegacyFixture({dir, schema});
      fixtures.push(await drillFixture(fixture));
    }
    const checks = fixtures.flatMap(fixture => fixture.checks);
    const summary = {
      pass: checks.filter(entry => entry.status === 'PASS').length,
      fail: checks.filter(entry => entry.status === 'FAIL').length,
      pending: checks.filter(entry => entry.status === 'PENDING_SCHEMA_V5').length,
    };
    summary.status = summary.fail === 0 ? 'PASS' : 'FAIL';
    const report = {
      v: 1,
      kind: 'memory-migration-drill',
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        writerVersion: MEMORY_WRITER_VERSION,
        oldWriterVersion: OLD_WRITER_VERSION,
      },
      fixtures,
      summary,
      boundary: [
        'Real MemoryController + real SQLite fixtures; the fake PluginContext only supplies deterministic source text and an empty provider.',
        'v5-only assertions are PENDING_SCHEMA_V5 when MEMORY_SCHEMA_VERSION < 5; pending checks do not fail the drill.',
        'Fixtures are synthetic but modelled on the shipped v3/v4 tables: records in all statuses, legacy method, jobs+proposalLedger, usage/suppression/operation/migration rows.',
      ],
    };
    if (options.write === true) {
      const outFile = resolve(options.outFile ?? DEFAULT_OUT);
      mkdirSync(dirname(outFile), {recursive: true});
      writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    if (options.cleanup === true) rmSync(baseDir, {recursive: true, force: true});
  }
}

function parseArgs(argv) {
  let outFile = DEFAULT_OUT;
  let write = true;
  let baseDir;
  let cleanup = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--out') outFile = argv[++index] ?? outFile;
    else if (argument === '--no-write') write = false;
    else if (argument === '--base-dir') baseDir = argv[++index];
    else if (argument === '--cleanup') cleanup = true;
    else if (argument === '--help' || argument === '-h') {
      console.error('usage: node --import tsx benchmarks/memory/migration-drill.mjs [--out <file>] [--no-write] [--base-dir <dir>] [--cleanup]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!baseDir && write) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    baseDir = join('.artifacts/qa/memory-migration-drill', stamp);
  }
  return {outFile, write, baseDir, cleanup: cleanup || (!write && !baseDir)};
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runMigrationDrill(args);
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.fail > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
