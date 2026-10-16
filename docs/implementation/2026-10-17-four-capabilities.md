# Four capabilities implementation, 2026-10-17

Approved user scope: configurable experts and per-spawn overrides; optional dirty baseline/worktree/independent review; preserve concurrency 4/default, 16/max and 64 graph nodes; Memory retrieval/feedback/complete conditions; stable and incremental ReBuild. Pi owns execution and JSONL. This record is an implementation contract, not acceptance.

## Ownership and sequence

Integration owns Core, desktop, root documentation, dependencies/build scripts and final Git integration. Four plugin agents own only their package including focused tests, README and source records, in separate worktrees. Root owns GUI access. Public contract first, fixed package commits second, shared UI and complete candidate validation last. No dependency changes are expected. Original and reference checkouts remain untouched.

## Expert and Swarm bus contract

Expert provides `profile.list {query?,cursor?,limit?}`, `profile.read {id}`, `profile.create`, `profile.update {id,expectedRevision,...patch}`, `profile.copy {id,title?}`, `profile.toggle {id,expectedRevision,enabled}`, and `spawn.resolve {expertId,overrides?}`. User entry points manage persistent profiles; main agents may read/resolve without editing the preset. Profiles contain title, prompt, skillRefs, toolsMode, tools, modelId and thinkingLevel. Existing definitions remain readable and selectable. Explicitly saved profiles are immediately usable and labelled user configured, never falsely growth validated.

`spawn.resolve` returns Core `ResolvedExpertSpawn`. Priority is per-spawn override, preset, then trusted host defaults. Explicit skill/tool arrays replace preset arrays. `toolsMode:inherit` uses the authorized available set; `allowlist` with `tools:[]` means no work tools. Tool and write scope authority is always capped by trusted host/task grants. Explicit unavailable models/tools/skills fail instead of silently falling back. A resolved snapshot's body and versions never change during its run.

Swarm task input adds `expertOverrides:ExpertSpawnOverrides`; existing expertId/roleId/modelId/thinkingLevel remain compatible. Explicit task model/thinking is folded into per-spawn overrides. Main Agent and GUI call the same controller. Native members apply the resolved model before the first provider request, include prompt and selected Skill bodies, expose effective tools, and record the exact snapshot in native JSONL. No Expert module import from Swarm.

## Execution policy

New graphs can explicitly select `executionPolicy:{v:1,workspace:'isolated'|'shared',review:'required'|'none',dirtyBaseline:'snapshot'|'reject'}`. Default/old calls preserve legacy isolated/required/reject behavior; main-agent guidance explains selecting policies for new work. Frozen policies cannot be changed mid-attempt. Shared members do not auto-commit or switch the repository branch. Existing resource controls serialize conflicting writes. Isolated dirty snapshots preserve original index/worktree and integration applies only attempt changes with target drift checks. Explicit user-required review cannot be waived by a child. No review must be reported as not requested, never approved/independent.

## Memory and ReBuild contract

Memory selected records continue exposing complete `conditions`, `validFrom`, `validTo`, sources, id, revision and content hash. Add `semanticDigest` over the fixed ordered object `{id,revision,content,conditions,validFrom:null-or-string,validTo:null-or-string,scope}`; ReBuild retains and validates these fields and computes the same digest. No additional model request for query rewriting.

Memory accepts trusted-user `feedback {id,revision,kind:'relevant'|'irrelevant'|'outdated',taskContext?,operationId?}`; ranking changes remain scoped to normalized taskContext and never modify facts or create preferences. `search/select` accept optional `taskContext:{goal?,scenario?,entities?:string[]}`. Keep existing sources and exact literal priorities.

ReBuild separates original `goal` from `currentRequest`. Status queries retain the goal; explicit replacement/cancellation changes it. Optional trusted host goal context may be used, but standalone operation remains complete. Incremental preparation derives only from Pi sources, retains original source refs for active facts, pages oversized input with explicit omitted/pending ranges, and advances effective coverage only with canonical Pi adoption. Timeline is a derived read view.

## Gates

Focused fake-provider and real Pi tests; typecheck/build/full tests; 15 plugin combinations; explicit configured real-model checks; unique packaged app/data directory/process/window Computer Use. Final commit, Pi SHA and artifact hash must agree. Fresh origin/main is cec5bc975001851260de90875e8af9b8621137cb. Final merge, real model, GUI and remote merge are NOT_RUN at contract creation.
