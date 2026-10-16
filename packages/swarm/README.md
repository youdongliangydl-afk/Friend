# @friend-pi/swarm

## 本地安装

```sh
mkdir -p /absolute/path/plugins/swarm
tar -xzf /absolute/path/friend-pi-swarm-VERSION-HASH.tgz -C /absolute/path/plugins/swarm
pi install /absolute/path/plugins/swarm/package
```

Pi 不会自动解包本地 `.tgz`。也可直接安装 `.artifacts/packages/unpacked/swarm/package` 的绝对路径。使用 Node 24 和本项目锁定的 Pi 1.0.4 宿主；Pi/Typebox 为 peer。

独立 Pi Package，使用公开 Pi SDK 创建独立 Node 成员进程及原生 JSONL 会话。安装完整包后加载 `dist/index.js`；成员运行器 `dist/member.js` 随包提供，Pi 作为宿主 peer，不打包进插件。

GUI、`friend_swarm` 工具和 `/swarm` 命令调用同一 `SwarmController`。主要操作：

```text
/swarm create {"goal":"实现登录校验","tasks":[{"id":"implement","title":"实现校验","prompt":"实现并自检","mode":"write","dependencies":[],"writeScopes":["src","test"]}],"checks":[{"command":"npm","args":["test"]}]}
/swarm start {"graphId":"返回的标识"}
/swarm snapshot
/swarm pause {"graphId":"..."}
/swarm resume {"graphId":"...","confirmUnknown":true}
/swarm send {"graphId":"...","to":"implement","body":"补充约束"}
/swarm shared.write {"graphId":"...","name":"接口约定","content":"...","expectedRevision":0}
```

`create` 不带 tasks 时由配置好的模型提出任务图；模型不会被用来伪造完成状态。任务领取使用 SQLite 原子事务；成果版本绑定 attempt。默认并发 4，最多 16；累计最多 64 个逻辑节点。非 Git 写入在独立暂存目录并行，应用目标时使用跨聊天资源租约和启动摘要。未提交的 Git 改动会阻止 Swarm 写入，仍可使用 Single 或只读 Swarm。

首次启动从宿主公开 Pi API 继承当前模型与思考等级；明确的启动参数可覆盖。
实际成员和独立复核沿用该冻结快照，停止后的显式接续不会把已有尝试
改写为新的模型或等级。

Git 写入成员使用独立 worktree；依赖成果通过明确的提交应用到下一成员。整合在另一个 worktree 串行进行；客观检查和独立只读成员复核通过后，仅在原基线和工作区仍未变化时执行 fast-forward。复核失败自动返工最多两轮。工作区、会话和失败现场保留。

独立复核使用 Pi 工具 `swarm_review_result` 提交布尔判断和事实说明，助手的自由文本不作为批准结果。宿主在 Pi 真正结束后才采用这次提交；缺少提交、提交冲突、取消或超时均保留成果并暂停。复核成员只开放 read/grep/find/ls 和结果提交工具，客观命令检查由宿主执行。

`prepare` 启动后台复核并立即返回任务图状态；通过 `snapshot` 跟踪进度。重复点击不会同时开启第二次复核。模型回答出现、复核已排队或单个工具完成都不代表任务图已经整合。

全部任务均为 `mode:read` 时，Agent 或插件不能在 `graph.checks` 或 `contract.checks[kind=command]` 中安排命令检查；只读图也不会默认注入 `npm test`。计划、创建、追加、任务修改和旧图启动/恢复/准备均重新检查此边界。保留 read/grep/find/ls、声明式检查，以及合同要求的独立 reviewer/verifier，无需把资料阅读改成写入任务。可信宿主标识为用户明确操作的检查沿用原有权限、临时目录审批和未知副作用围栏；工具输入中的 `origin` 不能取得该身份。包含 write 任务的图仍沿用既有检查规则；此边界依据已声明任务模式，不声称能普遍识别自然语言中的只读约束。

消息区分已持久化、已投递和已纳入成员上下文；不将队列接收描述为模型理解。共享材料使用短事务锁、版本 CAS、不可变版本文件和原子写入，模型思考不占锁。停止、进程丢失或会话关闭标记副作用未知；显式接续创建新的 attempt，不重放旧工具。

`pause/stop` 先进入 `stopping`，取消成员、客观检查、独立复核和隔离/整合中的 Git 进程，再等待实际关闭收据。每个受管进程拥有宿主新建的 POSIX 进程组；强制退出只针对这些组。`Graph.stopReceipt.objects` 逐项区分 `terminated/unknown`，没有完整回执时暂停，不能称已经停止。已终止也不表示撤销已经发生的效果；中断尝试仍保留为 unknown，用户检查后显式接续。停止途中崩溃不重放，冷启动恢复为暂停和未知回执。宿主可订阅 `swarm.process` 的 started/closed 事件，为 SDK 强制退出登记其实际创建的子组。

复核拒绝使用 `taskIds` 归因到成果；仅这些任务及其下游依赖返工，其他 completed 成果保留。没有有效归因则暂停。原始 `Task.prompt/originalPrompt` 不改写，返工要求进入 `requirementVersions`，尝试绑定采用版本；达到两轮自动上限后要调整方法。用户通过 `rework {graphId,taskIds,reason,prompts?,revision?,confirmUnknown?}` 在安全边界显式调整，不能由模型替用户确认未知副作用。

共享保存成功提交后才发布 `swarm.shared.changed {v,graphId,name,revision,digest}`，订阅通知失败不撤销已保存内容。历史内容可用 `shared.readVersion {graphId,name,revision}` 回查。竞争保存仍会拒绝旧版本覆盖；带已读 `baseDigest`（及可选 baseRevision/operationId）时，控制器自动三方合并无重叠行修改。成员工具自动保留读取的版本与摘要。软文本重叠最多调用/重试两次合并模型，必须保留三方来源、共同内容和独立修改；涉及同一约束/接口、来源不全、无法判断、取消或连续竞争则保留 `shared.conflicts` 材料并拒绝保存。模型思考期间不持锁，不生成冲突覆盖，不自动重放外部工具。关键产物、验证、预算和操作通知使用持久 outbox；通知失败后按同一 eventId 补投，snapshot 始终从 SQLite 对账。

安装 Expert 时，图启动冻结目录与选择；每个成员实际采用的 id/version/hash/Skill 摘要记录在其原生 JSONL 和 `Attempt.expertAdoptions`。明确无效专家会在成员启动前报错，不能悄悄退回基础角色。Expert 缺席时保留明确的 unavailable 基础角色；成员不加载整个 Expert 插件，按需采用通过版本化受限请求交给 Expert 控制器，范围只按交集收紧。

成员不加载 Swarm 或其他可派生扩展。`tool_call` 对嵌套调用同样检查：read/write/edit 必须在工作区，写入必须在分配范围；只读成员不开放 Bash。写入成员沿用 Pi 高信任 shell，阻止明显目录逃逸并确认破坏性操作。此策略和 worktree 是协作边界，不是完整 OS 或 shell 沙箱。

桌面 SDK 宿主在加载插件前将实际 `dataDir/pi` 配置目录公布为
`FRIEND_PI_AGENT_DIR`。Core 将它冻结到 `PluginContext.agentDir`，Swarm
把同一路径传给执行成员、独立复核及子进程环境。原生 Pi 没有这个 SDK
覆盖时使用公开 `getAgentDir()`，包括 Pi 自身的目录环境覆盖。
使用自定义 `createAgentSession({agentDir})` 的 SDK 宿主也须明确公布该目录；
当前 Pi 扩展上下文不公开 SDK 的认证文件路径，不以私有字段或猜测发现。
只传递目录，不迁移或复制凭据，不输出密钥。`FRIEND_PI_MEMBER_WORKER`
可为宿主指定同协议运行器。

开源参考：Pi 官方 SDK / extensions / subagent 示例（MIT），以及项目根 README 和来源清单所列的调度参考。持续团队的 roster/mailbox 代码按 SOURCES.md 从 DeepSeek 适配；模型执行使用 Pi 公开 SDK。

## 持续队友（Swarm v2）

新 Swarm 图默认按当前 Pi 聊天保存队友。任务可指定 `memberId` 或 `memberName`；同一聊天中的同名任务键默认复用队友，另一个聊天不会共享身份。`snapshot.teammates` 与任务/尝试状态分别返回。队友待命不表示成果已经验收。

`member.create/list/history/send/interrupt/resume` 使用同一控制器。成员会话可只读查看；正常待命消息唤醒独立只读讨论，改动建议由主 Agent 创建新尝试。收件过程区分已保存、成员已收件和实际原生消息已进入上下文。停止后的队友保持暂停，退出收据未知时不能并发打开原生会话。

成员 v2 进程使用稳定消息 ID、SQLite 接收端 inbox 和 Pi 条目身份去重。原生会话由 Pi 保存；后续任务用公开 `SessionManager.open` 恢复，写任务仍独立冻结权限/工作树。独立复核始终创建全新会话。旧图继续使用 v1，旧投递记录不提升为 v2 收件证明。

DeepSeek 源码适配范围与 MIT 全文见 SOURCES.md、DEEPSEEK-LICENSE。


## 通用合同与验证（schema 3）

新任务图保存 `contract`、冻结执行摘要、来源/能力版本围栏、预算和累计修复账；Pi 继续独占模型循环与 JSONL。任务状态、验证状态和实际应用分别呈现。`operationId` 为 mutation 业务幂等键；同键同意图返回原回执，同键新意图返回 `VERSION_CONFLICT`。`expectedRevision` 是图 CAS；共享材料的 `expectedRevision` 是该材料 CAS。

- `V0`：低风险只读或暂存草稿，核对来源和结构，不暗派 reviewer。
- `V1`：代码、文件和数据写入，真实客观检查后使用全新只读 reviewer。
- `V2`：高风险交付，另有全新 verifier 和声明的宿主目标 oracle；作者、reviewer、verifier 会话不同。

检查支持 `file.exists`、`file.hash`、`json.schema`、`csv.contract`、`source.coverage` 和宿主受控 `command + argv`。JSON schema 使用已声明的类型/字段/数组/枚举子集，不支持的关键字在准入时拒绝，不能忽略后声称通过。语义评审标记 `modelJudged`；它不能替代实际检查结果。

```json
{
  "operationId": "create-report-1",
  "goal": "生成报告",
  "tasks": [{"id":"report","title":"报告","prompt":"生成 report.json","mode":"write","dependencies":[],"writeScopes":["report.json"]}],
  "contract": {
    "risk":"medium", "verification":"V1",
    "artifacts":[{"id":"report","kind":"file","target":"report.json","taskId":"report","required":true}],
    "checks":[{"id":"report-format","kind":"json.schema","target":"report.json","args":{"schema":{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}}}]
  },
  "budget": {"tokenLimit": 12000}
}
```

非 Git 成员工作区位于受管数据目录 `swarm-workspaces/<project>/<graph>/artifacts/<attempt>`，不能直接覆盖目标项目。所有有效产物组合成另一候选目录进行检查和独立评审；Team 仅返回 ready，主控明确 integrate 后应用。每个文件保存启动 hash、备份、新 digest 和应用日志；单文件原子替换，多文件逐项可恢复，不宣称目录事务原子。候选/目标漂移时保留现场。`artifact.list/read` 可回查不可变版本，`snapshot.operations` 也显示文件应用的 unknown。

外部写入先 `operation.prepare`，由可信宿主 adapter 校验目标、payload 和授权；真正 dispatch 不注册为成员模型工具，也不把 `origin:'plugin'` 当发送 authority。未配置 adapter 返回 `CAPABILITY_UNAVAILABLE`。派发后断连/超时保留原 key 并进入 unknown；只读 reconcile 唯一匹配原操作且具备成功回执和目标读回时才确认，不能换 key 自动重试。过期未知资源只有宿主可信回执 authority 才能解除；默认未配置时继续阻断。

`budget.read` 返回真实 native entry/call ID 去重账、预留与未知用量；没有默认货币额度。规划、共享合并、成员和独立复核均归入同父任务。用量不可得时保留 unknown，显式限额下停止新调用；在途请求可能有有限超额，不能宣称硬 token 截断。图最多 2 波返工，逻辑步骤最多 2 轮；同一失败证据且产物和输入无变化时提前暂停。

Memory 缺席时无需加载它；启用时完整选择正文及 conditions 进入成员请求才登记精确版本依赖。Expert 采用 intent → 成员原生 journal/fsync → canonical confirm，确认后正文才进入模型；显式选择在首次 provider 请求前完成同一过程。来源/记忆/Skill 撤回会使旧成果失效，提交与整合仍在同 SQLite 短事务围栏复核。成员 `provisioning` 只有与首条真实原生任务 entry 对账后才转 running。

成员 trial 以当前尝试的原生 user entry 摘要及 graph 作用域预占额度。真实 Bash 的结构化退出码生成最小原生检查 journal；父端核对受管会话、当前尝试/代次、原 toolResult 摘要和 canonical 采用后登记 `CheckRef`，不使用模型文字或全图检查代替成员证据。`attempt.nativeChecks` 可回查精确来源，`trialObservation` 区分已观察与待证据。整组检查仅在成员实际结束后交 Expert 结算；取消、未知退出、无结构化退出码和被守卫拦截的命令保持等待，旧尝试/旧版本不能推进新结果。

受管 `swarm-views/<project>/<session>` 是只读 Markdown 投影，带 graph revision/hash manifest，可重建，不读取为新指令或业务状态。任务/共享材料检索使用 SQLite FTS5 和确定性中文词元，无 embedding 模型。迁移前使用 SQLite 快照，失败事务回滚并保留原记录；不重写 Pi 历史。升级表和 namespace 使用最小 writer 版本围栏，旧连接没有版本函数时只能读取，不能写入新 UNKNOWN 状态；本地反例模拟旧 writer，不能冒充完整旧二进制验收。旧 v1/v2 fixture 和新 schema3 证据等级分别保留。

本地 focused tests 覆盖 fake provider、真实 Pi + 本地 HTTP fixture、SQLite 并发/迁移/故障注入。商业模型质量、外部授权测试资源、打包客户端 Computer Use 和最终整合验收由集成会话另行执行，不能以这些本地测试替代。

## 协作优化（writer 4；图合同仍为 schema 3）

- **规划校验**：只在用户选择 Swarm 后使用 `plan.validate {goal,reason,strategy,tasks,maxWorkers?,risk?,checks?,contract?,budget?}`。`direct` 使用空任务，允许主 Agent 在 Swarm 内直接完成简单任务，必要检查与独立复核仍保留；`collaboration` 使用 1–64 任务。此动作不调用模型、不保存图、不预占预算；返回权限、依赖、冲突和预算依据，未知时间/费用不估造。`create/start/append/update_task` 重新确定性校验，计划不能扩大权限。
- **图校验**：一次校验内缓存祖先集合，覆盖流程条件、并行写范围和同目标产物冲突；定义变更重新计算，没有跨图缓存，也不降低 64 节点容量或合法密集 DAG 的边数。
- **等待**：`snapshot.graphs[].tasks[].waiting` 区分依赖、队友、固定并发、流程门闸、资源、预算和暂停。宿主明确 `VERSION_CONFLICT + details.waitSafe:true` 的局部占用仅等待当前任务，继续按定义顺序启动其他独立 ready 任务；释放后定时重验，不调整并发、不改变队列排序。未知副作用、权限/来源变化或全局预算耗尽仍安全暂停。
- **结构化交接**：任务可带 `constraints`、`unresolved`。交接包含目标、当前完整要求、全部祖先约束/未决问题、真实提交和产物版本、原生会话以及精确来源/Memory/Expert/Skill 引用。默认正文 8000 字符；超限保存不可变 `{id,version,hash,length,mustRead:true}` 引用，不截断约束。成员 `swarm_handoff_read` 连续受控完整读取前，其他工具与成果提交都被阻断；父端再次读回当前尝试 Pi 原生工具调用/结果并核对全文 hash，保存 `attempt.handoffRead`。读取收据仅证明完整正文进入原生工具结果，不能宣称理解或答案正确；明确要求完整阅读的原始附件仍须完整阅读。
- **恢复预览**：`swarm resume.preview {graphId}` 和 `workflow resume.preview {workflowId}` 只读返回 `keep/redo/check`、原因、revision、来源有效性及输入/成果摘要。Workflow 另绑定定义和相关代码字节，传播上游失效。预览不修改状态、水位或修复次数。`resume` 可携带 `previewBinding`，操作前重算；过期拒绝并返回新预览，实际恢复重新验证。未知副作用仍需用户明确确认；原有重试上限不重置。
- **迁移**：已有 v3 数据首次升级前使用 SQLite `VACUUM INTO` 保存 `swarm-pre-v4-*.sqlite`，一次升级记录和 namespace/表的 writer 4 围栏防止旧 writer 覆盖新增等待或交接状态。功能关闭不等于可降级数据库；备份也不能自动覆盖运行中的新数据。

上述协议通过原版本化 Pi bus 和同一 controller 提供，不引入跨插件单例或复制 Pi transcript。最终包、真实外部模型与 Computer Use 的结果由集成候选另外绑定；本包开发测试不代表最终客户端验收。

## Frozen execution policies and configurable experts

New graphs accept `executionPolicy: {v:1, workspace:'isolated'|'shared', review:'required'|'none', dirtyBaseline:'snapshot'|'reject'}`. Omitting it preserves the existing isolated/required/reject behavior, including the existing V0 read-only fast path. Explicit `review:'required'` also reviews V0; `review:'none'` reports `integration.reviewStatus:'not_requested'`, and never creates a fabricated approval. An explicit V1/V2 review contract cannot be waived. Policy changes require a new graph.

`isolated + snapshot` copies tracked and nonignored untracked file content, including staged/unstaged worktree content, without touching the original index. Attempts and the combined candidate use that frozen copy. Integration applies only changed task files, with per-target content checks and original Git branch/HEAD checks. Existing staged content, unrelated unstaged files and untracked content remain intact. Symbolic-link business inputs are rejected rather than followed. `shared` members execute in the real project directory under the same host resource reservations; host member completion performs no Git commit or branch operation, and the member guard rejects explicit Git mutations including index changes. Shared output versions are retained separately, and checks/review bind the live candidate. Shared writes are already visible before review and are not rolled back on rejection or stop.

Tasks accept `expertId`, `expertOverrides` (`prompt`, `skillRefs`, `toolsMode`, `tools`, `modelId`, `thinkingLevel`), and existing explicit task `modelId`/`thinkingLevel`. Task model/thinking wins over overrides; overrides win over the saved profile. `spawn.resolve` and `spawn.validate` use the versioned Pi event bus. The member consumes the frozen model before its first request and includes the exact prompt and selected Skill bodies; `friend-pi.expert.spawn` in native Pi JSONL records the snapshot and effective tools. `toolsMode:'allowlist'` exposes exactly the resolved allowed tools, further limited by task mode and host authority; coordinator tools require explicit inclusion too. `tools:[]` therefore exposes no model tools. Protocol IPC remains internal. If an oversized task requires a mandatory handoff reader absent from the explicit list, the spawn fails before inference rather than skipping its full-read requirement; shorten the task or use inherit mode. Inherit mode keeps the existing coordinator tools. Host and task authority cap profile tools and write scopes. Explicit missing models/tools/Skills fail. Five default profiles are templates, not a role limit. Unchanged legacy catalog selections retain canonical `adopt.frozen`/`adopt.confirm` and trial-scope enforcement; new profiles, saved profile edits, and explicit per-spawn overrides use `spawn.resolve`.

## Editable workflows, citations and observations

`workflow.template.list {}` returns four `WorkflowTemplate` records: `code-development` (代码开发), `code-repair` (问题修复), `source-research` (来源研究), and `structured-delivery` (结构化交付). `template.read {templateId,version?}` reads a version; `template.save {templateId,definition}` saves a new immutable version. `workflow.create {templateId,parameters:{target:'...'}}` creates an editable run; passing `definition` supplies an edited definition directly. Definitions accept `executionPolicy`, objective `checks`, and node `expertOverrides`. Write templates initially target `output/` and check that it contains files; replace scopes and checks with the real project acceptance requirements before executing. Default concurrency remains 4, maximum concurrency 16, and cumulative graph nodes 64.

Graph `create` accepts `claims:[{id,claim,sources:SourceRef[]}]`. `citations.validate {claims}` resolves every claim's exact registered session/entry/span through the host and returns `source_bound` records and source digests, with `entailmentVerified:false`. A source binding establishes traceability, not factual entailment. Bound graph claims participate in its source revocation fence and candidate digest. For final-result claims, create with `deferPreparation:true`, then call `citations.bind {graphId,claims}` after members complete and before `prepare`; binding clears any previous candidate verification and requires fresh checks/review.

`snapshot.summaries` reports observed elapsed milliseconds (including review attempts), summed completed member time, known native token usage, and completeness/unknown flags. Missing usage is unknown; `estimatedSavings:null` deliberately supplies no invented savings or comparative cost. These records are read views over persisted execution metadata, not duplicate transcripts.

Local fake-provider and native Pi SDK verification is recorded by the focused package tests. Real configured-model validation, packaged client Computer Use, final integrated candidate/artifact binding and remote merge belong to the integration chat and are not established by these package tests.
