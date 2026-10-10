# 材料、后台任务与外部能力开发交接

本候选实现用户批准的三组体验改进。Pi 公共 SDK 继续拥有模型循环、工具执行和 JSONL 历史；未增加依赖，未修改锁文件或共享构建脚本。

## 已实现范围

| 范围 | 用户入口与行为 | 主要代码 |
| --- | --- | --- |
| 材料输入 | 主会话、侧聊和浮动输入框支持拖入文件、粘贴图片、`@` 文件/目录/同项目会话引用、`/` 命令和 Skill 补全 | `ComposerInput.tsx`、`attachment-input.ts`、`material-references.ts` |
| 附件可读性 | 每份附件独立显示解析范围、警告及输入方式。较小正文直接纳入原生用户消息；较大正文提供文件说明，通过 `read_document` 分节读取。原生实际用户消息匹配后记录 started 回执，扩展转换后不能核实的范围标记 unverified | `document-reader.ts`、`document-tools.ts`、`AttachmentDelivery.tsx` |
| 长任务自由导航 | 运行中可切换项目、会话和新建会话。任务中心汇总执行中、等待处理及未读结果；系统通知点击请求导航，提交完成后再切换。迟到响应、过期批准和旧浮动输入框动作有身份校验 | `session-attention.ts`、`ActivityCenter.tsx`、`main.ts`、`App.tsx` |
| 外部能力 | 设置 → 扩展中维护 MCP stdio/Streamable HTTP 配置，连接测试、工具清单及失败诊断。GUI 与原生模型工具使用同一控制器。提供 `web_fetch`，以及显式配置 Brave Key 后的 `web_search` | `external-capabilities.ts`、`external-capabilities-network.ts`、`CapabilitiesPanel.tsx` |
| 文件交付 | 本轮非代码改动生成成果卡，支持查看和系统打开。文件工作区提供 PDF 页面位图、Office 内容结构、Excel 工作表/隐藏表/单元格及 CSV 预览；CSV 仍可切回源码编辑 | `Deliverables.tsx`、`DocumentPreview.tsx`、`FileWorkspace.tsx` |

`@` 目录引用提供明确目录路径，由模型使用工作区工具继续读取；不宣称已递归读完整个目录。同项目会话引用只提供最近 20 条消息的文字部分，最多尾部 48 KiB，并显示真实来源摘要及范围。

## 边界与限制

- 附件单条最多 20 份、单个 10 MiB、合计 20 MiB；正文和附件说明合计最多 128 KiB。侧聊增量合并也检查合计限制，保留已有冻结快照；新增附件检查预期 Hash，避免悄悄替换源内容。
- PDF 使用 macOS PDFKit：支持文字层和页面预览，未实现 OCR。Office 预览按文字/表格内容组织，不还原原始排版或内嵌对象语义；旧 `.doc/.xls/.ppt` 提示转换后重试，可系统打开。
- DOCX 含尚未转换的 `altChunk` 导入正文时明确拒绝完整读取，须用 Word 打开并另存后重试；不静默遗漏导入内容。
- XLSX 包含隐藏和 veryHidden 工作表、稀疏有效单元格、公式及保存的缓存值；不重新计算公式、不还原格式或图表。图表工作表、ZIP64 等不支持的结构明确报错。
- 解析资源限制见 `DOCUMENT_LIMITS`；超限失败，不将截断预览冒充完整源内容。每个主机独立维护有界缓存，每次读取校验真实文件 Hash。
- MCP 配置支持显式环境变量和 HTTP 请求头。无专用 OAuth 登录界面和旧 SSE 传输。Pi 状态诊断依赖固定版本公开 `/mcp` 状态输出，升级 SDK 时须重跑兼容测试。
- Web 读取执行有界 HTTP(S) GET，限制重定向、内容和时间，并校验 DNS/私网地址。Brave 搜索无隐式凭据或默认供应商回退。
- 活动中心状态属于本次桌面运行；过期或退出的运行时交互不会从历史恢复为可批准请求。
- CSV 预览读取已保存文件；未保存时显示提示，保存成功后刷新预览。

## 集成修复

- 旧队列/侧聊附件及原生 started 回执继续支持旧 Base64 Hash；文档工具用同一份源字节验证新旧 Hash，实际文件变化仍拒绝。
- XLSX 按单次 ST_Xstring 解码还原共享、内联和公式缓存字符串；CSV 在字段入队时检查百万单元格限额。
- 归档、删除后的自动选择及原史重定位沿用导航代次，迟到启动不会覆盖用户后续选择。
- MCP 注册前脱敏描述、参数说明及命名空间说明；参数结构包含凭证时拒绝公开，保留参数语义。进度和最终结果按内容值脱敏，保留原生内容结构。
- 原生 MCP 资源工具也检查服务停用/移除和配置变化，临时会话统一走一次 MCP 审批。

格式依据：[Microsoft altChunk](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.altchunk?view=openxml-3.0.1)、[Microsoft ST_Xstring](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/bd0aa042-434a-4ca7-b25f-4e1fd25a954d)。

## 验证与证据

使用仓库固定 Node 24.15.0 / npm 11.12.1、Pi SHA `eb326d265ae0b88489a6d10319307780df827cdf`。

```sh
export PATH="$PWD/.cache/toolchain/node-v24.15.0-darwin-arm64/bin:$PATH"
npm run typecheck
npm run build
npm test
git diff --check
node scripts/package-desktop.mjs --require-clean --no-zip --app-name <唯一应用名> --bundle-id <唯一应用标识>
```

最终固定提交的测试日志、候选/制品摘要、安装包路径统一记录在开发工作树 `.artifacts/ux-materials-tools/handoff.json`。整套测试覆盖真实 Pi SDK 与本地假供应商、MCP 协议、原生 JSONL 输入和工具结果；假供应商通过不等于真实模型验收。

开发候选交接时尚未完成 Computer Use、真实模型和真实 Brave 搜索验收。集成会话独立记录最终候选的测试、制品和客户端证据；不以源码或静态渲染代替实际验收。按用户更新的规则，可以使用共享桌面和控制通道，但应用名称、Bundle ID、数据目录及实际进程/窗口必须明确绑定。Brave 未配置时，验收明确提示不可用的行为。

## 集成验收步骤

1. 在集成会话自己的工作树接收固定候选；若候选或主分支变化，重新运行完整本地检查并重新打包。保留其他会话工作，依赖/锁文件/共享脚本仅由集成会话处理。
2. 在可用桌面和控制通道上，使用唯一应用名称、Bundle Identifier 及数据目录。记录候选提交、Pi SHA、制品 Hash、App 路径、实际进程和窗口身份。
3. 使用明确配置的真实模型：拖入小 DOCX+含隐藏表 XLSX，核对解析状态和实际模型可见原文；再发送超内联预算的材料，核对真实 `read_document` 分页、隐藏表尾部及工具记录。测试图片粘贴、错误文件、Hash 变化、Stop 解析中、侧聊增量和浮动输入框。
4. 启动长任务后切换项目、新建/切换会话，验证任务继续运行、原会话草稿隔离；从任务中心/系统通知返回，核对完成/失败/等待批准/过期批准，提交期通知不能跳走。
5. 在设置中添加真实可用 MCP，测试成功/失败、工具列表、明确批准/拒绝及会话切换；验证真实模型调用 `web_fetch`。配置用户授权的 Brave Key 后验证 `web_search`。
6. 让模型生成 PDF/DOCX/PPTX/XLSX/CSV，核对成果卡、全部工作表/分页、预览与系统打开。CSV 修改后应保留源码编辑流程。
7. 保存实际操作步骤、关键截图和源/制品绑定信息。全部验收通过后仅由集成会话创建 PR、合入远端 main，并核对远端结果；在此之前不标记项目完成。

开发工作树中的 `node-pty` 安装后需确认 `prebuilds/darwin-arm64/spawn-helper` 可执行；本次仅修正工作树内安装产物的执行位，未修改依赖或共享脚本。打包脚本会追加包内 SDK/后台学习/PTY 冒烟检查。
