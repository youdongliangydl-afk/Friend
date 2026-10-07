# @friend-pi/swarm

## 本地安装

```sh
mkdir -p /absolute/path/plugins/swarm
tar -xzf /absolute/path/friend-pi-swarm-VERSION-HASH.tgz -C /absolute/path/plugins/swarm
pi install /absolute/path/plugins/swarm/package
```

Pi 不会自动解包本地 `.tgz`。也可直接安装 `.artifacts/packages/unpacked/swarm/package` 的绝对路径。使用 Node 24 和本项目锁定的 Pi 1.0.4 宿主；Pi/Typebox 为 peer。

独立 Pi Package，使用公开 Pi SDK 创建独立 Node 成员进程及原生 JSONL 会话。安装完整包后加载 `dist/index.js`；成员运行器 `dist/member.js` 随包提供，Pi 作为宿主 peer，不打包进插件。

GUI、`friend_swarm` 工具和 `/swarm` 命令调用同一 `SwarmController`。主要操作：

```text
/swarm create {"goal":"实现登录校验","tasks":[{"id":"implement","title":"实现校验","prompt":"实现并自检","mode":"write","dependencies":[],"writeScopes":["src","test"]}],"checks":[{"command":"npm","args":["test"]}]}
/swarm start {"graphId":"返回的标识"}
/swarm snapshot
/swarm pause {"graphId":"..."}
/swarm resume {"graphId":"...","confirmUnknown":true}
/swarm send {"graphId":"...","to":"implement","body":"补充约束"}
/swarm shared.write {"graphId":"...","name":"接口约定","content":"...","expectedRevision":0}
```

`create` 不带 tasks 时由配置好的模型提出任务图；模型不会被用来伪造完成状态。任务领取使用 SQLite 原子事务；成果版本绑定 attempt。默认并发 4，最多 16；非 Git 写入串行。未提交的 Git 改动会阻止 Swarm 写入，仍可使用 Single 或只读 Swarm。

首次启动从宿主公开 Pi API 继承当前模型与思考等级；明确的启动参数可覆盖。
实际成员和独立复核沿用该冻结快照，停止后的显式接续不会把已有尝试
改写为新的模型或等级。

Git 写入成员使用独立 worktree；依赖成果通过明确的提交应用到下一成员。整合在另一个 worktree 串行进行；客观检查和独立只读成员复核通过后，仅在原基线和工作区仍未变化时执行 fast-forward。复核失败自动返工最多两轮。工作区、会话和失败现场保留。

独立复核使用 Pi 工具 `swarm_review_result` 提交布尔判断和事实说明，助手的自由文本不作为批准结果。宿主在 Pi 真正结束后才采用这次提交；缺少提交、提交冲突、取消或超时均保留成果并暂停。复核成员只开放 read/grep/find/ls 和结果提交工具，客观命令检查由宿主执行。

`prepare` 启动后台复核并立即返回任务图状态；通过 `snapshot` 跟踪进度。重复点击不会同时开启第二次复核。模型回答出现、复核已排队或单个工具完成都不代表任务图已经整合。

消息区分已持久化、已投递和已纳入成员上下文；不将队列接收描述为模型理解。共享材料使用短事务锁、版本 CAS、不可变版本文件和原子写入，模型思考不占锁。停止、进程丢失或会话关闭标记副作用未知；显式接续创建新的 attempt，不重放旧工具。

成员不加载 Swarm 或其他可派生扩展。`tool_call` 对嵌套调用同样检查：read/write/edit 必须在工作区，写入必须在分配范围；只读成员不开放 Bash。写入成员沿用 Pi 高信任 shell，阻止明显目录逃逸并确认破坏性操作。此策略和 worktree 是协作边界，不是完整 OS 或 shell 沙箱。

桌面 SDK 宿主在加载插件前将实际 `dataDir/pi` 配置目录公布为
`FRIEND_PI_AGENT_DIR`。Core 将它冻结到 `PluginContext.agentDir`，Swarm
把同一路径传给执行成员、独立复核及子进程环境。原生 Pi 没有这个 SDK
覆盖时使用公开 `getAgentDir()`，包括 Pi 自身的目录环境覆盖。
使用自定义 `createAgentSession({agentDir})` 的 SDK 宿主也须明确公布该目录；
当前 Pi 扩展上下文不公开 SDK 的认证文件路径，不以私有字段或猜测发现。
只传递目录，不迁移或复制凭据，不输出密钥。`FRIEND_PI_MEMBER_WORKER`
可为宿主指定同协议运行器。

开源参考：Pi 官方 SDK / extensions / subagent 示例（MIT），以及项目根 README 和来源清单所列的调度参考。此包业务实现为 Friend-Pi 新代码，没有复制其他 Agent loop。
