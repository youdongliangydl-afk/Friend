# Friend-Pi Swarm / Expert 功能完备性审计

审计对象：源码 `5ec4b39fb7301ac57715976458f602909fc0a0fb`，Pi `eb326d265ae0b88489a6d10319307780df827cdf`。交付清单所列 app 摘要为 `a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4`。本审计新运行源码测试和独立控制器夹具，没有操作 GUI，没有读取用户认证文件，没有修改业务代码。这里引用制品身份来自当前清单，不冒充本审计重新计算制品摘要或重新做真实模型验收。

## 结论

Swarm 与 Expert 的首版主要闭环确实存在，新跑 43 项现有专项测试全部通过；包含真实 Pi SDK、真实独立 Node 成员、原生 JSONL、真实 Git worktree / cherry-pick / fast-forward，以及 fake / 本机 HTTP Provider。它们不是只展示面板的占位功能。

但不能据此宣称原计划全部完备。额外 6 项专项探针确认了 4 个差距，另 2 项补充验证通过。首要问题是停止操作没有取消已经启动的宿主客观检查；其次是缺少定向返工、自动采用专家的工具范围执行不一致，以及共享材料事件在事务提交前发布。管理界面的若干信息/操作仍然有限，需要根 Agent 的同候选 GUI 核验来确认实际可用性。

## 可复现差距

| ID / 优先级 | 当前行为与复现 | 原计划 / 用户影响 | 证据位置 |
|---|---|---|---|
| SWARM-STOP-OBJECTIVE-CHECK / P1 | 独立临时项目里启动一个真实 Node 客观检查，该检查先写 started，600ms 后写第二个文件；等待 started 后 stop 在 1ms 返回，图显示 stopped，随后第二个文件仍被写入；没有复核成员启动 | 停止没有覆盖宿主检查进程；用户可能以为所有执行已停止，检查仍继续产生文件等副作用 | `packages/swarm/src/index.ts:115-117,316-320,365-368`；`probes.ts` / `probe-results.json` 同 ID |
| SWARM-TARGETED-REWORK / P2 | 两个相互独立只读任务，复核只指出 task-a 错误，task-b 正确；下一轮 task-a、task-b 都各执行一次，总计各 2 次 | 有界返工已实现，定向返工没有实现；没有受影响任务集合/依赖闭包，增加成本并扩大成果变化面 | `packages/swarm/src/index.ts:375-377`；同 ID 探针 |
| EXPERT-AUTO-TOOL-SCOPE / P2 | 创建 tools=[read] 专家；自动目录模式 beginRun 后调用 use，实际采用记录有 read 范围，但冻结范围仍 undefined，bash 不会被拦截；明确选同一个专家则 bash 被拦截 | 同一专家的工具范围因采用方式不同而行为不同；这是工具策略一致性问题，不宣称存在 OS 沙箱 | `packages/expert/src/index.ts:74-77,108-111,215`；同 ID 探针 |
| SWARM-SHARED-EVENT-COMMIT / P2 | shared.write 的变更事件 payload 显示 1 份共享材料时，同步查询的第二个 SQLite 连接仍是 0 份；调用返回后才成为 1 份 | 共享版本 CAS 与原子文件没有丢更新，但“通知”先于持久化事务提交，订阅者可能拿到尚不能沿另一连接回查的状态 | `packages/swarm/src/index.ts:308-314`；同 ID 探针 |

运行复现：`node --import tsx .artifacts/qa/evolution-audit/swarm-expert/probes.ts`。所有项目、SQLite 和进程均为本次临时夹具；退出后删除本次夹具，不触碰用户工作区。该脚本将“实际观察到差距”记录为 `CONFIRMED_GAP`，不会通过改变断言把差距写成 PASS。

## 原计划逐项覆盖

| 原计划能力 | 当前核查结果 | 新验证 / 源码依据 |
|---|---|---|
| 成果 DAG、依赖合法性、循环与重复检查 | 已实现、专项通过 | swarm.test：DAG / dependencies；index.ts:34-49 |
| 原子领取、并发数默认 4 / 可调 | 已实现、专项通过 | 两个独立控制器共用 SQLite，竞争只产生一次领取；index.ts:150,171-181 |
| 非 Git 写入串行、读者并行 | 已实现规则、专项通过 | claim 串行门槛；index.ts:178,220；非 Git 没有回滚/独立整合工作区，写入就在原项目发生 |
| Git 写成员独立进程 / worktree | 已实现、专项通过 | native member / real controller tests；worktree 与整合目录不同 |
| dirty baseline 保留、只读仍可用 | 已实现、专项通过 | dirty baseline test；未删除用户草稿、未产生成员 |
| 依赖成果传递、整合串行 | 已实现、专项通过 | dependencyCommits、真实 Git 两任务传递与整合；index.ts:186-201,356-359 |
| 自检 | 部分实现 | 写成员结束时执行 git diff --check / scoped staging；成员提示要求报告检查；没有独立结构化自检用例与证据门槛；index.ts:269-278；guard.ts:43 |
| 客观检查、独立复核 | 已实现、专项通过 | 检查真实执行；不同 Pi 会话只读复核器；结构化结果工具提交，等 agent_settled 才采用；反向文字不能覆盖 |
| 基线变化 / 冲突保留并暂停 | 已实现、专项通过 | 现有 baseline change test；新增真实两 worktree 同文件冲突探针：原项目 HEAD 与文件未变，两个成员和冲突整合目录保留 |
| 自动返工最多 2 轮 | 已实现、专项通过 | independent rejection test 恰好 3 次实现尝试 / 2 轮返工 |
| 定向返工 / 调整方法入口 | 缺少后端定向集合与对应 UI | 当前所有任务重跑；GUI 仅 start / pause / stop / resume / prepare，不能指定返工任务或改当前任务要求；panels.tsx:67-70 |
| 暂停 / 停止 / 明确接续 | 成员闭环已实现；宿主检查取消缺口 | unknown 要求用户 confirmUnknown；旧尝试结果不能覆盖新尝试；stop-check 差距见上 |
| 成员崩溃 / 会话关闭不重放 | 已实现、专项通过 | vanished owner / pre-launch shutdown / native lifecycle tests；保存 unknown、没有自动启动 |
| 消息先持久化、已投递 / 已处理 | 已实现、专项通过 | durable delivery、member 实际 user message 消费才 processed；重复 ready 不重复投递 |
| 共享材料短事务 / 版本 CAS / 原子文件 | 存储实现、专项通过；通知顺序有差距 | immutable v1/v2 文件、过期 CAS 拒绝、路径名称校验；事件见上 |
| 工具范围含嵌套调用、禁止递归派生 | 已实现工具钩子、专项通过 | guard test 带 parentToolCallId，越界/范围外/递归/未确认 rm 拦截；shell 是高信任，不是完整沙箱 |
| 关键确认 | 已接公开 UI 确认接口，规则测试通过 | index.ts:248-258,409；实际 macOS 对话体验由根 Agent 核验，本审计未做 GUI |
| Expert 五类、稳定身份 / 版本 / 摘要 | 已实现、专项通过 | expert startup / immutable version tests；内置 planner/researcher/implementer/reviewer/integrator |
| 实际采用版本、历史不被编辑覆盖 | 已实现、原生 JSONL 专项通过 | 同一 Pi 会话两次 run 记录 v1 / v2，旧文件前缀保持；自动目录不会假称所有专家已采用 |
| Skill 正文 / 范围冻结 | 明确指定场景已实现、专项通过；自动 scope 有差距 | 原方法正文变更后仍返回已冻结 v1；Markdown / 项目路径校验；auto-use 见上 |
| 方法按需采用 | Single 模型 use 入口存在；加载和 Swarm 采用粒度有限 | 自动目录 freeze 会预读所有启用专家的 Skill，use 返回该冻结正文；Swarm 成员不加载 Expert 插件，采用记录在 attempt.expert，不能从成员 JSONL 确认自动目录中究竟采用哪个角色 |
| 专家适用领域 / 检查标准 | 文本支持，结构化能力有限 | prompt / 候选 method 可写范围和检查标准；definition 只有项目 scope，没有领域谓词、检查标准字段或运行时匹配器；index.ts:8,68-77；编辑 UI 只有名称、方法、工具、Skill |
| 两个独立适用案例 + 一个反例 | 已实现门槛、专项通过 | 用例 ID 与输入不同，至少 2 positive / 1 negative；用户拥有 oracle，模型不能创建套件 |
| 客观验证、缺少基准不发布 | JSON 预期比对场景已实现、专项通过 | 真实输出与用户 expected 深比较；记 baselinePassed；不是模型自评。首版没有外部测试脚本/文件制品断言的 Expert 验证器，领域效果只能由用户给定 JSON 案例证明 |
| 限域自动发布 / 撤回 | 项目隔离与来源撤回已实现、专项通过 | 新方法只写本项目、只有文本、不加 tools/skills；来源失效/套件变化/关闭时晚到结果不能发布；细粒度任务领域为文本约束 |
| 后台串行 / 前台优先 / 暂停 | 已实现、专项通过 | 双控制器 lease、serial queue、foreground idle、abort pause/resume |
| 编辑 / 版本差异 / 启停 / 回滚 UI | 后端已实现、UI 调用已接；真实 GUI 未在本审计重测 | panels.tsx:98-104；新增 rollback 探针恢复旧正文生成 v3，旧 v1 / v2 不改写 |
| Swarm 管理 UI | 主操作入口已接；可见性/恢复操作有限 | 任务依赖卡片、尝试摘要、状态、消息收据、共享材料、检查/复核展开；没有成员工具事件/原生会话读取、单任务返工、每任务 Expert 选择、保留 worktree 打开按钮 |

## 适合后续规划书的优化单位

1. **先补齐停止闭环**：当前“已停止”但检查仍运行；目标是任务、成员、客观检查、复核都显示明确取消状态，等待终止边界再确认停止。验证要用真实可延迟检查并确保停止后不再写文件。
2. **定向返工与计划修订**：当前拒绝后全量重跑；目标是复核问题 → 受影响任务 → 依赖闭包，展示保留哪些已通过成果，用户可调整方法后再执行有界新尝试。
3. **Swarm 运行视图**：当前长卡片列表和 JSON 路径；目标是依赖图 + 成员列 + 整合/检查/复核阶段、可打开原生来源/工作区，显示为什么暂停以及下一项操作。
4. **专家采用可解释性**：当前只见选择列表，自动 use 工具范围与明确指定不同；目标是本轮已采用的 Expert id/version/hash/适用范围/工具范围清晰可见，统一自动与明确采用策略。
5. **专家验证模板**：当前用户写 JSON oracle、范围为一块方法文字；目标是按领域拆分适用范围与检查标准，给出客观验证模板和反例覆盖，不以几条模型回复替代代码制品或外部事实验证。
6. **共享材料版本与通知一致性**：当前 CAS 正确但通知先发；目标是提交完成后事件发布，界面展示基于版本、冲突差异与重载草稿的明确步骤。

这些是待用户决策的建议，不是已经实施的功能。竞品调研应分别寻找上述可用体验，不把竞品宣传或源码中的入口当作已体验到的行为。

## 证据文件

- `targeted-tests.log`：本次 43 / 43，Node 24.15.0，无真实外网模型。
- `probes.ts`：6 项独立探针。
- `probe-results.json` / `probe-output.log`：4 个 CONFIRMED_GAP，2 个 PASS。
- `coverage.json`：机器可读原计划覆盖与差距。

Git 在专项结束后保持原提交、无跟踪文件变更。截图、宽窄窗口、点击/键盘及真实模型的客户端体验由根 Agent 独占调度；本报告不伪造这些证据。
