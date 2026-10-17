# 验证记录

本项目区分源码测试、实际 SDK 进程、应用包、真实 Computer Use 和真实模型，不把其中一项替代其他项。

Pi 底座已经两次独立构建，13 个 tarball 字节摘要一致；单独 consumer import、官方 CLI、篡改拒绝均通过。当前固定 SHA 为 `eb326d265ae0b88489a6d10319307780df827cdf`。

针对性测试覆盖 DAG/竞争领取、共享文件 CAS、消息收据、成员失败、工作树与整合隔离、基线变化、检查失败及两轮返工；专家不可变采用、Skill 冻结、验证串行/暂停/前台优先/来源撤回；记忆中文混合词元、来源、跨项目隔离、纠正、冷启动遗忘抑制；ReBuild 原生 JSONL 检查点/压缩采用、失败不推进水位、新增输入、原史回查及组合失效传播。

SDK 集成测试实际 fork Node、加载四插件、执行 Pi 工具、保存 JSONL、完成真实 reload、关联确认与取消、流式停止，并用本地 HTTP Provider 验证模型配置和认证的冷恢复。所有离线回复均属于测试夹具，不代表真实模型。

独立复核另验证结构化工具提交及原始参数类型、说明文字不覆盖结论、提交冲突和取消不采用结果、原生结束边界，以及异步复核请求去重。真实 GUI 曾暴露自由文本复核格式和等待请求超时问题；旧失败报告保留，修复后的候选须重新运行，不能把旧制品的通过项移作新制品证据。

初轮源客户端 Computer Use 已观察打开独立项目、快捷键发送、真实 write 工具完成、记忆保存及纠正至 v2。用户随后要求回到原 Friend 的横向项目顶栏布局，因此旧窗口记录仅为初轮检查，最终候选须重新覆盖宽窄窗口、轮次定位、模式选择、停止、管理工作台及冷重启。

最终可机器读取的报告写在 `.artifacts/qa`，制品及摘要在 `.artifacts/delivery-manifest.json` 和 `.artifacts/packages/manifest.json`。`build-info.json` 记录源码提交、工作区状态及 Pi SHA；它随应用分发。报告中的 `PENDING_USER_AUTH` 表示新数据目录尚未配置真实供应商，不得据此声称真实模型验收通过。

真实模型小批旅程由用户在客户端配置 Key 后显式运行 `node scripts/real-journeys.mjs`；可用 `FRIEND_PI_ROOT` 指向应用 `Contents/Resources/app` 并使用应用内 Node。脚本只操作新建的系统临时 `friend-pi-repair-real-*` 项目，不导入旧 Friend 或 Pi 认证。结果保存至 `.artifacts/qa/real-model-report.json`。

本地交付不做远端发布、npm 发布和签名发行。最终源提交、应用树摘要、压缩包摘要及验证状态应一起查看，未运行项保持明确标记。

## 2026-10-07 修复候选

源码整合阶段已执行 165 项测试全部通过（fake/local HTTP Provider，含实际 Node/Pi 进程）；新后台宿主与生命周期测试分别覆盖串行/前后台并行/检查点/崩溃接续/晚结果失效，以及归档写保护/原史缺失/父子史删除/永久 tombstone/幂等与清理恢复。第一批真实模型已完成 Single、Expert 收据、Memory 纠正和 Swarm 独立复核；连续压缩第一批仅一次采用，保留待补状态，未改写为通过。

以上是施工中的观测，不是最终制品验收。最终候选必须重新构建、完整测试、打包并实际 Computer Use；绑定记录位于 `.artifacts/qa/evolution-candidate-verification.md`、`.artifacts/qa/real-model-report.json` 与 `.artifacts/mac/delivery-manifest.json`。原失败及施工记录保留，最终报告逐项区分通过、未运行和限制。

[实施清单](implementation/2026-10-07/修复清单.md) 和 [18 项前后对比](implementation/2026-10-07/comparison.html) 说明本批范围；第 17 项专家验证界面不扩展。


## 2026-10-08 client workspace candidate

This candidate implements composer Enter/IME boundaries, native tool timeline projection, temporary workspace promotion, persisted project sorting, editable file workbench and independent Node24 terminal host. Focused tests execute production workspace/file/controller paths, native Pi JSONL/tool hooks and real Unix PTY subprocesses; GUI input, scrolling, docking, drafts and sandbox appearance require separate Computer Use evidence. Existing regression cases remain intact. Initial regression runs hit learning/HTTP timeouts. Diagnosis found Pi initialization’s allowModelNetwork:false did not constrain later runtime.refresh() defaults; every local metadata/config refresh now explicitly passes allowNetwork:false. Actual inference calls remain enabled. Target cases and the stable final suite are rechecked on the resulting candidate. Do not combine evidence from intermediate dirty builds with final acceptance.

Final evidence is written outside source in `.artifacts/qa/client-workspace-acceptance.json`, `.artifacts/qa/full-regression-final.log`, and `.artifacts/mac/delivery-manifest.json`, binding exact commit, Pi SHA, dependency lock and artifact hash. Real-model evidence must name the observed configured provider separately from the explicit fake Provider. File tabs/drafts survive in-app workspace/panel switching; save file edits before quitting. Terminal records restore without command replay; explicit stop freezes the owned process tree before termination to prevent TERM handlers spawning surviving children.

Native UI acceptance additionally caught a grid-slot expansion bug and a native HTML drag path that did not commit reordering. The workspace now expands outside its grid slot and reveals selected file tabs. Project sorting now uses synchronous pointer state/capture with a threshold, gap drop targets, continuous edge scrolling and cancelled-click suppression; real window verification must show both order change and unchanged selected project.


The Settings/Model follow-up retains a fixed sidebar footer, adds original-Friend category navigation and a compact effort/model card, and requires saving plus an exact connection test. New tests cover exact model visibility, restore, credential/config invalidation, late network and final-auth CAS races, timeout and secret error sanitization, main no-dispatch/no-workspace guards, managed native input/approval guards, plugin inference and missing-model history. Existing independent SDK tests remain unchanged in policy. All final GUI and real-model evidence must be tied to the resulting packaged candidate, not the earlier development screenshot.

Managed hosts additionally guard Pi public stream/complete request boundaries (including native compaction); automatic cache warming is disabled in managed sessions to avoid inference on history viewing. Independent Pi behavior is unchanged.


## 临时会话子目录与审批

- 新会话使用全局 `defaultWorkspaceDir`（默认 `~/Documents/Friend`）下的独立 UUID 子目录；更改设置后已有会话目录仍可恢复。
- 已移除 `session.promote` 与 GUI 登记入口；原转换回归改为不支持转换和目录设置持久化验证。
- 三种权限策略均验证目录外写入必须显式批准；覆盖 `..`、Pi `@` 前缀、家目录、同前缀兄弟目录、缺失父目录和符号链接（含悬空链接）。
- 临时会话的 shell、后台命令和 Agent 服务输入申请明确批准；等待批准时停止后不启动、不重放。协作宿主检查同样覆盖取消栅栏。权限批准不扩大计划只读或成员角色范围。
- JSONL、数据库和受管执行状态仍使用应用数据目录；记忆导出、共享文件和协作工作树使用会话子目录。审批是工具执行前的用户授权，不是操作系统文件沙箱。

## 2026-10-17 Memory P1–P4 complete build

Branch `codex/memory-p0-20261017` (P0 `4d63158` plus P1–P4 commits). Scope: seven-kind memory, lifecycle/review, Dream v2 with audit/rollback, schema v5/writer 6 migration, intent-aware lexical retrieval with pinned/budget/explain, Memory Center nine-tab Desktop UI, memorybench paired counterfactuals and a v3/v4→v5 migration drill.

Deterministic evidence: memory package 362 tests, topic-rebuild 50, Memory Center UI 44, memorybench 12, migration drill 40 checks, full repository suite and `tsc --noEmit`/build results recorded in `docs/implementation/2026-10-17-memory-p1-p4.md`; artefacts under `.artifacts/qa/memory-bench.json`, `.artifacts/qa/memory-migration-drill.json`, `.artifacts/qa/memory-center-*`. Codex is used for independent cross-acceptance; packaged Computer Use journeys and real-model smoke (with explicitly configured provider only) are recorded separately, and unconfigured real-model runs remain `PENDING_USER_AUTH` rather than passed.
