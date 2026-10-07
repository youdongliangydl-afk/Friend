# MiniMax Code / Reasonix：功能地图、机制与体验核验清单

研究时间：2026-10-07。此文件是资料/源码研究，不是客户端验收，也不是 Friend-Pi 最终演进规划。没有操作 GUI，没有读取用户配置/凭证，没有拉取或更改参考仓库。

## 版本与许可

| 对象 | 本次只读核对 | 可用证据边界 |
|---|---|---|
| MiniMax Code 装机客户端 | `/Applications/MiniMax Code.app`，Info.plist 版本 **3.0.68** | 只确认装机版本，尚未由本 Agent 体验；桌面源码不在所查公开仓库 |
| MiniMax 开源仓库 | `/Users/youdongliang/Desktop/参考项目/minimax-code`，clean HEAD **56221c121c6e63d0e50b68f57d4abf083afed119**，remote `https://github.com/MiniMax-AI/minimax-code.git`，package 0.6.2 | 公开 TUI/runtime projection，不能直接当作桌面 3.0.68 的源码映射；第一方默认 MIT，vendored sandbox-runtime 为 Apache-2.0，Pi/资产/依赖按文件原许可。见 [固定许可说明](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/LICENSE-STATUS.md) |
| Reasonix 装机客户端 | `/Applications/Reasonix.app`，Info.plist 版本 **1.38.6** | 精确源码标签 `v1.38.6` = **e2145b031deef603d9ec1acc9d30f9a1e1ac9325**；标签通过 git show 只读研究，未切换分支 |
| Reasonix 当前参考检出 | `/Users/youdongliang/Desktop/参考项目/reasonix`，clean studio HEAD **63195e95a5b95c4b2c69481dea272fc4d5ce0bcd**，remote `https://github.com/esengine/DeepSeek-Reasonix.git` | Studio 2.x 新架构；不能把它的组件算到本机 1.38.6。稳定分支本地 remote `origin/main-v2` = 866ad4cb8ee12f353f13ea1efb34be311ed9dc4e。默认 MIT，复用时仍核查具体依赖/文件许可。版本线见 [固定 README](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/README.zh-CN.md) |

本次官方网页已实际 browse：MiniMax [桌面文档入口](https://agent.minimax.io/docs/code/welcome)、[完整索引](https://agent.minimax.io/docs/llms.txt)、[CLI 功能](https://agent.minimax.io/docs/cli/features)、[下载与产品形态](https://agent.minimax.io/download)；Reasonix [官网](https://reasonix.io/)、固定标签下的 Checkpoints / Subagent / Context Engine 文档。每个下表链接是对应一手页面或固定 commit 源文件。

## MiniMax Code 的完整功能分类

以下是文档已覆盖的桌面入口；每行的操作仍为 **待 GUI 核验**。它用于尽量覆盖功能面，而不假称每项已实跑成功。付费/登录/跨设备/外部发布等依赖要分别记为受限或未体验。

| ID | 功能 / 布局 | 客户端入口与建议核验 | 一手来源 |
|---|---|---|---|
| M01 | Coding / Work 两种显示重点 | 切两模式，比较是否隐藏开发面板、保留同一任务和能力 | [Modes](https://agent.minimax.io/docs/code/workflows/modes) |
| M02 | 新任务与项目上下文 | 首页 composer 选目录，@ 一个真实夹具文件，重新打开任务检查项目路径 | [Workspace](https://agent.minimax.io/docs/code/workflows/workspace) |
| M03 | 多媒体/文件输入 | 拖入文本、图片及支持格式，查看附件来源、预览与上下文引用；无需付费生成 | [First task](https://agent.minimax.io/docs/code/get-started/first-task) |
| M04 | 会话侧栏、分组、搜索 | New Task / Search / Pinned / Project history / Archive；找会话、改名、置顶、归档再恢复 | [Tasks](https://agent.minimax.io/docs/code/workflows/tasks) |
| M05 | 长会话轮次导航 | 用已生成夹具会话查看定位、预览、跳转前后保持草稿与滚动 | [Tasks](https://agent.minimax.io/docs/code/workflows/tasks) |
| M06 | 本地 / 云任务与 handoff | 查看 local/cloud 控件及 Continue in Cloud；核查推荐文件的确认卡与变化预览。没有授权时只查入口，不上传私有资料 | [Tasks](https://agent.minimax.io/docs/code/workflows/tasks) |
| M07 | 引用/选择批注 | 选择回复中的一句、代码块或表格，多选批注一起送回当前任务，核查定位 | [Collaboration](https://agent.minimax.io/docs/code/workflows/conversation-collaboration) |
| M08 | 单条回复反馈 | 查看 like/dislike 与原因入口；研究界面即可，不提交外部反馈 | [Collaboration](https://agent.minimax.io/docs/code/workflows/conversation-collaboration) |
| M09 | Review / Diff 范围 | 夹具改动后选择所有未提交/上一轮 Agent 改动；文件 viewed/unviewed 与 findings 行定位 | [Code Review](https://agent.minimax.io/docs/code/workflows/code-review) |
| M10 | 文件与制品预览 | 右侧 Files 开文本/Markdown/SVG/HTML/支持文件，切预览与源码；Windows Office 支持不算 macOS 验证 | [Panels](https://agent.minimax.io/docs/code/desktop/panels) |
| M11 | Changes / Git history | Changes 按文件看 diff；Change Graph 看分支、commit、标签，添加 commit 为上下文 | [Panels](https://agent.minimax.io/docs/code/desktop/panels) |
| M12 | Terminal / 执行过程 | 右侧跟踪测试/构建输出、折叠与打开；特别观察停止后日志与后台进程实际状态 | [Panels](https://agent.minimax.io/docs/code/desktop/panels)；[公开 runtime 边界](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/docs/tui-capabilities.md) |
| M13 | Goal 跨轮目标 | `+` 或命令菜单选 Goal（单独键入 /goal 不等于进入）；查看目标/证据/暂停编辑恢复，明确 completion 验证结果 | [Goal](https://agent.minimax.io/docs/code/desktop/goal) |
| M14 | Agent Team | Sidebar Agent Team，看 specialized Agents / 分解 / producing→verifying / 汇总入口；记录与普通任务具体差异 | [Team](https://agent.minimax.io/docs/code/agents/team) |
| M15 | Custom Agents | 创建页只读查看名称、头像、描述、指令、默认模型、workspace、channels；专用会话入口 | [Custom Agents](https://agent.minimax.io/docs/code/agents/custom-agents) |
| M16 | Plugins / Skills / 账户连接 | 市场搜索/详情/授权及费用说明、已安装开关；@ 选择的包身份不应只按显示名绑定 | [Plugins](https://agent.minimax.io/docs/code/agents/plugins)；[公开 @ 绑定实现边界](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/docs/tui-capabilities.md) |
| M17 | MCP 配置、测试和工具发现 | Plugins 管理→MCP Servers；表单/JSON、stdio/http/sse、启停、test、错误行；用自有无网络夹具，不读已有 secret 字段 | [MCP](https://agent.minimax.io/docs/code/agents/mcp) |
| M18 | 全局记忆与主动学习 | Settings→Personalization：Memory / Proactive Memory 独立开关；summary 管理、更新时间、编辑/删除入口 | [Memory](https://agent.minimax.io/docs/code/agents/memory) |
| M19 | 会话记忆读取 / 生成 | `/memory`：Use memory 会话开始前决定；Generate memory 可中途调整，观察禁止读取与禁止学习的差别 | [Memory](https://agent.minimax.io/docs/code/agents/memory) |
| M20 | Browser 工作台 | 右侧 Browser 多标签、移动预览、Agent 光标路径、普通页/本地页打开偏好；只访问自有夹具或公开页 | [Browser](https://agent.minimax.io/docs/code/desktop/browser) |
| M21 | Computer Use | 市场插件、@/composer 开关、预览窗口、缺失权限提示；是否实际可运行取决于 OS 许可，不自动扩大系统权限 | [Computer Use](https://agent.minimax.io/docs/code/desktop/computer-use) |
| M22 | Infinite Canvas | 本地任务右侧 `+`→Canvas；拖动、缩放、多选、HTML 节点滚动/大小、Add to chat、区域/元素批注、Vary | [Canvas](https://agent.minimax.io/docs/code/desktop/infinite-canvas) |
| M23 | Mini Apps | 专用菜单与右面板，用现有空白示例观察创建/预览/后续自然语言修改入口；不接真实外部账户 | [Mini Apps](https://agent.minimax.io/docs/code/agents/mini-apps) |
| M24 | H3 / H3 Max 与图音视频输出 | 查看选项、输入媒体条件与计划/费用提示。实际生成需要服务权限/额度，未做即明确未体验 | [H3](https://agent.minimax.io/docs/code/agents/h3-max) |
| M25 | 定时任务 | Sidebar Scheduled Tasks：name/instruction/Agent/time/conversation mode，启停/立即触发入口；研究时不建立用户后台任务 | [Schedules](https://agent.minimax.io/docs/code/automation/schedules) |
| M26 | 手机 Remote Control | 查看 pairing 与进度/追加指令/审批入口；没有手机配对则不能声称实跑 | [Remote Control](https://agent.minimax.io/docs/code/automation/remote-control) |
| M27 | IM 通道 | 中文区 WeChat/Feishu，global Telegram/WeChat/Lark；绑定与账户权限。只查可用性，不向别人发消息 | [IM](https://agent.minimax.io/docs/code/automation/im) |
| M28 | BYOK 模型 | Settings→Usage & model→Custom model：preset / Others、Fetch、Test、Save、composer model/thinking；区分“保存”“test request”“任务真实派发” | [BYOK](https://agent.minimax.io/docs/code/account/byok) |
| M29 | 托管模型、API Key 与用量 | Usage：模型/订阅/额度/花费入口；仅读安全元数据。真实 Key 不读/不输出，不能把余额截图视作模型调用通过 | [Usage](https://agent.minimax.io/docs/code/account/usage)；[API key](https://agent.minimax.io/docs/code/account/minimax-api) |
| M30 | 外观/易读性 | Settings→Appearance：密度、对话宽度、字体/代码字体、对比度、重置；用户明确浅色偏好，不采夜间风格 | [Appearance](https://agent.minimax.io/docs/code/desktop/appearance) |
| M31 | 命令面板、快捷键、Mini Window | Settings→Shortcuts；搜索动作/会话/设置、侧栏任务跳转；小窗口只是可选扩展 | [Shortcuts](https://agent.minimax.io/docs/code/desktop/shortcuts) |
| M32 | 更新、通知与反馈 | 当前版本、check update、bell/inbox、反馈草稿及 My Feedback 回执；不提交报告/上传日志 | [Updates](https://agent.minimax.io/docs/code/desktop/updates-feedback) |
| M33 | 权限呈现 | 工具的常规/关键审批，文件范围与外部效果，取消与原因。规划模式不应混同权限模式 | [Permissions](https://agent.minimax.io/docs/code/workflows/permissions)；[CLI modes](https://agent.minimax.io/docs/cli/features) |
| M34 | 会话恢复/分叉/回退/队列/侧问 | CLI 完整能力包括 sessions / fork / rewind / retry / compact / queue / steer / btw；桌面是否同样开放需逐项看实际入口 | [CLI features](https://agent.minimax.io/docs/cli/features)；[恢复与停止边界源码文档](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/docs/tui-capabilities.md) |

这些分类覆盖官方 desktop 文档目录的核心 workflows、desktop features、agent capabilities、automation、models/account 与 help。不是对所有可组合服务、每个付费插件、每种文件格式都完成实际运行的声明。

## MiniMax 的机制：哪些值得看，哪些不能照单全收

1. **可阅读的执行单元**。公开 runtime 将 background work、Goal、队列、输出存储、交付抑制分开，模型回复不替代实际任务终态。`packages/local-runtime/src/background-task/user-stop-cascade.ts` 的 stop 先校验 owner/turn，再暂停 Goal 与级联本进程拥有的任务，抑制停止中的晚到自动唤醒；整体 best-effort / 15s 边界。Friend-Pi 当前 stop-check 缺口应优先补完整所有权与取消链，界面显示“正在停止 / 已停止 / 部分未终止”，不直接复制整个复杂模块。固定 [source](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/packages/local-runtime/src/background-task/user-stop-cascade.ts)。
2. **Worker→Verifier 并非模型配置无关**。公开 source `verification-policy.ts` 中，managed MiniMax 路线默认 subagent verifier，BYOK custom/configured 默认 none，避免悄悄加倍用户模型调用；可配置覆写。它是公开 runtime 0.6.2 的源事实，不证明桌面 3.0.68 一致。Friend-Pi 应始终显示“复核未运行 / 运行 / 通过 / 拒绝”的真实状态，不能因模式按钮叫 Swarm 就宣称已独立复核。固定 [source](https://github.com/MiniMax-AI/minimax-code/blob/56221c121c6e63d0e50b68f57d4abf083afed119/packages/agent-modules/goal/src/verification/verification-policy.ts)。
3. **成果、过程与角色分层**。官方技术文提出 Leader/Worker/Verifier、交付证据、可拉取共享材料以及协作的交接/共享/整合成本。可借鉴阶段化证据和可追问成员；不应把技术文的设计描述算作每配置下已验证行为，更不采用“零错误交付”类营销文案作为保证。[技术文章](https://agent.minimax.io/docs/techblog/agent-team)。
4. **全局与会话记忆控制分开**。个人设置管 use / proactive，会话管 use / generate。Friend-Pi 可以借此明确“引用已有经验”与“把本轮学成经验”的差别；用户要求个人偏好只明确记住时保存，应保留自己的更严格默认。

## Reasonix 1.38.6 的功能分类（与装机版本对应）

下表源文件 URL 固定至精确标签 commit `e2145b…`；读 source / docs 仍不等于 GUI 已体验。对应网页文档在 v1.38.6 标签 browse 后确认，源码用 git show 读取。

| ID | 功能 / 布局 | 客户端入口与建议核验 | 固定来源 |
|---|---|---|---|
| R01 | 顶部项目/标签、侧栏对话 | 新夹具目录、同项目两会话、global/project、tab close/rename、侧栏状态、收起展开、拖动分栏 | [App shell](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/app-shell/TopicbarRegion.tsx) |
| R02 | 命令面板与会话搜索 | Cmd+K、搜索 current/past chats、项目/功能路由、键盘高亮回填 | [CommandPalette](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/CommandPalette.tsx) |
| R03 | 富文本 composer / 附件 / @ / 草稿 | 路径引用、结构化 token、折叠长粘贴、图像、拖文件或目录、undo、历史prompt；保留用户输入 | [Composer](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/Composer.tsx) |
| R04 | Plan 与审批姿态 | Plan 开关独立于 Ask/Auto/YOLO；计划审批“修改/开始/退出”；只读 Plan 与实际写工具行为 | [Guide](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md) |
| R05 | Goal / 两级 Todo | 协作菜单 Goal；目标状态、pause/resume、唯一 current step 与完成证据；不要默认开启无限循环 | [Guide Goal](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md#goal) |
| R06 | 流式回复 / 思考 / 工具折叠 | 普通读写、shell输出、phase、聚合读记录、错误原因，完成后是否残留 running | [ProcessFold](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/ProcessFoldHeader.tsx) |
| R07 | 本轮结果收据 / 检查证据 | 本轮文件计数、+/−、coverage partial/unknown、checks passed/failed/notrun；工具成功不当作整个task通过 | [TurnResultSummary](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/TurnResultSummary.tsx)；[结果文档](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/TURN_RESULTS.zh-CN.md) |
| R08 | 文件 tree / 预览 / 编辑 / Diff | Workspace dock：文件引用、原文、Preview/Source、diff范围、未追踪文件是否明确显示 | [WorkspaceTurnResult](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/WorkspaceTurnResult.tsx) |
| R09 | Terminal / Browser | topicbar terminal按钮与workspace/browser工作台，shell折叠与后续输出；浏览器登录权限只查入口 | [Desktop browser](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/DESKTOP_BROWSER.zh-CN.md) |
| R10 | Checkpoint / rewind / fork / summarize | 用户消息 hover rewind，预览 Code / Conversation / Both / Fork / Summarize；确认冲突提示与恢复范围 | [Checkpoints](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/CHECKPOINTS.zh-CN.md) |
| R11 | Task monitor | topicbar summary→session/project/all，queued/running/waiting/succeeded/failed/cancelled/stale；事件、时间、stop/requeue/open原会话 | [TaskMonitorPanel](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/TaskMonitorPanel.tsx) |
| R12 | 子代理 Profile | Settings→Subagents：name/prompt/model/effort/tools，slash调用；只读try与正常run不同，不能把Profile当新增权限 | [Profiles](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SUBAGENT_PROFILES.zh-CN.md) |
| R13 | task / fleet / 并行写入 | 成员状态、任务依赖、write paths、原会话/进度/取消、资源排队；默认总6/写3但是否当下配置需实际查安全元数据 | [Profiles](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SUBAGENT_PROFILES.zh-CN.md)；[进度](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SUBAGENT_PROGRESS.zh-CN.md) |
| R14 | 隔离 worktree 与合并 | 分叉isolated worktree产生新tab，topicbar合并入口，原基线变化要清楚指出；与默认shared writer机制区分 | [Topicbar worktree](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/app-shell/TopicbarActionsStack.tsx) |
| R15 | 中断工具恢复 | Recovery卡：检查、已生效确认、不重试、受限retry；unknown写屏障、runtimeEpoch/revision 防旧响应覆盖 | [Tool recovery](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/TOOL_RECOVERY.zh-CN.md) |
| R16 | Context Center / 指令来源 | 指令/事实/当前上下文来源、继承优先级、诊断；站立规则与背景事实分层 | [Context Engine](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SESSION_MEMORY_RETRIEVAL.zh-CN.md) |
| R17 | Memory 管理 | Settings→Memory 与上下文面板，facts/candidates/recall/instructions、search/source/revision/correction、global/project | [MemoryPanel](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/MemoryPanel.tsx) |
| R18 | 记忆激活 / 冲突 / 召回 | pinned常驻 vs relevant检索、subject key的项目覆盖global、CJK bigram、过期降权、纠正后有效revision | [Context Engine](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SESSION_MEMORY_RETRIEVAL.zh-CN.md) |
| R19 | 双模型 planner/executor | 模型设置与可选planner配置，计划提交边界、显式plan-only / waitapproval /执行；普通请求不应另加一次classifier | [Guide双模型](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md#双模型协同) |
| R20 | Model / Providers / Effort / 能力 | Settings3页＋composer：preset/自定义URL与APIformat、测试/保存区别、图像支持与effortpropagation；不读已有凭证 | [Model settings](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/MODEL_SETTINGS.zh-CN.md) |
| R21 | 模型统计 / 用量 / 成本与时间预算 | 设置model-stats、token/cache命中、价格未知明确未知、跨成员用量；用户预算显式选择 | [Guide](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md) |
| R22 | MCP / Skills / Plugins | 设置各页列表、作用范围、启停/测试/发现/详情，检查错误出现位置，slash与@调用 | [Guide MCP](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md#插件mcp) |
| R23 | Hooks / 自动化 / Diagnostics | 设置hooks、事件/崩溃诊断/健康检查；不要自动启用执行外部副作用的hook或上传日志 | [Hooks](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/DESKTOP_HOOKS.zh-CN.md) |
| R24 | Remote SSH / IM Bots | Settings remote / bots，主机身份与模型凭据边界，连接错误及本地/远程状态；不读取或复制已保存Key | [Guide Remote](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md#远程-ssh)；[Bots](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/BOT_GUIDE.zh-CN.md) |
| R25 | 权限 / 沙盒 / Network | 设置permissions、sandbox、network；动作审批与文件范围独立，显示平台能力限制 | [Approval modes](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/TOOL_APPROVAL_MODES.zh-CN.md) |
| R26 | 设置搜索、组、默认/项目作用域 | 20页按 preferences/models/connections/capabilities/context/automation/security/application 分组；搜索不到时clear/empty状态 | [SettingsNavigation](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/SettingsNavigation.tsx) |
| R27 | 快捷键/外观/存储/更新 | Settings快捷键冲突与锁定系统编辑键、appearance密度字重、storage清理备份/迁移、update版本与恢复 | [Guide keys](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/GUIDE.zh-CN.md#桌面端-gui)；[Recovery](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/RECOVERY.zh-CN.md) |
| R28 | 会话导出、复制、摘要 | topicbar copy-all / export markdown/json/pdf/image / summary；检查导出对象是不是当前原始历史 | [Session actions](https://github.com/esengine/DeepSeek-Reasonix/blob/e2145b031deef603d9ec1acc9d30f9a1e1ac9325/desktop/frontend/src/components/TopicbarSessionActions.tsx) |

## Reasonix 机制的价值和边界

- **真实恢复动作和一般 retry 分开**。工具恢复由 kernel持久化 call/attempt/参数摘要/幂等身份，started但无结果仍unknown；确认不会伪造工具成功。普通shell/MCP无法权威证明外部效果不存在，默认不安全自动retry。Friend-Pi现有“unknown后confirmUnknown新尝试”可演进为具体副作用检查收据，保留原史和新尝试身份。[固定恢复文档](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/TOOL_RECOVERY.zh-CN.md)。
- **Checkpoint不是“撤销一切”**。它保留可预览文件工具的before-image，会话恢复显式分叉保留父链，外部编辑冲突不覆盖；shell/数据库/发布等外部效果没有文件快照保证。Friend-Pi若增加回退，先只支持明确文件工具与Pi原生分叉，不能宣传全任务回滚。[固定checkpoint文档](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/CHECKPOINTS.zh-CN.md)。
- **指令与记忆的权限不同**。scope/type/activation正交，project事实可覆盖global同subject事实，pinned须用户选择，普通记忆按需召回。Friend-Pi应把“此条经验为什么生效/不生效”呈现出来，而不是只追加一列来源文本。[固定Context Engine文档](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/docs/SESSION_MEMORY_RETRIEVAL.zh-CN.md)。
- **单控制器，多客户端**。桌面/TUI/HTTP共用host行为。Friend-Pi已用统一插件控制器，不需要引入另一个完整内核；可以参考版本化错误类、检查收据、作用域设置和可解释UI。[1.x host结构](https://github.com/esengine/DeepSeek-Reasonix/blob/v1.38.6/desktop/README.md)。

## Studio 2.x：只能作为另一产品候选研究

当前studio源码还包含 pane/deck多会话、workbench树与可编辑文件、Browser、上下文压缩原因/覆盖卡、记忆pinned/relevant分组、工具/集成scope、remote hosts、wallet/usage、backup、进度观察、反馈/社区等功能。只读发现入口在：

- [Studio Sidebar](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/desktop/frontend-next/src/ui/Sidebar.tsx)
- [Settings](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/desktop/frontend-next/src/ui/Settings.tsx)
- [Memory](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/desktop/frontend-next/src/ui/Memory.tsx)
- [Workbench](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/desktop/frontend-next/src/ui/WorkbenchPanel.tsx)
- [CompactionCard](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/desktop/frontend-next/src/ui/cards/CompactionCard.tsx)
- [官方ROADMAP](https://github.com/esengine/DeepSeek-Reasonix/blob/63195e95a5b95c4b2c69481dea272fc4d5ce0bcd/docs/ROADMAP.md) 明列未完成发布门槛，不能将“新UI源码存在”视作全部流程通过。

## Friend-Pi 可借鉴的优化单位（供主规划使用）

| 优化单位 | Friend-Pi已核查的优化前 | 可借鉴的产品方式 / 来源 | 建议优化后、示意图应画什么 | 复杂度与决策 |
|---|---|---|---|---|
| 运行与停止状态 | 会话卡有终态，但hostcheck停止链缺口 | MiniMax owned stop cascade；Reasonix taskmonitor状态原因 | 卡片“检查运行→正在停止→已停止/未终止”，右侧显示实际对象列表和证据 | 首先修正确性；不先引入Goal/cron |
| 成果审阅 | 一个文本Diff与工具折叠；未追踪文件/本轮范围信息有限 | MiniMax上一轮/all-diff＋viewed；Reasonix本轮results/checkcoverage | 右侧文件列表→diff→实际checks→来源，区分Agent本轮与原项目全部改动 | 优先；用原始Pi工具/自有收据，避免复制聊天正文 |
| Swarm成果与定向返工 | cards展示依赖，拒绝后全量重跑 | Team生产/验证阶段；TaskMonitor成员详情 | 依赖图/阶段条、成员选中详情、问题→受影响task/下游闭包→新尝试 | 优先，保持Single/Swarm两方式 |
| Expert采用解释 | 列表与版本管理，但当前自动实际采用与toolrange不清 | MiniMaxCustomAgent role；Reasonixprofile工具/model/effort | 本轮方法chip→v/hash/已冻结范围/skill来源，auto与explicit统一 | 优先；不加独立外部Agent后端 |
| Memory读取与学习控制 | 插件开关/学习暂停，有来源记忆条目 | MiniMaxuse/generate双控制；Reasonixactivation/scopes | 会话可读/可学两个开关与有效范围chip、为什么命中/覆盖、纠正影响链 | 有用，继续个人偏好明确要求才保存 |
| ReBuild可解释现场 | 当前field/水位/来源分列，用户较难理解整理是否有效 | StudioCompactionCard覆盖与原因（源码） | 一张“为什么整理、保存状态、覆盖原文/缺口、下一次重建”卡，来源跳转 | 优先；按公开Pi压缩接口，不加自制loop |
| 设置可发现 | 通用配置已入设置，分类/搜索待完善 | Reasonix20页分组搜索；MiniMaxPersonalization/Usage/Appearance | 左侧简洁分组＋搜索，主栏只显示当前配置、作用域与生效边界 | 优先，先5-7组，不复制20页 |
| 精准反馈/引用 | 轮次预览书签已有，针对选中片段的后续修改有限 | MiniMaxmultiquote评论、Reasonixper-turnactions | 选中句子/代码→引用卡＋指令；保持原文锚点与来源 | 中等；无需侧聊/多窗口 |
| 安全回退 | Swarm隔离保留，但Single没有通用回退UI | ReasonixCheckpoint/Fork | “文件改动可恢复 / 外部效果不可恢复”preview；仅明确文件工具、冲突确认 | 中等偏高，需单独验证后才能承诺 |
| 可读性与键盘 | 浅色/拖动分栏/轮次导航已交付 | MiniMaxdensity/width/font；Reasonix快捷键registry/search | 标准/舒适密度、正文宽度、字体与键盘提示，保留浅色Friend布局 | 低到中等；不需要壁纸/主题市场 |
| 能力安装/诊断 | 四包本地独立，GUI开关 | 两者能力详情/连接测试/安装位置 | 四插件状态、版本、独立安装说明、真实load error与retry | 中等；市场仅必要时加，先不堆完整框架 |
| 浏览器/终端/Canvas/remote/office | 原计划首版排除或未纳入 | MiniMax多媒体/浏览器/IM/云、ReasonixSSH | 独立“可选扩展”示意，不在核心优化后图默认全部显示 | 高复杂度；让用户逐项决定，避免重建原Friend复杂度 |

优化示意图应明确“前”来自当前Friend-Pi真实截图/源码，“后”为设计方案，竞品截图为参考证据。不要把after mock画成已实现，也不要把预发布Studio画成装机1.38.6实际体验。

## 根 Agent 实际体验的优先顺序

1. 两产品基本布局、composer、会话切换、范围/模块大小、快捷键/搜索。
2. 自有Git夹具的读取→小改动→实际check→diff审阅→stop→冷重启，记录工具事实与任务终态。
3. Team/Profile或fleet：成员详情、消息/状态、复核证据、暂停/恢复与失败原因。配置受限时记录，不虚构成功。
4. Memory与上下文：普通事实/规则、纠正/版本、范围、生效理由、来源回看。
5. 设置各页、模型测试/保存差别、plugin/Skill/MCP状态、外观/键盘。
6. Canvas、Browser、MiniApps、Schedule、Remote、IM、云handoff、付费媒体：尽量查看入口与可逆本地场景；受限项单列，外发/上传/购买/授权不因“体验”自动执行。

所有本Agent条目实际GUI状态为 NOT_RUN。主 Agent 可以把对应ID与实际截图、操作、结果、阻塞条件绑定，逐步形成真实覆盖率；分母应是明确功能项而不是任意组合穷举。
