# Goal behavior and API

Goal is an optional, session-owned instruction to keep working toward a user-requested objective. It does not create a separate Agent loop or transcript. Pi's public SDK owns execution and JSONL; the host stores Goal state in its journal and schedules continuations through Pi's public prompt API.

## Model tools

The native Pi extension exposes three tools:

| Tool | Input | Boundary |
| --- | --- | --- |
| `create_goal` | `{objective}` | Use only when the user explicitly asks for ongoing work. Ordinary tasks do not authorize creating a Goal. |
| `get_goal` | `{}` | Read the current Goal and its saved progress. |
| `update_goal` | `{status:"complete"\|"paused"\|"blocked"}` | The main Agent may record a status. Completion requires checking the original request and actual result; pause is for an explicit user request; blocked is for a repeated, unresolved execution obstruction. |

These schemas do not expose budget, duration, resume, stop, or clear inputs. The model cannot resume or clear a Goal. Only the user can resume through the UI or `/goal resume`, and user-only controls also own edit, pause, and clear. Completion records the main Agent's explanation and does not dispatch a second Goal auditor. This does not waive a review required by a particular Team or Swarm graph contract.

## Plan, mode, and controls

Plan is independent of Single, Team, and Swarm. Turning Plan on retains the current Goal and suppresses automatic Goal wakes; it does not execute the Goal. Changing the selected execution mode does not transfer or clear the Goal. On a later user-authorized resume, the current session settings apply. A Goal remains tied to its Pi session and cannot be transferred to another session.

Pausing or clearing a Goal changes Goal state and cancels its pending automatic wake. If a model turn is already streaming, that turn can finish; pause and clear do not abort it or kill running jobs. Clear removes the Goal from the current-session focus while retaining its journal record and the Pi transcript. Stopping current execution aborts the foreground turn and leaves an active Goal paused. `/goal stop` is a compatibility alias for Goal pause, not a destructive stop state. Resume is an explicit user action; unresolved unknown side effects must be checked and confirmed first.

The Goal bar and editor provide create, edit, pause, resume, and clear. The `/goal` command supports setting or reading the current objective plus `get`, `list`, `pause`, `resume`, and `clear`. Goal status is separate from the lifecycle of the current model turn.

## Persistence and migration

The host lazily upgrades legacy Goal records to schema version 2 while preserving their revision and saved evidence. Legacy `completed` becomes `complete`; obsolete `stopped`, `verifying`, and incomplete waiting states become `paused`; a waiting state with a live task/job can become active. A legacy block caused only by an unavailable independent audit becomes paused so the main Agent can resume and assess the objective. Old token and wall-clock budget fields are ignored: Goal tracks observed token usage and active elapsed time, but neither is an execution limit. Unknown token usage does not pause the Goal.

Pi owns the native JSONL transcript. Goal tool calls and results use Pi's normal records. Automatic Goal wakes are native `custom_message` entries with `display:false`, so they remain in session history without appearing as extra user bubbles. Goal state and receipts are host records; no duplicate transcript is maintained.

Implementation references: [RuntimeController](../apps/desktop/src/runtime-controller.ts), [GoalLedger](../packages/core/src/runtime.ts), [Goal controller tests](../tests/goal-controller.test.ts), and [SDK Goal journeys](../tests/sdk-worker.test.ts).

This describes implementation and test behavior. Integrated desktop acceptance remains pending the root session's final candidate, Pi SHA, artifact hash, and real Computer Use evidence.
