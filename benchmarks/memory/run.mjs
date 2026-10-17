/**
 * Paired counterfactual harness for Friend Memory (blueprint §17, P4).
 *
 *   node --import tsx benchmarks/memory/run.mjs [--out <file>] [--no-write]
 *
 * For every scenario in `scenarios.mjs` the harness runs two arms:
 *   - on : real MemoryController + real SQLite, scenario seeds memory;
 *   - off: same probes against an empty-memory database (the control).
 * The delta is the observable contribution of memory for that scenario.
 *
 * Evidence is written to `.artifacts/qa/memory-bench.json` by default and the
 * report is printed as JSON on stdout. The provider is always the deterministic
 * fake provider: this is not a real-model quality benchmark.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildScenarios, collectFixtureMetrics, createFixture, createMetrics } from './scenarios.mjs';
import { MEMORY_SCHEMA_VERSION, MEMORY_WRITER_VERSION } from '../../packages/memory/src/schema.ts';

export const DEFAULT_OUT = '.artifacts/qa/memory-bench.json';

const round = (value, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

function percentile(values, ratio) {
  const sorted = [...values].filter(value => typeof value === 'number' && Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function normalizeArm(result) {
  const assertions = Array.isArray(result?.assertions) ? result.assertions : [];
  const pass = Number.isInteger(result?.pass) ? result.pass : assertions.filter(assertion => assertion?.ok).length;
  const total = Number.isInteger(result?.total) ? result.total : assertions.length;
  const pending = result?.pending === true;
  return {
    pass,
    total,
    status: pending ? String(result.status ?? 'PENDING') : 'MEASURED',
    pending,
    ok: pending ? false : total > 0 && pass === total,
    latencyMs: typeof result?.latencyMs === 'number' ? result.latencyMs : 0,
    detail: typeof result?.detail === 'string' ? result.detail : '',
    assertions,
  };
}

function kpi(value, unit, target, method, status) {
  return {
    value,
    unit,
    target,
    status: status ?? (value === null ? 'NO_SAMPLE' : 'MEASURED'),
    method,
  };
}

/** Derive the blueprint §17.1 KPI block from the raw run counters. */
export function summarizeKpis(metrics, scenarioLatencies = []) {
  const precisionDenominator = metrics.verifiedAutoPublished + metrics.autoCorrected;
  const autopublishPrecision = precisionDenominator > 0 ? round(metrics.verifiedAutoPublished / precisionDenominator) : null;
  const rollbackDenominator = metrics.verifiedAutoPublished + metrics.autoCorrected;
  const rollbackRate = rollbackDenominator > 0 ? round((metrics.autoCorrected + metrics.autoUnintendedRevoked) / rollbackDenominator) : null;
  const recallUseRate = metrics.recalls > 0 ? round(metrics.relevantFeedback / metrics.recalls) : null;
  const conflictRate = metrics.activeRecords > 0 ? round(metrics.openConflicts / metrics.activeRecords) : null;
  const duplicateRate = metrics.activeRecords > 0 ? round(metrics.duplicateActive / metrics.activeRecords) : null;
  const expiredRecallRate = metrics.recalls > 0 ? round(metrics.expiredRecalls / metrics.recalls) : null;
  const reviewSla = metrics.reviewDue > 0 ? round(metrics.reviewHandled / metrics.reviewDue) : null;
  const latencySource = metrics.recallLatencies.length ? metrics.recallLatencies : scenarioLatencies;
  const latencyP95 = latencySource.length ? round(percentile(latencySource, 0.95), 3) : null;
  const costCallsPer1k = metrics.activeRecords > 0 ? round(metrics.providerCalls / metrics.activeRecords * 1000, 2) : null;

  return {
    autopublishPrecision: kpi(
      autopublishPrecision,
      'ratio',
      '>= 0.95',
      'verified auto-published facts / (verified + user-corrected); deliberate benchmark revokes are excluded (drillRevokes counter)',
    ),
    rollbackRate: kpi(
      rollbackRate,
      'ratio',
      '<= 0.02',
      'user-corrected or unintentionally revoked auto-publications / verified auto-publications; deliberate drill revokes excluded',
    ),
    recallUseRate: kpi(
      recallUseRate,
      'ratio',
      'baseline + 20%',
      'simulated relevant feedback on a recall hit / recall attempts (proxy: the fake harness cannot observe later citations)',
    ),
    conflictRate: kpi(
      conflictRate,
      'ratio',
      'declining and explainable',
      'open conflict objects / active records at the end of every on-arm scenario',
    ),
    duplicateRate: kpi(
      duplicateRate,
      'ratio',
      '< 0.01',
      'active records sharing one project+scope+subject+value / active records',
    ),
    expiredRecallRate: kpi(
      expiredRecallRate,
      'ratio',
      '= 0',
      'recalls returning a record whose validTo/expiresAt is in the past / recall attempts',
    ),
    reviewSla: kpi(
      reviewSla,
      'ratio',
      '>= 0.80',
      'resolved due-review items / due items; the stale scenario lists the due item via review.list and resolves it via review.resolve',
      reviewSla === null ? (metrics.reviewApi ? 'NO_SAMPLE' : 'PENDING_P1_REVIEW_QUEUE') : 'MEASURED',
    ),
    costCalls: kpi(
      metrics.providerCalls,
      'provider calls',
      'budgeted and observable',
      'fake-provider completions across all on-arm scenarios; the harness never calls a network provider',
    ),
    costCallsPer1kMemories: kpi(
      costCallsPer1k,
      'calls / 1k active records',
      'budgeted and observable',
      'provider calls scaled to 1000 active records (small-sample evidence only)',
    ),
    latencyP95: kpi(
      latencyP95,
      'ms',
      '<= 150 (local)',
      'p95 of local search/select recall latency; fake provider, tmpdir SQLite, single process',
    ),
    drillRevokes: kpi(
      metrics.drillRevokes,
      'records',
      'informational',
      'records intentionally revoked by the autopublish rollback drill; excluded from precision/rollback ratios',
    ),
  };
}

/**
 * Pure report builder. `runBenchmark` calls this directly, tests call it (or
 * runBenchmark with `write:false`) to validate the evidence shape without
 * touching `.artifacts`.
 */
export function buildReport({scenarioResults, metrics, generatedAt = new Date().toISOString()}) {
  const scenarioLatencies = scenarioResults
    .map(entry => entry?.on?.latencyMs)
    .filter(value => typeof value === 'number' && Number.isFinite(value));
  const scenarios = scenarioResults.map(entry => {
    const pending = entry.on.pending === true;
    return {
      scenario: entry.scenario,
      status: pending ? entry.on.status : 'MEASURED',
      on: entry.on,
      off: entry.off,
      delta: pending ? null : entry.on.pass - entry.off.pass,
      detail: entry.on.detail,
    };
  });
  const totals = {
    scenarios: scenarios.length,
    measured: scenarios.filter(scenario => scenario.status === 'MEASURED').length,
    pending: scenarios.filter(scenario => scenario.status !== 'MEASURED').length,
    onPass: scenarios.reduce((sum, scenario) => sum + scenario.on.pass, 0),
    onTotal: scenarios.reduce((sum, scenario) => sum + scenario.on.total, 0),
    offPass: scenarios.reduce((sum, scenario) => sum + scenario.off.pass, 0),
    offTotal: scenarios.reduce((sum, scenario) => sum + scenario.off.total, 0),
    onFailures: scenarios.filter(scenario => scenario.status === 'MEASURED' && !scenario.on.ok).map(scenario => scenario.scenario),
  };
  return {
    v: 1,
    kind: 'memory-bench',
    generatedAt,
    environment: {
      node: process.version,
      platform: process.platform,
      provider: 'fixture/offline (fake)',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      writerVersion: MEMORY_WRITER_VERSION,
      branch: 'codex/memory-p0-20261017',
    },
    pairing: 'on=real MemoryController with seeded memory; off=same probes against an empty-memory control',
    scenarios,
    totals,
    kpi: summarizeKpis(metrics, scenarioLatencies),
    metrics: {...metrics, recallLatencySamples: metrics.recallLatencies.length},
    boundary: [
      'Offline paired counterfactual harness: deterministic fake provider + real MemoryController + real SQLite in temp dirs.',
      'Not a real-model benchmark: no network call, no embedding/vector/reranker, no human relevance judgement.',
      'The `off` arm is an empty-memory control for the same probes; it measures the observable contribution of memory, not a model-quality delta.',
      'KPI values are proxies over a small deterministic sample; see kpi.<name>.method and README section "Method boundary".',
      'episode/task and review-SLA probes run against the P1 APIs when present; older checkouts report PENDING_P1_EPISODE_TASK / PENDING_P1_REVIEW_QUEUE instead of faking a pass.',
    ],
  };
}

/**
 * Run every scenario on both arms and return the evidence report.
 * `write:false` keeps the workspace untouched (used by tests).
 */
export async function runBenchmark(options = {}) {
  const metrics = options.metrics ?? createMetrics();
  const names = options.scenarios ? new Set(options.scenarios) : undefined;
  const selected = buildScenarios().filter(scenario => !names || names.has(scenario.name));
  const scenarioResults = [];
  for (const scenario of selected) {
    const arms = {};
    for (const arm of ['on', 'off']) {
      const fixture = createFixture({arm, metrics});
      let result;
      const startedAt = performance.now();
      try {
        result = await scenario.run(fixture);
      } catch (error) {
        result = {
          pass: 0,
          total: 1,
          ok: false,
          detail: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs: round(performance.now() - startedAt),
          assertions: [{name: 'scenario completed', ok: false, detail: String(error)}],
        };
      }
      try {
        collectFixtureMetrics(fixture);
      } catch {
        /* Metrics are advisory; a snapshot failure must not hide the scenario result. */
      }
      arms[arm] = normalizeArm(result);
      await fixture.close();
    }
    scenarioResults.push({scenario: scenario.name, on: arms.on, off: arms.off});
  }
  const report = buildReport({
    scenarioResults,
    metrics,
    ...(options.generatedAt ? {generatedAt: options.generatedAt} : {}),
  });
  if (options.write === true) {
    const outFile = resolve(options.outFile ?? DEFAULT_OUT);
    mkdirSync(dirname(outFile), {recursive: true});
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function parseArgs(argv) {
  let outFile = DEFAULT_OUT;
  let write = true;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--out') {
      const next = argv[++index];
      if (!next) throw new Error('--out requires a path');
      outFile = next;
    } else if (argument === '--no-write') {
      write = false;
    } else if (argument === '--help' || argument === '-h') {
      console.error('usage: node --import tsx benchmarks/memory/run.mjs [--out <file>] [--no-write]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return {outFile, write};
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const {outFile, write} = parseArgs(process.argv.slice(2));
    if (write) {
      const absolute = resolve(outFile);
      if (existsSync(absolute)) console.error(`overwriting ${absolute}`);
    }
    const report = await runBenchmark({write, outFile});
    console.log(JSON.stringify(report, null, 2));
    if (report.totals.onFailures.length) {
      console.error(`memory-bench on-arm failures: ${report.totals.onFailures.join(', ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
