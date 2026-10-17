import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CapabilityError, ConflictError, RecordStore, digest, type HistoryItem, type PluginContext } from '../../core/src/index.js';
import { MemoryController, peekLearningJob, type MemoryRecord } from '../src/index.js';
import {
  AUTO_DOWNGRADE_THRESHOLD, AutoPublishStore, DEFAULT_MAX_AUTO_PER_DAY, MODE_ALLOWED_TRUST, MODE_THRESHOLDS,
  decideAutoPublish, evaluateGates, isValidAutoPublishSubjectKey, scoreCandidate,
  type AuditInput, type AuditRow, type AutoPublishMode, type AutoPublishPolicy, type CandidateFacts, type GateResult, type TrustLevel,
} from '../src/autopublish.js';

// Verbatim P0-SPEC §2.4 DDL for the two tables this module owns, plus the two
// indexes. In production `ensureMemorySchema` (schema v4) creates them; tests
// create the same DDL on the shared RecordStore connection (`documents` already
// exists so rolling stats work).
const SCHEMA_DDL = `
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
`;

const PROJECT = 'project-a';
const NOW = '2026-10-17T12:00:00.000Z';

function makeDb(options: { now?: () => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-autopublish-'));
  const store = new RecordStore('memory', dir);
  store.db.exec(SCHEMA_DDL);
  const ap = new AutoPublishStore(store.db, options);
  return {
    dir, store, db: store.db, ap,
    cleanup: () => { store.close(); rmSync(dir, {recursive: true, force: true}); },
  };
}

function clock(start = NOW) {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms: number) => { current += ms; },
    current: () => current,
  };
}

function baseFacts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    kind: 'fact', trust: 'user_explicit', authority: 'user',
    quoteVerbatim: true, quoteUnique: true, conditionsComplete: true,
    subjectKey: 'project.db.engine', subjectCardinality: 'single', subjectConflict: false, correctionEvidence: false,
    secretFree: true, piiFree: true, promptInjectionFree: true, crossProjectLeak: false,
    novelty: 'new', independentSources: 2, independentProjects: 2,
    userPolicyEnabled: true, autoPublishedToday: 0, runtimeHealthy: true,
    ...overrides,
  };
}

function policy(overrides: Partial<AutoPublishPolicy> = {}): AutoPublishPolicy {
  return {
    id: `autopublish:${PROJECT}`, projectId: PROJECT, mode: 'standard', minScore: MODE_THRESHOLDS.standard,
    maxAutoPerDay: DEFAULT_MAX_AUTO_PER_DAY, requireReview: false, version: 1, updatedAt: NOW,
    ...overrides,
  };
}

const AGGRESSIVE: {mode: AutoPublishMode; minScore: number} = {mode: 'aggressive', minScore: 55};
const STANDARD_ISOLATED: {mode: AutoPublishMode; minScore: number} = {mode: 'standard', minScore: 55};

function gatesOf(facts: CandidateFacts, context: {mode: AutoPublishMode; minScore: number; maxAutoPerDay?: number} = AGGRESSIVE): GateResult[] {
  return evaluateGates(facts, context);
}

function gateOf(facts: CandidateFacts, id: number, context: {mode: AutoPublishMode; minScore: number; maxAutoPerDay?: number} = AGGRESSIVE): GateResult {
  const found = gatesOf(facts, context).find(item => item.id === id);
  assert.ok(found, `gate ${id} missing`);
  return found;
}

function failedGateIds(facts: CandidateFacts, context: {mode: AutoPublishMode; minScore: number; maxAutoPerDay?: number} = AGGRESSIVE): number[] {
  return gatesOf(facts, context).filter(item => !item.pass).map(item => item.id);
}

function validationError(run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof CapabilityError && error.code === 'VALIDATION_ERROR');
}

function auditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    projectId: PROJECT, memoryId: 'memory-1', revision: 1, action: 'publish', mode: 'standard',
    policyId: `autopublish:${PROJECT}`, policyVersion: 1, actor: 'system',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scoring (blueprint §7.3)
// ---------------------------------------------------------------------------

test('scoring: authority dimension follows the trust ladder (40/35/35/30/10/10/0/0)', () => {
  const expected: Record<TrustLevel, number> = {
    user_explicit: 40, user_confirmed: 35, source_verified: 35, tool_verified: 30,
    quote_verified: 10, model_supported: 10, model_inferred: 0, external_import: 0,
  };
  for (const [trust, points] of Object.entries(expected) as [TrustLevel, number][]) {
    assert.equal(scoreCandidate(baseFacts({trust})).authority, points, `authority for ${trust}`);
  }
});

test('scoring: quote dimension is 20 for verbatim+unique+complete, 10 partial, 0 none', () => {
  assert.equal(scoreCandidate(baseFacts()).quote, 20);
  assert.equal(scoreCandidate(baseFacts({quoteVerbatim: false})).quote, 10);
  assert.equal(scoreCandidate(baseFacts({quoteUnique: false})).quote, 10);
  assert.equal(scoreCandidate(baseFacts({conditionsComplete: false})).quote, 10);
  assert.equal(scoreCandidate(baseFacts({quoteVerbatim: false, quoteUnique: false, conditionsComplete: false})).quote, 0);
});

test('scoring: subject dimension is 20 normalized/unique, 10 absent, 0 conflict or malformed', () => {
  assert.equal(scoreCandidate(baseFacts()).subject, 20);
  assert.equal(scoreCandidate(baseFacts({subjectKey: null})).subject, 10);
  assert.equal(scoreCandidate(baseFacts({subjectKey: undefined})).subject, 10);
  assert.equal(scoreCandidate(baseFacts({subjectConflict: true})).subject, 0);
  assert.equal(scoreCandidate(baseFacts({subjectKey: 'Project DB Engine'})).subject, 0);
});

test('scoring: independence 10/5/0, novelty 10/0, total is the component sum', () => {
  assert.equal(scoreCandidate(baseFacts({independentSources: 2, independentProjects: 0})).independence, 10);
  assert.equal(scoreCandidate(baseFacts({independentSources: 0, independentProjects: 2})).independence, 10);
  assert.equal(scoreCandidate(baseFacts({independentSources: 1, independentProjects: 0})).independence, 5);
  assert.equal(scoreCandidate(baseFacts({independentSources: 0, independentProjects: 1})).independence, 5);
  assert.equal(scoreCandidate(baseFacts({independentSources: 0, independentProjects: 0})).independence, 0);
  assert.equal(scoreCandidate(baseFacts({novelty: 'new'})).novelty, 10);
  assert.equal(scoreCandidate(baseFacts({novelty: 'duplicate'})).novelty, 0);
  assert.equal(scoreCandidate(baseFacts({novelty: 'merge'})).novelty, 0);
  const breakdown = scoreCandidate(baseFacts({trust: 'user_confirmed', independentSources: 1, independentProjects: 0}));
  assert.deepEqual(breakdown, {authority: 35, quote: 20, subject: 20, independence: 5, novelty: 10, total: 90});
  assert.equal(scoreCandidate(baseFacts()).total, 100);
  assert.ok(MODE_THRESHOLDS.conservative === 90 && MODE_THRESHOLDS.standard === 70 && MODE_THRESHOLDS.aggressive === 55);
});

// ---------------------------------------------------------------------------
// The ten gates: fixed IDs, one positive and one negative assertion each
// ---------------------------------------------------------------------------

test('gates: IDs 1..10 are fixed, ordered, named and all pass for an ideal candidate', () => {
  const gates = gatesOf(baseFacts());
  assert.deepEqual(gates.map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(gates.map(item => item.name)).size, 10);
  assert.deepEqual(gates.filter(item => !item.pass), []);
  // ID list is independent of mode/minScore ordering.
  assert.deepEqual(gatesOf(baseFacts(), {mode: 'conservative', minScore: 90}).map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  validationError(() => gatesOf(baseFacts(), {mode: 'wild' as never, minScore: 70}));
  validationError(() => gatesOf(baseFacts(), {mode: 'standard', minScore: 101}));
});

test('gate 1 authority: user/source/tool and quote-verified pass; inference/import/self-assessment fail', () => {
  assert.equal(gateOf(baseFacts({trust: 'user_explicit', authority: 'user'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'user_confirmed', authority: 'user'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'source_verified', authority: 'source'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'tool_verified', authority: 'tool'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'quote_verified', authority: 'model'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'model_supported', authority: 'model'}), 1).pass, true);
  assert.equal(gateOf(baseFacts({trust: 'model_supported', authority: 'model', quoteVerbatim: false}), 1).pass, false);
  assert.equal(gateOf(baseFacts({trust: 'model_inferred', authority: 'model'}), 1).pass, false);
  assert.equal(gateOf(baseFacts({trust: 'external_import', authority: 'external'}), 1).pass, false);
});

test('gate 2 quote: verbatim, unique and complete conditions are all required', () => {
  assert.equal(gateOf(baseFacts(), 2).pass, true);
  assert.equal(gateOf(baseFacts({quoteVerbatim: false}), 2).pass, false);
  assert.equal(gateOf(baseFacts({quoteUnique: false}), 2).pass, false);
  assert.equal(gateOf(baseFacts({conditionsComplete: false}), 2).pass, false);
  // Score still records a partial quote (gate 6 stays passing for this facts set).
  assert.equal(gateOf(baseFacts({conditionsComplete: false}), 6).pass, true);
});

test('gate 3 subject: absent subject allowed, malformed key fails, single conflict needs correction evidence', () => {
  assert.equal(gateOf(baseFacts(), 3).pass, true);
  // P0-SPEC §4.1 does not require a subject: it scores 10 and stays publishable.
  for (const kind of ['fact', 'preference', 'profile', 'experience', 'knowledge']) {
    assert.equal(gateOf(baseFacts({kind, subjectKey: null}), 3).pass, true, `${kind} without subject`);
  }
  assert.equal(gateOf(baseFacts({kind: 'fact', subjectKey: 'Project DB Engine'}), 3).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'experience', subjectKey: 'Bad Key'}), 3).pass, false);
  assert.equal(gateOf(baseFacts({subjectConflict: true, subjectCardinality: 'single', correctionEvidence: false}), 3).pass, false);
  assert.equal(gateOf(baseFacts({subjectConflict: true, subjectCardinality: 'single', correctionEvidence: true}), 3).pass, true);
  assert.equal(gateOf(baseFacts({subjectConflict: true, subjectCardinality: 'multi', correctionEvidence: false}), 3).pass, true);
  assert.equal(gateOf(baseFacts({subjectConflict: true, subjectCardinality: null, correctionEvidence: false}), 3).pass, false);
  assert.equal(isValidAutoPublishSubjectKey('project-rule.abc123'), true);
  assert.equal(isValidAutoPublishSubjectKey('project..db'), false);
  // A subject-less, fully verified fact therefore reaches active in standard mode.
  const decision = decideAutoPublish(baseFacts({subjectKey: null}), policy());
  assert.equal(decision.status, 'active');
  assert.equal(decision.breakdown.subject, 10);
});

test('gate 4 safety: any secret/PII/injection/cross-project leak fails and marks the decision rejected', () => {
  assert.equal(gateOf(baseFacts(), 4).pass, true);
  for (const overrides of [{secretFree: false}, {piiFree: false}, {promptInjectionFree: false}, {crossProjectLeak: true}]) {
    const facts = baseFacts(overrides);
    assert.equal(gateOf(facts, 4).pass, false, JSON.stringify(overrides));
    const decision = decideAutoPublish(facts, policy());
    assert.equal(decision.status, 'candidate');
    assert.equal(decision.rejected, true);
  }
  // Non-safety failures are candidates but must not be marked rejected (no data loss).
  const duplicate = decideAutoPublish(baseFacts({novelty: 'duplicate'}), policy());
  assert.equal(duplicate.status, 'candidate');
  assert.equal(duplicate.rejected, false);
  assert.match(duplicate.reason ?? '', /#7/);
});

test('gate 5 type: standard blocks model-sourced profile/preference, aggressive needs two independent observations', () => {
  assert.equal(gateOf(baseFacts({kind: 'fact', trust: 'model_supported', authority: 'model'}), 5, STANDARD_ISOLATED).pass, true);
  assert.equal(gateOf(baseFacts({kind: 'experience', trust: 'model_supported', authority: 'model'}), 5, STANDARD_ISOLATED).pass, true);
  assert.equal(gateOf(baseFacts({kind: 'preference', trust: 'model_supported', authority: 'model'}), 5, STANDARD_ISOLATED).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'profile', trust: 'model_supported', authority: 'model'}), 5, STANDARD_ISOLATED).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'profile', trust: 'model_supported', authority: 'model', independentSources: 2}), 5, AGGRESSIVE).pass, true);
  assert.equal(gateOf(baseFacts({kind: 'profile', trust: 'model_supported', authority: 'model', independentSources: 1, independentProjects: 0}), 5, AGGRESSIVE).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'method'}), 5).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'not-a-kind'}), 5).pass, false);
});

test('gate 6 confidence: score >= minScore passes, one point below fails (only gate 6 fails)', () => {
  const facts = baseFacts({trust: 'user_confirmed', authority: 'user'}); // 95
  assert.equal(gateOf(facts, 6, {mode: 'standard', minScore: 95}).pass, true);
  assert.equal(gateOf(facts, 6, {mode: 'standard', minScore: 96}).pass, false);
  assert.deepEqual(failedGateIds(facts, {mode: 'standard', minScore: 96, maxAutoPerDay: 100}), [6]);
  const below = decideAutoPublish(facts, policy({minScore: 96}));
  assert.equal(below.status, 'candidate');
  assert.match(below.reason ?? '', /#6/);
});

test('gate 7 novelty: new passes, duplicate/merge only merge evidence', () => {
  assert.equal(gateOf(baseFacts({novelty: 'new'}), 7).pass, true);
  assert.equal(gateOf(baseFacts({novelty: 'duplicate'}), 7).pass, false);
  assert.equal(gateOf(baseFacts({novelty: 'merge'}), 7).pass, false);
});

test('gate 8 user policy: disabled policy or exhausted daily quota blocks auto publish', () => {
  assert.equal(gateOf(baseFacts(), 8).pass, true);
  assert.equal(gateOf(baseFacts({userPolicyEnabled: false}), 8).pass, false);
  assert.equal(gateOf(baseFacts({autoPublishedToday: 99}), 8, {mode: 'standard', minScore: 70, maxAutoPerDay: 100}).pass, true);
  assert.equal(gateOf(baseFacts({autoPublishedToday: 100}), 8, {mode: 'standard', minScore: 70, maxAutoPerDay: 100}).pass, false);
  assert.equal(gateOf(baseFacts({autoPublishedToday: 0}), 8, {mode: 'standard', minScore: 70, maxAutoPerDay: 0}).pass, false);
  assert.equal(gateOf(baseFacts({autoPublishedToday: 2}), 8, {mode: 'standard', minScore: 70, maxAutoPerDay: 3}).pass, true);
});

test('gate 9 cross-project: knowledge needs explicit promotion or two independent projects', () => {
  assert.equal(gateOf(baseFacts({kind: 'knowledge', trust: 'source_verified', authority: 'source', independentProjects: 1}), 9).pass, false);
  assert.equal(gateOf(baseFacts({kind: 'knowledge', trust: 'source_verified', authority: 'source', independentProjects: 2}), 9).pass, true);
  assert.equal(gateOf(baseFacts({kind: 'knowledge', trust: 'user_explicit', independentProjects: 0}), 9).pass, true);
  assert.equal(gateOf(baseFacts({kind: 'fact', trust: 'source_verified', authority: 'source', independentProjects: 0}), 9).pass, true);
});

test('gate 10 runtime: unhealthy runtime can only be retried, never auto published', () => {
  assert.equal(gateOf(baseFacts(), 10).pass, true);
  assert.equal(gateOf(baseFacts({runtimeHealthy: false}), 10).pass, false);
  const decision = decideAutoPublish(baseFacts({runtimeHealthy: false}), policy());
  assert.equal(decision.status, 'candidate');
  assert.match(decision.reason ?? '', /#10/);
});

// ---------------------------------------------------------------------------
// Decisions across modes / thresholds / policy switches
// ---------------------------------------------------------------------------

test('decision: mode off returns every candidate even for an ideal proposal', () => {
  const offPolicy = policy({mode: 'off', minScore: 90});
  for (const trust of ['user_explicit', 'user_confirmed', 'source_verified', 'model_supported'] as TrustLevel[]) {
    const decision = decideAutoPublish(baseFacts({trust}), offPolicy);
    assert.equal(decision.status, 'candidate', trust);
    assert.equal(decision.rejected, false);
    assert.equal(decision.policy.mode, 'off');
    assert.match(decision.reason ?? '', /off/);
  }
  assert.equal(MODE_ALLOWED_TRUST.off.length, 0);
  // MODE_THRESHOLDS.off is +Infinity: an off policy must still decide cleanly.
  const infinite = decideAutoPublish(baseFacts(), policy({mode: 'off', minScore: MODE_THRESHOLDS.off}));
  assert.equal(infinite.status, 'candidate');
  assert.equal(infinite.gates.length, 10);
  assert.equal(MODE_THRESHOLDS.off, Number.POSITIVE_INFINITY);
});

test('decision: conservative 90 / standard 70 / aggressive 55 produce different outcomes for score 85', () => {
  const facts = baseFacts({trust: 'user_confirmed', independentSources: 0, independentProjects: 0}); // 85
  assert.equal(scoreCandidate(facts).total, 85);
  const conservative = decideAutoPublish(facts, policy({mode: 'conservative', minScore: MODE_THRESHOLDS.conservative}));
  const standard = decideAutoPublish(facts, policy({mode: 'standard', minScore: MODE_THRESHOLDS.standard}));
  const aggressive = decideAutoPublish(facts, policy({mode: 'aggressive', minScore: MODE_THRESHOLDS.aggressive}));
  assert.equal(conservative.status, 'candidate');
  assert.match(conservative.reason ?? '', /#6/);
  assert.equal(standard.status, 'active');
  assert.equal(aggressive.status, 'active');
  assert.equal(standard.score, 85);
  assert.equal(aggressive.rejected, false);
});

test('decision: conservative only allows user_explicit/user_confirmed even when every gate passes', () => {
  const facts = baseFacts({trust: 'source_verified', authority: 'source'}); // 95
  const conservative = decideAutoPublish(facts, policy({mode: 'conservative', minScore: MODE_THRESHOLDS.conservative}));
  assert.equal(conservative.gates.filter(item => !item.pass).length, 0);
  assert.equal(conservative.status, 'candidate');
  assert.match(conservative.reason ?? '', /source_verified/);
  assert.equal(decideAutoPublish(facts, policy()).status, 'active');
  assert.equal(MODE_ALLOWED_TRUST.conservative.includes('source_verified'), false);
  assert.equal(MODE_ALLOWED_TRUST.standard.includes('model_supported'), true);
});

test('decision: aggressive allows model-supported profile only with two independent observations', () => {
  const profile = baseFacts({kind: 'profile', trust: 'model_supported', authority: 'model'});
  assert.equal(decideAutoPublish(profile, policy({mode: 'aggressive', minScore: MODE_THRESHOLDS.aggressive})).status, 'active');
  const singleObservation = baseFacts({kind: 'profile', trust: 'model_supported', authority: 'model', independentSources: 1, independentProjects: 0});
  const held = decideAutoPublish(singleObservation, policy({mode: 'aggressive', minScore: MODE_THRESHOLDS.aggressive}));
  assert.equal(held.status, 'candidate');
  assert.match(held.reason ?? '', /#5/);
});

test('decision: requireReview keeps the record candidate until P1 review, policy validation is strict', () => {
  assert.equal(decideAutoPublish(baseFacts(), policy({requireReview: true})).status, 'candidate');
  assert.match(decideAutoPublish(baseFacts(), policy({requireReview: true})).reason ?? '', /复核/);
  assert.equal(decideAutoPublish(baseFacts(), policy({requireReview: false})).status, 'active');
  validationError(() => decideAutoPublish(baseFacts(), policy({mode: 'wild' as never})));
  validationError(() => decideAutoPublish(baseFacts(), policy({minScore: 101})));
  validationError(() => decideAutoPublish(baseFacts(), policy({maxAutoPerDay: -1})));
  validationError(() => decideAutoPublish(baseFacts(), policy({requireReview: 'yes' as never})));
});

// ---------------------------------------------------------------------------
// Policy store: defaults, CAS, persistence
// ---------------------------------------------------------------------------

test('policy: first resolve uses install profile (fresh->standard/70, upgraded->conservative/90)', () => {
  const f = makeDb({now: () => NOW});
  try {
    const fresh = f.ap.resolvePolicy(PROJECT, 'fresh');
    assert.deepEqual(fresh, {
      id: `autopublish:${PROJECT}`, projectId: PROJECT, mode: 'standard', minScore: 70,
      maxAutoPerDay: DEFAULT_MAX_AUTO_PER_DAY, requireReview: false, version: 1, updatedAt: NOW,
    });
    const upgraded = f.ap.resolvePolicy('project-b', 'upgraded');
    assert.equal(upgraded.mode, 'conservative');
    assert.equal(upgraded.minScore, 90);
    assert.equal(upgraded.id, 'autopublish:project-b');
    // Existing policy is never replaced by a later install-profile guess.
    assert.equal(f.ap.resolvePolicy(PROJECT, 'upgraded').mode, 'standard');
    assert.equal(f.ap.resolvePolicy(PROJECT, 'fresh').version, 1);
    validationError(() => f.ap.resolvePolicy(PROJECT, 'sideways' as never));
  } finally { f.cleanup(); }
});

test('policy: survives reopen and update CAS rejects stale versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-autopublish-'));
  const first = new RecordStore('memory', dir);
  first.db.exec(SCHEMA_DDL);
  try {
    const store = new AutoPublishStore(first.db, {now: () => NOW});
    assert.equal(store.resolvePolicy(PROJECT, 'fresh').version, 1);
    first.close();
    const reopened = new RecordStore('memory', dir);
    try {
      const store2 = new AutoPublishStore(reopened.db, {now: () => NOW});
      const persisted = store2.resolvePolicy(PROJECT, 'fresh');
      assert.equal(persisted.version, 1);
      assert.equal(persisted.mode, 'standard');
    } finally { reopened.close(); }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('policy: updatePolicy patch validation, version CAS and mode threshold defaults', () => {
  const f = makeDb();
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh'); // standard v1
    const aggressive = f.ap.updatePolicy(PROJECT, {mode: 'aggressive'}, 1);
    assert.equal(aggressive.version, 2);
    assert.equal(aggressive.mode, 'aggressive');
    assert.equal(aggressive.minScore, MODE_THRESHOLDS.aggressive);
    assert.throws(() => f.ap.updatePolicy(PROJECT, {minScore: 80}, 1), ConflictError);
    const explicit = f.ap.updatePolicy(PROJECT, {minScore: 60}, 2);
    assert.equal(explicit.version, 3);
    assert.equal(explicit.minScore, 60);
    assert.equal(explicit.mode, 'aggressive');
    const reviewed = f.ap.updatePolicy(PROJECT, {requireReview: true, maxAutoPerDay: 5}, 3);
    assert.equal(reviewed.version, 4);
    assert.equal(reviewed.requireReview, true);
    assert.equal(reviewed.maxAutoPerDay, 5);
    const off = f.ap.updatePolicy(PROJECT, {mode: 'off'}, 4);
    assert.equal(off.mode, 'off');
    assert.equal(off.minScore, 60); // off keeps the threshold; decision short-circuits
    validationError(() => f.ap.updatePolicy(PROJECT, {}, 5));
    validationError(() => f.ap.updatePolicy(PROJECT, {mode: 'wild' as never}, 5));
    validationError(() => f.ap.updatePolicy(PROJECT, {minScore: 101}, 5));
    validationError(() => f.ap.updatePolicy(PROJECT, {maxAutoPerDay: -1}, 5));
    validationError(() => f.ap.updatePolicy(PROJECT, {requireReview: 'yes' as never}, 5));
    validationError(() => f.ap.updatePolicy(PROJECT, {unknown: true} as never, 5));
    validationError(() => f.ap.updatePolicy('missing-project', {minScore: 50}, 1));
    // mode switch back applies the deterministic threshold again.
    assert.equal(f.ap.updatePolicy(PROJECT, {mode: 'standard'}, 5).minScore, 70);
    assert.equal(f.ap.resolvePolicy(PROJECT, 'fresh').version, 6);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Audit store: daily quota, record/list, revoke
// ---------------------------------------------------------------------------

test('audit: countAutoPublishedToday uses the LOCAL day boundary and counts publish rows only', () => {
  const timer = clock();
  const f = makeDb({now: timer.now});
  try {
    f.ap.record(auditInput({memoryId: 'm1'}));
    f.ap.record(auditInput({memoryId: 'm2'}));
    f.ap.record(auditInput({memoryId: 'm3', action: 'candidate'}));
    assert.equal(f.ap.countAutoPublishedToday(PROJECT), 2);
    assert.equal(f.ap.countAutoPublishedToday('project-b'), 0);
    timer.advance(24 * 60 * 60 * 1000);
    assert.equal(f.ap.countAutoPublishedToday(PROJECT), 0);
  } finally { f.cleanup(); }
});

test('audit: record stores full row, rollback token, gates and filters by memory/batch/policy/since/limit', () => {
  const timer = clock();
  const f = makeDb({now: timer.now});
  try {
    const publish = f.ap.record(auditInput({
      memoryId: 'm1', revision: 3, policyVersion: 2, score: 88,
      gates: [{id: 1, name: 'authority', pass: true}],
      trust: 'source_verified', authority: 'source', jobId: 'job-1',
      before: {status: 'candidate'}, after: {status: 'active'}, batchKey: 'batch-1',
    }));
    assert.match(publish.id, /^[0-9a-f-]{36}$/);
    assert.equal(publish.rollbackToken, digest([PROJECT, 'm1', 3, 2, publish.createdAt]));
    assert.equal(publish.gates.length, 1);
    assert.equal(publish.trust, 'source_verified');
    assert.equal(publish.authority, 'source');
    assert.equal(publish.jobId, 'job-1');
    assert.equal(publish.batchKey, 'batch-1');
    assert.equal(publish.score, 88);
    assert.deepEqual(publish.before, {status: 'candidate'});
    assert.deepEqual(publish.after, {status: 'active'});
    assert.equal(publish.revokedAt, null);
    timer.advance(1000);
    const candidate = f.ap.record(auditInput({memoryId: 'm2', revision: 2, action: 'candidate', policyVersion: 1}));
    assert.equal(candidate.rollbackToken, null, 'only publish rows carry a rollback token');
    const all = f.ap.listAudit(PROJECT);
    assert.equal(all.length, 2);
    assert.equal(all[0].memoryId, 'm2');
    assert.equal(f.ap.listAudit(PROJECT, {memoryId: 'm1'}).length, 1);
    assert.equal(f.ap.listAudit(PROJECT, {batchKey: 'batch-1'}).length, 1);
    assert.equal(f.ap.listAudit(PROJECT, {policyVersion: 2}).length, 1);
    assert.equal(f.ap.listAudit(PROJECT, {policyVersion: 1}).length, 1);
    assert.equal(f.ap.listAudit(PROJECT, {since: publish.createdAt}).length, 2);
    assert.equal(f.ap.listAudit(PROJECT, {since: candidate.createdAt}).length, 1);
    assert.equal(f.ap.listAudit(PROJECT, {limit: 1}).length, 1);
    assert.equal(f.ap.listAudit('project-b').length, 0);
    validationError(() => f.ap.listAudit(PROJECT, {limit: 0}));
    validationError(() => f.ap.listAudit(PROJECT, {since: 'not-a-time'}));
    validationError(() => f.ap.record(auditInput({action: 'Bad Action'})));
    validationError(() => f.ap.record(auditInput({projectId: ''})));
    validationError(() => f.ap.record(auditInput({revision: -1})));
    validationError(() => f.ap.record(auditInput({mode: 'wild' as never})));
    validationError(() => f.ap.record(auditInput({score: 101})));
    validationError(() => f.ap.record(auditInput({gates: {} as never})));
    validationError(() => f.ap.record(auditInput({actor: ' '})));
  } finally { f.cleanup(); }
});

test('audit: revoke by audit id or memory id is idempotent and updates only unrevoked publish rows', () => {
  const f = makeDb();
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh');
    const publish = f.ap.record(auditInput({memoryId: 'm1', batchKey: 'batch-A'}));
    f.ap.record(auditInput({memoryId: 'm2', batchKey: 'batch-B'}));
    f.ap.record(auditInput({memoryId: 'm3', action: 'candidate'}));
    // By memory id.
    const byMemory = f.ap.revoke({projectId: PROJECT, ids: ['m1'], actor: 'user', reason: '误发布'});
    assert.equal(byMemory.length, 1);
    assert.equal(byMemory[0].id, publish.id);
    assert.equal(byMemory[0].memoryId, 'm1');
    assert.ok(byMemory[0].revokedAt);
    assert.equal(byMemory[0].revokeReason, '误发布');
    assert.equal(byMemory[0].revision, 1);
    // Repeat is idempotent: nothing left to revoke.
    assert.deepEqual(f.ap.revoke({projectId: PROJECT, ids: ['m1'], actor: 'user'}), []);
    // By audit id also works.
    const byAuditId = f.ap.revoke({projectId: PROJECT, ids: [publish.id], actor: 'user'});
    assert.deepEqual(byAuditId, []);
    // Batch revoke only matches publish rows.
    const byBatch = f.ap.revoke({projectId: PROJECT, batchKey: 'batch-B', actor: 'user'});
    assert.equal(byBatch.length, 1);
    assert.equal(byBatch[0].memoryId, 'm2');
    // The candidate row was never selectable.
    assert.equal(f.ap.listAudit(PROJECT, {memoryId: 'm3'})[0].revokedAt, null);
    validationError(() => f.ap.revoke({projectId: PROJECT, actor: 'user'}));
    assert.throws(() => f.ap.revoke({projectId: PROJECT, ids: ['m1'], actor: 'system' as never}),
      (error: unknown) => error instanceof CapabilityError && error.code === 'PERMISSION_DENIED');
  } finally { f.cleanup(); }
});

test('audit: revoke filters by policyVersion and since', () => {
  const timer = clock();
  const f = makeDb({now: timer.now});
  try {
    const m1 = f.ap.record(auditInput({memoryId: 'm1', policyVersion: 1}));
    timer.advance(1000);
    const m2 = f.ap.record(auditInput({memoryId: 'm2', policyVersion: 2}));
    timer.advance(1000);
    const m3 = f.ap.record(auditInput({memoryId: 'm3', policyVersion: 3}));
    const byPolicy = f.ap.revoke({projectId: PROJECT, policyVersion: 2, actor: 'user'});
    assert.deepEqual(byPolicy.map(row => row.memoryId), ['m2']);
    const bySince = f.ap.revoke({projectId: PROJECT, since: m2.createdAt, actor: 'user'});
    assert.deepEqual(bySince.map(row => row.memoryId), ['m3']);
    assert.equal(f.ap.listAudit(PROJECT, {memoryId: 'm1'})[0].revokedAt, null);
    assert.equal(f.ap.listAudit(PROJECT, {since: m1.createdAt}).length, 3);
    assert.equal(m3.createdAt >= m2.createdAt, true);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Stats and automatic downgrade
// ---------------------------------------------------------------------------

test('stats: autoPublished/revoked totals plus rolling corrected count and current mode', () => {
  const f = makeDb();
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh');
    f.ap.record(auditInput({memoryId: 'm1'}));
    f.ap.record(auditInput({memoryId: 'm2'}));
    f.ap.revoke({projectId: PROJECT, ids: ['m1'], actor: 'user'});
    assert.equal(f.ap.noteCorrection(PROJECT, 'm1').downgraded, false);
    assert.equal(f.ap.noteCorrection(PROJECT, 'm2').downgraded, false);
    assert.deepEqual(f.ap.stats(PROJECT), {autoPublished: 2, revoked: 1, corrected: 2, mode: 'standard'});
    assert.deepEqual(f.ap.stats('project-b'), {autoPublished: 0, revoked: 0, corrected: 0});
  } finally { f.cleanup(); }
});

test('downgrade: five corrections move standard -> conservative, reset the window and write an audit row', () => {
  const f = makeDb();
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh'); // standard v1
    for (let index = 0; index < AUTO_DOWNGRADE_THRESHOLD - 1; index++) {
      const result = f.ap.noteCorrection(PROJECT, `m${index}`);
      assert.equal(result.downgraded, false);
      assert.equal(result.mode, 'standard');
    }
    const last = f.ap.noteCorrection(PROJECT, 'm-final');
    assert.equal(last.downgraded, true);
    assert.equal(last.mode, 'conservative');
    const policyAfter = f.ap.resolvePolicy(PROJECT, 'fresh');
    assert.equal(policyAfter.mode, 'conservative');
    assert.equal(policyAfter.minScore, 90);
    assert.equal(policyAfter.version, 2);
    const audit = f.ap.listAudit(PROJECT, {policyVersion: 2});
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'downgrade');
    assert.equal(audit[0].mode, 'conservative');
    // Window was reset: conservative never downgrades further anyway, and the
    // rolling counters restart from zero.
    assert.equal(f.ap.stats(PROJECT).corrected, 0);
    for (let index = 0; index < 8; index++) {
      assert.equal(f.ap.noteCorrection(PROJECT, `again-${index}`).downgraded, false);
    }
  } finally { f.cleanup(); }
});

test('downgrade: aggressive -> standard, conservative never downgrades, noteRevoke shares the counter', () => {
  const f = makeDb();
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh');
    f.ap.updatePolicy(PROJECT, {mode: 'aggressive'}, 1); // v2
    assert.equal(f.ap.noteRevoke(PROJECT, 2).downgraded, false);
    const downgraded = f.ap.noteRevoke(PROJECT, 3);
    assert.equal(downgraded.downgraded, true);
    assert.equal(downgraded.mode, 'standard');
    assert.equal(f.ap.resolvePolicy(PROJECT, 'fresh').mode, 'standard');
    assert.equal(f.ap.updatePolicy(PROJECT, {mode: 'conservative'}, 3).mode, 'conservative');
    assert.equal(f.ap.noteRevoke(PROJECT, 5).downgraded, false);
    assert.equal(f.ap.noteCorrection(PROJECT, 'm1').downgraded, false);
    assert.equal(f.ap.resolvePolicy(PROJECT, 'fresh').mode, 'conservative');
  } finally { f.cleanup(); }
});

test('downgrade: corrections older than the 7-day rolling window do not count', () => {
  const timer = clock();
  const f = makeDb({now: timer.now});
  try {
    f.ap.resolvePolicy(PROJECT, 'fresh');
    for (let index = 0; index < 3; index++) f.ap.noteCorrection(PROJECT, `old-${index}`);
    assert.equal(f.ap.stats(PROJECT).corrected, 3);
    timer.advance(8 * 24 * 60 * 60 * 1000);
    assert.equal(f.ap.stats(PROJECT).corrected, 0, 'expired rolling window reads as zero');
    for (let index = 0; index < 3; index++) {
      assert.equal(f.ap.noteCorrection(PROJECT, `new-${index}`).downgraded, false);
    }
    assert.equal(f.ap.resolvePolicy(PROJECT, 'fresh').mode, 'standard');
    assert.equal(f.ap.stats(PROJECT).corrected, 3);
  } finally { f.cleanup(); }
});

test('store: refuses to construct before schema v4 tables exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-autopublish-'));
  const db = new DatabaseSync(join(dir, 'raw.sqlite'));
  try {
    assert.throws(() => new AutoPublishStore(db),
      (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_UNAVAILABLE');
  } finally {
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// Controller-level integration (post-INTEGRATION_READY)
//
// These exercise the real MemoryController + learning pipeline + schema v4 +
// autoPublish actions. They assert only the public shapes the Lead finalized:
// snapshot.autoPublish / dispatch('autoPublish.*') / events / record fields.
// ---------------------------------------------------------------------------

interface AutoPublishStatusView {
  policy: AutoPublishPolicy;
  stats: { autoPublished: number; revoked: number; corrected: number; mode?: AutoPublishMode };
  audit: AuditRow[];
}

interface ControllerSnapshotView {
  memories: MemoryRecord[];
  candidates: MemoryRecord[];
  conflicts: unknown[];
  autoPublish: AutoPublishStatusView;
}

interface ControllerFixture {
  dir: string;
  items: HistoryItem[];
  events: { event: string; data: unknown }[];
  ctx: PluginContext;
  controller: MemoryController;
  /** Queue of extraction responses; each learning job consumes the next entry. */
  reply(responses: unknown[][]): void;
  settle(): Promise<void>;
  close(): Promise<void>;
}

function controllerFixture(userTexts: string[]): ControllerFixture {
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-autopublish-controller-'));
  const previousRole = process.env.FRIEND_PI_LEARNING_ROLE;
  process.env.FRIEND_PI_LEARNING_ROLE = 'producer';
  const items: HistoryItem[] = userTexts.map((text, index) => ({
    id: `u${index + 1}`, parentId: null, type: 'message', role: 'user', timestamp: new Date().toISOString(), text,
  }));
  const events: { event: string; data: unknown }[] = [];
  let responses: unknown[][] = [];
  const ctx: PluginContext = {
    origin: 'user', dataDir: dir, projectDir: dir, projectId: 'a', sessionId: 's',
    sessionFile: join(dir, 'native.jsonl'), agentDir: join(dir, 'pi'), modelId: 'fixture/offline', runId: 'run1',
    isIdle: () => false,
    history: () => items,
    readSource: source => {
      const item = items.find(candidate => candidate.id === source.entryId);
      if (!item) throw new Error('来源不存在');
      return item;
    },
    complete: async () => JSON.stringify({memories: responses.shift() ?? []}),
    request: async () => { throw new Error('not installed'); },
    emit: (event, data) => { events.push({event, data}); },
    notify: () => {},
    appendEntry: () => {},
  };
  const controller = new MemoryController();
  return {
    dir, items, events, ctx, controller,
    reply: value => { responses = [...value]; },
    settle: async () => {
      await controller.settled(ctx);
      for (let step = 0; step < 40; step++) {
        const job = peekLearningJob(dir);
        if (!job) return;
        await controller.executeLearningJob(job.id, ctx);
      }
      throw new Error('learning did not settle');
    },
    close: async () => {
      await controller.dispose();
      if (previousRole === undefined) delete process.env.FRIEND_PI_LEARNING_ROLE;
      else process.env.FRIEND_PI_LEARNING_ROLE = previousRole;
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

function snapshotOf(fixture: ControllerFixture): ControllerSnapshotView {
  return fixture.controller.snapshot(fixture.ctx) as unknown as ControllerSnapshotView;
}

function factProposal(content: string, quote: string, entryId = 'u1'): Record<string, unknown> {
  return {title: content.slice(0, 30), content, kind: 'fact', sourceEntryIds: [entryId], sourceQuotes: {[entryId]: quote}};
}

function autoPublishEvents(fixture: ControllerFixture): { event: string; data: Record<string, unknown> }[] {
  return fixture.events.filter((item): item is { event: string; data: Record<string, unknown> } =>
    item.event === 'memory.autopublish' && !!item.data && typeof item.data === 'object' && !Array.isArray(item.data));
}

test('controller: standard mode auto-publishes a user-verified fact with audit row + rollback token', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  fixture.reply([[factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。')]]);
  try {
    await fixture.settle();
    const snapshot = snapshotOf(fixture);
    assert.equal(snapshot.autoPublish.policy.mode, 'standard');
    assert.equal(snapshot.autoPublish.policy.minScore, 70);
    assert.equal(snapshot.autoPublish.stats.autoPublished, 1);
    const record = snapshot.memories.find(item => item.content === '数据库必须使用 SQLite');
    assert.ok(record);
    assert.equal(record.status, 'active');
    assert.equal(record.enabled, true);
    assert.equal(record.autoPublished, true);
    assert.equal(record.trust, 'source_verified');
    assert.equal(record.authority, 'source');
    assert.equal(record.policyId, snapshot.autoPublish.policy.id);
    assert.equal(record.policyVersion, 1);
    assert.equal(record.score, 80);
    const status = await fixture.controller.dispatch('autoPublish.status', {}, fixture.ctx) as unknown as AutoPublishStatusView;
    assert.equal(status.policy.version, 1);
    assert.deepEqual(status.stats, {autoPublished: 1, revoked: 0, corrected: 0, mode: 'standard'});
    const publishRows = status.audit.filter(row => row.action === 'publish');
    assert.equal(publishRows.length, 1);
    const row = publishRows[0];
    assert.equal(row.mode, 'standard');
    assert.equal(row.score, 80);
    assert.equal(row.revision, record.revision);
    assert.deepEqual((row.gates as GateResult[]).map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.match(row.rollbackToken ?? '', /^[0-9a-f]{64}$/);
    assert.equal(row.trust, 'source_verified');
    assert.equal(row.authority, 'source');
    assert.ok(row.jobId);
    assert.equal(row.batchKey, row.jobId);
    const publishedEvents = autoPublishEvents(fixture).filter(item => typeof item.data.rollbackToken === 'string');
    assert.equal(publishedEvents.length, 1);
    assert.equal(publishedEvents[0].data.memoryId, record.id);
    assert.equal(publishedEvents[0].data.score, 80);
    assert.equal(publishedEvents[0].data.rollbackToken, row.rollbackToken);
    assert.equal(publishedEvents[0].data.policyVersion, 1);
  } finally {
    await fixture.close();
  }
});

test('controller: conservative mode holds a user-verified fact as candidate with a gate-6 audit row', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  fixture.reply([[factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。')]]);
  try {
    const configured = await fixture.controller.dispatch('autoPublish.settings', {mode: 'conservative'}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(configured.mode, 'conservative');
    assert.equal(configured.minScore, 90);
    assert.equal(configured.version, 2);
    await fixture.settle();
    const snapshot = snapshotOf(fixture);
    assert.equal(snapshot.memories.length, 0);
    assert.equal(snapshot.autoPublish.stats.autoPublished, 0);
    const candidate = snapshot.candidates.find(item => item.content === '数据库必须使用 SQLite');
    assert.ok(candidate);
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.autoPublished, false);
    assert.match(candidate.invalidatedReason ?? '', /#6|确定性分数/);
    const status = await fixture.controller.dispatch('autoPublish.status', {}, fixture.ctx) as unknown as AutoPublishStatusView;
    const candidateRows = status.audit.filter(row => row.action === 'candidate');
    assert.equal(candidateRows.length, 1);
    assert.equal(candidateRows[0].mode, 'conservative');
    assert.equal(candidateRows[0].score, 80);
    assert.equal(candidateRows[0].rollbackToken, null);
    assert.equal((candidateRows[0].gates as GateResult[]).find(item => item.id === 6)?.pass, false);
    assert.equal(autoPublishEvents(fixture).filter(item => item.data.action !== 'settings').length, 0);
  } finally {
    await fixture.close();
  }
});

test('controller: mode off keeps proposals candidate and switching back to standard auto-publishes new proposals', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  fixture.reply([
    [factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。')],
    [factProposal('构建命令必须使用 pnpm', '构建命令必须使用 pnpm。', 'u2')],
  ]);
  try {
    const off = await fixture.controller.dispatch('autoPublish.settings', {mode: 'off'}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(off.mode, 'off');
    assert.equal(off.version, 2);
    await fixture.settle();
    const offSnapshot = snapshotOf(fixture);
    assert.equal(offSnapshot.memories.length, 0);
    const held = offSnapshot.candidates.find(item => item.content === '数据库必须使用 SQLite');
    assert.ok(held);
    assert.match(held.invalidatedReason ?? '', /off/);
    assert.equal(offSnapshot.autoPublish.audit.filter(row => row.action === 'candidate').length, 1);
    const standard = await fixture.controller.dispatch('autoPublish.settings', {mode: 'standard'}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(standard.mode, 'standard');
    assert.equal(standard.version, 3);
    assert.equal(standard.minScore, 70);
    fixture.items.push({id: 'u2', parentId: null, type: 'message', role: 'user', timestamp: new Date().toISOString(), text: '构建命令必须使用 pnpm。'});
    await fixture.settle();
    const snapshot = snapshotOf(fixture);
    assert.equal(snapshot.autoPublish.policy.mode, 'standard');
    const published = snapshot.memories.find(item => item.content === '构建命令必须使用 pnpm');
    assert.ok(published);
    assert.equal(published.status, 'active');
    assert.equal(published.autoPublished, true);
    assert.equal(snapshot.candidates.some(item => item.id === held.id), true, 'the off-mode candidate stays candidate');
    assert.equal(snapshot.autoPublish.stats.autoPublished, 1);
  } finally {
    await fixture.close();
  }
});

test('controller: autoPublish.settings enforces version CAS, patch validation and user origin', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  try {
    await assert.rejects(
      fixture.controller.dispatch('autoPublish.settings', {mode: 'aggressive', expectedVersion: 99}, fixture.ctx),
      {name: 'ConflictError'},
    );
    const aggressive = await fixture.controller.dispatch('autoPublish.settings', {mode: 'aggressive', expectedVersion: 1}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(aggressive.mode, 'aggressive');
    assert.equal(aggressive.minScore, 55);
    assert.equal(aggressive.version, 2);
    const reviewed = await fixture.controller.dispatch('autoPublish.settings', {requireReview: true, expectedVersion: 2}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(reviewed.requireReview, true);
    assert.equal(reviewed.version, 3);
    for (const patch of [{}, {minScore: 101}, {requireReview: 'yes'}, {mode: 'wild'}]) {
      await assert.rejects(
        fixture.controller.dispatch('autoPublish.settings', patch, fixture.ctx),
        (error: unknown) => error instanceof CapabilityError && error.code === 'VALIDATION_ERROR',
      );
    }
    await assert.rejects(
      fixture.controller.dispatch('autoPublish.settings', {mode: 'standard'}, {...fixture.ctx, origin: 'agent'}),
      (error: unknown) => error instanceof CapabilityError && error.code === 'PERMISSION_DENIED',
    );
    const snapshot = snapshotOf(fixture);
    assert.equal(snapshot.autoPublish.policy.mode, 'aggressive');
    assert.equal(snapshot.autoPublish.policy.version, 3);
    assert.equal(snapshot.autoPublish.policy.requireReview, true);
    const settingsEvents = autoPublishEvents(fixture).filter(item => item.data.action === 'settings');
    assert.equal(settingsEvents.length, 2);
    assert.equal((settingsEvents.at(-1)?.data.policy as AutoPublishPolicy | undefined)?.version, 3);
  } finally {
    await fixture.close();
  }
});

test('controller: autoPublish.revoke by memory id deactivates, suppresses and blocks automatic revival', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  fixture.reply([
    [factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。')],
    [factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。', 'u2')],
  ]);
  try {
    await fixture.settle();
    const before = snapshotOf(fixture);
    const record = before.memories.find(item => item.content === '数据库必须使用 SQLite');
    assert.ok(record);
    assert.equal(record.status, 'active');
    const result = await fixture.controller.dispatch('autoPublish.revoke', {ids: [record.id], reason: '误发布'}, fixture.ctx) as unknown as {revoked: string[]; skipped: {id: string; reason: string}[]};
    assert.deepEqual(result.revoked, [record.id]);
    assert.deepEqual(result.skipped, []);
    const revoked = snapshotOf(fixture);
    const inactive = revoked.memories.find(item => item.id === record.id);
    assert.ok(inactive);
    assert.equal(inactive.status, 'inactive');
    assert.equal(inactive.enabled, false);
    assert.equal(inactive.autoPublished, false);
    assert.match(inactive.invalidatedReason ?? '', /撤回/);
    assert.deepEqual(fixture.controller.search({query: 'SQLite'}, fixture.ctx), []);
    assert.equal(revoked.autoPublish.stats.revoked, 1);
    const revokedRow = revoked.autoPublish.audit.find(row => row.action === 'publish' && row.memoryId === record.id);
    assert.ok(revokedRow);
    assert.ok(revokedRow.revokedAt);
    assert.equal(revokedRow.revokeReason, '误发布');
    const revokedEvent = fixture.events.find(item => item.event === 'memory.autopublish.revoked');
    assert.ok(revokedEvent);
    assert.deepEqual((revokedEvent.data as {revoked: string[]}).revoked, [record.id]);
    // Re-extracting identical content from a new user entry cannot revive it.
    fixture.items.push({id: 'u2', parentId: null, type: 'message', role: 'user', timestamp: new Date().toISOString(), text: '数据库必须使用 SQLite。'});
    await fixture.settle();
    const final = snapshotOf(fixture);
    assert.equal(final.memories.some(item => item.status === 'active'), false);
    assert.equal(final.candidates.length, 0);
    assert.equal(final.autoPublish.audit.filter(row => row.action === 'publish').length, 1);
  } finally {
    await fixture.close();
  }
});

test('controller: autoPublish.revoke by batch/policyVersion revokes every publish row and is idempotent', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。构建命令必须使用 pnpm。']);
  fixture.reply([[
    factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。'),
    factProposal('构建命令必须使用 pnpm', '构建命令必须使用 pnpm。'),
  ]]);
  try {
    await fixture.settle();
    const before = snapshotOf(fixture);
    assert.equal(before.memories.filter(item => item.status === 'active').length, 2);
    const publishRows = before.autoPublish.audit.filter(row => row.action === 'publish');
    assert.equal(publishRows.length, 2);
    const batchKey = publishRows[0].batchKey;
    assert.ok(batchKey);
    assert.equal(publishRows.every(row => row.batchKey === batchKey), true);
    assert.equal(publishRows.every(row => !!row.rollbackToken && row.policyVersion === 1), true);
    const first = await fixture.controller.dispatch('autoPublish.revoke', {batchKey}, fixture.ctx) as unknown as {revoked: string[]};
    assert.deepEqual([...first.revoked].sort(), publishRows.map(row => row.memoryId).sort());
    const after = snapshotOf(fixture);
    assert.equal(after.memories.filter(item => item.status === 'active').length, 0);
    assert.equal(after.autoPublish.stats.revoked, 2);
    assert.equal(after.autoPublish.audit.filter(row => row.action === 'publish').every(row => row.revokedAt !== null), true);
    const second = await fixture.controller.dispatch('autoPublish.revoke', {policyVersion: 1}, fixture.ctx) as unknown as {revoked: string[]};
    assert.deepEqual(second.revoked, []);
    assert.equal(fixture.controller.search({query: 'SQLite'}, fixture.ctx).length, 0);
    assert.equal(fixture.controller.search({query: 'pnpm'}, fixture.ctx).length, 0);
    const revokedEvents = fixture.events
      .filter(item => item.event === 'memory.autopublish.revoked')
      .map(item => (item.data as {revoked: string[]}).revoked);
    assert.equal(revokedEvents.some(ids => ids.length === 2), true);
  } finally {
    await fixture.close();
  }
});

test('controller: a user correction of an auto-published record triggers the rolling downgrade event', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。']);
  fixture.reply([[factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。')]]);
  try {
    await fixture.settle();
    const before = snapshotOf(fixture);
    const record = before.memories.find(item => item.content === '数据库必须使用 SQLite');
    assert.ok(record);
    assert.equal(record.autoPublished, true);
    assert.equal(before.autoPublish.policy.mode, 'standard');
    assert.equal(before.autoPublish.policy.version, 1);
    // The Lead-approved shortcut: pre-seed four corrections, then correct the record by user origin.
    const seedStore = new RecordStore('memory', fixture.dir);
    try {
      const seed = new AutoPublishStore(seedStore.db);
      for (let index = 0; index < AUTO_DOWNGRADE_THRESHOLD - 1; index++) {
        assert.equal(seed.noteCorrection('a', `seed-${index}`).downgraded, false);
      }
    } finally {
      seedStore.close();
    }
    const corrected = await fixture.controller.dispatch('update', {id: record.id, revision: record.revision, content: '数据库必须使用 PostgreSQL'}, fixture.ctx) as unknown as MemoryRecord;
    assert.equal(corrected.autoPublished, false);
    assert.equal(corrected.trust, 'user_explicit');
    const after = snapshotOf(fixture);
    assert.equal(after.autoPublish.policy.mode, 'conservative');
    assert.equal(after.autoPublish.policy.minScore, 90);
    assert.equal(after.autoPublish.policy.version, 2);
    assert.equal(after.autoPublish.stats.corrected, 0);
    assert.equal(after.autoPublish.audit.some(row => row.action === 'downgrade' && row.mode === 'conservative'), true);
    const downgradeEvent = autoPublishEvents(fixture).find(item => item.data.action === 'downgrade');
    assert.ok(downgradeEvent);
    assert.equal(downgradeEvent.data.mode, 'conservative');
  } finally {
    await fixture.close();
  }
});

test('controller: the daily auto-publish quota turns the second proposal into a candidate', async () => {
  const fixture = controllerFixture(['数据库必须使用 SQLite。构建命令必须使用 pnpm。']);
  fixture.reply([[
    factProposal('数据库必须使用 SQLite', '数据库必须使用 SQLite。'),
    factProposal('构建命令必须使用 pnpm', '构建命令必须使用 pnpm。'),
  ]]);
  try {
    const configured = await fixture.controller.dispatch('autoPublish.settings', {maxAutoPerDay: 1}, fixture.ctx) as unknown as AutoPublishPolicy;
    assert.equal(configured.maxAutoPerDay, 1);
    assert.equal(configured.version, 2);
    await fixture.settle();
    const snapshot = snapshotOf(fixture);
    assert.equal(snapshot.autoPublish.stats.autoPublished, 1);
    assert.equal(snapshot.memories.filter(item => item.status === 'active' && item.autoPublished === true).length, 1);
    const held = snapshot.candidates.find(item => item.status === 'candidate');
    assert.ok(held);
    assert.match(held.invalidatedReason ?? '', /#8|额度/);
    const status = await fixture.controller.dispatch('autoPublish.status', {}, fixture.ctx) as unknown as AutoPublishStatusView;
    assert.equal(status.audit.filter(row => row.action === 'publish').length, 1);
    assert.equal(status.audit.filter(row => row.action === 'candidate').length, 1);
    assert.equal(autoPublishEvents(fixture).filter(item => typeof item.data.rollbackToken === 'string').length, 1);
  } finally {
    await fixture.close();
  }
});
