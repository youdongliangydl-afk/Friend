# Memory benchmark + migration drill (P4 evidence harness)

Offline, deterministic evidence for the Friend Memory P1–P4 work:

- **paired counterfactual scenarios** from blueprint §17.2 — `scenarios.mjs` + `run.mjs`;
- **v3/v4 → current schema migration drill** — `migration-drill.mjs`;
- **focused regression tests** — `tests/memory-bench.test.ts`.

Everything runs against the **real `MemoryController`**, a **real SQLite file** in
a throw-away directory and a **deterministic fake `PluginContext` provider**
(the same fixture style as `packages/memory/test/*.test.ts`). There are no new
dependencies, no network calls and no embeddings.

## Commands

```bash
# paired on/off benchmark -> .artifacts/qa/memory-bench.json (JSON also on stdout)
node --import tsx benchmarks/memory/run.mjs

# same run without writing evidence
node --import tsx benchmarks/memory/run.mjs --no-write

# migration drill -> .artifacts/qa/memory-migration-drill.json
# fixtures are kept under .artifacts/qa/memory-migration-drill/<run-id>/
node --import tsx benchmarks/memory/migration-drill.mjs

# deterministic tests (tmpdirs only; never writes .artifacts)
node --import tsx --test tests/memory-bench.test.ts
```

`run.mjs` exits non-zero only when an **on-arm** scenario fails (the off arm is
expected to fail most probes). `migration-drill.mjs` exits non-zero on a `FAIL`
check; `PENDING_SCHEMA_V5` checks do not fail the drill.

Both scripts accept `--out <file>` and `--no-write`; the drill additionally
accepts `--base-dir <dir>` and `--cleanup`. `--no-write` skips the JSON evidence
file; the drill then uses a temporary fixture directory (removed on exit) unless
an explicit `--base-dir` is given.

## Scenarios (blueprint §17.2)

| scenario | on-arm seeds | what the assertions prove |
|---|---|---|
| `update` | one fact, then a user `update` with a new value | only the new value is active/recallable; the old value survives in `versions`/historical `read` |
| `conflict` | two independent sources with different values | old value stays active/usable; new value is an open-conflict candidate; the unresolved value is never retrieved |
| `stale` | fact with `validTo`/`reviewAfter` in the past | not recalled, not selected, excluded as `validity` in `search.explain`; still visible in the reviewable snapshot and readable by the user |
| `v1-miss` | record with aliases + ASCII subject | alias, subject-style alias and task-context-only recall work without vectors; a pure synonym query is recorded as the known lexical gap |
| `fork` | fact, `forget`, then forked re-quote + re-word proposals | no active or candidate revival; suppression family catches changed bytes |
| `autopublish` | high-confidence user fact + experience + low-confidence assistant guess | high confidence publishes with a rollback token; low confidence stays candidate; batch revoke retires both published records and re-learning cannot revive them |
| `cross-project` | personal preference + project fact | preference is available/selected in another project; the project fact never leaks |
| `Chinese` | agent-origin explicit/negated remember | “请帮我记住” confirms an active memory; “不要记住” stays a candidate, is not recalled, and cannot confirm a personal preference |
| `episode-task` | P1 episode/task kinds with trigger/state conditions | kinds and conditions are preserved; episode/task are recallable across sessions; they cannot enter the pinned prefix; episode TTL (60 d) is longer than task TTL (14 d). Older checkouts without the P1 API report **PENDING_P1_EPISODE_TASK** (or **PENDING_SCHEMA_V5** pre-v5) instead of faking a pass |

Every scenario is a builder `{name, run(fixture) -> {pass,total,ok,detail,latencyMs,assertions}}`
exported from `scenarios.mjs` (`buildScenarios()` / `scenarioByName()`).

### Paired counterfactual

`run.mjs` runs each scenario twice:

- `on` — memory is seeded through the public controller and the probe runs;
- `off` — the **same probe code** runs against an **empty memory database**
  (nothing is seeded). It is the control for “what does memory add?”.

`delta = on.pass − off.pass`. The off arm is not a weaker model or a feature
flag: it is the same controller with no memory content.

## Evidence format

### `.artifacts/qa/memory-bench.json`

```jsonc
{
  "v": 1,
  "kind": "memory-bench",
  "generatedAt": "…",
  "environment": {"node":"v24…","platform":"darwin","provider":"fixture/offline (fake)","schemaVersion":5,"writerVersion":6,"branch":"codex/memory-p0-20261017"},
  "pairing": "on=real MemoryController with seeded memory; off=same probes against an empty-memory control",
  "scenarios": [{
    "scenario": "update",
    "status": "MEASURED",          // or PENDING_…
    "on":  {"pass":5,"total":5,"status":"MEASURED","pending":false,"ok":true,"latencyMs":12.3,"detail":"…","assertions":[{"name":"…","ok":true}]},
    "off": {"pass":1,"total":5,"status":"MEASURED","pending":false,"ok":false,"latencyMs":4.1,"detail":"…","assertions":[…]},
    "delta": 4,
    "detail": "…"
  }],
  "totals": {"scenarios":9,"measured":9,"pending":0,"onPass":52,"onTotal":52,"offPass":16,"offTotal":52,"onFailures":[]},
  "kpi": {"autopublishPrecision":{"value":1,"unit":"ratio","target":">= 0.95","status":"MEASURED","method":"…"}, …},
  "metrics": {"recalls":21,"recallHits":10,"expiredRecalls":0,"relevantFeedback":5,"providerCalls":6,…},
  "boundary": ["…"]
}
```

`pass`/`total` are per-assertion counts; `ok` is `pass === total` for a
measured arm (always `false` for pending arms). Assertions are kept so a failed
run is diagnosable without rerunning.

### KPI definitions (blueprint §17.1)

| KPI | formula in this harness | target |
|---|---|---|
| `autopublishPrecision` | verified auto-published / (verified + user-corrected); deliberate drill revokes are reported separately in `drillRevokes` and excluded | ≥ 0.95 |
| `rollbackRate` | user-corrected or unintentionally revoked auto-publications / verified auto-publications (drill revokes excluded) | ≤ 0.02 |
| `recallUseRate` | simulated relevant feedback on a recall hit / recall attempts (proxy; no later-citation observation) | baseline +20% |
| `conflictRate` | open conflict objects / active records at the end of every on-arm scenario | declining/explainable |
| `duplicateRate` | active records sharing project+scope+subject+value / active records | < 0.01 |
| `expiredRecallRate` | recalls returning `validTo`/`expiresAt` ≤ now / recall attempts | 0 |
| `reviewSla` | resolved due-review items / due items; the stale scenario lists the due item through `review.list` and resolves it with `review.resolve` | ≥ 0.80 |
| `costCalls` | fake-provider completions across on-arm scenarios | budgeted/observable |
| `costCallsPer1kMemories` | `costCalls` scaled to 1000 active records | budgeted/observable |
| `latencyP95` | p95 of local `search`/`select` latency | ≤ 150 ms local |

### `.artifacts/qa/memory-migration-drill.json`

```jsonc
{
  "v": 1,
  "kind": "memory-migration-drill",
  "environment": {"schemaVersion":5,"writerVersion":6,"oldWriterVersion":4,…},
  "fixtures": [{
    "name": "v3",
    "dir": ".artifacts/qa/memory-migration-drill/<run>/v3",
    "checks": [{"id":"backup.openable:before-v4-….sqlite","title":"…","status":"PASS","detail":"integrity=ok records=5"}, …],
    "counts": {"before": {…}, "after": {…}},
    "backups": ["…/memory-migration-backups/before-v4-….sqlite", "…/before-v5-….sqlite"],
    "migration": {"version":5,"migrated":true,"migrations":{"v4":true,"v5":true},"v4BackupPath":"…","v5BackupPath":"…"}
  }, {"name":"v4", …}],
  "summary": {"pass":40,"fail":0,"pending":0,"status":"PASS"},
  "boundary": ["…"]
}
```

The drill checks:

1. **backup created, 0700 directory, openable (`integrity_check=ok`)** and it
   still contains the pre-migration record count;
2. **record JSON/status, learning jobs (with `proposalLedger`), usage receipts,
   suppression rows and operation ledger preserved** byte-for-byte;
3. **forget suppression survives** and a re-learned proposal with the forgotten
   text cannot create a record;
4. an **old writer** (`friend_pi_writer_version() => 4`) can read but its
   `INSERT`/`UPDATE` fail with `Friend data requires a newer writer`;
5. a **second open is a no-op**: no new migration row, no new backup, no duplicates;
6. **v5 assertions** (schema row 5 + checksum, writer 6 triggers, `memory_relations`
   / `memory_consolidations`, `pinned*`/`decay_score`/`consolidation_id`/
   `project_ids_json` columns). When `MEMORY_SCHEMA_VERSION < 5` these are
   reported as `PENDING_SCHEMA_V5` instead of failing.

Fixture content: active/candidate/inactive/invalidated records plus a legacy
`method` row, completed/queued learning jobs with a proposal ledger, usage,
content/family suppression rows, an operation row and v2/v3 migration rows. The
v4 fixture adds v4-only policy/audit/review/conflict rows (and their sides).

## Method boundary (important)

- **Fake provider only.** `ctx.complete` returns fixed JSON; no real model is
  called and no credentials are read. These numbers are **not** a real-model
  quality benchmark and must not be presented as autopublish precision on real
  traffic.
- **No vectors/embeddings/reranker/query rewriting.** Recall is lexical +
  subject/alias/context metadata, exactly the no-vector product boundary.
- **Small deterministic sample.** Nine scenarios, one run, tmpdir SQLite in one
  process. Latency is local JS/SQLite latency, not desktop or provider latency.
- **Recall-use is a proxy.** The harness simulates a `relevant` feedback click
  for an expected hit; it cannot observe later citations or answer quality.
- **Review SLA is a one-item proxy.** The stale scenario exercises the real
  `review.list` → `review.resolve` path for one due item; it demonstrates the
  queue/SLA plumbing, not a production SLA distribution.
- **Episode/task depends on the P1 kind API.** The scenario exercises it when
  present; an older checkout reports `PENDING_P1_EPISODE_TASK` (or
  `PENDING_SCHEMA_V5` pre-v5) rather than faking a pass.
- **On/off is a content control, not an ablation of code paths.** Both arms run
  the same controller; only seeded memory differs.
- **Evidence is not a commit.** Bind these artefacts to the candidate commit and
  Pi SHA in the P4 handoff; `.artifacts/` is gitignored, so archive it with the
  delivery.

## Files

- `benchmarks/memory/scenarios.mjs` — fixtures + scenario builders;
- `benchmarks/memory/run.mjs` — paired runner, KPI derivation, evidence writer;
- `benchmarks/memory/migration-drill.mjs` — v3/v4 fixtures + migration checks;
- `tests/memory-bench.test.ts` — deterministic tests (tmpdirs, no `.artifacts`).
