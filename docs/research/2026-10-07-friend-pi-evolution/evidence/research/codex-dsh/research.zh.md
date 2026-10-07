# Codex、DeepSeek Harness 客户端资料/源码深研，附 ZCode 与额外主题参考

研究日期：2026-10-07。此分报告是源码与在线官方资料调查，未操作 GUI、未读认证文件、未发模型请求。主报告应将根 Agent 的真实体验、截图与本报告逐项合并；未执行、条件不足、只观察入口必须保留原标签。

## 产品与版本边界

| 对象 | 本轮固定源码/来源 | 许可 | 安装版本（根 Agent 盘点） | 证据限制 |
|---|---|---|---|---|
| Codex | `openai/codex`，main `afb436df8b70bb5bc57b86d9a3e829968988cd21`，2026-10-04 | Apache-2.0 | 26.1002.51308 | 开源目录包含CLI/TUI、core、app-server与SDK，不能把TUI/协议当闭源Desktop已体验。官方旧Codex-app文档今日重定向到统一ChatGPT/Codex资料 |
| DeepSeek Harness | `deepseek-ai/deepseek-harness`，master `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，2026-10-03 | MIT，Copyright DeepSeek 2026，独立第三方Notice | 0.2.0-rc.2 | 当前源desktop package已是0.2.1-alpha.1；源功能与安装版分别记录。官方桌面是完整Web UI的Electron shell |
| ZCode | `zai-org/ZCode`，main `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，2026-09-24 | Apache-2.0，独立第三方Notice | 3.14.3 | 仓库包含Desktop/Web共享React UI与Agent。官网资料可能部分落后于源码，须由已装GUI判定 |

身份更正：根 Agent 已盘点装机应用 **Ocean，bundle `com.lspjs`，v1.18.10**。本报告检索到的社区Harness仓库也把一个主题叫作Ocean，但没有证据将两者对应。该仓库仅留作额外开源主题参考，不进入竞品或真实体验矩阵；没有“本机Ocean未安装”的结论。它的远端参考pin为 `405f333b467683bb0e639fa1a1558d5b58dd3d71`，MIT已查固定LICENSE，未复制代码。

三份本地参考仓库均只读、工作树干净，未fetch修改引用或更新代码。远端HEAD只用于Ocean资料冻结；不把本地pins称为已重新更新的远端最新版本。

## Codex：从执行聊天到可审阅工作空间

### 客户端能力与入口地图

| 优化研究领域 | 产品/官方资料与源码线索 | 应体验的入口与结果 | 对Friend-Pi的含义 |
|---|---|---|---|
| 导航与长期任务 | 官方按项目、聊天、来源组织；源app-server处理thread start/fork/archive与turn行为 | 左栏项目/置顶/最近/分组，对话menu、rename、unread、archive、全局搜索 | 横向项目与左会话结构可保留，补可靠检索、注意力队列、管理空状态 |
| 执行位置 | Local/Worktree/Cloud分别说明目录与隔离；worktree支持起始branch、后续Handoff | 新任务环境picker、页头路径/branch、测试worktree、Handoff及保留成果 | Swarm成员工作区身份、基线、未整合成果应可见；运行环境不藏在技术详情 |
| 模型与运行控制 | native turn与后台队列有独立协议；config支持模型、推理和自动压缩阈值 | 模型picker、计划、权限、运行中steer/queue、stop、冷恢复 | 区分本次运行快照与下次草稿配置，当前停止状态与成员剩余工作分开 |
| 问题澄清与审批 | app-server typed request/elicitation与UI响应；Guardian是独立审核领域 | 确认/选择/输入弹窗、取消/超时/会话切换、待处理任务提示 | 每种用户交互明确owner与“等待你”，避免自动结束图标掩盖待审批 |
| 上下文提供 | official浏览器/文件资料；CLI能文件访问但没有Desktop视觉预览 | 附件、`@`引用、文件树/搜索、图片与URL预览、上下文Chip | 文件路径输入升级为选取→预览→添加引用→来源可查，建立可解释材料列表 |
| 成果审阅 | official Code Review为Summary/Changes、文件、comments、checks；本地review协议 | 测试修改的changed-file列表、Diff行评论、草稿反馈、审阅状态 | Diff不只输出原始patch；给结果证据、文件路径与后续定向返工连贯入口 |
| 工作台 | official per-chat terminal、可视文件预览/HTMLsource、浏览器/annotation | New tab→文件/终端/浏览器/审查，拖分栏、全屏、重开、返回 | 固定模块按钮增加历史和来源间导航；是否引入终端/浏览器由用户单独决定 |
| 多代理 | core多agent工具独立spawn/message/followup/interrupt/list/wait；official app显示子线程 | 与“多条用户任务并行”分别验证：真实两只读子工作、打开子过程、stop | Swarm任务图、成员、消息应有通向真实子会话/工具记录的统一路径 |
| Memory | local Codex memory与ChatGPT memory分离；后台两阶段流水线见源README | `/memories`的读/贡献开关、Settings Personalization；历史和reset入口仅观察 | 长期记忆的参与范围、后台运行状态、来源和生成/采用区别可集中呈现 |
| Context | core auto compact、turn-end threshold、manual compact/recap、原rollout | 长会话整理前后、约束与源文回查、取消/失败后继续 | ReBuild提供比“压缩已完成”更具体的当前目标、约束、水位与引用证据 |
| 扩展 | Skills、MCP、Plugins、Apps有不同scope和执行路径 | 清单、来源、启停、配置、load errors、命令菜单；需环境项列未执行 | Expert所用方法/Skill版本与插件能力开关不要混成一个工具表 |
| 时间与持续工作 | official Scheduled区分单独任务与同会话后续；本地任务依赖应用开着 | Scheduled模板/规则/历史/关联chat、Goal暂停恢复；实际触发单独验证 | 可考虑“延期回访”但需持久调度/错过运行/停止语义，先完成目前安全恢复 |
| 跨机器与账号 | 当前资料包括远程/Cloud，project在执行端，浏览器会话不自动搬运 | 远程hosts、environment缺失状态、账户使用率，只浏览现有配置 | 整体账号/连接状态应在Settings；首版仍用本机Pi保持边界可验证 |
| 可达性与可配置体验 | official命令和可检索快捷键、外观字号、通知、sleep/followup偏好 | CmdK/CmdF/Tab/Escape/窄窗、shortcut search、字幕式工具标签 | 不只增加快捷键，需要菜单、tooltip、焦点和键盘路径共同可发现 |

公开资料分别支持：[项目与聊天](https://learn.chatgpt.com/docs/projects)、[执行环境](https://learn.chatgpt.com/docs/environments/modes)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[审阅](https://learn.chatgpt.com/docs/code-review)、[终端](https://learn.chatgpt.com/docs/integrated-terminal)、[浏览器](https://learn.chatgpt.com/docs/browser)、[文件工作台](https://learn.chatgpt.com/docs/artifacts-viewer)、[子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Memory](https://learn.chatgpt.com/docs/customization/memories)、[定时任务](https://learn.chatgpt.com/docs/automations?surface=app)、[设置](https://learn.chatgpt.com/docs/reference/settings)、[命令](https://learn.chatgpt.com/docs/reference/commands)。这些今日资料包含ChatGPT Work/Space/dots等内容；本报告只把Codex有关线索提供给实际版本检查。

### 源码层值得借鉴的具体机制

- `codex-rs/app-server/src/message_processor.rs` 对 fork、compact、interrupt、review 使用不同请求分支；业务行为与请求/响应/通知相分离。Friend-Pi可以保持Pi运行权威，同时把用户侧进度区分为请求受理、执行、等待交互、停止确认与成果采用。
- `codex-rs/memories/README.md` 的提取阶段使用每来源持久claim、空闲窗口、失败backoff；整合阶段有全局lease与使用/时效筛选、基线diff、成功水位。对本轮 Memory 跨会话优先与过期内容缺口，有现成机制思路可参考；总额度不应被悄悄改为用户未要求的限制。
- `codex-rs/core/src/tools/handlers/multi_agents_v2/*` 保持 spawn/followup/message/interrupt/list/wait 的不同语义；子任务结果与父对话整合是独立步骤。可借鉴状态表达与持久消息receipt，而不替换Pi agent loop。
- `codex-rs/tui/src/slash_command.rs` 覆盖 model、permissions、memories、skills、review、fork、compact、plan、goal、agents、diff等，但这是**TUI菜单源码**，桌面是否有相同入口需实测。

## DeepSeek Harness：模块化过程展示与多材料工作台

### 主要布局与交互

当前固定源码的AppFrame是左导航、中央Conversation、右侧停靠内容。源码UI布局说明左栏默认280px、可264–420px；右侧首次45%、之后像素偏好、70%上限，优先保护中间400px，窄于1024px时收起导航。macOS收起左栏时去掉整个rail，在交通灯旁保留重新打开/新会话入口。布局文档声明重新加载后几何状态重置；Friend-Pi已具备持久分栏宽度，因此重点是借鉴“优先保护主工作区”的收缩顺序与焦点行为。[固定源码布局](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-layout/README.zh.md)

| 领域 | 固定源功能线索 | GUI入口与深体验 | 应保留的边界 |
|---|---|---|---|
| 项目会话 | Workspace/session sidebar，置顶、归档、版本品牌、New Session默认workspace顺序 | 左栏workspaces/new/session/search/menu、Settings底部；当前项目和session路径 | DSH项目不是Friend原版顶栏横向结构；用户已指定布局应继续保留 |
| 运行与输入 | `ui-conversation` binding/openTurn、input takeover；Chat只投影原记录 | 输入中steering/queued消息、等待交互时Stop、发送与原记录一致性 | 队列消息和已进入模型轮次消息不混作已处理 |
| 模型/preset | providers、自定义模型、推理强度；Standard/Creator/PTC/Minimal、只读YAML解释 | 模型与新任务默认preset、查看配置/帮助、自定义失败状态 | preset是插件组合，不是Expert的不可变技能成长版本 |
| 权限/计划 | permission preset、plan独立状态、全文计划、批准/拒绝/历史卡 | `/plan`→任务→右侧全文审批→已完成回合成果→重开 | DSHplan主要是策略指导，实际只读需独立sandbox/approval |
| Chat/Trajectory | 工作步骤显示/折叠，另有专门时间线/记录检查器 | 顶部View切换、真实tool参数/返回/错误/耗时/TTFT/token、历史分页 | Trajectory看的是记录，不能把tool成功当整个目标完成 |
| 引用/附件 | 文件/目录/session同`@`source，skill/command另source，持久附件 | 输入补全、目录下钻、引用Chip点击、历史图片/lightbox与断源 | session mention与subagent `@label`语义不同，后者不等于续接地址 |
| 成果与Diff | 每完成turn的deliverable cards、Changes双列diff、精确路径/行号 | 读改自有fixture→成果卡→Changes→预览/行号；不存在无条件猜basename链接 | 未找到完整Git提交/推送/PR客户端，不能引用社区发行版说明当官方原生功能 |
| 文件/文档 | 右侧Files层级监听、document viewer与Office/PDF等扩展 | Guide→Files→preview、类型正确呈现、失败与刷新 | 实际具体格式依已装插件与环境，不从包名推导每格式可用 |
| 右侧多内容 | tab、资源地址、pane、fullscreen、floating、per-session owner | 多文件+plan+子对话多tab与分栏、关闭重开、tab标题与当前来源 | 切会话不把原owner丢到新session；输入焦点与命令目标要核对 |
| 用户Terminal | 持久PTY、shell选取、rename、输入takeover、退出保留码、断线重连 | 新tab/折叠继续/关闭结束/重启恢复/失效进程不自动重建 | 用户Terminal权限独立于Agent审批。来源和执行端需清楚 |
| Browser | Desktop `<webview>`保活/原history；Web iframe/apphistory | Guide Browser、URL/回退/refresh/external、失效页恢复 | sidebar预览与Browser Use控制、系统ComputerUse是三项不同能力 |
| Subagent | 页头谱系树、one-shot只读、continuable FIFO、独立Stop、durable usage | 父任务页头后代菜单、嵌套child、右侧打开、独立停止/续接 | 完成绿点只代表最近正常结束；其它inactive失败/取消等尚 grouped |
| Agent Teams | root team、持久mailbox、共享任务DAG/CAS、阻塞/owner/warnings | model协作→team投影及task readiness、消息投递和停止结果 | `writeScopes`是提示前缀而非锁；共享checkout不能代替Friend-Pi隔离worktree |
| Jobs/目标/调度 | 后台job行、两击stop、Goal状态条；Schedule工具与目录/记录 |运行时出现Jobs，goal编辑/暂停/清除；schedule Rules/History/未执行项 | 官方Desktop默认未启用schedule；receipt确认发送不确认模型结果 |
| Memory/压缩原史 | compaction/session query/会话谱系；记忆主要可接第三方MCP | manual压缩/上下文、history与source、Memory MCP配置入口 | 不把MCP接入可能性算内建Reflection/Dream/Expert成长闭环 |
| Skills/MCP/插件 | skill目录和invocable策略；MCP stdio/HTTP、插件配置与动态资源 | Settings/Plugins/catalog/搜索/启停/diagnostic/Creator帮助 | MCP已知限制包括prompt模板/elicitation/tasks/resource订阅等，不是全协议自动支持 |
| Computer Use | 两个需显式启用的实验CuaDriver MCP/native provider | 当前默认安装只观察配置/disabled说明；额外启用需独立环境 | registry只认名称、不为session锁住桌面，GUI测试必须全流程单owner |

固定源依据可直接访问：[官方Desktop](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/apps/desktop/README.md)、[Chat](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-chat/README.zh.md)、[Trajectory](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-trajectory/README.zh.md)、[计划](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-plan/README.md)、[子会话](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/ui-subagent/README.md)、[AgentTeams](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/agent-team.zh.md)、[Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/subsystems/schedule.zh.md)。在线公开入口也核查了官方GitHub页面；本地源文保留更多实现细节。

## ZCode：完整编码工作台，优先借鉴高频链路

本地同3.14.3源包含Desktop、Web共享React UI、终端/后端/Agent；Settings分组是基础、Agent能力、数据与统计，条目含模型、Memory、Subagents、Plugins、MCP、Skills、Commands、Automations、Hooks、Browser、ComputerUse、快捷键、workspace file search、Usage。`SettingsSectionEnabled`仍可能使入口按平台/flags隐藏，实际GUI才决定。

| 研究点 | 官方资料与源码交叉 | Friend-Pi可借鉴之处与当前风险 |
|---|---|---|
| 会话组织 | Grouped/Workspace/Timeline，组颜色与拖动，quick actions、搜索/归档；`WorkspaceSidebar`系列 | 会话多后提供查询、分组、状态与未读；保留顶栏项目，用列表视图切换而非再建重复导航 |
| 文件与Git | 文件树筛选changed-only、Git状态、Add to Chat、预览/OpenWith；Git Graph只读；源码git-graph/actions/branch | 从Diff返回文件或添加具体上下文，用真实变更列表驱动自检和复核 |
| Composer配置 | `V4ComposerModeControls`把Plan作为独立草稿选择、三权限单选；model/reasoning/context usage separate | 配置字段减少歧义，明确当前与下次生效；不要把Plan/Swarm/权限合为不兼容的大枚举 |
| 消息改正 | 官网仅最后user turn可改，running/queue期间禁用；可conversation-only，文件安全可恢复时chat+files | 后续可给误输入“修正并重发”，需Pi branch与文件baseline协议，不能直接覆盖原JSONL |
| Goal/持续工作 | 官网独立回合校验、下一动作、迭代归属、pause/resume/clear及预算停止 | Swarm可在一个运行卡呈现成果→自检→独立复核→返工证据，Task结束与模型措辞分开 |
| 专家入口 | Settings用户/项目/插件子agent、built-in General/Explore、可选model/reasoning/tools；不可编辑插件md可覆模型 | Expert编辑与版本/采用界面可提供catalog层级、工具范围、model独立配置；Friend仍保留客观案例发布门槛 |
| Memory | 官网说明默认off、同项目Markdown/index、后台自动提取与召回；源已出现只读MemorySettingsViewer | Friend已有更强逐条版本/纠正/撤回；把背景学习状态和来源关联做得容易理解。官网“无管理页”与源只读viewer存在差异 |
| Browser | 默认BrowserUse插件与两skills，Desktop内嵌浏览器，preview/元素引用/截图反馈 | 后续若选browser，先解决页owner、用户接管、操作记录、关闭停止与故障恢复；独立安排首批网页旅程 |
| Computer Use | 源NOTICE与`packages/zcode-cua/index.js`明确不可用占位 | UI入口/包名不算系统操作实际能力，应在竞品矩阵记录不可执行边界 |
| Automations | 官网独立项目工作页、Scheduled/Idle、模板/配置/history/sleep skips与返回chat；sourcecurrentsettings/main双路径 | 以后做回访需清晰scope、实际运行receipt、关联会话；先解决当前后台全局前台优先 |
| Remote/Bots/使用率 | SSH/remote control/bot频道、用量按来源/模型、外部工具/hooks | 多为环境/账号依赖；资料覆盖，现场缺环境则未执行，不能成为现阶段必做范围 |
| Pane布局 | sidebar264px起/最大容器50%、像素持久、pointer与keyboard step16；workbenchtab可排序重开；terminal独立下方 | 主聊天与材料的收缩/关闭顺序、tab身份持久与键盘分隔条值得借鉴 |

公开依据：[功能导航](https://zcode.z.ai/en/docs/welcome)、[任务文件](https://zcode.z.ai/en/docs/task-management)、[Goal](https://zcode.z.ai/en/docs/goal)、[改消息](https://zcode.z.ai/en/docs/edit-history)、[子agent](https://zcode.z.ai/en/docs/subagents)、[Memory](https://zcode.z.ai/en/docs/memory)、[自动化](https://zcode.z.ai/en/docs/automations)、[BrowserUse](https://zcode.z.ai/en/docs/browser-use)、[MCP](https://zcode.z.ai/en/docs/mcp-services)。源码依据：[同版源码](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)、[NOTICE](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/NOTICE.md)、`packages/ui/src/settings/settingsPageConfig.ts`、`app-shell/WorkspaceShellLayout.tsx`、`v4/composer/*`。

## 额外同名主题参考：不对应装机 Ocean

搜索Ocean时，检索到了一个独立社区Harness封装中的同名主题。作者说明保留上游Harness Web UI，另加主题、玻璃效果、本地背景/MP4与表层动效；仓库文档给出的运行时是锁定的DSH0.1.0-rc.7和Node22.22.3，版本不等于本机官方DSH0.2.0-rc.2。该仓库与装机 `com.lspjs` Ocean 的身份关系未确认；没有安装或体验这个社区封装，不纳入产品体验份额。可参考表层外观配置与主题token分离的工程方式；用户本次强调浅色布局，壁纸/透明/动效应列可选低优先项目。[作者原始仓库](https://github.com/renjianxin929-ux/deepseek-harness-desktop/tree/405f333b467683bb0e639fa1a1558d5b58dd3d71)

## 建议交给总规划书的优化单位

这些是研究建议，尚未实施，由用户决策。每项需在总书补当前Friend-Pi真实截图、标注的优化后示意，以及竞品真实操作证据。

| 优化单位 | 当前Friend-Pi触发问题 | 参考依据 | 优化后的用户可见链路 | 验收目标 |
|---|---|---|---|---|
| F01 当前事实与来源纠正 | 本轮R01/R02/M03回归：有效约束冲突、无关约束丢失、fork候选复出 | Codex来源水位/记忆diff；Friend自身更严格来源门槛 | 约束卡→出处/版本→更正影响预览→新有效事实/退休事实分开 | 同源多事实只撤回相关一条，冷启动/克隆/再次学习不复出 |
| F02 运行与待处理中心 | 多成员/前后台/暂停需要区分执行与消息已处理 | DSHopenTurn/Jobs/Trajectory，Codexthread/turn分层 | 会话卡状态→当前运行→待审批/队列/成员→停止确认 | 父/成员/后台实际停止与展示一致，不从回复推断完成 |
| F03 Swarm成果审阅闭环 | 任务/成员/复核/返工目前分散在列表 | DSH谱系树/任务投影，CodexChanges/Review，ZCodeGoal摘要 | DAG任务→实际成员记录→成果diff→自检/独立复核→定向返工 | 每个成果、检查、返工有来源及真实workspace；基线变化不误整合 |
| F04 文件与引用一体 | 路径输入/裸Diff让用户来回寻找材料 | DSH`@`file/session与deliverables；ZCodechanged-only/AddtoChat | 文件树/搜索→预览→添加引用→发送→回到结果对应行 | 文件/附件scope明确、断源可解释、一次选择不是偷偷发送 |
| F05 对话长程导航 | 轮次preview已做，缺全局检索与源文返回路径 | CodexCmdF/attention，DSHTrajectory与source，ZCodetask views | 会话搜索→轮次命中→工具/原文→回到当时上下文 | 长会话定位不丢滚动，来源跨同项目会话可达，跨项目隔离 |
| F06 配置scope与生效解释 | default/current/project/plugin配置可能难辨 | CodexSettings/followup，DSHpreset/config read，ZCodescope badges | Settings按基础/Agent/数据分组→scope标签→当前/下次生效说明 | 空闲reload真实成功，运行快照稳定，兼容性错误保留草稿 |
| F07 专家与记忆成长可解释 | 候选、版本、采用、验证证据入口尚偏表单 | ZCodeagentcatalog，Codexmemorytwo-phase，DSHpreset只读 | Expert卡→方法版本diff→适用scope→案例/反例/检查→当前运行采用 | 有限范围客观发布门槛保持，候选补投有idempotent入口 |
| F08 工作台布局与键盘 | 已可拖分栏，模块切换后材料上下文容易丢 | DSH保护中栏算法、ZCodepixels/tabs、Codexcommands | 主聊天稳定；材料tab可重开；source/owner可見；窄屏渐进收缩 | 宽窄窗、键盘分隔条、焦点恢复/退出覆盖，冷启动恢复归属 |
| F09 工具记录与性能诊断 | 知道“调用过”尚不容易核对具体结果 | DSHChat/Trajectory独立视图 | 常规简洁聊天→点击过程→原参数/返回/异常/耗时/来源 | 技术细节按需打开，嵌套tool和异常不遗漏，不把耗时当成功 |
| F10 后台学习与持续任务 | M02跨会话前台优先失败，后台进度/失败线需清晰 | Codexdurableclaims/lease/backoff，DSHJobs/Schedule | 后台面板→等待前台/运行/暂停/失败→显式重试→成果候选 | 全进程前台优先、持久队列无重复未知副作用，重启检查点一致 |
| F11 Terminal/Browser可选扩展 | 首版明确排除这两能力，日常前端验收仍需外部工具 | Codex/DSH/ZCode真实preview与terminal owner边界 | 用户选取后再加入本机终端/本地网页观察、操作全过程回到会话 | 每一模式有独立权限、归属、取消/崩溃/冷启测试；不是只放一个tab |
| F12 Automation/Remote/外观可选 | 当前能力尚需完备，复杂度/依赖会显著扩大 | Codex/DSH/ZCode调度/远端、额外开源主题参考 | 单项由用户选择追加，分别定义调度/机器身份/视觉设置 | 缺环境不显示已完成；表层布局需求与执行能力范围分别评估 |

## 复用建议与版权记录

Codex应优先借鉴协议/状态/存储与公开体验，闭源Desktop布局实现不能从CLI源码复制。DSH优先取纯展示与几何算法的小闭包；直接拷贝一个CordisUI包会带来大量slot/runtime依赖，不符合Pi底座简单化目标。ZCode优先看纯React的设置分组、引用/预览、resize/focus与file状态呈现；共享services/Agent后端不应并入Friend-Pi。拟复制任何代码前，另固定实际文件/commit、有限依赖闭包，保留LICENSE/NOTICE与修改记录，本轮没有复制代码。

详见 `sources.json`（URL/commit/许可/证据等级）与 `capability-inventory.json`（分类与GUI待验证项）。`gui-navigation.zh.md` 是根 Agent 的实际操作清单。产品差异来自已核查源与官方资料，布局观感、性能、焦点可靠性仍需真实Computer Use。
