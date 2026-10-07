# 版本化插件协议

公共库是构建时库，各插件包内自足，无跨包共享单例。SQLite 用命名空间、版本 CAS 和短事务协调独立连接；事件必须在事务提交后发出，防止接收者另连接写入造成锁竞争。

Pi EventBus 请求频道 `friend-pi:v1:request`：`{v:1,id,plugin,action,input,origin}`。响应频道 `friend-pi:v1:response`：`{id,result}` 或 `{id,error}`。事件频道 `friend-pi:v1:event`：`{pluginEvent,sessionId,data}`。请求 ID 是 UUID，监听在响应或超时后释放；可选能力短超时，无依赖时退回自身能力。

`PluginContext` 包含项目真实路径的稳定身份、Pi sessionId、来源读取、空闲状态、冻结模型 ID/思考等级/complete、宿主 agentDir、统一 request/emit 和 appendEntry。SDK 宿主明确声明自己的认证目录，成员与复核继承同一冻结目录；原生 Pi 使用公开默认目录。来源是 `{sessionId,entryId,start?,end?,hash?,factId?}`，start/end 是 UTF-16 半开区间，hash 校验片段。跨会话原文限登记的同项目 JSONL；有效个人记忆仅允许其精确登记片段跨项目回查。删除 tombstone 在来源读取和召回入口生效。

| 插件 | 核心 actions |
|---|---|
| Swarm | snapshot/create/start/pause/stop/resume/prepare/integrate/send/shared.read/shared.write/shared.conflicts/shared.readVersion/rework |
| Expert | snapshot/create/update/toggle/versions/rollback/select/freeze/use/candidate.submit/validation.suite/validation.run/settings/candidate.withdraw |
| Memory | snapshot/save/search/read/update/toggle/forget/accept/versions/export/learning.run/learning.pause/learning.resume/learning.settings/select/usage/invalidation.snapshot/source.deleted |
| Topic & ReBuild | snapshot/settings/rebuild/prepare/history.search/history.read/history.around |

GUI 请求为用户 origin，模型工具为 agent，插件相互请求为 plugin。用户管理权限由控制器判断；origin 不是模型输入字段，模型不能自行提升为用户。方法幂等键还绑定项目和来源摘要，同一键内容变化会冲突。

模型工具名称分别为 `friend_swarm`、`friend_expert`、`friend_memory`、`friend_topic_rebuild`，参数为 `{action,input?}`。原生 `/命令 action JSON`、GUI 与工具均进入相同 dispatch。

Electron Preload 只暴露 request/onEvent。Main 校验顶级 webContents/frame 和方法白名单，SDK 工作进程隔离执行，交互 ID 路由到发起会话。`session.send` 接受 text、attachments、mode=single|swarm、planMode 和 inputMode=steer|followUp；计划范围在执行启动时冻结，执行中切换需先停止。`project.select{projectId}` 切换到该项目最近会话。

`settings.get/update` 管理全局供应商及新会话默认模型、思考等级、插件、协作方式和计划模式；模型、计划与协作默认值用于新会话；插件和 contextMode=native|infinite 在空闲安全边界 reload，忙碌会话显示待生效配置。项目覆盖优先于全局配置，reset 恢复全局。`provider.save` 不要求先创建会话，认证只写入独立数据目录内 Pi 原生存储，响应不包含凭证。供应商修改要求所有会话空闲，再刷新各自运行时。

客户端聊天快照读取 Pi JSONL 当前分支的原生消息 ID，压缩后仍能预览原始轮次；本地书签仅保存来源 ID。SQLite 会话卡保存可重建的型号、状态和配置索引，不复制消息正文。完成状态依据 `agent_settled` 及 Swarm 调度终态；进程中断与冷启动中的未完成执行标记为 interrupted，不自动重放。

当前执行不热卸载插件。空闲 configure 调用公开 reload，然后重新绑定确认／选择／输入等 UI；取消和超时返回未批准。红色关窗只隐藏窗口。明确退出发送 session_shutdown，结束会话、成员和独立学习宿主；持久队列保留阶段，下次启动接续，未确认用户工具副作用不自动重放。

## 本批新增公共边界

- `session.archive{id,archived}` 保留原身份、原史、草稿和成果；归档写入与执行由 Main 守卫拒绝，恢复后继续。`session.delete.preview{id}` 生成一次确认令牌；`session.delete{id,token}` 先持久 tombstone，取消学习和运行时，再清理主/成员/复核原史与独占记录。保留项目代码、原附件和 worktrees；崩溃后从 preparing 标记接续清理，重复确认返回同一删除结果。
- `plan.read/revise/approve/reject` 绑定原生会话、版本、正文 hash、模型、思考和执行方式。模型 `friend_plan` 仅 submit/read，无批准权限。修改生成新版本，旧批准无效。
- `file.tree/read/open` 在项目 realpath 边界内只读；read 支持 offset/line、大文件分段和图片；`git.diff{scope,runId}` 返回文件、行号、增删统计与特殊状态。本轮范围绑定启动基线，基线失效明确拒绝替代。
- `learning.pause/resume/state` 管理单一 Node 串行学习宿主。后台模型冻结于触发快照或指定后台模型；前台开始不会取消后台。缺认证等待配置，不算失败；来源失效与删除独立取消任务。
- Memory 使用收据区分 prepared/context/request-prepared/response-observed/tool-read；原生 custom entries 是可回查采用证据，不推断模型内部因果作用。冷恢复只恢复最后有证据的轮次，不补造旧历史。
- `swarm.shared.changed{v:1,graphId,name,revision,digest}` 仅外层事务提交成功后发出；通知失败不撤销保存。并发写保留基版/新版/稿件，非重叠自动合并，重叠模型协调整合最多两次，矛盾未解暂停。停止收据记录成员/检查/Git/活动终止与未知现场。
