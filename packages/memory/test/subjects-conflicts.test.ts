import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_SUBJECT_CARDINALITY, activeSubjectPeers, getSubject, isValidSubjectKey, listSubjects,
  normalizeSubjectKey, normalizeSubjectValue, registerSubject, subjectClaimHash,
  type SubjectDefinition, type SubjectPeer,
} from '../src/subjects.js';
import {
  ConflictStore, detectSubjectConflict,
  type ConflictRecord, type ConflictSideInput, type ConflictTransitionInput,
} from '../src/conflicts.js';
import { MemoryController, peekLearningJob, type MemoryRecord } from '../src/index.js';
import type { HistoryItem, PluginContext } from '../../core/src/index.js';

/**
 * The P0-C modules only own subjects/conflicts tables plus read-only access to
 * memory_records. Tests create the v4 DDL subset they need in an isolated tmp
 * database so they stay independent from the migration/index.ts wiring.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS memory_records(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,
  enabled INTEGER NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,
  subject_key TEXT,subject_cardinality TEXT,trust TEXT);
CREATE INDEX IF NOT EXISTS memory_records_subject_active ON memory_records(project_id,scope,subject_key);
CREATE UNIQUE INDEX IF NOT EXISTS memory_records_single_subject ON memory_records(project_id,scope,subject_key)
  WHERE status='active' AND subject_cardinality='single' AND subject_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS memory_subjects(
  project_id TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,label TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',cardinality TEXT NOT NULL DEFAULT 'single',
  value_type TEXT NOT NULL DEFAULT 'freeform',sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,scope,key));
CREATE TABLE IF NOT EXISTS memory_conflicts(
  id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope TEXT NOT NULL,subject_key TEXT NOT NULL,
  status TEXT NOT NULL,resolution TEXT,opened_at TEXT NOT NULL,opened_by TEXT NOT NULL,
  resolved_at TEXT,resolved_by TEXT,policy_version INTEGER,notes TEXT,json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS memory_conflicts_open ON memory_conflicts(project_id,status,subject_key);
CREATE TABLE IF NOT EXISTS memory_conflict_sides(
  conflict_id TEXT NOT NULL,side TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,
  claim_hash TEXT NOT NULL,support_score INTEGER NOT NULL,evidence_json TEXT NOT NULL,
  PRIMARY KEY(conflict_id,side));
`;

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-subjects-conflicts-'));
  const path = join(dir, 'plugins.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(DDL);
  return {
    dir, path, db,
    open(): DatabaseSync {
      const next = new DatabaseSync(path);
      next.exec('PRAGMA busy_timeout=5000');
      return next;
    },
    cleanup() {
      try { db.close(); } catch { /* already closed in persistence test */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertRecord(db: DatabaseSync, input: {
  id?: string; projectId?: string; scope?: 'project' | 'personal'; status?: string; enabled?: boolean;
  revision?: number; subjectKey?: string | null; cardinality?: 'single' | 'multi' | null;
  trust?: string | null; content?: string; conditions?: string[]; updatedAt?: string;
}) {
  const id = input.id ?? randomUUID();
  const projectId = input.projectId ?? 'project-a';
  const scope = input.scope ?? 'project';
  const status = input.status ?? 'active';
  const enabled = input.enabled === false ? 0 : 1;
  const revision = input.revision ?? 1;
  const content = input.content ?? '默认正文';
  const conditions = input.conditions ?? [];
  const updatedAt = input.updatedAt ?? '2026-10-17T10:00:00.000Z';
  const subjectKey = input.subjectKey ?? null;
  const cardinality = input.cardinality === undefined ? (subjectKey ? 'single' : null) : input.cardinality;
  const trust = input.trust ?? null;
  const record = {
    id, revision, projectId, scope, kind: 'fact', title: content.slice(0, 30), content, status, enabled: !!enabled,
    sources: [], parentIds: [], conditions, createdAt: updatedAt, updatedAt, hash: content, ...(subjectKey ? { subject: subjectKey } : {}),
  };
  db.prepare('INSERT INTO memory_records(id,project_id,scope,status,enabled,revision,json,subject_key,subject_cardinality,trust) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, projectId, scope, status, enabled, revision, JSON.stringify(record), subjectKey, cardinality, trust);
  return id;
}

function subjectInput(overrides: Partial<SubjectDefinition> = {}): SubjectDefinition {
  return {
    projectId: 'project-a', scope: 'project', key: 'orders.database.engine', label: '订单数据库',
    aliases: [], cardinality: 'single', valueType: 'enum', sensitivity: 'normal',
    createdAt: '2026-10-17T10:00:00.000Z', updatedAt: '2026-10-17T10:00:00.000Z', ...overrides,
  };
}

function side(memoryId: string, overrides: Partial<ConflictSideInput> = {}): ConflictSideInput {
  return { memoryId, revision: 1, claimHash: subjectClaimHash({ content: '数据库使用 SQLite' }), supportScore: 30, evidence: [{ kind: 'pi' }], ...overrides };
}

function peer(content: string, overrides: Partial<SubjectPeer> = {}): SubjectPeer {
  return {
    id: overrides.id ?? randomUUID(), revision: 1, claimHash: subjectClaimHash({ content, conditions: overrides.conditions }),
    content, conditions: [], trust: 'user_explicit', updatedAt: '2026-10-17T10:00:00.000Z', ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('normalizeSubjectKey folds case, width, whitespace, underscore, hyphen and colon into dotted keys', () => {
  assert.equal(normalizeSubjectKey('Project.DB.Engine'), 'project.db.engine');
  assert.equal(normalizeSubjectKey('  orders database engine  '), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('orders_database_engine'), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('orders-database-engine'), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('orders:database:engine'), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('ＯＲＤＥＲＳ．ＤＡＴＡＢＡＳＥ．ＥＮＧＩＮＥ'), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('a__b--c::d'), 'a.b.c.d');
  assert.equal(normalizeSubjectKey('.orders.'), 'orders');
  assert.equal(normalizeSubjectKey('orders.database.engine'), 'orders.database.engine');
  assert.equal(normalizeSubjectKey('user.response.language'), 'user.response.language');
  // Existing project-rule:<factId> subjects become one dotted key (colon -> '.').
  assert.equal(normalizeSubjectKey('project-rule:abc123'), 'project.rule.abc123');
  assert.equal(normalizeSubjectKey('same-subject'), 'same.subject');
  assert.equal(normalizeSubjectKey('database'), 'database');
});

test('normalizeSubjectKey rejects unusable subjects instead of inventing a key', () => {
  for (const raw of [undefined, null, 42, {}, [], true]) assert.equal(normalizeSubjectKey(raw), undefined, String(raw));
  for (const raw of ['', '   ', '..', 'db..engine', '数据库', '归档文件名命名规则', '.', '...']) {
    assert.equal(normalizeSubjectKey(raw), undefined, JSON.stringify(raw));
  }
  assert.equal(normalizeSubjectKey('a'.repeat(200)), 'a'.repeat(200));
  assert.equal(normalizeSubjectKey('a'.repeat(201)), undefined);
  // Illegal characters are dropped; a non-empty remainder is still a key.
  assert.equal(normalizeSubjectKey('db@engine!'), 'dbengine');
  assert.equal(normalizeSubjectKey('@#$%'), undefined);
});

test('isValidSubjectKey accepts bounded lowercase dotted keys only', () => {
  assert.equal(DEFAULT_SUBJECT_CARDINALITY, 'single');
  for (const key of ['orders.database.engine', 'database', 'a', 'a.b-c', 'project-rule.abc123', '2026.10.17']) assert.equal(isValidSubjectKey(key), true, key);
  for (const key of ['', 'Orders.Database', ' orders.database', 'orders..database', '.orders', 'orders.', 'db@engine', '数据库', 'a'.repeat(201)]) {
    assert.equal(isValidSubjectKey(key), false, JSON.stringify(key));
  }
});

test('normalizeSubjectValue folds width/case/whitespace and strips trailing sentence punctuation', () => {
  assert.equal(normalizeSubjectValue('　ＳＱＬｉｔｅ　数据库。 '), 'sqlite 数据库');
  assert.equal(normalizeSubjectValue('数据库必须使用 SQLite！'), '数据库必须使用 sqlite');
  assert.equal(normalizeSubjectValue('数据库必须使用 SQLite?'), '数据库必须使用 sqlite');
  assert.equal(normalizeSubjectValue('数据库必须使用 SQLite;'), '数据库必须使用 sqlite');
  assert.equal(normalizeSubjectValue('数据库必须使用 SQLite，'), '数据库必须使用 sqlite');
  assert.equal(normalizeSubjectValue('  multiple   spaces\tand\nnewlines  '), 'multiple spaces and newlines');
  // Internal and leading punctuation is meaningful and preserved.
  assert.equal(normalizeSubjectValue('"SQLite" 是默认值'), '"sqlite" 是默认值');
  assert.equal(normalizeSubjectValue('。领先的句号'), '。领先的句号');
});

test('subjectClaimHash treats width, spacing and trailing punctuation variants as the same value', () => {
  const base = subjectClaimHash({ content: '数据库使用 SQLite。', conditions: ['仅测试环境', '生产环境不使用'] });
  assert.equal(base, subjectClaimHash({ content: '数据库使用 ＳＱＬｉｔｅ', conditions: ['仅测试环境', '生产环境不使用'] }));
  assert.equal(base, subjectClaimHash({ content: '  数据库使用   sqlite  ', conditions: ['仅测试环境 ', '生产环境不使用'] }));
  // Condition order is not semantic.
  assert.equal(base, subjectClaimHash({ content: '数据库使用 SQLite', conditions: ['生产环境不使用', '仅测试环境'] }));
  assert.notEqual(base, subjectClaimHash({ content: '数据库使用 PostgreSQL', conditions: ['仅测试环境', '生产环境不使用'] }));
  assert.notEqual(base, subjectClaimHash({ content: '数据库使用 SQLite', conditions: ['仅测试环境'] }));
});

// ---------------------------------------------------------------------------
// Subject registry
// ---------------------------------------------------------------------------

test('registerSubject inserts and getSubject reads back the definition', () => {
  const f = createFixture();
  try {
    const saved = registerSubject(f.db, subjectInput({ aliases: ['订单库', 'orders db'] }));
    assert.equal(saved.key, 'orders.database.engine');
    assert.equal(saved.label, '订单数据库');
    assert.deepEqual(saved.aliases, ['订单库', 'orders db']);
    assert.deepEqual(getSubject(f.db, 'project-a', 'project', 'orders.database.engine'), saved);
    assert.equal(getSubject(f.db, 'project-b', 'project', 'orders.database.engine'), undefined);
    assert.equal(getSubject(f.db, 'project-a', 'personal', 'orders.database.engine'), undefined);
  } finally { f.cleanup(); }
});

test('registerSubject preserves label/created_at and unions aliases while refreshing metadata', () => {
  const f = createFixture();
  try {
    const first = registerSubject(f.db, subjectInput());
    const second = registerSubject(f.db, subjectInput({
      label: '被忽略的新标签', aliases: ['订单库', '订单库', ' db '], cardinality: 'multi',
      valueType: 'string', sensitivity: 'sensitive', updatedAt: '2026-10-17T11:00:00.000Z',
    }));
    assert.equal(second.label, '订单数据库');
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(second.updatedAt, '2026-10-17T11:00:00.000Z');
    assert.deepEqual(second.aliases, ['订单库', 'db']);
    assert.equal(second.cardinality, 'multi');
    assert.equal(second.valueType, 'string');
    assert.equal(second.sensitivity, 'sensitive');
    // An older update timestamp never moves updated_at backwards.
    const third = registerSubject(f.db, subjectInput({ updatedAt: '2026-10-17T09:00:00.000Z' }));
    assert.equal(third.updatedAt, '2026-10-17T11:00:00.000Z');
    assert.deepEqual(getSubject(f.db, 'project-a', 'project', 'orders.database.engine')?.aliases, ['订单库', 'db']);
  } finally { f.cleanup(); }
});

test('registerSubject rejects invalid keys/scopes and listSubjects isolates projects and scopes', () => {
  const f = createFixture();
  try {
    assert.throws(() => registerSubject(f.db, subjectInput({ key: 'Order DB' })), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => registerSubject(f.db, subjectInput({ scope: 'global' as SubjectDefinition['scope'] })), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    registerSubject(f.db, subjectInput({ key: 'b.topic', label: 'B' }));
    registerSubject(f.db, subjectInput({ key: 'a.topic', label: 'A' }));
    registerSubject(f.db, subjectInput({ key: 'personal.topic', label: 'P', scope: 'personal' }));
    registerSubject(f.db, subjectInput({ projectId: 'project-b', key: 'other.topic', label: 'O' }));
    assert.deepEqual(listSubjects(f.db, 'project-a').map(subject => subject.key), ['personal.topic', 'a.topic', 'b.topic']);
    assert.deepEqual(listSubjects(f.db, 'project-a', 'project').map(subject => subject.key), ['a.topic', 'b.topic']);
    assert.deepEqual(listSubjects(f.db, 'project-a', 'personal').map(subject => subject.key), ['personal.topic']);
    assert.deepEqual(listSubjects(f.db, 'project-b').map(subject => subject.key), ['other.topic']);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Active peers
// ---------------------------------------------------------------------------

test('activeSubjectPeers returns only active+enabled peers, newest first, excluding excludeId', () => {
  const f = createFixture();
  try {
    const older = insertRecord(f.db, { content: '数据库使用 SQLite', subjectKey: 'orders.database.engine', cardinality: 'multi', conditions: ['仅测试环境'], updatedAt: '2026-10-17T09:00:00.000Z', trust: 'user_explicit' });
    const newer = insertRecord(f.db, { content: '数据库使用 SQLite，生产只读', subjectKey: 'orders.database.engine', cardinality: 'multi', updatedAt: '2026-10-17T10:30:00.000Z' });
    insertRecord(f.db, { content: '候选', subjectKey: 'orders.database.engine', status: 'candidate' });
    insertRecord(f.db, { content: '已停用', subjectKey: 'orders.database.engine', enabled: false });
    insertRecord(f.db, { content: '其他项目', subjectKey: 'orders.database.engine', projectId: 'project-b' });
    insertRecord(f.db, { content: '个人范围', subjectKey: 'orders.database.engine', scope: 'personal' });
    insertRecord(f.db, { content: '其他主题', subjectKey: 'orders.database.owner' });

    const all = activeSubjectPeers(f.db, { projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine' });
    assert.deepEqual(all.map(item => item.id), [newer, older]);
    assert.equal(all[0].trust, null);
    assert.equal(all[1].trust, 'user_explicit');
    assert.deepEqual(all[1].conditions, ['仅测试环境']);
    assert.equal(all[0].claimHash, subjectClaimHash({ content: '数据库使用 SQLite，生产只读' }));
    assert.deepEqual(activeSubjectPeers(f.db, { projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', excludeId: newer }).map(item => item.id), [older]);
    assert.deepEqual(activeSubjectPeers(f.db, { projectId: 'project-a', scope: 'personal', subjectKey: 'orders.database.engine' }).map(item => item.content), ['个人范围']);
    assert.deepEqual(activeSubjectPeers(f.db, { projectId: 'project-b', scope: 'project', subjectKey: 'orders.database.engine' }).map(item => item.content), ['其他项目']);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detectSubjectConflict never opens a conflict without a subject', () => {
  const peers = [peer('数据库使用 SQLite')];
  for (const subjectKey of [undefined, null, '', '   ']) {
    assert.deepEqual(detectSubjectConflict({ subjectKey, claimHash: subjectClaimHash({ content: '数据库使用 PostgreSQL' }), trust: 'user_explicit', kind: 'fact', peers, hasCorrectionEvidence: false, explicitSupersedeIntent: false }), { action: 'none' });
  }
  assert.deepEqual(detectSubjectConflict({ subjectKey: 'orders.database.engine', claimHash: subjectClaimHash({ content: '数据库使用 PostgreSQL' }), trust: 'user_explicit', kind: 'fact', peers: [], hasCorrectionEvidence: false, explicitSupersedeIntent: false }), { action: 'none' });
});

test('detectSubjectConflict merges the same normalized value, even with correction evidence', () => {
  const existing = peer('数据库使用 SQLite。', { conditions: ['仅测试环境'] });
  const claimHash = subjectClaimHash({ content: ' 数据库使用 sqlite ', conditions: ['仅测试环境'] });
  const merged = detectSubjectConflict({ subjectKey: 'orders.database.engine', claimHash, trust: 'model_supported', kind: 'fact', peers: [existing], hasCorrectionEvidence: true, explicitSupersedeIntent: false });
  assert.deepEqual(merged, { action: 'merge', peer: existing });
  // A different claim hash with correction evidence supersedes instead of merging.
  const superseded = detectSubjectConflict({ subjectKey: 'orders.database.engine', claimHash: subjectClaimHash({ content: '数据库使用 PostgreSQL' }), trust: 'model_supported', kind: 'fact', peers: [existing], hasCorrectionEvidence: true, explicitSupersedeIntent: false });
  assert.equal(superseded.action, 'supersede');
});

test('detectSubjectConflict supersedes on user correction authority and opens otherwise', () => {
  const target = peer('数据库使用 SQLite');
  const different = subjectClaimHash({ content: '数据库使用 PostgreSQL' });
  const input = { subjectKey: 'orders.database.engine', claimHash: different, kind: 'fact', peers: [target], hasCorrectionEvidence: false };
  assert.deepEqual(detectSubjectConflict({ ...input, trust: 'user_explicit', explicitSupersedeIntent: true }), { action: 'supersede', peer: target });
  assert.deepEqual(detectSubjectConflict({ ...input, trust: 'user_confirmed', explicitSupersedeIntent: true }), { action: 'supersede', peer: target });
  // Model-inferred trust cannot replace an existing value just because the text sounds corrective.
  assert.equal(detectSubjectConflict({ ...input, trust: 'model_supported', explicitSupersedeIntent: true }).action, 'open');
  const conflict = detectSubjectConflict({ ...input, trust: 'source_verified', explicitSupersedeIntent: false });
  assert.equal(conflict.action, 'open');
  if (conflict.action === 'open') {
    assert.equal(conflict.peer, target);
    assert.match(conflict.reason, /orders\.database\.engine/u);
  }
});

test('detectSubjectConflict returns the most recently updated peer for supersede and open', () => {
  const older = peer('数据库使用 SQLite', { updatedAt: '2026-10-17T09:00:00.000Z' });
  const newer = peer('数据库使用 MySQL', { updatedAt: '2026-10-17T10:00:00.000Z' });
  const input = {
    subjectKey: 'orders.database.engine', claimHash: subjectClaimHash({ content: '数据库使用 PostgreSQL' }),
    trust: 'user_explicit', kind: 'fact', peers: [older, newer], explicitSupersedeIntent: false,
  };
  assert.deepEqual(detectSubjectConflict({ ...input, hasCorrectionEvidence: true }), { action: 'supersede', peer: newer });
  assert.deepEqual(detectSubjectConflict({ ...input, hasCorrectionEvidence: false, explicitSupersedeIntent: true }), { action: 'supersede', peer: newer });
  const conflict = detectSubjectConflict({ ...input, hasCorrectionEvidence: false, explicitSupersedeIntent: false });
  assert.equal(conflict.action, 'open');
  if (conflict.action === 'open') assert.equal(conflict.peer, newer);
});

// ---------------------------------------------------------------------------
// ConflictStore
// ---------------------------------------------------------------------------

test('ConflictStore.open persists a typed conflict object with both sides', () => {
  const f = createFixture();
  const clock = { value: '2026-10-17T12:00:00.000Z' };
  try {
    const store = new ConflictStore(f.db, { now: () => clock.value });
    const record = store.open({
      projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine',
      openedBy: 'learning', policyVersion: 3, notes: '等待用户裁决',
      left: side('memory-old', { revision: 2, supportScore: 40, evidence: [{ kind: 'pi', relation: 'supports' }] }),
      right: side('memory-new', { claimHash: subjectClaimHash({ content: '数据库使用 PostgreSQL' }), supportScore: 10, evidence: [] }),
    });
    assert.equal(record.status, 'open');
    assert.equal(record.resolution, null);
    assert.equal(record.openedAt, '2026-10-17T12:00:00.000Z');
    assert.equal(record.openedBy, 'learning');
    assert.equal(record.policyVersion, 3);
    assert.equal(record.notes, '等待用户裁决');
    assert.deepEqual(record.sides.map(item => [item.side, item.memoryId, item.revision, item.supportScore]), [['left', 'memory-old', 2, 40], ['right', 'memory-new', 1, 10]]);
    assert.deepEqual(store.get(record.id, 'project-a'), record);
    assert.equal(new ConflictStore(f.db).get(record.id, 'project-a')?.sides.length, 2);
    // Project boundary is enforced on read.
    assert.equal(store.get(record.id, 'project-b'), undefined);
  } finally { f.cleanup(); }
});

test('ConflictStore.list filters by project and status', () => {
  const f = createFixture();
  try {
    const store = new ConflictStore(f.db);
    const first = store.open({ projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'learning', left: side('a1'), right: side('b1') });
    const second = store.open({ projectId: 'project-a', scope: 'project', subjectKey: 'service.protocol', openedBy: 'migration', left: side('a2'), right: side('b2') });
    store.open({ projectId: 'project-b', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'learning', left: side('a3'), right: side('b3') });
    assert.deepEqual(store.list('project-a').map(item => item.id).sort(), [first.id, second.id].sort());
    assert.deepEqual(store.list('project-b').map(item => item.subjectKey), ['orders.database.engine']);
    store.transition(second.id, 'project-a', { resolution: 'neither', resolvedBy: 'user' });
    assert.deepEqual(store.list('project-a', { status: 'open' }).map(item => item.id), [first.id]);
    assert.deepEqual(store.list('project-a', { status: 'resolved' }).map(item => item.id), [second.id]);
    assert.deepEqual(store.list('project-a', { status: 'deferred' }), []);
    assert.throws(() => store.list('project-a', { status: 'bogus' as never }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
  } finally { f.cleanup(); }
});

test('ConflictStore.transition applies the ruling CAS and refuses terminal states', () => {
  const f = createFixture();
  const start = Date.parse('2026-10-17T12:00:00.000Z');
  let tick = 0;
  try {
    const store = new ConflictStore(f.db, { now: () => new Date(start + tick++ * 1000).toISOString() });
    const resolvedTarget = store.open({ projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'user', left: side('a1'), right: side('b1') });
    const resolved = store.transition(resolvedTarget.id, 'project-a', { resolution: 'keep_right', resolvedBy: 'user', notes: '采用新值' });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolution, 'keep_right');
    assert.equal(resolved.resolvedBy, 'user');
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.notes, '采用新值');
    assert.throws(() => store.transition(resolvedTarget.id, 'project-a', { resolution: 'merge', resolvedBy: 'user' }), (error: Error & { code?: string }) => error.code === 'VERSION_CONFLICT' && error.name === 'ConflictError');

    const deferredTarget = store.open({ projectId: 'project-a', scope: 'project', subjectKey: 'service.protocol', openedBy: 'learning', left: side('a2'), right: side('b2') });
    const deferred = store.transition(deferredTarget.id, 'project-a', { resolution: 'defer', resolvedBy: 'user' });
    assert.equal(deferred.status, 'deferred');
    assert.equal(deferred.resolution, null);
    assert.equal(deferred.resolvedAt, undefined);
    // A deferred conflict can still be ruled on later.
    const afterDefer = store.transition(deferredTarget.id, 'project-a', { resolution: 'both', resolvedBy: 'user' });
    assert.equal(afterDefer.status, 'resolved');
    assert.equal(afterDefer.resolution, 'both');
    assert.throws(() => store.transition('missing', 'project-a', { resolution: 'neither', resolvedBy: 'user' }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.transition(resolvedTarget.id, 'project-a', { resolution: 'defer', resolvedBy: 'user' }), (error: Error & { code?: string }) => error.code === 'VERSION_CONFLICT');
  } finally { f.cleanup(); }
});

test('ConflictStore.transition is a compare-and-swap: a concurrent ruling cannot overwrite the first', () => {
  const f = createFixture();
  try {
    const first = new ConflictStore(f.db);
    const second = new ConflictStore(f.db);
    const record = first.open({ projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'user', left: side('a1'), right: side('b1') });
    first.transition(record.id, 'project-a', { resolution: 'keep_left', resolvedBy: 'user' });
    // The second store observed only the original open state; its ruling must fail.
    assert.throws(() => second.transition(record.id, 'project-a', { resolution: 'keep_right', resolvedBy: 'user' }), (error: Error & { code?: string }) => error.code === 'VERSION_CONFLICT');
    assert.equal(second.get(record.id, 'project-a')?.resolution, 'keep_left');
  } finally { f.cleanup(); }
});

test('ConflictStore validates inputs and rejects bad sides/resolutions', () => {
  const f = createFixture();
  try {
    const store = new ConflictStore(f.db);
    const base = { projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'learning' as const, left: side('a1'), right: side('b1') };
    assert.throws(() => store.open({ ...base, subjectKey: 'Bad Key' }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.open({ ...base, scope: 'global' }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.open({ ...base, openedBy: 'robot' as never }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.open({ ...base, left: { ...side('a2'), revision: 0 } }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.open({ ...base, right: { ...side('b2'), claimHash: '' } }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.open({ ...base, left: { ...side('a3'), evidence: 'nope' as never } }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    const record = store.open(base);
    const bad: ConflictTransitionInput = { resolution: 'winner' as never, resolvedBy: 'user' };
    assert.throws(() => store.transition(record.id, 'project-a', bad), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.throws(() => store.transition(record.id, 'project-a', { resolution: 'merge', resolvedBy: 'agent' as never }), (error: Error & { code?: string }) => error.code === 'VALIDATION_ERROR');
    assert.equal(store.get(record.id, 'project-a')?.status, 'open');
  } finally { f.cleanup(); }
});

test('ConflictStore data survives reopening the database with a new store instance', () => {
  const f = createFixture();
  try {
    const store = new ConflictStore(f.db);
    const record = store.open({ projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine', openedBy: 'migration', notes: 'legacy', left: side('a1'), right: side('b1') });
    f.db.close();
    const reopened = new DatabaseSync(f.path);
    try {
      const next = new ConflictStore(reopened);
      const loaded = next.get(record.id, 'project-a');
      assert.deepEqual(loaded, record);
      const ruled = next.transition(record.id, 'project-a', { resolution: 'keep_right', resolvedBy: 'user' });
      assert.equal(ruled.status, 'resolved');
    } finally {
      reopened.close();
    }
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Database-level single-subject invariant (schema contract used by the controller)
// ---------------------------------------------------------------------------

test('the partial unique index exists and rejects a second active single-valued subject record', () => {
  const f = createFixture();
  try {
    const index = f.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='memory_records_single_subject'").get();
    assert.ok(index, 'memory_records_single_subject index must exist');
    assert.match(String(index!.sql), /WHERE status='active' AND subject_cardinality='single' AND subject_key IS NOT NULL/u);
    insertRecord(f.db, { content: '数据库使用 SQLite', subjectKey: 'orders.database.engine', cardinality: 'single' });
    assert.throws(
      () => insertRecord(f.db, { content: '数据库使用 PostgreSQL', subjectKey: 'orders.database.engine', cardinality: 'single' }),
      /UNIQUE constraint failed/u,
    );
    // Multi-valued subjects may coexist; candidates may coexist too.
    insertRecord(f.db, { content: '服务 A', subjectKey: 'service.api.url', cardinality: 'multi' });
    insertRecord(f.db, { content: '服务 B', subjectKey: 'service.api.url', cardinality: 'multi' });
    insertRecord(f.db, { content: '候选值', subjectKey: 'orders.database.engine', cardinality: 'single', status: 'candidate' });
  } finally { f.cleanup(); }
});

test('single-valued invariant is satisfied when the old active record is deactivated before activating the new one', () => {
  const f = createFixture();
  try {
    const oldId = insertRecord(f.db, { content: '数据库使用 SQLite', subjectKey: 'orders.database.engine', cardinality: 'single' });
    const newId = insertRecord(f.db, { content: '数据库使用 PostgreSQL', subjectKey: 'orders.database.engine', cardinality: 'single', status: 'candidate' });
    // Keep the ruling ordering explicit: deactivate first, then activate.
    f.db.prepare("UPDATE memory_records SET status='inactive',enabled=0 WHERE id=?").run(oldId);
    f.db.prepare("UPDATE memory_records SET status='active',enabled=1 WHERE id=?").run(newId);
    assert.deepEqual(activeSubjectPeers(f.db, { projectId: 'project-a', scope: 'project', subjectKey: 'orders.database.engine' }).map(item => item.id), [newId]);
    // Acting in the wrong order fails closed at the database level.
    assert.throws(() => f.db.prepare("UPDATE memory_records SET status='active',enabled=1 WHERE id=?").run(oldId), /UNIQUE constraint failed/u);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Controller-level integration (P0-C wired into index.ts)
//
// These tests exercise the real MemoryController + a fake foreground context:
// learning publishes through autopublish, subject conflicts become first-class
// objects, and every ruling keeps the single-active-value invariant.
// ---------------------------------------------------------------------------

interface ControllerSnapshot {
  memories: MemoryRecord[];
  candidates: MemoryRecord[];
  conflicts: ConflictRecord[];
  schemaVersion: number;
  autoPublish: { policy: { mode: string; version: number }; stats: { autoPublished: number; revoked: number; corrected: number }; audit: Record<string, unknown>[] };
}

interface RawRecordRow { id: string; status: string; subject_cardinality: string | null; auto_published: number }

function rawRows(dir: string, subjectKey: string, projectId = 'p', scope = 'project'): RawRecordRow[] {
  const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    return db.prepare('SELECT id,status,subject_cardinality,auto_published FROM memory_records WHERE project_id=? AND scope=? AND subject_key=? ORDER BY rowid').all(projectId, scope, subjectKey) as unknown as RawRecordRow[];
  } finally { db.close(); }
}

function activeSingleAutoCount(dir: string, subjectKey: string): number {
  return rawRows(dir, subjectKey).filter(row => row.status === 'active' && row.subject_cardinality === 'single' && row.auto_published === 1).length;
}

function registryCardinality(dir: string, subjectKey: string): string | undefined {
  const db = new DatabaseSync(join(dir, 'plugins.sqlite'));
  try {
    const row = db.prepare("SELECT cardinality FROM memory_subjects WHERE project_id='p' AND scope='project' AND key=?").get(subjectKey) as { cardinality?: string } | undefined;
    return row?.cardinality;
  } finally { db.close(); }
}

function controllerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-p0c-controller-'));
  const items: HistoryItem[] = [{ id: 'user1', parentId: null, type: 'message', role: 'user', timestamp: new Date().toISOString(), text: '开始独立验收。' }];
  const previousRole = process.env.FRIEND_PI_LEARNING_ROLE;
  process.env.FRIEND_PI_LEARNING_ROLE = 'producer';
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let calls = 0;
  const ctx: PluginContext = {
    origin: 'user', dataDir: dir, projectDir: dir, projectId: 'p', sessionId: 's', runId: 'run-1', modelId: 'fixture/offline',
    isIdle: () => false, history: () => items,
    readSource(source) { const item = items.find(item => item.id === source.entryId); if (!item) throw new Error('来源不存在'); return item; },
    complete: async () => { calls++; return '{"memories":[]}'; },
    request: async () => { throw new Error('not installed'); },
    emit: (event, data) => events.push({ event, data: data as Record<string, unknown> }), notify: () => {}, appendEntry: () => {},
  };
  const controller = new MemoryController();
  return {
    dir, items, ctx, events,
    get c(): MemoryController { return controller; },
    calls: () => calls,
    reply(proposals: unknown[]) { ctx.complete = async () => { calls++; return JSON.stringify({ memories: proposals }); }; },
    push(id: string, text: string) { items.push({ id, parentId: items.at(-1)?.id ?? null, type: 'message', role: 'user', timestamp: new Date().toISOString(), text }); },
    async drain() {
      for (let step = 0; step < 80; step++) { const job = peekLearningJob(dir); if (!job) return; await controller.executeLearningJob(job.id, ctx); }
      throw new Error('learning did not settle');
    },
    snapshot() { return controller.snapshot(ctx) as unknown as ControllerSnapshot; },
    async close() {
      await controller.dispose();
      if (previousRole === undefined) delete process.env.FRIEND_PI_LEARNING_ROLE; else process.env.FRIEND_PI_LEARNING_ROLE = previousRole;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function publishFact(f: ReturnType<typeof controllerFixture>, input: { text: string; content: string; subject?: string; conditions?: string[]; title?: string; quote?: string }): Promise<string> {
  const id = `source-${randomUUID()}`;
  f.push(id, input.text);
  f.reply([{
    title: input.title ?? input.content, content: input.content, kind: 'fact',
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
    sourceEntryIds: [id], sourceQuotes: { [id]: input.quote ?? input.text },
  }]);
  await f.c.settled(f.ctx);
  await f.drain();
  f.ctx.complete = async () => '{"memories":[]}';
  return id;
}

async function explicitSave(f: ReturnType<typeof controllerFixture>, input: { content: string; subject?: string; conditions?: string[] }): Promise<MemoryRecord> {
  return await f.c.dispatch('save', { explicitRemember: true, ...input }, f.ctx) as MemoryRecord;
}

test('controller publish opens a first-class conflict: the old value stays active/recallable and the new value is isolated', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    assert.ok(first);
    assert.equal(first.status, 'active');
    assert.equal(first.subjectKey, 'orders.database.engine');

    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const snapshot = f.snapshot();
    const current = snapshot.memories.find(record => record.id === first.id)!;
    const candidate = snapshot.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    assert.equal(current.status, 'active');
    assert.deepEqual(current.conflictIds, []);
    assert.equal(candidate.status, 'candidate');
    assert.ok(candidate.conflictId);
    assert.equal(candidate.conflictState, 'open');
    assert.equal(snapshot.schemaVersion, 4);
    assert.equal(snapshot.conflicts.length, 1);
    const conflict = snapshot.conflicts[0]!;
    assert.equal(conflict.status, 'open');
    assert.equal(conflict.subjectKey, 'orders.database.engine');
    assert.equal(conflict.openedBy, 'learning');
    assert.deepEqual(conflict.sides.map(side => [side.side, side.memoryId]), [['left', first.id], ['right', candidate.id]]);
    assert.equal(conflict.sides[0].claimHash, subjectClaimHash({ content: current.content, conditions: current.conditions ?? [] }));
    // Old value usable, new value isolated from recall.
    assert.equal(f.c.search({ query: 'SQLite' }, f.ctx)[0]?.id, first.id);
    assert.deepEqual(f.c.search({ query: 'PostgreSQL' }, f.ctx), []);
    assert.ok((f.c.select({ query: '订单数据库' }, f.ctx).records as MemoryRecord[]).some(record => record.id === first.id));
    const listed = await f.c.dispatch('conflict.list', { status: 'open' }, f.ctx) as { conflicts: ConflictRecord[] };
    assert.deepEqual(listed.conflicts.map(item => item.id), [conflict.id]);
    assert.ok(f.events.some(event => event.event === 'memory.conflict.opened'));
  } finally { await f.close(); }
});

test('controller conflict.resolve keep_right is CAS-guarded, idempotent by operationId, and leaves one active value', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const opened = f.snapshot();
    const candidate = opened.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    const conflict = opened.conflicts[0]!;

    // A stale expectedStatus is a CAS failure, not a silent ruling.
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_right', expectedStatus: 'deferred' }, f.ctx), { name: 'ConflictError' });

    const resolved = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_right', expectedStatus: 'open', operationId: 'resolve-right-1' }, f.ctx) as { conflict: ConflictRecord; affectedRecordIds: string[]; records: MemoryRecord[] };
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal(resolved.conflict.resolution, 'keep_right');
    assert.equal(resolved.conflict.resolvedBy, 'user');
    assert.deepEqual([...resolved.affectedRecordIds].sort(), [first.id, candidate.id].sort());

    const after = f.snapshot();
    assert.equal(after.memories.find(record => record.id === first.id)?.status, 'inactive');
    assert.equal(after.memories.find(record => record.id === candidate.id)?.status, 'active');
    assert.equal(f.c.search({ query: 'PostgreSQL' }, f.ctx)[0]?.id, candidate.id);
    assert.deepEqual(f.c.search({ query: 'SQLite' }, f.ctx), []);
    const old = await f.c.dispatch('read', { id: first.id }, f.ctx) as MemoryRecord;
    assert.equal(old.status, 'inactive');
    assert.equal(old.content, '订单数据库实际使用 SQLite');
    // Database-level single-active-value invariant.
    assert.equal(rawRows(f.dir, 'orders.database.engine').filter(row => row.status === 'active').length, 1);
    assert.equal(activeSingleAutoCount(f.dir, 'orders.database.engine'), 0);

    // Same operationId + payload replays the committed result.
    const replay = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_right', expectedStatus: 'open', operationId: 'resolve-right-1' }, f.ctx);
    assert.deepEqual(replay, resolved);
    // Reusing the operationId for a different payload is a version conflict.
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_left', expectedStatus: 'open', operationId: 'resolve-right-1' }, f.ctx), { code: 'VERSION_CONFLICT' });
    // Resolved conflicts are terminal.
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'neither' }, f.ctx), { name: 'ConflictError' });
    // Rulings are user authority only.
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'neither' }, { ...f.ctx, origin: 'agent' }), { code: 'PERMISSION_DENIED' });
    assert.ok(f.events.some(event => event.event === 'memory.conflict.resolved'));
  } finally { await f.close(); }
});

test('controller conflict.resolve keep_left keeps the old active value untouched and retires only the candidate', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const opened = f.snapshot();
    const candidate = opened.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    const conflict = opened.conflicts[0]!;
    const resolved = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_left' }, f.ctx) as { conflict: ConflictRecord; affectedRecordIds: string[]; records: MemoryRecord[] };
    assert.equal(resolved.conflict.status, 'resolved');
    assert.equal(resolved.conflict.resolution, 'keep_left');
    assert.deepEqual(resolved.affectedRecordIds, [candidate.id]);
    assert.deepEqual(resolved.records.map(record => [record.id, record.status]), [[candidate.id, 'inactive']]);
    const kept = await f.c.dispatch('read', { id: first.id }, f.ctx) as MemoryRecord;
    assert.equal(kept.status, 'active');
    assert.equal(kept.revision, first.revision);
    assert.equal((await f.c.dispatch('read', { id: candidate.id }, f.ctx) as MemoryRecord).status, 'inactive');
    assert.equal(f.c.search({ query: 'SQLite' }, f.ctx)[0]?.id, first.id);
    assert.deepEqual(f.c.search({ query: 'PostgreSQL' }, f.ctx), []);
  } finally { await f.close(); }
});

test('controller conflict.resolve defer keeps both sides pending and allows a later keep_right ruling', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const opened = f.snapshot();
    const candidate = opened.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    const conflict = opened.conflicts[0]!;
    const deferred = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'defer', notes: '证据不足，稍后再看' }, f.ctx) as { conflict: ConflictRecord; affectedRecordIds: string[]; records: MemoryRecord[] };
    assert.equal(deferred.conflict.status, 'deferred');
    assert.equal(deferred.conflict.resolution, null);
    assert.deepEqual(deferred.affectedRecordIds, []);
    assert.deepEqual(deferred.records, []);
    assert.equal((await f.c.dispatch('read', { id: first.id }, f.ctx) as MemoryRecord).status, 'active');
    assert.equal((await f.c.dispatch('read', { id: candidate.id }, f.ctx) as MemoryRecord).status, 'candidate');
    assert.deepEqual((await f.c.dispatch('conflict.list', { status: 'open' }, f.ctx) as { conflicts: ConflictRecord[] }).conflicts, []);
    assert.deepEqual((await f.c.dispatch('conflict.list', { status: 'deferred' }, f.ctx) as { conflicts: ConflictRecord[] }).conflicts.map(item => item.id), [conflict.id]);
    const ruled = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'keep_right' }, f.ctx) as { conflict: ConflictRecord };
    assert.equal(ruled.conflict.status, 'resolved');
    assert.equal((await f.c.dispatch('read', { id: first.id }, f.ctx) as MemoryRecord).status, 'inactive');
    assert.equal((await f.c.dispatch('read', { id: candidate.id }, f.ctx) as MemoryRecord).status, 'active');
  } finally { await f.close(); }
});

test('controller conflict.resolve both activates distinguishable values as multi-cardinality', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：测试环境的缓存使用 Redis。', content: '测试环境的缓存使用 Redis', subject: 'cache.engine', conditions: ['仅测试环境'] });
    await publishFact(f, { text: '生产环境的缓存使用 Memcached。', content: '生产环境的缓存使用 Memcached', subject: 'cache.engine', conditions: ['仅生产环境'] });
    const opened = f.snapshot();
    assert.equal(opened.conflicts.length, 1);
    const conflict = opened.conflicts[0]!;
    const both = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'both' }, f.ctx) as { conflict: ConflictRecord; records: MemoryRecord[] };
    assert.equal(both.conflict.status, 'resolved');
    assert.equal(both.conflict.resolution, 'both');
    const active = f.snapshot().memories.filter(record => record.subjectKey === 'cache.engine' && record.status === 'active');
    assert.equal(active.length, 2);
    assert.ok(active.every(record => record.subjectCardinality === 'multi'));
    assert.equal(registryCardinality(f.dir, 'cache.engine'), 'multi');
    const rows = rawRows(f.dir, 'cache.engine');
    assert.equal(rows.filter(row => row.status === 'active' && row.subject_cardinality === 'multi').length, 2);
  } finally { await f.close(); }
});

test('controller conflict.resolve both rejects values without distinguishable conditions', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：本项目服务使用 HTTP/1.1。', content: '本项目服务使用 HTTP/1.1', subject: 'service.protocol' });
    await publishFact(f, { text: '独立观察：本项目服务使用 HTTP/2。', content: '本项目服务使用 HTTP/2', subject: 'service.protocol' });
    const conflict = f.snapshot().conflicts[0]!;
    assert.ok(conflict);
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'both' }, f.ctx), { code: 'VALIDATION_ERROR' });
    // The failed ruling is atomic: the conflict stays open and both values unchanged.
    const failed = f.snapshot();
    assert.equal(failed.conflicts.find(item => item.id === conflict.id)?.status, 'open');
    assert.equal(failed.memories.filter(record => record.subjectKey === 'service.protocol' && record.status === 'active').length, 1);
    assert.equal(failed.candidates.filter(record => record.subjectKey === 'service.protocol').length, 1);
    // neither is still available and retires both values.
    const neither = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'neither' }, f.ctx) as { conflict: ConflictRecord; records: MemoryRecord[] };
    assert.equal(neither.conflict.status, 'resolved');
    assert.equal(neither.conflict.resolution, 'neither');
    assert.ok(neither.records.every(record => record.status === 'inactive'));
    assert.deepEqual(f.c.search({ query: '项目服务' }, f.ctx), []);
  } finally { await f.close(); }
});

test('controller conflict.resolve merge builds one active merged record and retires both parents', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const opened = f.snapshot();
    const candidate = opened.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    const conflict = opened.conflicts[0]!;
    // Merge needs explicit combined content; failure must not consume the conflict.
    await assert.rejects(f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'merge' }, f.ctx), /合并后的正文/u);
    assert.equal(f.snapshot().conflicts.find(item => item.id === conflict.id)?.status, 'open');
    const mergedContent = '订单数据库实际使用 PostgreSQL（合并历史证据）';
    const merged = await f.c.dispatch('conflict.resolve', { id: conflict.id, resolution: 'merge', content: mergedContent, title: '订单数据库合并事实' }, f.ctx) as { conflict: ConflictRecord; affectedRecordIds: string[]; records: MemoryRecord[] };
    assert.equal(merged.conflict.status, 'resolved');
    assert.equal(merged.conflict.resolution, 'merge');
    const mergedRecord = merged.records.find(record => record.status === 'active' && record.content === mergedContent);
    assert.ok(mergedRecord);
    assert.deepEqual([...mergedRecord.parentIds].sort(), [first.id, candidate.id].sort());
    assert.equal(mergedRecord.sources.length, 2);
    assert.ok(merged.affectedRecordIds.includes(mergedRecord.id));
    const after = f.snapshot();
    assert.equal(after.memories.find(record => record.id === first.id)?.status, 'inactive');
    assert.equal(after.memories.find(record => record.id === candidate.id)?.status, 'inactive');
    assert.equal(after.memories.find(record => record.id === mergedRecord.id)?.status, 'active');
    assert.equal(rawRows(f.dir, 'orders.database.engine').filter(row => row.status === 'active').length, 1);
  } finally { await f.close(); }
});

test('controller publish merges evidence when the normalized subject value is unchanged', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：项目数据库使用 SQLite。', content: '项目数据库使用 SQLite', subject: 'project.db.engine' });
    await publishFact(f, { text: '项目数据库使用 SQLite！', content: '项目数据库使用 SQLite！', subject: 'project.db.engine' });
    const snapshot = f.snapshot();
    const active = snapshot.memories.filter(record => record.subjectKey === 'project.db.engine' && record.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0]!.sources.length, 2);
    assert.ok(active[0]!.revision >= 2);
    assert.deepEqual(snapshot.conflicts, []);
    const mergedAway = snapshot.memories.find(record => record.content === '项目数据库使用 SQLite！');
    assert.ok(mergedAway);
    assert.equal(mergedAway.status, 'inactive');
    assert.match(mergedAway.invalidatedReason ?? '', /同值|合并/u);
    assert.equal(activeSingleAutoCount(f.dir, 'project.db.engine'), 1);
  } finally { await f.close(); }
});

test('controller auto-publish keeps subjectless verified facts active and normalizes ASCII subjects', async () => {
  const f = controllerFixture();
  try {
    f.push('source-logs', '日志必须使用 UTF-8。');
    f.push('source-api', '本项目接口路径使用 /api/v2。');
    f.reply([
      { title: '日志编码', content: '日志必须使用 UTF-8', kind: 'fact', sourceEntryIds: ['source-logs'], sourceQuotes: { 'source-logs': '日志必须使用 UTF-8。' } },
      { title: '接口路径', content: '本项目接口路径使用 /api/v2', kind: 'fact', subject: 'project.api.path', sourceEntryIds: ['source-api'], sourceQuotes: { 'source-api': '本项目接口路径使用 /api/v2。' } },
    ]);
    await f.c.settled(f.ctx);
    await f.drain();
    const snapshot = f.snapshot();
    const subjectless = snapshot.memories.find(record => record.content === '日志必须使用 UTF-8');
    assert.ok(subjectless);
    assert.equal(subjectless.status, 'active');
    assert.equal(subjectless.subjectKey ?? null, null);
    assert.equal(subjectless.autoPublished, true);
    const subjected = snapshot.memories.find(record => record.content.includes('/api/v2'));
    assert.ok(subjected);
    assert.equal(subjected.status, 'active');
    assert.equal(subjected.subjectKey, 'project.api.path');
    assert.deepEqual(snapshot.conflicts, []);
  } finally { await f.close(); }
});

test('controller accept on a conflicting candidate opens/keeps a conflict instead of superseding the active value', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const opened = f.snapshot();
    const candidate = opened.candidates.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    const accepted = await f.c.dispatch('accept', { id: candidate.id, expectedRevision: candidate.revision }, f.ctx) as MemoryRecord;
    assert.equal(accepted.status, 'candidate');
    assert.ok(accepted.conflictId);
    assert.equal(accepted.conflictState, 'open');
    const after = f.snapshot();
    assert.equal(after.memories.find(record => record.id === first.id)?.status, 'active');
    assert.deepEqual(after.memories.find(record => record.id === first.id)?.conflictIds, []);
    assert.ok(after.conflicts.some(conflict => conflict.status === 'open' && conflict.subjectKey === 'orders.database.engine'));
    assert.equal(f.c.search({ query: 'SQLite' }, f.ctx)[0]?.id, first.id);
    assert.deepEqual(f.c.search({ query: 'PostgreSQL' }, f.ctx), []);
  } finally { await f.close(); }
});

test('controller toggle re-enable with a conflicting active peer opens a conflict and stays inactive', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const first = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    const disabled = await f.c.dispatch('toggle', { id: first.id, expectedRevision: first.revision, enabled: false }, f.ctx) as MemoryRecord;
    assert.equal(disabled.status, 'inactive');
    await publishFact(f, { text: '独立观察：订单数据库实际使用 PostgreSQL。', content: '订单数据库实际使用 PostgreSQL', subject: 'orders.database.engine' });
    const replacement = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 PostgreSQL')!;
    assert.equal(replacement.status, 'active');
    const reenabled = await f.c.dispatch('toggle', { id: first.id, expectedRevision: disabled.revision, enabled: true }, f.ctx) as MemoryRecord;
    assert.equal(reenabled.status, 'inactive');
    assert.equal(reenabled.enabled, false);
    assert.ok(reenabled.conflictId);
    const after = f.snapshot();
    assert.equal(after.memories.find(record => record.id === replacement.id)?.status, 'active');
    assert.ok(after.conflicts.some(conflict => conflict.status === 'open' && conflict.subjectKey === 'orders.database.engine'));
    assert.equal(f.c.search({ query: 'PostgreSQL' }, f.ctx)[0]?.id, replacement.id);
    assert.deepEqual(f.c.search({ query: 'SQLite' }, f.ctx), []);
  } finally { await f.close(); }
});

test('controller user update retires a differing active same-subject peer before activating the edit', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const auto = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    const explicit = await explicitSave(f, { content: '订单数据库实际使用 MySQL', subject: 'orders.database.engine' });
    assert.equal(explicit.status, 'active');
    const updated = await f.c.dispatch('update', { id: explicit.id, expectedRevision: explicit.revision, content: '订单数据库实际使用 PostgreSQL' }, f.ctx) as MemoryRecord;
    assert.equal(updated.status, 'active');
    assert.equal(updated.content, '订单数据库实际使用 PostgreSQL');
    const after = f.snapshot();
    assert.equal(after.memories.find(record => record.id === auto.id)?.status, 'inactive');
    assert.equal(after.memories.find(record => record.id === explicit.id)?.status, 'active');
    assert.equal(rawRows(f.dir, 'orders.database.engine').filter(row => row.status === 'active').length, 1);
  } finally { await f.close(); }
});

test('controller correction supersede retires the old subject value before publishing the replacement', async () => {
  const f = controllerFixture();
  try {
    await publishFact(f, { text: '项目事实：订单数据库实际使用 SQLite。', content: '订单数据库实际使用 SQLite', subject: 'orders.database.engine' });
    const old = f.snapshot().memories.find(record => record.content === '订单数据库实际使用 SQLite')!;
    assert.equal(old.status, 'active');
    const correctionId = 'correction-message';
    f.push(correctionId, '更正：订单数据库实际使用 PostgreSQL，不再使用 SQLite。');
    f.reply([{
      title: '订单数据库更正', content: '订单数据库实际使用 PostgreSQL', kind: 'fact', subject: 'orders.database.engine',
      sourceEntryIds: [correctionId], sourceQuotes: { [correctionId]: '订单数据库实际使用 PostgreSQL，不再使用 SQLite。' }, supersedesMemoryIds: [old.id],
    }]);
    await f.c.settled(f.ctx);
    await f.drain();
    const after = f.snapshot();
    const retired = after.memories.find(record => record.id === old.id)!;
    assert.equal(retired.status, 'inactive');
    const replacement = after.memories.find(record => record.content === '订单数据库实际使用 PostgreSQL');
    assert.ok(replacement);
    assert.equal(replacement.status, 'active');
    assert.equal(replacement.autoPublished, true);
    assert.equal(replacement.trust, 'source_verified');
    assert.deepEqual(after.conflicts, []);
    assert.equal(activeSingleAutoCount(f.dir, 'orders.database.engine'), 1);
    assert.equal(f.c.search({ query: 'SQLite' }, f.ctx).length, 0);
    assert.equal(f.c.search({ query: 'PostgreSQL' }, f.ctx)[0]?.id, replacement.id);
    assert.ok(f.events.some(event => event.event === 'memory.invalidated'));
  } finally { await f.close(); }
});
