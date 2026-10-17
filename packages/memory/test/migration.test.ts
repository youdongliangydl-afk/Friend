import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryController, memorySemanticDigest, type LearningJob, type MemoryRecord } from '../src/index.js';
import {
  ensureMemorySchema, MEMORY_RECORD_COLUMNS, MEMORY_SCHEMA_TABLES, MEMORY_SCHEMA_VERSION, MEMORY_V4_MIGRATION_CHECKSUM_INPUT,
  type MemoryMigrationHooks, type MemoryV4Result,
} from '../src/schema.js';
import {
  normalizeSubjectKey as foldSubjectKey, normalizeSubjectValue, subjectClaimHash,
} from '../src/subjects.js';
import { digest, type HistoryItem, type PluginContext } from '../../core/src/index.js';

/** P0 rule: only ASCII legacy subjects become subject keys; CJK free-form subjects stay NULL. */
function migrationSubjectKey(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
  if (!value || /[^\x00-\x7F]/u.test(value)) return undefined;
  return foldSubjectKey(value);
}

function hooks(dataDir: string): MemoryMigrationHooks {
  return {
    dataDir,
    now: () => new Date().toISOString(),
    digest,
    semanticDigest: record => memorySemanticDigest(record as MemoryRecord),
    normalizeSubjectKey: migrationSubjectKey,
    normalizeSubjectValue,
    recordClaim: record => subjectClaimHash({content:record.content, conditions:record.conditions}),
  };
}

const NOW = '2026-10-17T12:00:00.000Z';

function v3Record(over: Partial<MemoryRecord> & {id:string;content:string}): MemoryRecord {
  const record = {
    revision:1, projectId:'p', scope:'project', schemaVersion:2, kind:'fact', title:over.id,
    status:'candidate', enabled:true, sources:[], parentIds:[], aliases:[], conditions:[], evidence:[], dependencies:[],
    createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'2026-01-02T00:00:00.000Z', ...over,
  } as MemoryRecord;
  record.hash = digest(record.content);
  record.fingerprint = record.fingerprint ?? digest(record.content);
  record.semanticDigest = memorySemanticDigest(record);
  if (record.kind === 'method') record.legacy = true;
  return record;
}

function baseSchema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS documents(namespace TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,key));
CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS memory_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,state TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_suppression(project_id TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,kind,hash));
CREATE TABLE IF NOT EXISTS memory_usage(receipt_id TEXT PRIMARY KEY,run_id TEXT,stage TEXT,json TEXT);
CREATE TABLE IF NOT EXISTS memory_migrations(version INTEGER PRIMARY KEY,checksum TEXT,applied_at TEXT);
`);
}

type V3Input = {
  records?: MemoryRecord[];
  jobs?: LearningJob[];
  suppressions?: {projectId:string;kind:string;hash:string;reason:string;createdAt?:string}[];
  usage?: {receiptId:string;runId?:string;stage?:string;json:unknown}[];
  migrations?: boolean;
};

/** Hand-built v3 database: the schema/migration rows a shipped 2a1b8d0 install would have. */
function createV3(dir: string, input: V3Input = {}): string {
  mkdirSync(dir, {recursive:true, mode:0o700});
  const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    baseSchema(db);
    for (const record of input.records ?? []) {
      db.prepare('INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES(?,?,?,?,?,?,?)')
        .run(record.id, record.projectId, record.scope, record.status, Number(record.enabled), record.revision, JSON.stringify(record));
    }
    for (const job of input.jobs ?? []) {
      db.prepare('INSERT INTO memory_jobs(id,project_id,fingerprint,state,json) VALUES(?,?,?,?,?)')
        .run(job.id, job.projectId, job.fingerprint, job.state, JSON.stringify(job));
    }
    for (const suppression of input.suppressions ?? []) {
      db.prepare('INSERT INTO memory_suppression(project_id,kind,hash,reason,created_at) VALUES(?,?,?,?,?)')
        .run(suppression.projectId, suppression.kind, suppression.hash, suppression.reason, suppression.createdAt ?? NOW);
    }
    for (const usage of input.usage ?? []) {
      db.prepare('INSERT INTO memory_usage(receipt_id,run_id,stage,json) VALUES(?,?,?,?)')
        .run(usage.receiptId, usage.runId ?? 'run', usage.stage ?? 'retrieved', JSON.stringify(usage.json));
    }
    if (input.migrations !== false) {
      db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(2,?,?)').run(digest('memory-v2'), NOW);
      db.prepare('INSERT INTO memory_migrations(version,checksum,applied_at) VALUES(3,?,?)').run(digest('memory-durable-proposals-v1'), NOW);
    }
  } finally { db.close(); }
  return dir;
}

function controllerFixture(dir: string) {
  const entries: HistoryItem[] = [{id:'user1',parentId:null,type:'message',timestamp:NOW,role:'user',text:'迁移测试来源正文。'}];
  const events: {event:string;data:unknown}[] = [];
  const ctx: PluginContext = {
    dataDir:dir, projectDir:dir, projectId:'p', sessionId:'s', origin:'user', isIdle:() => true,
    history:() => entries,
    readSource(source) { const item = entries.find(entry => entry.id === source.entryId); if (!item) throw new Error('来源不存在'); return item; },
    complete:async () => '{"memories":[]}',
    request:async () => { throw new Error('not installed'); },
    emit:(event,data) => events.push({event,data}), notify:() => {}, appendEntry:() => {},
  };
  return {ctx, entries, events, cleanup:() => rmSync(dir, {recursive:true, force:true})};
}

function tempDir(prefix: string): string { return mkdtempSync(join(tmpdir(), `friend-pi-${prefix}-`)); }

function v4(db: DatabaseSync): unknown { return db.prepare('SELECT 1 FROM memory_migrations WHERE version=4').get(); }
function columns(db: DatabaseSync, table = 'memory_records'): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row => row.name);
}
function indexSql(db: DatabaseSync, name: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as {sql?:string} | undefined;
  return String(row?.sql ?? '');
}
function backupFiles(dir: string): string[] {
  const root = join(dir, 'memory-migration-backups');
  return readdirSync(root).filter(name => name.endsWith('.sqlite')).sort();
}
function openController(dir: string) {
  const fixture = controllerFixture(dir);
  const controller = new MemoryController();
  const open = () => controller.snapshot(fixture.ctx);
  return {controller, ctx:fixture.ctx, events:fixture.events, open, cleanup:async () => { await controller.dispose(); fixture.cleanup(); }};
}

// ---------------------------------------------------------------- §2.5 case 1
test('v4 fresh install creates every table, column, index, migration row and a fresh install profile', () => {
  const dir = tempDir('migration-fresh');
  const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    baseSchema(db);
    const result = ensureMemorySchema(db, hooks(dir));
    assert.equal(result.version, MEMORY_SCHEMA_VERSION);
    assert.equal(result.migrated, true);
    assert.equal(result.installProfile, 'fresh');
    assert.ok(result.backupPath && result.backupPath.startsWith(join(dir, 'memory-migration-backups', 'before-v4-')));
    assert.ok(v4(db));
    const checksum = (db.prepare('SELECT checksum FROM memory_migrations WHERE version=4').get() as {checksum:string}).checksum;
    assert.equal(checksum, digest(MEMORY_V4_MIGRATION_CHECKSUM_INPUT));

    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(row => row.name));
    for (const table of ['memory_subjects','memory_conflicts','memory_conflict_sides','memory_policies','memory_autopublish_audit','memory_reviews']) assert.ok(tables.has(table), table);
    const present = new Set(columns(db));
    for (const column of MEMORY_RECORD_COLUMNS) assert.ok(present.has(column.name), column.name);
    for (const name of ['memory_records_subject_active','memory_records_single_subject','memory_records_kind_status','memory_records_last_used']) assert.notEqual(indexSql(db, name), '', name);
    assert.match(indexSql(db, 'memory_records_single_subject'), /UNIQUE/iu);
    assert.match(indexSql(db, 'memory_records_single_subject'), /status='active'/u);
    assert.match(indexSql(db, 'memory_records_single_subject'), /auto_published=1/u);

    const profile = db.prepare("SELECT json FROM documents WHERE namespace='memory' AND key='install-profile'").get() as {json:string};
    assert.deepEqual(Object.keys(JSON.parse(profile.json)).sort(), ['at','profile','v']);
    assert.equal(JSON.parse(profile.json).profile, 'fresh');

    // Idempotent second call on the same connection: tables ensured, nothing migrated again.
    const backupsBefore = backupFiles(dir).length;
    const second = ensureMemorySchema(db, hooks(dir));
    assert.equal(second.migrated, false);
    assert.equal(second.installProfile, 'fresh');
    assert.equal(backupFiles(dir).length, backupsBefore);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_migrations WHERE version=4').get() as {count:number}).count), 1);
  } finally { db.close(); rmSync(dir, {recursive:true, force:true}); }
});

// ---------------------------------------------------------------- §2.5 case 2
test('opening a v3 database runs a backup-first transactional v4 migration and backfills the new columns', async () => {
  const userFact = v3Record({id:'user-fact', content:'数据库使用 SQLite。', status:'active', confirmedBy:'user', subject:'orders.database.engine',
    evidence:[{kind:'pi', evidenceId:'e1', relation:'supports', observedAt:NOW, sourceRole:'user', source:{sessionId:'s', entryId:'user1'}, visibility:'native-text'}],
    conditions:['仅测试环境适用'], parentIds:[]});
  const dir = tempDir('migration-upgrade');
  createV3(dir, {records:[
    userFact,
    v3Record({id:'tool-pref', content:'偏好中文解释。', kind:'preference', confirmedBy:'system',
      evidence:[{kind:'pi', evidenceId:'e2', relation:'supports', observedAt:NOW, sourceRole:'toolResult', source:{sessionId:'s', entryId:'user1'}, visibility:'tool-visible-range'}]}),
    v3Record({id:'model-exp', content:'经验：先读后写。', kind:'experience',
      evidence:[{kind:'pi', evidenceId:'e3', relation:'supports', observedAt:NOW, sourceRole:'assistant', source:{sessionId:'s', entryId:'user1'}, visibility:'native-text'}]}),
    v3Record({id:'legacy-method', content:'旧方法正文。', kind:'method', status:'inactive', enabled:false, subject:'legacy-method'}),
    v3Record({id:'derived', content:'派生事实。', status:'invalidated', enabled:false, parentIds:['root-id']}),
    v3Record({id:'ungrounded', content:'无证据事实。'}),
    v3Record({id:'system-no-evidence', content:'系统无证据事实。', confirmedBy:'system'}),
  ], usage:[{receiptId:'receipt-1', json:{v:1, projectId:'p', at:NOW}}]});
  const {controller, ctx, cleanup} = openController(dir);
  try {
    const snapshot = controller.snapshot(ctx);
    assert.ok(snapshot);
    const result = (controller as unknown as {schemaV4?:MemoryV4Result}).schemaV4;
    assert.ok(result);
    assert.equal(result.migrated, true);
    assert.equal(result.installProfile, 'upgraded');

    const backups = backupFiles(dir);
    assert.equal(backups.length, 1, 'only before-v4 backup: v2/v3 rows were already recorded');
    assert.match(backups[0], /^before-v4-/u);
    const backup = new DatabaseSync(join(dir, 'memory-migration-backups', backups[0]));
    try {
      assert.equal(Number((backup.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as {count:number}).count), 7);
      assert.deepEqual(columns(backup), ['id','project_id','scope','status','enabled','revision','json']);
    } finally { backup.close(); }

    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      assert.ok(v4(db));
      const profile = JSON.parse((db.prepare("SELECT json FROM documents WHERE namespace='memory' AND key='install-profile'").get() as {json:string}).json);
      assert.equal(profile.profile, 'upgraded');
      const rows = new Map((db.prepare('SELECT id,kind_v2,subject_key,subject_cardinality,trust,authority,lineage_root,semantic_digest FROM memory_records').all() as Record<string, unknown>[]).map(row => [String(row.id), row]));

      assert.equal(rows.get('user-fact')!.kind_v2, 'fact');
      assert.equal(rows.get('user-fact')!.subject_key, 'orders.database.engine');
      assert.equal(rows.get('user-fact')!.subject_cardinality, 'single');
      assert.equal(rows.get('user-fact')!.trust, 'user_explicit');
      assert.equal(rows.get('user-fact')!.authority, 'user');
      assert.equal(rows.get('user-fact')!.lineage_root, 'user-fact');
      assert.equal(rows.get('user-fact')!.semantic_digest, memorySemanticDigest(userFact));
      assert.equal(rows.get('tool-pref')!.trust, 'tool_verified');
      assert.equal(rows.get('tool-pref')!.authority, 'tool');
      assert.equal(rows.get('model-exp')!.trust, 'model_supported');
      assert.equal(rows.get('model-exp')!.authority, 'model');
      assert.equal(rows.get('legacy-method')!.kind_v2, null);
      assert.equal(rows.get('legacy-method')!.trust, null);
      assert.equal(rows.get('legacy-method')!.authority, null);
      assert.equal(rows.get('derived')!.lineage_root, 'root-id');
      assert.equal(rows.get('ungrounded')!.trust, 'model_inferred');
      assert.equal(rows.get('system-no-evidence')!.trust, 'model_supported');
    } finally { db.close(); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 3
test('reopening a migrated database is a no-op: no migration row, no new backup, no conflict duplicate', async () => {
  const dir = createV3(tempDir('migration-idempotent'), {records:[v3Record({id:'a', content:'事实A', status:'active'})]});
  const first = openController(dir);
  try { first.open(); } finally { await first.controller.dispose(); }
  const backupsAfterFirst = backupFiles(dir);
  assert.equal(backupsAfterFirst.length, 1);

  const second = openController(dir);
  try {
    second.open();
    const result = (second.controller as unknown as {schemaV4?:MemoryV4Result}).schemaV4;
    assert.ok(result);
    assert.equal(result.migrated, false);
    assert.equal(result.installProfile, 'upgraded');
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(backupFiles(dir), backupsAfterFirst);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_migrations WHERE version=4').get() as {count:number}).count), 1);
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_conflicts').get() as {count:number}).count), 0);
    } finally { db.close(); }
  } finally { await second.cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 4
test('legacy method stays read-only, is not recalled and gets neither kind_v2 nor trust', async () => {
  const dir = createV3(tempDir('migration-method'), {records:[
    v3Record({id:'legacy-method', content:'旧方法检索关键词', kind:'method', status:'active', subject:'writing.method'}),
    v3Record({id:'fact', content:'普通事实。', status:'active', confirmedBy:'user'}),
  ]});
  const {controller, ctx, cleanup} = openController(dir);
  try {
    const method = await controller.dispatch('read', {id:'legacy-method'}, ctx) as MemoryRecord;
    assert.equal(method.kind, 'method');
    assert.equal(method.legacy, true);
    assert.deepEqual(controller.search({query:'旧方法检索关键词'}, ctx), []);
    await assert.rejects(controller.dispatch('update', {id:'legacy-method', revision:method.revision, content:'修改'}, ctx), {code:'VALIDATION_ERROR'});
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      const row = db.prepare("SELECT kind_v2,trust,authority FROM memory_records WHERE id='legacy-method'").get() as Record<string, unknown>;
      assert.equal(row.kind_v2, null);
      assert.equal(row.trust, null);
      assert.equal(row.authority, null);
    } finally { db.close(); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 5
test('several active rows for one single subject are deduped before the unique index, isolated as candidates and survive restart', async () => {
  const dir = createV3(tempDir('migration-dupe'), {records:[
    v3Record({id:'keeper-user', content:'数据库使用 SQLite。', status:'active', confirmedBy:'user', subject:'orders.database.engine', updatedAt:'2026-01-01T00:00:00.000Z'}),
    v3Record({id:'newest-system', content:'数据库使用 PostgreSQL。', status:'active', confirmedBy:'system', subject:' Orders.Database.Engine ', updatedAt:'2026-07-01T00:00:00.000Z'}),
    v3Record({id:'older-system', content:'数据库使用 MySQL。', status:'active', confirmedBy:'system', subject:'orders.database.engine', updatedAt:'2026-06-01T00:00:00.000Z'}),
    v3Record({id:'other-subject', content:'服务使用 HTTP/2。', status:'active', subject:'service.protocol'}),
  ]});
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
    try {
      assert.match(indexSql(db, 'memory_records_single_subject'), /WHERE status='active' AND subject_cardinality='single' AND subject_key IS NOT NULL AND auto_published=1/u);
      const statuses = new Map((db.prepare('SELECT id,status,conflict_state,json FROM memory_records').all() as Record<string, unknown>[]).map(row => [String(row.id), row]));
      assert.equal(statuses.get('keeper-user')!.status, 'active');
      for (const id of ['newest-system','older-system']) {
        assert.equal(statuses.get(id)!.status, 'candidate', id);
        assert.equal(statuses.get(id)!.conflict_state, 'open', id);
        const json = JSON.parse(String(statuses.get(id)!.json));
        assert.equal(json.status, 'candidate');
        assert.match(String(json.invalidatedReason), /同 subject 多 active/u);
      }
      assert.equal(statuses.get('other-subject')!.status, 'active');
      const conflicts = db.prepare('SELECT id,status,opened_by,subject_key,json FROM memory_conflicts').all() as Record<string, unknown>[];
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].status, 'open');
      assert.equal(conflicts[0].opened_by, 'migration');
      assert.equal(conflicts[0].subject_key, 'orders.database.engine');
      assert.equal(conflicts[0].id, digest(['legacy-subject','p','project','orders.database.engine']));
      const sides = db.prepare('SELECT side,memory_id,claim_hash,revision FROM memory_conflict_sides ORDER BY side').all() as Record<string, unknown>[];
      assert.deepEqual(sides.map(row => row.side), ['left','right']);
      assert.equal(sides[0].memory_id, 'keeper-user');
      assert.equal(sides[1].memory_id, 'newest-system');
      const json = JSON.parse(String(conflicts[0].json));
      assert.equal(json.openedBy, 'migration');
      assert.equal(json.sides.length, 2);
    } finally { db.close(); }

    // Restart: the dedupe result is durable and the unique index still holds.
    await controller.dispose();
    const restarted = new MemoryController();
    try {
      restarted.snapshot(ctx);
      const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
      try {
        assert.equal(Number((db.prepare("SELECT COUNT(*) AS count FROM memory_records WHERE subject_key='orders.database.engine' AND status='active'").get() as {count:number}).count), 1);
        assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM memory_conflicts').get() as {count:number}).count), 1, 'restart must not duplicate the migration conflict');
      } finally { db.close(); }
      const raw = new DatabaseSync(join(dir, 'plugins.sqlite'));
      try {
        raw.function('friend_pi_writer_version', {deterministic:true}, () => 5);
        const insert = raw.prepare("INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json,subject_key,subject_cardinality,auto_published) VALUES(?,?,?,?,?,?,?,?,?,?)");
        // Explicit user writes are user-authoritative and may coexist for one subject.
        assert.doesNotThrow(() => insert.run('explicit-dup', 'p', 'project', 'active', 1, 1, '{}', 'orders.database.engine', 'single', 0));
        // Automatic publication still enforces one active record per single-cardinality subject.
        assert.doesNotThrow(() => insert.run('auto-1', 'p', 'project', 'active', 1, 1, '{}', 'orders.database.engine', 'single', 1));
        assert.throws(() => insert.run('auto-2', 'p', 'project', 'active', 1, 1, '{}', 'orders.database.engine', 'single', 1), /UNIQUE constraint failed/u);
      } finally { raw.close(); }
    } finally { await restarted.dispose(); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 9 (+ Lead registry requirement)
test('legacy free-form subjects become keys only for ASCII, registry rows are created and Chinese subjects stay NULL', async () => {
  const dir = createV3(tempDir('migration-subjects'), {records:[
    v3Record({id:'chinese', content:'中文主题事实。', status:'active', subject:'CedarArchive 服务端口', createdAt:'2026-01-01T00:00:00.000Z'}),
    v3Record({id:'older-label', content:'订单库事实。', status:'active', subject:' Orders.Database.Engine ', createdAt:'2026-01-01T00:00:00.000Z'}),
    v3Record({id:'newer-label', content:'订单库另一事实。', status:'active', subject:'orders.database.engine', createdAt:'2026-06-01T00:00:00.000Z'}),
    v3Record({id:'colon-subject', content:'规则事实。', status:'active', subject:'project-rule:abc-1'}),
    v3Record({id:'empty-subject', content:'空主题事实。', status:'active', subject:'   '}),
    v3Record({id:'number-subject', content:'数字主题事实。', status:'active', subject:123 as unknown as string}),
    v3Record({id:'no-subject', content:'无主题事实。', status:'active'}),
  ]});
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      const keys = new Map((db.prepare('SELECT id,subject_key,subject_cardinality FROM memory_records').all() as Record<string, unknown>[]).map(row => [String(row.id), row]));
      assert.equal(keys.get('chinese')!.subject_key, null);
      assert.equal(keys.get('empty-subject')!.subject_key, null);
      assert.equal(keys.get('number-subject')!.subject_key, null);
      assert.equal(keys.get('no-subject')!.subject_key, null);
      assert.equal(keys.get('older-label')!.subject_key, 'orders.database.engine');
      assert.equal(keys.get('newer-label')!.subject_key, 'orders.database.engine');
      assert.equal(keys.get('older-label')!.subject_cardinality, 'single');
      assert.equal(keys.get('colon-subject')!.subject_key, migrationSubjectKey('project-rule:abc-1'));
      assert.ok(keys.get('colon-subject')!.subject_key);

      const subjects = db.prepare('SELECT project_id,scope,key,label,aliases_json,cardinality,value_type,sensitivity FROM memory_subjects ORDER BY key').all() as Record<string, unknown>[];
      const keysRegistered = subjects.map(row => String(row.key));
      assert.deepEqual(keysRegistered, ['orders.database.engine','project.rule.abc.1']);
      assert.ok(!keysRegistered.includes('cedararchive'), 'Chinese subject must not create a collided ASCII key');
      assert.ok(!keysRegistered.includes('cedararchive.'));
      const orderSubject = subjects.find(row => row.key === 'orders.database.engine')!;
      assert.equal(orderSubject.label, 'Orders.Database.Engine');
      assert.equal(orderSubject.aliases_json, '[]');
      assert.equal(orderSubject.cardinality, 'single');
      assert.equal(orderSubject.value_type, 'freeform');
      assert.equal(orderSubject.sensitivity, 'normal');
      assert.equal(orderSubject.project_id, 'p');
      assert.equal(orderSubject.scope, 'project');
    } finally { db.close(); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 6
test('forgotten bodies, suppression rows and usage receipts are preserved and never revived by the migration', async () => {
  const forgotten = '遗忘正文不得复活 UNIQUE_FORGET_42';
  const suppressionHash = digest(forgotten.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim());
  const usageJson = {v:1, operationId:'op-1', records:[{id:'kept-fact', content:'保留事实'}], at:NOW};
  const dir = createV3(tempDir('migration-forget'), {
    records:[v3Record({id:'kept-fact', content:'保留事实', status:'active', confirmedBy:'user'})],
    suppressions:[{projectId:'p', kind:'content', hash:suppressionHash, reason:'forget'}],
    usage:[{receiptId:'receipt-1', runId:'run-1', stage:'retrieved', json:usageJson}],
  });
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      assert.deepEqual(db.prepare('SELECT kind,hash,reason FROM memory_suppression').all().map(row => ({...row})), [{kind:'content', hash:suppressionHash, reason:'forget'}]);
      assert.equal(JSON.parse(String((db.prepare("SELECT json FROM memory_usage WHERE receipt_id='receipt-1'").get() as {json:string}).json)).operationId, 'op-1');
      assert.ok(!String((db.prepare('SELECT group_concat(json) AS body FROM memory_records').get() as {body:string}).body).includes(forgotten));
    } finally { db.close(); }
    assert.deepEqual(controller.search({query:'遗忘正文'}, ctx), []);
    assert.equal(controller.search({query:'保留事实'}, ctx)[0]?.id, 'kept-fact');
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 8
test('learning job checkpoints (proposalLedger/modelOperations/pendingRanges) stay byte-equivalent across the migration', async () => {
  const job: LearningJob = {
    id:'job-1', projectId:'p', sessionId:'s', sources:[{sessionId:'s', entryId:'user1'}], fingerprint:digest('job'),
    state:'queued', stage:'publish', attempts:1, memoryIds:['kept-fact'],
    createdAt:NOW, updatedAt:NOW, operationId:'operation-1',
    proposalLedger:[{id:'proposal-1', operationId:'operation-1', ordinal:0, contentHash:digest('proposal'), original:{title:'提案', content:'提案正文'}, state:'validated', groupId:'group-1', memoryId:'kept-fact'}],
    modelOperations:[{operationId:'call-1', stage:'extract', callId:'call-id-1'}],
    pendingRanges:[{sessionId:'s', entryId:'user1', start:0, end:2, hash:digest('迁移')}],
  };
  const dir = createV3(tempDir('migration-job'), {records:[v3Record({id:'kept-fact', content:'保留事实', status:'active'})], jobs:[job]});
  const raw = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
  const before = String((raw.prepare('SELECT json FROM memory_jobs WHERE id=?').get('job-1') as {json:string}).json);
  raw.close();
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const after = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      assert.equal(String((after.prepare('SELECT json FROM memory_jobs WHERE id=?').get('job-1') as {json:string}).json), before);
      assert.equal((after.prepare("SELECT state FROM memory_jobs WHERE id='job-1'").get() as {state:string}).state, 'queued');
    } finally { after.close(); }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 10
test('a corrupt record aborts the migration without a v4 row or partial columns, and a repair migrates cleanly', async () => {
  const dir = createV3(tempDir('migration-corrupt'), {records:[v3Record({id:'ok', content:'正常事实', status:'active'})]});
  const raw = new DatabaseSync(join(dir, 'plugins.sqlite'));
  raw.prepare("INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES('broken','p','project','candidate',1,1,'{not json')").run();
  raw.close();

  const first = openController(dir);
  assert.throws(() => first.open(), /JSON/u);
  await first.controller.dispose();
  const inspect = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    assert.equal(v4(inspect), undefined, 'failed migration must not record version 4');
    assert.ok(!columns(inspect).includes('kind_v2'), 'failed migration must roll back the ALTER TABLE');
    assert.equal(inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='memory_records_single_subject'").get(), undefined);
  } finally { inspect.close(); }

  const repair = new DatabaseSync(join(dir, 'plugins.sqlite'));
  repair.prepare("UPDATE memory_records SET json=? WHERE id='broken'").run(JSON.stringify(v3Record({id:'broken', content:'修复事实'})));
  repair.close();
  const second = openController(dir);
  try {
    second.open();
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      assert.ok(v4(db));
      assert.ok(columns(db).includes('kind_v2'));
    } finally { db.close(); }
  } finally { await second.cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 11
test('the migration backup directory is 0700, the backup opens, and the migrated database restarts read/write', async () => {
  const dir = createV3(tempDir('migration-restart'), {records:[v3Record({id:'fact', content:'迁移前事实', status:'active', confirmedBy:'user'})]});
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const mode = statSync(join(dir, 'memory-migration-backups')).mode & 0o777;
    assert.equal(mode & 0o077, 0, 'backup directory must not be group/other accessible');
    assert.equal(mode & 0o700, 0o700);
    const backups = backupFiles(dir);
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(dir, 'memory-migration-backups', backups[0]), {readOnly:true});
    try {
      assert.equal(Number((backup.prepare('SELECT COUNT(*) AS count FROM memory_records').get() as {count:number}).count), 1);
    } finally { backup.close(); }
  } finally { await controller.dispose(); }

  const restarted = openController(dir);
  try {
    restarted.open();
    const saved = await restarted.controller.dispatch('save', {content:'迁移后新写入事实', explicitRemember:true}, restarted.ctx) as MemoryRecord;
    assert.equal(saved.status, 'active');
    assert.equal(restarted.controller.search({query:'迁移后新写入'}, restarted.ctx)[0]?.id, saved.id);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      const row = db.prepare("SELECT kind_v2,semantic_digest FROM memory_records WHERE id=?").get(saved.id) as Record<string, unknown>;
      assert.equal(row.kind_v2, 'fact');
      assert.equal(row.semantic_digest, saved.semanticDigest);
    } finally { db.close(); }
  } finally { await restarted.cleanup(); }
});

// ---------------------------------------------------------------- §2.5 case 7
test('after migration an old writer can read but its writes fail, while a version-5 writer still writes', async () => {
  const dir = createV3(tempDir('migration-fence'), {records:[v3Record({id:'fact', content:'围栏事实', status:'active'})]});
  const {controller, ctx, cleanup} = openController(dir);
  try { controller.snapshot(ctx); } finally { await controller.dispose(); }
  const old = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    old.function('friend_pi_writer_version', {deterministic:true}, () => 4);
    assert.ok(old.prepare('SELECT json FROM memory_records WHERE id=?').get('fact'), 'reads stay available');
    assert.throws(() => old.prepare('UPDATE memory_records SET json=json WHERE id=?').run('fact'), /requires a newer writer/u);
    assert.throws(() => old.prepare("INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES('old-writer','p','project','candidate',1,1,'{}')").run(), /requires a newer writer/u);
    assert.throws(() => old.prepare("INSERT INTO documents(namespace,key,revision,json) VALUES('memory','old-writer',1,'{}')").run(), /requires a newer writer/u);
  } finally { old.close(); }
  const next = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    next.function('friend_pi_writer_version', {deterministic:true}, () => 5);
    assert.doesNotThrow(() => next.prepare('UPDATE memory_records SET json=json WHERE id=?').run('fact'));
    assert.doesNotThrow(() => next.prepare("INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json) VALUES('new-writer','p','project','candidate',1,1,'{}')").run());
  } finally { next.close(); }
  rmSync(dir, {recursive:true, force:true});
});

// ---------------------------------------------------------------- §2.5 case 12
test('the migration does not rewrite user-visible record json unless it isolates a duplicate subject', async () => {
  const records = [
    v3Record({id:'active', content:'活动事实。', status:'active', confirmedBy:'user', conditions:['仅测试环境适用'], sources:[{sessionId:'s', entryId:'user1'}], aliases:['别名']}),
    v3Record({id:'candidate', content:'候选事实。', conditions:['条件'], sources:[{sessionId:'s', entryId:'user1', start:0, end:2, hash:digest('迁移')}]}),
    v3Record({id:'inactive', content:'停用事实。', status:'inactive', enabled:false}),
    v3Record({id:'invalidated', content:'作废事实。', status:'invalidated', enabled:false, invalidatedReason:'corrected'}),
    v3Record({id:'multi-a', content:'多值主题 A。', status:'active', subject:'multi.subject'}),
    v3Record({id:'multi-b', content:'多值主题 B。', status:'active', subject:'other.subject'}),
  ];
  const dir = createV3(tempDir('migration-json'), {records});
  const expected = new Map((new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true}).prepare('SELECT id,json FROM memory_records').all() as {id:string;json:string}[]).map(row => [row.id, row.json]));
  const {controller, ctx, cleanup} = openController(dir);
  try {
    controller.snapshot(ctx);
    const db = new DatabaseSync(join(dir, 'plugins.sqlite'), {readOnly:true});
    try {
      for (const [id, json] of expected) assert.equal(String((db.prepare('SELECT json FROM memory_records WHERE id=?').get(id) as {json:string}).json), json, id);
    } finally { db.close(); }
    for (const record of records) {
      const read = await controller.dispatch('read', {id:record.id}, ctx) as MemoryRecord;
      assert.equal(read.content, record.content);
      assert.deepEqual(read.conditions, record.conditions ?? []);
      assert.deepEqual(read.sources, record.sources);
      assert.equal(read.status, record.status);
      assert.equal(read.updatedAt, record.updatedAt);
    }
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------- coverage guard
test('MEMORY_SCHEMA_TABLES covers every v4 table plus the legacy memory tables guarded by the writer fence', () => {
  const expected = ['memory_records','memory_versions','memory_jobs','memory_suppression','memory_usage','memory_evidence','memory_dependencies','memory_operations','memory_projection_outbox','memory_migrations','memory_events','memory_queries','memory_subjects','memory_conflicts','memory_conflict_sides','memory_policies','memory_autopublish_audit','memory_reviews'];
  assert.deepEqual([...MEMORY_SCHEMA_TABLES].sort(), [...expected].sort());
  assert.equal(MEMORY_SCHEMA_VERSION, 4);
  assert.equal(MEMORY_RECORD_COLUMNS.length, 17);
  assert.equal(new Set(MEMORY_RECORD_COLUMNS.map(column => column.name)).size, 17);
});
