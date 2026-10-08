# Friend-Pi

以固定版本 Pi 为执行底座的轻量 macOS 开发客户端。四项能力均为可独立安装的 Pi Package；桌面端使用同一组控制器，不复制 Pi 的 Agent 循环。

## 开始使用

交付的客户端位于 `.artifacts/mac/Friend-Pi.app`。在左下角“设置 → 模型”保存具体型号并测试连接，再选择型号和思考强度；也可从临时会话直接开始。认证由 Pi 存在 Friend-Pi 独立目录，界面和日志不展示 Key。

- 顶栏横向切换项目，左栏选择和重命名会话。
- 无项目也可直接发送，首次发送在全局默认目录 `~/Documents/Friend` 下为会话创建持久子目录；设置可修改默认目录。文件工作台显示当前子目录，目录外修改必须逐次批准。项目栏固定临时入口，支持拖拽／菜单排序、横向滚动及顺序恢复。
- 内嵌终端支持底部／右侧／应用内浮窗、多标签及尺寸恢复；Agent 服务终端的首次用户输入会接管，明确交还后才恢复 Agent 控制。隐藏保留进程，关闭及退出应用会核实清理，重启只恢复记录。
- 会话左侧短线轮次导航支持悬停预览、键盘定位和书签；右上角两个按钮分别控制会话栏与右侧工作台；工作台内部切换文件、Diff、Swarm、Expert、Memory，详细配置在设置。
- 输入框底部切换计划／执行与 Single／Swarm。计划模式使用原生只读探索工具，提交版本化计划；用户批准当前版本后才执行，修改会使旧批准失效。`Enter` 发送，`⌘ Enter`／`Shift Enter` 换行（输入法确认不发送），`⌘ N` 新会话，停止按钮中止执行。
- 文本和图片可作为附件；图片需当前模型支持，单附件上限 10 MiB，文本总量上限 128 KiB。文件页支持按需加载目录树、多文件标签、CodeMirror 编辑与 ⌘S 保存、版本冲突确认，以及 Markdown／图片／隔离 HTML 预览。大文件按 256 KiB 分段只读，其他类型提供系统打开入口。

客户端数据默认为 `~/Library/Application Support/Friend-Pi`；原生插件默认为 `~/.local/share/friend-pi`。可用 `FRIEND_PI_DATA_DIR` 显式指定测试目录。不会导入旧 Friend 或覆盖现有 Pi 配置。

## 从源码构建

要求 macOS arm64、Node 24.15.0 和 npm 11.12.1。首轮安装需网络；后续使用已验证缓存。普通构建不会追踪 Pi main。

```sh
npm run bootstrap
node node_modules/electron/install.js
npm run build
npm run typecheck
npm test
npm start
npm run package:plugins
npm run package:mac
```

Pi 固定为 `eb326d265ae0b88489a6d10319307780df827cdf`（1.0.4）。[底座构建说明](docs/pi-bootstrap.md)记录官方离线构建、完整 tarball 集、模型目录和摘要核验。[打包说明](docs/packaging.md)说明本地安装包和独立运行时。

## 四项能力

| Package | 使用方式 | 保存的业务记录 |
|---|---|---|
| `@friend-pi/swarm` | 任务图、成员、消息、共享材料和成果复核 | DAG、尝试、收据、工作区、客观检查及复核记录 |
| `@friend-pi/expert` | 五类专家、明确采用、编辑版本、验证方法候选 | 不可变版本、内容摘要、采用记录和限域验证结果 |
| `@friend-pi/memory` | 搜索、来源、纠正、停用、遗忘及后台学习 | 自动学习的项目经验、个人偏好、来源版本及抑制记录 |
| `@friend-pi/topic-rebuild` | 自动／手动整理、工作现场和历史回查 | 来源覆盖、水位、现场版本及可重建的历史索引 |

四个本地 `.tgz` 位于 `.artifacts/packages`，需先 `tar -xzf package.tgz -C /absolute/path/unpacked`，再 `pi install /absolute/path/unpacked/package` 安装至已有 Pi，或使用 `pi -e /absolute/path/packages/memory/dist/index.js` 临时加载。使用固定版本 Pi/Node 24；各包声明 Pi 和 TypeBox peers。公共库已打入各插件，不需安装第五个能力插件。

每个插件均提供同名 `/命令` 和 `friend_*` 模型工具：例如 `/memory search {"query":"中文字段"}`，`/expert snapshot`，`/topic-rebuild history.search {"query":"约束"}`。GUI、命令和工具进入同一控制器；用户管理动作不会因为模型声称“用户要求”就被放行。

### Swarm

默认最多四名成员，不递归派生。Git 写入需要干净基线，每名写入成员在独立工作树执行；非 Git 写入串行并要求提供客观检查。原项目有未提交改动时保留它们，提示使用 Single 或先自行处理基线。

成果先进入独立整合工作区，经过成员自检、客观检查和独立审查，再显示“可整合”。通过后再次核对原项目基线并自动整合；变化或冲突会暂停并保留现场。自动返工最多两轮。中断后的未知副作用需先检查保留工作区，再显式接续；不会自动重放工具。

工作树提供协作隔离，不是 OS 沙箱。Pi 仍采用高信任工具模型；关键破坏性操作要求确认。成员范围在工具边界检查，包括嵌套工具参数，shell 写入限制由可识别范围和关键操作确认共同执行。

### Expert 与 Memory

专家身份独立于模型。任务采用的版本、Skill 正文和摘要被冻结；后续修改不改写既有记录。专家方法候选必须通过两个独立适用案例、一个范围外反例及可比的客观 JSON 输出检查，才在本项目中发布文本方法；缺少基准时保持候选，不自动增加脚本、工具或权限。

项目经验与个人偏好全自动学习；明确、有来源的经验原子发布，歧义保持内部待验证。偏好依据用户原话与重复纠正，单次任务要求和附件指令不直接泛化为全局偏好。纠正使用版本检查，立即失效旧派生结果；遗忘保留抑制信息，防止冷启动重新学习相同错误。长期记忆以 SQLite 为权威，Markdown 为导出。中文检索使用 FTS5 词元和短查询回退，不引入向量数据库。

Reflection、Dream、Distill 由一个独立 Node 宿主和持久队列串行运行，前台可同时工作。模型继承触发会话快照或设置指定值。关闭窗口仅隐藏，后台继续；⌘Q/菜单退出保存进度并结束进程，下次启动接续。可在设置中暂停，缺模型配置等待，普通失败最多三次。专家方法仍须客观验证。

### Topic & ReBuild

默认使用 Pi 原生压缩，不替换其触发和保存流程。仅在设置开启“无限上下文”时，结合有效历史记忆生成保留片段与上下文摘要；后台只准备草稿，前台压缩钩子校验与采用，保留内容不回写长期记忆。

Pi JSONL 是原始历史的唯一来源。工作现场绑定原文 ID 和覆盖范围，仅在 Pi 实际保存检查点或压缩条目后采用新水位。整理期间新增输入仍保留为原文。Topic 隐式参与选材，不出现在必须由用户管理的标签流程中。

记忆纠正或遗忘会失效相关派生现场；下一安全边界重建。失败、取消或预算不足保留旧有效现场并退回 Pi 原生压缩，不重放工具。所谓长任务承接是保留约束、现场和可回查原文，模型窗口仍然有限。

## 架构、验证与来源

```text
Electron / React 客户端
└─ Preload 与 Main：原生窗口、文件交互、请求路由
   └─ 独立 Node Pi SDK 会话进程
      ├─ Pi 模型、工具、认证、JSONL 会话和原生压缩
      ├─ 四插件控制器与版本化请求／事件
      └─ Swarm 独立成员 Node 进程与工作区
```

插件开关在空闲后执行真实 reload 并重绑交互。任务结束依据 Pi `agent_settled` 和 Swarm 调度状态。SQLite 只存业务数据、会话路径和索引，不另存聊天正文。

[使用说明](docs/user-guide.md)、[公共协议](docs/contracts.md)、[验证报告](docs/verification.md)与 `.artifacts/delivery-manifest.json` 分别记录用法、接口、实际测试和候选摘要。离线测试 Provider 仅在显式 `FRIEND_PI_TEST_PROVIDER=1` 时启用，并在界面标注“非真实服务”，其结果不代表真实模型质量。

感谢 [Pi](https://github.com/earendil-works/pi)、[pi-gui](https://github.com/minghinmatthewlam/pi-gui)、[DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness)、[pi-subagents](https://github.com/tintinweb/pi-subagents)、[pi-agent-orchestrator](https://github.com/GroepOnline/pi-agent-orchestrator)、[MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)、[Mem0](https://github.com/mem0ai/mem0)、[MiniMax Code](https://github.com/MiniMax-AI/minimax-code)、[ZCode](https://github.com/zai-org/ZCode) 和 [Codex](https://github.com/openai/codex) 的公开实现。固定来源、复用边界、版权和许可证见 [第三方说明](THIRD_PARTY_NOTICES.md)及各插件 `SOURCES.md`。README 致谢不代替原许可证。

本版本只交付本地源码和 macOS 应用，不创建远端、不发布 npm、不执行证书签名发行或公证。ARM64 应用使用本地 ad-hoc 代码签名满足系统的可执行要求，不具有发布证书身份。

## 完备性核验与后续演进

2026-10-07 的独立核验重跑原95项测试与制品检查通过，但另确认13项需求缺口，当前不能声明首版全部功能完备。详情、竞品逐项体验范围及19个带前后对比图的优化点见 [后续演进规划书](docs/research/2026-10-07-friend-pi-evolution/规划书.md)与[可交互决策稿](docs/research/2026-10-07-friend-pi-evolution/index.html)。统一轻量工作台是用户已确定的方向；修复前的研究记录作为历史快照保留；本批已按新的实施计划落地，逐项实施边界和前后示意见 [修复清单](docs/implementation/2026-10-07/修复清单.md)、[产品对比图](docs/implementation/2026-10-07/comparison.html)。最终候选的真实模型、桌面操作与制品摘要以本批验证报告为准。
