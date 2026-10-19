import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DREAM_RULE_VERSION, applyDreamPlan, dreamRetentionScore, planDream, rollbackConsolidation, validateDreamProposal,
  type DreamOperation, type DreamPlan, type DreamRecord,
} from '../src/dream.js';

const NOW = '2026-10-17T12:00:00.000Z';
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY).toISOString();
}

function source(sessionId: string, entryId: string): Record<string, unknown> {
  return {sessionId, entryId, start: 0, end: 10, hash: `${sessionId}-${entryId}-hash`};
}

// A database independent of the controller: every table Dream touches is created
// here with the same columns as the Lead-owned schema v5 migration.
function openDatabase(minimal = false): {db: DatabaseSync; dir: string; close: () => void} {
  const dir = mkdtempSync(join(tmpdir(), 'memory-dream-test-'));
  const db = new DatabaseSync(join(dir, 'memory.sqlite'));
  if (minimal) {
    db.exec(`
      CREATE TABLE memory_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE memory_consolidations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,applied_at TEXT,rolled_back_at TEXT,diff_json TEXT NOT NULL,parent_ids_json TEXT NOT NULL,child_ids_json TEXT NOT NULL,rollback_token TEXT,json TEXT NOT NULL);
    `);
  } else {
    db.exec(`
      CREATE TABLE documents(namespace TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,key));
      CREATE TABLE memory_records(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
        enabled INTEGER NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL,
        kind_v2 TEXT, subject_key TEXT, subject_cardinality TEXT, trust TEXT, authority TEXT,
        auto_published INTEGER NOT NULL DEFAULT 0, policy_id TEXT, policy_version INTEGER, score INTEGER,
        conflict_state TEXT, lineage_root TEXT, semantic_digest TEXT, last_used_at TEXT,
        use_count INTEGER NOT NULL DEFAULT 0, feedback_score REAL NOT NULL DEFAULT 0, expires_at TEXT,
        deleted_at TEXT, pinned INTEGER NOT NULL DEFAULT 0, pinned_at TEXT, decay_score REAL,
        consolidation_id TEXT, project_ids_json TEXT);
      CREATE TABLE memory_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE memory_relations(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        kind TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE memory_consolidations(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        actor TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT, rolled_back_at TEXT,
        diff_json TEXT NOT NULL, parent_ids_json TEXT NOT NULL, child_ids_json TEXT NOT NULL,
        rollback_token TEXT, json TEXT NOT NULL);
    `);
  }
  return {db, dir, close: () => { db.close(); rmSync(dir, {recursive: true, force: true}); }};
}

function seedRow(db: DatabaseSync, over: Partial<DreamRecord> & {id: string; evidence?: unknown[]}): DreamRecord {
  const record: DreamRecord = {
    projectId: 'p', scope: 'project', kind: 'fact', subjectKey: null, title: `标题-${over.id}`,
    content: '内容', conditions: [], status: 'active', enabled: true, revision: 1,
    trust: 'user_explicit', updatedAt: NOW, expiresAt: null, useCount: 0, lastUsedAt: null,
    feedbackScore: 0, sources: [], parentIds: [], ...over,
  };
  const json = {
    id: record.id, revision: record.revision, projectId: record.projectId, scope: record.scope,
    schemaVersion: 2, kind: record.kind, title: record.title, content: record.content,
    conditions: record.conditions, status: record.status, enabled: record.enabled,
    sources: record.sources, parentIds: record.parentIds, fingerprint: `fingerprint-${record.id}`,
    hash: `hash-${record.id}`, createdAt: NOW, updatedAt: record.updatedAt, aliases: [],
    trust: record.trust, expiresAt: record.expiresAt, useCount: record.useCount,
    lastUsedAt: record.lastUsedAt, feedbackScore: record.feedbackScore,
    evidence: (over as {evidence?: unknown[]}).evidence ?? [], dependencies: [],
    ...(record.subjectKey ? {subjectKey: record.subjectKey, subjectCardinality: 'single'} : {}),
  };
  const columns = new Set((db.prepare('PRAGMA table_info(memory_records)').all() as Record<string, unknown>[]).map(row => String(row.name)));
  const values: Record<string, unknown> = {
    id: record.id, project_id: record.projectId, scope: record.scope, status: record.status,
    enabled: Number(record.enabled), revision: record.revision, json: JSON.stringify(json),
    kind_v2: record.kind, subject_key: record.subjectKey ?? null,
    subject_cardinality: record.subjectKey ? 'single' : null, trust: record.trust,
    authority: null, lineage_root: record.id, use_count: record.useCount,
    feedback_score: record.feedbackScore, expires_at: record.expiresAt, pinned: 0,
  };
  const present = Object.keys(values).filter(key => columns.has(key));
  db.prepare(`INSERT INTO memory_records(${present.join(',')}) VALUES(${present.map(() => '?').join(',')})`)
    .run(...present.map(key => values[key] as string | number | null));
  return record;
}

function recordRow(db: DatabaseSync, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM memory_records WHERE id=?').get(id) as Record<string, unknown> | undefined;
  assert.ok(row, `record ${id} should exist`);
  return row;
}
function recordJson(db: DatabaseSync, id: string): Record<string, unknown> {
  return JSON.parse(String(recordRow(db, id).json)) as Record<string, unknown>;
}
function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return Number(row?.n ?? 0);
}
function consolidations(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM memory_consolidations').all() as Record<string, unknown>[];
}
function relations(db: DatabaseSync): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM memory_relations').all() as Record<string, unknown>[];
}
function opsOf(plan: DreamPlan, kind: DreamOperation['kind']): DreamOperation[] {
  return plan.operations.filter(op => op.kind === kind);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

test('planDream merges equivalent claims deterministically (byte-identical, stable id)', () => {
  const f = openDatabase();
  try {
    const a = seedRow(f.db, {id: 'rec-a', subjectKey: 'language.response', content: 'Always answer in Chinese', conditions: ['project-alpha'], sources: [source('s1', 'e1')]});
    const b = seedRow(f.db, {id: 'rec-b', subjectKey: 'language.response', content: 'always ANSWER in   chinese', conditions: ['project-alpha'], sources: [source('s2', 'e2')]});
    const c = seedRow(f.db, {id: 'rec-c', subjectKey: 'language.response', content: 'Use concise bullet lists', conditions: ['project-alpha']});
    const plan = planDream({projectId: 'p', records: [c, a, b], now: NOW});
    const merges = opsOf(plan, 'merge');
    assert.equal(merges.length, 1);
    const merge = merges[0] as Extract<DreamOperation, {kind: 'merge'}>;
    assert.deepEqual(merge.parentIds, ['rec-a', 'rec-b']);
    assert.deepEqual(merge.conditions, ['project-alpha']);
    assert.equal(merge.sourceIds.length, 2);
    assert.match(plan.consolidationId, UUID);
    assert.equal(plan.projectId, 'p');
    assert.equal(plan.proposals.length, 0);

    const shuffled = planDream({projectId: 'p', records: [b, c, a], now: NOW});
    assert.equal(JSON.stringify(plan), JSON.stringify(shuffled), 'input order must not change the plan bytes');
    assert.equal(plan.consolidationId, shuffled.consolidationId);
    assert.equal(DREAM_RULE_VERSION, 1);
  } finally { f.close(); }
});

test('planDream never merges different values, conditions, scopes or subjects', () => {
  const f = openDatabase();
  try {
    seedRow(f.db, {id: 'v1', subjectKey: 'deploy.strategy', content: 'Blue-green'});
    seedRow(f.db, {id: 'v2', subjectKey: 'deploy.strategy', content: 'Canary'});
    seedRow(f.db, {id: 'c1', subjectKey: 'db.pool', content: 'Pool size 20', conditions: ['prod']});
    seedRow(f.db, {id: 'c2', subjectKey: 'db.pool', content: 'Pool size 20', conditions: ['dev']});
    seedRow(f.db, {id: 's1', subjectKey: 'theme.color', content: 'Dark', scope: 'project'});
    seedRow(f.db, {id: 's2', subjectKey: 'theme.color', content: 'Dark', scope: 'personal'});
    seedRow(f.db, {id: 'k1', subjectKey: 'one.key', content: 'Shared sentence'});
    seedRow(f.db, {id: 'k2', subjectKey: 'two.key', content: 'Shared sentence'});
    const loaded = planDream({
      projectId: 'p', now: NOW,
      records: [
        {id: 'v1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'deploy.strategy', title: 't', content: 'Blue-green', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'v2', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'deploy.strategy', title: 't', content: 'Canary', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'c1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'db.pool', title: 't', content: 'Pool size 20', conditions: ['prod'], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'c2', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'db.pool', title: 't', content: 'Pool size 20', conditions: ['dev'], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 's1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'theme.color', title: 't', content: 'Dark', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 's2', projectId: 'p', scope: 'personal', kind: 'fact', subjectKey: 'theme.color', title: 't', content: 'Dark', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'k1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'one.key', title: 't', content: 'Shared sentence', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'k2', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'two.key', title: 't', content: 'Shared sentence', conditions: [], status: 'active', enabled: true, revision: 1, updatedAt: NOW, sources: []},
      ],
    });
    assert.equal(opsOf(loaded, 'merge').length, 0);
  } finally { f.close(); }
});

test('planDream archives expired and low-retention records only', () => {
  const f = openDatabase();
  try {
    const expired = seedRow(f.db, {id: 'expired', expiresAt: daysAgo(1), updatedAt: NOW});
    const stale = seedRow(f.db, {id: 'stale', trust: 'model_supported', updatedAt: daysAgo(400), useCount: 0});
    const fresh = seedRow(f.db, {id: 'fresh', trust: 'user_explicit', updatedAt: NOW, lastUsedAt: NOW, useCount: 12});
    const plan = planDream({projectId: 'p', records: [expired, stale, fresh], now: NOW});
    const archives = opsOf(plan, 'archive') as Extract<DreamOperation, {kind: 'archive'}>[];
    const reasons = new Map(archives.map(op => [op.memoryId, op.reason]));
    assert.equal(reasons.get('expired'), 'expired');
    assert.equal(reasons.get('stale'), 'low-retention');
    assert.equal(reasons.has('fresh'), false);
    assert.ok(dreamRetentionScore(stale, NOW) < 0.25);
    assert.ok(dreamRetentionScore(fresh, NOW) > dreamRetentionScore(stale, NOW));
    assert.ok(dreamRetentionScore(fresh, NOW) <= 1);
  } finally { f.close(); }
});

test('planDream emits parent, same-subject and conflict relations sorted by id', () => {
  const f = openDatabase();
  try {
    const parent = seedRow(f.db, {id: 'rel-parent', subjectKey: 'deploy.strategy', content: 'Blue-green deployment'});
    const child = seedRow(f.db, {id: 'rel-child', subjectKey: 'deploy.notes', content: 'Rollback first', parentIds: ['rel-parent']});
    const peer = seedRow(f.db, {id: 'rel-peer', subjectKey: 'deploy.strategy', content: 'Canary deployment'});
    const plan = planDream({projectId: 'p', records: [parent, child, peer], conflictIds: ['rel-peer', 'rel-parent'], now: NOW});
    const relations = opsOf(plan, 'relation') as Extract<DreamOperation, {kind: 'relation'}>[];
    assert.ok(relations.some(op => op.relation === 'derived-from' && op.fromId === 'rel-child' && op.toId === 'rel-parent'));
    assert.ok(relations.some(op => op.relation === 'same-subject' && op.fromId === 'rel-parent' && op.toId === 'rel-peer'));
    assert.ok(relations.some(op => op.relation === 'related' && op.fromId === 'rel-parent' && op.toId === 'rel-peer'));
    const shuffled = planDream({projectId: 'p', records: [peer, child, parent], conflictIds: ['rel-parent', 'rel-peer'], now: NOW});
    assert.equal(JSON.stringify(plan), JSON.stringify(shuffled));
  } finally { f.close(); }
});

test('planDream bounds operations with maxOps deterministically', () => {
  const records: DreamRecord[] = [];
  for (let index = 0; index < 5; index += 1) {
    for (const suffix of ['x', 'y']) {
      records.push({
        id: `bounded-${index}-${suffix}`, projectId: 'p', scope: 'project', kind: 'fact',
        subjectKey: `bounded.${index}`, title: `t${index}`, content: `claim ${index}`, conditions: [],
        status: 'active', enabled: true, revision: 1, trust: 'user_explicit', updatedAt: NOW,
        expiresAt: null, useCount: 0, lastUsedAt: null, feedbackScore: 0, sources: [],
      });
    }
  }
  const full = planDream({projectId: 'p', records, now: NOW});
  assert.equal(opsOf(full, 'merge').length, 5);
  const bounded = planDream({projectId: 'p', records, now: NOW, maxOps: 2});
  assert.equal(bounded.operations.length, 2);
  const boundedShuffled = planDream({projectId: 'p', records: [...records].reverse(), now: NOW, maxOps: 2});
  assert.equal(JSON.stringify(bounded), JSON.stringify(boundedShuffled));
  assert.notEqual(bounded.consolidationId, full.consolidationId);
});

test('planDream ignores records that are not active/enabled (candidates are never consolidated)', () => {
  const f = openDatabase();
  try {
    const plan = planDream({
      projectId: 'p', now: NOW,
      records: [
        {id: 'candidate-1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'only.candidate', title: 't', content: 'same', conditions: [], status: 'candidate', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'candidate-2', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'only.candidate', title: 't', content: 'same', conditions: [], status: 'candidate', enabled: true, revision: 1, updatedAt: NOW, sources: []},
        {id: 'disabled-1', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'only.disabled', title: 't', content: 'same', conditions: [], status: 'active', enabled: false, revision: 1, updatedAt: NOW, sources: []},
        {id: 'disabled-2', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'only.disabled', title: 't', content: 'same', conditions: [], status: 'active', enabled: false, revision: 1, updatedAt: NOW, sources: []},
      ],
    });
    assert.equal(plan.operations.length, 0);
    const archived = planDream({projectId: 'p', now: NOW, records: [
      {id: 'expired-candidate', projectId: 'p', scope: 'project', kind: 'fact', title: 't', content: 'x', conditions: [], status: 'candidate', enabled: true, revision: 1, updatedAt: NOW, expiresAt: daysAgo(1), sources: []},
    ]});
    assert.equal(archived.operations.length, 0, 'archive only retires active records');
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Proposal validation
// ---------------------------------------------------------------------------

test('validateDreamProposal drops malformed, unknown, missing-parent and unsourced splits', () => {
  const f = openDatabase();
  try {
    const record = seedRow(f.db, {id: 'split-parent', subjectKey: 'split.subject', content: 'Alpha beta gamma', sources: [source('s1', 'e1'), source('s2', 'e2')]});
    const plan = planDream({projectId: 'p', records: [record], now: NOW});
    const base = {kind: 'split', parentIds: [record.id]};
    const validParts = [
      {title: 'Alpha', content: 'Alpha', conditions: [], sourceIds: ['s1:e1']},
      {title: 'Beta', content: 'Beta', conditions: [], sourceIds: ['s2:e2']},
    ];
    const cases: unknown[] = [
      {...base, parts: []},
      {...base, parts: [validParts[0]]},
      {...base, parts: validParts.map(part => ({...part, sourceIds: []}))},
      {...base, parts: validParts, kind: 'delete'},
      {kind: 'split', parentIds: ['missing-record'], parts: validParts},
      {kind: 'split', parentIds: [record.id], parts: validParts.map(part => ({...part, title: ''}))},
      null,
      'split',
    ];
    for (const proposal of cases) {
      const validated = validateDreamProposal({plan, proposals: [proposal], records: [record]});
      assert.equal(opsOf(validated, 'split').length, 0, `proposal must be dropped: ${JSON.stringify(proposal)}`);
    }
    const accepted = validateDreamProposal({plan, proposals: [{...base, parts: validParts}], records: [record]});
    assert.equal(opsOf(accepted, 'split').length, 1);
    assert.equal(accepted.proposals.length, 1);
    assert.equal(accepted.proposals[0]!.origin, 'model');
    assert.match(accepted.consolidationId, UUID);
    assert.equal(accepted.consolidationId, validateDreamProposal({plan, proposals: [{...base, parts: validParts}], records: [record]}).consolidationId);
  } finally { f.close(); }
});

test('validateDreamProposal requires independent per-part sources for splits', () => {
  const f = openDatabase();
  try {
    const record = seedRow(f.db, {id: 'split-sources', subjectKey: 'split.sources', content: 'Alpha beta', sources: [source('s1', 'e1'), source('s2', 'e2')]});
    const plan = planDream({projectId: 'p', records: [record], now: NOW});
    const attempt = (sourceIds: string[][]) => validateDreamProposal({
      plan, records: [record],
      proposals: [{kind: 'split', parentIds: [record.id], parts: sourceIds.map((ids, index) => ({title: `Part ${index}`, content: `Part ${index}`, conditions: [], sourceIds: ids}))}],
    });
    assert.equal(opsOf(attempt([['s1:e1'], ['s1:e1']]), 'split').length, 0, 'two parts cannot share the only source');
    assert.equal(opsOf(attempt([['s1:e1'], ['s1:e1', 's2:e2']]), 'split').length, 0, 'the first part has no independent source');
    assert.equal(opsOf(attempt([['s1:e1'], ['s2:e2']]), 'split').length, 1);
    assert.equal(opsOf(attempt([['s1:e1'], ['unknown:source']]), 'split').length, 0, 'unknown source ids are rejected');
  } finally { f.close(); }
});

test('validateDreamProposal accepts a grounded, multi-source distill and drops unsourced ones', () => {
  const f = openDatabase();
  try {
    const e1 = seedRow(f.db, {id: 'ep-1', kind: 'episode', trust: 'model_supported', content: '部署失败需要回滚', sources: [source('s1', 'e1')]});
    const e2 = seedRow(f.db, {id: 'ep-2', kind: 'episode', trust: 'model_supported', content: '部署失败时先回滚再排查', sources: [source('s2', 'e2')]});
    const plan = planDream({projectId: 'p', records: [e1, e2], now: NOW});
    const grounded = validateDreamProposal({
      plan, records: [e1, e2],
      proposals: [{kind: 'distill', parentIds: ['ep-1', 'ep-2'], title: '部署失败先回滚', content: '部署失败需要先回滚'}],
    });
    assert.equal(opsOf(grounded, 'distill').length, 1);
    assert.equal(grounded.proposals[0]!.origin, 'model');

    const unrelated = validateDreamProposal({
      plan, records: [e1, e2],
      proposals: [{kind: 'distill', parentIds: ['ep-1', 'ep-2'], title: '无关', content: '今天天气晴朗适合散步'}],
    });
    assert.equal(opsOf(unrelated, 'distill').length, 0);

    const single = seedRow(f.db, {id: 'ep-3', kind: 'episode', trust: 'model_supported', content: '部署失败需要回滚', sources: [source('s9', 'e1')]});
    const single2 = seedRow(f.db, {id: 'ep-4', kind: 'episode', trust: 'model_supported', content: '部署失败时先回滚再排查', sources: [source('s9', 'e1')]});
    const singlePlan = planDream({projectId: 'p', records: [single, single2], now: NOW});
    const oneSource = validateDreamProposal({
      plan: singlePlan, records: [single, single2],
      proposals: [{kind: 'distill', parentIds: ['ep-3', 'ep-4'], title: '回滚', content: '部署失败先回滚'}],
    });
    assert.equal(opsOf(oneSource, 'distill').length, 0, 'a distill needs >=2 independent sources or a user confirmation');

    const unsourced = validateDreamProposal({
      plan: singlePlan, records: [single, single2],
      proposals: [{kind: 'distill', parentIds: ['ep-3', 'ep-4'], title: '回滚', content: '部署失败先回滚', sourceIds: ['nope:nope']}],
    });
    assert.equal(opsOf(unsourced, 'distill').length, 0);
  } finally { f.close(); }
});

test('validateDreamProposal only profiles user-confirmed parents', () => {
  const f = openDatabase();
  try {
    const u1 = seedRow(f.db, {id: 'user-1', kind: 'preference', scope: 'personal', trust: 'user_explicit', content: '偏好中文解释', sources: [source('s1', 'e1')]});
    const u2 = seedRow(f.db, {id: 'user-2', kind: 'preference', scope: 'personal', trust: 'user_confirmed', content: '偏好简洁回答', sources: [source('s2', 'e2')]});
    const model = seedRow(f.db, {id: 'model-1', kind: 'preference', scope: 'personal', trust: 'model_supported', content: '模型推断偏好', sources: [source('s3', 'e1')]});
    const plan = planDream({projectId: 'p', records: [u1, u2, model], now: NOW});
    const rejected = validateDreamProposal({plan, records: [u1, u2, model], proposals: [
      {kind: 'profile', parentIds: ['model-1', 'user-1'], content: '混合画像'},
    ]});
    assert.equal(opsOf(rejected, 'profile').length, 0);
    const accepted = validateDreamProposal({plan, records: [u1, u2, model], proposals: [
      {kind: 'profile', parentIds: ['user-2', 'user-1'], content: '用户偏好中文简洁回答'},
    ]});
    const profiles = opsOf(accepted, 'profile') as Extract<DreamOperation, {kind: 'profile'}>[];
    assert.equal(profiles.length, 1);
    assert.deepEqual(profiles[0]!.parentIds, ['user-1', 'user-2']);
    assert.equal(profiles[0]!.origin, 'model');
    assert.equal(accepted.proposals.length, 1);
    const again = validateDreamProposal({plan, records: [u1, u2, model], proposals: [
      {kind: 'profile', parentIds: ['user-1', 'user-2'], content: '用户偏好中文简洁回答'},
    ]});
    assert.equal(accepted.consolidationId, again.consolidationId);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

test('applyDreamPlan merge: active child, retired parents, lineage, audit and versions', () => {
  const f = openDatabase();
  try {
    const a = seedRow(f.db, {id: 'apply-a', subjectKey: 'language.response', title: '回答语言', content: 'Always answer in Chinese', conditions: ['project-alpha'], sources: [source('s1', 'e1')]});
    const b = seedRow(f.db, {id: 'apply-b', subjectKey: 'language.response', title: '回答语言', content: 'always answer in Chinese', conditions: ['project-alpha'], sources: [source('s2', 'e2')]});
    seedRow(f.db, {id: 'apply-c', subjectKey: 'language.response', content: 'Use bullet lists'});
    const plan = planDream({projectId: 'p', records: [a, b], now: NOW});
    const result = applyDreamPlan(f.db, {plan, now: () => NOW, digest: value => {
      // Same contract as core.digest; deterministic stand-in keeps ids stable in tests.
      return JSON.stringify(value);
    }});
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.consolidationId, plan.consolidationId);
    assert.equal(f.db.isTransaction, false);
    const childId = result.childIds[0]!;
    assert.match(childId, UUID);
    const child = recordRow(f.db, childId);
    assert.equal(child.status, 'active');
    assert.equal(Number(child.enabled), 1);
    assert.equal(Number(child.revision), 1);
    assert.equal(child.kind_v2, 'fact');
    assert.equal(child.trust, 'user_explicit');
    assert.equal(child.consolidation_id, plan.consolidationId);
    assert.equal(Number(child.auto_published), 0);
    const childJson = recordJson(f.db, childId);
    assert.deepEqual(childJson.parentIds, ['apply-a', 'apply-b']);
    assert.equal((childJson.sources as unknown[]).length, 2);
    assert.deepEqual(childJson.conditions, ['project-alpha']);
    assert.equal(childJson.consolidationId, plan.consolidationId);
    assert.equal(childJson.title, '回答语言');
    const merge = opsOf(plan, 'merge')[0] as Extract<DreamOperation, {kind: 'merge'}>;
    assert.equal(childJson.content, merge.content);

    for (const parentId of ['apply-a', 'apply-b']) {
      const parent = recordRow(f.db, parentId);
      assert.equal(parent.status, 'inactive');
      assert.equal(Number(parent.enabled), 0);
      assert.equal(Number(parent.revision), 2);
      assert.equal(parent.consolidation_id, plan.consolidationId);
      const json = recordJson(f.db, parentId);
      assert.match(String(json.invalidatedReason), /Dream 合并/);
      assert.equal(json.consolidationId, plan.consolidationId);
    }
    assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM memory_versions WHERE id=? AND revision=1', childId), 1);
    assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM memory_versions WHERE id=? AND revision=2', 'apply-a'), 1);
    assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM memory_versions WHERE id=? AND revision=2', 'apply-b'), 1);

    const rows = consolidations(f.db);
    assert.equal(rows.length, 1);
    const audit = rows[0]!;
    assert.equal(audit.id, plan.consolidationId);
    assert.equal(audit.status, 'applied');
    assert.equal(audit.actor, 'dream');
    assert.equal(audit.kind, 'merge');
    assert.equal(audit.applied_at, NOW);
    assert.ok(typeof audit.rollback_token === 'string' && (audit.rollback_token as string).length > 0);
    assert.deepEqual(JSON.parse(String(audit.parent_ids_json)), ['apply-a', 'apply-b']);
    assert.deepEqual(JSON.parse(String(audit.child_ids_json)), [childId]);
    const diff = JSON.parse(String(audit.diff_json)) as Record<string, unknown>;
    assert.equal(diff.ruleVersion, DREAM_RULE_VERSION);
    assert.equal((diff.applied as unknown[]).length, 1);
  } finally { f.close(); }
});

test('applyDreamPlan is idempotent: repeated apply creates no duplicates', () => {
  const f = openDatabase();
  try {
    const a = seedRow(f.db, {id: 'idem-a', subjectKey: 'idem.subject', content: 'Same claim'});
    const b = seedRow(f.db, {id: 'idem-b', subjectKey: 'idem.subject', content: 'same  claim'});
    const child = seedRow(f.db, {id: 'idem-child', subjectKey: 'idem.other', content: 'Derived note', parentIds: ['idem-a']});
    const plan = planDream({projectId: 'p', records: [a, b, child], now: NOW});
    assert.ok(opsOf(plan, 'merge').length >= 1);
    assert.equal(opsOf(plan, 'relation').length, 1);
    const first = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(first.applied.length, 2);
    const relationRows = relations(f.db).length;
    const parentRevision = Number(recordRow(f.db, 'idem-a').revision);
    const second = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(second.applied.length, 0);
    assert.equal(second.skipped.length, plan.operations.length);
    assert.ok(second.skipped.every(item => item.reason === 'already-applied'));
    assert.equal(consolidations(f.db).length, 1);
    assert.equal(relations(f.db).length, relationRows);
    assert.equal(Number(recordRow(f.db, 'idem-a').revision), parentRevision);
    const relation = relations(f.db)[0]!;
    assert.equal(relation.kind, 'derived-from');
    assert.equal(Number(relation.weight), 1);
    const relationJson = JSON.parse(String(relation.json)) as Record<string, unknown>;
    assert.equal(relationJson.consolidationId, plan.consolidationId);
  } finally { f.close(); }
});

test('applyDreamPlan archive + relation, then rollback restores parents and is idempotent', () => {
  const f = openDatabase();
  try {
    const expired = seedRow(f.db, {id: 'rb-expired', subjectKey: 'old.thing', content: 'Obsolete', expiresAt: daysAgo(2)});
    const parent = seedRow(f.db, {id: 'rb-parent', subjectKey: 'rb.subject', content: 'Parent value'});
    const child = seedRow(f.db, {id: 'rb-child', subjectKey: 'rb.child', content: 'Child value', parentIds: ['rb-parent']});
    const plan = planDream({projectId: 'p', records: [expired, parent, child], now: NOW});
    assert.equal(opsOf(plan, 'archive').length, 1);
    assert.equal(opsOf(plan, 'relation').length, 1);
    const result = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(result.applied.length, 2);
    assert.equal(recordRow(f.db, 'rb-expired').status, 'inactive');
    assert.match(String(recordJson(f.db, 'rb-expired').invalidatedReason), /Dream 归档/);
    assert.equal(relations(f.db).length, 1);
    assert.equal(recordRow(f.db, 'rb-parent').status, 'active');

    const rollback = rollbackConsolidation(f.db, {consolidationId: plan.consolidationId, projectId: 'p', now: () => NOW});
    assert.deepEqual(rollback.restored, ['rb-expired']);
    assert.deepEqual(rollback.revoked, []);
    const restored = recordRow(f.db, 'rb-expired');
    assert.equal(restored.status, 'active');
    assert.equal(Number(restored.enabled), 1);
    assert.equal(Number(restored.revision), 3);
    assert.equal(recordJson(f.db, 'rb-expired').invalidatedReason, undefined);
    assert.equal(restored.consolidation_id, null);
    assert.equal(relations(f.db).length, 0);
    const audit = consolidations(f.db)[0]!;
    assert.equal(audit.status, 'rolled_back');
    assert.equal(audit.rolled_back_at, NOW);

    const again = rollbackConsolidation(f.db, {consolidationId: plan.consolidationId, projectId: 'p', now: () => NOW});
    assert.deepEqual(again, {restored: [], revoked: []});
    assert.equal(Number(recordRow(f.db, 'rb-expired').revision), 3);
    const reapply = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(reapply.applied.length, 0);
    assert.equal(consolidations(f.db).length, 1);
    assert.throws(
      () => rollbackConsolidation(f.db, {consolidationId: plan.consolidationId, projectId: 'other-project', now: () => NOW}),
      (error: unknown) => (error as {code?: string}).code === 'PERMISSION_DENIED',
    );
    assert.deepEqual(rollbackConsolidation(f.db, {consolidationId: 'unknown', projectId: 'p', now: () => NOW}), {restored: [], revoked: []});
  } finally { f.close(); }
});

test('applyDreamPlan split: model children stay candidates, user-confirmed children become active', () => {
  const f = openDatabase();
  try {
    const modelParent = seedRow(f.db, {id: 'split-model-parent', content: 'Alpha beta', sources: [source('s1', 'e1'), source('s2', 'e2')]});
    const modelPlan: DreamPlan = {
      consolidationId: 'split-model-plan',
      projectId: 'p',
      proposals: [],
      operations: [{kind: 'split', parentId: modelParent.id, origin: 'model', parts: [
        {title: 'Alpha', content: 'Alpha', conditions: [], sourceIds: ['s1:e1']},
        {title: 'Beta', content: 'Beta', conditions: [], sourceIds: ['s2:e2']},
      ]}],
    };
    const modelResult = applyDreamPlan(f.db, {plan: modelPlan, now: () => NOW});
    assert.equal(modelResult.applied.length, 1);
    assert.equal(modelResult.childIds.length, 2);
    assert.deepEqual(modelResult.parentIds, [], 'model split only proposes candidates; the active parent stays usable');
    assert.equal(recordRow(f.db, modelParent.id).status, 'active', 'model-proposed split must not remove effective memory');
    for (const childId of modelResult.childIds) {
      const row = recordRow(f.db, childId);
      assert.equal(row.status, 'candidate', 'model-proposed split children never become active');
      assert.equal(Number(row.enabled), 1);
      const json = recordJson(f.db, childId);
      assert.deepEqual(json.parentIds, [modelParent.id]);
      assert.equal((json.sources as unknown[]).length, 1);
      assert.equal(json.consolidationId, modelPlan.consolidationId);
    }

    const userParent = seedRow(f.db, {id: 'split-user-parent', content: 'Gamma delta', trust: 'user_explicit', sources: [source('s3', 'e3'), source('s4', 'e4')]});
    const userPlan: DreamPlan = {
      consolidationId: 'split-user-plan',
      projectId: 'p',
      proposals: [],
      operations: [{kind: 'split', parentId: userParent.id, origin: 'user', parts: [
        {title: 'Gamma', content: 'Gamma', conditions: [], sourceIds: ['s3:e3']},
        {title: 'Delta', content: 'Delta', conditions: [], sourceIds: ['s4:e4']},
      ]}],
    };
    const userResult = applyDreamPlan(f.db, {plan: userPlan, now: () => NOW});
    assert.equal(userResult.childIds.length, 2);
    for (const childId of userResult.childIds) {
      const row = recordRow(f.db, childId);
      assert.equal(row.status, 'active');
      assert.ok(['user_explicit', 'user_confirmed'].includes(String(row.trust)), 'active split child keeps user authority');
      assert.equal(recordJson(f.db, childId).confirmedBy, 'user');
    }
  } finally { f.close(); }
});

test('applyDreamPlan distill keeps parents active; profile only aggregates user-confirmed parents', () => {
  const f = openDatabase();
  try {
    const e1 = seedRow(f.db, {id: 'distill-e1', kind: 'episode', trust: 'model_supported', content: '部署失败需要回滚', sources: [source('s1', 'e1')]});
    const e2 = seedRow(f.db, {id: 'distill-e2', kind: 'episode', trust: 'model_supported', content: '部署失败时先回滚再排查', sources: [source('s2', 'e2')]});
    const distillPlan: DreamPlan = {
      consolidationId: 'distill-plan',
      projectId: 'p',
      proposals: [],
      operations: [{kind: 'distill', parentIds: ['distill-e2', 'distill-e1'], title: '部署失败先回滚', content: '部署失败需要先回滚', conditions: []}],
    };
    const distillResult = applyDreamPlan(f.db, {plan: distillPlan, now: () => NOW});
    assert.equal(distillResult.applied.length, 1);
    const distilledId = distillResult.childIds[0]!;
    const distilled = recordRow(f.db, distilledId);
    assert.equal(distilled.status, 'candidate');
    assert.equal(distilled.kind_v2, 'experience');
    assert.equal(recordRow(f.db, 'distill-e1').status, 'active', 'distill parents stay active');
    assert.equal(Number(recordRow(f.db, 'distill-e1').revision), 1);
    assert.deepEqual(recordJson(f.db, distilledId).parentIds, ['distill-e1', 'distill-e2']);

    const u1 = seedRow(f.db, {id: 'prof-u1', kind: 'preference', scope: 'personal', trust: 'user_explicit', content: '偏好中文解释', sources: [source('s3', 'e3')]});
    const u2 = seedRow(f.db, {id: 'prof-u2', kind: 'preference', scope: 'personal', trust: 'user_confirmed', content: '偏好简洁回答', sources: [source('s4', 'e4')]});
    const profilePlan: DreamPlan = {
      consolidationId: 'profile-plan',
      projectId: 'p',
      proposals: [],
      operations: [{kind: 'profile', parentIds: [u2.id, u1.id], content: '用户偏好中文简洁回答', conditions: []}],
    };
    const profileResult = applyDreamPlan(f.db, {plan: profilePlan, now: () => NOW});
    assert.equal(profileResult.applied.length, 1);
    const profile = recordRow(f.db, profileResult.childIds[0]!);
    assert.equal(profile.status, 'active');
    assert.equal(profile.kind_v2, 'profile');
    assert.equal(profile.trust, 'user_confirmed');
    assert.equal(profile.scope, 'personal');
    assert.equal(recordRow(f.db, 'prof-u1').status, 'inactive');
    assert.equal(recordRow(f.db, 'prof-u2').status, 'inactive');

    const modelOnly = seedRow(f.db, {id: 'prof-model', kind: 'preference', scope: 'personal', trust: 'model_supported', content: '模型推断', sources: [source('s5', 'e5')]});
    const invalidPlan: DreamPlan = {
      consolidationId: 'profile-invalid-plan',
      projectId: 'p',
      proposals: [],
      operations: [{kind: 'profile', parentIds: [modelOnly.id], content: '不该生效', conditions: []}],
    };
    const invalidResult = applyDreamPlan(f.db, {plan: invalidPlan, now: () => NOW});
    assert.equal(invalidResult.applied.length, 0);
    assert.deepEqual(invalidResult.skipped.map(item => item.reason), ['profile-requires-user-confirmed-parent']);
    assert.equal(recordRow(f.db, modelOnly.id).status, 'active');
    assert.equal(consolidations(f.db).filter(row => row.id === 'profile-invalid-plan').length, 0);
  } finally { f.close(); }
});

test('applyDreamPlan is atomic on failure and nested-safe inside an outer transaction', () => {
  const f = openDatabase();
  try {
    const a = seedRow(f.db, {id: 'atomic-a', subjectKey: 'atomic.subject', content: 'Same claim'});
    const b = seedRow(f.db, {id: 'atomic-b', subjectKey: 'atomic.subject', content: 'same claim'});
    const plan = planDream({projectId: 'p', records: [a, b], now: NOW});
    let calls = 0;
    const flakyNow = () => {
      calls += 1;
      if (calls === 2) throw new Error('now exploded');
      return NOW;
    };
    assert.throws(() => applyDreamPlan(f.db, {plan, now: flakyNow}), /now exploded/);
    assert.equal(f.db.isTransaction, false, 'failed apply must not leave a transaction open');
    assert.equal(recordRow(f.db, 'atomic-a').status, 'active');
    assert.equal(recordRow(f.db, 'atomic-b').status, 'active');
    assert.equal(count(f.db, 'SELECT COUNT(*) AS n FROM memory_records'), 2);
    assert.equal(consolidations(f.db).length, 0);
    const retried = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(retried.applied.length, 1);

    // Nested-safe: an outer transaction owns commit/rollback.
    const nested = openDatabase();
    try {
      const c = seedRow(nested.db, {id: 'nested-a', subjectKey: 'nested.subject', content: 'Same claim'});
      const d = seedRow(nested.db, {id: 'nested-b', subjectKey: 'nested.subject', content: 'same claim'});
      const nestedPlan = planDream({projectId: 'p', records: [c, d], now: NOW});
      nested.db.exec('BEGIN IMMEDIATE');
      const nestedResult = applyDreamPlan(nested.db, {plan: nestedPlan, now: () => NOW});
      assert.equal(nestedResult.applied.length, 1);
      assert.equal(nested.db.isTransaction, true, 'nested apply must not commit the caller transaction');
      nested.db.exec('ROLLBACK');
      assert.equal(recordRow(nested.db, 'nested-a').status, 'active');
      assert.equal(count(nested.db, 'SELECT COUNT(*) AS n FROM memory_records'), 2);
      assert.equal(consolidations(nested.db).length, 0);
    } finally { nested.close(); }
  } finally { f.close(); }
});

test('applyDreamPlan/rollbackConsolidation work on a minimal pre-migration DDL', () => {
  const f = openDatabase(true);
  try {
    const a = seedRow(f.db, {id: 'min-a', subjectKey: 'min.subject', content: 'Same claim'});
    const b = seedRow(f.db, {id: 'min-b', subjectKey: 'min.subject', content: 'same claim'});
    const plan = planDream({projectId: 'p', records: [a, b], now: NOW});
    assert.match(plan.consolidationId, UUID);
    const result = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(result.applied.length, 1);
    const childId = result.childIds[0]!;
    assert.equal(recordRow(f.db, childId).status, 'active');
    assert.deepEqual(recordJson(f.db, childId).parentIds, ['min-a', 'min-b']);
    assert.equal(recordRow(f.db, 'min-a').status, 'inactive');
    const rollback = rollbackConsolidation(f.db, {consolidationId: plan.consolidationId, projectId: 'p', now: () => NOW});
    assert.deepEqual(rollback.restored, ['min-a', 'min-b']);
    assert.deepEqual(rollback.revoked, [childId]);
    assert.equal(recordRow(f.db, 'min-a').status, 'active');
    assert.equal(recordRow(f.db, childId).status, 'inactive');
  } finally { f.close(); }
});

test('planDream compares conditions as a set, not by array order', () => {
  const f = openDatabase();
  try {
    const first = seedRow(f.db, {id: 'cond-a', subjectKey: 'cond.subject', content: 'Same claim', conditions: ['alpha', 'beta']});
    const second = seedRow(f.db, {id: 'cond-b', subjectKey: 'cond.subject', content: 'same claim', conditions: ['beta', 'alpha']});
    const plan = planDream({projectId: 'p', records: [first, second], now: NOW});
    const merges = opsOf(plan, 'merge') as Extract<DreamOperation, {kind: 'merge'}>[];
    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0]!.parentIds, ['cond-a', 'cond-b']);
    assert.deepEqual(merges[0]!.conditions, ['alpha', 'beta']);
    const reversedConditions = planDream({projectId: 'p', now: NOW, records: [
      {...first, conditions: ['beta', 'alpha']},
      {...second, conditions: ['alpha', 'beta']},
    ]});
    assert.equal(plan.consolidationId, reversedConditions.consolidationId);
  } finally { f.close(); }
});

test('applyDreamPlan merge unions parent sources and evidence without duplicates', () => {
  const f = openDatabase();
  try {
    const shared = {sessionId: 's1', entryId: 'e1', start: 0, end: 4, hash: 'h1'};
    const evidenceA = {evidenceId: 'ev-a', kind: 'pi', source: shared};
    const evidenceB = {evidenceId: 'ev-b', kind: 'pi', source: {sessionId: 's2', entryId: 'e2', start: 0, end: 4, hash: 'h2'}};
    const a = seedRow(f.db, {id: 'union-a', subjectKey: 'union.subject', content: 'Same claim', sources: [shared], evidence: [evidenceA]});
    const b = seedRow(f.db, {id: 'union-b', subjectKey: 'union.subject', content: 'same claim', sources: [shared, {sessionId: 's2', entryId: 'e2', start: 0, end: 4, hash: 'h2'}], evidence: [evidenceA, evidenceB]});
    const plan = planDream({projectId: 'p', records: [a, b], now: NOW});
    const result = applyDreamPlan(f.db, {plan, now: () => NOW});
    assert.equal(result.applied.length, 1);
    const child = recordJson(f.db, result.childIds[0]!);
    assert.equal((child.sources as unknown[]).length, 2, 'identical source objects are unioned once');
    assert.equal((child.evidence as unknown[]).length, 2, 'evidence is unioned across parents');
    assert.deepEqual((child.parentIds as string[]), ['union-a', 'union-b']);
    assert.equal(typeof child.hash, 'string');
    assert.equal(typeof child.semanticDigest, 'undefined');
  } finally { f.close(); }
});

test('derived record ids, audit and rollback tokens are deterministic across databases', () => {
  const left = openDatabase(), right = openDatabase();
  try {
    for (const f of [left, right]) {
      seedRow(f.db, {id: 'det-a', subjectKey: 'det.subject', content: 'Same claim'});
      seedRow(f.db, {id: 'det-b', subjectKey: 'det.subject', content: 'same claim'});
    }
    const records: DreamRecord[] = [
      {id: 'det-a', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'det.subject', title: 't', content: 'Same claim', conditions: [], status: 'active', enabled: true, revision: 1, trust: 'user_explicit', updatedAt: NOW, sources: []},
      {id: 'det-b', projectId: 'p', scope: 'project', kind: 'fact', subjectKey: 'det.subject', title: 't', content: 'same claim', conditions: [], status: 'active', enabled: true, revision: 1, trust: 'user_explicit', updatedAt: NOW, sources: []},
    ];
    const plan = planDream({projectId: 'p', records, now: NOW});
    const l = applyDreamPlan(left.db, {plan, now: () => NOW});
    const r = applyDreamPlan(right.db, {plan, now: () => NOW});
    assert.deepEqual(l.childIds, r.childIds);
    assert.match(l.childIds[0]!, UUID);
    assert.deepEqual(recordJson(left.db, l.childIds[0]!), recordJson(right.db, r.childIds[0]!));
    assert.equal(consolidations(left.db)[0]!.rollback_token, consolidations(right.db)[0]!.rollback_token);
  } finally { left.close(); right.close(); }
});
