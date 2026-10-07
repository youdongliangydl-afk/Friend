# Swarm source and design records

Business code in this package is newly authored for Friend-Pi. No upstream source files or Agent loops were copied. Pi is consumed as host peer packages and its public SDK owns execution and native session history.

| Upstream | Inspected revision and license | Reference use |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) | `eb326d265ae0b88489a6d10319307780df827cdf`, MIT | Public `createAgentSession`, `DefaultResourceLoader`, `ModelRuntime`, session lifecycle and extension `tool_call` hooks; official subagent example informed independent execution without copying its loop. |
| [DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness) | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, MIT | `agent-team` task board and mailbox informed distinct task claims, revisions, durable admission, delivery and acknowledgement. Friend-Pi uses separate SQLite transactions and actual worktree/tool guards. |

The repository root provides the pinned Pi artifact manifest, broader reference inventory and retained upstream license notices. The package license applies to new Friend-Pi code; it does not replace upstream licenses.
