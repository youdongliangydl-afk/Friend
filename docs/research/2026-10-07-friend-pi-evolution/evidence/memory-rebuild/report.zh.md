# Friend-Pi Memory 与 Topic & ReBuild 完备性核验

候选：`5ec4b39fb7301ac57715976458f602909fc0a0fb`；Pi：`eb326d265ae0b88489a6d10319307780df827cdf`；已交付 `.app` 清单树摘要：`a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4`。本轮核验读取当前源代码，重新运行 31 项既有针对性测试，并添加 3 项故障/边界正向用例和 5 项独立需求回归。31 + 3 项通过，5 项回归失败。全部新数据位于临时目录，未读认证文件，未改变源码、应用包、原项目或用户数据。

结论：四项主要路径存在，Memory/ReBuild 的关键存储与 Pi 历史接口有较充分的测试；“所有已开发能力完备”尚不成立。以下失败属于原测试未覆盖的组合，不应被上一轮 95 项通过、可见按钮或小批真实模型旅程掩盖。本轮没有执行 GUI 或真实模型；旧 GUI/模型报告只作为已交付候选的历史证据列出。

## 本轮新发现

| ID / 优先级 | 触发、实际行为 | 产品影响 | 精确位置 | 证据与建议 |
|---|---|---|---|---|
| R02 / P1 | 一个原始用户消息同时包含“数据库必须使用 SQLite”“必须保留 UTF-8 中文字段”；只纠正数据库记忆为 PostgreSQL，整理后的约束数组为空 | 无关且仍有效的中文编码约束一并丢失 | `packages/memory/src/index.ts:393` 发出整条来源；`packages/topic-rebuild/src/index.ts:88` 把来源 entry 整体退休；`:304-307` 丢弃任何引用该 entry 的点 | 独立失败用例 R02。改为事实/引用片段粒度的撤回关系，保留原文和未被撤回的约束；不能只关闭抑制而让旧错误复活 |
| R01 / P2 | 用户先要求蓝色侧栏，后明确“更正，不再蓝色，必须绿色”；普通结算 checkpoint 同时保留旧蓝色、新绿色，显示 `applied`，未请求整理 | “有效约束”面板可同时给出相互冲突的要求；必要纠正触发尚未完整实现 | `packages/topic-rebuild/src/index.ts:171-178` 累加约束；`:294-301` 只在压缩时处理更正；`:377-379` 自动请求只检查 Memory epoch | 独立失败用例 R01。下一安全边界处理明确更正，无法可靠判别时显示待确认冲突并提供有来源的取舍；不要每条消息增加模型调用 |
| M01 / P2 | 用户明确说“请帮我记住，我更喜欢中文解释”；Agent 的 `save(personal, preference, explicitRemember:true)` 被拒绝为未明确请求 | 常见中文表达无法使用已承诺的“明确要求记住偏好”流程 | `packages/memory/src/index.ts:159` 仅允许一个礼貌前缀 | 独立失败用例 M01。扩充可证明的肯定请求表达，同时保留“请不要记住”等否定保护；不能依靠模型自己设置 true 放宽权限 |
| M02 / P2 | 同一数据目录有 A、B 两个控制器/活会话，A 正在后台 provider 调用；B 前台开始只调用 B 的 `foregroundStarted`，A 的 AbortSignal 仍未取消 | 全局串行后台队列只保证后台彼此串行；跨会话前台优先尚未实现 | `packages/memory/src/index.ts:215-216` 全局后台占用；`:246` 只取消当前实例；`:256-269` idle/signal 仅属于当前会话；`packages/core/src/index.ts:135-139` 直接 provider 调用 | 独立失败用例 M02。通过版本化跨进程请求或持久前台租约协调全应用优先级；GUI 验证切换会话后发起请求、前后台同时运行时的行为 |
| M03 / P2 | 遗忘一个带来源事实后关闭控制器；使用真实 `SessionManager.forkFrom` 复制原史，新 sessionId 保留原 entryId/body；Reflection 对同一旧事实换词改写，重新出现候选 | 遗忘内容可在原生 Pi fork 后以候选再次出现。尚未自动成为 active，不能声称有效记忆已自动恢复 | `packages/memory/src/index.ts:119-128` 只抑制 content hash 或 sessionId:entryId；Pi `dist/core/session-manager.js:1374` 公共 fork 复制原条目 | 独立失败用例 M03（真实 Pi JSONL/fork + fake completion）。结合原 entryId、类型/角色/body 摘要或原始谱系识别同一证据；同时避免不相关短 ID 碰撞被误删 |

复现：

```sh
node --import tsx --test .artifacts/qa/evolution-audit/memory-rebuild/independent-regressions.test.ts
```

期望退出码当前为 1，共 5 个需求断言失败。原始输出在 `independent-regressions.tap`；结构化现象在 `regression-observations.json`。这些用例验证产品需求，不只是验证已有代码按自己的逻辑运行。

## 已验证与部分实现

| 能力 | 源码/本轮测试结论 | 真实客户端证据边界 |
|---|---|---|
| Memory SQLite 权威、版本、Markdown 导出 | 独立版本表与 FTS；CAS；显式导出；已验证源文可读；新增 P01/P02 注入 SQLite update/delete 故障，父子、版本、索引、抑制、事件均原子回滚 | 旧 GUI 报告证明 v3→v4 纠正与冷启动；未覆盖全套增删改查 GUI |
| 中文/混合词元、单字、部分 Latin、标点检索 | 本轮重跑 CJK bigram、unicode61、FTS 安全参数及 substring fallback 通过 | 旧 GUI 只小批检索，不能代表大规模搜索质量 |
| 项目隔离、个人偏好显式记住 | 既有正/负向与跨项目可见性通过；常见中文肯定表达失败见 M01 | GUI 新建个人偏好、模型肯定/否定自然语言需单独体验 |
| 项目自动学习 | 默认启用，native `agent_settled` 入队。Reflection 形成有来源候选，用户确认才 active；不把模型自评当证据 | 自动候选不等于自动可用长期记忆，应在产品文案说明 |
| Reflection → Dream → Distill | Reflection 校验原 entry，Distill 只交文本方法候选；无 Expert 可保留 unavailable 候选，独立性测试通过 | Dream **部分实现**：只做精确重复合并和同标题冲突提示；无语义冲突、适用期/过期判定。重新启用 Expert 后无现成可重投动作 |
| 纠正/停用/遗忘/派生撤回 | 同一原会话冷启动抑制、派生级联、接受无效候选拒绝、事件提交后发布均通过；粒度与 fork 边界见 R02/M03 | GUI 停用→启用、遗忘→重启→立即学习、子候选撤回需完整覆盖 |
| 后台队列、暂停、前台优先、重试停止线 | 跨控制器后台原子串行通过；同控制器前台/暂停中断不耗次数；3 次失败后停止、显式重试通过；跨会话优先见 M02 | 真实 provider 超时/429/暂停恢复、跨会话切换尚未本轮 GUI 体验 |
| ReBuild 原始历史与工作现场分离 | 原史唯一来源是 Pi JSONL；SQLite 只索引/hash/操作元数据；checkpoint canonical receipt 后采用，保存失败不假推进 | 旧真实模型证明两次 compaction adopted，旧 GUI 小会话 fallback/原文打开 |
| 目标、约束、决定、未完工作、近期其他主题 | native checkpoint 无额外模型调用；budget/manual compaction 才调用整理模型；助手单方“完成”被明确标记未独立核验 | 普通纠正冲突见 R01；语义 Topic 在压缩时建立，普通 checkpoint 标签只是消息前缀启发式 |
| 唯一操作、来源覆盖、水位/版本 | 异步新增消息保留在 capture 之外，canonical adoption 才推进；缺来源、改源、拒绝保存、取消、预算不足均 fallback，通过 | 真实客户端整理期间新增输入、取消需单独体验；已有控制器 fixture 通过不代表 GUI 交互通过 |
| Memory invalidation 的安全重建 | epoch 持久化、重启仍无效、不能浅 checkpoint 假清除；Memory optional/短超时，不引入强依赖；来源抑制可跨 Pi 克隆 body 身份校验 | 注意这项 ReBuild 克隆保护 **没有**同步落实到 Memory 自身 M03 |
| 原文搜索/读取/前后文/项目边界 | 新增 P03：真实 Pi JSONL 两个同项目会话 registry，冷控制器查读另会话原文通过；另一项目拒绝与检索隔离通过 | GUI 搜索结果缺会话名/来源定位/返回上下文的导航体验可作为演进项；API 能读不等于用户容易找回 |
| 自动开关、独立安装/组合 | 关闭后不 checkpoint/不调用模型/不召回 Memory，history lookup 可用；原生 Memory+ReBuild 两个组合测试本轮通过 | idle 插件 reload/启停组合由主 Agent 统一测，不能从独立控制器推导实际 GUI reload 成功 |

## 主 Agent 应完整体验的 GUI 清单

1. Memory 无筛选列表、新增项目事实/经验/方法/个人偏好；中文长词、单字、英文前缀、混合词、无结果、清空搜索。
2. 候选采用、无法采用无效候选、纠正、版本原文、来源原文、停用/启用、Markdown 导出后打开实际文件。
3. 删除一个带派生关系的父记忆，确认对话框取消/确认；冷启动后立即学习，核对候选与已采用内容。
4. 自然语言“记住/请帮我记住/请不要记住”等流程，核对身份、范围、版本和实际 action，而非只看模型回复。
5. 后台暂停/恢复/立即学习，查看 reflection/dream/distill 阶段、失败重试；切到第二会话发前台消息，核对第一会话 provider 是否让路。
6. Context 自动开关、手动整理、小会话 Nothing to compact、成功两次重建、终止整理；保留上一有效现场和原文。
7. 两主题来回、早期约束、用户更正、整理过程中新增输入；逐项核对“有效约束”与真实目标是否一致。
8. 同条用户消息含两个独立约束，只纠正一个带来源记忆，再手动整理，验证未纠正的约束仍在（R02）。
9. 历史搜索、原文、前后文、当前现场每一来源按钮；同项目第二会话查到第一会话条目，跨项目查不到。
10. idle 禁用 Memory 仍能 ReBuild、禁用 ReBuild 仍能 Memory 工具/管理、重新启用后候选/现场/历史不丢失；所有 GUI 操作保持主 Agent 独占输入。

## 证据索引

- `focused-tests.tap`：本轮 31 项通过，包含 Memory 单元、ReBuild 单元、两个真实 Pi SDK/JSONL 组合 fixture；网络模型均 fake。
- `independent-positive.test.ts` / `.tap` / `positive-observations.json`：本轮 P01/P02/P03 共 3 项通过。
- `independent-regressions.test.ts` / `.tap` / `regression-observations.json`：本轮 5 项失败，R02、M02 是控制器组合，M03 使用真实 Pi fork。
- `.artifacts/qa/cua-final-report.json` / `real-model-report.json`：上一轮同候选历史 GUI/真实模型证据，本轮没有重做，也不覆盖上述失败场景。
- `requirement-coverage.json`：逐项覆盖与缺口供主报告汇总。

所有源码路径均以 `/Users/youdongliang/Desktop/Friend-Pi/` 为前缀；本报告未声称竞品已体验，也未替用户决定修复与演进范围。
