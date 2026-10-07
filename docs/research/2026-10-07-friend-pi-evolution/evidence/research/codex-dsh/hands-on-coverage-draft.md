# Codex / DSH / ZCode：资料与真实入口混合覆盖稿

这是持续更新草稿，不是全部功能已体验的结论。GUI操作全部由根 Agent 执行；本 Agent 只读检视留存AX快照与直接父消息，不操作客户端、不读凭证。

## 本轮明确结论

- **Codex全部本轮Desktop GUI为 BLOCKED_SELF_APP**：根 Agent 的CUA请求对 `com.openai.codex` 返回安全拒绝；不绕过。用户给定Codex图片只支持局部轮次划线/预览/书签布局，不代表完整新GUI体验。24项仅有官方文档/开源backend线索。
- **DSH已有实际执行**：`dsh-command-output.txt` 明确展开命令tool output，tests 1 / pass 1 / fail 0 / EXIT=0，且Chat显示已结束8秒。初始充值提醒被跳过，现有账号路线真的能执行，不应仍写成“完全缺Key阻塞”。
- **DSH计划链路具体夹具 RESULT_VERIFIED**：pending审批、右侧全文tab已观察，根 Agent 点击同意后完成1分43秒；根随后独立读取磁盘/Git diff并用Node24重跑，exit0/tests2/pass2/fail0，实际仅index.js/test.mjs发生+2/-1，scopeMatched=true。仅这个subtract夹具与同意执行happy path通过；拒绝/取消/复合计划/崩溃恢复等未验证。
- **DSH Trajectory专门视图未运行**：General的代码工作视图off，未改用户设置。`dsh-trajectory.txt`仍是Chat；`dsh-file-linked-preview.txt`仍选中Start，没有README预览tab，名称只反映尝试，不能计成功。
- **ZCode可查看管理页，但模型执行未测试**：跳过登录后查看现有页面，provider未就绪/未连接，没有迁移API Key。当前快照支持12个独立页标题（11个其他管理页 + 电脑控制）；仅按钮/开关/列表可观察，不计真实生成、浏览器控制或MCP调用。
- **ZCode Computer Use只有UI观察**：开关off、composer按钮禁用，结合固定源placeholder说明；未开启、未系统操作，不能从UI存在推断执行能力。
- **装机Ocean身份不确定**：`com.lspjs` v1.18.10 与社区Harness同名主题未确认对应。从主产品/体验矩阵排除；社区主题留为额外开源参考。
- **DSH 两只读成员具体旅程 PROCESS_VERIFIED**：父会话实际完成1分15秒，页头2个子智能体、成员目录2项均完成且显示可继续（7秒/10秒）；根实际点击README成员“在侧边栏打开”，右tab选中其原始请求/结果，显示Custom模式、中文第3行原文和行数3。续接/独立停止、另一成员原文、并发写入/隔离/合并/异常均未跑；只读委派和Custom标签不证明OS权限限制，独立磁盘检查待补。

## 每项能力分层

状态按每项实际保留证据判定。即使某类达到RESULT_VISIBLE，也只覆盖列出的最小旅程，不代表该类所有异常/组合已测。JSON保留source IDs、实际入口、操作过程、结果、受限与NOT_RUN字段。

### CODEX

| ID / 能力 | 本轮状态 | 实际入口 / 过程 / 结果 | 证据 |
|---|---|---|---|
| codex-01 项目/聊天/来源组织、置顶/未读/归档/分组 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-02 全局命令、会话全文/文件搜索、注意力导航 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-03 Local/Worktree/Cloud身份、branch与Handoff | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-04 模型/思考/plan/permissions/本次与草稿 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-05 文件/图片/目录与现有browser上下文 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-06 流式、工具、turn settled、成功/异常/等待审批 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-07 运行中修正/下一轮排队/待发编辑 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-08 停止确认、fork/resume与冷历史 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-09 确认/选择/输入与取消/迟到响应 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-10 轮次预览/书签/消息操作 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-11 changed files/Diff/行评论/审查/checks | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-12 文本/Markdown/图像/HTML/Office/PDF预览与source/annotation | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-13 per-chat current project/worktree终端 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-14 内嵌browser、现有用户浏览器extension、local page反馈 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-15 模型spawn/followup/message/list/interrupt/wait | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-16 自定义agent、Skills目录、指令/模型/工具选择 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-17 MCP/Apps/Plugins来源与启停、tools/UI资源 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-18 local memory read/contribute、全局后台二阶段 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-19 native compact/recap、自动阈值/原rollout | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-20 持续目标、单独schedule与同chat回访/历史 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-21 远端host/project与Cloud environment | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-22 General/shortcuts/notifications/appearance/browser/personalization/account | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-23 键盘focus/Escape、分栏/宽窄窗、字体、模块归属 | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| codex-24 voice/imagegen/computer-use/pets/Space/dots/CodeReview | BLOCKED_SELF_APP | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |

### DSH

| ID / 能力 | 本轮状态 | 实际入口 / 过程 / 结果 | 证据 |
|---|---|---|---|
| dsh-01 workspace与session列表、置顶/归档/new/default workspace | ENTRY_OBSERVED | Workspace/session navigation and selected running test session；Root reports owned project opened; archive/pin/search/new-default flows NOT_RUN；Selected dsh workspace plus one session visible | [dsh-home](../../screenshots/dsh-home.txt)、[dsh-real-dispatch](../../screenshots/dsh-real-dispatch.txt) |
| dsh-02 三栏、右pane/tab/fullscreen/floating、中心优先压缩 | PARTIAL_PROCESS_OBSERVED | Right workbench guide and plan tab, sidebar and main conversation；Actual plan tab shown alongside chat；Full plan content visible; drag/resize/fullscreen/floating/cold layout NOT_RUN | [dsh-workbench](../../screenshots/dsh-workbench.txt)、[dsh-plan-ready](../../screenshots/dsh-plan-ready.txt) |
| dsh-03 DeepSeek/自定义provider/模型输入能力/思考 | ENTRY_PLUS_MODEL_ROUTE_EXECUTED | Models page and active DeepSeek-V41-Flash High route；Existing account route sent actual request; no key copied/edited；One test tool run completed; provider configuration save/test flows NOT_RUN | [dsh-models](../../screenshots/dsh-models.txt)、[dsh-command-output](../../screenshots/dsh-command-output.txt) |
| dsh-04 Standard/Creator/PTC/Minimal/custom与readonly YAML | ENTRY_OBSERVED | Preset grouped cards observed；No default or preset change verified；Creation/config viewer/custom runtime NOT_RUN | [dsh-presets](../../screenshots/dsh-presets.txt) |
| dsh-05 访问preset、sandbox与审批范围 | ENTRY_OBSERVED | Workspace-write current access/default modes visible；No permission change or denied side-effect test；Enforcement NOT_RUN | [dsh-home](../../screenshots/dsh-home.txt)、[dsh-general](../../screenshots/dsh-general.txt) |
| dsh-06 /plan进入、composer关闭、正文审批/历史artifact | RESULT_VERIFIED | Plan menu/composer entry, pending review and selected right full-text plan；Root clicked Agree to execute; actual implementation ran and completed 1m43s；Root independent Node24 rerun exit0/tests2/pass2/fail0; Git diff only index.js/test.mjs +2/-1, scopeMatched true; one fixture only | [dsh-plan-toggle](../../screenshots/dsh-plan-toggle.txt)、[dsh-plan-ready](../../screenshots/dsh-plan-ready.txt)、[dsh-plan-execution-result](../../screenshots/dsh-plan-execution-result.txt)、[独立磁盘/测试复验](../../competitor-independent-results.json) |
| dsh-07 Chat最终答案与工作过程/思考显隐 | RESULT_VISIBLE_ONE_JOURNEY | Running turn then finished 8s; expanded Chat process；Actual model read README and invoked command；Direct expanded tool output tests1/pass1/fail0/EXIT=0; not all streaming failure/approval paths | [dsh-real-dispatch](../../screenshots/dsh-real-dispatch.txt)、[dsh-tool-details](../../screenshots/dsh-tool-details.txt)、[dsh-command-output](../../screenshots/dsh-command-output.txt) |
| dsh-08 运行中steer、队列、composer takeover/Stop | ENTRY_OBSERVED | Busy send preference Queue visible；No running followup/queue edit/cancel verified；NOT_RUN | [dsh-general](../../screenshots/dsh-general.txt) |
| dsh-09 timeline/records、tool input/output/error/timing/TTFT/token | BLOCKED_SETTING_CODE_VIEWS_OFF | Code-work views switch off; ordinary Chat still visible；Dedicated Trajectory not entered; root did not change user setting；No Trajectory table/timeline/TTFT inspection proven | [dsh-general](../../screenshots/dsh-general.txt)、[dsh-trajectory](../../screenshots/dsh-trajectory.txt) |
| dsh-10 @file/folder/session，/skill/command | ENTRY_OBSERVED | README links and @ prompt affordance visible；No file/folder/session autocomplete pick or successful linked preview proven；NOT_RUN | [dsh-command-output](../../screenshots/dsh-command-output.txt)、[dsh-file-linked-preview](../../screenshots/dsh-file-linked-preview.txt) |
| dsh-11 persistent普通文件/图像/历史lightbox | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| dsh-12 文件cards/Changes双列Diff/精确path#line | ARTIFACT_VERIFIED_DIFF_UI_NOT_RUN | Result reply includes index.js/test.mjs entry buttons and plan artifact；Actual owned files changed, independently checked by root; dedicated Changes UI not selected；Git diff scope matched two files +2/-1 and independent tests passed; visual Diff/source/file-preview navigation NOT_RUN | [dsh-plan-execution-result](../../screenshots/dsh-plan-execution-result.txt)、[独立磁盘/测试复验](../../competitor-independent-results.json) |
| dsh-13 文件树监听+document viewer/格式资源 | ATTEMPT_NO_PREVIEW_PROVEN | Workspace Files and README link available; Start tab remains selected；A linked preview attempt is named, but selected file/doc pane not observed；NOT_RUN_SUCCESS | [dsh-file-linked-preview](../../screenshots/dsh-file-linked-preview.txt)、[dsh-workbench](../../screenshots/dsh-workbench.txt) |
| dsh-14 shell列表/PTY/rename/takeover/exitcode/reconnect | ENTRY_OBSERVED | New Terminal and shell selector guide available；No user-terminal process started in current evidence；NOT_RUN | [dsh-workbench](../../screenshots/dsh-workbench.txt) |
| dsh-15 Desktop webview/保活/history；Webiframe | ENTRY_OBSERVED | Browser guide entry available；No browser tab navigation/tool action verified；NOT_RUN | [dsh-workbench](../../screenshots/dsh-workbench.txt) |
| dsh-16 model自动控制provider+Session所有权 | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| dsh-17 页头谱系目录、one-shot/continuable、独立Stop/token/time | PROCESS_VERIFIED_TWO_READONLY_CHILDREN | Parent header 2-child catalog, two completed continuable members, README child selected original in right tab；Root delegated README line3 and index.js subtract-definition readonly tasks; opened lineage list and clicked Open in sidebar for README child；Parent finished 1m15s; child catalog shows 7s/10s; native child original visible with Custom access, Chinese line3 and line count3; independent no-write/filesystem check pending root | [dsh-subagents-current](../../screenshots/dsh-subagents-current.txt)、[dsh-subagent-lineage](../../screenshots/dsh-subagent-lineage.txt)、[dsh-subagent-original](../../screenshots/dsh-subagent-original.txt) |
| dsh-18 持久成员mailbox与任务DAG/CAS/依赖/owner | DOCS_ONLY | Some plugin inventory visible but no Team DAG/member UI；Team delegation/messages/claims NOT_RUN；NOT_RUN | [dsh-builtins](../../screenshots/dsh-builtins.txt) |
| dsh-19 后台job行、输出/progress、two-click stop | ENTRY_IN_PLUGIN_INVENTORY | tool-jobs listed enabled；No durable background job creation/output/kill observed；NOT_RUN | [dsh-builtins](../../screenshots/dsh-builtins.txt) |
| dsh-20 Goal控制与Schedule规则/history/deliveryreceipt | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| dsh-21 nativecompaction/source/sessionQuery/谱系 | PARTIAL_PROCESS_VERIFIED | Subagent lineage and one child original conversation actually open; compaction packages/context-usage entry also visible；Actual readonly child-source navigation; native compaction/sessionQuery/search/rebuild NOT_RUN；README child request/result visible; cannot generalize to all historical lookup or compacted-source recovery | [dsh-subagent-lineage](../../screenshots/dsh-subagent-lineage.txt)、[dsh-subagent-original](../../screenshots/dsh-subagent-original.txt)、[dsh-builtins](../../screenshots/dsh-builtins.txt) |
| dsh-22 thirdparty MCPmemory与通用Skills/MCP | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| dsh-23 插件管理/install/enable/diagnostic/config schema/Creator | ENTRY_OBSERVED | Builtin session/global plugin list and presets visible；No install/disable/reload/Creator generated package；NOT_RUN | [dsh-builtins](../../screenshots/dsh-builtins.txt)、[dsh-presets](../../screenshots/dsh-presets.txt) |
| dsh-24 CuaDriver MCP/native实验提供方需启用 | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |
| dsh-25 General/model/loop/subagent/websearch/shell/shortcuts/sessionlog/account | ENTRY_OBSERVED | General/model/builtins/preset controls and installed 0.2.0-rc.2 visible；Read-only opening pages；No setting persistence mutation, no all plugin-config forms tested | [dsh-general](../../screenshots/dsh-general.txt)、[dsh-models](../../screenshots/dsh-models.txt)、[dsh-builtins](../../screenshots/dsh-builtins.txt)、[dsh-presets](../../screenshots/dsh-presets.txt) |
| dsh-26 SSH/Webhost/desktopauth/nativefolder/updates | DOCS_ONLY | NOT_RUN；NOT_RUN | 官方文档/固定源码；无本轮GUI |

### ZCODE

| ID / 能力 | 本轮状态 | 实际入口 / 过程 / 结果 | 证据 |
|---|---|---|---|
| zcode-01 workspace tabs、Group/Workspace/Timeline/quickactions | PARTIAL_ENTRY_OBSERVED | Project/group view and command palette visible; no project open；No new runtime project/task creation verified；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt) |
| zcode-02 scratch/local/SSH/remote/bot/channel | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-03 changed-only tree/状态/AddToChat/preview/OpenWith/GitGraph | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-04 Plan独立、Ask/Edit/Full权限、模型/思考 | ENTRY_OBSERVED_LIMITED | Composer present, manage-model disabled, provider not ready/unconnected；No mode/model selection dispatch；BLOCKED_UNCONFIGURED_MODEL | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-05 文件/image/网页元素/代码comment上下文 | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-06 运行中排队、消息queue编辑/取消、停止/恢复 | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-07 仅最新userturn编辑、conditional chat+filesreset | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-08 持续目标、每轮独立校验、摘要迭代/暂停 | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-09 toolcards/trajectory/summary/contextusage/compact | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-10 文本/图片/HTML/Office/materials/workbenchtabs | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-11 linecomments/selectionsidechat/gitdiff/source | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-12 defaultBrowserUse+twoSkills/内嵌visiblecontrol | ENTRY_OBSERVED_EXECUTION_BLOCKED | Browser control currently on; import/cache/clear controls visible；No browser operation or import/reset invoked；BLOCKED_UNCONFIGURED_MODEL | [zcode-browser-control](../../screenshots/zcode-browser-control.txt) |
| zcode-13 独立底部terminal与sidepaneTerminal | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-14 built-in general/Explore/custom user/project/plugin;model/tools | ENTRY_OBSERVED_EXECUTION_BLOCKED | User list empty; built-in General/Explore and inherit-default controls visible；No spawn, custom create/model override；BLOCKED_UNCONFIGURED_MODEL | [zcode-subagents](../../screenshots/zcode-subagents.txt) |
| zcode-15 projectMarkdown/index、后台提取/召回、source只读viewer | ENTRY_OBSERVED_EXECUTION_BLOCKED | Workspace Memory existing switch on, no saved workspaces memories visible；No extraction/recall/forget/edit executed；BLOCKED_UNCONFIGURED_MODEL | [zcode-memory](../../screenshots/zcode-memory.txt) |
| zcode-16 source组/user-workspace/stdioHTTPsse/OAuth/formJSON | ENTRY_OBSERVED_EXECUTION_NOT_RUN | MCP management page and installed-zero state；No configured server added/authenticated/invoked；NOT_RUN | [zcode-mcp](../../screenshots/zcode-mcp.txt) |
| zcode-17 plugin/components/Skillcatalog/Command/Hooks/source | ENTRY_OBSERVED_EXECUTION_NOT_RUN | Plugin/skill/command/hook pages, current catalogs and groups visible；No mutation, installation, lifecycle hook or skill invocation；NOT_RUN | [zcode-plugins](../../screenshots/zcode-plugins.txt)、[zcode-skills](../../screenshots/zcode-skills.txt)、[zcode-commands](../../screenshots/zcode-commands.txt)、[zcode-hooks](../../screenshots/zcode-hooks.txt) |
| zcode-18 scheduled/idle任务+template/config/history/keepawake | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-19 account/provider/model/时间消费与balance | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-20 基础/Agent能力/数据统计的scope分组 | ENTRY_OBSERVED | Twelve preserved distinct management page titles including Computer Use; count method listed separately；Root navigated visible settings; no credentials transferred；Scope/default descriptions observed, not all forms applied or operationally tested | [zcode-settings](../../screenshots/zcode-settings.txt)、[zcode-appearance](../../screenshots/zcode-appearance.txt)、[zcode-shortcuts](../../screenshots/zcode-shortcuts.txt)、[zcode-browser-control](../../screenshots/zcode-browser-control.txt)、[zcode-computer-use](../../screenshots/zcode-computer-use.txt)、[zcode-memory](../../screenshots/zcode-memory.txt)、[zcode-subagents](../../screenshots/zcode-subagents.txt)、[zcode-plugins](../../screenshots/zcode-plugins.txt)、[zcode-mcp](../../screenshots/zcode-mcp.txt)、[zcode-skills](../../screenshots/zcode-skills.txt)、[zcode-commands](../../screenshots/zcode-commands.txt)、[zcode-hooks](../../screenshots/zcode-hooks.txt) |
| zcode-21 sidebar264min/pixelpersist/16pxkey、responsivepane | PARTIAL_ENTRY_OBSERVED | Appearance settings, keyboard bindings and command-palette entry visible；No owned resize/keyboard-remap/cold-resume workflow verified；NOT_RUN | [zcode-appearance](../../screenshots/zcode-appearance.txt)、[zcode-shortcuts](../../screenshots/zcode-shortcuts.txt)、[zcode-home](../../screenshots/zcode-home.txt) |
| zcode-22 desktop computerUse菜单但包为unavailableplaceholder | UI_OFF_AND_SOURCE_PLACEHOLDER | Computer Use off; composer operation control disabled；No enable or system operation attempted；Pinned source NOTICE says unavailable stub; installed runtime execution not tested | [zcode-computer-use](../../screenshots/zcode-computer-use.txt) |
| zcode-23 带源码引用的repo架构wiki | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |
| zcode-24 Bot/remotecontrol/SSH/ADE/offpeak/feedback/onboarding | NOT_RUN_CONDITION_LIMITED | NOT_RUN；NOT_RUN | [zcode-home](../../screenshots/zcode-home.txt)、[zcode-settings](../../screenshots/zcode-settings.txt) |

## 未覆盖与追加证据

DSH：专门Trajectory、代码差异视图、真实文件预览、用户terminal、browser、Team、child实际续接/独立停止、运行时followup/queue/stop、持久goal/schedule、压缩/历史query、完整插件install/reload/CRUD，仍未验证。两只读child完成/谱系列表/README原会话打开是已验证的具体过程，不覆盖全部子agent组合。根 Agent 后续追加证据时只升级相关条目的实际子流程。

ZCode：源与入口覆盖充分，真实模型/目标/文件编辑/记忆提取/多agent/网页自动化/自动化/远端等均未运行。无需为了形成“全部体验”迁移用户凭证或连接新账号。

所有CodexGUI条目继续保持安全阻塞，用户局部参考截图单独列layout reference。研究报告74条主产品能力清单不等于74条实际运行成功。
