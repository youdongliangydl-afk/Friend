# @friend-pi/expert

## 本地安装

```sh
mkdir -p /absolute/path/plugins/expert
tar -xzf /absolute/path/friend-pi-expert-VERSION-HASH.tgz -C /absolute/path/plugins/expert
pi install /absolute/path/plugins/expert/package
```

Pi 不会自动解包本地 `.tgz`。也可直接安装 `.artifacts/packages/unpacked/expert/package` 的绝对路径。使用 Node 24 和本项目锁定的 Pi 1.0.4 宿主；Pi/Typebox 为 peer。

独立 Pi Package。加载 `dist/index.js` 后，GUI、`friend_expert` 模型工具和 `/expert` 命令都使用同一控制器。五类内建文本方法是规划、研究、实现、审查和整合；默认提供方法目录，明确选择时采用对应正文。

Role（角色）与 Method（文本方法）是两份独立目录。五类同名内建角色另有硬工具允许列表、项目相对写入范围和结构化交付合同；选择旧方法不会暗中分配角色。方法 `tools=[]` 保持“不新增限制”语义，角色 `tools=[]` 则禁止工作工具。角色与所有已采用方法同时限制工具；方法采用只能收紧本轮权限。Reviewer（审查角色）硬只读，没有 Bash、write、edit 或启动／整合权限；planner（规划角色）可使用 `friend_plan read/submit` 提交计划元数据，不能批准或执行。只读角色可查询目标、任务、工作流和进程状态。写入路径检查包含现存祖先的 realpath；窄写入范围不开放任意 Bash。整个项目 `.` 下的 Bash 仍是宿主高信任 shell，不是 OS 沙箱。

内建角色可使用 `friend_todo read/update` 维护执行清单元数据；这不开放任务完成、文件写入或验证权限，仍受宿主和已采用方法的工具范围限制。启动时为旧内建角色目录增量加入该工具；已冻结运行保留旧合同，自定义角色的显式工具允许列表不自动扩张。

用户通过 `role.create/update` 管理职责、工具、写入范围、交付合同及可选模型／思考映射。模型与插件可以查询、分配下一轮角色或在宿主确认的安全阶段切换同一 Agent 的角色；不能修改角色合同。`role.assign {id,methodIds?}` 只影响后续运行；模型调用该操作也须携带安全阶段信息。`role.switch {id,runId,stage,policyRevision}` 要求真实宿主 `policy.v=1`、匹配 stage／revision／runId、`canSwitchRole=true` 且 `unsettledTools=0`；工具输入自行声明 safe 无效。切换从本轮冻结角色目录选取合同，保留已采用方法的范围交集，不因换角色恢复被方法收紧的权限。一个会话换角色始终记录 `independent:false`，不能冒充独立审核。

模型映射默认继承调用会话。显式映射须存在于宿主公布的 `availableModels`，思考等级须兼容；方法采用不切换模型。角色切换返回 `modelChangeRequired` 并发出 `expert.role.changed`，由宿主在同一安全边界应用明确配置。宿主必须在派发 prompt 前用 `assertRoleModel` 核对实际模型；扩展请求钩子发现不符会调用公开 abort 并通知，工具钩子也拒绝所有工具作为兜底。Pi 对请求钩子异常会记录后继续，且 before_agent_start 的 abort 可能早于运行信号建立，故扩展钩子本身不保证未派发模型请求；原生宿主同样需要应用或拒绝显式映射。原生 JSONL 的角色收据区分目标映射与当前实际模型，不伪称切换已完成。

`freeze {catalog:true,roleId?,methodIds?}` 返回 `roles`、可选 `role`、`methods` 和兼容字段 `experts`。`freeze.role {catalogHash,roleId,capability:{tools?,writeScopes?,modelId?,thinkingLevel?}}` 从同项目的冻结目录读取角色，与宿主父任务和成员能力取交；派生成员不必加载 Expert 或导入其模块。`role.snapshot/read/versions` 可查看当前分配、有效角色和旧合同。角色编辑使用 revision CAS，旧运行仍引用原版本；方法候选验证不能创建或修改角色。

宿主可使用导出的 `freezeRole`、`blockedByFrozenRole`、`assertRoleModel` 与 `assertRoleDelivery` 分别收紧成员能力、执行工具／路径守卫、核对模型映射及校验结构化交付。交付合同为 `{v:1,fields:{field:"string"|"boolean"|"string[]"},required:[...]}`，拒绝字段缺失、合同外字段和类型强制转换。校验通过只证明合同格式成立，不证明任务正确或审核独立。GUI 与模型调用都进入上述同一控制器。

用户管理定义、选择、启停、回滚和验证基准；模型不能通过候选提交绕过管理权限。项目对内建方法的编辑为项目覆盖，其他项目保留原模板。更新使用 revision CAS，历史版本不被改写；回滚生成新版本。

启动时冻结专家定义、工具范围、Skill 的路径、实际 Markdown 正文和内容摘要。Skill 必须位于当前项目，不支持脚本或可执行权限成长。`use` 返回本次实际冻结正文和采用记录；后续文件变动不会悄然进入本次任务。明确选择的工具范围在 Pi `tool_call` 钩子中检查，也覆盖嵌套调用；`friend_expert` 自身仍可用于按需读取方法，其他插件工具不会被整体豁免。

自动按需 `use` 与明确选择采用同一范围策略：本轮已经采用的限制按交集组合，后续采用只能收紧，空交集禁止执行工具；定义中的空 tools 表示不新增限制。冻结目录和版本摘要保持不可变，`adoptedIds/adoptions/toolScope` 是当前实际采用投影。重复 use 不制造重复的本轮 use 收据；明确选择与第一次实际 use 分别留证。SDK 可传 `PluginContext.runId`，原生 Pi 使用新 UUID。

Swarm 通过版本化请求 `freeze {catalog:true}` 取得完整冻结目录，再用 `adopt.frozen {catalogHash,id}` 读取同一版方法；目录按项目隔离，来源撤回后拒绝采用。成员在自己的原生 JSONL 写实际采用收据并立即收紧工具范围；模型和专家身份保持分开，不增加工具权限。

每次实际 `before_agent_start` 为运行生成独立 UUID，并在原生 Pi JSONL
追加 `friend-pi.expert.run` 冻结快照。明确选中的专家同时追加
`friend-pi.expert.adoption`；按需 `use` 的采用也绑定同一运行 UUID。
自动目录的冻结记录不宣称采用全部专家。后续改版或另一轮运行不会
改写旧记录；SQLite 的当前运行指针只供范围检查与当前方法读取。

Expert 与 Skill 使用同一 `plugins.sqlite` 的 `expert` namespace。首次安装包含五类专家和十五个文本 Skill；角色合同保持独立。Skill 正文版本不可变，当前 head 采用 revision CAS。Markdown 位于应用数据目录的 `projections/expert`，仅为可重建只读视图；外部编辑会标记漂移并重建，不导回数据库。旧项目 Markdown 在迁移或用户明确更新时冻结，不在后续执行中追随文件变化。

新目录动作 `catalog.search` 默认返回最多 8 项元数据，上限 20；`expert.read` 返回职责与默认 Skill 引用，`skill.read {id,version}` 才返回指定正文。实际 `use {expertId,runId,catalogHash,skillIds?}` 冻结版本、来源和权限交集，先保存采用 intent，再核对 canonical Pi custom entry。未知或失败的 journal 不返回正文，已收紧限制保持生效；重试仅核对原 operationId，不重复创建成功收据。Swarm 成员通过可信上下文调用 `adopt.frozen`，在自己的 JSONL 写入并 fsync 收据，再调用 `adopt.confirm`。

独立成长入口是 `taskTraceReady {runId,taskResultVersion,taskResult,evidence}`。可验证的 Pi 原史、登记产物及宿主检查构成证据，Memory 仅是可选依赖。`peekExpertLearningJob` / `wakeExpertLearningJobs` 和控制器 `executeLearningJob` 供统一宿主公平轮转；每次 execute 最多发起一个模型请求。作业保存独立 budgetId、sourceRunId、阶段、cursor、调用身份和租约 epoch。普通前台开始不取消在途请求，下一请求等待准入；未知调用不盲目重放。

低风险文本候选通过 `candidate.submit` 提交，以 `trial.configure` 在指定项目和适用范围试用，默认最多三个任务，准入时 CAS 预占。重复输入不作为独立效果证据；真实客观关键失败冻结后续试用。自动方法不得改变角色、工具授权、模型或预算，也不生成脚本、hook、tool 或安装指令。

`validation.manifest` 冻结 train、validation 和隐藏 release 分区、任务/来源族、候选与基线 hash、模型、工具、预算及客观检查器；`validation.schedule` 创建独立后台作业。validation 和 release 各至少需要两个独立正例和一个范围外反例。每阶段 candidate 必须严格多于 baseline 的通过数，关键项和范围外检查全部通过，才晋升 `validated + growth`。两者同样全过、证据不足、近似副本泄漏或预算不足均不发布。隐藏题、答案和可逆输出不通过普通 snapshot 或 validation.read 返回。

来源、登记产物与明确能力依赖在准入及同数据库短事务提交时再次核验；迟到 owner 或来源撤回后的结果不能晋升。旧 published 方法迁为 `trial + legacy-partial`，保留原 id/hash/验证快照；旧 `validation.suite/run` 仅产生局部试用证据，不再直接发布默认方法。用户仍可通过旧管理接口操作，新的 Skill 编辑、启停和回滚使用 `expectedRevision` 与业务 `key`，回滚创建新版本。

新执行的默认方法解析当前有效 Skill head，已冻结执行继续沿用原 version/hash。用户可用 `freeze {expertId,skillRefs:[{id,version}]}` 明确固定单个专家的方法版本；模型与后台不能设置此覆盖。原生 Pi 采用以公开工具清单限制工具，缺少宿主授权与真实清单时保持空工具范围。自动成长不会把 Memory/Expert 工具输出或受管投影回读当作独立 Pi 事实；引用这些能力时需要明确的版本依赖。

```text
/expert select {"ids":["reviewer"]}
/expert create {"title":"项目审查","prompt":"检查项目约束","tools":["read","grep","find","ls"],"skills":["docs/review-method.md"]}
/expert settings {"paused":true}
/expert settings {"paused":false}
/expert validation.suite {"cases":[{"id":"a","kind":"positive","input":"独立案例一","expected":{"result":true}},{"id":"b","kind":"positive","input":"独立案例二","expected":{"result":true}},{"id":"outside","kind":"negative","input":"范围外案例","expected":{"result":false}}]}
```

Pi 和 Typebox 使用宿主 peer；不绑定特定 Provider，不复制 Pi loop。源码和设计参考见 SOURCES.md，以及仓库根来源记录。

新 Skill 操作示例：

```text
/expert catalog.search {"query":"编码","limit":8}
/expert skill.read {"id":"seed.implementer.1","version":1}
/expert learning.settings {"expectedRevision":0,"paused":false,"limits":{"maxCalls":64,"autoTrial":true}}
/expert jobs.read {}
```

包内 fake Provider 测试验证合同和状态，不证明真实模型成长效果。最终真实模型、GUI、制品及组合验收由集成宿主执行并绑定候选提交与 Pi SHA。

### Stable methods and incremental indexes

The current candidate head and the stable validated pointer are separate. Submitting or trialling a same-id update keeps the stable version available to ordinary runs; a trial selects the candidate's exact version (`skillRefs`). In-flight runs retain their frozen body and restrictions. Promotion checks the frozen candidate, stable baseline and source fence. A withdrawn candidate source cannot withdraw an independently supported stable version. Disabling a method still disables every version.

The SQLite version records remain authoritative. Durable dirty-version triggers maintain only changed directory/FTS/dependency rows; unchanged startup reuses those rows. Missing or damaged derived indexes, and schema changes, rebuild from version records. Historical method bodies and source invalidation retain their version semantics.
