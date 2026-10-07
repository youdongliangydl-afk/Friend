# @friend-pi/topic-rebuild

Native Pi working fields, safe context rebuilding and original-history lookup.
Extract the generated tarball and install its package directory:

```sh
mkdir -p /absolute/path/plugins/topic-rebuild
tar -xzf /absolute/path/friend-pi-topic-rebuild-VERSION-HASH.tgz -C /absolute/path/plugins/topic-rebuild
pi install /absolute/path/plugins/topic-rebuild/package
```

Pi does not automatically unpack local `.tgz` sources. You may also install
the absolute path of `.artifacts/packages/unpacked/topic-rebuild/package`.
Node 24 and the host Pi packages are required; Memory is optional.

Pi's original JSONL history is authoritative. At settlement, the plugin appends
an incremental working-field **custom entry** through Pi's boundary draft API.
It preserves existing drafts from other extensions. This deterministic
checkpoint costs no extra model call per message. The checkpoint stores goals,
explicit constraints, source-backed decisions and unfinished work, and implicit
history organization. Topic labels are not a user-managed taxonomy.

Native `session_before_compact` handles manual, threshold and overflow
rebuilding. The plugin calls the currently configured model through the public
SDK, validates source citations, preserves Pi's exact `firstKeptEntryId`, and
returns a structured compaction. The old field remains effective until the
actual Pi journal contains the unique operation identity. Confirmation scans
canonical entries rather than trusting summary equality or the callback's
entry. Identical summaries therefore cannot be mistaken for a new commit.

`coveredThroughId` is the end of the captured original-message prefix;
`compactedThroughId` records the prefix actually replaced before Pi's retained
tail. Messages arriving during preparation remain in the original tail and
are outside the operation's captured coverage. Source rewrites, invalidated
versions, cancellation, missing models, malformed output or insufficient
budget leave the valid field in place and fall back to Pi native behavior.

`/topic-rebuild ACTION JSON` and `friend_topic_rebuild` use the same controller
as the desktop workbench:

- `snapshot`: current field, enabled state, applied/preparing/fallback status,
  invalidation flag and indexed original-entry count. Topics stay internal.
- `settings {enabled}`: user-owned enable/disable setting; model tools cannot change it.
- `rebuild {}`: request actual native `ExtensionContext.compact()` at idle.
  A request is not reported as an adopted result. Stop/cancellation stays Pi's.
- `history.search {query,limit?,sessionId?}`: search source references in the
  current project. CJK bigrams and short-query fallback are supported.
- `history.read {id,sessionId?}` and
  `history.around {id,sessionId?,radius?}`: retrieve actual original entries,
  reporting unavailable sources instead of synthesizing text.

The SQLite index stores only original-entry references, source/term hashes and
operation receipts. It can be rebuilt from Pi history. It contains no second
transcript. Memory correction/forget events invalidate dependent working
fields durably and trigger rebuilding at the next safe idle boundary. Optional
memory recall uses a 750 ms request, includes only active records, is temporary
per provider call, and is never baked into persistent compaction summaries.

Explicit conversational corrections keep a canonical superseded-source ledger.
Memory GUI corrections and forgetting also persist project-scoped source
suppression (references and verified body hashes). Deterministic checkpoints
and model-proposed points cannot revive those sources after later compactions,
cold starts or forked entry copies. Short entry-id collisions require the same
verified body; another project's event cannot suppress this project's history.
The original Pi JSONL remains available for explicit source lookup. A corrected
new Memory version stays available through temporary recall.

Tests use fake completion only and verify early constraints, multiple topics,
identical summaries, canonical-write failures, new input, invalidation and
cold restart, source isolation, cancellation and native fallback.
