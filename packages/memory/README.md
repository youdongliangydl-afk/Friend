# @friend-pi/memory

A native Pi package using Pi's public extension API. Extract the generated
tarball, then install its package directory with Pi. Node 24 is
required. Pi owns JSONL conversation history; this plugin stores only memory
records, revisions, original entry references, learning checkpoints and an FTS5
index in Friend-Pi's separate data directory.

```sh
mkdir -p /absolute/path/plugins/memory
tar -xzf /absolute/path/friend-pi-memory-VERSION-HASH.tgz -C /absolute/path/plugins/memory
pi install /absolute/path/plugins/memory/package
```

Pi does not automatically unpack a local `.tgz` source. The packaging script
also supplies `.artifacts/packages/unpacked/memory/package`; install that
directory's absolute path directly. Pi/Typebox are host peers, not bundled.

`/memory ACTION JSON` and the `friend_memory` model tool use the same controller
as the desktop workbench. Main actions:

- `save`: `{content,title?,kind?,scope?,explicitRemember?,sources?,parentIds?}`.
  Ordinary facts and model extraction are candidates. An explicit user request
  to remember, or `accept {id,revision}`, makes a record active. Personal scope
  is permitted only with `explicitRemember:true`.
- `search`: `{query,limit?,includeCandidates?,match?:"any"}`. Searches active enabled records
  in the current project, plus explicitly remembered personal records. CJK
  bigrams and short-query fallback need no native tokenizer or vector service.
  Default matching requires all query terms. `match:"any"` provides ranked
  term overlap for contextual recall from a longer task description.
- `read`: `{id,source?:true}`. Original text is fetched from Pi history on
  demand; unavailable origins are reported instead of invented.
- `update`, `toggle`, `forget`: require `{id,revision,...}`. Corrections and
  stopping invalidate descendants. Forget removes records and stored versions,
  and retains only suppression hashes so relearning cannot restore them.
- `versions`, `export`: `{id?}`. Markdown exports are written to the private
  `memory-exports` directory. Exports are user copies and must be removed by
  the user if no longer wanted; forgetting removes plugin authority records.
- `learning.run`, `learning.pause`, `learning.resume`, `learning.settings`:
  manual run/resume and `{enabled?,paused?}` controls. `learning.retry {id}`
  explicitly retries a failed job.

After `agent_settled`, project-only Reflection produces sourced candidates.
Dream consolidates exact duplicates and flags same-title conflicts. Distill
produces a text method candidate, optionally delivered to Expert for separate
objective validation; unavailable Expert leaves the local candidate intact.
No personal preferences are learned automatically. No model confidence is
treated as verification. Background calls run serially at idle boundaries,
yield to foreground activity, and stop after an initial failure plus two
retries. There is no monetary quota or silent infinite retry.

The snapshot exposes `memories`, `candidates`, `learning` settings/jobs and
`derivedRefs`. Corrections, stopping and forgetting emit the versioned
`memory.invalidated` event with `{v:1,ids,reason,revision}` so Topic & ReBuild
can drop derived context at a safe boundary.
