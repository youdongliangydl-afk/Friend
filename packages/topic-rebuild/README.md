# @friend-pi/topic-rebuild

Source-backed working fields, optional infinite-context preparation and Pi original-history lookup. Node 24 and the host Pi packages are required. Memory is optional; Pi owns execution and JSONL history.

```sh
mkdir -p /absolute/path/plugins/topic-rebuild
tar -xzf /absolute/path/friend-pi-topic-rebuild-VERSION-HASH.tgz -C /absolute/path/plugins/topic-rebuild
pi install /absolute/path/plugins/topic-rebuild/package
```

Pi does not unpack local tarballs automatically. The generated unpacked package directory can also be installed directly.

## Modes

The default is **native**: Pi decides when and how to compact. Installing this plugin adds no normal-turn model call, no automatic Memory recall and no working-field checkpoint. Existing `{enabled:true}` records do not opt the user into infinite context.

Explicitly select infinite mode through the same controller used by the desktop:

```text
/topic-rebuild settings {"mode":"infinite"}
/topic-rebuild settings {"mode":"native"}
```

Settings are user-owned. In infinite mode, `agent_before_settle` can contribute an incremental deterministic working-field custom draft, preserving other extensions' drafts. This costs no additional model call per message. Goals, constraints, decisions, unfinished work and implicit topics are derived from original source fragments. `goal` retains the original task; `currentRequest` tracks the latest user request. Both keep all clauses within a 3,000-character bound with individual source fragments, so later subtasks are retained and an invalidated constraint does not erase unrelated goal clauses. Progress/status questions and steering retain the task; explicit replacement establishes a new task and explicit cancellation sets `goalStatus:cancelled`. Deterministic intent recognition accepts direct Chinese/English task commands and conservatively keeps the goal for ambiguous prose. The summary model cannot replace goal identity. Topic labels never control tools or execution.

## Preparation and adoption

Pi's public `session_before_compact` hook handles manual, threshold and overflow compaction. It selects at most four current Memory records through the optional, non-model `memory.select` request, then makes one summary model request. It records each selected Memory ID, revision, content hash, complete conditions, validity dates, scope, source references and semantic digest; selects with the retained goal as `taskContext`; and revalidates the complete semantic identity plus sources before reuse. The semantic digest is SHA256 of the fixed ordered object `{id,revision,content,conditions,validFrom,validTo,scope}`, with missing dates normalized to `null`. Records missing verifiable semantic metadata are excluded. It does not claim that the model necessarily relied on a particular record. Normal-turn memory injection belongs to the Memory plugin.

The result belongs only to the session. Preparation never creates or updates long-term Memory. The plugin preserves Pi's exact retained-tail entry, validates citations and budget, and returns a structured compaction. `coverage:{v:1,ranges,pending,complete,toolRanges?}` records verified UTF-16 ranges already processed and the exact ranges still pending. Each preparation reads at most 36,000 new original characters and 6,000 per entry; the first page of a large entry splits its remaining allowance between the head and tail (up to 3,000 characters each). Later pages fill the middle, and constraints crossing a page boundary become eligible when the full fact is covered. Deterministic checkpoints leave unrepresented tool output pending; only a canonical compaction may add the tool spans actually supplied to its model into `toolRanges`. These spans survive later checkpoints and cold starts. Legacy coverage without `toolRanges` conservatively rereads tool output once. A checkpoint with only pending tool spans and no new deterministic input emits no redundant draft. Subsequent summaries carry source-backed active facts instead of resending adopted raw entries. A prompt with no new original spans is valid. Pending ranges remain explicit in the summary and reachable through original-history tools. `coveredThroughId` advances only through the contiguous fully processed original prefix; `compactedThroughId` describes the prefix actually replaced before the retained tail. Added inputs remain original messages outside the captured coverage. A new explicit replacement/cancellation invalidates an in-flight result; ordinary new steering stays in Pi's retained tail. Unadopted or rejected drafts never move the range cursor, including after cold restart.

Adoption requires Pi's actual canonical journal entry with the unique operation identity. Provider success, a draft, an event callback or equal summary text cannot advance the effective watermark. Source changes, persisted Memory epoch changes and session deletion fence a late result. Missing models, malformed summaries and budget failure return control to Pi's normal compaction. Cancellation returns `cancel:true`, preserving the effective field and avoiding an additional native summary request.

During compaction/background preparation, an optional 250 ms non-model `runtime.goal.read` request may supply a host goal. ReBuild accepts it only for the current project/session, with active user origin, a matching native `friend-pi.goal.receipt`, and an objective that occurs literally in original user history. Later explicit task changes take precedence, and changed receipts fence adoption. Normal settlement makes no runtime request. Missing runtime support leaves standalone goal handling intact.

A learning host can call:

```ts
await controller.prepareDraft(context, {
  reason: 'threshold',
  signal,
});
```

The optional `memorySelection` input uses `{records,epoch}` from `memory.select`. Supply `NativeBindings.entries` when the host has Pi canonical entries available. Background preparation writes only a derived draft and hashed index in SQLite: it does not append the foreground JSONL or advance canonical coverage. An unchanged matching draft avoids another preparation request. Foreground compaction can reuse a draft with matching source digest, base revision, Memory epoch/version, model and thinking level; it still rechecks Pi's current retained-tail budget and requires actual Pi adoption. Foreground compaction never waits for a background queue.

## Corrections and old data

Source ranges are UTF-16 half-open offsets into `HistoryItem.text`. Each fragment carries its SHA256 and a stable fact identity. A correction retires only overlapping verified fragments, including verified copies in Pi forks. Other facts in the same original entry remain available. Uniquely addressed explicit conversational corrections apply at the settlement boundary without another model request; ambiguous corrections are shown as conflicts and do not become competing effective constraints.

Memory's versioned invalidation snapshot survives cold starts and cross-process learning. Legacy whole-entry invalidations trigger revalidation but never silently retire every fact in that entry. Legacy points gain ranges only when the literal or a sole source fact can be verified. The original history remains available for explicit lookup. A deleted-session tombstone prevents indexing, preparation or adoption from reviving that history.

## Public actions

`/topic-rebuild ACTION JSON` and `friend_topic_rebuild` call the same controller:

- `snapshot`: mode, last source-backed field, derived timeline, preparation/adoption status, invalidation and indexed-entry count. Topics remain implicit.
- `timeline`: last 100 canonical working-field entries with original goal, current request, goal status, preserved facts, conflicts, source entries, range coverage and operation receipt status. This is a read view of Pi history, not another transcript.
- `settings {mode:"native"|"infinite"}`: explicit user-owned mode. The old `enabled:false` request remains a stop-compatible alias; `enabled:true` is not an implicit migration.
- `rebuild {}`: request Pi's bound idle compaction interface. A request is not an adoption receipt.
- `prepare {}`: host/user preparation only; model tools use `rebuild` instead.
- `history.search {query,limit?,sessionId?}`: project-scoped hashed FTS5 tokens, CJK bigrams and short-query fallback.
- `history.read {id,sessionId?}` / `history.around {id,sessionId?,radius?}`: retrieve original Pi entries; missing or disallowed sources are reported rather than synthesized.

SQLite holds plugin settings, derived drafts/receipts and original-entry references/hashes. It never holds a second raw transcript. Personal Memory references can point to another project; preparation does not bypass Pi's project-scoped original-history access.

Tests use fake providers and the public Pi SDK, including ten consecutive compactions with cold recovery, progress/replace/cancel intent, long-entry tail and cross-page constraints, canonical range advancement and conditional Memory/source drift. They cover independent native/infinite operation, optional Memory, same-entry fact correction, cold reconstruction, canonical write failure, cancellation, retained-tail coverage, draft reuse, cross-process epochs and deletion fences. GUI and real-model acceptance belong to the desktop delivery candidate.
