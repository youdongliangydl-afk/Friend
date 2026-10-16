# Expert source record

本包业务实现为 Friend-Pi 新代码，没有复制上游 Agent loop 或专家框架。

- [Pi](https://github.com/earendil-works/pi), `eb326d265ae0b88489a6d10319307780df827cdf`, MIT：公开扩展接口、事件总线、模型完成调用、原生会话自定义条目及工具调用钩子。
- [DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness), `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, MIT：角色/版本/协作研究来源，与根目录固定来源清单一并记录；未引用其运行时业务源码。
- [pi-workflow-roles](https://github.com/Akagilnc/ak-pi-workflow-roles), npm `@akagilnc/pi-workflow-roles@0.1.5698`, `89171f749e3f5afb526f59778c08cf82f7f329bd`, Apache-2.0：角色身份、显式模型映射与 typed submission 的研究来源。本包角色合同、范围守卫及交付校验为独立实现，没有复制其 Soul、CLI、账本或运行时源码。上游 Reviewer 可写入/安装/运行的取证授权不适用于本包的硬只读 Reviewer。

许可证和来源记录不代表上游项目保证本包专家效果。冻结方法和客观基准结果是本包提供的证据范围。

2026-10-17 profile/spawn API: `src/profiles.ts` is an independent Friend-Pi implementation of the approved unified preset contract. It reuses Core's versioned bus DTO, RecordStore and existing Expert Skill/source guards. No external code, model loop or transcript implementation was copied; Pi remains the execution/history owner.
