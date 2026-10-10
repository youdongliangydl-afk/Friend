# Friend-Pi development

- Implement the approved four-plugin product in this repository only. Preserve the original Friend and reference repositories.
- Pi's public SDK and extensions own model execution and JSONL session history. Do not fork its loop or duplicate transcripts.
- Development chats own their assigned scope. The designated integration chat owns dependency/lockfile changes, shared build scripts and final Git integration. Plugin subagents own only their assigned package and focused tests.
- Four plugins must work independently. Communicate through versioned Pi event-bus requests, not shared module singletons. GUI and model tools call the same controller.
- Use Node 24. Native plugins provide host Pi packages as peers and do not bundle Pi. Keep open-source license and source records.
- Default tests use a fake provider. Real models use only explicitly configured credentials; never print credentials.
- Never stash, reset --hard, clean -fd, overwrite unrelated changes, force push, publish npm or create a remote. Commit explicit owned paths.
- Final client evidence binds the exact candidate commit, Pi SHA, artifact hash and actual Computer Use journeys. Report unrun verification accurately.

## 并行开发规则

- **任务分工**：用户向各开发会话分派任务，由唯一的集成会话协调依赖、修改范围和合码。
- **隔离开发**：每个开发会话及集成会话均使用自己的 Worktree 和分支，不修改其他会话的工作区。范围重叠先协调，依赖及锁文件由集成会话统一处理。
- **开发自测**：功能完成后，必须通过本地测试和 Computer Use 用户视角测试。涉及模型调用的功能，须使用明确配置的真实模型追加验收。
- **验收隔离**：各会话使用独立桌面环境和控制通道，验收客户端使用唯一应用名称、应用标识及数据目录。环境不可用或测试未通过时，不得声明验收完成。
- **代码交接**：自测通过后，以固定提交交接，附变更说明、测试结果、操作步骤和关键截图；证据须绑定提交、Pi SHA 和制品摘要。
- **统一集成**：集成会话逐项接收代码，负责冲突处理和验收问题修复，并对最终集成候选重新执行完整本地测试和 Computer Use 验收。
- **远端合码**：全部验收通过后，仅由集成会话创建 PR 并自主合入远端 `main`。候选或主分支发生变化时，重新集成验收。
- **完成确认**：核对远端合码结果并统一保存验收证据后，才标记完成；清理 Worktree 前须确保代码、证据及未提交内容不会丢失。
