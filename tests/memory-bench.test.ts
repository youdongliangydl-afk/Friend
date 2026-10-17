import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MEMORY_SCHEMA_VERSION} from '../packages/memory/src/schema.ts';

/**
 * P4 evidence-harness tests.
 *
 * The benchmark modules are plain ESM (they import the real controller through
 * tsx). They are loaded dynamically with a computed URL so TypeScript does not
 * need a declaration file for the `.mjs` artefacts, while runtime still uses
 * tsx to resolve the controller imports.
 */
type Scenario = {name: string; run: (fixture: any) => Promise<any>};
type ScenarioModule = {
  SCENARIO_NAMES: string[];
  buildScenarios: () => Scenario[];
  createFixture: (options?: Record<string, unknown>) => any;
};
type DrillModule = {runMigrationDrill: (options?: Record<string, unknown>) => Promise<any>};

async function load<T>(file: string): Promise<T> {
  return (await import(new URL(`../benchmarks/memory/${file}`, import.meta.url).href)) as T;
}

async function scenarioModule(): Promise<ScenarioModule> {
  return load<ScenarioModule>('scenarios.mjs');
}

async function runScenario(name: string, arm: 'on' | 'off', inspect?: (fixture: any, result: any) => void | Promise<void>): Promise<any> {
  const module = await scenarioModule();
  const scenario = module.buildScenarios().find(candidate => candidate.name === name);
  assert.ok(scenario, `scenario ${name} is exported`);
  const fixture = module.createFixture({arm});
  try {
    const result = await scenario.run(fixture);
    if (inspect) await inspect(fixture, result);
    return result;
  } finally {
    await fixture.close();
  }
}

function assertAllOnArm(result: any): void {
  assert.ok(Array.isArray(result.assertions), 'result carries per-assertion evidence');
  assert.equal(result.total, result.assertions.length);
  assert.equal(result.pass, result.total, `on-arm assertions failed: ${JSON.stringify(result.assertions.filter((assertion: any) => !assertion.ok))}`);
}

test('scenario catalog covers blueprint §17.2 with builder-shaped run functions', async () => {
  const module = await scenarioModule();
  const scenarios = module.buildScenarios();
  assert.ok(scenarios.length >= 8, `expected >= 8 scenarios, got ${scenarios.length}`);
  assert.deepEqual(scenarios.map(scenario => scenario.name), module.SCENARIO_NAMES);
  for (const required of ['update', 'conflict', 'stale', 'v1-miss', 'fork', 'autopublish', 'cross-project', 'Chinese', 'episode-task']) {
    assert.ok(module.SCENARIO_NAMES.includes(required), `missing scenario ${required}`);
  }
  for (const scenario of scenarios) {
    assert.equal(typeof scenario.name, 'string');
    assert.equal(typeof scenario.run, 'function');
  }
});

test('paired update scenario: corrected value wins, old version stays historical, empty-memory control is weaker', async () => {
  const on = await runScenario('update', 'on');
  assertAllOnArm(on);
  const off = await runScenario('update', 'off');
  assert.ok(off.pass < on.pass, `off arm ${off.pass}/${off.total} should be weaker than on ${on.pass}/${on.total}`);
  assert.equal(off.total, 5, 'both arms evaluate the same assertions');
});

test('conflict scenario: old value stays usable while the new value is an open-conflict candidate', async () => {
  let snapshot: any;
  const on = await runScenario('conflict', 'on', fixture => {
    snapshot = fixture.snapshot();
  });
  assertAllOnArm(on);
  const oldValue = snapshot.memories.find((record: any) => record.status === 'active' && record.content.includes('SQLite'));
  const newValue = snapshot.candidates.find((record: any) => record.status === 'candidate' && record.content.includes('PostgreSQL'));
  assert.ok(oldValue, 'old value remains active');
  assert.ok(newValue, 'new value stays a candidate');
  assert.equal(newValue.conflictState, 'open');
  assert.equal(snapshot.conflicts.filter((conflict: any) => conflict.status === 'open').length, 1);
  const off = await runScenario('conflict', 'off');
  assert.ok(off.pass < on.pass);
});

test('fork scenario: punctuation/word/quote rewrites after forget never revive the fact', async () => {
  let snapshot: any;
  const on = await runScenario('fork', 'on', fixture => {
    snapshot = fixture.snapshot();
  });
  assertAllOnArm(on);
  const revived = [...snapshot.memories, ...snapshot.candidates].filter((record: any) => String(record.content).includes('串行'));
  assert.deepEqual(revived, [], 'no active or candidate revival');
  const off = await runScenario('fork', 'off');
  assert.ok(off.pass < on.pass);
});

test('stale scenario: expired fact is not recalled but remains visible for review', async () => {
  let snapshot: any;
  let hits: any[] = [];
  const on = await runScenario('stale', 'on', fixture => {
    snapshot = fixture.snapshot();
    hits = fixture.search('访问令牌');
  });
  assertAllOnArm(on);
  assert.deepEqual(hits, []);
  const stale = snapshot.memories.find((record: any) => record.content.includes('访问令牌'));
  assert.ok(stale, 'expired record stays in the reviewable snapshot');
  assert.equal(stale.validTo, '2020-01-01T00:00:00.000Z');
  const off = await runScenario('stale', 'off');
  assert.ok(off.pass < on.pass);
});

test('v1-miss scenario: alias, subject-style and task-context recall work without vectors', async () => {
  const on = await runScenario('v1-miss', 'on');
  assertAllOnArm(on);
  const off = await runScenario('v1-miss', 'off');
  assert.ok(off.pass < on.pass);
  // The scenario records the pure-synonym miss as a documented lexical gap.
  assert.ok(on.detail.includes('synonym='), on.detail);
});

test('Chinese explicit remember activates, while 不要记住 stays unconfirmed and unrecallable', async () => {
  let snapshot: any;
  const on = await runScenario('Chinese', 'on', fixture => {
    snapshot = fixture.snapshot();
  });
  assertAllOnArm(on);
  const positive = snapshot.memories.find((record: any) => record.status === 'active' && record.content.includes('CedarArchive'));
  const negative = snapshot.candidates.find((record: any) => record.content.includes('demo-user'));
  assert.ok(positive, 'explicit remember is active');
  assert.ok(negative, 'negated remember is only a candidate');
  assert.equal(negative.status, 'candidate');
  const off = await runScenario('Chinese', 'off');
  assert.ok(off.pass < on.pass);
});

test('autopublish scenario: high confidence publishes, low confidence waits, bulk revoke retires the value', async () => {
  let snapshot: any;
  const on = await runScenario('autopublish', 'on', fixture => {
    snapshot = fixture.snapshot();
  });
  assertAllOnArm(on);
  assert.ok(snapshot.autoPublish.stats.revoked >= 1, 'the drill revoked one auto-published record');
  assert.ok(!snapshot.memories.some((record: any) => record.status === 'active' && record.content.includes('SQLite')));
  const off = await runScenario('autopublish', 'off');
  assert.ok(off.pass < on.pass);
});

test('cross-project scenario: personal preference crosses projects, project facts do not leak', async () => {
  const on = await runScenario('cross-project', 'on');
  assertAllOnArm(on);
  const off = await runScenario('cross-project', 'off');
  assert.ok(off.pass < on.pass);
});

test('migration drill: v3/v4 fixtures migrate, preserve content, fence old writers and reopen idempotently', async () => {
  const module = await load<DrillModule>('migration-drill.mjs');
  const baseDir = mkdtempSync(join(tmpdir(), 'friend-pi-memory-bench-drill-'));
  try {
    const report = await module.runMigrationDrill({baseDir, write: false, cleanup: false});
    assert.equal(report.v, 1);
    assert.equal(report.kind, 'memory-migration-drill');
    assert.equal(report.fixtures.length, 2);
    assert.equal(report.summary.fail, 0, JSON.stringify(
      report.fixtures.flatMap((fixture: any) => fixture.checks.filter((entry: any) => entry.status === 'FAIL')),
      null,
      2,
    ));
    const v3 = report.fixtures.find((fixture: any) => fixture.name === 'v3');
    const v4 = report.fixtures.find((fixture: any) => fixture.name === 'v4');
    assert.ok(v3, 'v3 fixture was drilled');
    assert.ok(v4, 'v4 fixture was drilled');
    const ids = (fixture: any) => new Set(fixture.checks.map((entry: any) => entry.id));
    const v3Ids = ids(v3);
    for (const id of ['schema.version', 'backup.created', 'records.preserved', 'jobs.preserved', 'suppression.preserved', 'writer.old.write-blocked', 'reopen.idempotent']) {
      assert.ok(v3Ids.has(id), `v3 drill emits ${id}`);
    }
    assert.ok([...v3Ids].some(id => String(id).startsWith('backup.openable:')), 'v3 backup opens');
    assert.ok(ids(v4).has('v4.data.preserved'), 'v4 policy/audit/review/conflict rows survive');
    const v5Checks = report.fixtures.flatMap((fixture: any) => fixture.checks).filter((entry: any) => String(entry.id).startsWith('v5.'));
    assert.ok(v5Checks.length > 0);
    if (MEMORY_SCHEMA_VERSION >= 5) {
      assert.ok(v5Checks.every((entry: any) => entry.status === 'PASS'), JSON.stringify(v5Checks));
    } else {
      assert.ok(v5Checks.every((entry: any) => entry.status === 'PENDING_SCHEMA_V5'), JSON.stringify(v5Checks));
    }
    assert.equal(report.summary.status, 'PASS');
  } finally {
    rmSync(baseDir, {recursive: true, force: true});
  }
});

test('episode/task scenario exercises P1 kinds (TTL + pin boundary) or reports a structured pending status', async () => {
  const on = await runScenario('episode-task', 'on');
  if (on.pending) {
    assert.ok(['PENDING_P1_EPISODE_TASK', 'PENDING_SCHEMA_V5'].includes(on.status), on.status);
    return;
  }
  assertAllOnArm(on);
  assert.match(on.detail, /ttl=60\/14d/u, `episode/task TTL detail: ${on.detail}`);
  const off = await runScenario('episode-task', 'off');
  assert.ok(off.pass < on.pass);
});

test('benchmark report has the documented shape and write:false leaves .artifacts untouched', async () => {
  const module = await load<any>('run.mjs');
  const scenarios = await scenarioModule();
  const artifact = join(process.cwd(), '.artifacts/qa/memory-bench.json');
  const before = existsSync(artifact) ? statSync(artifact).mtimeMs : null;
  const report = await module.runBenchmark({write: false, generatedAt: '2026-10-17T00:00:00.000Z'});
  assert.equal(report.v, 1);
  assert.equal(report.kind, 'memory-bench');
  assert.equal(report.generatedAt, '2026-10-17T00:00:00.000Z');
  assert.equal(report.scenarios.length, scenarios.SCENARIO_NAMES.length);
  assert.equal(report.totals.scenarios, report.scenarios.length);
  assert.equal(report.totals.measured + report.totals.pending, report.totals.scenarios);
  assert.deepEqual(report.totals.onFailures, []);
  for (const scenario of report.scenarios) {
    assert.equal(typeof scenario.scenario, 'string');
    for (const arm of ['on', 'off']) {
      assert.ok(Number.isInteger(scenario[arm].pass), `${scenario.scenario}.${arm}.pass`);
      assert.ok(Number.isInteger(scenario[arm].total), `${scenario.scenario}.${arm}.total`);
      assert.equal(typeof scenario[arm].latencyMs, 'number');
      assert.equal(typeof scenario[arm].status, 'string');
    }
    if (scenario.status === 'MEASURED') assert.equal(typeof scenario.delta, 'number');
  }
  for (const name of ['autopublishPrecision', 'rollbackRate', 'recallUseRate', 'conflictRate', 'duplicateRate', 'expiredRecallRate', 'reviewSla', 'costCalls', 'latencyP95']) {
    assert.ok(name in report.kpi, `kpi.${name} is present`);
    const entry = report.kpi[name];
    assert.ok(entry.value === null || typeof entry.value === 'number', `kpi.${name}.value is number|null`);
    assert.equal(typeof entry.unit, 'string');
    assert.equal(typeof entry.target, 'string');
    assert.equal(typeof entry.status, 'string');
    assert.equal(typeof entry.method, 'string');
  }
  assert.ok(Array.isArray(report.boundary) && report.boundary.some((line: string) => line.includes('Not a real-model benchmark')));
  assert.equal(existsSync(artifact) ? statSync(artifact).mtimeMs : null, before, 'write:false must not touch the evidence file');
});
