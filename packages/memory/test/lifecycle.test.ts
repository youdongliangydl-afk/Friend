import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpired, retentionScore, needsArchive, reviewPriority, reviewCandidates,
  REVIEW_REASONS, ARCHIVE_RETENTION_THRESHOLD, DEFAULT_REVIEW_LIMIT,
  type LifecycleRecord, type ReviewReason,
} from '../src/lifecycle.js';
import { KIND_POLICIES } from '../src/kinds.js';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (days: number): string => new Date(NOW - days * DAY_MS).toISOString();
const fromNow = (days: number): string => new Date(NOW + days * DAY_MS).toISOString();

function record(overrides: Partial<LifecycleRecord> = {}): LifecycleRecord {
  return {id: 'm1', kind: 'fact', status: 'active', enabled: true, trust: 'user_explicit', updatedAt: ago(0), ...overrides};
}

function near(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

test('isExpired uses expiresAt <= now and ignores missing/invalid or validTo-only records', () => {
  assert.equal(isExpired(record({expiresAt: new Date(NOW).toISOString()}), NOW), true);
  assert.equal(isExpired(record({expiresAt: new Date(NOW - 1).toISOString()}), NOW), true);
  assert.equal(isExpired(record({expiresAt: new Date(NOW + 1).toISOString()}), NOW), false);
  assert.equal(isExpired(record({}), NOW), false);
  assert.equal(isExpired(record({expiresAt: 'not-a-date'}), NOW), false);
  // validTo is handled by the controller's validTime(), not by isExpired.
  assert.equal(isExpired(record({validFrom: '2000-01-01', validTo: '2000-12-31'}), NOW), false);
});

test('retentionScore is monotone in trust (user > confirmed > source > tool > model)', () => {
  const scores = ['user_explicit', 'user_confirmed', 'source_verified', 'tool_verified', 'quote_verified', 'model_supported', 'model_inferred']
    .map(trust => retentionScore(record({trust, useCount: 5, lastUsedAt: ago(0), feedbackScore: 0}), NOW));
  for (let index = 1; index < scores.length; index++) {
    assert.ok(scores[index - 1]! > scores[index]!, `trust rank ${index}`);
  }
  near(scores[0]!, 1);
  near(scores[5]!, 0.4);
  near(scores[6]!, 0.25);
  // Unknown/absent trust uses the neutral 0.5 factor.
  near(retentionScore(record({trust: undefined, useCount: 5, lastUsedAt: ago(0)}), NOW), 0.5);
});

test('retentionScore usage factor = min(1, 0.5 + 0.1*useCount)', () => {
  const score = (useCount: number) => retentionScore(record({useCount, lastUsedAt: ago(0), feedbackScore: 0}), NOW);
  near(score(0), 0.5);
  near(score(1), 0.6);
  near(score(5), 1);
  near(score(10), 1);
  near(score(100), 1);
  assert.ok(score(1) > score(0));
  assert.equal(score(5), score(10));
});

test('retentionScore feedback factor is clamped to 0.5..1.5', () => {
  // Model trust keeps the product below 1 so the feedback multiplier is observable.
  const score = (feedbackScore: number) => retentionScore(record({trust: 'model_supported', useCount: 5, lastUsedAt: ago(0), feedbackScore}), NOW);
  near(score(-10), 0.2); // 0.4 * 0.5 (clamped)
  near(score(-5), 0.2);
  near(score(-1), 0.36);
  near(score(0), 0.4);
  near(score(1), 0.44);
  near(score(5), 0.6); // 0.4 * 1.5 (clamped)
  near(score(10), 0.6);
  assert.ok(score(0) > score(-1));
  assert.ok(score(1) > score(0));
  assert.equal(score(-10), score(-5));
  assert.equal(score(5), score(10));
});

test('retentionScore age decay: 180d → 0.5 for long-lived kinds and 60d → 0.5 for episode', () => {
  const profileFresh = retentionScore(record({kind: 'profile', updatedAt: ago(0), useCount: 5, lastUsedAt: ago(0)}), NOW);
  const profileOld = retentionScore(record({kind: 'profile', updatedAt: ago(180), useCount: 5, lastUsedAt: ago(0)}), NOW);
  near(profileOld / profileFresh, 0.5);
  const episodeFresh = retentionScore(record({kind: 'episode', updatedAt: ago(0), useCount: 5, lastUsedAt: ago(0)}), NOW);
  const episodeOld = retentionScore(record({kind: 'episode', updatedAt: ago(60), useCount: 5, lastUsedAt: ago(0)}), NOW);
  near(episodeOld / episodeFresh, 0.5);
  const ages = [0, 30, 90, 180, 360];
  const scores = ages.map(days => retentionScore(record({kind: 'profile', updatedAt: ago(days), useCount: 5, lastUsedAt: ago(0)}), NOW));
  for (let index = 1; index < scores.length; index++) assert.ok(scores[index - 1]! > scores[index]!, `age ${ages[index]}`);
});

test('retentionScore recency uses lastUsedAt with a 0.5 floor', () => {
  const score = (days: number) => retentionScore(record({updatedAt: ago(0), useCount: 5, feedbackScore: 0, lastUsedAt: ago(days)}), NOW);
  near(score(0), 1);
  near(score(90), 0.5);
  near(score(365), 0.5);
  near(score(3650), 0.5);
  const recent = score(1);
  const mid = score(30);
  assert.ok(recent > mid);
  assert.ok(mid > score(89));
  assert.equal(score(365), score(3650));
  // A never-used record gets the neutral 0.8 recency discount.
  near(retentionScore(record({updatedAt: ago(0), useCount: 5, lastUsedAt: undefined}), NOW), 0.8);
});

test('needsArchive requires active + low retention + age beyond the kind TTL', () => {
  assert.equal(ARCHIVE_RETENTION_THRESHOLD, 0.25);
  assert.equal(needsArchive(record({status: 'candidate', updatedAt: ago(365)}), NOW), false);
  assert.equal(needsArchive(record({status: 'inactive', updatedAt: ago(365)}), NOW), false);
  assert.equal(needsArchive(record({enabled: false, updatedAt: ago(365)}), NOW), false);
  // fact TTL is 90 days: 80d is not old enough even though retention is already low.
  assert.equal(needsArchive(record({updatedAt: ago(80), useCount: 0}), NOW), false);
  // At 200d with no use/feedback the retention falls below 0.25.
  assert.equal(needsArchive(record({updatedAt: ago(200), useCount: 0}), NOW), true);
  // Heavy recent use/love keeps the record above the archive threshold.
  assert.equal(needsArchive(record({updatedAt: ago(200), useCount: 10, lastUsedAt: ago(0), feedbackScore: 5}), NOW), false);
  assert.equal(needsArchive(record({kind: 'profile', updatedAt: ago(200), useCount: 0}), NOW), true);
  assert.equal(needsArchive(record({kind: 'episode', updatedAt: ago(61), useCount: 0}), NOW), true);
  assert.equal(needsArchive(record({kind: 'task', updatedAt: ago(15), useCount: 0}), NOW), true);
  assert.equal(needsArchive(record({kind: 'method', updatedAt: ago(999), useCount: 0}), NOW), false);
  assert.equal(needsArchive(record({kind: 'unknown', updatedAt: ago(999), useCount: 0}), NOW), false);
});

test('reviewPriority matches the spec table and unknown reasons score 0', () => {
  const expected: Record<ReviewReason, number> = {
    expired: 90, 'review-after': 70, 'low-use': 40, 'negative-feedback': 60,
    'autopublish-sample': 30, 'conflict-open': 80, 'dream-proposal': 50, 'stale-source': 85,
  };
  assert.equal(REVIEW_REASONS.length, 8);
  for (const [reason, priority] of Object.entries(expected)) {
    assert.equal(reviewPriority(reason as ReviewReason), priority, reason);
  }
  assert.equal(reviewPriority('bogus' as ReviewReason), 0);
});

test('reviewCandidates reports expired and review-after with normalized due dates', () => {
  const expired = record({id: 'expired', expiresAt: '2026-10-16T20:00:00+08:00'});
  const review = record({id: 'review', reviewAfter: ago(5)});
  const inactiveExpired = record({id: 'inactive-expired', status: 'inactive', expiresAt: ago(2)});
  const disabledExpired = record({id: 'disabled-expired', enabled: false, expiresAt: ago(2)});
  const result = reviewCandidates({records: [expired, review, inactiveExpired, disabledExpired], now: NOW});
  const byId = new Map(result.map(candidate => [candidate.memoryId, candidate]));
  assert.equal(result.length, 2);
  assert.equal(byId.get('expired')?.reason, 'expired');
  assert.equal(byId.get('expired')?.priority, 90);
  assert.equal(byId.get('expired')?.dueAt, '2026-10-16T12:00:00.000Z');
  assert.equal(byId.get('review')?.reason, 'review-after');
  assert.equal(byId.get('review')?.priority, 70);
  assert.equal(byId.get('review')?.dueAt, ago(5));
  assert.equal(byId.get('inactive-expired'), undefined);
  assert.equal(byId.get('disabled-expired'), undefined);
});

test('reviewCandidates merges explicit conflict/sample/dream lists and keeps the highest priority', () => {
  const conflicting = record({id: 'conflict', revision: 4});
  const sampled = record({id: 'sample'});
  const dream = record({id: 'dream'});
  const both = record({id: 'expired-conflict', expiresAt: ago(1)});
  const result = reviewCandidates({
    records: [conflicting, sampled, dream, both],
    now: NOW,
    openConflictIds: ['conflict', 'expired-conflict'],
    autopublishSampleIds: ['sample'],
    consolidationIds: ['dream'],
  });
  const byId = new Map(result.map(candidate => [candidate.memoryId, candidate]));
  assert.equal(byId.get('conflict')?.reason, 'conflict-open');
  assert.equal(byId.get('conflict')?.priority, 80);
  assert.equal(byId.get('conflict')?.revision, 4);
  assert.equal(byId.get('sample')?.reason, 'autopublish-sample');
  assert.equal(byId.get('sample')?.priority, 30);
  assert.equal(byId.get('sample')?.dueAt, new Date(NOW).toISOString());
  assert.equal(byId.get('dream')?.reason, 'dream-proposal');
  assert.equal(byId.get('dream')?.priority, 50);
  // expired (90) wins over conflict-open (80) for the same memory.
  assert.equal(byId.get('expired-conflict')?.reason, 'expired');
  assert.equal(new Set(result.map(candidate => candidate.memoryId)).size, result.length);
});

test('reviewCandidates detects low-use and negative-feedback records', () => {
  const lowUse = record({id: 'low-use', kind: 'fact', updatedAt: ago(61), useCount: 0});
  const usedEnough = record({id: 'used', kind: 'fact', updatedAt: ago(61), useCount: 3});
  const tooFresh = record({id: 'fresh', kind: 'fact', updatedAt: ago(30), useCount: 0});
  const negative = record({id: 'negative', feedbackScore: -2});
  const negativeCandidate = record({id: 'negative-candidate', status: 'candidate', feedbackScore: -3});
  const mild = record({id: 'mild', feedbackScore: -1});
  const result = reviewCandidates({
    records: [lowUse, usedEnough, tooFresh, negative, negativeCandidate, mild], now: NOW,
  });
  const byId = new Map(result.map(candidate => [candidate.memoryId, candidate]));
  assert.equal(byId.get('low-use')?.reason, 'low-use');
  assert.equal(byId.get('low-use')?.priority, 40);
  assert.equal(byId.get('used'), undefined);
  assert.equal(byId.get('fresh'), undefined);
  assert.equal(byId.get('negative')?.reason, 'negative-feedback');
  assert.equal(byId.get('negative')?.priority, 60);
  assert.equal(byId.get('negative-candidate')?.reason, 'negative-feedback');
  assert.equal(byId.get('mild'), undefined);
  // Negative feedback outranks low use for a record carrying both.
  const lowAndNegative = record({id: 'both', updatedAt: ago(61), useCount: 0, feedbackScore: -2});
  assert.equal(new Map(reviewCandidates({records: [lowAndNegative], now: NOW}).map(item => [item.memoryId, item.reason])).get('both'), 'negative-feedback');
});

test('reviewCandidates sorts by priority then dueAt then memoryId and honors limit', () => {
  const records = [
    record({id: 'a', expiresAt: ago(3)}),
    record({id: 'b'}),
    record({id: 'c', reviewAfter: ago(2)}),
    record({id: 'd', feedbackScore: -2}),
    record({id: 'e'}),
    record({id: 'f', kind: 'fact', updatedAt: ago(61), useCount: 0}),
    record({id: 'g'}),
  ];
  const result = reviewCandidates({
    records, now: NOW,
    openConflictIds: ['b'], autopublishSampleIds: ['g'], consolidationIds: ['e'],
  });
  assert.deepEqual(result.map(candidate => candidate.memoryId), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(result.slice(0, 3).map(candidate => candidate.memoryId), ['a', 'b', 'c']);
  const limited = reviewCandidates({
    records, now: NOW, limit: 2, openConflictIds: ['b'], autopublishSampleIds: ['g'], consolidationIds: ['e'],
  });
  assert.deepEqual(limited.map(candidate => candidate.memoryId), ['a', 'b']);
  assert.deepEqual(reviewCandidates({records, now: NOW, limit: 0}), []);
});

test('reviewCandidates tie-breaks same priority by dueAt then memoryId and caps the default limit at 50', () => {
  const tied = [
    record({id: 'z', expiresAt: ago(1)}),
    record({id: 'y', expiresAt: ago(3)}),
    record({id: 'x', expiresAt: ago(1)}),
  ];
  assert.deepEqual(reviewCandidates({records: tied, now: NOW}).map(candidate => candidate.memoryId), ['y', 'x', 'z']);
  const many = Array.from({length: DEFAULT_REVIEW_LIMIT + 5}, (_, index) => record({id: `sample-${String(index).padStart(2, '0')}`}));
  const result = reviewCandidates({records: many, now: NOW, autopublishSampleIds: many.map(item => item.id)});
  assert.equal(result.length, DEFAULT_REVIEW_LIMIT);
  assert.equal(DEFAULT_REVIEW_LIMIT, 50);
});

test('reviewCandidates is deterministic, tolerates invalid input and unknown ids', () => {
  const input = {
    records: [record({id: 'a', expiresAt: ago(1)}), record({id: 'b', feedbackScore: -2})],
    now: NOW,
    openConflictIds: ['missing-id'],
    autopublishSampleIds: [42 as unknown as string, 'b'],
  };
  assert.deepEqual(reviewCandidates(input), reviewCandidates(input));
  assert.deepEqual(reviewCandidates({records: []}), []);
  assert.deepEqual(reviewCandidates({records: null as unknown as LifecycleRecord[]}), []);
  assert.deepEqual(reviewCandidates(null as unknown as Parameters<typeof reviewCandidates>[0]), []);
  // Every kind policy TTL is a positive integer (the lifecycle module depends on it).
  for (const policy of Object.values(KIND_POLICIES)) assert.ok(policy.ttlDays === null || policy.ttlDays > 0);
});
