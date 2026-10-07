# @friend-pi/memory

Native Pi package for automatically managed, source-backed project experience and personal preferences. Node 24 is required. Pi JSONL remains the original history; SQLite owns memory records, revisions, suppression and the durable learning queue. No vector service, external Agent backend or forked Pi loop is required.

```sh
mkdir -p /absolute/path/plugins/memory
tar -xzf /absolute/path/friend-pi-memory-VERSION-HASH.tgz -C /absolute/path/plugins/memory
pi install /absolute/path/plugins/memory/package
```

Pi host packages are peers. The desktop and `/memory ACTION JSON` / `friend_memory` use the same controller. Management actions remain available for compatibility and explicit correction; ordinary learning does not require `accept`.

- Automatic Reflection extracts one sourced fact per record, including personal preferences supported by user input. Dream publishes eligible records and keeps unresolved conflicts or unsupported claims internal. Assistant self-evaluation is not verification. Attachment text cannot supply a personal preference or correction instruction; verified `HistoryItem.userText` defines that boundary.
- Distill creates only text methods. Expert independently validates methods; absent Expert preserves the candidate. No scripts, tools or permissions are created.
- `search {query,limit?,match?:"any"}` uses FTS5, CJK bigrams and short-query fallback. Only effective enabled records are recalled. `select {query,limit?,purpose?:"rebuild"}` is pure selection and returns `{records,epoch,budget}`; `hash` is SHA256 of full stored content. `read {id,source?:true}` exposes exact revisions and provenance.
- Source refs carry optional UTF-16 `start/end`, fragment `hash`, stable cross-fork `factId`. Legacy whole-entry refs remain readable; ambiguous legacy references never imply deleting every fact in that entry. `update`, `toggle`, `forget` require revision CAS. Precise invalidation, descendants and suppression commit atomically. Forget removes authority records and versions, while source/fact hashes prevent relearning. Original Pi history is untouched.
- `source.deleted {sessionId}` is a host/user operation. It withdraws solely dependent records and related jobs, preserves records with other sources and emits versioned invalidation. Native session tombstones are checked before learning publication and recall.
- `invalidation.snapshot` returns persistent `{v:2,projectId,epoch,ids,sources}`. Runtime projections `memory-source-epoch:<projectId>` and `memory-source-epoch:*` update in the same transaction; effective epoch is their sum.

Memory-only installations recall effective memories through Pi public context hooks even when Topic/ReBuild is disabled or Pi uses native compression. `friend-pi.memory.usage:v1` custom entries in native JSONL record prepared/context-observed/injected-to-context/request-prepared/response-observed/tool-read stages, exact versions, content hashes, fragment hashes, source refs and character budget. Request preparation is not proof of HTTP dispatch; no stage claims causal model use. SQLite usage data can be restored from native entries after reload. Old history without a receipt remains unrecorded.

Background execution is independent of foreground input. Desktop extensions use `FRIEND_PI_LEARNING_ROLE=producer`; they only enqueue. A native Pi extension without a live desktop learning host executes through its in-process scheduler. A public `peekLearningJob(dataDir)` returns the next eligible job fairly across projects; `MemoryController.executeLearningJob(id,ctx,{signal?})` claims and completes one stage with its own cancellation signal. Job metadata includes project/session paths, source hashes and model identifiers, never keys. The host adapts context independently of any foreground ExtensionContext.

Only one Memory learning stage runs at a time across controllers. Model calls hold no SQLite lock. Pausing, source deletion or correction invalidates affected work; foreground activity does not preempt it. Source/lease/epoch checks reject late results. Three failures stop the job; authentication/configuration failures wait until `wakeLearningJobs(dataDir,projectId?)` or `learning.configuration`. Model calls have no monetary quota. `learning.pause/resume/settings/retry` and `export/versions` remain user management controls.

`memory.invalidated` emits `{v:2,projectId,ids,reason,revision,sourceEpoch,sources}` after commit. Markdown exports are user copies; removing them is independent of deleting plugin records.
