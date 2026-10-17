import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGETS,
  DEFAULT_RANK_WEIGHTS,
  INTENT_PRECEDENCE,
  INTENT_TYPES,
  INTENT_TYPE_PRIORITY_BOOSTS,
  LIFECYCLE_WEIGHTS,
  MAX_BUDGET_COUNT,
  MAX_GUIDANCE_SUGGESTIONS,
  MAX_PRIORITY_PREFERENCES,
  RETRIEVAL_RULE_VERSION,
  TRUST_SCORE,
  ZERO_HIT_BOUNDARY,
  applyBudget,
  detectIntent,
  explainRuleVersion,
  rankCandidates,
  renderedRecordChars,
  scoreCandidate,
  zeroHitGuidance,
  type BudgetRecord,
  type RankCandidate,
  type RecallIntent,
} from '../src/retrieval.js';

function candidate(overrides: Partial<RankCandidate> = {}): RankCandidate {
  return {
    id: 'm1',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    subjectKey: 'project.db.engine',
    aliases: [],
    title: '数据库引擎',
    content: '本项目数据库必须使用 PostgreSQL。',
    conditions: [],
    trust: 'user_confirmed',
    bm25: 0.5,
    exact: 0,
    subjectMatch: 0,
    taskContextMatch: 0,
    feedbackScore: 0,
    scopePrecedence: 0.5,
    recency: 0.5,
    conflict: false,
    stale: false,
    duplicate: false,
    pinned: false,
    pinnedChars: 0,
    recallWeight: 1,
    decay: 1,
    useCount: 0,
    ...overrides,
  };
}

function record(id: string, content = '正文', overrides: Partial<BudgetRecord> = {}): BudgetRecord {
  return { id, revision: 1, content, conditions: [], ...overrides };
}

const close = (actual: number, expected: number, message?: string) => {
  assert.ok(Math.abs(actual - expected) < 1e-6, message ?? `expected ${actual} ≈ ${expected}`);
};

test('rule version is 3 and defaults mirror the blueprint §10.3/§10.5 contract', () => {
  assert.equal(explainRuleVersion(), 3);
  assert.equal(RETRIEVAL_RULE_VERSION, 3);
  assert.deepEqual(DEFAULT_RANK_WEIGHTS, {
    exact: 4,
    subject: 3,
    bm25: 2,
    context: 2,
    feedback: 1.5,
    scope: 1.5,
    trust: 1,
    recency: 1,
    conflict: 3,
    stale: 2,
    duplicate: 1,
    intentType: 0.75,
  });
  assert.deepEqual(DEFAULT_BUDGETS, { pinned: 1500, directory: 1500, body: 3500, count: 6 });
  assert.equal(MAX_BUDGET_COUNT, 8);
  assert.equal(MAX_PRIORITY_PREFERENCES, 2);
  assert.deepEqual(LIFECYCLE_WEIGHTS, { recallWeight: 1, decay: 1 });
});

test('detectIntent maps the blueprint intent table lexically (Chinese + English)', () => {
  const table: Record<Exclude<RecallIntent, 'general'>, string[]> = {
    'how-to': [
      '如何修复构建报错',
      '部署失败怎么排查',
      'how to debug the failing build',
      'troubleshoot the broken command',
    ],
    decision: ['我们决定了什么', '为什么选 PostgreSQL 作为数据库', 'what did we decide about the database', 'the team chose sqlite'],
    identity: ['我是谁', '我的回答风格是什么', 'who am i', 'how should you work with me'],
    'current-task': ['当前任务还有什么没完成', '下一步做什么', 'current task next step', 'where were we'],
    'cross-project': ['其他项目怎么处理这个问题', '跨项目复用这个模式', 'reuse this in another project', 'other projects pattern'],
  };
  for (const [intent, queries] of Object.entries(table) as [Exclude<RecallIntent, 'general'>, string[]][]) {
    for (const query of queries) assert.equal(detectIntent(query), intent, `${query} → ${intent}`);
  }
  for (const query of ['CedarArchive 端口', 'PostgreSQL', '', '   ']) assert.equal(detectIntent(query), 'general');
});

test('intent precedence is exported, deterministic and first-match wins', () => {
  assert.deepEqual(INTENT_PRECEDENCE, ['current-task', 'identity', 'cross-project', 'decision', 'how-to']);
  assert.equal(detectIntent('当前任务为什么选择这个方案'), 'current-task');
  assert.equal(detectIntent('我的偏好在其他项目怎么用'), 'identity');
  assert.equal(detectIntent('其他项目里怎么做这件事'), 'cross-project');
  assert.equal(detectIntent('怎么决定用哪个方案'), 'decision');
  assert.equal(detectIntent('这里是 raw sql'), 'general');
});

test('INTENT_TYPES follows blueprint §10.4 priority order and general is neutral', () => {
  assert.deepEqual(INTENT_TYPES['how-to'], ['experience', 'fact', 'episode']);
  assert.deepEqual(INTENT_TYPES.decision, ['fact', 'episode', 'knowledge']);
  assert.deepEqual(INTENT_TYPES.identity, ['profile', 'preference']);
  assert.deepEqual(INTENT_TYPES['current-task'], ['task', 'episode', 'fact']);
  assert.deepEqual(INTENT_TYPES['cross-project'], ['knowledge', 'profile']);
  assert.deepEqual(INTENT_TYPES.general, []);
  const kinds = new Set(Object.values(INTENT_TYPES).flat());
  for (const kind of ['profile', 'preference', 'fact', 'experience', 'episode', 'task', 'knowledge']) {
    assert.ok(kinds.has(kind), `missing kind ${kind}`);
  }
});

test('scoreCandidate returns a finite score and every scoring feature', () => {
  const { score, features } = scoreCandidate(candidate({ exact: 1, subjectMatch: 0.5 }), 'how-to');
  assert.ok(Number.isFinite(score));
  for (const key of [
    'exact', 'subjectMatch', 'bm25', 'taskContextMatch', 'feedbackScore', 'scopePrecedence',
    'trust', 'recency', 'conflict', 'stale', 'duplicate', 'intentType', 'recallWeight',
    'decay', 'pinned', 'pinnedChars', 'useCount',
  ]) {
    assert.equal(typeof features[key], 'number', `feature ${key}`);
    assert.ok(Number.isFinite(features[key]!), `feature ${key} finite`);
  }
});

test('exact tiers are monotonic, clamped to 0..4 and worth 4.0 each', () => {
  const scores = [0, 1, 2, 3, 4].map(exact => scoreCandidate(candidate({ exact }), 'general').score);
  for (let index = 1; index < scores.length; index++) close(scores[index]! - scores[index - 1]!, 4, 'exact step');
  close(scoreCandidate(candidate({ exact: 99 }), 'general').score, scores[4]!, 'exact clamp');
  close(scoreCandidate(candidate({ exact: -1 }), 'general').score, scores[0]!, 'exact floor');
});

test('subjectMatch and taskContextMatch are monotonic (3.0 / 2.0)', () => {
  const subject = [0, 0.25, 0.5, 0.75, 1].map(subjectMatch => scoreCandidate(candidate({ subjectMatch }), 'general').score);
  for (let index = 1; index < subject.length; index++) close(subject[index]! - subject[index - 1]!, 3 * 0.25, 'subject step');
  const context = [0, 0.5, 1].map(taskContextMatch => scoreCandidate(candidate({ taskContextMatch }), 'general').score);
  close(context[1]! - context[0]!, 2 * 0.5, 'context step');
  close(context[2]! - context[1]!, 2 * 0.5, 'context step 2');
});

test('bm25 normalized score is monotonic (2.0 per full unit)', () => {
  const scores = [0, 0.5, 1].map(bm25 => scoreCandidate(candidate({ bm25 }), 'general').score);
  close(scores[1]! - scores[0]!, 1, 'bm25 step');
  close(scores[2]! - scores[1]!, 1, 'bm25 step 2');
  close(scoreCandidate(candidate({ bm25: 5 }), 'general').score, scores[2]!, 'bm25 clamp');
});

test('feedbackScore is monotonic across -1..1 with weight 1.5', () => {
  const negative = scoreCandidate(candidate({ feedbackScore: -1 }), 'general').score;
  const neutral = scoreCandidate(candidate({ feedbackScore: 0 }), 'general').score;
  const positive = scoreCandidate(candidate({ feedbackScore: 1 }), 'general').score;
  close(neutral - negative, 1.5);
  close(positive - neutral, 1.5);
  close(scoreCandidate(candidate({ feedbackScore: 9 }), 'general').score, positive, 'feedback clamp');
});

test('scopePrecedence and recency are monotonic (1.5 / 1.0)', () => {
  close(
    scoreCandidate(candidate({ scopePrecedence: 1 }), 'general').score -
      scoreCandidate(candidate({ scopePrecedence: 0 }), 'general').score,
    1.5,
  );
  close(
    scoreCandidate(candidate({ recency: 1 }), 'general').score -
      scoreCandidate(candidate({ recency: 0 }), 'general').score,
    1,
  );
});

test('trust tiers are monotonic and unknown/null is never strongest', () => {
  const order = [
    'external_import',
    'model_inferred',
    'model_supported',
    'quote_verified',
    'tool_verified',
    'source_verified',
    'user_confirmed',
    'user_explicit',
  ];
  const scores = order.map(trust => scoreCandidate(candidate({ trust }), 'general').score);
  for (let index = 1; index < scores.length; index++) assert.ok(scores[index]! >= scores[index - 1]!, `trust ${order[index]}`);
  assert.equal(TRUST_SCORE.user_explicit, 1);
  const { features } = scoreCandidate(candidate({ trust: null }), 'general');
  assert.equal(features.trust, TRUST_SCORE.unknown);
  close(scoreCandidate(candidate({ trust: 'not-a-tier' }), 'general').score, scoreCandidate(candidate({ trust: 'model_inferred' }), 'general').score);
});

test('conflict/stale/duplicate are exact penalties and use the penalty weights', () => {
  const base = scoreCandidate(candidate(), 'general').score;
  close(scoreCandidate(candidate({ conflict: true }), 'general').score - base, -3);
  close(scoreCandidate(candidate({ stale: true }), 'general').score - base, -2);
  close(scoreCandidate(candidate({ duplicate: true }), 'general').score - base, -1);
  close(scoreCandidate(candidate({ conflict: true, stale: true, duplicate: true }), 'general').score - base, -6);
  const custom = scoreCandidate(candidate({ conflict: true }), 'general', { conflict: 10 });
  close(custom.score - base, -10);
});

test('intentType boost is graded by the intent/type priority table', () => {
  const neutral = scoreCandidate(candidate({ kind: 'task' }), 'how-to').score;
  const experience = scoreCandidate(candidate({ kind: 'experience' }), 'how-to');
  const fact = scoreCandidate(candidate({ kind: 'fact' }), 'how-to');
  const episode = scoreCandidate(candidate({ kind: 'episode' }), 'how-to');
  assert.deepEqual(INTENT_TYPE_PRIORITY_BOOSTS, [1, 0.6, 0.3]);
  assert.equal(experience.features.intentType, 1);
  assert.equal(fact.features.intentType, 0.6);
  assert.equal(episode.features.intentType, 0.3);
  close(experience.score - neutral, 0.75);
  close(fact.score - neutral, 0.45);
  close(episode.score - neutral, 0.225);
  assert.ok(experience.score > fact.score && fact.score > episode.score && episode.score > neutral);
  for (const kind of ['profile', 'preference', 'fact', 'experience', 'episode', 'task', 'knowledge']) {
    assert.equal(scoreCandidate(candidate({ kind }), 'general').features.intentType, 0, `general ${kind} neutral`);
  }
});

test('neutral lifecycle precisely reproduces the blueprint formula', () => {
  const { score, features } = scoreCandidate(
    candidate({
      kind: 'preference',
      trust: 'user_confirmed',
      exact: 1,
      subjectMatch: 0.5,
      bm25: 0.4,
      taskContextMatch: 0.3,
      feedbackScore: -0.2,
      scopePrecedence: 0.8,
      recency: 0.25,
    }),
    'identity',
  );
  // 4*1 + 3*.5 + 2*.4 + 2*.3 + 1.5*(-.2) + 1.5*.8 + 1*.9 + 1*.25 + .75*.6
  close(score, 9.4);
  assert.equal(features.recallWeight, 1);
  assert.equal(features.decay, 1);
});

test('recallWeight and decay adjust lifecycle rank monotonically (neutral 1.0 = no change)', () => {
  const neutral = scoreCandidate(candidate(), 'general').score;
  assert.equal(scoreCandidate(candidate({ recallWeight: 1, decay: 1 }), 'general').score, neutral);
  const weights = [0.6, 1, 1.3].map(recallWeight => scoreCandidate(candidate({ recallWeight }), 'general').score);
  assert.ok(weights[0]! < weights[1]! && weights[1]! < weights[2]!);
  close(weights[1]! - weights[0]!, 0.4);
  close(weights[2]! - weights[1]!, 0.3);
  const decays = [0, 0.5, 1].map(decay => scoreCandidate(candidate({ decay }), 'general').score);
  assert.ok(decays[0]! < decays[1]! && decays[1]! < decays[2]!);
  close(decays[2]! - decays[1]!, 0.5);
});

test('rankCandidates orders by score, applies limit, keeps ties deterministic and does not mutate input', () => {
  const candidates = [
    candidate({ id: 'm-b', bm25: 0.9 }),
    candidate({ id: 'm-a', bm25: 0.1 }),
    candidate({ id: 'm-c', bm25: 0.5 }),
  ];
  const before = JSON.parse(JSON.stringify(candidates));
  const result = rankCandidates(candidates, { intent: 'general' });
  assert.deepEqual(result.ranked.map(item => item.id), ['m-b', 'm-c', 'm-a']);
  assert.deepEqual(candidates, before, 'input order/content unchanged');
  assert.equal(rankCandidates(candidates, { intent: 'general', limit: 2 }).ranked.length, 2);
  assert.deepEqual(rankCandidates(candidates, { intent: 'general', limit: 0 }).ranked, []);
  const tied = rankCandidates([candidate({ id: 'b' }), candidate({ id: 'a' })], { intent: 'general' });
  assert.deepEqual(tied.ranked.map(item => item.id), ['a', 'b']);
});

test('rankCandidates explain aligns with the ranked list and is deterministic', () => {
  const candidates = [candidate({ id: 'x', bm25: 0.8, exact: 1 }), candidate({ id: 'y', bm25: 0.2, conflict: true })];
  const first = rankCandidates(candidates, { intent: 'decision', limit: 1 });
  const second = rankCandidates(candidates, { intent: 'decision', limit: 1 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.explain.map(entry => entry.id), first.ranked.map(item => item.id));
  assert.equal(first.explain[0]!.id, 'x');
  assert.ok(Number.isFinite(first.explain[0]!.score));
  assert.ok(first.explain[0]!.reasons.length > 0);
  assert.throws(() => rankCandidates(candidates, { intent: 'general', limit: -1 }), RangeError);
  assert.throws(() => rankCandidates(candidates, { intent: 'nope' as RecallIntent }), RangeError);
});

test('explain reasons cover every non-zero feature, penalties and the rule version', () => {
  const { explain } = rankCandidates(
    [
      candidate({
        kind: 'experience',
        trust: 'user_explicit',
        exact: 2,
        subjectMatch: 1,
        bm25: 0.6,
        taskContextMatch: 0.5,
        feedbackScore: 0.5,
        scopePrecedence: 0.75,
        recency: 0.5,
        conflict: true,
        stale: true,
        duplicate: true,
        recallWeight: 1.2,
        decay: 0.8,
      }),
    ],
    { intent: 'how-to' },
  );
  const reasons = explain[0]!.reasons.join('\n');
  for (const expected of ['精确', 'subject', 'BM25', '任务上下文', '用户反馈', '范围', '信任', '新鲜度', '意图', '冲突', '过时', '重复', '召回权重', '衰减', '检索规则 v3']) {
    assert.ok(reasons.includes(expected), `missing explain reason: ${expected}`);
  }
  assert.ok(!/NaN|undefined/.test(reasons));
});

test('weights override tunes scores without mutating defaults or the override object', () => {
  const base = scoreCandidate(candidate({ exact: 1 }), 'general').score;
  const tuned = scoreCandidate(candidate({ exact: 1 }), 'general', { exact: 10 });
  close(tuned.score - base, 6);
  const override = { exact: 10 };
  scoreCandidate(candidate(), 'general', override);
  assert.deepEqual(override, { exact: 10 });
  assert.equal(DEFAULT_RANK_WEIGHTS.exact, 4);
  assert.throws(() => scoreCandidate(candidate(), 'general', { exact: -1 }), RangeError);
  assert.throws(() => scoreCandidate(candidate(), 'general', { invented: 1 } as never), RangeError);
});

test('applyBudget keeps pinned in a separate stable tier that never consumes body budget or count', () => {
  const p1 = record('p1', 'P1', { pinned: true });
  const a = record('a', 'AAAA');
  const p2 = record('p2', 'P2', { pinned: true });
  const result = applyBudget([p1, a, p2], { budget: { pinned: 100, directory: 10000, body: 1000, count: 1 } });
  assert.deepEqual(result.pinned.map(item => item.id), ['p1', 'p2']);
  assert.deepEqual(result.body.map(item => item.id), ['a']);
  assert.deepEqual(result.directory.map(item => item.id), ['a']);
  assert.equal(result.used.pinned, 4);
  assert.equal(result.used.body, 4);
  assert.ok(!result.omitted.some(item => item.id.startsWith('p')));
  const withoutPinned = applyBudget([a], { budget: { pinned: 100, directory: 10000, body: 1000, count: 1 } });
  assert.deepEqual(withoutPinned.body.map(item => item.id), ['a']);
});

test('applyBudget enforces the 1500 character pinned ceiling and omits with a readRef', () => {
  const big = record('big', 'x'.repeat(1500), { pinned: true });
  const extra = record('extra', 'y', { pinned: true, revision: 4 });
  const result = applyBudget([big, extra], { budget: { pinned: 1500, directory: 10000, body: 10000, count: 8 } });
  assert.deepEqual(result.pinned.map(item => item.id), ['big']);
  assert.equal(result.used.pinned, 1500);
  const omission = result.omitted.find(item => item.id === 'extra');
  assert.deepEqual(omission, { id: 'extra', reason: 'pinned-budget', readRef: { action: 'read.range', id: 'extra', revision: 4 } });
});

test('applyBudget directory pointers carry readRef/conditions and honour the directory budget', () => {
  const first = record('a', '正文内容', { revision: 3, title: '标题', kind: 'fact', conditions: ['仅测试环境'] });
  const second = record('b', '正文内容', { revision: 3, title: '标题', kind: 'fact' });
  const probe = applyBudget([first, second], { budget: { directory: 100000 } });
  assert.equal(probe.directory.length, 2);
  const pointer = probe.directory[0]!;
  const cost = JSON.stringify(pointer).length;
  assert.equal(pointer.id, 'a');
  assert.equal(pointer.revision, 3);
  assert.equal(pointer.fullLength, 4);
  assert.deepEqual(pointer.conditions, ['仅测试环境']);
  assert.equal('content' in pointer, false);
  const tight = applyBudget([first, second], { budget: { directory: cost + 1, body: 10000 } });
  assert.equal(tight.directory.length, 1);
  const omission = tight.omitted.find(item => item.id === 'b');
  assert.equal(omission?.reason, 'directory-budget');
  assert.deepEqual(omission?.readRef, { action: 'read.range', id: 'b', revision: 3 });
});

test('applyBudget admits body+complete conditions together or omits with readRef (no truncation)', () => {
  const conditions = ['仅测试环境', '不用于生产'];
  const full = record('full', '完整正文内容', { revision: 7, conditions });
  const required = renderedRecordChars(full);
  assert.equal(required, full.content.length + '\n适用条件：'.length + conditions.join('；').length);
  const tooSmall = applyBudget([full], { budget: { body: required - 1 } });
  assert.deepEqual(tooSmall.body, []);
  assert.deepEqual(tooSmall.omitted.find(item => item.id === 'full'), {
    id: 'full',
    reason: 'body-budget',
    readRef: { action: 'read.range', id: 'full', revision: 7 },
  });
  assert.deepEqual(tooSmall.directory[0]!.conditions, conditions);
  const exact = applyBudget([full], { budget: { body: required } });
  assert.equal(exact.body.length, 1);
  assert.equal(exact.body[0]!.content, full.content);
  assert.deepEqual(exact.body[0]!.conditions, conditions);
  assert.equal(exact.used.body, required);
});

test('applyBudget main count limit is 6 by default, clamps to 8 and handles 0', () => {
  const records = Array.from({ length: 9 }, (_, index) => record(`r${index}`, 'x'));
  const defaults = applyBudget(records, { budget: { directory: 100000, body: 100000 } });
  assert.equal(defaults.body.length, 6);
  assert.equal(defaults.omitted.filter(item => item.reason === 'record-limit').length, 3);
  const wide = applyBudget(records, { budget: { directory: 100000, body: 100000, count: 8 } });
  assert.equal(wide.body.length, 8);
  const clamped = applyBudget(records, { budget: { directory: 100000, body: 100000, count: 12 } });
  assert.equal(clamped.body.length, MAX_BUDGET_COUNT);
  const none = applyBudget(records, { budget: { directory: 100000, body: 100000, count: 0 } });
  assert.deepEqual(none.body, []);
  assert.equal(none.omitted.filter(item => item.reason === 'record-limit').length, 9);
});

test('applyBudget applies the 2-preference priority hook and keeps unknown-applicability preferences directory-only', () => {
  const normal = record('normal', '普通正文');
  const pref1 = record('pref1', '偏好一', { kind: 'preference' });
  const pref2 = record('pref2', '偏好二', { kind: 'preference' });
  const pref3 = record('pref3', '偏好三', { kind: 'preference' });
  const result = applyBudget([normal, pref1, pref2, pref3], {
    preferenceIds: ['pref2', 'pref1'],
    budget: { directory: 100000, body: 100000, count: 8 },
  });
  assert.deepEqual(result.body.map(item => item.id), ['pref2', 'pref1', 'normal']);
  assert.ok(result.directory.some(item => item.id === 'pref3'));
  assert.equal(result.omitted.find(item => item.id === 'pref3')?.reason, 'preference-applicability-unknown');
  assert.equal(MAX_PRIORITY_PREFERENCES, 2);
  const three = applyBudget([normal, pref1, pref2, pref3], {
    preferenceIds: ['pref2', 'pref1', 'pref3'],
    budget: { directory: 100000, body: 100000, count: 8 },
  });
  assert.deepEqual(three.body.map(item => item.id), ['pref2', 'pref1', 'normal', 'pref3']);
});

test('applyBudget is deterministic, keeps input intact and reports exact readRef ids/revisions', () => {
  const records = [record('old', '旧正文', { revision: 7 }), record('new', '新正文', { revision: 9 })];
  const before = JSON.parse(JSON.stringify(records));
  const first = applyBudget(records, { budget: { directory: 100000, body: 0 } });
  const second = applyBudget(records, { budget: { directory: 100000, body: 0 } });
  assert.deepEqual(first, second);
  assert.deepEqual(records, before);
  assert.deepEqual(first.omitted, [
    { id: 'old', reason: 'body-budget', readRef: { action: 'read.range', id: 'old', revision: 7 } },
    { id: 'new', reason: 'body-budget', readRef: { action: 'read.range', id: 'new', revision: 9 } },
  ]);
});

test('applyBudget validates budgets/measures and annotates directory review warnings from now', () => {
  const base = record('r1');
  assert.throws(() => applyBudget([base], { budget: { body: -1 } }), RangeError);
  assert.throws(() => applyBudget([base], { budget: { count: 1.5 } }), RangeError);
  assert.throws(() => applyBudget([base], { preferenceIds: 'r1' as never }), RangeError);
  // Existing MemoryRecord has optional conditions; applyBudget accepts it.
  const memoryRecordLike = [{ id: 'legacy', revision: 2, content: '旧版正文' }];
  const legacy = applyBudget(memoryRecordLike, { budget: { directory: 100000, body: 100000 } });
  assert.deepEqual(legacy.body.map(item => item.id), ['legacy']);
  assert.equal(legacy.directory[0]!.fullLength, 4);
  const merged = applyBudget([record('a'), record('b'), record('c')], { budget: { count: 2, directory: 100000, body: 100000 } });
  assert.equal(merged.body.length, 2);
  assert.throws(
    () => applyBudget([base], { measure: { body: () => Number.NaN } }),
    RangeError,
  );
  const now = Date.parse('2026-01-01T00:00:00.000Z');
  const stale = record('stale', 'x', { reviewAfter: '2020-01-01T00:00:00.000Z' });
  const expired = record('expired', 'x', { expiresAt: '2020-01-01T00:00:00.000Z' });
  const warned = applyBudget([stale, expired], { now, budget: { directory: 100000, body: 100000 } });
  assert.equal(warned.directory.find(item => item.id === 'stale')?.reason, 'review-due');
  assert.equal(warned.directory.find(item => item.id === 'expired')?.reason, 'expired');
});

test('zeroHitGuidance states the boundary and echoes only caller-provided suggestions', () => {
  const guidance = zeroHitGuidance({
    terms: ['Cedar', 'cedar', 'Cedar', '端口'],
    subjects: ['user.response.language'],
    aliases: ['DB', '数据库'],
  });
  assert.equal(guidance.split('\n')[0], ZERO_HIT_BOUNDARY);
  assert.ok(guidance.includes('零命中'));
  assert.ok(guidance.includes('不代表历史不存在'));
  assert.ok(guidance.includes('建议关键词：Cedar、端口'));
  assert.ok(guidance.includes('user.response.language'));
  assert.ok(guidance.includes('建议别名：DB、数据库'));
  assert.ok(!guidance.includes('找到'));
  assert.ok(!guidance.includes('memory_'));
  assert.equal(zeroHitGuidance({ terms: [], subjects: [], aliases: [] }).includes('建议关键词'), false);
});

test('zeroHitGuidance caps suggestions, tolerates junk and never fabricates', () => {
  const terms = Array.from({ length: 12 }, (_, index) => `kw-${index}`);
  const guidance = zeroHitGuidance({ terms: [...terms, '', '   ', 42 as never], subjects: [], aliases: [] });
  const suggestionLine = guidance.split('\n').find(line => line.startsWith('建议关键词：'))!;
  assert.equal(suggestionLine.split('、').length, MAX_GUIDANCE_SUGGESTIONS);
  assert.ok(guidance.includes('kw-7'));
  assert.ok(!guidance.includes('kw-8'));
  const empty = zeroHitGuidance({ terms: [], subjects: [], aliases: [] });
  assert.ok(empty.includes('建议提供 1–3 个有区分度关键词'));
  assert.ok(empty.includes('read.range'));
  assert.equal(empty, zeroHitGuidance({ terms: [], subjects: [], aliases: [] }));
});
