# 版本化插件协议

公共库是构建时库，各插件包内自足，无跨包共享单例。SQLite 用命名空间、版本 CAS 和短事务协调独立连接；事件必须在事务提交后发出，防止接收者另连接写入造成锁竞争。

Pi EventBus 请求频道 `friend-pi:v1:request`：`{v:1,id,plugin,action,input,origin}`。响应频道 `friend-pi:v1:response`：`{id,result}` 或 `{id,error}`。事件频道 `friend-pi:v1:event`：`{pluginEvent,sessionId,data}`。请求 ID 是 UUID，监听在响应或超时后释放；可选能力短超时，无依赖时退回自身能力。

`PluginContext` 包含项目真实路径的稳定身份、Pi sessionId、来源读取、空闲状态、冻结模型 ID/complete、统一 request/emit 和 appendEntry。来源是 `{sessionId,entryId}`；跨会话来源必须是已登记的同项目 JSONL，缺失或越界拒绝。

| 插件 | 核心 actions |
|---|---|
| Swarm | snapshot/create/start/pause/stop/resume/prepare/integrate/send/shared.read/shared.write |
| Expert | snapshot/create/update/toggle/versions/rollback/select/freeze/use/candidate.submit/validation.suite/validation.run/settings/candidate.withdraw |
| Memory | snapshot/save/search/read/update/toggle/forget/accept/versions/export/learning.run/learning.pause/learning.resume/learning.settings |
| Topic & ReBuild | snapshot/settings/rebuild/history.search/history.read/history.around |

GUI 请求为用户 origin，模型工具为 agent，插件相互请求为 plugin。用户管理权限由控制器判断；origin 不是模型输入字段，模型不能自行提升为用户。方法幂等键还绑定项目和来源摘要，同一键内容变化会冲突。

模型工具名称分别为 `friend_swarm`、`friend_expert`、`friend_memory`、`friend_topic_rebuild`，参数为 `{action,input?}`。原生 `/命令 action JSON`、GUI 与工具均进入相同 dispatch。

Electron Preload 只暴露 request/onEvent。Main 校验顶级 webContents/frame 和方法白名单，SDK 工作进程隔离执行，交互 ID 路由到发起会话。`session.send` 接受 text、attachments、mode=single|swarm、planMode 和 inputMode=steer|followUp；计划范围在执行启动时冻结，执行中切换需先停止。`project.select{projectId}` 切换到该项目最近会话。

当前执行不热卸载插件。空闲 configure 调用公开 reload，然后重新绑定确认／选择／输入等 UI；取消和超时返回未批准。关闭发送 session_shutdown，取消后台任务和成员，未确认副作用不自动重放。
