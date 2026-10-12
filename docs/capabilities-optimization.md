# Swarm, Memory and Expert optimization contract

Approved scope: SW-01–04, ME-01–04, EX-01–04 and CX-01–03. ME-05, critical-path sorting, adaptive concurrency, undeclared-history search and Topic/Rebuild dependencies are excluded. Integration starts from `e8846297a186f252e20e8aa9d2ab20e90ea805a3`; previous test counts and client evidence are not acceptance of this work.

## Ownership and authority

Pi owns model loops and native JSONL history. Plugins persist business records and exact references. GUI and model tools use the same controllers via `friend-pi:v1:request`; no plugin imports another plugin's controller or shares an authority singleton. The integration branch owns Core, desktop, dependencies, final tests and remote integration. Each package is developed in its own worktree and handed off at fixed commits.

## Execution and resource waiting

Selecting Swarm authorizes cooperation within the current permissions; it never recommends or switches execution modes. Simple tasks may be completed directly by the main agent with required checks. A model planning draft is deterministically validated for dependencies, role/tool/write boundaries, conflicts and available budget before execution. Unknown time/cost remains unknown.

Resource contention is locally retryable only when the host returns `VERSION_CONFLICT` with `details.v=1` and `waitSafe=true`, reservation identity, blocking task/graph and overlapping keys. Expired, abandoned or unknown reservations return `OPERATION_UNKNOWN` without that marker. Permission loss, unknown side effects and global-budget exhaustion remain global safety pauses. Task order, configured concurrency and the 64-node limit are unchanged.

Handoffs retain complete constraints and exact source/artifact/Memory/Skill versions. The 8,000-character default body limit never silently truncates constraints: excess is represented as mandatory registered reads, fulfilled before related execution. A recovery preview is read-only and binds definition/revision, inputs, sources and results. Actual recovery revalidates that binding; unknown side effects are not replayed automatically.

## Memory processing and retrieval

A learning job retains its proposal identity, raw extraction, per-proposal/group state, rejection reason, published memory ID and progress across restarts. Independent invalid proposals do not poison valid ones. Twelve is a normal round target; linked corrections remain atomic, and a larger group owns a round. Authoritative publication checks precede one transaction covering new facts, superseded facts, downstream invalidation and proposal progress.

The same cumulative six-model-call default remains in force. Exhausting it prevents new model requests, not deterministic validation/publication of saved proposals. Optional compaction cannot invalidate published work. Source entry coverage, processed proposals, publication and pending continuation are distinct diagnostics.

Automatic retrieval and active main-agent follow-up reuse FTS5/BM25/CJK and registered `source.read`/`read.range` references. No independent query-rewriting model or raw-history fallback is added. Only clearly applicable, explicit long-term user preferences receive priority, at most two within six complete bodies/3,500 characters and a 1,500-character directory. Bodies and full conditions fit together or remain precise pointers with an omission reason.

## Expert evaluation authority

`PluginContext.expertEvaluation` is an optional host-owned, version-1 capability. `catalog` returns opaque registered case references; `advance` executes a frozen case through public Pi SDK sessions and registered host checks; `read` reconciles its durable operation. Expected answers, hidden task bodies and checker implementations are not supplied by the candidate or exposed through arbitrary shell access. Missing scenarios/checkers/host support leave a candidate in trial/waiting state.

Stable and candidate versions are separate. Trial uses an exact candidate, ordinary adoption continues to use stable versions, and promotion compares stable baseline, candidate and source fences with CAS. In-flight adoption snapshots never change.

Quality growth retains the strict-gain route. Efficiency growth requires both validation and independent release to have total Pi tokens at most 85% of baseline and task-admission-to-final-check elapsed time no greater than baseline. Queue waiting is separate; preparation, tools, failures, retries and checks remain included. Each paired check must avoid baseline-pass/candidate-fail; critical checks and out-of-scope examples all pass. Each stage contains at least two independent positive cases and one out-of-scope negative, each paired three times: at least 36 SDK tasks. Repetitions do not add independent examples.

The default 64-provider-request budget covers both sides, stages, turns and retries. It is not a task count and cannot be reset to finish a sample set. Unknown usage/results, insufficient samples or exhausted request budgets retain trial/waiting. Use Pi `totalTokens` once; cache/reasoning are not added again. Learning and evaluation costs are reported separately from delivery costs. First baselines are the four accepted initial scenario templates; subsequent baselines are the scenario's validated stable method.

## Diagnostics, migration and release

Enhance existing task details with conclusion, basis and gaps; fold raw receipts and link their authoritative pages. Execution end, objective check, independent review and application are separate states. Selection, inclusion in context/request and answer correctness are separate claims. Read-only Memory impact/recovery previews bind revisions and sources and become stale after changes; existing controllers still own mutations.

Memory and Expert operate independently. Database schema changes require scoped migration/backups and old-writer fences; disabling a feature is not a safe database downgrade. Derived indexes may be rebuilt, but old evidence is not upgraded.

Final acceptance binds one new source candidate, Pi SHA, dependency/model/input/data snapshots, App/Bundle/data directory/PID/window and artifact digest. Build, types, tests, real-model journeys, Computer Use, remote merge and evidence sealing remain separate PASS/FAIL/BLOCKED/NOT_RUN gates. Four fixed scenario pairs and targeted feature-off controls test claimed benefits without removing authorization or mandatory checks. Only the integration chat creates and merges the PR after all final gates pass.
