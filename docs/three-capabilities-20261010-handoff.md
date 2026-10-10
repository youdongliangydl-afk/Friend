# 三功能开发候选交接

本候选实现方案会话定稿的 Swarm、Memory、Expert 与 Skill 自进化。开发候选测试、真实模型效果、桌面验收和最终集成验收分别记录；本说明不表示已经远端合码。

## 身份与范围

- Worktree：`/Users/bytedance/.codex/worktrees/three-capabilities-20261010/Friend`
- 分支：`codex/three-capabilities-20261010`
- 开发基线：`6e98ee592672bba0efdfbbb3a589efb5ab4d5545`
- 方案定稿：`8c6b5b6`，方案目录 `docs/design/2026-10-10-three-capabilities/`（由方案会话交接，未在本候选重复复制）。
- Pi：`eb326d265ae0b88489a6d10319307780df827cdf`，Node 24.15.0。
- 固定候选 SHA/tree、App/bundle/dataDir、制品 SHA256 和各验证日志绑定于开发交接消息及 `.artifacts/three-capabilities/` 下的证据清单。本文不写入自身提交 SHA。
- 未改依赖、锁文件、构建/打包脚本、Topic/Rebuild 包；未推送、创建 PR 或合码。
- 集成会话拥有最终 Git 集成与验收。其后续导航 UI 分支不在本候选内，不能直接相加两批测试结论。

## 实现

### Swarm

- typed 任务契约、V0/V1/V2 验证、客观检查和新只读 reviewer/verifier；V0 读取不隐藏派 reviewer。
- Git 工作树与非 Git staging 独立产物、摘要绑定、受控 apply、恢复日志、检查/复核后候选变化即失效。非 Git 依赖输入与原项目 apply 基线分别保存；同文件串行写入保留中间不可变产物，按依赖拓扑选择最终写者并仅应用一次。
- 最多两轮修复；桌面及原生 Pi 的宿主逻辑步骤身份跨图沿用，不能只改 task ID 重置额度；同失败无进展停止。
- 资源范围预约、过期/崩溃保持 UNKNOWN、预算独立统计与父目标去重记账。成员未确认终止时保留资源、预算和 handle，等待真实退出回执或对账。
- 外部操作 prepare/dispatch/reconcile 保存幂等与提交状态。未配置真实宿主适配器时明确不可用，未知操作不自动重发。
- 真实成员 Pi JSONL 登记到公共来源注册表；成员续聊/采用沿用 native entry 身份，不复制会话正文。

### Memory

- 新类型为 preference/fact/experience；旧 method 保留只读兼容。模型工具明确提供实际查询 action，不把排队/候选当作已经采用，也不猜测用户专用写入操作。
- 不可变历史、revision/CAS、操作幂等、别名/条件/有效期/复核时间、精确来源与依赖撤回。停用标记归属记录，重新启用仅解除本记录的可逆停用；永久遗忘、更正和宿主撤回保持有效。同 entry 全部分片参与引用核对。
- 中文加权 FTS、可解释命中、目录与正文分离、分段/原史回查和实际提供范围收据。
- 独立 extract→validate→publish→可选 compact 管线，不再强制走 Expert distill。
- 全部分批覆盖才推进水位；artifact-only 学习只允许真实观察范围，图片无正文或仅 parser/saved 不生成事实。
- 受管 Markdown 视图、manifest/outbox/drift 重建；纠正/遗忘同步撤回派生内容，清理投影、备份与暂存正文，并抑制旧来源重学。

### Expert 与 Skill

- 15 个种子 Skill、元数据目录、不可变版本/head CAS、只读投影、编辑/停用/回滚与旧记录迁移。
- 主任务与成员冻结采用、显式选择、角色/工具/写入权限统一取交集；原生 journal 对账后才返回采用正文。独立原生 Pi 以真实工具目录和当前项目范围作为宿主边界，Skill 限制继续收窄。
- 从任务 trace 独立学习；取消/未知结果不变成成功经验，无客观成功证据则等待证据。
- trial 上限三次；真实 TaskLedger 检查、原生 Pi Bash 或 Swarm 成员原生 Bash 检查结果触发可信反馈，绑定采用版本、每轮 run/member/task 与 CheckRef，跨任务/旧版本不能影响当前试用；主控、成员及桌面 TaskLedger 检查在实际 assistant 决策或用户主动验证开始前冻结 canonical 采用集合，后采用的方法不能获取旧检查信用；缺任一最终采用记录时整组保持等待，不筛掉失败检查；同逻辑任务新一轮失败仍反馈到同版试用，额度与成功次数按图作用域中的逻辑任务/实际输入去重。成员输入摘要来自当前 attempt 的原生用户条目并核对冻结提示；不以父会话原史或模型字段替代。相同内容的补充证据不重置版本、额度或冻结状态。独立 train/validation/hidden release、严格优于 baseline 且关键检查通过才晋升。
- 同一项目 Skill 的成长版本保留限制，重复内容不重新获得试用额度；自动提取仅提供可变项目基线。捏造/内置基线作为坏提议最多三次独立计量重试，真实并发仍拒绝覆盖；未知调用不重放。
- 原生 Pi 只装 Expert 亦可独立学习，不依赖桌面或 Memory 常驻单例。

### 公共宿主与桌面

- 公共 SourcePolicy 原子提交围栏、精确个人来源授权、ArtifactRef/CheckRef/依赖、共享串行 learning lease 和独立调用预算。
- 两宿主的后台调用幂等身份绑定版本化请求摘要：公开 SDK 解析后的实际端点、非秘密模型配置、anthropic-beta、锁定 SDK 明确读取的非秘密路由/缓存 env 选择器、思考强度、输出上限、阶段及提示正文摘要。认证只留在临时 SDK 选项中；用 Pi 公开 provider.stream 与 normalizeContext 执行同一冻结快照，避免二次认证解析覆盖端点。收据仅存摘要，不存原始头或凭据。
- 已确认操作参数变化拒绝 VERSION_CONFLICT；所有未确认调用优先保持 UNKNOWN。Memory 在重算 extract/compact 材料前检查原未决账本，标题修改、配置变化、冷恢复和唤醒都不能换键重派；请求身份冲突终止作业并保留未覆盖范围与 canonical 原调用身份。Expert 本地缓存仅作恢复定位，结果仍须经过公共账本及实际请求身份校验；缺账本、旧身份或未确认缓存均拒绝使用与重派。
- 后台使用入队时冻结型号；前台工作阻止新后台准入，已发请求可并行完成。Memory/Expert 公平轮转。
- 暂停/退出/进程被杀、HTTP 断连或派发后账本写入失败的未知调用保留账本并返回 OPERATION_UNKNOWN；手动恢复与重启均不得换 operationId 自动重发。已确认阶段可复用。调用收据保存实际 stopReason、请求 maxTokens 与 SDK 返回的 usage；length 明确记为已收到但不完整的失败响应，保留原结果/用量，Memory 与 Expert 停止该学习作业、保留未覆盖范围且不推进 cursor；唤醒与重启不能换 operationId 重试或采用半截 JSON。普通格式错误仍按原三次上限处理。
- 附件注册不可变原始字节快照；保持旧冻结输入/侧分支队列行为。
- parser/saved、selected、Pi `context_with_system` 的 injected-to-context 分开记录。上下文钩子收据不等于最终网络载荷、模型理解或答案正确。
- Single 长期目标的写入成果通过客观检查后等待用户验收，不另派 reviewer；验收绑定候选摘要、任务/目标版本及当前代码内容。暂停后显式接续清除旧绑定并要求新的客观检查；普通 Pi 执行终态仍不等于验证通过。
- 面板展示验证级别、未知用量/外部状态、Memory 使用与来源、Skill 目录/采用/版本/学习；GUI 与模型工具调用同一控制器。
- 设置中的扩展只承载 MCP 与现有网页工具；不显示 Swarm 手动任务配置与上下文诊断。Expert 独立分类仅提供启用开关，目录、擅长领域与版本管理移至 Expert 工具页；角色合同收起为高级内容。开关仅更新对应插件，保留其他设置并通过原空闲配置边界生效；专家/记忆页面入口直接打开对应分类。 异步设置加载按作用域代次核对，未加载完成不能保存，旧响应不能覆盖新作用域。旧用户关闭底层插件时，协作模式在用户选择或创建协作会话时按需补 Swarm；无限上下文保存自动补所需能力，保留 Expert/Memory 开关及其他已保存默认值。

## 本地验证与边界

旧候选 bb811761、05f9865、b48d8eec 与 10272d5a 的后续审查反例已作废其可集成结论；旧日志和真实模型结果单独保留，不作为新候选证据。正式日志和计数以固定候选证据清单为准。focused 覆盖 Memory/被动 Topic、Expert native-only、Swarm、公共宿主、实际 built worker 与 localhost HTTP/SSE 进程生命周期。

重点反例包括：来源撤回与迟到响应、片段越界读取、个人来源扩大、失败/UNKNOWN 重复计量、资源过期持久 UNKNOWN、换图不重置修复、Single 候选变化拒验收、前台不抢占后台请求、后台未知请求重启不重放、冻结附件原文件缺失仍保持原输入。

以下不从本地假 Provider 推断：

- 真实模型质量、学习效果和晋升效果。
- Computer Use 用户旅程、界面视觉与交互通过。
- 实际旧版打包客户端在新数据库上的兼容性；本候选仅以旧 SQLite 连接模拟证明读保留/写拒绝。
- 真实外部操作适配器与服务端幂等/回查能力；无适配器明确拒绝。
- 第三方云 SDK 的隐式凭据/profile 默认链、代理传输路由及并发修改 ambient env；请求快照仅核验锁定 Pi 明确读取的非秘密选择器。缺少公开 provider.stream 拒绝准入；未声明这些第三方或并发环境边界已完整冻结。
- 合并其他开发批次后的单一候选通过。

共享桌面由集成会话协调独占验收时段；本开发会话已取得释放时段，GUI 结果仍以绑定固定候选的独立证据清单为准。用户已授权使用 DeepSeek，配置仅写入本会话的独立 Pi auth store；禁止使用集成会话 profile 或复制其凭据。

## 集成接收与操作

1. 在集成会话自己的 worktree 接收固定提交；处理 main、renderer/types 与导航批次的接线重叠，保留本候选 session tombstone/SourcePolicy 事务。
2. 运行 TypeScript、build 和全仓测试；候选内容变化则重绑新的 commit/tree/制品身份。
3. 使用唯一 App 名称、bundle 与独立 dataDir 启动，并核对进程/窗口与候选，不能用旧包截图替代。
4. 通过真实 GUI 验证 Memory 新建→检索→正文/来源→纠正→遗忘→重启不回流；Skill 目录→版本→停用/回滚→真实采用收据；Single 待验收→确认/候选变化拒绝；Team/Swarm 检查、复核、停止、恢复及非 Git apply。
5. 追加明确配置真实模型的前台、后台并发、Memory 学习、Expert trial/客观验证、Swarm 成员与复核旅程；缺证据保持 waiting，不以 trial 存在证明学习有效。
6. 完整验收通过后，仅由集成会话创建 PR、合入远端 main、核对远端并保存最终证据。所有未运行项需明确保留。

开发 worktree 与 `.artifacts` 应保留，直到固定代码、证据、未提交内容已安全接收。
