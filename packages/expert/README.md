# @friend-pi/expert

## 本地安装

```sh
mkdir -p /absolute/path/plugins/expert
tar -xzf /absolute/path/friend-pi-expert-VERSION-HASH.tgz -C /absolute/path/plugins/expert
pi install /absolute/path/plugins/expert/package
```

Pi 不会自动解包本地 `.tgz`。也可直接安装 `.artifacts/packages/unpacked/expert/package` 的绝对路径。使用 Node 24 和本项目锁定的 Pi 1.0.4 宿主；Pi/Typebox 为 peer。

独立 Pi Package。加载 `dist/index.js` 后，GUI、`friend_expert` 模型工具和 `/expert` 命令都使用同一控制器。五类内建文本方法是规划、研究、实现、审查和整合；默认提供方法目录，明确选择时采用对应正文。

用户管理定义、选择、启停、回滚和验证基准；模型不能通过候选提交绕过管理权限。项目对内建方法的编辑为项目覆盖，其他项目保留原模板。更新使用 revision CAS，历史版本不被改写；回滚生成新版本。

启动时冻结专家定义、工具范围、Skill 的路径、实际 Markdown 正文和内容摘要。Skill 必须位于当前项目，不支持脚本或可执行权限成长。`use` 返回本次实际冻结正文和采用记录；后续文件变动不会悄然进入本次任务。明确选择的工具范围在 Pi `tool_call` 钩子中检查，也覆盖嵌套调用；`friend_expert` 自身仍可用于按需读取方法，其他插件工具不会被整体豁免。

Memory 的自动方法必须携带可回查来源和父记忆。`idempotencyKey` 在项目内绑定内容及来源摘要，重复投递不创建重复候选，不同内容使用同一标识会被拒绝。用户也可手动提交文本候选。

发布只依据用户提供的固定 JSON 基准：至少两个不同输入的适用案例和一个范围外反例。队列实际调用配置的模型，分别运行基础方法和候选方法；将响应与预期 JSON 做严格客观相等检查。发布保留案例快照、基准摘要、模型、逐例结果，且只在本项目范围启用。结果仅证明这些声明案例，不证明一般专业水平。

自动验证串行进行，SQLite 运行租约避免同数据目录下两个控制器并发验证。前台工作优先；可暂停，关闭时取消在途调用，模型调用失败不无限自动重试。进程异常后的在途验证恢复为待验证，不制造发布。来源纠正或遗忘撤回候选和派生方法；撤回期间的迟到响应不能发布。

```text
/expert select {"ids":["reviewer"]}
/expert create {"title":"项目审查","prompt":"检查项目约束","tools":["read","grep","find","ls"],"skills":["docs/review-method.md"]}
/expert settings {"paused":true}
/expert settings {"paused":false}
/expert validation.suite {"cases":[{"id":"a","kind":"positive","input":"独立案例一","expected":{"result":true}},{"id":"b","kind":"positive","input":"独立案例二","expected":{"result":true}},{"id":"outside","kind":"negative","input":"范围外案例","expected":{"result":false}}]}
```

Pi 和 Typebox 使用宿主 peer；不绑定特定 Provider，不复制 Pi loop。源码和设计参考见 SOURCES.md，以及仓库根来源记录。
