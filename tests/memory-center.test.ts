import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_PUBLISH_GATE_LABELS,
  AUTO_PUBLISH_MODES,
  CONFLICT_RESOLUTIONS,
  EMPTY_RECORD_FILTERS,
  MEMORY_CENTER_ACTIONS,
  MEMORY_CENTER_TABS,
  MEMORY_CENTER_TAB_IDS,
  PINNED_CHAR_LIMIT,
  RECEIPT_STAGE_VIEWS,
  REVIEW_REASON_LABELS,
  memoryAuditView,
  memoryAutoPublishRevokeInput,
  memoryAutoPublishSettingsInput,
  memoryAutoPublishView,
  memoryBulkPinRequests,
  memoryBulkToggleRequests,
  memoryCandidateAcceptRequest,
  memoryCandidateEditRequest,
  memoryCandidateGateView,
  memoryCandidateGroups,
  memoryCandidateRejectRequest,
  memoryCandidateView,
  memoryCenterActionKind,
  memoryCenterActionsOfKind,
  memoryCenterDataState,
  memoryCenterEmptyMessage,
  memoryCenterErrorHint,
  memoryCenterSnapshotView,
  memoryCenterTab,
  memoryCenterTabBadge,
  memoryCenterTabNeighbor,
  memoryConflictImpactView,
  memoryConflictResolveAllowed,
  memoryConflictResolveInput,
  memoryConflictView,
  memoryConflictViews,
  memoryCountText,
  memoryDerivedRefs,
  memoryDetailRevisionDiff,
  memoryDetailSources,
  memoryDiagnosticsRequest,
  memoryExplainRequest,
  memoryExplainView,
  memoryExportInput,
  memoryGraphFromSnapshot,
  memoryGraphLayout,
  memoryGraphRequest,
  memoryGraphView,
  memoryImpactCommitInput,
  memoryImpactStale,
  memoryImpactView,
  memoryImportInput,
  memoryKindLabel,
  memoryKindPolicyRows,
  memoryLearningControlRequest,
  memoryLearningJobView,
  memoryLearningJobViews,
  memoryListInput,
  memoryMergeInput,
  memoryPinEligible,
  memoryPinRequest,
  memoryPinnedChars,
  memoryPinnedView,
  memoryReadInput,
  memoryReadRangeInput,
  memoryReadSourcesInput,
  memoryRecordIsActive,
  memoryRecordList,
  memoryRecordMatchesFilters,
  memoryRecordPage,
  memoryRecordStateView,
  memoryRecordSubject,
  memoryRecordSummary,
  memoryReviewActions,
  memoryReviewBatchInputs,
  memoryReviewItems,
  memoryReviewListInput,
  memoryReviewResolveInput,
  memoryReviewsDue,
  memoryScopeLabel,
  memorySearchExplainInput,
  memorySearchInput,
  memorySplitInput,
  memoryStatusLabel,
  memorySupersedeInput,
  memoryTrustLabel,
  memoryUsageRequest,
  memoryUsageView,
  memoryVersionsInput,
} from '../apps/desktop/src/renderer/memory-center-model.js';

type Json = Record<string, unknown>;
const asRecordList = (value: unknown): Json[] => Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const record = (id: string, overrides: Json = {}): Json => ({
  id,
  revision: 1,
  kind: 'fact',
  scope: 'project',
  status: 'active',
  enabled: true,
  title: id,
  content: `正文 ${id}`,
  conditions: [],
  sources: [],
  parentIds: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

const candidate = (id: string, overrides: Json = {}): Json => record(id, { status: 'candidate', enabled: false, ...overrides });

const usageFixture = () => ({
  runId: 'run-1',
  evidenceBoundary: '分别记录阶段；读取收据不代表模型采纳。',
  receipts: [
    { operationId: 'op-1', stage: 'prepared', directory: [{ id: 'fact-a', revision: 1 }], records: [{ id: 'fact-a', revision: 1 }] },
    { operationId: 'op-1', stage: 'injected-to-context', records: [{ id: 'fact-a', revision: 1 }] },
  ],
  stageReceipts: [
    { operationId: 'op-1', stage: 'prepared', directory: [{ id: 'fact-a', revision: 1 }], records: [{ id: 'fact-a', revision: 1 }] },
    { operationId: 'op-2', stage: 'request-prepared', records: [{ id: 'pref-b', revision: 1 }] },
    { operationId: 'op-2', stage: 'response-observed', records: [{ id: 'pref-b', revision: 1 }] },
    {
      operationId: 'op-3',
      stage: 'tool-read',
      records: [{ id: 'inactive-c', revision: 2 }],
      omitted: [
        { id: 'inactive-c', reason: 'inactive', readRef: { revision: 2 } },
        { id: 'fact-a', reason: 'body-budget', readRef: { action: 'read.range', id: 'fact-a', revision: 1 } },
      ],
    },
  ],
  sourceReceipts: [{ receiptId: 'sr-1' }],
});

const snapshotFixture = (overrides: Json = {}): Json => ({
  schemaVersion: 5,
  epoch: 3,
  memories: [
    record('fact-a', {
      title: '构建命令',
      content: '构建使用 pnpm build。',
      pinned: true,
      updatedAt: '2026-10-10T00:00:00.000Z',
      trust: 'source_verified',
      autoPublished: true,
      score: 95,
    }),
    record('pref-b', {
      kind: 'preference',
      scope: 'personal',
      title: '中文回复',
      content: '默认使用中文回复。',
      updatedAt: '2026-10-09T00:00:00.000Z',
    }),
    record('inactive-c', { status: 'inactive', enabled: false, title: '旧命令', updatedAt: '2026-10-08T00:00:00.000Z' }),
    record('profile-d', { kind: 'profile', title: '用户画像', content: '用户是工程师。', updatedAt: '2026-10-07T00:00:00.000Z' }),
  ],
  candidates: [
    candidate('cand-1', {
      title: '新事实候选',
      content: '测试使用 node --test。',
      jobId: 'job-1',
      score: 82,
      conditions: ['Node 24'],
      sources: [{ sessionId: 's1', entryId: 'e1' }],
      invalidatedReason: '未通过门禁 #6 置信分',
      updatedAt: '2026-10-11T00:00:00.000Z',
    }),
    candidate('cand-2', { title: '无门禁候选', content: '另一个候选。', kind: 'experience', updatedAt: '2026-10-06T00:00:00.000Z' }),
    record('invalid-1', {
      status: 'invalidated',
      enabled: false,
      title: '失效记录',
      invalidatedReason: '原始来源已删除',
      updatedAt: '2026-10-05T00:00:00.000Z',
    }),
  ],
  conflicts: [
    {
      id: 'conf-1',
      status: 'open',
      subjectKey: 'build.command',
      scope: 'project',
      openedAt: '2026-10-11T08:00:00.000Z',
      openedBy: 'learning',
      sides: [
        { side: 'left', memoryId: 'fact-a', revision: 1, claimHash: 'left-hash', supportScore: 0.9 },
        { side: 'right', memoryId: 'cand-1', revision: 1, claimHash: 'right-hash', supportScore: 0.4 },
      ],
      resolution: null,
    },
    { id: 'conf-resolved', status: 'resolved', subjectKey: 'other', sides: [], resolution: 'keep_left' },
  ],
  learning: {
    enabled: true,
    paused: false,
    running: false,
    queued: 2,
    jobs: [
      {
        id: 'job-1',
        stage: 'publish',
        state: 'failed',
        attempts: 2,
        updatedAt: '2026-10-12T00:00:00.000Z',
        error: '来源已撤回',
        sources: [{ sessionId: 's1', entryId: 'e1', start: 0, end: 12 }],
        pendingRanges: [{ sessionId: 's2', entryId: 'e2' }],
        progress: { proposals: 4, processed: 3, published: 1, candidates: 1, rejected: 1, pending: 1 },
        budget: { calls: 3, maxCalls: 6, tokens: 900 },
        proposalLedger: [
          { id: 'p1', state: 'rejected', original: { title: '伪造引文' }, reason: '引文不能定位' },
          { id: 'p2', state: 'pending', original: { title: '待核对提案' } },
        ],
      },
    ],
  },
  autoPublish: {
    policy: { id: 'auto:proj', projectId: 'proj', mode: 'standard', minScore: 70, maxAutoPerDay: 10, requireReview: false, version: 4, updatedAt: '2026-10-12T00:00:00.000Z' },
    stats: { autoPublished: 3, revoked: 1, corrected: 0 },
    audit: [
      {
        id: 'audit-1',
        memoryId: 'cand-1',
        revision: 2,
        action: 'candidate',
        mode: 'standard',
        policyVersion: 4,
        score: 82,
        gates: [
          { id: 1, name: 'authority', pass: true },
          { id: 6, name: 'confidence', pass: false, reason: '确定性分数 60 低于阈值 70' },
        ],
        trust: 'model_supported',
        authority: 'model',
        actor: 'system',
        createdAt: '2026-10-12T00:00:00.000Z',
      },
      {
        id: 'audit-2',
        memoryId: 'fact-a',
        revision: 1,
        action: 'publish',
        mode: 'standard',
        policyVersion: 4,
        score: 95,
        gates: [{ id: 1, name: 'authority', pass: true }],
        trust: 'source_verified',
        authority: 'source',
        actor: 'system',
        createdAt: '2026-10-09T00:00:00.000Z',
        rollbackToken: 'rollback-token',
      },
    ],
  },
  pinned: ['fact-a'],
  reviews: [
    { id: 'review-1', memoryId: 'fact-a', revision: 1, reason: 'review-after', priority: 70, dueAt: '2026-10-15T00:00:00.000Z', status: 'open' },
    { id: 'review-2', memoryId: 'inactive-c', revision: 2, reason: 'expired', priority: 90, dueAt: '2026-10-01T00:00:00.000Z', status: 'open' },
  ],
  derivedRefs: [{ id: 'child-1', parentIds: ['fact-a'], status: 'inactive', revision: 1 }],
  feedback: [{ id: 'fact-a', kind: 'relevant' }],
  usage: usageFixture(),
  ...overrides,
});

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const view = () => memoryCenterSnapshotView(snapshotFixture(), { now: NOW });

/* ------------------------------------------------------------------ */
/* Nine-tab registry                                                   */
/* ------------------------------------------------------------------ */

test('nine-tab registry exposes the exact product tabs in order', () => {
  assert.equal(MEMORY_CENTER_TABS.length, 9);
  assert.deepEqual(MEMORY_CENTER_TABS.map(tab => tab.label), ['概览', '记录', '候选', '冲突', '复审', '学习', '图谱', '用量诊断', '设置']);
  assert.deepEqual(MEMORY_CENTER_TAB_IDS, ['overview', 'records', 'candidates', 'conflicts', 'reviews', 'learning', 'graph', 'usage', 'settings']);
  assert.equal(new Set(MEMORY_CENTER_TABS.map(tab => tab.id)).size, 9);
  for (const tab of MEMORY_CENTER_TABS) assert.ok(tab.description.length > 0, tab.id);
  assert.equal(memoryCenterTab('conflicts')?.label, '冲突');
  assert.equal(memoryCenterTab('nope'), undefined);
});

test('tab keyboard navigation wraps in both directions and keeps a valid tab', () => {
  assert.equal(memoryCenterTabNeighbor('overview', -1), 'settings');
  assert.equal(memoryCenterTabNeighbor('settings', 1), 'overview');
  assert.equal(memoryCenterTabNeighbor('records', 1), 'candidates');
  assert.equal(memoryCenterTabNeighbor('candidates', -4), 'usage');
  assert.equal(memoryCenterTabNeighbor('usage', 0), 'usage');
});

test('tab badges count actionable items and never invent a count for featureless tabs', () => {
  const value = view();
  assert.equal(memoryCenterTabBadge('candidates', value), value.candidates.length);
  assert.equal(memoryCenterTabBadge('conflicts', value), 1);
  assert.equal(memoryCenterTabBadge('reviews', value), 2);
  assert.equal(memoryCenterTabBadge('learning', value), 3); // queued 2 + failed 1
  assert.equal(memoryCenterTabBadge('records', value), 4);
  assert.equal(memoryCenterTabBadge('overview', value), undefined);
  assert.equal(memoryCenterTabBadge('settings', value), undefined);
});

/* ------------------------------------------------------------------ */
/* Snapshot mapping / counts / problems / budget                       */
/* ------------------------------------------------------------------ */

test('snapshot maps records and candidates into disjoint groups with by-kind/scope/status counts', () => {
  const value = view();
  assert.equal(value.hasSnapshot, true);
  assert.deepEqual(value.records.map(item => item.id).sort(), ['fact-a', 'inactive-c', 'pref-b', 'profile-d']);
  assert.deepEqual(value.candidates.map(item => item.id).sort(), ['cand-1', 'cand-2', 'invalid-1']);
  assert.equal(value.counts.active, 3);
  assert.equal(value.counts.candidate, 2);
  assert.equal(value.counts.inactive, 1);
  assert.equal(value.counts.invalidated, 1);
  const fact = value.byKind.find(row => row.kind === 'fact');
  assert.ok(fact);
  assert.equal(fact.label, '事实');
  assert.equal(fact.total, 4); // fact-a, inactive-c, cand-1, invalid-1
  assert.equal(fact.active, 1);
  assert.equal(fact.candidate, 1);
  assert.ok(value.byKind.some(row => row.kind === 'preference'));
  assert.deepEqual(value.byScope.map(row => [row.key, row.total]), [['project', 6], ['personal', 1]]);
  assert.equal(value.byStatus.find(row => row.key === 'active')?.total, 3);
});

test('overview exposes problem shortcuts that point at the tab that can fix them', () => {
  const value = view();
  const byId = new Map(value.problems.map(problem => [problem.id, problem]));
  assert.equal(byId.get('conflicts')?.count, 1);
  assert.equal(byId.get('conflicts')?.tab, 'conflicts');
  assert.equal(byId.get('reviews')?.count, 2);
  assert.equal(byId.get('reviews')?.tab, 'reviews');
  assert.equal(byId.get('candidates')?.count, 3);
  assert.equal(byId.get('candidates')?.tab, 'candidates');
  assert.equal(byId.get('learning-failed')?.tab, 'learning');
  assert.equal(byId.get('invalidated')?.count, 1);
  // Healthy snapshot: no fabricated problems.
  const healthy = memoryCenterSnapshotView({ memories: [record('only')], candidates: [], learning: { jobs: [] } }, { now: NOW });
  assert.deepEqual(healthy.problems, []);
});

test('budget rows mark unknown values instead of showing zero and surface the pinned 1500-char limit', () => {
  const value = view();
  const pinned = value.budget.find(row => row.id === 'pinned');
  assert.ok(pinned);
  assert.equal(pinned.available, true);
  assert.equal(pinned.limit, PINNED_CHAR_LIMIT);
  assert.equal(pinned.used, memoryPinnedChars(value.recordById.get('fact-a')));
  const daily = value.budget.find(row => row.id === 'autopublish-daily');
  assert.deepEqual([daily?.used, daily?.limit], [3, 10]);
  const calls = value.budget.find(row => row.id === 'learning-calls');
  assert.deepEqual([calls?.used, calls?.limit], [3, 6]);
  const unknown = memoryCenterSnapshotView({ memories: [] }, { now: NOW });
  assert.equal(unknown.budget.find(row => row.id === 'pinned')?.available, false);
  assert.equal(unknown.budget.find(row => row.id === 'pinned')?.used, undefined);
  assert.equal(memoryCountText(undefined), '未记录');
});

/* ------------------------------------------------------------------ */
/* Candidate vs active safety                                          */
/* ------------------------------------------------------------------ */

test('candidates never report as active and the records list never renders them', () => {
  const value = view();
  const cand = memoryCandidateView(value.candidates[0], { audit: value.autoPublish.audit, jobs: value.learning.jobs });
  assert.equal(cand.active, false);
  assert.equal(cand.statusLabel, '候选');
  assert.equal(memoryRecordIsActive(value.candidates[0]), false);
  assert.equal(memoryRecordIsActive(record('plain')), true);
  assert.equal(memoryRecordIsActive(record('x', { invalidatedReason: '来源已删除' })), false);
  assert.equal(memoryRecordIsActive(record('x', { enabled: false })), false);
  const state = memoryRecordStateView(candidate('c'));
  assert.equal(state.active, false);
  assert.equal(state.tone, 'candidate');
  assert.match(state.label, /候选/);
  assert.match(state.label, /未生效/);
  assert.match(state.safety, /不参与召回/);
  // Even a degenerate filter cannot leak a candidate into the records list.
  const leaked = memoryRecordList([...value.records, ...value.candidates], { status: 'all', kind: 'all', scope: 'all', subject: '', query: '' });
  assert.equal(leaked.some(item => item.status === 'candidate'), false);
  assert.equal(leaked.some(item => item.status === 'invalidated'), false);
  const activeCount = memoryCenterSnapshotView(snapshotFixture()).counts.active;
  assert.equal(activeCount, 3); // candidates excluded even though they exist in the snapshot
});

test('record state and label helpers fall back honestly for unknown metadata', () => {
  assert.equal(memoryKindLabel('fact'), '事实');
  assert.equal(memoryKindLabel('species'), '未知类型 species');
  assert.equal(memoryKindLabel(undefined), '未记录类型');
  assert.equal(memoryScopeLabel('personal'), '个人');
  assert.equal(memoryStatusLabel('candidate'), '候选');
  assert.equal(memoryStatusLabel('weird'), '未知状态 weird');
  assert.equal(memoryTrustLabel('source_verified'), '来源核验');
  assert.equal(memoryTrustLabel(undefined), '信任未记录');
  const inactive = memoryRecordStateView(record('x', { status: 'inactive', enabled: false }));
  assert.equal(inactive.tone, 'inactive');
  assert.equal(inactive.active, false);
  const invalidated = memoryRecordStateView(record('x', { status: 'invalidated', invalidatedReason: '来源已删除' }));
  assert.equal(invalidated.tone, 'invalidated');
  assert.equal(invalidated.active, false);
  assert.match(invalidated.safety, /来源已失效/);
});

/* ------------------------------------------------------------------ */
/* Candidates: grouping, gates, rejection reason, actions              */
/* ------------------------------------------------------------------ */

test('candidates group by learning job with an explicit unassigned bucket and rejection reasons', () => {
  const groups = memoryCandidateGroups(view());
  assert.equal(groups.length, 2);
  assert.match(groups[0].label, /^学习批次 job-1/);
  assert.equal(groups[0].key, 'job-1');
  assert.equal(groups[0].candidates.length, 1);
  assert.equal(groups[0].candidates[0].summary.length > 0, true);
  assert.equal(groups[0].candidates[0].rejectionReason, '未通过门禁 #6 置信分');
  assert.equal(groups[0].rejected, 1);
  const unassigned = groups.at(-1);
  assert.equal(unassigned?.key, 'unassigned');
  assert.match(unassigned?.label || '', /未关联学习批次/);
  assert.equal(unassigned?.candidates.length, 2);
});

test('candidate gate detail merges record, audit and job proposal telemetry with fixed gate labels', () => {
  const value = view();
  const gates = memoryCandidateGateView(value.candidates[0], { audit: value.autoPublish.audit, jobs: value.learning.jobs });
  assert.equal(gates.available, true);
  assert.equal(gates.total, 2);
  assert.equal(gates.passed, 1);
  assert.equal(gates.failed.length, 1);
  assert.equal(gates.failed[0].id, 6);
  assert.equal(gates.failed[0].label, '置信分');
  assert.match(gates.summary, /未通过门禁 #6 置信分/);
  assert.equal(AUTO_PUBLISH_GATE_LABELS[4], '安全');
  assert.equal(AUTO_PUBLISH_GATE_LABELS[10], '运行时');
  // Gate details that the record carries directly win over audit rows.
  const direct = memoryCandidateGateView({ ...candidate('direct'), gates: [{ id: 4, name: 'safety', pass: false, reason: '跨项目泄漏' }] });
  assert.equal(direct.items[0].label, '安全');
  assert.match(direct.summary, /跨项目泄漏/);
  // No telemetry anywhere: say so instead of claiming the gates passed.
  const missing = memoryCandidateGateView(candidate('silent'));
  assert.equal(missing.available, false);
  assert.equal(missing.total, 0);
  assert.equal(missing.summary, '门禁明细未记录');
});

test('candidate actions accept/edit/reject keep explicit revisions and never fake activation', () => {
  const value = view();
  const cand = value.candidates[0];
  const accept = memoryCandidateAcceptRequest(cand);
  assert.equal(accept.action, 'accept');
  assert.deepEqual(accept.input, { id: 'cand-1', revision: 1, expectedRevision: 1 });
  const reject = memoryCandidateRejectRequest(cand);
  assert.equal(reject.action, 'toggle');
  assert.equal(reject.input.enabled, false);
  assert.equal(reject.input.id, 'cand-1');
  assert.equal(reject.input.expectedRevision, 1);
  const preview = { action: 'update', id: 'cand-1', revision: 1, previewToken: 'token-1' };
  const edit = memoryCandidateEditRequest(cand, preview, { content: '修正后的正文' });
  assert.equal(edit.action, 'update');
  assert.equal(edit.input.previewToken, 'token-1');
  assert.deepEqual(edit.input.patch, { content: '修正后的正文' });
  assert.throws(() => memoryCandidateAcceptRequest({}), /缺少编号/);
  assert.throws(() => memoryCandidateEditRequest(cand, preview, {}), /填写/);
});

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

test('conflict view resolves both sides from the snapshot and labels sides honestly', () => {
  const value = view();
  const conflicts = memoryConflictViews(value, 'open');
  assert.equal(conflicts.length, 1);
  const conflict = conflicts[0];
  assert.equal(conflict.statusLabel, '待裁决');
  assert.equal(conflict.left.found, true);
  assert.equal(conflict.right.found, true);
  assert.match(conflict.left.claim, /构建使用/);
  assert.equal(conflict.left.supportScore, 0.9);
  assert.equal(conflict.left.kindLabel, '事实');
  assert.equal(conflict.right.kindLabel, '事实');
  assert.equal(conflict.right.statusLabel, '候选');
  assert.notEqual(conflict.right.statusLabel, '生效');
  // A conflict whose record left the snapshot stays renderable and flagged.
  const orphan = memoryConflictView({ sides: [{ side: 'left', memoryId: 'gone', revision: 1, supportScore: 0.5 }] }, value);
  assert.equal(orphan.left.found, false);
  assert.match(orphan.left.title, /不在当前快照/);
});

test('conflict resolution builders enforce valid resolutions and required merge content', () => {
  const conflict = memoryConflictViews(view(), 'open')[0];
  for (const resolution of CONFLICT_RESOLUTIONS) {
    if (resolution === 'merge') continue;
    if (resolution === 'both') continue; // no conditions on the left side in this fixture
    const input = memoryConflictResolveInput(conflict, resolution, { notes: '核对后处理' });
    assert.equal(input.id, 'conf-1');
    assert.equal(input.resolution, resolution);
    assert.equal(input.expectedStatus, 'open');
    assert.equal(input.notes, '核对后处理');
  }
  assert.throws(() => memoryConflictResolveInput(conflict, 'merge'), /需要填写合并后的完整正文/);
  const merge = memoryConflictResolveInput(conflict, 'merge', { content: '构建使用 pnpm build。（合并）', title: '构建命令' });
  assert.equal(merge.content, '构建使用 pnpm build。（合并）');
  assert.equal(merge.title, '构建命令');
  assert.throws(() => memoryConflictResolveInput(conflict, 'bogus'), /未知的冲突裁决方式/);
  const resolved = memoryConflictViews(view(), 'all').find(item => item.status === 'resolved')!;
  assert.equal(memoryConflictResolveAllowed(resolved, 'keep_left').allowed, false);
  assert.match(memoryConflictResolveAllowed(resolved, 'keep_left').reason, /已裁决/);
  const noConditions = memoryConflictResolveAllowed(conflict, 'both');
  assert.equal(noConditions.allowed, false);
  assert.match(noConditions.reason, /适用条件/);
});

test('conflict impact preview lists affected records, derived content and the retrieval consequence', () => {
  const value = view();
  const conflict = memoryConflictViews(value, 'open')[0];
  const keepLeft = memoryConflictImpactView(value, conflict, 'keep_left');
  assert.equal(keepLeft.affectedRecords.length, 2);
  assert.equal(keepLeft.derived, 1);
  assert.match(keepLeft.retrieval, /检索只会返回保留的一侧/);
  assert.equal(keepLeft.requiresConfirmation, true);
  assert.equal(keepLeft.affectedRecords.find(item => item.id === 'cand-1')?.role, '将停用');
  const both = memoryConflictImpactView(value, conflict, 'both');
  assert.match(both.retrieval, /可区分的适用条件/);
  const defer = memoryConflictImpactView(value, conflict, 'defer');
  assert.equal(defer.requiresConfirmation, false);
  assert.match(defer.retrieval, /不做变更/);
});

/* ------------------------------------------------------------------ */
/* Reviews                                                             */
/* ------------------------------------------------------------------ */

test('reviews sort by priority and due date, translate reasons and expose due items', () => {
  const value = view();
  assert.equal(value.reviewsDue, 2);
  assert.deepEqual(value.reviews.map(item => item.id), ['review-2', 'review-1']);
  assert.equal(value.reviews[0].reasonLabel, '已过期');
  assert.equal(value.reviews[1].reasonLabel, '到期复核');
  assert.equal(REVIEW_REASON_LABELS['negative-feedback'], '负向反馈');
  const due = memoryReviewsDue(value, NOW);
  assert.equal(due.length, 2);
  const future = memoryReviewItems({ items: [{ id: 'r', memoryId: 'm', reason: 'review-after', priority: 1, dueAt: '2027-01-01T00:00:00.000Z' }] }, NOW);
  assert.equal(future[0].overdue, false);
});

test('review resolve inputs gate destructive actions behind confirmation and patches', () => {
  const review = view().reviews[0];
  assert.equal(memoryReviewResolveInput(review, 'confirm').action, 'confirm');
  assert.equal(memoryReviewResolveInput(review, 'defer', { notes: '下周处理' }).notes, '下周处理');
  assert.throws(() => memoryReviewResolveInput(review, 'forget'), /影响预览并确认/);
  assert.throws(() => memoryReviewResolveInput(review, 'disable'), /影响预览并确认/);
  const forget = memoryReviewResolveInput(review, 'forget', { confirmed: true, previewToken: 'token-9' });
  assert.equal(forget.previewToken, 'token-9');
  assert.equal(forget.id, 'review-2');
  assert.throws(() => memoryReviewResolveInput(review, 'correct', { confirmed: true }), /正文或条件补丁/);
  const corrected = memoryReviewResolveInput(review, 'correct', { confirmed: true, patch: { content: '更正后' } });
  assert.deepEqual(corrected.patch, { content: '更正后' });
  assert.throws(() => memoryReviewResolveInput(review, 'explode'), /未知的复审操作/);
  assert.ok(memoryReviewActions(review).includes('forget'));
  assert.deepEqual(memoryReviewListInput({ status: 'queued', limit: 500 }), { status: 'queued', limit: 200 });
});

test('review.list rows from the controller (snake_case) normalize due dates, embedded records and status', () => {
  const items = memoryReviewItems({
    reviews: [{
      id: 'review-row',
      memory_id: 'memory-one',
      revision: 4,
      reason: 'review-after',
      priority: 70,
      due_at: '2026-10-01T00:00:00.000Z',
      status: 'open',
      created_at: '2026-09-01T00:00:00.000Z',
      notes: '自动复审',
      record: { id: 'memory-one', revision: 4, title: '构建命令', content: '构建使用 pnpm build。', conditions: ['Node 24'] },
    }],
    open: 1,
    overdue: 1,
  }, NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'review-row');
  assert.equal(items[0].memoryId, 'memory-one');
  assert.equal(items[0].revision, 4);
  assert.equal(items[0].dueAt, '2026-10-01T00:00:00.000Z');
  assert.equal(items[0].overdue, true);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].notes, '自动复审');
  assert.equal(items[0].recordTitle, '构建命令');
  assert.deepEqual(items[0].record?.id, 'memory-one');
  // A resolved review is not reported as overdue.
  const resolved = memoryReviewItems({ reviews: [{ id: 'r', memory_id: 'm', reason: 'expired', priority: 90, due_at: '2026-01-01T00:00:00Z', status: 'resolved' }] }, NOW);
  assert.equal(resolved[0].overdue, false);
});

test('snapshot reviewSummary object drives due/open counts without fabricating a review list', () => {
  const summaryView = memoryCenterSnapshotView({
    memories: [record('a')],
    candidates: [],
    reviews: { open: 2, deferred: 1, resolved: 3, overdue: 1, byReason: { expired: 2 } },
    learning: { jobs: [] },
  }, { now: NOW });
  assert.equal(summaryView.reviewsDue, 1);
  assert.deepEqual(summaryView.reviews, []);
  assert.deepEqual(summaryView.reviewSummary, { available: true, open: 2, deferred: 1, resolved: 3, overdue: 1 });
  assert.equal(summaryView.problems.find(problem => problem.id === 'reviews')?.count, 1);
  // Older snapshots that still carry a review array keep working.
  const arrayView = memoryCenterSnapshotView({ reviews: [{ id: 'r', memoryId: 'm', reason: 'expired', priority: 90, dueAt: '2026-01-01T00:00:00Z', status: 'open' }] }, { now: NOW });
  assert.equal(arrayView.reviewsDue, 1);
});

test('review actions exactly match the controller review.resolve surface', () => {
  const actions = memoryReviewActions(view().reviews[0]);
  assert.deepEqual(actions, ['confirm', 'correct', 'disable', 'forget', 'defer']);
  assert.equal(actions.includes('merge'), false);
  assert.equal(actions.includes('split'), false);
});

test('batch review actions stay limited to safe transitions and require confirmation for disable', () => {
  const reviews = view().reviews;
  assert.throws(() => memoryReviewBatchInputs(reviews, 'disable' as 'disable'), /确认影响/);
  const confirmed = memoryReviewBatchInputs(reviews, 'disable', { confirmed: true });
  assert.equal(confirmed.length, 2);
  assert.ok(confirmed.every(item => item.action === 'review.resolve' && item.input.action === 'disable'));
  assert.throws(() => memoryReviewBatchInputs(reviews, 'forget' as unknown as 'defer'), /批量复审仅支持/);
  const deferred = memoryReviewBatchInputs(reviews, 'defer');
  assert.equal(deferred.length, 2);
});

/* ------------------------------------------------------------------ */
/* Learning                                                            */
/* ------------------------------------------------------------------ */

test('learning jobs render stages, proposal counts, budget, errors and source ranges', () => {
  const value = view();
  const jobs = memoryLearningJobViews(value);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.stageLabel, '发布记忆');
  assert.equal(job.stateLabel, '失败');
  assert.equal(job.error, '来源已撤回');
  assert.equal(job.proposals.total, 4);
  assert.equal(job.proposals.published, 1);
  assert.equal(job.proposals.pending, 1);
  assert.deepEqual(job.budget, { calls: 3, maxCalls: 6, tokens: 900, usageUnknown: false });
  assert.equal(job.sourceCount, 2);
  assert.ok(job.sourceRanges.includes('s1/e1[0-12]'));
  assert.ok(job.sourceRanges.includes('s2/e2'));
  assert.equal(job.rejections[0].title, '伪造引文');
  assert.equal(job.rejections[0].reason, '引文不能定位');
  assert.equal(job.canRetry, true);
  // Unknown budgets stay unknown, never zero.
  const legacy = memoryLearningJobView({ id: 'old', stage: 'validate', state: 'completed', budget: { unknown: true } });
  assert.equal(legacy.budget.calls, undefined);
  assert.equal(legacy.budget.tokens, undefined);
  assert.equal(legacy.budget.usageUnknown, true);
  assert.equal(legacy.canRetry, false);
  assert.equal(legacy.stageLabel, '核对提案');
  assert.equal(memoryLearningJobView({}).stageLabel, '阶段未记录');
});

test('learning controls build the exact run/retry/pause/resume requests', () => {
  assert.deepEqual(memoryLearningControlRequest('run'), { action: 'learning.run', input: {} });
  assert.deepEqual(memoryLearningControlRequest('pause'), { action: 'learning.pause', input: {} });
  assert.deepEqual(memoryLearningControlRequest('resume'), { action: 'learning.resume', input: {} });
  assert.deepEqual(memoryLearningControlRequest('retry', 'job-1'), { action: 'learning.retry', input: { jobId: 'job-1' } });
  assert.throws(() => memoryLearningControlRequest('retry'), /具体的学习批次/);
  assert.throws(() => memoryLearningControlRequest('bogus' as 'run'), /未知的学习控制操作/);
});

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

test('graph views normalize controller nodes/edges and drop dangling edges', () => {
  const graph = memoryGraphView({
    rootId: 'a',
    nodes: [{ id: 'a', kind: 'fact', title: 'A', status: 'active' }, { id: 'b', kind: 'preference', title: 'B', status: 'inactive' }],
    edges: [{ from: 'a', to: 'b', kind: 'same-subject' }, { from: 'a', to: 'missing', kind: 'related' }],
  });
  assert.equal(graph.available, true);
  assert.equal(graph.nodes[0].label, '事实 · 生效');
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].label, '同主题');
  assert.equal(memoryGraphView({}).available, false);
  assert.equal(memoryGraphView({ nodes: [{ id: 'x', kind: 'fact', title: 'X', status: 'active' }] }).source, 'controller');
  const conflicted = memoryGraphView({ nodes: [{ id: 'a', kind: 'fact', title: 'A', status: 'active' }, { id: 'b', kind: 'fact', title: 'B', status: 'candidate' }], edges: [{ from: 'a', to: 'b', kind: 'contradicts' }] });
  assert.equal(conflicted.edges[0].label, '冲突');
  assert.deepEqual(memoryGraphRequest({ scope: 'personal', depth: 2 }), { scope: 'personal', depth: 2 });
});

test('snapshot fallback derives lineage from parentIds and graph layout is deterministic', () => {
  const value = memoryCenterSnapshotView(snapshotFixture({
    memories: [
      record('parent', { title: '父记录' }),
      record('child', { title: '子记录', parentIds: ['parent'] }),
    ],
    candidates: [],
  }), { now: NOW });
  const graph = memoryGraphFromSnapshot(value, { rootId: 'child' });
  assert.equal(graph.source, 'snapshot');
  assert.deepEqual(graph.nodes.map(node => node.id).sort(), ['child', 'parent']);
  assert.deepEqual(graph.edges, [{ from: 'parent', to: 'child', kind: 'parent-child', label: '父子派生' }]);
  assert.equal(memoryGraphFromSnapshot(value, { rootId: 'missing' }).available, false);
  const layoutA = memoryGraphLayout(graph, { width: 640, height: 360 });
  const layoutB = memoryGraphLayout(graph, { width: 640, height: 360 });
  assert.deepEqual(layoutA, layoutB);
  assert.equal(layoutA.width, 640);
  assert.equal(layoutA.nodes.length, 2);
  assert.ok(layoutA.nodes.every(node => node.x >= 0 && node.x <= 640 && node.y >= 0 && node.y <= 360));
  assert.equal(layoutA.edges[0].from, 'parent');
  assert.ok(Number.isFinite(layoutA.edges[0].labelX));
  // One node is centered.
  const single = memoryGraphLayout(memoryGraphView({ nodes: [{ id: 'only', kind: 'fact', title: 'only', status: 'active' }] }), { width: 640, height: 360 });
  assert.deepEqual([single.nodes[0].x, single.nodes[0].y], [320, 180]);
  assert.throws(() => memoryGraphRequest({ depth: 3 }), /1 或 2 跳/);
  assert.deepEqual(memoryGraphRequest({ depth: 2, scope: 'all' }), { depth: 2 });
});

/* ------------------------------------------------------------------ */
/* Usage diagnosis                                                     */
/* ------------------------------------------------------------------ */

test('usage view reports the five receipt stages separately and deduplicates receipts', () => {
  const usage = memoryUsageView(usageFixture());
  assert.equal(usage.recorded, true);
  assert.equal(usage.stages.length, 5);
  assert.deepEqual(usage.stages.map(stage => stage.label), ['召回候选', '注入上下文', '请求已准备', '响应已观察', '工具读取']);
  assert.deepEqual(usage.stages.map(stage => stage.count), [1, 1, 1, 1, 1]);
  assert.equal(usage.rawReceipts, 6); // 5 unique stage receipts + 1 source receipt
  assert.equal(usage.sourceReads, 1);
  assert.equal(usage.toolReads, 1);
  assert.equal(usage.responseObserved, 1);
  assert.equal(usage.omissions.length, 2);
  assert.equal(usage.omissions.find(item => item.id === 'inactive-c')?.label, '未生效或已停用');
  assert.equal(usage.omissions.find(item => item.id === 'fact-a')?.label, '正文与完整条件超出预算');
  assert.deepEqual(usage.omissions.find(item => item.id === 'fact-a')?.readRef, { action: 'read.range', id: 'fact-a', revision: 1 });
  assert.match(usage.boundary, /不代表模型采纳/);
  // Empty receipt log never claims there is no relevant history.
  const empty = memoryUsageView({});
  assert.equal(empty.recorded, false);
  assert.ok(empty.stages.every(stage => stage.count === 0));
  assert.equal(empty.omissions.length, 0);
  assert.equal(empty.boundary, '分别记录召回、注入、请求、响应与工具读取；读取收据不代表模型采纳或答案正确。');
});

test('search explain exposes matched terms, ordered feature scores, exclusions and zero-hit guidance', () => {
  const explain = memoryExplainView({
    queryId: 'query-1',
    ruleVersion: 3,
    terms: ['构建', '命令'],
    matches: [{
      id: 'fact-a',
      revision: 1,
      score: 4.5,
      matchedTerms: ['构建'],
      fields: { title: ['构建'], body: ['构建'] },
      features: { exact: 1, bm25: 12.5, subjectMatch: 0.5, feedbackScore: 0, conflict: -2, mysteryFeature: 3 },
      reasons: ['主题匹配'],
    }],
    excluded: [{ id: 'inactive-c', reason: 'inactive' }, { id: 'cand-1', reason: 'validity' }],
  });
  assert.equal(explain.available, true);
  assert.equal(explain.ruleVersion, 3);
  assert.deepEqual(explain.terms, ['构建', '命令']);
  assert.equal(explain.matches.length, 1);
  assert.equal(explain.matches[0].matchedTerms[0], '构建');
  assert.deepEqual(explain.matches[0].features.map(row => row.label), ['精确匹配', '主题匹配', 'BM25', '反馈', '冲突扣分', 'mysteryFeature']);
  assert.deepEqual(explain.matches[0].features.map(row => row.value), [1, 0.5, 12.5, 0, -2, 3]);
  assert.deepEqual(explain.excluded.map(row => row.label), ['未生效或已停用', '不在有效期内']);
  assert.equal(explain.empty, false);
  assert.match(explain.note, /命中不等于权威/);
  const zero = memoryExplainView({ matches: [], terms: ['不存在'] });
  assert.equal(zero.empty, true);
  assert.match(zero.guidance, /零命中不代表历史中不存在/);
  const unavailable = memoryExplainView({});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.guidance, '');
});

/* ------------------------------------------------------------------ */
/* Record list / paging / detail helpers                               */
/* ------------------------------------------------------------------ */

test('record filters cover kind/scope/status/subject/query without crossing candidate boundaries', () => {
  const value = view();
  assert.deepEqual(memoryRecordList(value.records).map(item => item.id), ['fact-a', 'pref-b', 'inactive-c', 'profile-d']);
  assert.deepEqual(memoryRecordList(value.records, { kind: 'preference' }).map(item => item.id), ['pref-b']);
  assert.deepEqual(memoryRecordList(value.records, { scope: 'personal' }).map(item => item.id), ['pref-b']);
  assert.deepEqual(memoryRecordList(value.records, { status: 'inactive' }).map(item => item.id), ['inactive-c']);
  assert.deepEqual(memoryRecordList(value.records, { status: 'active' }).map(item => item.id), ['fact-a', 'pref-b', 'profile-d']);
  assert.deepEqual(memoryRecordList(value.records, { subject: '构建' }).map(item => item.id), ['fact-a']);
  assert.deepEqual(memoryRecordList(value.records, { query: 'pnpm' }).map(item => item.id), ['fact-a']);
  assert.equal(memoryRecordMatchesFilters(value.records[0], { query: '不存在的词' }), false);
  assert.deepEqual(EMPTY_RECORD_FILTERS, { kind: 'all', scope: 'all', status: 'all', subject: '', query: '' });
});

test('record paging clamps pages, reports omissions and computes page metadata', () => {
  const records = Array.from({ length: 45 }, (_, index) => record(`r-${String(index).padStart(2, '0')}`, { updatedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString() }));
  const page2 = memoryRecordPage(records, 2, 20);
  assert.equal(page2.page, 2);
  assert.equal(page2.pageCount, 3);
  assert.equal(page2.items.length, 5);
  assert.equal(page2.start, 41);
  assert.equal(page2.end, 45);
  assert.equal(page2.omitted, 40);
  assert.equal(page2.hasNext, false);
  assert.equal(page2.hasPrevious, true);
  const clamped = memoryRecordPage(records, 99, 20);
  assert.equal(clamped.page, 2);
  const empty = memoryRecordPage([], 0, 20);
  assert.deepEqual([empty.pageCount, empty.total, empty.start, empty.omitted], [1, 0, 0, 0]);
  assert.equal(memoryRecordPage(records, 0, 999).pageSize, 100);
});

test('list/search/read input builders send only the controller-supported keys', () => {
  assert.deepEqual(memoryListInput({ scope: 'all', status: 'all' }, 2, 20), { cursor: 40, limit: 20 });
  assert.deepEqual(memoryListInput({ scope: 'personal', status: 'active' }, 0, 100), { scope: 'personal', status: 'active', cursor: 0, limit: 100 });
  assert.deepEqual(memorySearchInput('构建'), { query: '构建', limit: 20, match: 'adaptive' });
  assert.deepEqual(memorySearchInput('构建', { scope: 'personal' }), { query: '构建', limit: 20, match: 'adaptive', scope: 'personal' });
  assert.deepEqual(memorySearchExplainInput('构建'), { query: '构建', limit: 12, match: 'adaptive' });
  assert.throws(() => memorySearchExplainInput('  '), /检索词/);
  assert.deepEqual(memoryReadInput('fact-a'), { id: 'fact-a' });
  assert.deepEqual(memoryReadInput('fact-a', 2), { id: 'fact-a', revision: 2 });
  assert.deepEqual(memoryReadSourcesInput('fact-a', 3), { id: 'fact-a', revision: 3, source: true });
  assert.deepEqual(memoryVersionsInput('fact-a'), { id: 'fact-a' });
  assert.deepEqual(memoryReadRangeInput('fact-a', 2, 40), { id: 'fact-a', revision: 2, cursor: 40 });
  assert.throws(() => memoryReadRangeInput('fact-a', 0), /实际版本号/);
  assert.throws(() => memoryVersionsInput(''), /缺少记忆编号/);
  assert.throws(() => memoryReadInput(''), /缺少记忆编号/);
  assert.deepEqual(memoryExplainRequest('构建'), memorySearchExplainInput('构建'));
  assert.deepEqual(memoryUsageRequest(' run-1 '), { runId: 'run-1' });
  assert.deepEqual(memoryDiagnosticsRequest(), {});
});

test('record detail builds revision diff, sources/originals and derived references', () => {
  const value = view();
  const recordValue = value.recordById.get('fact-a')!;
  const diff = memoryDetailRevisionDiff(recordValue, [
    { ...recordValue, revision: 1 },
    { ...recordValue, revision: 0, content: '旧构建命令', title: '旧标题' },
  ]);
  assert.equal(diff.available, true);
  assert.equal(diff.currentRevision, 1);
  assert.equal(diff.previousRevision, 0);
  assert.deepEqual(diff.changedFields, ['标题', '正文']);
  assert.match(diff.summary, /v0 → v1/);
  assert.equal(memoryDetailRevisionDiff(recordValue, [{ ...recordValue, revision: 1 }]).available, false);
  assert.equal(memoryDetailRevisionDiff(recordValue, []).available, false);
  const sources = memoryDetailSources(recordValue, { originals: [{ source: { sessionId: 's1', entryId: 'e1' }, item: { text: '原始正文' } }, { error: '来源不可用' }] });
  assert.equal(sources.originals.length, 2);
  assert.equal(sources.originals[0].text, '原始正文');
  assert.equal(sources.originals[1].error, '来源不可用');
  assert.equal(sources.sources.length, 0);
  assert.equal(memoryDerivedRefs(value, 'fact-a').length, 1);
  assert.equal(memoryRecordSubject(recordValue), '未登记主题');
  assert.equal(memoryRecordSummary(recordValue, 4).length <= 5, true);
});

/* ------------------------------------------------------------------ */
/* Pinned budget                                                       */
/* ------------------------------------------------------------------ */

test('pinned view resolves ids, counts characters against the 1500-char limit and flags unresolved ids', () => {
  const value = memoryPinnedView(snapshotFixture({ pinned: ['fact-a', 'missing'] }));
  assert.equal(value.available, true);
  assert.deepEqual(value.ids, ['fact-a', 'missing']);
  assert.equal(value.records.length, 1);
  assert.equal(value.unresolved, 1);
  assert.equal(value.limit, 1500);
  assert.equal(value.used, memoryPinnedChars(value.records[0]));
  assert.equal(value.remaining, 1500 - value.used);
  const objects = memoryPinnedView({ pinned: { ids: ['fact-a'], limit: 100, used: 12 } });
  assert.equal(objects.limit, 100);
  assert.equal(memoryPinnedView({}).available, false);
  assert.equal(memoryPinnedChars(record('x', { content: 'abc', conditions: ['条件一'] })), 3 + 3);
  // The controller snapshot sends pinned records themselves (id/revision/content/conditions).
  const controllerPinned = memoryPinnedView({ pinned: [{ id: 'fact-a', revision: 1, kind: 'fact', title: '构建命令', content: '构建使用 pnpm build。', conditions: [] }] });
  assert.equal(controllerPinned.available, true);
  assert.equal(controllerPinned.records.length, 1);
  assert.deepEqual(controllerPinned.ids, ['fact-a']);
  assert.equal(controllerPinned.used, memoryPinnedChars(controllerPinned.records[0]));
  // Multiple conditions are joined with the same separator the controller counts.
  assert.equal(memoryPinnedChars(record('multi', { content: 'ab', conditions: ['甲', '乙'] })), 2 + '甲；乙'.length);
});

test('pin requests enforce kind eligibility, the 1500-char budget and unpin CAS revisions', () => {
  const value = view();
  const pinnable = value.recordById.get('pref-b')!;
  const pin = memoryPinRequest(pinnable, value.pinned);
  assert.equal(pin.action, 'pin');
  assert.deepEqual(pin.input, { id: 'pref-b', revision: 1, expectedRevision: 1 });
  const unpin = memoryPinRequest(value.recordById.get('fact-a'), memoryPinnedView({ pinned: ['fact-a'] }));
  assert.equal(unpin.action, 'unpin');
  assert.deepEqual(unpin.input, { id: 'fact-a', expectedRevision: 1 });
  const episode = record('ep', { kind: 'episode' });
  assert.equal(memoryPinEligible(episode).eligible, false);
  assert.match(memoryPinEligible(episode).reason, /情节/);
  assert.throws(() => memoryPinRequest(episode, { available: true, ids: [], records: [], used: 0, limit: 1500, remaining: 1500, overBudget: false, unresolved: 0 }), /情节/);
  assert.equal(memoryPinEligible(record('c', { status: 'candidate' })).eligible, false);
  const full = { available: true, ids: [], records: [], used: 1490, limit: 1500, remaining: 10, overBudget: false, unresolved: 0 };
  assert.throws(() => memoryPinRequest(record('big', { content: 'x'.repeat(20) }), full), /置顶预算不足/);
  assert.equal(memoryPinEligible(record('ok')).eligible, true);
});

test('bulk pin skips ineligible/over-budget records and bulk unpin only touches pinned records', () => {
  const pinned = memoryPinnedView({ pinned: ['fact-a'] });
  const records = [
    record('fact-a', { content: 'short' }),
    record('new-b', { content: 'x'.repeat(1460) }),
    record('new-c', { content: 'tiny' }),
    record('episode-d', { kind: 'episode' }),
  ];
  const pinnedWithRoom = { ...pinned, used: 1400, limit: 1500, remaining: 100 };
  const result = memoryBulkPinRequests(records, pinnedWithRoom, true);
  assert.deepEqual(result.actions.map(item => item.input.id), ['new-c']);
  assert.deepEqual(result.skipped.map(item => item.id).sort(), ['episode-d', 'fact-a', 'new-b']);
  assert.ok(result.skipped.find(item => item.id === 'episode-d')?.reason.includes('情节'));
  assert.ok(result.skipped.find(item => item.id === 'new-b')?.reason.includes('预算'));
  assert.equal(result.used, 1404);
  const unpin = memoryBulkPinRequests(records, pinned, false);
  assert.deepEqual(unpin.actions.map(item => item.input.id), ['fact-a']);
  assert.ok(unpin.skipped.some(item => item.id === 'new-c' && item.reason.includes('不在置顶列表')));
});

/* ------------------------------------------------------------------ */
/* Impact preview token handling                                       */
/* ------------------------------------------------------------------ */

const previewFixture = () => ({
  action: 'forget',
  id: 'fact-a',
  revision: 7,
  previewToken: 'frozen-token',
  epoch: 3,
  conclusion: '将遗忘选中记忆及其派生记录。',
  evidenceBoundary: '只读预览，不修改记录。',
  affected: [
    { id: 'fact-a', revision: 5, status: 'active' },
    { id: 'child-1', revision: 2, status: 'inactive' },
  ],
  sources: [{ source: { entryId: 'e1' }, valid: true }, { source: { entryId: 'e2' }, valid: false, reason: '来源已撤回' }],
  artifacts: [{ valid: true }],
  dependencies: [{ valid: true }],
});

test('impact preview summarizes affected records/sources and requires a frozen token before commit', () => {
  const preview = previewFixture();
  const viewModel = memoryImpactView(preview);
  assert.equal(viewModel.available, true);
  assert.equal(viewModel.counts.affected, 2);
  assert.equal(viewModel.counts.derived, 1);
  assert.deepEqual(viewModel.sourceValidity, { valid: 1, invalid: 1, unknown: 0 });
  assert.equal(viewModel.affected[1].statusLabel, '已停用');
  const commit = memoryImpactCommitInput(preview, 'forget', 'fact-a');
  assert.deepEqual(commit, { id: 'fact-a', revision: 7, previewToken: 'frozen-token' });
  const updatePreview = { ...preview, action: 'update' };
  const update = memoryImpactCommitInput(updatePreview, 'update', 'fact-a', { content: '新正文' });
  assert.deepEqual(update.patch, { content: '新正文' });
  assert.throws(() => memoryImpactCommitInput({ action: 'forget', id: 'fact-a', revision: 7 }, 'forget', 'fact-a'), /重新预览/);
  assert.throws(() => memoryImpactCommitInput({ ...preview, action: 'update' }, 'forget', 'fact-a'), /重新预览/);
  assert.throws(() => memoryImpactCommitInput(preview, 'forget', 'other'), /重新预览/);
  const missing = memoryImpactView({ action: 'forget' });
  assert.equal(missing.available, false);
  assert.match(missing.error, /previewToken/);
});

test('impact preview goes stale when the snapshot epoch or affected revision changes', () => {
  const preview = previewFixture();
  const snapshot = { epoch: 3, memories: [{ id: 'fact-a', revision: 5 }], candidates: [] };
  assert.equal(memoryImpactStale(preview, snapshot), false);
  assert.equal(memoryImpactStale(preview, { ...snapshot, epoch: 4 }), true);
  assert.equal(memoryImpactStale(preview, { epoch: 3, memories: [{ id: 'fact-a', revision: 6 }], candidates: [] }), true);
  assert.equal(memoryImpactStale(preview, {}), false); // cannot prove a change: do not fabricate staleness
});

/* ------------------------------------------------------------------ */
/* Settings: auto-publish policy, audit, revoke, import/export         */
/* ------------------------------------------------------------------ */

test('auto-publish view normalizes policy, stats and audit labels from snapshot or status payload', () => {
  const value = view();
  const autoPublish = memoryAutoPublishView(value.autoPublish);
  assert.equal(autoPublish.available, true);
  assert.equal(autoPublish.policy.modeLabel, '标准');
  assert.equal(autoPublish.policy.minScore, 70);
  assert.equal(autoPublish.policy.version, 4);
  assert.deepEqual(autoPublish.stats, { autoPublished: 3, revoked: 1, corrected: 0 });
  assert.equal(memoryAutoPublishView(value).policy.version, 4); // snapshot nesting is accepted too
  const audit = memoryAuditView(value.autoPublish.audit);
  assert.equal(audit.length, 2);
  assert.equal(audit[0].memoryId, 'cand-1');
  assert.equal(audit[0].actionLabel, '进入候选');
  assert.match(audit[0].gatesSummary, /#6 置信分/);
  assert.equal(audit[0].revocable, false);
  const published = audit.find(row => row.memoryId === 'fact-a')!;
  assert.equal(published.actionLabel, '自动发布');
  assert.equal(published.revocable, true);
  assert.equal(published.rollbackToken, true);
  assert.equal(memoryAuditView([{ id: 'a', action: 'publish', createdAt: '2026-10-01T00:00:00Z' }])[0].gatesSummary, '门禁未记录');
  assert.equal(AUTO_PUBLISH_MODES.length, 4);
});

test('auto-publish settings input requires a loaded CAS version and validates every field', () => {
  const autoPublish = memoryAutoPublishView(view().autoPublish);
  assert.deepEqual(memoryAutoPublishSettingsInput(autoPublish, { mode: 'aggressive', minScore: 55.4, maxAutoPerDay: 20, requireReview: true }), {
    expectedVersion: 4,
    mode: 'aggressive',
    minScore: 55,
    maxAutoPerDay: 20,
    requireReview: true,
  });
  assert.throws(() => memoryAutoPublishSettingsInput(autoPublish, {}), /没有要保存的策略变更/);
  assert.throws(() => memoryAutoPublishSettingsInput(autoPublish, { mode: 'turbo' }), /未知的自动发布模式/);
  assert.throws(() => memoryAutoPublishSettingsInput(autoPublish, { minScore: 101 }), /0 到 100/);
  assert.throws(() => memoryAutoPublishSettingsInput(autoPublish, { maxAutoPerDay: 1.5 }), /0 到 10000/);
  assert.throws(() => memoryAutoPublishSettingsInput(autoPublish, { requireReview: 'yes' as unknown as boolean }), /布尔值/);
  const unloaded = memoryAutoPublishView({});
  assert.throws(() => memoryAutoPublishSettingsInput(unloaded, { mode: 'standard' }), /尚未读取/);
});

test('auto-publish revoke refuses accidental mass revocation and validates the selection', () => {
  const audit = memoryAuditView(view().autoPublish.audit);
  assert.deepEqual(memoryAutoPublishRevokeInput({ ids: ['audit-2'], reason: '撤回错误发布' }, audit), { ids: ['audit-2'], reason: '撤回错误发布' });
  assert.deepEqual(memoryAutoPublishRevokeInput({ batchKey: 'job-1' }, audit), { batchKey: 'job-1' });
  assert.deepEqual(memoryAutoPublishRevokeInput({ since: '2026-10-01T00:00:00.000Z' }, audit), { since: '2026-10-01T00:00:00.000Z' });
  assert.throws(() => memoryAutoPublishRevokeInput({}, audit), /不会默认撤销全部/);
  assert.throws(() => memoryAutoPublishRevokeInput({ ids: [] }, audit), /不会默认撤销全部/);
  assert.throws(() => memoryAutoPublishRevokeInput({ since: 'not-a-time' }, audit), /有效时间/);
  assert.throws(() => memoryAutoPublishRevokeInput({ ids: ['audit-1'] }, audit), /不可撤销/);
  assert.throws(() => memoryAutoPublishRevokeInput({ ids: ['ghost'] }, audit), /不在当前审计中/);
});

test('import forces every imported record to candidate/false and strips model-claim metadata', () => {
  const input = memoryImportInput([{ title: '导入标题', content: '导入正文', status: 'active', enabled: true, trust: 'user_explicit', authority: 'user', score: 99, autoPublished: true, confirmedBy: 'user' }]);
  const imported = asRecordList(input.records);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].status, 'candidate');
  assert.equal(imported[0].enabled, false);
  assert.equal('trust' in imported[0], false);
  assert.equal('score' in imported[0], false);
  assert.equal('autoPublished' in imported[0], false);
  assert.equal('confirmedBy' in imported[0], false);
  const parsed = memoryImportInput('{"records":[{"title":"JSON 标题","content":"JSON 正文"}]}');
  assert.equal(asRecordList(parsed.records)[0].status, 'candidate');
  assert.throws(() => memoryImportInput('not json'), /不是有效 JSON/);
  assert.throws(() => memoryImportInput([]), /导入列表为空/);
  assert.throws(() => memoryImportInput([{ content: 'x' }]), /缺少标题/);
  assert.throws(() => memoryImportInput([{ title: 'x' }]), /缺少正文/);
  assert.throws(() => memoryImportInput({ nope: true }), /必须是记录数组/);
  assert.deepEqual(memoryExportInput(), {});
  assert.deepEqual(memoryExportInput('fact-a'), { id: 'fact-a' });
  assert.throws(() => memoryExportInput(' '), /不能为空/);
});

test('kind policy rows are read-only and normalize snapshot policy shapes', () => {
  const rows = memoryKindPolicyRows(snapshotFixture({
    kindPolicies: {
      fact: { scopes: ['project'], authority: 'user_or_source', ttlDays: 90, reviewAfterDays: 120, pinnedEligible: true, conditionsRequired: true },
      episode: { scopes: ['project'], authority: 'low_auto', ttlDays: 60, reviewAfterDays: 60, pinnedEligible: false, conditionsRequired: true },
    },
  }));
  assert.equal(rows.length, 2);
  const fact = rows.find(row => row.kind === 'fact')!;
  assert.equal(fact.label, '事实');
  assert.deepEqual(fact.scopes, ['project']);
  assert.equal(fact.ttlDays, 90);
  assert.equal(fact.pinnedEligible, true);
  assert.equal(fact.readOnly, true);
  assert.deepEqual(memoryKindPolicyRows({}), []);
  const arrayRows = memoryKindPolicyRows({ kindPolicy: [{ kind: 'profile', scopes: ['personal'], pinnedEligible: true }] });
  assert.equal(arrayRows[0].label, '画像');
});

/* ------------------------------------------------------------------ */
/* Record mutations: merge/split/supersede/toggle helpers              */
/* ------------------------------------------------------------------ */

test('merge/split/supersede/toggle builders validate identity and bulk-edit inputs', () => {
  assert.deepEqual(memoryMergeInput('left', 'right', ' 合并正文 '), { leftId: 'left', rightId: 'right', content: '合并正文' });
  assert.throws(() => memoryMergeInput('same', 'same'), /自身合并/);
  assert.throws(() => memoryMergeInput('', 'right'), /两条记录/);
  assert.throws(() => memorySplitInput('id', [{ title: 'a', content: 'A' }]), /至少需要两个部分/);
  const split = memorySplitInput('id', [{ title: '第一部分', content: 'A' }, { title: '第二部分', content: 'B', conditions: ['条件'] }]);
  assert.deepEqual(split.parts, [
    { title: '第一部分', content: 'A', conditions: [], sources: [] },
    { title: '第二部分', content: 'B', conditions: ['条件'], sources: [] },
  ]);
  assert.throws(() => memorySplitInput('id', [{ title: 'a', content: 'A' }, { title: '', content: 'B' }]), /缺少标题/);
  assert.throws(() => memorySupersedeInput('a', 'a'), /不能相同/);
  assert.deepEqual(memorySupersedeInput('old', 'new'), { oldId: 'old', newId: 'new' });
  const toggles = memoryBulkToggleRequests([record('a', { revision: 3 }), { ...record('b'), revision: undefined }], false);
  assert.deepEqual(toggles, [{ action: 'toggle', input: { id: 'a', revision: 3, enabled: false } }]);
});

/* ------------------------------------------------------------------ */
/* Loading/error/empty states                                          */
/* ------------------------------------------------------------------ */

test('loading, error and empty states are explicit and never claim an empty history', () => {
  assert.equal(memoryCenterDataState({ loading: true }).kind, 'loading');
  assert.equal(memoryCenterDataState({ loading: true, error: '插件不可用' }).kind, 'error');
  const error = memoryCenterDataState({ error: 'VERSION_CONFLICT：版本已变化' });
  assert.equal(error.kind, 'error');
  assert.equal(error.retry, true);
  assert.equal(memoryCenterDataState({ snapshot: {} }).kind, 'empty');
  const records = memoryCenterDataState({ snapshot: snapshotFixture(), tab: 'records' });
  assert.equal(records.kind, 'ready');
  assert.equal(memoryCenterDataState({ snapshot: snapshotFixture({ reviews: [] }), tab: 'reviews' }).kind, 'empty');
  assert.match(memoryCenterEmptyMessage('records', view()), /候选与失效记录在“候选”页/);
  assert.match(memoryCenterEmptyMessage('usage', memoryCenterSnapshotView({})), /没有收据不代表历史中没有相关内容/);
  assert.match(memoryCenterErrorHint('VERSION_CONFLICT: revision changed'), /重新预览/);
  assert.match(memoryCenterErrorHint('归档会话为只读'), /恢复会话/);
  assert.match(memoryCenterErrorHint('OPERATION_UNKNOWN'), /不要盲目重放/);
  assert.match(memoryCenterErrorHint('random failure'), /操作未完成/);
  // The overview of an empty snapshot still maps without fabricated counts.
  const emptyView = memoryCenterSnapshotView({});
  assert.equal(emptyView.hasSnapshot, false);
  assert.equal(emptyView.counts.total, 0);
  assert.deepEqual(emptyView.problems, []);
});

/* ------------------------------------------------------------------ */
/* Action manifest / request wiring                                    */
/* ------------------------------------------------------------------ */

test('the action manifest covers every required controller action and classifies writes', () => {
  const required = [
    'snapshot', 'list', 'search', 'search.explain', 'read', 'read.range', 'conflict.list', 'conflict.resolve',
    'review.list', 'review.resolve', 'autoPublish.status', 'autoPublish.settings', 'autoPublish.revoke',
    'feedback', 'pin', 'unpin', 'update', 'accept', 'toggle', 'forget', 'impact.preview', 'merge', 'split',
    'supersede', 'graph', 'usage', 'diagnostics', 'learning.status', 'learning.run', 'learning.retry',
    'learning.pause', 'learning.resume', 'export', 'import',
  ];
  const actions = new Set(MEMORY_CENTER_ACTIONS.map(item => item.action));
  for (const action of required) assert.ok(actions.has(action), action);
  assert.equal(memoryCenterActionKind('search.explain'), 'read');
  assert.equal(memoryCenterActionKind('impact.preview'), 'preview');
  assert.equal(memoryCenterActionKind('conflict.resolve'), 'write');
  assert.equal(memoryCenterActionKind('import'), 'write');
  assert.equal(memoryCenterActionKind('nope'), undefined);
  assert.ok(memoryCenterActionsOfKind('write').includes('pin'));
  assert.ok(memoryCenterActionsOfKind('read').includes('graph'));
  for (const item of MEMORY_CENTER_ACTIONS) assert.ok(item.purpose.length > 0, item.action);
});

test('every request builder emits an action registered in the manifest (no typo drift)', () => {
  const value = view();
  const pinRequest = memoryPinRequest(value.recordById.get('fact-a'), { ...value.pinned, used: 0 });
  const requests = [
    Object.assign(memoryListInput({}, 0, 20), { action: 'list' }),
    Object.assign(memorySearchInput('q'), { action: 'search' }),
    Object.assign(memorySearchExplainInput('q'), { action: 'search.explain' }),
    Object.assign(memoryReadInput('a'), { action: 'read' }),
    Object.assign(memoryReadSourcesInput('a'), { action: 'read' }),
    Object.assign(memoryReadRangeInput('a', 1), { action: 'read.range' }),
    Object.assign(memoryVersionsInput('a'), { action: 'versions' }),
    Object.assign(memoryGraphRequest({ rootId: 'a' }), { action: 'graph' }),
    Object.assign(memoryUsageRequest(), { action: 'usage' }),
    Object.assign(memoryDiagnosticsRequest(), { action: 'diagnostics' }),
    Object.assign(memoryReviewListInput(), { action: 'review.list' }),
    pinRequest,
    memoryCandidateAcceptRequest(value.candidates[0]),
    memoryCandidateRejectRequest(value.candidates[0]),
    Object.assign(memoryConflictResolveInput(memoryConflictViews(value, 'open')[0], 'keep_left'), { action: 'conflict.resolve' }),
    memoryReviewResolveInput(value.reviews[0], 'confirm') && { action: 'review.resolve', input: memoryReviewResolveInput(value.reviews[0], 'confirm') },
    Object.assign(memoryAutoPublishSettingsInput(value.autoPublish, { mode: 'standard' }), { action: 'autoPublish.settings' }),
    Object.assign(memoryAutoPublishRevokeInput({ batchKey: 'job-1' }, memoryAuditView(value.autoPublish.audit)), { action: 'autoPublish.revoke' }),
    { action: 'import', input: memoryImportInput([{ title: 't', content: 'c' }]) },
    { action: 'export', input: memoryExportInput() },
    { action: 'merge', input: memoryMergeInput('a', 'b') },
    { action: 'split', input: memorySplitInput('a', [{ title: 'x', content: 'y' }, { title: 'z', content: 'w' }]) },
    { action: 'supersede', input: memorySupersedeInput('a', 'b') },
    memoryLearningControlRequest('run'),
    memoryLearningControlRequest('retry', 'job-1'),
    memoryLearningControlRequest('pause'),
    memoryLearningControlRequest('resume'),
  ];
  for (const request of requests) {
    const action = String((request as Json).action || '');
    assert.ok(action, JSON.stringify(request));
    assert.ok(memoryCenterActionKind(action), `unregistered action ${action}`);
  }
  // Preview-token commits of update/forget are write actions; impact.preview is the user preview step.
  assert.equal(memoryCenterActionKind('update'), 'write');
  assert.equal(memoryCenterActionKind('forget'), 'write');
  assert.equal(memoryCenterActionKind('impact.preview'), 'preview');
  assert.deepEqual(memoryBulkPinRequests([record('tiny', { content: 'x' })], { ...value.pinned, used: 0 }, true).actions.map(item => item.action), ['pin']);
});
