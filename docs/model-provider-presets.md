# 模型厂商预配置

核验日期：2026-10-08。选择厂商后，公开地址、协议和默认型号预填，API Key 只进入 Pi 原生私有认证存储。勾选“设为新会话默认模型”时保存该默认值，不更换已打开会话的模型。连接测试由用户显式点击。

| 厂商 | 默认模型 | 配置来源 |
| --- | --- | --- |
| DeepSeek | deepseek-flash | [首次调用](https://api-docs.deepseek.com/en/) |
| OpenAI | gpt-6.1-sol | [模型](https://developers.openai.com/api/docs/models)、[调用](https://developers.openai.com/api/docs/quickstart) |
| Anthropic | claude-sonnet-5-5 | [API](https://platform.claude.com/docs/en/api/overview)、[模型](https://platform.claude.com/docs/en/models/overview) |
| Google Gemini | gemini-3.8-flash | [模型](https://ai.google.dev/gemini-api/docs/models)、[调用](https://ai.google.dev/gemini-api/docs/quickstart) |
| Moonshot / Kimi 中国 | kimi-k3 | [中国站 Key](https://platform.kimi.com/docs/get-api-key) |
| MiniMax 中国 | MiniMax-M2.7 | [Anthropic 接口](https://platform.minimax.cn/docs/api-reference/text-anthropic-api) |
| 阿里云百炼北京 / 新加坡按量 | qwen3.8-max | [地址与地域](https://help.aliyun.com/zh/model-studio/base-url)、[首次调用](https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen) |
| 智谱按量 | glm-5.3 | [模型文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3.md) |
| 火山方舟 | 用户已开通 Model ID / Endpoint ID | [鉴权与公开模型示例](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh) |

实际账号仍须开通相应模型。方舟的账户专属 `ep-…` 不公开，保留必填型号。未在 Pi 目录中的自定义型号采用应用保守容量 32768、输出 4096，不把它们描述成厂商上限。高级连接设置允许自定义地址和协议。

Pi 已支持的厂商只保存 Key，保留其完整模型目录、兼容参数和思考等级。百炼按量与智谱按量使用独立 provider，克隆目录中相同型号的兼容字段，分别使用通用接口而非套餐接口。GLM-5.3 禁止关闭思考，默认采用 Pi 支持的最低等级 `low`。MiniMax 中国从 Pi 旧内建域名迁至当前官方域名时只覆盖 Base URL，已有用户代理地址保留。

交互参考：原 Friend 只读快照 commit `c9fc2754a9321d035875f472ceded9566364b81b`、tree `f0d4f67950eb4eed190745bafdb44f44d685f3d0`。参考 `apps/desktop/src/renderer/ProviderSettings.tsx`（SHA256 `0e916f242967af32f5b1e1d245bca47f69c126e68ff598a9a4dcbb9c59fcefea`）和 `packages/core-host/src/provider-profile-authority.ts`（SHA256 `ddc197726343086f89f0a01349a9b68d50c9cde0ff4dba848e7e3489b9a58b7f`）的 Key 主入口与折叠高级参数；未复制其实现或修改快照。
