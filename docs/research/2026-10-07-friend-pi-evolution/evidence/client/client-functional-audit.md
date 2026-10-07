# Friend-Pi 客户端功能完备性核验（独立审计）

主要日常路径已经实现，并有同一应用制品的小批真实模型与 Computer Use 证据；当前不能将它表述为“所开发功能全部完备”。这次无 GUI 输入、无凭据读取的核验确认了 4 项客户端缺口，另有 1 项恢复风险需要 Root 的真实界面复现。源码保持不变，报告仅写入忽略目录。

- 源码：`5ec4b39fb7301ac57715976458f602909fc0a0fb`
- Pi：`eb326d265ae0b88489a6d10319307780df827cdf`
- 应用树 SHA256：`a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4`
- 本次重新运行：95/95 测试、typecheck 通过；app、ZIP、清单登记的验证报告摘要均重新计算匹配。

既有最终 GUI 报告覆盖自然 Swarm 的两个只读成员、独立结构化复核、Single/Expert、真实流式停止、Memory 纠正 v4、ReBuild 小会话回退、原史回查、文件/已跟踪 Diff、宽窄布局/拖动、轮次书签、待发送方式/计划/草稿冷恢复。它证明这些小批旅程通过，不证明所有项目、Provider 或边界已体验。

## 已确认缺口与恢复风险

### CL-01 · P1 · 原始会话文件丢失时静默新建历史

证据：boundary-report.json:CL-01。源码：[main.ts:91](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:91)、[main.ts:40](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:40)、[sdk-worker.ts:92](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:92)。

处理建议：已登记路径缺失时阻止新建，保留原路径与恢复操作，明确显示缺失原史；新增会话必须明确新会话身份。

### CL-02 · P1 · Diff 将新文件存在显示为没有改动

证据：boundary-report.json:CL-02。源码：[main.ts:165](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:165)、[App.tsx:59](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:59)。

处理建议：合并 git status 的 untracked 列表与 tracked Diff；新文件单独展示完整内容及新建状态，不为展示自动 git add。

### CL-03 · P1 · 历史工具调用与多模态结构没有呈现在客户端

证据：boundary-report.json:CL-03。源码：[index.ts:93](/Users/youdongliang/Desktop/Friend-Pi/packages/core/src/index.ts:93)、[sdk-worker.ts:27](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:27)、[App.tsx:219](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:219)。

处理建议：扩展可重建快照的结构化内容与 toolCall/result 关联，直接投影 JSONL，不另存聊天副本；保留历史 thinking 折叠及图片预览。

### CL-05 · P2 · 新会话 Swarm 默认与关闭 Swarm 插件矛盾

证据：boundary-report.json:CL-05。源码：[main.ts:129](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:129)、[App.tsx:167](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:167)。

处理建议：保存时明确验证依赖，或用户选择 Swarm 时同步启用；如需降级必须解释原因并返回实际保存值。

### CL-04 · P2 · 任何 error notice 可能回填上次成功提交

证据：源码已确认两端条件，未做 GUI/React event 复现。源码：[App.tsx:99](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:99)、[main.ts:119](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:119)。

处理建议：只对相关 accepted/runId 的提交失败恢复草稿；已结算成功则清除 lastSubmitted，错误通知不能改变已成功轮次的输入意图。

CL-01 的 Main VM 严格执行当前源码条件：原路径 missing → worker env 不指定历史 → ready 后 record.path 指向新原史。CL-02 在自有真实 Git 项目中验证 `git status` 有 `?? new-file.ts` 而客户端使用的 `git diff HEAD` 为空。CL-03 用真实 Pi JSONL 和实际 SDK 子进程确认：原史里有 image/thinking/toolCall，客户端快照将这些结构投影掉。CL-05 通过当前 Main 的设置入口确认允许保存矛盾默认值。CL-04 尚未做 React/GUI 事件复现，必须保留“待复现”标记。

## 部分实现及演进范围

1. 运行中纠偏/排队：SDK 有 steer/followUp，GUI 发送函数在 running 直接返回。建议设置明确的“加入队列 / 立即纠偏”动作及原生待处理队列展示，避免用户不知输入会如何执行。
2. 计划模式探索：默认工具只激活 read/bash/edit/write，计划阻断所有 bash；没有激活原生 ls/find/grep。已知文件能读，但陌生目录整体分析不足。建议通过 Pi 原生只读工具提供列目录/搜索，继续保持写入边界。
3. Provider 能力：自定义配置固定一个 text/non-reasoning 32K 型号，不能表达 vision、思考和真实预算能力；GUI 默认模型选择也未显示认证/能力过滤。建议 Settings 中建模供应商→型号→能力，保持运行快照。
4. Swarm 可观察性：当前任务卡可看状态/摘要/路径，但成员流式事件没有渲染；没有在客户端打开成员原史、工作区文件或结果 Diff 的入口。建议成员详情页直接读取其 Pi JSONL，仍不复制历史。
5. Swarm 恢复与返工：操作入口仅 start/resume/prepare/并发数，没有定向选择返工目标、调整方法或明确手动 integrate；自动整合通路已存在。是否增加定向控制须结合 Swarm 专项核验和用户决策。
6. Expert 管理：编辑/版本/Skill/回滚/候选基准均有入口，但当前不展示本轮真实采用快照；suite 表单重新打开不加载保存基准。建议采用记录、验证案例和发布时间清晰分开。
7. Memory 配置：后台 pause/resume 存在，enabled 设置仅后端；最近只展示 6 个 job。需要项目级学习配置、完整失败/重试队列及阶段来源入口。
8. 配置归位：全局供应商和默认值已在 Settings；项目级学习/验证策略与基准仍只在会话工作台。建议 Settings 分全局/项目配置，工作台保留当前执行和临时操作。
9. 消息可读性：真实 React 静态渲染确认链接、表格、编号步骤原样显示。建议安全 Markdown、代码复制、文件/来源打开；图片预览目前仅在 Renderer 有未接入分支，README 已明确文件预览限文本，因此应作为新增能力，而不是既有功能通过项。
10. 会话管理：归档、删除、关闭项目、分支恢复并未在首版明确承诺；旧 Friend 数据迁移、Team、浏览器、交互终端、侧聊、多窗口和外部 Agent 后端明确排除。竞品提供这些能力不能直接转化为首版缺陷。

## 用户可见功能覆盖清单

状态中的“通过”使用当前源码、此次 headless 重跑和既有同制品报告；不是审计 Agent 本轮亲自操作 GUI。

| ID | 能力/操作 | 核验状态 | 源码入口 | 范围与限制 |
|---|---|---|---|---|
| C01 | 项目打开及路径身份 | 源码与既有同制品证据通过 | [main.ts:144](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:144)、[App.tsx:145](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:145) | 原生选目录、canonical identity；实际 GUI 已在自有临时项目运行。 |
| C02 | 顶栏跨项目切换、最近会话恢复 | 已有实现，缺本轮真实界面覆盖 | [main.ts:151](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:151)、[App.tsx:138](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:138) | 源码支持最近会话及键盘左右/Home/End；最终 GUI 报告未明确覆盖两个项目互切。 |
| C03 | 新会话与 Cmd N | 源码与既有同制品证据通过 | [main.ts:148](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:148)、[App.tsx:152](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:152) | 本轮默认创建独立逻辑 ID 与原生 JSONL；Cmd N 既有最终 GUI 通过。 |
| C04 | 会话重命名及后续持久化 | 已有实现，缺本轮真实界面覆盖 | [main.ts:160](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:160)、[App.tsx:241](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:241) | 已同步 live worker.record，避免后续状态覆盖名称；最终 5ec GUI 报告未单列此项。 |
| C05 | 左栏会话搜索、Cmd K | 已有实现，缺本轮真实界面覆盖 | [App.tsx:164](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:164)、[App.tsx:174](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:174) | 仅当前项目名称子串搜索，不是聊天正文全文检索；需要真实中文/大小写/空结果操作。 |
| C06 | 历史会话全项目列表与打开 | 已有实现，缺本轮真实界面覆盖 | [App.tsx:239](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:239)、[main.ts:157](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:157) | 历史弹窗列出全部已登记会话并显示项目/型号；没有归档或删除。 |
| C07 | 会话状态卡片及模型 | 源码与既有同制品证据通过 | [App.tsx:201](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:201)、[main.ts:40](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:40) | 真正依据原生结算与图状态；已整合旧图不会把新的停止状态刷成完成。 |
| C08 | 草稿、附件路径、待发送计划/方式保存 | 源码与既有同制品证据通过 | [App.tsx:116](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:116) | 按逻辑会话 ID 隔离 localStorage；既有最终证据覆盖空/非空草稿及 mode/plan 冷恢复，未单列附件路径冷恢复。 |
| C09 | 轮次定位、摘要预览、书签 | 源码与既有同制品证据通过 | [TurnIndex.tsx:10](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/TurnIndex.tsx:10) | 预览从原生 ID 文本生成，书签仅存 ID；hover/focus/方向键/ B / Escape 有实现。 |
| C10 | 左右分栏拖动、键盘调整、保存宽度 | 源码与既有同制品证据通过 | [ResizeHandle.tsx:2](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ResizeHandle.tsx:2)、[App.tsx:72](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:72) | 既有最终 GUI 拖动并恢复 319/440 px；保存像素宽度而非百分比，窄屏切 overlay。 |
| C11 | 宽窄窗口和顶栏模块开关 | 源码与既有同制品证据通过 | [App.tsx:183](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:183)、[layout.css:108](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/layout.css:108) | 项目顶栏、左会话、右工作台；七个顶栏按钮；工作台一次显示一个模块。 |
| C12 | 全局供应商配置、空会话可用 | 源码与既有同制品证据通过 | [provider-settings.ts:6](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/provider-settings.ts:6)、[main.ts:138](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:138) | 独立 Pi auth；API Key 输入空白保留，不在 metadata 返回；保存要求全部执行空闲。 |
| C13 | 自定义兼容 Provider 配置 | 部分实现或产品入口不足 | [provider-settings.ts:12](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/provider-settings.ts:12)、[App.tsx:24](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:24) | HTTP Chat Completions 真实本地服务已测；Responses/Anthropic 只有配置入口；一个供应商只保存一个模型，并强制 text/reasoning false/32K/4096，无法配置真实 vision/reasoning/caps。 |
| C14 | 新会话默认模型/思考/插件/方式/计划 | 已有实现，缺本轮真实界面覆盖 | [main.ts:129](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:129)、[main.ts:148](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:148) | 默认值只给新会话，不重写当前快照；需真实新旧会话差异验证。 |
| C15 | 默认 Swarm 与插件依赖一致性 | 确认缺口 | [main.ts:129](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:129)、[App.tsx:167](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:167) | 设置可保存 defaultMode=swarm 但 defaultPlugins 无 swarm；新会话 Renderer 静默切为 Single，违背保存后的选择。 |
| C16 | 当前会话模型和思考等级 | 源码与既有同制品证据通过 | [App.tsx:231](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:231)、[sdk-worker.ts:174](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:174) | 空闲才可修改，Pi 原生 setModel/setThinkingLevel 决定实际支持等级；界面仍枚举全部等级，能力说明可增强。 |
| C17 | 插件开关与真实 reload 重绑 | 源码与既有同制品证据通过 | [App.tsx:238](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:238)、[sdk-worker.ts:174](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:174) | 禁止执行中修改；真实 reload 后 bind UI，关闭插件拒绝调用；缺最终真实 GUI 逐个禁用/启用的记录。 |
| C18 | 计划模式的写入阻断 | 源码与既有同制品证据通过 | [sdk-worker.ts:53](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:53)、[App.tsx:226](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:226) | 不是仅靠提示；工具边界阻断 edit/write/bash 与非读取插件动作。 |
| C19 | 计划模式探索陌生目录 | 部分实现或产品入口不足 | [sdk-worker.ts:58](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:58)、[sdk-worker.ts:89](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:89) | 默认仅 read/bash/edit/write，计划禁用全部 bash；没有激活原生 ls/find/grep，read 是文件读取而非列目录。已有已知文件阅读可用，完整目录探索不足。 |
| C20 | Single 原生执行与完整结算 | 源码与既有同制品证据通过 | [sdk-worker.ts:149](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:149)、[sdk-worker.ts:95](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:95) | SDK 原生执行、保存 JSONL、agent_settled 后结算；会话卡完成不表示任意产品验收成功。 |
| C21 | 自然语言 Swarm 协作 | 源码与既有同制品证据通过 | [sdk-worker.ts:28](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:28)、[sdk-worker.ts:149](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:149) | 最终 GUI 2 个只读成员与独立结构化复核 integrated；不存在图/未启动/只有模型宣称成功时拒绝完成。 |
| C22 | 流式回复与自动跟随 | 源码与既有同制品证据通过 | [App.tsx:105](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:105)、[App.tsx:129](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:129) | 有增量文本、思考块、近底自动滚动；用户手动定位后停止跟随。 |
| C23 | 前台本轮工具过程 | 源码与既有同制品证据通过 | [App.tsx:112](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:112)、[App.tsx:219](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:219) | 当前 Renderer 内存保留最近 50 个工具调用，输入/输出/执行状态可以展开；没有持久化第二份工具历史。 |
| C24 | 历史工具名/输入/结果关联 | 确认缺口 | [index.ts:93](/Users/youdongliang/Desktop/Friend-Pi/packages/core/src/index.ts:93)、[sdk-worker.ts:27](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:27) | 原生 toolCall 被投影丢弃；冷打开只剩多个匿名“工具结果”，不能判断结果来自哪个工具和参数。 |
| C25 | 历史思考与图片展示 | 部分实现或产品入口不足 | [index.ts:88](/Users/youdongliang/Desktop/Friend-Pi/packages/core/src/index.ts:88)、[App.tsx:107](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:107) | 原史保留这些块，但 current.messages 只有文本，settled 清掉 thinking；历史中的图片、思考无法展示。可列作展示完整性修补。 |
| C26 | 运行中补充要求/排队/steer | 部分实现或产品入口不足 | [App.tsx:131](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:131)、[sdk-worker.ts:165](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:165) | SDK 支持 steer/followUp；GUI running 时 send 直接 return，没有显式排队/纠偏入口。首版未明确承诺此交互，属于重要演进。 |
| C27 | 文本附件选择/去重/移除/限额 | 已有实现，缺本轮真实界面覆盖 | [App.tsx:165](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:165)、[sdk-worker.ts:141](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:141) | 原生选择器、同路径去重；单附件 10 MiB，文本合计 128 KiB；最终 5ec GUI 报告未单列实际附件内容及限额失败。 |
| C28 | 图片附件发给支持视觉的型号 | 部分实现或产品入口不足 | [sdk-worker.ts:141](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:141)、[provider-settings.ts:17](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/provider-settings.ts:17) | builtin vision 型号可发送 base64；不支持则明确拒绝。自定义 Provider 没有 vision 能力配置，原史图片不显示；成功视觉真实模型旅程未运行。 |
| C29 | 项目文本文件预览 | 源码与既有同制品证据通过 | [App.tsx:49](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:49)、[main.ts:124](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:124) | README 明确限定当前项目内 1 MiB 内文本；输入相对路径或原生选文件。 |
| C30 | 文件预览越界/符号链接/二进制/超限错误 | 已有实现，缺本轮真实界面覆盖 | [main.ts:124](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:124)、[main.ts:164](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:164) | realpath + relative 阻断外部文件和逃逸 symlink；NUL/超限拒绝。图片 dataUrl Renderer 分支无 Main 入口，因此图片预览不是已实现能力，亦非首版 README 承诺。 |
| C31 | 已跟踪 Git 工作区 Diff | 源码与既有同制品证据通过 | [main.ts:165](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:165)、[App.tsx:55](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:55) | git diff HEAD 包括 staged+unstaged 已跟踪差异，彩色文本 Diff；没有 stage/revert/逐 hunk 操作。 |
| C32 | 新建未跟踪文件的改动展示 | 确认缺口 | [main.ts:165](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:165)、[App.tsx:59](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:59) | 真实 Git 新文件存在但 diff 为空，UI 文案“当前没有工作区改动”错误。 |
| C33 | Pi confirm 与取消 | 源码与既有同制品证据通过 | [sdk-worker.ts:21](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:21)、[sdk-worker.ts:69](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:69) | ID 关联到发起 worker，取消为未批准；60 秒超时删除弹窗；最终 GUI 报告未单列 confirm 实际点击。 |
| C34 | Pi select/input/editor 交互 | 已有实现，缺本轮真实界面覆盖 | [sdk-worker.ts:69](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:69)、[App.tsx:62](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:62) | 宿主实现三个接口，支持取消/超时；暂无三类对话的端到端 GUI 测试，不能称全交互已验收。 |
| C35 | Single 停止及停止后冷恢复 | 源码与既有同制品证据通过 | [sdk-worker.ts:168](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:168)、[App.tsx:233](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:233) | 真实 DeepSeek 流式中止、原生 stopReason=aborted 与已停止卡片一致，未重放。 |
| C36 | Swarm 暂停/停止/未知副作用接续 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:67](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:67)、[sdk-worker.ts:168](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/sdk-worker.ts:168) | 控制器与复选确认已实现且 headless 验证；缺真实 GUI stop/member crash/检查现场/显式接续闭环。 |
| C37 | 正常退出、启动超时和进程回收 | 源码与既有同制品证据通过 | [main.ts:41](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:41)、[main.ts:81](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:81) | 最长 3 秒 shutdown + 1 秒自有进程组回收；启动 45 秒超时，不自动重放。 |
| C38 | 冷启动配置/历史/书签恢复 | 源码与既有同制品证据通过 | [main.ts:86](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:86)、[main.ts:94](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:94) | 原史仍是 Pi 权威，SQLite 仅记录业务/路径；默认值与本轮快照明确分开。 |
| C39 | 已登记历史文件缺失恢复 | 确认缺口 | [main.ts:91](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:91)、[main.ts:40](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:40) | Main 缺文件时传 undefined，SDK 新建会话，ready 后覆盖旧路径；与 user-guide 明确提示缺史的说明相反。 |
| C40 | Swarm 自动及手动任务图表单 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:55](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:55) | 自动拆分、手动读写/依赖/路径/检查程序/并发数均有入口；最终 GUI 未覆盖手动表单/循环依赖错误。 |
| C41 | Swarm 成员实时过程/结果/工作区 | 部分实现或产品入口不足 | [panels.tsx:68](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:68)、[index.ts:239](/Users/youdongliang/Desktop/Friend-Pi/packages/swarm/src/index.ts:239) | 可查看尝试状态和结果 JSON，但没有消费 member-event 渲染成员流式对话/工具；sessionFile/workspace 仅文字路径。 |
| C42 | Swarm 消息和共享材料 CAS | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:71](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:71) | 成员消息区分保存/投递/处理；共享材料版本检查与冲突提示；真实 GUI 发消息、编辑冲突未记录。 |
| C43 | Swarm 客观检查、独立复核、整合结果 | 源码与既有同制品证据通过 | [panels.tsx:70](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:70)、[index.ts:348](/Users/youdongliang/Desktop/Friend-Pi/packages/swarm/src/index.ts:348) | 有真实检查输出、保留整合位置和独立结论。GUI 新图显式传 checks=[]，会屏蔽后端自动 npm test 的默认检测；未填写检查时要明确说明仅基础 Git 检查。 |
| C44 | Swarm 定向返工、方法调整、手动整合入口 | 部分实现或产品入口不足 | [panels.tsx:67](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:67)、[index.ts:375](/Users/youdongliang/Desktop/Friend-Pi/packages/swarm/src/index.ts:375) | GUI 只有 start/resume/prepare/worker count，没有目标任务返工/修改方法/指定成员专家或 integrate 按钮；自动整合通路已实现。当前插件返工范围请结合 Swarm 专项审计。 |
| C45 | Expert 库、明确/自动采用、冻结记录 | 源码与既有同制品证据通过 | [panels.tsx:89](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:89)、[index.ts:68](/Users/youdongliang/Desktop/Friend-Pi/packages/expert/src/index.ts:68) | 五角色稳定身份，选用后原生 adoption 有版本/hash/runId；GUI 未显示当轮实际采用快照。 |
| C46 | Expert 编辑、工具/Skill、版本差异与回滚 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:97](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:97) | 所有管理入口已连 controller；版本差异包含名称/提示/工具/Skill；需要实际创建、编辑、失效 Skill、回滚。 |
| C47 | Expert 方法候选、客观案例、验证/撤回/暂停 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:100](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:100) | 至少 2 正例+1 反例，JSON exact checks；手动 suite 表单每次默认 3 案例，未加载 snapshot.suites 的已有基准，重新编辑时可能覆盖旧 suite。 |
| C48 | Memory 中文列表/搜索/保存/纠正 | 源码与既有同制品证据通过 | [panels.tsx:109](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:109) | 实际最终 GUI 纠正到 v4 与冷重启保持，原史不可改写；搜索兼容候选。 |
| C49 | Memory 来源/历史版本/停用/遗忘/导出 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:121](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:121) | 各入口都有；最终 GUI 未逐项覆盖来源带失效、遗忘后冷启动不复活、导出内容与停用。 |
| C50 | Memory 后台队列/候选/暂停/重试 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:123](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:123) | 显示最近 6 个 jobs，失败可显式重试；learning.enabled 后端配置只有 pause/resume GUI，不提供关闭自动学习设置。 |
| C51 | 个人偏好明确保存、跨项目隔离 | 已有实现，缺本轮真实界面覆盖 | [panels.tsx:124](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:124)、[index.ts:369](/Users/youdongliang/Desktop/Friend-Pi/packages/memory/src/index.ts:369) | 明确按钮为 user origin；个人事实/经验虽可选 personal 范围，具体拒绝/类型语义须真实表单检查。 |
| C52 | ReBuild 开关、手动整理、现场与来源 | 源码与既有同制品证据通过 | [panels.tsx:130](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:130) | 空闲真实 native compact；小会话 fallback 已在最终 GUI 观察；两次大压缩采用由同包真实 SDK 模型报告证明。 |
| C53 | ReBuild 原史搜索/原文/前后文 | 源码与既有同制品证据通过 | [panels.tsx:151](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:151) | 从 JSONL 读原文，含时间戳；最终 GUI 命中 preview.txt 原始用户消息。 |
| C54 | Memory 纠正/遗忘导致派生现场失效 | 源码与既有同制品证据通过 | [panels.tsx:148](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:148)、[native-combination.test.ts:73](/Users/youdongliang/Desktop/Friend-Pi/packages/topic-rebuild/test/native-combination.test.ts:73) | 既有最终 GUI 观察纠正后派生失效；遗忘路线仍需要 GUI 追加覆盖。 |
| C55 | 全局/项目设置与工作台职责 | 部分实现或产品入口不足 | [App.tsx:28](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:28)、[panels.tsx:100](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/panels.tsx:100) | 全局供应商和新会话默认已移设置；项目级长期配置（学习/验证策略及基准）仍仅放会话工作台。建议 Settings 增项目配置页，与临时操作分开。 |
| C56 | Markdown 常用结构和可点击来源 | 部分实现或产品入口不足 | [ui.tsx:31](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ui.tsx:31) | 安全小子集；标题/无序列表/代码/粗体可用，链接、表格、有序列表原样显示；没有来源文件点击打开。 |
| C57 | macOS 文件隐私授权 | 已有实现，缺本轮真实界面覆盖 | [main.ts:95](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:95)、[user-guide.md:13](/Users/youdongliang/Desktop/Friend-Pi/docs/user-guide.md:13) | 临时项目已用；桌面目录仍需用户系统授权。不能把临时项目通过算作系统提示操作通过，也不能绕过限制。 |
| C58 | 归档/删除会话、关闭项目、分支恢复、导入 | 首版未承诺或明确排除 | [main.ts:33](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/main.ts:33) | 当前白名单无这些动作；旧 Friend 数据迁移明确排除，其他属于未明确承诺的管理增强，用户决策后再做。 |
| C59 | Team/浏览器/交互终端/侧聊/多窗口/外部后端 | 首版未承诺或明确排除 | [README.md:72](/Users/youdongliang/Desktop/Friend-Pi/README.md:72) | 明确首版排除，不应列为开发缺陷；可作为竞品调研后的可选方向。 |

## 推荐 Root 优先真实 GUI 验证

所有项目、记忆、原史和进程必须为自有 QA 对象；不操作原 Friend、不改真实凭据、不移动用户历史。下列项本审计未操作 GUI。

- **G01 / P1 / 原史缺失后的打开**：自有 QA 数据目录创建一次会话，保存原 JSONL 路径，正常退出；仅移动自有该 JSONL 到保留备份，再打开同会话。 断言：期望显示缺失原史并保留索引；当前源码预期出现新空历史。不要移动真实用户会话。
- **G02 / P1 / 未跟踪新文件的 Diff**：自有已提交 Git 项目仅新增 new-file.ts，打开 Diff。 断言：现有面板预期错误显示没有改动；应显示新文件且不得偷偷 git add。
- **G03 / P1 / 工具历史与图片冷恢复**：在自有会话执行 read 与另一个不同参数工具，正常退出/打开；视觉测试用自己准备的小图与支持视觉型号。 断言：工具名/输入/输出可关联；当前只匿名结果；图片需原文留存且历史呈现。视觉真实模型没有配置时准确标未运行。
- **G04 / P1 / 计划模式陌生目录分析**：自有项目有 README 未列出的 src/deep/nested.ts，开启先规划，让它找出全部层级并分析。 断言：只读工具能枚举/搜索目录；当前默认工具不足，记录实际工具失败及模型是否从有限 README 推测。
- **G05 / P2 / 默认配置与依赖**：设置默认 Swarm，再关闭默认 Swarm 插件，保存，新建会话。 断言：保存值和新会话模式一致；当前 renderer 静默 Single。回滚到原 QA 默认。
- **G06 / P1 / 两项目与草稿隔离**：创建两个自有项目，每个两会话；分别输入草稿/附件/plan/mode，顶栏互切、历史跨项目打开、改默认值再新建会话。 断言：原会话意图不变；新会话采用新默认，消息/书签/记忆没有串项目。
- **G07 / P2 / 名称与搜索**：重命名后真实发送一次，冷重启，Cmd K 输入中文名称、不同大小写和不存在关键词，历史弹窗打开。 断言：名字保持；名称搜索边界明确且无正文检索伪称；焦点和 Cmd N 正常。
- **G08 / P1 / 文本附件及失败草稿**：选择同一路径两次、移除一个、发送小文本并确认实际原文；测试自有 NUL 二进制、128 KiB 文本和 10 MiB 限额。 断言：去重正确，错误有说明，发送失败留草稿，不触发副作用。
- **G09 / P1 / Pi 交互四类**：自有 QA 项目通过仅测试扩展触发 confirm/select/input/editor，各点确认/取消/Escape，等待一次超时，执行后 reload 再触发。 断言：交互 ID 对应发起会话；取消/超时不批准；陈旧响应拒绝，reload 后可用。真实 GUI 仅 Root 操作。
- **G10 / P1 / Swarm 停止、暂停和显式接续**：自有任务图，正在执行时暂停/停止；查看保留尝试与工作区，再显式勾选未知副作用确认接续。 断言：不自动重放；members 与 card 同步，重开应用保持未知，只有用户确认新尝试。
- **G11 / P1 / Swarm 消息/共享材料/手动 DAG**：真实手动创建读写依赖图；成员运行中发消息，检查收据；载入共享 v1 后另连接改 v2，再保存 stale v1。 断言：依赖/并发可信；投递≠处理；CAS 拒绝旧保存且草稿保留；循环依赖明确拒绝。
- **G12 / P1 / Expert 编辑采用和回滚**：自有项目新建专家，真实采用 v1；编辑 v2、停用、版本对比，再回滚生成 v3，并查看原史 adoption。 断言：历史 v1 不改写，v2/v3 仅后续执行；Skill 越界/缺失明确错误。
- **G13 / P1 / Expert 验证基准管理**：手动候选；定义 2 正例+1 反例，失败候选不能发布，暂停/恢复验证，关闭再打开 suite 表单。 断言：已有 suite 应可载入修改；目前打开为默认空基准，避免误覆盖；真实模型未跑就不能写通过。
- **G14 / P1 / Memory 全管理与冷抑制**：自有有来源候选：采用、纠正、停用、原始来源/版本、导出、遗忘、冷重启后学习同一历史。 断言：源内容不被改写；派生失效，遗忘不复活，导出对应有效版本。只用自有记忆。
- **G15 / P1 / 项目经验与个人偏好边界**：两个自有项目存不同事实；个人偏好由明确用户保存，另项目查看；尝试保存 personal fact，观察语义错误。 断言：事实不得串项目；跨项目只有明确个人偏好；表单选项与控制器允许类型一致。
- **G16 / P1 / 正常运行时进程退出与错误草稿**：先成功发送有副作用的自有任务并清空草稿，再仅结束该 QA session 的已确认自有 SDK worker，观察 error notice 与草稿。 断言：不应回填已成功任务造成误重发；不触碰其它进程，更不运行泛 kill 命令。
- **G17 / P2 / 工作台配置归位与窄屏键盘**：在 720x610 和宽窗口操作所有模块、modal、separator 键盘调宽/Tab/关闭，确认项目级长期配置的位置。 断言：操作可见、文字可读、焦点无陷阱；长期配置能从 Settings 找到。

## 报告与证据

- [client-completeness-matrix.json](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/client/client-completeness-matrix.json)
- [boundary-report.json](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/client/boundary-report.json)
- [test-output.txt](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/client/test-output.txt)
- [typecheck-output.txt](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/client/typecheck-output.txt)
- [boundary-audit.mjs](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/client/boundary-audit.mjs)
- [既有最终 GUI 报告](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/cua-final-report.json) · [既有最终真实模型报告](/Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/real-model-report.json)

核验没有修改源码或应用包；没有调用真实模型，没有操作 GUI，也没有读取 auth.json 或任何用户凭据。完整矩阵中的来源与证据层级可用于后续规划书区分“必须修补的完备性缺口”和“用户决定的新增能力”。
