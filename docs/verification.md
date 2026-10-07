# 验证记录

本项目区分源码测试、实际 SDK 进程、应用包、真实 Computer Use 和真实模型，不把其中一项替代其他项。

Pi 底座已经两次独立构建，13 个 tarball 字节摘要一致；单独 consumer import、官方 CLI、篡改拒绝均通过。当前固定 SHA 为 `eb326d265ae0b88489a6d10319307780df827cdf`。

针对性测试覆盖 DAG/竞争领取、共享文件 CAS、消息收据、成员失败、工作树与整合隔离、基线变化、检查失败及两轮返工；专家不可变采用、Skill 冻结、验证串行/暂停/前台优先/来源撤回；记忆中文混合词元、来源、跨项目隔离、纠正、冷启动遗忘抑制；ReBuild 原生 JSONL 检查点/压缩采用、失败不推进水位、新增输入、原史回查及组合失效传播。

SDK 集成测试实际 fork Node、加载四插件、执行 Pi 工具、保存 JSONL、完成真实 reload、关联确认与取消、流式停止，并用本地 HTTP Provider 验证模型配置和认证的冷恢复。所有离线回复均属于测试夹具，不代表真实模型。

初轮源客户端 Computer Use 已观察打开独立项目、快捷键发送、真实 write 工具完成、记忆保存及纠正至 v2。用户随后要求回到原 Friend 的横向项目顶栏布局，因此旧窗口记录仅为初轮检查，最终候选须重新覆盖宽窄窗口、轮次定位、模式选择、停止、管理工作台及冷重启。

最终可机器读取的报告写在 `.artifacts/qa`，制品及摘要在 `.artifacts/delivery-manifest.json` 和 `.artifacts/packages/manifest.json`。`build-info.json` 记录源码提交、工作区状态及 Pi SHA；它随应用分发。报告中的 `PENDING_USER_AUTH` 表示新数据目录尚未配置真实供应商，不得据此声称真实模型验收通过。

真实模型小批旅程由用户在客户端配置 Key 后显式运行 `node scripts/real-journeys.mjs`；可用 `FRIEND_PI_ROOT` 指向应用 `Contents/Resources/app` 并使用应用内 Node。脚本只操作独立的 `.artifacts/qa/real-workspace`，不导入旧 Friend 或 Pi 认证。结果保存至 `.artifacts/qa/real-model-report.json`。

本地交付不做远端发布、npm 发布和签名发行。最终源提交、应用树摘要、压缩包摘要及验证状态应一起查看，未运行项保持明确标记。
