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

Memory 的自动方法必须携带可回查来源和父记忆。`idempotencyKey` 在项目内绑定内容及来源摘要，重复投递不创建重复候选，不同内容使用同一标识会被拒绝。用户也可手动提交文本候选。

发布只依据用户提供的固定 JSON 基准：至少两个不同输入的适用案例和一个范围外反例。队列实际调用配置的模型，分别运行基础方法和候选方法；将响应与预期 JSON 做严格客观相等检查。发布保留案例快照、基准摘要、模型、逐例结果，且只在本项目范围启用。结果仅证明这些声明案例，不证明一般专业水平。

自动验证串行进行，SQLite 运行租约避免同数据目录下两个控制器并发验证。前台工作优先；可暂停，关闭时取消在途调用，模型调用失败不无限自动重试。进程异常后的在途验证恢复为待验证，不制造发布。来源纠正或遗忘撤回候选和派生方法；撤回期间的迟到响应不能发布。

```text
/expert select {"ids":["reviewer"]}
/expert create {"title":"项目审查","prompt":"检查项目约束","tools":["read","grep","find","ls"],"skills":["docs/review-method.md"]}
/expert settings {"paused":true}
/expert settings {"paused":false}
/expert validation.suite {"cases":[{"id":"a","kind":"positive","input":"独立案例一","expected":{"result":true}},{"id":"b","kind":"positive","input":"独立案例二","expected":{"result":true}},{"id":"outside","kind":"negative","input":"范围外案例","expected":{"result":false}}]}
```

Pi 和 Typebox 使用宿主 peer；不绑定特定 Provider，不复制 Pi loop。源码和设计参考见 SOURCES.md，以及仓库根来源记录。
