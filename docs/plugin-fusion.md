# Pi plugin fusion

The product remains four independent native Pi packages: Swarm, Expert, Memory and Topic/Rebuild. Model execution and JSONL belong to the pinned public Pi SDK. Goal, task and process services live in the host and communicate through versioned Pi events.

## Execution modes

- Single uses one foreground Agent, self review and actual objective checks. It rejects delegation and separate goal auditors. Independent Memory learning follows existing configuration.
- Team reuses the Swarm member executor. Children communicate only with their parent and cannot recursively delegate. Reads return directly. Writes require a Git worktree, checks and independent read-only review; the parent explicitly integrates a ready result. Default child model/thinking inherit; explicitly configured alternatives may be selected.
- Swarm uses its existing graph scheduler and adds structured dynamic workflows. Serial dependencies, parallel nodes, typed conditions, bounded retries and dynamic append are supported. Defaults: 4 workers, maximum 16; at most 64 logical nodes. Templates have immutable versions. There is no arbitrary JavaScript workflow execution.

## Continuation and evidence

One durable coordinator admits goal, Team and finite-job wakes. Generations fence explicit stops, durable event IDs deduplicate notices and completions, and saved owner identities reject foreign or stale results. Automatic prompts pass through Pi's public prompt API and native hooks. Receipts mark automatic messages in derived UI/history projections without changing or duplicating native JSONL.

Goals use safe checkpoints for automatic cold restoration; unknown side effects and unsafe checkpoints are never replayed. Goals track observed usage and elapsed active time but have no token or wall-clock budget; legacy budget fields do not pause or gate them. The main Agent records completion after checking the original request and actual result; Goal completion does not require a separate auditor or a saved task/check artifact. Team and Swarm graph reviews still follow each graph's frozen contract, and explicitly omitted independent review is reported honestly. A reviewer role switch in the same Agent is not independent review. Evidence binds source contents, write generations and task/result versions; changed results require fresh checks.

Logical steps persist acceptance conditions, actual check output and repair usage. Two directed repair rounds are allowed, including across restores or replacement execution IDs. Agent methods do not force a refine/research/grill pipeline or upstream pi-task Git side effects. Goals remain owned by their Pi session and are not transferred between sessions. Plan is independent of Single/Team/Swarm: changing the selected mode does not clear a Goal, and Plan suspends automatic Goal wakes until execution is enabled again. See [Goal behavior and API](goal-mode.md) for tool, pause, clear, stop and migration semantics. Valid independent audit evidence can be reused only when its source history and objective/task/code binding still match.

## Background processes

The retained ISC pi-background-tasks 2.6.9 process backend is internal; see third-party/pi-background-tasks/ADAPTATIONS.md. No background Agent dispatch is enabled. Window hiding or session switching keeps processes running. Explicit app quit closes owned groups and keeps logs; cold startup never replays a shell command. Agent finite jobs may resume their owning foreground task; manual commands default to notification only. Chat stop cancels its finite jobs and preserves designated services; services do not block run completion.

This is a high-trust cooperation boundary, not an OS shell sandbox. Recognizable Agent command routes and inline credential assignments are rejected; arbitrary shell behavior is not statically provable. Process ownership reaches the parent supervisor before asynchronous admission finishes. Unknown old PIDs are never adopted or killed from persisted PID values.

## Roles and UI

Expert roles separately freeze responsibilities, tool and write scopes, delivery schemas and optional model mappings. A safe stage receipt authorizes switching; the host applies explicit model mappings before the next model request. Scope remains the intersection with original task permission. Independent reviewers are hard read-only. Existing versioned method validation/evolution remains separate from user-managed contracts. Automatic continuations preserve the frozen role/method catalog for the same authorized run; selecting a role for the next run does not rewrite the active role.

The client has Single/Team/Swarm controls, a task workbench for goals/steps/Team results/workflows/jobs, and an Expert contract editor. GUI and model tools route to the same controllers. Recovering an unknown scene requires an explicit user inspection receipt before new attempts; it does not replay old commands.

Model/thinking selection uses a compact trigger and a native top-layer popover. Opening it leaves composer geometry unchanged. Proposed plans appear at the conversation tail with a three-line preview and no visible revision number; clicking opens full Markdown in the right workbench. Internal plan approval still binds the full revision/hash/model/mode snapshot. Popular provider setup pre-fills public defaults and keeps advanced parameters collapsed; see [provider sources and boundaries](model-provider-presets.md).

## Verification and integration

Default tests use the fake provider and isolated project/data directories. Native SDK lifecycle tests, controller regressions, type checking, build and package checks are self tests. Final product acceptance requires actual Computer Use evidence bound to the exact candidate commit, Pi SHA and artifact hash; unrun real-model or integrated acceptance must be reported as unrun. Goal-mode behavior is documented from implementation and focused tests; integrated client acceptance remains pending the root integration gate.

Implementation is isolated in `codex/friend-pi-plugin-fusion`. The receiving chat owns merging with the concurrent client UX branch and subsequent integration acceptance. Do not apply the candidate directly to the primary Friend checkout.


## Client integration boundaries

The integration preserves the concurrent client UX branch: Enter sends, Cmd/Shift Enter adds a newline, toolCallId records follow the native conversation order, temporary WorkspaceRef identities survive promotion, file saves use content digests, and Node 24 PTY takeover remains separate from process-only jobs. Settings remain in the sidebar footer; only explicitly saved exact models are shown, and a successful current-configuration connection test is mandatory for desktop inference. Role mappings, member models, automatic wakes, generated workflows, plan approval, and native compaction use the same exact-model gate. Standalone Pi packages retain their native authentication policy.

Recovery refuses new goal turns while unknown side effects remain. Job cancellation fences generations instead of permanently blocking a resumed run. Task checks use the same normalized critical-command admission as other jobs. Shutdown checkpoints include foreground idleness, and the parent captures process birth identities before fallback cleanup; a vanished SDK leader does not skip detached-job cleanup. Cleanup failure retains ownership for retry.

The original checkout's three untracked research files are intentionally excluded from this merge so their contents and uncommitted state remain intact. Their incoming copies remain on the plugin-fusion branch. Pi and the vendored process backend are unchanged during client integration.

Unsaved file-editor buffers persist across in-app workspace switches; save before quitting. Native Chinese IME candidate confirmation and a long held-edge project drag require separate manual acceptance; unit guard coverage is not a native-input acceptance claim.

New product Swarm graphs may use a dirty baseline snapshot and isolated or shared workspace. This does not change Team or development-worktree rules. Unified Expert profiles and per-spawn overrides supplement legacy role/method adoption; see the 2026-10-17 contracts.
