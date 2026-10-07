# 第 19 点补充：当前会话的 Memory / Expert 证据边界

核对候选：Friend-Pi `5ec4b39fb7301ac57715976458f602909fc0a0fb`；Pi `eb326d265ae0b88489a6d10319307780df827cdf`。本稿为只读源码核实与最小接口建议，未修改产品、未读取凭证、未新增 GUI / 真实模型验收。

**结论：Memory 尚无可支撑“本会话已提供给模型的记忆”的专门 receipt；Expert 已保存冻结版本与 selected/use 记录，但当前页面仍展示专家库的最新定义。第 19 点需要补充记录与页面投影，不能只把已有库列表换一个标题。**

## 现在能证明什么

| 路径 | 已有证据 | 不能据此宣称 |
|---|---|---|
| Memory 库与 GUI | `snapshot` 返回项目及个人范围的 memories/candidates、学习任务和派生关系；MemoryPanel 展示库、搜索、纠正、候选、后台学习。 | 这些记忆被当前会话或本轮模型调用采用。 |
| 模型调用 `friend_memory search/read` | controller 返回 id/revision/fingerprint/source 等真实记录；通过模型工具调用时，Pi 会保存原生 toolResult；GUI 查看同一 controller 不等于模型读取。 | 独立的 request/run 级注入清单、预算、排除理由；模型因果上使用了某条记忆。 |
| ReBuild 自动召回 | 每次 `context` 按最近用户目标检索，最多取 4 条有效记忆，各截 1000 字符，总计上限 3000 **字符**；临时消息带 id/revision。 | token 实测预算，或本轮冻结快照。当前每次调用重新检索，可以在同一逻辑执行中读到新版本。 |
| ReBuild 注入保存 | context hook 返回 `friend-pi:memory-recall:v1` 临时 custom message，没有 `appendEntry`；工作现场的 `memoryRefs` 初始化始终为 `[]`。Pi 的 context transform 与会话 message_end 持久化是不同路径。 | 临时注入已落入 JSONL、真实请求已发送、能够冷启动恢复“当时用了哪些”。 |
| Expert 实际版本 | `before_agent_start` 冻结方法/Skill，原生 JSONL 保存 `friend-pi.expert.run`；明确选择保存 `adoption mode=selected`，工具 `use` 保存 `mode=use` 与 version/hash。自动目录冻结不记录“每个专家都采用”。 | 所选专家必然导致某个回答；目录中全部专家都实际采用；selected 已代表 HTTP 请求成功发送。 |
| Expert GUI 与身份 | `snapshot.adoptions` 当前返回 `run:<sessionId>` 的 FrozenRun 指针；ExpertPanel 读的是 `experts`/`selection`，未展示此冻结记录。Expert 自建 run UUID，桌面 worker 另建 run UUID。 | 最新专家库版本就是当前执行版本；两套 UUID 已能可靠对应。 |

定位：[Memory 类型/库](</Users/youdongliang/Desktop/Friend-Pi/packages/memory/src/index.ts:12>)、[检索](</Users/youdongliang/Desktop/Friend-Pi/packages/memory/src/index.ts:179>)、[snapshot/read](</Users/youdongliang/Desktop/Friend-Pi/packages/memory/src/index.ts:355>)；[ReBuild recall](</Users/youdongliang/Desktop/Friend-Pi/packages/topic-rebuild/src/index.ts:382>)、[context 注入](</Users/youdongliang/Desktop/Friend-Pi/packages/topic-rebuild/src/index.ts:467>)、[空 memoryRefs](</Users/youdongliang/Desktop/Friend-Pi/packages/topic-rebuild/src/index.ts:194>)；[Expert 冻结与记录](</Users/youdongliang/Desktop/Friend-Pi/packages/expert/src/index.ts:66>)、[工具 use](</Users/youdongliang/Desktop/Friend-Pi/packages/expert/src/index.ts:109>)、[systemPrompt 绑定](</Users/youdongliang/Desktop/Friend-Pi/packages/expert/src/index.ts:214>)；[Memory 页面](</Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:109>)、[Expert 页面](</Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:89>)、[桌面 runId](</Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:161>)。

## 最小 contract 建议

1. **复用四插件和普通 contracts/runtime 库。** Core 提供同一逻辑执行身份与原生条目关联方式；Memory 负责其记录，ReBuild 在调用 Memory 召回时上报实际选材结果，Expert 暴露既有冻结/adoption 投影。通过版本化请求/事件协作，不增加第五插件。原生 Pi CLI 没有桌面 UUID 时也生成有效身份，不能强依赖桌面 worker。
2. **原生 Pi JSONL 是 receipt 的原始来源。** 增加版本化 custom entry，例如 `friend-pi.memory.context-receipt:v1`，经公开 `pi.appendEntry` 写入；SQLite 只做可重建索引。绑定 canonical entry ID，并处理保存失败：没有成功保存不宣称 adopted。receipt 不复制一份聊天历史；保留片段摘要与来源定位，必要的历史原文沿 Pi 查询。
3. **最少字段。** `receiptId/operationId`（幂等）、`projectId/sessionId/branchParentEntryId`、`logicalRunId/requestOrdinal/toolCallId?`、`channel`（`context-recall` / `model-tool` / `user-view`）、`memoryId/revision/scope/kind`、`recordHash/sentSliceHash`、`sources`、`budget`（单位、上限、消耗、截断；估算 token 另标 estimated）、`stage/reason/at`、`canonicalEntryId`。recordHash 用原文稳定摘要；现有 fingerprint 是规范化内容摘要，应标明算法，不能混同片段摘要。
4. **区分含义，不把“采用”当因果。** `retrieved` = 检索返回；`prepared` = 已选定待装配；`injected-to-context` = 在公开上下文观察点确实存在该片段；`excluded` = 候选被版本/状态/范围/预算等规则排除。`adopted` 只表示 Pi 已保存并绑定这份 receipt；Memory 的“候选采用→active”与 Expert 的 `selected/use` 是另外两个业务含义。若用更短 schema，可把 canonicalEntryId 表示采用状态，避免同名歧义。
5. **请求状态单独记录。** `before_agent_start` 返回 message/systemPrompt 只能证明 prepared；context hook 返回后，其他 hook 仍可改动。公开 `context_with_system` 可观察装配后的上下文，但后续 handler 仍可能修改。`before_provider_request` 是发送前 payload 观察点，不证明 HTTP 已发送；`after_provider_response` 才证明观察到响应，仍不证明模型因果使用。按实际公开观察点写 `request-prepared/response-observed/failed/cancelled`，缺少证据停在已有阶段；不增加私有 loop 钩子，不存请求头或 API Key。
6. **纠正与版本冻结。** 若采用用户要求的“本轮冻结、下轮生效”，逻辑 run 开始固定 Memory 的版本与注入策略；本轮 receipt 不被后续库修改改写。纠正立即生成有效新版本、撤销相关派生；界面注明“当前轮仍记录 vN；下轮使用 vN+1”。对尚未派发的上下文是否立即失效、对硬撤回是否停止执行，应作为明确例外策略决定，不能同时宣称“全轮冻结”和“每个工具后读取最新版本”。现有 Memory 尚未实现全轮冻结，Expert 已冻结。
7. **工作台只读当前会话使用投影。** 默认展示本会话选定轮次中 `injected-to-context` / 已观察模型工具结果的记忆，标注版本、送入渠道、片段、来源与证据阶段；检索但排除的条目置于可展开说明。单纯 GUI 搜索/read 不进“提供给模型”列表。全库 CRUD、候选、学习开关和队列移至设置/管理入口。Expert 主视图展示该轮 frozen 真版本，区分“明确选择”“工具按需采用”“仅目录可用”，编辑的新版本另标“下一轮生效”。
8. **旧记录不补造。** 原生工具结果和已有 Expert adoption 可按确切条目回查；旧 ReBuild 临时召回没有保存时显示“未记录”，不是“没有使用”。Memory 关闭或 ReBuild 单独安装时保持自身功能；Memory 独立安装时模型工具的 receipt 路径仍可工作。

Pi 边界定位：[公共 context / provider 事件](</Users/youdongliang/Desktop/Friend-Pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:659>)、[请求时 transform](</Users/youdongliang/Desktop/Friend-Pi/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:278>)、[hook 串行改写](</Users/youdongliang/Desktop/Friend-Pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:1006>)、[toolResult/message_end 落盘](</Users/youdongliang/Desktop/Friend-Pi/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:751>)、[公开 appendEntry](</Users/youdongliang/Desktop/Friend-Pi/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2720>)；[现有 PluginContext 无 run/request 身份](</Users/youdongliang/Desktop/Friend-Pi/packages/core/src/index.ts:16>)；[Expert 原生 JSONL fixture](</Users/youdongliang/Desktop/Friend-Pi/packages/expert/test/native-adoption.test.ts:11>)。

## 该优化点的验收边界

用 fake provider 捕获实际上下文并与 native receipt 对齐：只检索未注入、预算排除、模型工具读取与用户查看分开、两个请求/分支切换、不重复 receipt、注入后取消、请求失败、保存失败、纠正后冻结旧版和下轮新版、关闭/独立插件、冷启动重新建索引。旧会话无记录必须显示“未记录”。真实模型和 GUI 另行验收版本与来源展示，均不能升级为“证明模型在推理中因果使用了这条记忆”。
