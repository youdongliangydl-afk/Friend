# Swarm source and design records

The original DAG/integration controllers are Friend-Pi code. The persistent teammate roster and mailbox adapt the MIT DeepSeek Harness Agent Teams implementation at the revision below; no Agent loop is copied. The full upstream notice is DEEPSEEK-LICENSE. Pi is consumed as host peer packages and its public SDK owns execution and native session history.

| Upstream | Inspected revision and license | Reference use |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) | `eb326d265ae0b88489a6d10319307780df827cdf`, MIT | Public `createAgentSession`, `DefaultResourceLoader`, `ModelRuntime`, session lifecycle and extension `tool_call` hooks; official subagent example informed independent execution without copying its loop. |
| [DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness) | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, MIT | `agent-team` task board and mailbox informed distinct task claims, revisions, durable admission, delivery and acknowledgement. Persistent teammate code adapts roster membership, target-local dispatch tails, ordered admission and durable receipt checks to SQLite + Pi JSONL. Friend-Pi retains worktree/tool guards and its DAG scheduler. |

The repository root provides the pinned Pi artifact manifest, broader reference inventory and retained upstream license notices. The package license applies to new Friend-Pi code; it does not replace upstream licenses.

Adapted source map (all at `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, Copyright 2026 DeepSeek, MIT):

- `packages/experimental/agent-team/src/roster.ts` -> `src/teammates.ts`: chat-owned identities and lifecycle validation, adapted to SQLite leases.
- `packages/experimental/agent-team/src/mailbox.ts` -> `src/teammates.ts` and `src/member-inbox.ts`: receiver serialization, durable admission and receipt/recovery; Pi public SDK replaces Cordis/DSH services.
- `packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx` -> Desktop `Teammates.tsx`: roster states, member navigation and disclosure interaction adapted to Friend components.

The public worker protocol v2 adds identity/generation fences and durable receipt events. Legacy v1 graphs and workers retain their existing semantics. The desktop and standalone Swarm package both distribute DEEPSEEK-LICENSE.

Capability optimization: validation-local DAG reachability, deterministic plan checks, explicit local resource waiting, immutable structured handoffs, native full-read receipts and read-only recovery previews are new Friend-Pi code. They reuse the pinned Pi public SDK and native tool result history above; no scheduler or Agent loop was copied from another project. No new runtime dependency is introduced.
