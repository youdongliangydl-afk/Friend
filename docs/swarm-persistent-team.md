# Swarm persistent team implementation

This change extends Swarm only. Single and Team retain their existing execution paths. Pi commit `eb326d265ae0b88489a6d10319307780df827cdf` owns model execution and native JSONL; DeepSeek Harness reference commit is `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.

## Controllers and evidence

- `packages/swarm/src/teammates.ts` owns chat-scoped identities, generation leases, ordered persistent messages and read-only native-history recovery.
- `member-inbox.ts` records recipient intake before Pi steering and acknowledges context only after a matching native user entry is persisted and flushed. Duplicate and out-of-order transport frames drain the durable ordered prefix.
- `index.ts` exposes `member.create/list/history/send/interrupt/resume` through the same controller used by GUI, tools and commands. New Swarm graphs use protocol v2; legacy v1 remains available for saved graphs and runners.
- Tasks/attempts/results remain separate. Every task freezes role/model/permissions; Git write attempts get isolated worktrees, and interrupted worktrees require explicit user recovery. Each independent review starts a fresh read-only Pi session. Prior reviews remain historical evidence and cannot authorize changed results.
- Completed teammates accept read-only discussion; parent Agent receives suggestions and controls new attempts. Stopped, unknown and budget-blocked members retain messages. Missing exit receipts prevent concurrent native-session opens.

## Client

- Header and task workbench roster open a separate central teammate route, scoped by root chat and member.
- The selected teammate's name replaces the header roster label, with Return to main chat immediately to its left. Member conversations reuse the main composer styling and keyboard behavior; recipient names appear in the input placeholder and accessible label. Running members permit supplements and scoped Stop together. Only actionable wait reasons remain visible.
- Native messages and tools use the existing timeline projection; pending inbox bodies remain visible until an exact native entry exists.
- Drafts, stable send IDs, expanded native tool/thinking blocks and scroll positions are member-scoped; root drafts and scroll-following state survive member navigation.
- Worker terminal IPC is flushed before disconnect; lifecycle failure waits for process close after queued messages drain. Native history remains authoritative.
- Events are fenced by member, attempt and generation. Member Stop affects its attempt and dependencies; root Stop fences all members.
- Cancellation cannot release a member back to idle or replace an explicit pause reason. User supplements retain their original admission evidence while native context receipts bind the actual task, including earlier interrupted attempts whose constraints must reach the independent reviewer.

## Verification

- `persistent.test.ts`: chat ownership, lease exclusion, durable ordered admission, receiver restart, context receipt repair, corrupt/foreign history, scoped stop and unknown-exit admission.
- `persistent-native.test.ts`: separate real Pi worker processes under a loopback fake provider, two Git write tasks sharing one native session with separate worktrees/commits/reviews, idle discussion deduplication, and SIGKILL immediately after JSONL fsync but before receipt persistence. A cold controller repairs the receipt without rerunning inference.
- `sdk-worker.test.ts`: host busy/stop authority and native member-history display/parent continuation.
- The original 79 Swarm cases retain explicit legacy execution coverage; new cases exercise v2. Default model verification is synthetic and makes no claim about real-model quality.
- Final delivery evidence must use a clean candidate commit, the pinned Pi SHA, packaged artifact hash and actual Computer Use. Packaging smoke alone is not GUI acceptance.

## Source and license

DeepSeek roster/mailbox/TeamAction adaptations are listed in `packages/swarm/SOURCES.md` and `docs/sources.json`. The complete MIT notice ships in the Swarm tarball and `third-party-licenses/deepseek-harness/LICENSE` in the app.

Integration handoff artifacts live under `.artifacts/swarm-persistent-team/` in the isolated worktree. The primary Friend checkout is preserved; integration and merge remain a separate handoff.
