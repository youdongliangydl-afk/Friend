/**
 * Blueprint §17.2 memory benchmark scenarios.
 *
 * Every scenario drives a *real* `MemoryController` against a real SQLite file
 * in a throw-away directory and a deterministic fake `PluginContext` provider
 * (copied from the `packages/memory/test/*.test.ts` fixture style). No network,
 * no model, no embeddings: the numbers are an offline harness, not a real-model
 * quality benchmark.
 *
 * Scenario contract
 * -----------------
 *   buildScenarios()                    -> [{name, run}]
 *   await run(fixture)                  -> {pass,total,ok,detail,latencyMs,assertions}
 *
 * `fixture` is created by {@link createFixture} with `arm` = 'on' | 'off'. The
 * `off` arm is the paired counterfactual: the same probe code runs against an
 * empty memory database (nothing is seeded), so the delta between the arms is
 * the observable contribution of the memory system for that scenario.
 *
 * The fixture only seeds/drives memory when `arm === 'on'`; probe assertions are
 * written so they also evaluate safely (and mostly fail) on the empty control.
 *
 * Scenarios: update, conflict, stale, v1-miss, fork, autopublish, cross-project,
 * Chinese explicit/negative remember, episode/task (auto-pending until the P1
 * episode/task kind API lands).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryController, peekLearningJob } from '../../packages/memory/src/index.ts';

export const SCENARIO_NAMES = [
  'update',
  'conflict',
  'stale',
  'v1-miss',
  'fork',
  'autopublish',
  'cross-project',
  'Chinese',
  'episode-task',
];

const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const nowIso = () => new Date().toISOString();
const asArray = value => (Array.isArray(value) ? value : []);
const activeRecords = snapshot => asArray(snapshot?.memories).filter(record => record?.status === 'active');
const candidateRecords = snapshot => asArray(snapshot?.candidates).filter(record => record?.status === 'candidate');
const includesAll = (haystack, needles) => needles.every(value => haystack.includes(value));

function isExpired(record, at = Date.now()) {
  for (const value of [record?.validTo, record?.expiresAt]) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= at) return true;
  }
  return false;
}

// One process may host several fixtures (test file, paired arms). Keep the
// producer role reference-counted so an early close cannot desynchronise a
// still-running fixture.
let producerDepth = 0;
let producerPrevious;
function acquireProducerRole() {
  if (producerDepth++ === 0) {
    producerPrevious = process.env.FRIEND_PI_LEARNING_ROLE;
    process.env.FRIEND_PI_LEARNING_ROLE = 'producer';
  }
}
function releaseProducerRole() {
  if (producerDepth === 0) return;
  if (--producerDepth === 0) {
    if (producerPrevious === undefined) delete process.env.FRIEND_PI_LEARNING_ROLE;
    else process.env.FRIEND_PI_LEARNING_ROLE = producerPrevious;
    producerPrevious = undefined;
  }
}

/** Raw counters shared by every on-arm fixture in one benchmark run. */
export function createMetrics() {
  return {
    recalls: 0,
    recallHits: 0,
    expiredRecalls: 0,
    relevantFeedback: 0,
    recallLatencies: [],
    providerCalls: 0,
    requests: 0,
    activeRecords: 0,
    openConflicts: 0,
    duplicateActive: 0,
    verifiedAutoPublished: 0,
    autoCorrected: 0,
    autoUnintendedRevoked: 0,
    drillRevokes: 0,
    reviewDue: 0,
    reviewHandled: 0,
    reviewApi: false,
  };
}

/**
 * Real controller + real SQLite + fake provider. The fixture exposes only the
 * deterministic surfaces a scenario needs; it never reaches into private state.
 */
export function createFixture(options = {}) {
  const arm = options.arm === 'off' ? 'off' : 'on';
  const metrics = options.metrics ?? createMetrics();
  const dir = mkdtempSync(join(tmpdir(), 'friend-pi-memory-bench-'));
  acquireProducerRole();
  const items = [{
    id: 'seed',
    parentId: null,
    type: 'message',
    role: 'user',
    timestamp: nowIso(),
    text: options.seedText ?? '开始离线记忆基准。',
    userText: options.seedText ?? '开始离线记忆基准。',
  }];
  const journal = [];
  const events = [];
  let calls = 0;
  let requests = 0;
  let disposed = false;

  const ctx = {
    origin: options.origin ?? 'user',
    dataDir: dir,
    projectDir: dir,
    projectId: options.projectId ?? 'p',
    sessionId: options.sessionId ?? 's',
    runId: options.runId ?? 'bench-run',
    modelId: 'fixture/offline',
    isIdle: () => false,
    history: () => items,
    readSource(source) {
      const item = items.find(candidate => candidate.id === source.entryId);
      if (!item) throw new Error(`来源不存在：${source.entryId}`);
      return item;
    },
    complete: async () => {
      calls++;
      return '{"memories":[]}';
    },
    request: async () => {
      requests++;
      throw new Error('not installed');
    },
    emit: (event, data) => events.push({event, data}),
    notify: () => {},
    appendEntry: (type, data) => journal.push({type, data: structuredClone(data)}),
  };
  const controller = new MemoryController();

  function noteRecall(records) {
    if (arm !== 'on') return;
    metrics.recalls++;
    if (records.length) metrics.recallHits++;
    if (records.some(record => isExpired(record))) metrics.expiredRecalls++;
  }

  const fixture = {
    arm,
    dir,
    ctx,
    items,
    controller,
    metrics,
    journal,
    events,
    calls: () => calls,
    requests: () => requests,
    push(id, text, pushOptions = {}) {
      if (pushOptions.sessionId) ctx.sessionId = pushOptions.sessionId;
      const role = pushOptions.role ?? 'user';
      const item = {
        id,
        parentId: items.at(-1)?.id ?? null,
        type: 'message',
        role,
        timestamp: nowIso(),
        text,
        ...(role === 'user' ? {userText: text} : {}),
      };
      items.push(item);
      return item;
    },
    reply(proposals) {
      ctx.complete = async () => {
        calls++;
        return JSON.stringify({memories: proposals});
      };
    },
    async settle() {
      await controller.settled(ctx);
    },
    async drain(maxRounds = 80) {
      for (let step = 0; step < maxRounds; step++) {
        const job = peekLearningJob(dir);
        if (!job) return;
        const result = await controller.executeLearningJob(job.id, ctx);
        if (!result.executed) return;
        if (result.job?.state === 'failed' || result.job?.state === 'waiting_configuration') return;
      }
      throw new Error('learning did not settle');
    },
    async learn(proposals) {
      this.reply(proposals);
      await this.settle();
      await this.drain();
    },
    dispatch(action, input = {}, targetCtx = ctx) {
      return controller.dispatch(action, input, targetCtx);
    },
    save(input, targetCtx = ctx) {
      return controller.dispatch('save', {explicitRemember: true, ...input}, targetCtx);
    },
    search(input, targetCtx = ctx) {
      const query = typeof input === 'string' ? {query: input} : input;
      const started = performance.now();
      const records = controller.search(query, targetCtx);
      const latency = performance.now() - started;
      if (arm === 'on') {
        metrics.recallLatencies.push(round(latency));
        noteRecall(records);
      }
      return records;
    },
    select(input, targetCtx = ctx) {
      const started = performance.now();
      const selected = controller.select(input, targetCtx);
      const latency = performance.now() - started;
      if (arm === 'on') {
        metrics.recallLatencies.push(round(latency));
        noteRecall(asArray(selected?.records));
      }
      return selected;
    },
    snapshot(targetCtx = ctx) {
      return controller.snapshot(targetCtx);
    },
    async markRelevant(record, targetCtx = ctx) {
      if (!record) return false;
      try {
        await controller.dispatch('feedback', {id: record.id, revision: record.revision, kind: 'relevant'}, targetCtx);
        if (arm === 'on') metrics.relevantFeedback++;
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      if (disposed) return;
      disposed = true;
      try {
        await controller.dispose();
      } finally {
        releaseProducerRole();
        rmSync(dir, {recursive: true, force: true});
      }
    },
  };
  return fixture;
}

/** Aggregate end-of-scenario counters from an on-arm fixture (before close). */
export function collectFixtureMetrics(fixture) {
  if (!fixture || fixture.arm !== 'on') return;
  const metrics = fixture.metrics;
  metrics.providerCalls += fixture.calls();
  metrics.requests += fixture.requests();
  let snapshot;
  try {
    snapshot = fixture.snapshot();
  } catch {
    return;
  }
  const active = activeRecords(snapshot);
  metrics.activeRecords += active.length;
  metrics.openConflicts += asArray(snapshot?.conflicts).filter(conflict => conflict?.status === 'open').length;
  const groups = new Map();
  for (const record of active) {
    if (!record?.subjectKey) continue;
    const key = `${record.projectId}\u0000${record.scope}\u0000${record.subjectKey}\u0000${String(record.content).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const count of groups.values()) metrics.duplicateActive += Math.max(0, count - 1);
}

/** Build a deterministic model proposal understood by the learning pipeline. */
function proposal({kind = 'fact', title, content, subject, conditions = [], entryId = 'seed', quote = content, extra = {}}) {
  return {
    kind,
    title: title ?? content.slice(0, 60),
    content,
    ...(subject ? {subject} : {}),
    ...(conditions.length ? {conditions} : {}),
    sourceEntryIds: [entryId],
    sourceQuotes: {[entryId]: quote},
    ...extra,
  };
}

function resultOf(assertions, startedAt, detail) {
  const passed = assertions.filter(assertion => assertion.ok).length;
  return {
    pass: passed,
    total: assertions.length,
    ok: assertions.length > 0 && passed === assertions.length,
    detail,
    latencyMs: round(performance.now() - startedAt),
    assertions,
  };
}

function pendingResult(status, detail, startedAt) {
  return {
    pass: 0,
    total: 0,
    ok: false,
    pending: true,
    status,
    detail,
    latencyMs: round(performance.now() - startedAt),
    assertions: [],
  };
}

function makeChecks() {
  const assertions = [];
  const check = (name, ok, detail) => {
    assertions.push({name, ok: !!ok, ...(detail ? {detail} : {})});
    return !!ok;
  };
  return {assertions, check};
}

// ---------------------------------------------------------------------------
// 1. update — same subject, explicit correction: only the new value survives,
//    the old value stays queryable through version history.
// ---------------------------------------------------------------------------
export function updateScenario() {
  const OLD = '订单数据库必须使用 SQLite';
  const NEW = '订单数据库必须使用 PostgreSQL';
  return {
    name: 'update',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let record;
      let current;
      let versions = [];
      let historical;
      if (fixture.arm === 'on') {
        record = await fixture.save({
          title: '订单数据库引擎',
          content: OLD,
          subject: 'orders.database.engine',
          conditions: ['仅测试环境'],
        });
        await fixture.dispatch('update', {id: record.id, expectedRevision: record.revision, content: NEW});
        current = await fixture.dispatch('read', {id: record.id});
        versions = asArray(await fixture.dispatch('versions', {id: record.id}));
        historical = await fixture.dispatch('read', {id: record.id, revision: 1});
      }
      const newHits = fixture.search('PostgreSQL');
      const oldHits = fixture.search('SQLite');
      if (current) await fixture.markRelevant(current);

      check('current value is the corrected one', current?.content === NEW, current ? `status=${current.status} revision=${current.revision}` : 'no record');
      check('corrected value is recallable', newHits.some(hit => hit.id === record?.id));
      check('superseded value is not recalled', oldHits.length === 0, `${oldHits.length} hit(s)`);
      check('old value remains in version history', versions.some(version => version.content === OLD) && versions.length >= 2, `${versions.length} version(s)`);
      check('historical read returns the old value', historical?.content === OLD);
      return resultOf(assertions, startedAt, `OLD=${OLD} -> NEW=${NEW}; versions=${versions.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 2. conflict — two independent sources disagree without a correction: the old
//    value stays usable, the new value is isolated as a candidate conflict, and
//    retrieval never serves the unresolved value.
// ---------------------------------------------------------------------------
export function conflictScenario() {
  return {
    name: 'conflict',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      if (fixture.arm === 'on') {
        fixture.items[0].text = '项目事实：订单数据库实际使用 SQLite。';
        fixture.items[0].userText = fixture.items[0].text;
        fixture.reply([proposal({
          title: '订单数据库 SQLite',
          content: '订单数据库实际使用 SQLite',
          subject: 'orders.database.engine',
          quote: '项目事实：订单数据库实际使用 SQLite。',
        })]);
        await fixture.settle();
        await fixture.drain();

        fixture.push('fact2', '独立观察：订单数据库实际使用 PostgreSQL。', {sessionId: 's2'});
        fixture.reply([proposal({
          title: '订单数据库 PostgreSQL',
          content: '订单数据库实际使用 PostgreSQL',
          subject: 'orders.database.engine',
          entryId: 'fact2',
          quote: '独立观察：订单数据库实际使用 PostgreSQL。',
        })]);
        await fixture.settle();
        await fixture.drain();
      }
      const snapshot = fixture.snapshot();
      const oldActive = activeRecords(snapshot).find(record => String(record.content).includes('SQLite'));
      const newCandidate = candidateRecords(snapshot).find(record => String(record.content).includes('PostgreSQL'));
      const conflicts = asArray((await fixture.dispatch('conflict.list', {status: 'open'}).catch(() => ({conflicts: []})))?.conflicts);
      const oldHits = fixture.search('SQLite');
      const newHits = fixture.search('PostgreSQL');
      if (oldActive) await fixture.markRelevant(oldActive);

      check('old value stays active and usable', oldActive?.status === 'active');
      check('new value is isolated as a candidate', newCandidate?.status === 'candidate' && newCandidate?.conflictState === 'open');
      check('an open conflict object records the subject', conflicts.some(conflict => conflict?.subjectKey === 'orders.database.engine' && conflict?.status === 'open'));
      check('old value remains retrievable', oldHits.some(hit => hit.id === oldActive?.id));
      check('unresolved new value is never retrieved', newHits.length === 0, `${newHits.length} hit(s)`);
      return resultOf(assertions, startedAt, `oldActive=${oldActive?.id ?? 'none'} candidate=${newCandidate?.id ?? 'none'} conflicts=${conflicts.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 3. stale — an expired fact is never injected, but stays auditable/reviewable.
// ---------------------------------------------------------------------------
export function staleScenario() {
  return {
    name: 'stale',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let record;
      let readBack;
      if (fixture.arm === 'on') {
        record = await fixture.save({
          title: '临时访问令牌',
          content: '临时访问令牌仅本月有效。',
          validTo: '2020-01-01T00:00:00.000Z',
          reviewAfter: '2020-01-02T00:00:00.000Z',
        });
        readBack = await fixture.dispatch('read', {id: record.id});
      }
      const hits = fixture.search('访问令牌');
      const selected = fixture.select({query: '访问令牌'});
      const explain = await fixture.dispatch('search.explain', {query: '访问令牌'}).catch(() => undefined);
      const snapshot = fixture.snapshot();
      let reviewApi = false;
      let reviewEntries = [];
      let reviewResolved = false;
      try {
        const listed = await fixture.dispatch('review.list', {status: 'open', limit: 20});
        reviewApi = true;
        reviewEntries = asArray(listed?.reviews ?? listed?.items ?? listed?.candidates ?? listed);
      } catch {
        reviewApi = false;
      }
      const reviewEntry = reviewEntries.find(entry => (entry?.memory_id ?? entry?.memoryId ?? entry?.id) === record?.id);
      if (reviewApi && fixture.arm === 'on' && reviewEntry) {
        fixture.metrics.reviewApi = true;
        fixture.metrics.reviewDue++;
        try {
          const resolved = await fixture.dispatch('review.resolve', {id: String(reviewEntry.id), action: 'confirm'});
          reviewResolved = resolved?.review?.status === 'resolved';
          if (reviewResolved) fixture.metrics.reviewHandled++;
        } catch {
          reviewResolved = false;
        }
      }
      const snapshotVisible = [...asArray(snapshot?.memories), ...asArray(snapshot?.candidates)].some(entry => entry?.id === record?.id);
      const reviewVisible = reviewApi && !!reviewEntry;
      const visible = reviewVisible || snapshotVisible;
      const excludedByValidity = asArray(explain?.excluded).some(entry => entry?.id === record?.id && String(entry?.reason) === 'validity');

      check('expired fact is not recalled', hits.length === 0, `${hits.length} hit(s)`);
      check('expired fact is not selected into a body', asArray(selected?.records).length === 0);
      check('search.explain excludes the fact by validity', excludedByValidity);
      check('expired fact remains visible for review', visible);
      check('due review can be resolved through the review queue', !reviewApi || reviewResolved);
      check('read keeps the stale record auditable', typeof readBack?.content === 'string' && readBack.content.includes('访问令牌'));
      return resultOf(assertions, startedAt, `reviewApi=${reviewApi} reviewResolved=${reviewResolved} visible=${visible}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 4. v1-miss — alias / subject / task-context recall works without vectors; a
//    pure synonym query is recorded as the known lexical gap (not a failure).
// ---------------------------------------------------------------------------
export function v1MissScenario() {
  return {
    name: 'v1-miss',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let record;
      if (fixture.arm === 'on') {
        record = await fixture.save({
          title: '订单库引擎',
          content: '订单库数据库使用 PostgreSQL 17。',
          aliases: ['orders db', 'orders database'],
          subject: 'orders.database.engine',
          conditions: ['仅测试环境'],
        });
      }
      const aliasHits = fixture.search('orders db');
      const subjectHits = fixture.search('orders.database');
      const contextSelected = fixture.select({
        query: '如何升级',
        taskContext: {goal: '订单库 PostgreSQL 迁移', entities: ['orders.database.engine']},
      });
      const contextHits = asArray(contextSelected?.records);
      const plainHits = fixture.search('如何升级');
      const synonymHits = fixture.search('报账被拒');
      const firstHit = aliasHits[0] ?? subjectHits[0];
      if (firstHit) await fixture.markRelevant(firstHit);

      check('alias query recalls the record', aliasHits.some(hit => hit.id === record?.id), `hits=${aliasHits.length}`);
      check('subject-style alias query recalls the record', subjectHits.some(hit => hit.id === record?.id), `hits=${subjectHits.length}`);
      check('task context alone supplies the recall terms', contextHits.some(hit => hit.id === record?.id), `hits=${contextHits.length}`);
      check('query without matching context stays a zero hit', plainHits.length === 0);
      check('pure synonym query is a documented lexical gap', synonymHits.length === 0, `synonymOnlyMiss=${synonymHits.length === 0}`);
      return resultOf(assertions, startedAt, `alias=${aliasHits.length} subject=${subjectHits.length} context=${contextHits.length} synonym=${synonymHits.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 5. fork — forget, then a forked session re-words/re-quotes the same fact: it
//    must not revive, not even as a candidate.
// ---------------------------------------------------------------------------
export function forkScenario() {
  // Long enough that a one-word substitution in the fork keeps the CJK token
  // family above the M03 Jaccard threshold; the quote bytes still differ.
  const ORIGINAL = '数据库写操作必须串行执行，避免并发冲突。迁移任务读取旧表时必须使用只读事务，禁止在迁移窗口内写入业务数据。';
  const REWRITE = '数据库写操作必须串行执行，避免并发冲突。迁移任务读取旧表时需要使用只读事务，禁止在迁移窗口内写入业务数据。';
  const PUNCTUATION_REWRITE = '数据库写操作必须串行执行,避免并发冲突。迁移任务读取旧表时必须使用只读事务,禁止在迁移窗口内写入业务数据。';
  return {
    name: 'fork',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let forgottenId;
      let beforeHits = [];
      let readAfterForget = 'missing';
      if (fixture.arm === 'on') {
        const record = await fixture.save({
          title: '数据库写入约束',
          content: ORIGINAL,
          sources: [{sessionId: fixture.ctx.sessionId, entryId: 'seed'}],
        });
        forgottenId = record.id;
        beforeHits = fixture.search('串行');
        await fixture.dispatch('forget', {id: record.id, expectedRevision: record.revision});
        try {
          readAfterForget = (await fixture.dispatch('read', {id: record.id})).content;
        } catch {
          readAfterForget = 'missing';
        }
        // Fork attempt 1: same meaning, punctuation/quote bytes changed.
        fixture.push('fork-punctuation', PUNCTUATION_REWRITE, {sessionId: 'fork-1'});
        fixture.reply([proposal({
          kind: 'experience',
          title: '数据库写入约束（换引文）',
          content: PUNCTUATION_REWRITE,
          entryId: 'fork-punctuation',
          quote: PUNCTUATION_REWRITE,
        })]);
        await fixture.settle();
        await fixture.drain();
        // Fork attempt 2: a substituted word plus the original tail.
        fixture.push('fork-rewrite', REWRITE, {sessionId: 'fork-2'});
        fixture.reply([proposal({
          kind: 'experience',
          title: '数据库写入约束（换词）',
          content: REWRITE,
          entryId: 'fork-rewrite',
          quote: REWRITE,
        })]);
        await fixture.settle();
        await fixture.drain();
      }
      const afterForgetHits = fixture.search('串行');
      const snapshot = fixture.snapshot();
      const revivedActive = activeRecords(snapshot).filter(record => String(record.content).includes('串行'));
      const revivedCandidate = candidateRecords(snapshot).filter(record => String(record.content).includes('串行'));
      const revivedHits = fixture.search('只读事务');

      check('the fact was active and recallable before forgetting', beforeHits.length > 0, `${beforeHits.length} hit(s)`);
      check('forgetting removes the record from reads', readAfterForget === 'missing' && forgottenId !== undefined);
      check('the forgotten fact is not recalled afterwards', afterForgetHits.length === 0, `${afterForgetHits.length} hit(s)`);
      check('forked re-word/re-quote does not revive an active record', revivedActive.length === 0);
      check('forked rewrite does not become a candidate', revivedCandidate.length === 0, `${revivedCandidate.length} candidate(s)`);
      check('forked rewrite is not retrievable', revivedHits.length === 0);
      return resultOf(assertions, startedAt, `forgotten=${forgottenId ?? 'none'} revivedActive=${revivedActive.length} revivedCandidate=${revivedCandidate.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 6. autopublish — a high-confidence user fact is published with an audit row;
//    a low-confidence guess stays candidate; a batch revoke retires the record
//    and suppression prevents re-learning it.
// ---------------------------------------------------------------------------
export function autopublishScenario() {
  const HIGH = '数据库必须使用 SQLite';
  const LOW = '缓存可能使用 Redis';
  const EXPERIENCE = '上次迁移先备份再执行，结果成功';
  return {
    name: 'autopublish',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let high;
      let highExperience;
      let low;
      let revoked = [];
      let publishAudit;
      if (fixture.arm === 'on') {
        fixture.items[0].text = '数据库必须使用 SQLite。上次迁移先备份再执行，结果成功。';
        fixture.items[0].userText = fixture.items[0].text;
        fixture.push('guess', '我猜测缓存可能使用 Redis。', {role: 'assistant'});
        fixture.reply([
          proposal({
            title: '数据库引擎',
            content: HIGH,
            subject: 'project.db.engine',
            quote: '数据库必须使用 SQLite。',
          }),
          proposal({
            kind: 'experience',
            title: '迁移执行经验',
            content: EXPERIENCE,
            subject: 'migration.run.experience',
            quote: '上次迁移先备份再执行，结果成功。',
          }),
          proposal({
            title: '缓存引擎猜测',
            content: LOW,
            subject: 'project.cache.engine',
            entryId: 'guess',
            quote: '我猜测缓存可能使用 Redis。',
          }),
        ]);
        await fixture.settle();
        await fixture.drain();
        let snapshot = fixture.snapshot();
        high = activeRecords(snapshot).find(record => record.content === HIGH);
        highExperience = activeRecords(snapshot).find(record => record.content === EXPERIENCE);
        low = candidateRecords(snapshot).find(record => record.content === LOW);
        publishAudit = asArray(snapshot?.autoPublish?.audit).find(row => row?.action === 'publish' && row?.memoryId === high?.id);
        for (const published of [high, highExperience]) {
          if (published?.status === 'active' && published?.autoPublished === true) {
            fixture.metrics.verifiedAutoPublished++;
            await fixture.markRelevant(published);
          }
        }
        const batchKey = publishAudit?.batchKey;
        if (batchKey) {
          try {
            const result = await fixture.dispatch('autoPublish.revoke', {batchKey, reason: 'benchmark rollback drill'});
            revoked = asArray(result?.revoked);
            fixture.metrics.drillRevokes += revoked.length;
          } catch {
            revoked = [];
          }
        }
        // Re-learning the revoked value must not revive it.
        fixture.push('relearn', '数据库必须使用 SQLite。', {sessionId: 's2'});
        fixture.reply([proposal({
          title: '数据库引擎再次学习',
          content: HIGH,
          subject: 'project.db.engine',
          entryId: 'relearn',
          quote: '数据库必须使用 SQLite。',
        })]);
        await fixture.settle();
        await fixture.drain();
      }
      const afterRevokeHits = fixture.search('SQLite');
      const finalSnapshot = fixture.snapshot();
      const revivedActive = activeRecords(finalSnapshot).filter(record => record.content === HIGH);

      check('high-confidence fact is auto-published', high?.status === 'active' && high?.autoPublished === true);
      check('high-confidence experience is auto-published', highExperience?.status === 'active' && highExperience?.autoPublished === true);
      check('low-confidence guess never auto-publishes', low?.status === 'candidate', low ? `status=${low.status}` : 'no record');
      check('publish audit carries a rollback token', typeof publishAudit?.rollbackToken === 'string' && publishAudit.rollbackToken.length >= 32);
      check('bulk revoke retires both auto-published records', revoked.includes(high?.id) && revoked.includes(highExperience?.id));
      check('revoked value is no longer recalled', afterRevokeHits.length === 0, `${afterRevokeHits.length} hit(s)`);
      check('revoked value cannot be revived by re-learning', revivedActive.length === 0);
      return resultOf(assertions, startedAt, `high=${high?.id ?? 'none'} experience=${highExperience?.id ?? 'none'} low=${low?.id ?? 'none'} revoked=${revoked.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 7. cross-project — personal preferences travel with the user; project facts
//    never leak into another project.
// ---------------------------------------------------------------------------
export function crossProjectScenario() {
  return {
    name: 'cross-project',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let preference;
      let fact;
      if (fixture.arm === 'on') {
        preference = await fixture.save({
          kind: 'preference',
          scope: 'personal',
          title: '中文解释偏好',
          content: '今后默认用中文解释。',
        });
        fact = await fixture.save({
          kind: 'fact',
          title: '项目数据库',
          content: '本项目必须使用 SQLite。',
        });
      }
      const otherProject = {...fixture.ctx, projectId: 'p2', sessionId: 'p2-s', runId: 'bench-p2'};
      const preferenceHits = fixture.search('中文', otherProject);
      const selected = fixture.select({query: '请用中文解释这个问题'}, otherProject);
      const leakHits = fixture.search('SQLite', otherProject);
      const ownHits = fixture.search('SQLite');
      const preferenceHit = preferenceHits.find(hit => hit.id === preference?.id);
      if (preferenceHit) await fixture.markRelevant(preferenceHit, otherProject);

      check('personal preference is available in another project', preferenceHits.some(hit => hit.id === preference?.id));
      check('personal preference is selected in another project', asArray(selected?.records).some(record => record.id === preference?.id));
      check('project fact does not leak to another project', leakHits.length === 0 && !leakHits.some(hit => hit.id === fact?.id), `${leakHits.length} hit(s)`);
      check('project fact remains available in its own project', ownHits.some(hit => hit.id === fact?.id));
      return resultOf(assertions, startedAt, `pref=${preference?.id ?? 'none'} fact=${fact?.id ?? 'none'} leak=${leakHits.length}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 8. Chinese — explicit remember works; negated remember is never confirmed.
// ---------------------------------------------------------------------------
export function chineseScenario() {
  return {
    name: 'Chinese',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      let positive;
      let negative;
      let negativePreferenceRejected = false;
      if (fixture.arm === 'on') {
        fixture.ctx.origin = 'agent';
        fixture.push('remember', '请帮我记住：项目代号是 CedarArchive。');
        positive = await fixture.dispatch('save', {
          title: '项目代号',
          content: '项目代号是 CedarArchive',
          explicitRemember: true,
        });
        fixture.push('negative', '不要记住：临时演示账号是 demo-user。');
        negative = await fixture.dispatch('save', {
          title: '临时账号',
          content: '临时演示账号是 demo-user',
          explicitRemember: true,
        });
        fixture.push('negative-preference', '请不要记住我的个人偏好。');
        try {
          await fixture.dispatch('save', {
            kind: 'preference',
            scope: 'personal',
            title: '英文解释偏好',
            content: '我偏好英文解释。',
            explicitRemember: true,
          });
          negativePreferenceRejected = false;
        } catch {
          negativePreferenceRejected = true;
        }
      }
      const positiveHits = fixture.search('CedarArchive');
      const negativeHits = fixture.search('demo-user');
      const snapshot = fixture.snapshot();
      const negativeActive = activeRecords(snapshot).filter(record => String(record.content).includes('demo-user'));
      if (positive) await fixture.markRelevant(positive);

      check('explicit Chinese remember creates an active memory', positive?.status === 'active');
      check('explicit Chinese remember is recallable', positiveHits.some(hit => hit.id === positive?.id));
      check('negative remember is never activated', negativeActive.length === 0);
      check('negative remember is not recallable', negativeHits.length === 0, `${negativeHits.length} hit(s)`);
      check('negative remember blocks personal-preference confirmation', negativePreferenceRejected);
      return resultOf(assertions, startedAt, `positive=${positive?.status ?? 'none'} negative=${negative?.status ?? 'none'}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 9. episode/task — P1 kinds. Exercise the real kind API when it lands; older
//    checkouts report a structured PENDING status instead of faking a pass.
// ---------------------------------------------------------------------------
let episodeSupport;
export function episodeTaskScenario() {
  const EPISODE_CONTENT = '本次会话完成了迁移演练，并记录了备份复核事项。';
  const TASK_CONTENT = '复核迁移备份文件与旧 writer 围栏。';
  return {
    name: 'episode-task',
    async run(fixture) {
      const startedAt = performance.now();
      const {assertions, check} = makeChecks();
      const schemaVersion = Number(fixture.snapshot()?.schemaVersion ?? 0);
      let episode;
      let task;
      if (fixture.arm === 'on' && episodeSupport === undefined) {
        if (schemaVersion < 5) {
          episodeSupport = false;
        } else {
          try {
            const probe = await fixture.dispatch('save', {
              kind: 'episode',
              title: '迁移演练会话',
              content: EPISODE_CONTENT,
              conditions: ['会话结束'],
              explicitRemember: true,
            });
            episodeSupport = probe?.kind === 'episode';
            if (episodeSupport) episode = probe;
          } catch {
            episodeSupport = false;
          }
        }
      }
      if (fixture.arm === 'off' && episodeSupport === undefined) {
        return pendingResult('PENDING_P1_EPISODE_TASK', 'episode/task support is probed on the on arm first', startedAt);
      }
      if (!episodeSupport) {
        return pendingResult(
          schemaVersion < 5 ? 'PENDING_SCHEMA_V5' : 'PENDING_P1_EPISODE_TASK',
          'episode/task kind API is not available yet; scenario is skipped rather than reported as passing',
          startedAt,
        );
      }
      if (fixture.arm === 'on') {
        episode ??= await fixture.dispatch('save', {
          kind: 'episode',
          title: '迁移演练会话',
          content: EPISODE_CONTENT,
          conditions: ['会话结束'],
          explicitRemember: true,
        });
        task = await fixture.dispatch('save', {
          kind: 'task',
          title: '复核迁移备份',
          content: TASK_CONTENT,
          conditions: ['状态：open'],
          explicitRemember: true,
        });
      }
      const crossSession = {...fixture.ctx, sessionId: 'episode-recall'};
      const episodeHits = fixture.search('迁移演练', crossSession);
      const taskHits = fixture.search('迁移备份', crossSession);
      const snapshot = fixture.snapshot();
      let pinRejected = false;
      if (fixture.arm === 'on' && episode && task) {
        let rejected = 0;
        for (const record of [episode, task]) {
          try {
            await fixture.dispatch('pin', {id: record.id});
          } catch {
            rejected++;
          }
        }
        pinRejected = rejected === 2;
      }
      const episodeTtl = episode?.expiresAt ? Date.parse(episode.expiresAt) - Date.parse(episode.createdAt) : NaN;
      const taskTtl = task?.expiresAt ? Date.parse(task.expiresAt) - Date.parse(task.createdAt) : NaN;

      check('episode kind is accepted and preserved', episode?.kind === 'episode');
      check('task kind is accepted and preserved', task?.kind === 'task');
      check('episode keeps its trigger conditions', asArray(episode?.conditions).includes('会话结束'));
      check('task keeps its state conditions', asArray(task?.conditions).includes('状态：open'));
      check('episode is recallable across sessions', episodeHits.some(hit => hit.id === episode?.id));
      check('task is recallable across sessions', taskHits.some(hit => hit.id === task?.id));
      check('episode/task cannot enter the pinned prefix (low authority)', pinRejected);
      check('episode TTL is longer than task TTL', Number.isFinite(episodeTtl) && Number.isFinite(taskTtl) && episodeTtl > taskTtl, `episode=${Math.round((episodeTtl / 86400000) || 0)}d task=${Math.round((taskTtl / 86400000) || 0)}d`);
      check('episode/task records are not surfaced as auto-published facts', !activeRecords(snapshot).some(record => (record.kind === 'episode' || record.kind === 'task') && record.autoPublished === true));
      return resultOf(assertions, startedAt, `episode=${episode?.id ?? 'none'} task=${task?.id ?? 'none'} ttl=${Math.round((episodeTtl / 86400000) || 0)}/${Math.round((taskTtl / 86400000) || 0)}d`);
    },
  };
}

/** All builders, in blueprint §17.2 order. */
export const SCENARIO_BUILDERS = [
  updateScenario,
  conflictScenario,
  staleScenario,
  v1MissScenario,
  forkScenario,
  autopublishScenario,
  crossProjectScenario,
  chineseScenario,
  episodeTaskScenario,
];

/** Instantiate every scenario (fresh objects, no shared mutable state). */
export function buildScenarios() {
  return SCENARIO_BUILDERS.map(builder => builder());
}

/** Build one scenario by name; undefined when unknown. */
export function scenarioByName(name) {
  return buildScenarios().find(scenario => scenario.name === name);
}
