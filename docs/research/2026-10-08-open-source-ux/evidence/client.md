# Friend-Pi 客户端只读研究（2026-10-08）

本地候选：`c1415c7e9ec7cde75796716fc26f69db2e09f319`。本任务未修改产品、未操作 GUI、未读取认证。以下为当前源码/固定 GitHub commit 的证据；交互效果与性能仍须之后真实体验和同候选测试。保持横向项目、竖向对话、两个镜像按钮、五个轻量工作台页，完整配置继续放设置。

## 参考范围与复用边界

|产品/库|固定 SHA|许可证|使用方式|
|---|---|---|---|
|OpenCode|`3865c696efc97f30a34ea55b1d0ea4c26d939ecd`|[MIT](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/LICENSE)|仅参考 Solid 的状态边界、树加载、时间线；不直接搬入 Solid UI|
|Cline|`5b67631981ac2a3f1ad290e843a667491fb44f7d`|[Apache-2.0](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/LICENSE)|参考 React 消息/附件/设置交互；复用片段需移除 VS Code RPC 并保留版权与 NOTICE|
|VS Code OSS|`35c48f9946eecf40beed751940607f184a03b6de`|[MIT](https://github.com/microsoft/vscode/blob/35c48f9946eecf40beed751940607f184a03b6de/LICENSE.txt)|仅参考 Diff/Settings 行为，不搬入完整 workbench|
|Pierre Diffs|`d302ea0aad461a2a9ee6de5916e3482bced946e5`|[Apache-2.0](https://github.com/pierrecomputer/pierre/blob/d302ea0aad461a2a9ee6de5916e3482bced946e5/packages/diffs/LICENSE.md)|首选可复用只读 React File/FileDiff 组件候选；本轮未安装|

Codex 的开源仓库可参考底层协议，但其桌面 React 组件不能被描述成已公开可复制。未复制完整 OpenCode/Solid、VS Code workbench 或 Cline RPC 框架。Pierre 只考察 `packages/diffs` 的 Apache 许可闭包，不推广为整仓全部可复用。

## 九项建议

### C01 · P0 · 给工作台异步请求加项目与选择版本屏障

**当前源码：** [Workbench.tsx:12](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:12)、[Workbench.tsx:13](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:13)、[Workbench.tsx:18](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:18)

**用户问题：** 读取 A 项目或文件 A 后很快切到 B，晚到的 A 响应仍调用 setTabs/setSelected/setData；可能把旧项目内容显示在新项目标题下，或让旧选择抢回焦点。是源码可确定的无屏障路径，尚未做延迟注入运行复现。

**推荐：** 用 projectId + requestEpoch + path/scope/runId 标识请求；项目/会话改变递增 epoch；晚结果仅可进入自己的缓存，不能改当前选择。支持 AbortSignal 的接口同时取消，主进程仍验证路径和项目身份。

**参考证据：** [固定源码 1](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/packages/app/src/context/file.tsx#L167-L202)，[固定源码 2](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/packages/app/src/context/file/tree-store.ts#L42-L67)

**复用：** 参考行为，React 本地实现；不复制 Solid 的上下文依赖

**验收：**
- A 响应晚于 B 200ms 时只显示 B，B 的标题、内容、Diff 范围一致
- 切项目后旧错误/通知不污染新页，刷新不会抢走用户选择
- 缓存仍以项目隔离，取消请求不修改 JSONL 或业务状态

**对比示意（不是实际截图）：**
```text
之前：点击 A → 点击 B → A 迟到又选中 A
之后：点击 A → 点击 B → 只有 B 的当前身份可采用响应
```

### C02 · P1 · 把扁平文件清单升级为按目录展开的只读树

**当前源码：** [workspace-files.ts:18](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/workspace-files.ts:18)、[Workbench.tsx:15](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:15)

**用户问题：** 当前递归最多 6 层、2000 项，UI 过滤掉 directory，展示全路径扁平按钮且没有使用 truncated。大型项目容易误以为某文件不存在；同名文件与长路径难辨。

**推荐：** 按目录懒加载、显示层级/图标/同名路径，保留一个搜索框和少量预览标签。全项目文件查找不受已展开树限制；对忽略目录、权限错误、截断明确提示。首版不要增加编辑器或 Git 写按钮。

**参考证据：** [固定源码 1](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/packages/app/src/context/file/tree-store.ts#L42-L138)，[固定源码 2](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/packages/app/src/components/file-tree-v2.tsx#L18-L25)

**复用：** 参考懒加载与扁平可见行模型；React 虚拟化可独立选择，不叠装 OpenCode

**验收：**
- 超过 2000 文件、7 层目录仍能搜索并打开指定文件
- 相同 basename 的两份文件标签能区分，键盘上下/左右/Enter 展开定位
- 只读边界及 symlink 越界限制不放宽，深目录权限错不使整树失败

**对比示意（不是实际截图）：**
```text
之前：src/a/index.ts
src/b/index.ts
… 截断但没有提示
之后：▸ src
  ▾ a → index.ts
  ▸ b   [搜索全部项目文件]
```

### C03 · P1 · Diff 保留现有四范围，补前后版本与成熟阅读器

**当前源码：** [Workbench.tsx:17](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:17)、[Workbench.tsx:18](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/Workbench.tsx:18)、[workspace-files.ts:24](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/workspace-files.ts:24)、[workspace-files.ts:35](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/workspace-files.ts:35)

**用户问题：** 现有双栏按连续增删行位置配对，没有词内差异与逐段定位；删除文件仍提供“打开文件”但工作区文件已不存在。大文本被归入 binary 布尔值，和真正二进制共用展示。多文件/长行时阅读与跳转成本仍高。

**推荐：** 继续使用当前可信 Git 解析/真实本轮基线，适配 Pierre 的只读 FileDiff/File；默认折叠文件、短上下文，提供上一处/下一处、展开上下文、词内高亮、自动窄屏行内。删除打开基线只读版本，重命名可看旧/新路径；区分二进制、超预算文本、截断原因。不加入应用/回滚按钮。

**参考证据：** [固定源码 1](https://github.com/pierrecomputer/pierre/blob/d302ea0aad461a2a9ee6de5916e3482bced946e5/packages/diffs/src/react/FileDiff.tsx#L30-L67)，[固定源码 2](https://github.com/pierrecomputer/pierre/blob/d302ea0aad461a2a9ee6de5916e3482bced946e5/packages/diffs/src/react/Virtualizer.tsx)，[固定源码 3](https://github.com/microsoft/vscode/blob/35c48f9946eecf40beed751940607f184a03b6de/src/vs/editor/browser/widget/diffEditor/features/hideUnchangedRegionsFeature.ts#L380-L441)，[固定源码 4](https://github.com/anomalyco/opencode/blob/3865c696efc97f30a34ea55b1d0ea4c26d939ecd/packages/session-ui/src/components/file.tsx#L1110-L1189)

**复用：** 可复用 @pierre/diffs 1.5.2 的 React 只读层；需要 Shiki/theme/theming/diff、worker 打包与缓存身份适配。VS Code/OpenCode 整套组件只作行为参考。

**验收：**
- 删除文件能阅读 base；重命名能定位旧/新版本；模式/二进制仍显示明确元数据
- 空格/单词小改动可区分，特殊路径及缺尾换行保持准确
- 10k 行/100文件固定基准无全量 DOM 卡顿；窄屏自动行内，键盘可跳改动
- 切范围或更新同一文件时虚拟阅读器确实替换目标，避免依赖库旧 target 缓存

**对比示意（不是实际截图）：**
```text
之前：删 README.md [打开文件] → 路径不存在
整行红/绿，多个长补丁逐个滚动
之后：README.md 已删除 [查看旧版]
修改词高亮 · 2/7处 [上一处][下一处] · 展开上下文
```

### C04 · P1 · 富文本改用完整且安全的 Markdown 解析

**当前源码：** [ui.tsx:32](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ui.tsx:32)、[ui.tsx:37](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ui.tsx:37)、[ui.tsx:40](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ui.tsx:40)

**用户问题：** 当前用正则/空行拆块：所有标题都变成 h3，嵌套列表/混合段落/转义竖线等不完整，代码语言被丢弃，没有复制。文件路径 decodeURIComponent 异常未做本地处理。源码表明支持子集，不能等同 CommonMark。

**推荐：** 采用 react-markdown + remark-gfm，关闭 raw HTML；链接走现有原生打开/受约束文件 resolver，不让解析器直接访问网络或 file://。代码块显示语言、语法颜色和复制；完成块 memo 缓存，仅增量更新未完成块。用户原话继续原文显示。

**参考证据：** [固定源码 1](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/common/MarkdownBlock.tsx#L29-L115)，[固定源码 2](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/common/MarkdownBlock.tsx#L314-L335)

**复用：** Cline 是 React 但组件绑定内部 RPC/样式；优先使用同类解析库写薄适配，不照搬全部 MarkdownBlock。新增依赖需固定版本/核查子许可证。

**验收：**
- 嵌套中英列表、带转义竖线/反引号表格、不同级标题与未闭代码流式稳定
- __init__.py、带空格/中文路径、错误 % 编码不会错误加粗或触发崩溃
- script/img外链/危险 scheme 不执行、不自动请求；复制不包含行号
- 同候选冷恢复和实时回复相同，既有用户输入/附件边界不变

**对比示意（不是实际截图）：**
```text
之前：无语言纯代码块、所有标题一个级别、复杂列表挤成段落
之后：有层级标题/标准表格 · TypeScript [复制] · 文件链接可定位
```

### C05 · P1 · 按原始内容顺序合并实时与历史工具，长会话只渲染可见轮次

**当前源码：** [message-projection.ts:5](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/message-projection.ts:5)、[ui.tsx:52](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/ui.tsx:52)、[App.tsx:103](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:103)、[App.tsx:109](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:109)、[App.tsx:219](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:219)

**用户问题：** projection 保存了 parts，但展示先输出拼接 text 再把思考/工具集中追加，text→tool→text 的原顺序消失。tools 临时数组在 settled 后没清空，和已刷新的历史 call/result 可同时出现；且每次 token 更新映射整个历史 DOM。是源码显示风险，本轮未实测重复频率或性能。

**推荐：** 仍以 Pi JSONL 唯一原史，建立可重建视图 reducer：session/run/message/toolCallId 为身份，按 parts 顺序展示；历史采用后移除对应临时副本。低风险连续读取聚合为一条“读取3文件”，失败/确认突出，参数/结果/身份放展开详情。对长历史用稳定行锚点和虚拟渲染，保留用户主动滚动位置及轮次定位。

**参考证据：** [固定源码 1](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/chat-view/messageReducer.ts#L82-L109)，[固定源码 2](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/chat-view/components/messages/ToolGroupRenderer.tsx#L107-L154)，[固定源码 3](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/MessagesArea.tsx#L240-L265)

**复用：** 参考 reducer、分组与用户滚动状态，Pi 事件身份替代 Cline ts/epoch；不复制其按路径去重或无限 bottom overscan 的 workaround。React 虚拟列表是可选新增依赖。

**验收：**
- 实时、停止、冷恢复同一 toolCallId 仅一条状态，结果与调用关联且原序一致
- 100+ 工具与500轮会话不会因 token 推送重复、丢图或滚动跳跃
- 展开/轮次收藏/定位状态在虚拟行进出后仍准确；不能用工具结束推断整轮完成

**对比示意（不是实际截图）：**
```text
之前：正文A＋正文B →工具call详情→工具结果→实时工具卡再次出现
之后：正文A → 读取 README [已完成] → 正文B；详情按需展开，整轮状态仍由 settled 决定
```

### C06 · P1 · 打通纯图片/附件入口，粘贴与拖入也用相同校验

**当前源码：** [App.tsx:129](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:129)、[App.tsx:162](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:162)、[App.tsx:222](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:222)、[App.tsx:233](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:233)

**用户问题：** send guard 和发送按钮都要求 draft.trim()；选择图片却没文字不能发送。当前只有文件选择器和路径胶囊，没有图像缩略、粘贴/拖入或发送前模型图像能力提示。SDK 已具备图片投影，但 UI 入口不一致。

**推荐：** 输入非空或有有效附件可发送；原样保留空的 userText，不伪造一句用户指令。添加缩略/读取中/过大/不支持状态；选择、粘贴、拖入共用原生受限导入与现有 SDK 校验。无图片能力时让用户换模型或移除，不静默忽略。

**参考证据：** [固定源码 1](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/ChatTextArea.tsx#L855-L944)，[固定源码 2](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/ChatTextArea.tsx#L1566-L1618)

**复用：** 参考交互与类型检测；附件导入接 Electron/Pi 自身，不能复制 VS Code URI/RPC 或 Cline 忽略不支持图片的策略。

**验收：**
- 空文本单图真实进入 Native Pi、实时和冷恢复都保留原图/空用户原话
- 多图/中文路径/过大/损坏/模型不支持时发送前给精确原因，草稿不丢
- 粘贴只响应明确用户操作，不后台读取剪贴板；附件仍不是全局偏好来源

**对比示意（不是实际截图）：**
```text
之前：选图片 → 无文字 → 发送灰色
之后：图片缩略/已就绪 → 可发送；模型不支持则提示 [更换模型]/[移除]
```

### C07 · P1 · 设置搜索覆盖完整设置，作用域固定，保护未保存修改

**当前源码：** [App.tsx:33](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:33)、[App.tsx:36](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:36)、[App.tsx:39](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:39)、[App.tsx:239](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:239)

**用户问题：** 搜索靠 DOM textContent 隐藏部分 .field/.switch-row；可以连“设置作用域”一起隐藏，却不覆盖 settingsRoot 外四个高级管理折叠页，也留下一些无匹配按钮/说明。作用域改变 load() 会覆盖 form，没有 unsaved dirty 状态。

**推荐：** 仍只用一个设置弹窗，按模型/执行/学习/上下文/本地五组注册结构化设置项。搜索只显示匹配条目及所属组，结果可跳到展开的对应高级项；作用域条始终可见。每项显示继承/覆盖/当前生效/待生效；范围切换时保存或保留独立草稿，关闭时清楚提示未保存。

**参考证据：** [固定源码 1](https://github.com/microsoft/vscode/blob/35c48f9946eecf40beed751940607f184a03b6de/src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts#L98-L113)，[固定源码 2](https://github.com/microsoft/vscode/blob/35c48f9946eecf40beed751940607f184a03b6de/src/vs/workbench/contrib/preferences/browser/settingsEditor2.ts#L209-L250)，[固定源码 3](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/settings/SettingsView.tsx#L230-L277)

**复用：** 参考 VS Code 结构化索引和 Cline 分类/target highlight；沿用当前 React Modal，避免复制 workbench 配置系统。

**验收：**
- 搜记忆/无限/专家/并发均能定位真实项，0结果清晰；作用域始终可操作
- 全局与项目脏表单不互相覆盖；不会将默认值误称当前执行快照
- 设置返回原工作台后保留材料/滚动，不增加新的常驻导航页面

**对比示意（不是实际截图）：**
```text
之前：搜“记忆”仍留无关组，高级记忆可能找不到；切作用域未保存值消失
之后：固定 全局/项目 · 2条结果→学习组；已覆盖/继承标签 · 未保存草稿可恢复
```

### C08 · P2 · 保持快捷归档/删除规则，给归档撤销与会话键盘导航

**当前源码：** [App.tsx:172](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:172)、[App.tsx:173](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:173)、[App.tsx:204](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:204)、[App.tsx:240](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:240)

**用户问题：** 近期列表仅名称 includes，无日期分组/匹配片段；快速归档立刻离开列表而没有撤销。右键菜单有 menu roles，但没有完整菜单方向键/初始焦点管理。频繁会话切换会多点几次，视觉位置变化也难找。

**推荐：** 近期/归档时钟不改；近期按今日/较早轻分组，名称搜索可模糊匹配并标出原始用户标题片段。快捷归档显示短暂“已归档 [撤销]”，只撤销 archive 标记。键盘上下选会话、Enter打开、ShiftF10/menu键打开相同菜单，菜单可上下/Home/End/Escape，删除仍走原共用预览/一次确认。

**参考证据：** [固定源码 1](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/history/HistoryView.tsx#L272-L320)，[固定源码 2](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/history/HistoryView.tsx#L322-L359)

**复用：** 只参考模糊搜索与日期分组；最小 fuzzy 算法或 fuse.js 均需评估。归档撤销/菜单键盘由当前控制器实现，不采用 Cline 大型独立 History 页。

**验收：**
- 取消归档不改变原 ID/草稿/JSONL，冷恢复仍一致；永久删除没有假撤销
- 全键盘能新建/搜索/选择/归档/恢复/打开删除预览并取消
- 100会话搜索中文/错字/长标题可找到，新增/归档后焦点到邻近稳定项

**对比示意（不是实际截图）：**
```text
之前：点归档 → 卡片消失 → 需时钟再找；右键后仍依赖鼠标
之后：点归档 → 已归档 [撤销]；今日/较早短组，全键盘同入口
```

### C09 · P2 · 计划批准保留现有门槛，展示本次修订差异与执行摘要

**当前源码：** [App.tsx:214](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/renderer/App.tsx:214)、[plan-store.ts:8](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/plan-store.ts:8)、[plan-store.ts:9](/Users/youdongliang/Desktop/Friend-Pi/apps/desktop/src/plan-store.ts:9)

**用户问题：** 现有精确版本/hash/配置批准规则正确；客户端短卡只有 vN 和全文入口。多次要求修改后，用户要重新读整篇才知道改了哪里，卡片也没帮助区分“规划中的回答”和实际提交的计划。

**推荐：** 只在真正提交版本时显示批准卡；卡片放3项以内执行范围/验证/风险摘要及“相比上版”的增加/移除计数。全文和前后 Diff 留在文件页，当前按钮明确“批准 v3 并执行”；配置变化显示重规划原因。摘要是可重建展示，不替代已批准 body/hash，不添加模型自动批准。

**参考证据：** [固定源码 1](https://github.com/cline/cline/blob/5b67631981ac2a3f1ad290e843a667491fb44f7d/apps/vscode/webview-ui/src/components/chat/PlanCompletionOutputRow.tsx#L9-L29)，[固定源码 2](https://github.com/microsoft/vscode/blob/35c48f9946eecf40beed751940607f184a03b6de/src/vs/editor/browser/widget/diffEditor/features/hideUnchangedRegionsFeature.ts#L380-L441)

**复用：** 参考 Cline 区分计划模式回答的轻提示，版本差异可用 C03 阅读器；Cline 的计划结束显示不能当作 Friend-Pi 的严格批准收据。

**验收：**
- 只聊天讨论方案不会显示可批准提交；只有当前提案可批准
- 修订差异对应版本内容、0变动不虚构变化；批准后修改仍需要新批准
- 中央卡不增加长表单/工具清单；全文与版本差异仍在同一文件页

**对比示意（不是实际截图）：**
```text
之前：计划已就绪 v3 [阅读全文][批准并执行]
之后：计划 v3 · 改2项/移除1项 · 范围/验证摘要 [查看修订][批准 v3]
```

## 推荐顺序

先 C01（身份/过期响应），然后 C05/C06（真实消息与附件入口），再 C02/C03/C04（材料阅读），最后 C07/C08/C09（设置、会话、计划可理解性）。原始 JSONL、停止回执、审批门槛、后台串行学习、原生压缩默认值均保留。

## 证据限度

这些不是“已修复”或“已实测”。本任务只核对源码与 GitHub，未覆盖各产品所有功能、未使用真实模型、未测性能。异步竞态/重复展示要先补失败 fixture，验收再走最终候选 GUI；Markdown 子集、空文字附件 guard、截断 UI、DOM 设置过滤则由当前实现直接确认。原始下载位于 `client-sources`，版权/许可证已保留；两项失败下载未用于结论。