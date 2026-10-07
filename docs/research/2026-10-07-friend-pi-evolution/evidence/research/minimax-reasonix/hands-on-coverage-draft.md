# MiniMax / Reasonix 实际体验覆盖草稿

此表将根 Agent 的原生客户端 AX 截图映射到已有62个功能单位。它是持续更新草稿，不是所有功能执行通过的结论。生成时间：2026-10-07T09:07:47.265Z，最后所读截图时间：2026-10-07T09:04:54.926Z。根 Agent 后续截图增加后需再次核对。

## 已确认与仍未确认

- MiniMax：设置、Memory摘要空页、快捷键、Review配置、Worktree配置、Agent创建表单、手机连接/设备、Sites、Schedule入口已查看。两次新任务发送后没有进入会话，状态ATTEMPTED_UNCONFIRMED；Plugin/Skill/MCP与Sites加载状态记录为LOADING，不猜原因。未取得本轮新任务/工具执行成功证据。
- Reasonix：真实读取README与node--test已通过AllowOnce，工具退出0，测试1pass/0fail，本轮检查通过1项，文件中文预览可见。Stop ask的正在停止→本轮已中断UI边界已确认。
- Reasonix正式Plan：通过添加内容菜单启用，计划与三项审批动作已呈现，最新执行结果已出现host收据：2个文件+2−1、部分统计、检查通过1项，回复2pass/0fail；root另外实际git diff--stat验证文件变化。仅此夹具闭环确认。点击查看差异未观察到面板变化，Diff动作仍未计通过。本草稿没有把计划文字中的未来“2pass”当作已执行。setValue输入/plan发成普通消息属于操作路径记录，不能据此断言CLI或计划模式不支持。
- Reasonix已载入查看的10个设置页：通用、模型偏好、MCP与工具、Skills、子代理、记忆、诊断、快捷键、权限、沙盒。Plugin截图仍loading；导航可见的其他页不能算已打开。

## 判定规则

入口可见≠页面载入≠表单提交≠模型派发≠工具实际执行≠任务完成。配置页查看不算配置保存、连接测试或默认生效成功；空Memory页不证明学习/检索；旧会话不计本轮运行；菜单按钮不算回退/导出/远程执行成功。每个证据文件路径、SHA256和匹配行号均记录在JSON中。

## 功能映射

| ID | 功能单位 | 本轮状态 | 实际观察 | 尚未确认 | AX证据 |
|---|---|---|---|---|---|
| M01 | Coding / Work 两种显示重点 | CONFIG_UI_VIEWED | 通用页呈现编程开发与日常工作两模式控件；本轮未证实切换后完整工作流差异。 | 两个模式内的能力/任务一致性尚未实跑。 | [minimax-settings.txt](../../screenshots/minimax-settings.txt) |
| M02 | 新任务与项目上下文 | ATTEMPTED_UNCONFIRMED | 已添加独立临时项目并从该项目尝试发新任务；root记录两次发送后输入清空，AX仍为首页，无新会话执行证据。 | 未确认任务派发、模型响应、工具读取。不能推测网络或认证原因。 | [minimax-task-dispatch.txt](../../screenshots/minimax-task-dispatch.txt) · [minimax-running.txt](../../screenshots/minimax-running.txt) |
| M03 | 多媒体/文件输入 | ENTRY_OBSERVED | 首页有附件或技能入口；临时文件夹绑定可见。 | 本轮没有实际文件/图片附件处理成功证据。 | [minimax-new-task.txt](../../screenshots/minimax-new-task.txt) |
| M04 | 会话侧栏、分组、搜索 | SESSION_LIST_VIEWED | 已查看项目分组、历史任务入口并打开既有QA任务壳。 | 搜索、置顶、归档/恢复未在当前截图确认执行。历史标题不证明本轮模型请求。 | [minimax-new-task.txt](../../screenshots/minimax-new-task.txt) · [minimax-existing-qa-process.txt](../../screenshots/minimax-existing-qa-process.txt) |
| M05 | 长会话轮次导航 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M06 | 本地 / 云任务与 handoff | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M07 | 引用/选择批注 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M08 | 单条回复反馈 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M09 | Review / Diff 范围 | CONFIG_UI_VIEWED | 已进入代码审查设置，呈现子会话审查方式与自定义长期审查准则。 | 没有新任务diff审查结果或行定位证据。 | [minimax-review-settings.txt](../../screenshots/minimax-review-settings.txt) |
| M10 | 文件与制品预览 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M11 | Changes / Git history | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M12 | Terminal / 执行过程 | ENTRY_OBSERVED | 既有QA会话壳可见进度入口、工作区与浏览器开关。 | 本轮没有新的终端命令执行记录；旧任务壳不计执行成功。 | [minimax-existing-qa-process.txt](../../screenshots/minimax-existing-qa-process.txt) |
| M13 | Goal 跨轮目标 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M14 | Agent Team | ENTRY_OBSERVED | 侧栏呈现Agent团队与已有角色入口。 | 本轮未运行Team，未确认分解、生产、验证或汇总。 | [minimax-new-task.txt](../../screenshots/minimax-new-task.txt) |
| M15 | Custom Agents | FORM_INSPECTED | 已打开创建Agent表单，观察名称、描述、工作目录与图标。 | 没有创建或运行新Agent。 | [minimax-custom-agent.txt](../../screenshots/minimax-custom-agent.txt) |
| M16 | Plugins / Skills / 账户连接 | LOADING | 插件管理已打开，Plugin与Skill显示正在加载。 | 没有列表加载完成、安装/启停/授权/实际工具使用证据；原因未知。 | [minimax-plugin-management.txt](../../screenshots/minimax-plugin-management.txt) · [minimax-mcp-loading.txt](../../screenshots/minimax-mcp-loading.txt) |
| M17 | MCP 配置、测试和工具发现 | LOADING | MCP标签已选择，MCP正在加载，添加服务器 disabled。 | 没有MCP连接、工具发现、test或调用成功证据；不推断网络原因。 | [minimax-mcp-loading.txt](../../screenshots/minimax-mcp-loading.txt) |
| M18 | 全局记忆与主动学习 | UI_VIEWED_EMPTY | 已查看个性化Memory与Proactive Memory开关、打开Memory摘要管理；空摘要0/8000且编辑/保存禁用。 | 没有记忆学习、纠正、编辑保存或删除执行证据。 | [minimax-memory-settings.txt](../../screenshots/minimax-memory-settings.txt) · [minimax-memory-manager.txt](../../screenshots/minimax-memory-manager.txt) |
| M19 | 会话记忆读取 / 生成 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M20 | Browser 工作台 | CONFIG_UI_VIEWED | 通用设置有内置浏览器、普通网页/本地网页打开位置及Agent控制开关；会话壳有Browser开关。 | 未导航网页、未验证多tab、移动模式或Agent操作。 | [minimax-settings.txt](../../screenshots/minimax-settings.txt) · [minimax-existing-qa-process.txt](../../screenshots/minimax-existing-qa-process.txt) |
| M21 | Computer Use | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M22 | Infinite Canvas | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M23 | Mini Apps | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M24 | H3 / H3 Max 与图音视频输出 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M25 | 定时任务 | PAGE_VIEWED | 已打开定时任务页面与新建入口。 | 没有建立、触发、暂停或验证定时执行。 | [minimax-schedules.txt](../../screenshots/minimax-schedules.txt) |
| M26 | 手机 Remote Control | PAGE_VIEWED | 远程控制介绍和连接按钮、设备连接设置已查看。 | 未手机配对、未远程继续任务或审批。 | [minimax-remote.txt](../../screenshots/minimax-remote.txt) · [minimax-connections.txt](../../screenshots/minimax-connections.txt) |
| M27 | IM 通道 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M28 | BYOK 模型 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M29 | 托管模型、API Key 与用量 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M30 | 外观/易读性 | CONFIG_UI_VIEWED | 通用外观、语言和文件换行控制可见。 | 密度/字体/宽度等完整appearance页未实改；不复制暗色样式。 | [minimax-settings.txt](../../screenshots/minimax-settings.txt) |
| M31 | 命令面板、快捷键、Mini Window | CONFIG_UI_VIEWED | 快捷键设置已打开，多动作与全局入口可见。 | 未验证自定义绑定、冲突拒绝或Mini Window执行。 | [minimax-shortcuts.txt](../../screenshots/minimax-shortcuts.txt) |
| M32 | 更新、通知与反馈 | ENTRY_OBSERVED | 通用页显示3.0.68、检查更新和上传日志按钮。 | 未安装更新、未上传诊断/反馈，不能计更新/反馈闭环成功。 | [minimax-settings.txt](../../screenshots/minimax-settings.txt) |
| M33 | 权限呈现 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| M34 | 会话恢复/分叉/回退/队列/侧问 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R01 | 顶部项目/标签、侧栏对话 | LAYOUT_VIEWED | 独立临时项目与会话已打开，导航/输入区/工作区/文件树分隔器及宽度可见。 | 没有本Agent所读截图能证明每个分隔器完成拖动或比例持久化；本轮冷重启未确认。 | [reasonix-new-project.txt](../../screenshots/reasonix-new-project.txt) · [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R02 | 命令面板与会话搜索 | ENTRY_OBSERVED | 导航搜索、命令面板入口可见。 | Cmd+K搜索/筛选/回填没有本轮成功证据。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R03 | 富文本 composer / 附件 / @ / 草稿 | TEXT_SEND_CONFIRMED | 真实只读任务发送、运行与结果呈现可确认；添加内容菜单已打开。 | 图片/目录拖拽、undo、长粘贴、折叠附件未实际验证。 | [reasonix-running.txt](../../screenshots/reasonix-running.txt) · [reasonix-composer-menu.txt](../../screenshots/reasonix-composer-menu.txt) |
| R04 | Plan 与审批姿态 | PLAN_EXECUTION_CONFIRMED_EXAMPLE | 正式Plan经添加内容菜单启用、只读分析、计划审批后执行；最新本轮host收据统计2文件并检查通过1项，回复展示2pass/0fail。root另已实际git diff--stat核对index.js和test.mjs变更与UI一致。 | 仅该subtract夹具闭环确认；修改计划/拒绝/重试/异常/所有Plan组合仍未全测。/plan setValue误操作不能推出CLI不支持。 | [reasonix-composer-menu.txt](../../screenshots/reasonix-composer-menu.txt) · [reasonix-plan-ready.txt](../../screenshots/reasonix-plan-ready.txt) · [reasonix-plan-executing.txt](../../screenshots/reasonix-plan-executing.txt) · [reasonix-plan-execution-check.txt](../../screenshots/reasonix-plan-execution-check.txt) |
| R05 | Goal / 两级 Todo | TODO_UI_OBSERVED | 正式计划场景出现Todo计数与当前步骤。 | 未进入Goal、未验证跨轮自动续行、pause/resume与Goal达成条件。 | [reasonix-plan-ready.txt](../../screenshots/reasonix-plan-ready.txt) · [reasonix-plan-executing.txt](../../screenshots/reasonix-plan-executing.txt) |
| R06 | 流式回复 / 思考 / 工具折叠 | EXECUTION_CONFIRMED_EXAMPLE | 真实Read与Bash在工具过程里呈现耗时、done和exit0；可见思考及聚合工具折叠。 | 只覆盖当前夹具一次Read+test与后续计划；不等于所有工具/流式异常已验证。 | [reasonix-approved-once.txt](../../screenshots/reasonix-approved-once.txt) · [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R07 | 本轮结果收据 / 检查证据 | EXECUTION_CONFIRMED_EXAMPLE | 只读检查与Plan执行均有本轮收据：后者显示2个文件+2−1、部分统计、检查通过1项；root实际git diff--stat与之匹配。 | partial统计不能当作全覆盖；点击查看差异后未观察到面板变化，Diff操作尚不计通过。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) · [reasonix-plan-execution-check.txt](../../screenshots/reasonix-plan-execution-check.txt) · [reasonix-turn-diff.txt](../../screenshots/reasonix-turn-diff.txt) |
| R08 | 文件 tree / 预览 / 编辑 / Diff | FILE_PREVIEW_CONFIRMED | File tree列出夹具文件，选中README显示Markdown中文预览。 | 文件编辑、写入diff、untracked展示仍待后续；实时监听提示不可用，需手动刷新，不推测原因。 | [reasonix-file-tree.txt](../../screenshots/reasonix-file-tree.txt) · [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R09 | Terminal / Browser | ENTRY_OBSERVED | Topicbar有终端按钮，工作区文件页已进入。 | 独立交互终端或Browser执行未证明；Bash工具执行不能冒充交互Terminal体验。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R10 | Checkpoint / rewind / fork / summarize | ENTRY_OBSERVED | 最终回复有从此消息分叉会话入口。 | 未实际rewind/code restore/fork/summarize；旧会话名称含fork不算本轮分叉证据。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R11 | Task monitor | ENTRY_OBSERVED | 会话摘要入口已在topicbar呈现。 | TaskMonitor成员、状态筛选、事件、requeue/open未完成实际核验。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |
| R12 | 子代理 Profile | CONFIG_UI_VIEWED | 子代理设置列出内置Profile及角色描述。 | 未创建、编辑、调用或验证独立子代理执行。 | [reasonix-subagents.txt](../../screenshots/reasonix-subagents.txt) |
| R13 | task / fleet / 并行写入 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R14 | 隔离 worktree 与合并 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R15 | 中断工具恢复 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R16 | Context Center / 指令来源 | ENTRY_OBSERVED | Composer上下文使用量可见；模型偏好页展示压缩阈值与缓存连续性解释。 | Context Center原史来源/压缩/回查未本轮执行；阈值控件不代表压缩已发生。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) · [reasonix-model-preferences.txt](../../screenshots/reasonix-model-preferences.txt) |
| R17 | Memory 管理 | UI_VIEWED_EMPTY | Memory页已载入当前工作区背景记忆、归档、指令、召回、候选标签；当前零背景事实。 | 不验证增改删、来源、版本、跨范围或遗忘；不能用空页确认记忆机制有效。 | [reasonix-memory-loaded.txt](../../screenshots/reasonix-memory-loaded.txt) |
| R18 | 记忆激活 / 冲突 / 召回 | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R19 | 双模型 planner/executor | CONFIG_UI_VIEWED | 模型偏好有独立规划模型、子代理模型及effort默认。 | 正式Plan流程不等于已经用了独立第二模型；默认跟随会话模型可见。 | [reasonix-model-preferences.txt](../../screenshots/reasonix-model-preferences.txt) |
| R20 | Model / Providers / Effort / 能力 | EXECUTION_CONFIRMED_PARTIAL | 当前DeepSeek官方模型通过真实Read+test请求响应；模型偏好与自动effortUI已查看。 | 本轮未编辑URL/APIformat/Key、未测试Fetch/Save/Provider连接应用边界；不证明全部多模态/effort设置。 | [reasonix-approved-once.txt](../../screenshots/reasonix-approved-once.txt) · [reasonix-model-preferences.txt](../../screenshots/reasonix-model-preferences.txt) |
| R21 | 模型统计 / 用量 / 成本与时间预算 | ENTRY_OBSERVED | 运行时token/上下文及设置货币选择可见。 | 未验证全量用量/成本统计、cache命中、预算闸门或成员汇总。 | [reasonix-plan-executing.txt](../../screenshots/reasonix-plan-executing.txt) · [reasonix-settings-loaded.txt](../../screenshots/reasonix-settings-loaded.txt) |
| R22 | MCP / Skills / Plugins | CONFIG_UI_VIEWED_PARTIAL | MCP工具与Skills页面载入；MCP列出已停用服务器且0connected；插件页本次仍loading。 | 未启用连接/实际MCP调用、Skill调用、插件安装；加载原因未知。 | [reasonix-tools.txt](../../screenshots/reasonix-tools.txt) · [reasonix-skills.txt](../../screenshots/reasonix-skills.txt) · [reasonix-plugins.txt](../../screenshots/reasonix-plugins.txt) |
| R23 | Hooks / 自动化 / Diagnostics | CONFIG_UI_VIEWED_PARTIAL | Diagnostics页面已查看。 | Hooks执行或诊断测试触发/修复/上传未证明。 | [reasonix-diagnostics.txt](../../screenshots/reasonix-diagnostics.txt) |
| R24 | Remote SSH / IM Bots | NOT_EXPERIENCED | 仅已有资料/源码研究；本轮所读root截图未给出该功能实际体验证据。 | 不得当作功能不可用，也不得计为执行成功。 | 无本轮截图 |
| R25 | 权限 / 沙盒 / Network | APPROVAL_AND_STOP_UI_CONFIRMED | AllowOnce真实运行node测试，权限和沙盒页已查看；误操作普通/plan请求中的ask被stop，后续UI明确本轮已中断。 | 不等于沙盒平台全部对抗测试、所有进程停止；本次仅证明该ask/turn停止边界。 | [reasonix-approved-once.txt](../../screenshots/reasonix-approved-once.txt) · [reasonix-stop-ask.txt](../../screenshots/reasonix-stop-ask.txt) · [reasonix-plan-running.txt](../../screenshots/reasonix-plan-running.txt) · [reasonix-permissions.txt](../../screenshots/reasonix-permissions.txt) · [reasonix-sandbox.txt](../../screenshots/reasonix-sandbox.txt) |
| R26 | 设置搜索、组、默认/项目作用域 | SETTINGS_NAVIGATION_CONFIRMED | 整页设置、返回工作区、搜索与分组呈现；10个载入设置页已经查看。 | 仅控件可见，未确认搜索筛选、修改保存或每页全部能力；Plugin仍loading不计载入完成。 | [reasonix-settings-loaded.txt](../../screenshots/reasonix-settings-loaded.txt) |
| R27 | 快捷键/外观/存储/更新 | CONFIG_UI_VIEWED_PARTIAL | 快捷键页面载入并列registry来源说明。 | 未改绑/冲突测试；appearance/storage/update页面未本轮完整打开或执行。 | [reasonix-shortcuts.txt](../../screenshots/reasonix-shortcuts.txt) |
| R28 | 会话导出、复制、摘要 | ENTRY_OBSERVED | Topicbar复制、导出、摘要入口可见。 | 未实际导出任何文件或验证全部原始历史覆盖。 | [reasonix-result-and-preview.txt](../../screenshots/reasonix-result-and-preview.txt) |

## 不在原62单位中的补充页面

- MiniMax工作树管理设置：年龄分组与保护提示已查看，删除/刷新未执行。
- MiniMax网站页面：已打开仍加载，没有建站/发布成功证据。

## 后续分阶段推荐

- 阶段 0：**功能完备性闭环**。先处理停止宿主检查、定向返工、自动Expert工具范围、事务后共享事件，再同候选真实验证。 先补原计划缺口，暂不扩大产品面。
- 阶段 1：**日常开发可读性**。本轮结果/Diff含未追踪文件与检查收据、会话状态、模块布局、设置分组搜索与生效边界。 用低复杂度界面帮助用户理解当前事实。
- 阶段 2：**四能力深入**。Swarm任务图/成员来源/定向返工；Expert实际采用版本/领域验证；Memory读取vs学习/纠正影响；ReBuild覆盖与来源。 机制先过证据闭环，再加强可解释UI。
- 阶段 3：**受控恢复与交互**。公开Pi分叉/必要文件工具快照、精准引用、键盘/宽窄布局、密度与正文宽度。 限定可恢复范围，不声称撤销shell等外部效果。
- 阶段 4：**可选扩展**。Browser/交互Terminal/Canvas/Office/Cloud/SSH/IM/定时任务逐项单独立项。 由用户选择，保持简化Friend的核心边界。

这些阶段仅供根规划组织优化点，最终由用户决策；本草稿不修改业务代码、不创建设备连接、定时任务或对外发送。
