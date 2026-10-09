# Session changes and trajectory

The conversation offers **对话 / 轨迹** tabs in standard and fullscreen layouts.

- Each finished foreground run shows its file changes under the final conversation message: four-file preview, expand/collapse, additions/deletions, and binary/large-file labels. Clicking opens the recorded run Diff; current-file opening is a separate action, and deleted files retain their historical comparison.
- The baseline is captured before actual execution in the SDK worker, including dirty and staged files. Changes committed during the run remain visible. Counts describe the interval and may include simultaneous external edits; they do not prove authorship. Reverted net changes are omitted. Ignored files changed through native write/edit tools are supplemented by pre-mutation captures. Non-Git directories summarize those file-tool edits only; shell-only changes outside Git are not inferred.
- Text files above 1 MiB are metadata-only. A baseline over 500 dirty paths or 8 MiB of dirty text is unavailable, explicitly displayed instead of a zero-change claim. Patch previews are bounded; line counts use the complete available patch.
- Versioned `friend-pi.run.changes.v1` entries save only file metadata in native Pi JSONL. The existing Diff store owns baseline contents. Cold reopen retains the recorded summary, independent of later workspace edits. Goal wakes and collaboration execution wait for pending snapshots; obsolete snapshots are discarded.
- Trajectory projects original Pi messages and available system/context records, including native model identity, usage, durations, tool input/output, errors and interrupted calls. The three-track overview switches between equal widths and recorded durations. Turns and parallel call groups support whole-list folding; overview selection opens the containing groups and locates the row. Search requires every whitespace-separated term to match, ignoring case, and rows expand to show details. Automatic wakes do not count as human rounds.
- System records sampled at `context_with_system` are preparation-time records, not a claim of the final provider payload. Transient unsaved context and separate members' full histories are outside this view. Missing legacy durations are labeled unrecorded. Images use diagnostic placeholders rather than searchable base64.

Pi's public SDK remains the sole model loop and transcript owner. The UI introduces no provider execution, transcript replica or shared plugin singleton.

Focused checks: `tests/session-trace.test.ts`, `tests/run-changes.test.ts`, and the cold-reopen/stop test in `tests/sdk-worker.test.ts`. Candidate, package hash and actual desktop journeys are recorded in `.artifacts/session-qa/handoff.json` for integration.

## Changed-file previews and review

Interaction is grounded in DeepSeek Harness revision `4878cda`; the exact source record and adaptation limits are in `third-party/deepseek-harness`.

A single-file header or multi-file row previews its frozen Diff after 500ms. Clicking opens that run's selected file in the right Diff workbench (or its fullscreen Diff page), with green additions and red deletions, file selection, split/inline layout and wrapping. Opening the current file is a separate action; deleted files retain their historical comparison. Previews and review share lazy reads. Old summaries without a saved comparison show unavailable rather than a current-file diff.

Native JSONL contains comparison identity/metadata only. The session-owned Diff store holds patches bounded by the existing 1MiB per-file preview and an 8MiB aggregate budget, with truncation labels; views render at most 5,000 lines. Session deletion removes these snapshots through the existing Diff cleanup. Later file edits do not alter the recorded comparison.

文件工具文本比较参考 DSH compareText，使用内存 jsdiff（100ms 上限）；超时会明确标记整文件替换。系统未安装 Git 时也能比较已捕获的文件工具变更。已有 Git 基线失败不会降级成不完整成功；超限/捕获失败会持久化为不可用。Git 覆盖且本轮恢复原样的文件不会被工具捕获重复计入。
