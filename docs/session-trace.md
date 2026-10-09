# Session changes and trajectory

The conversation offers **对话 / 轨迹** tabs in standard and fullscreen layouts.

- Each finished foreground run shows its file changes under the final conversation message: four-file preview, expand/collapse, additions/deletions, and binary/large-file labels. Existing files open in the shared file workspace; deleted files remain visible as metadata.
- The baseline is captured before actual execution in the SDK worker, including dirty and staged files. Changes committed during the run remain visible. Counts describe the interval and may include simultaneous external edits; they do not prove authorship. Reverted net changes are omitted. Ignored files are outside the Git range.
- Text files above 1 MiB are metadata-only. A baseline over 500 dirty paths or 8 MiB of dirty text is unavailable, explicitly displayed instead of a zero-change claim. Patch previews are bounded; line counts use the complete available patch.
- Versioned `friend-pi.run.changes.v1` entries save only file metadata in native Pi JSONL. The existing Diff store owns baseline contents. Cold reopen retains the recorded summary, independent of later workspace edits. Goal wakes and collaboration execution wait for pending snapshots; obsolete snapshots are discarded.
- Trajectory projects original Pi messages and available system/context records, including native model identity, usage, durations, tool input/output, errors and interrupted calls. The three-track overview supports duration, round and call scales, with click-to-locate and searchable expandable rows. Automatic wakes do not count as human rounds.
- System records sampled at `context_with_system` are preparation-time records, not a claim of the final provider payload. Transient unsaved context and separate members' full histories are outside this view. Missing legacy durations are labeled unrecorded. Images use diagnostic placeholders rather than searchable base64.

Pi's public SDK remains the sole model loop and transcript owner. The UI introduces no provider execution, transcript replica, shared plugin singleton or dependency.

Focused checks: `tests/session-trace.test.ts`, `tests/run-changes.test.ts`, and the cold-reopen/stop test in `tests/sdk-worker.test.ts`. Candidate, package hash and actual desktop journeys are recorded in `.artifacts/session-qa/handoff.json` for integration.
