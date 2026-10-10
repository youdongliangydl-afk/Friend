# @friend-pi/memory

Source-backed project experience and stable personal preferences for Pi. Node 24 is required. Pi JSONL owns native session history; Memory SQLite owns records, immutable revisions, suppression, operations and learning checkpoints. The plugin works without Expert or Swarm and does not invoke either capability during learning.

```sh
mkdir -p /absolute/path/plugins/memory
tar -xzf /absolute/path/friend-pi-memory-VERSION-HASH.tgz -C /absolute/path/plugins/memory
pi install /absolute/path/plugins/memory/package
```

Pi host packages are peers. UI, `friend_memory` and `/memory ACTION JSON` call the same controller. No embedding model, reranker, vector service, duplicated chat store or fork of the Pi loop is added.

## Records and writes

New records are `fact`, `experience` or `preference`; preferences use personal scope. Records carry aliases, complete conditions, evidence, explicit dependencies, validity/review times, revisions and content SHA-256. Legacy `method` records retain IDs and history for read-only inspection and are excluded from recall. Old distill checkpoints migrate to cancelled; Memory no longer creates or submits Expert methods.

`save`, `update`, `accept`, `toggle`, `forget` and learning controls accept `operationId`. Retries with the same ID and payload return the committed result; reuse with another payload fails with `VERSION_CONFLICT`. Existing mutations accept `expectedRevision` (the legacy `revision` spelling remains supported). `update` accepts a patch. Origin comes from the trusted entry point; model arguments cannot elevate it. Legacy calls without operation IDs remain compatible but cannot reconcile a timeout by identity.

Explicit user remembrance is active; model proposals remain candidates until deterministic validation. Automatic stable preferences require an original sustained user statement or two independent native user entries. Forked copies and repeated fragments in one entry do not add independent support. Attachments, quoted instructions, temporary goals and assistant self-evaluation cannot become user authority.

Sources use exact native UTF-16 spans/hashes and artifact observations use registered version/hash/ranges, receipt ID and observer. Unknown or unobserved ranges fail closed. SourcePolicy checks public policy and frozen dependencies on the same SQLite connection as the short business transaction. Personal cross-project source grants expose only registered spans, never the whole originating project.

## Retrieval and evidence

- `search {query,scope?,limit?,match?}` returns effective records. Weighted FTS5 BM25 uses title 5, aliases 3, body 1; NFKC/Latin normalization and CJK bigrams affect only the index. Exact IDs, titles and code/path aliases are prioritized. Existing default all-term matching is preserved; `match:"adaptive"` tries conjunction then bounded disjunction, and `match:"any"` is explicit disjunction.
- `search.explain {queryId}` or `{query}` reports matched fields/terms, filtering reasons and rule version. Query caches expire after 24 hours and retain terms, not full prompts.
- `directory {query?,scope?,budget?}` returns versioned pointers and explicit omissions. `select {query,scope?,budget?,limit?}` returns separate directory and whole-body selections. Defaults are 1500 directory characters, 3500 body characters and 6 records. Conditions are preserved; oversized bodies remain unread pointers rather than truncated claims.
- `read {id,revision?,source?}`, `read.range {id,revision,cursor?,maxChars?}` and `source.read {source|artifact,cursor?,maxChars?}` provide immutable versions, bounded UTF-16 pages and controlled original source access. Pages report exact visible ranges, full length, slice hash and next cursor; a stale current revision fails CAS. The read limit is 8000 characters.
- `usage` distinguishes prepared/selected, context injection, observed provider request, response and native tool reads. Directory and body each have EvidenceReceipts. No receipt claims causal model adoption or answer correctness. `source.read` records actual tool observation separately. Native receipts are journaled before SQLite projections and restore on cold start.

Expired records are excluded; `reviewAfter` only marks review due. Conflicting subject records are excluded from automatic use. New user corrections, forgetting and source withdrawal take precedence over late learning results. Forget removes body/version/index/evidence data and redacts body/title/conditions from usage and operation projections, retaining tombstones and scoped suppression. Native historical receipts remain immutable; original-history deletion is a host operation. A new explicit user remembrance can lift only its matching scoped suppression.

## Independent background learning

The persistent pipeline is `extract → validate → publish → optional compact`. Ordinary batches use one extraction call; validation and publication call no model. Compaction is limited to at least three active same-subject records, at most one extra call, and must retain the original claims, conditions and evidence. It never creates Expert methods.

Batches cover at most 80 native entries and 48000 UTF-16 source characters; oversized entries are split with exact ranges. Complete and pending ranges are tracked separately. More than 12 proposals stay pending rather than advancing full coverage. The source/model/rule fingerprint prevents rescanning covered ranges. Jobs freeze the explicitly configured background model or source task model and register an independent LearningBudget; the foreground run is provenance, not reusable quota.

The desktop host and native extension use `peekLearningJob` and `executeLearningJob(id,ctx,{signal?,lease?,budgetId?})`. Generic host admission honors foreground priority; normal foreground input does not abort in-flight work. Pausing, source invalidation, stale owner token or public policy change prevents late publication. Claims have a 60-second lease with 10-second heartbeats. Ordinary failures stop after three attempts; authentication/configuration waits without retry churn. Unknown remote results persist as `operation_unknown` and cannot be blindly retried. `learning.status`, `learning.run/retry/pause/resume/settings` and `operation.get` expose the same durable state.

## Managed Markdown and migration

`memory-views/<scope>/MEMORY.md`, `records/<id>.md` and `manifest.json` are read-only derived views in application data, not files in the user repository. SQLite changes enqueue a durable projection. Files are staged, bodies atomically installed and the manifest replaced last; revision/epoch/hash or external-edit drift triggers regeneration, never import. Model reads use the controller so ordinary filesystem reads cannot silently adopt stale projections. `projection.status/rebuild` validates/reconciles views. A failed projection does not roll back valid database content.

Schema v2 migration backs up SQLite, records a checksum and applies changes transactionally. Unavailable legacy evidence remains a candidate; native JSONL is not rewritten. `export` remains a user copy and is independent of managed views.

Focused tests cover controller safety and public Pi faux requests. Real-model semantic quality and packaged Computer Use journeys require integration acceptance and are not implied by these tests.
