# 固定 Pi 底座

Friend-Pi 消费 Pi 的公开 SDK 与 Extension API，不复制 Pi Agent 循环，不修改参考仓库。`pi-source.lock.json` 固定源提交、运行工具版本、不可变模型目录及整套本地 tarball 摘要。主 `package-lock.json` 固定应用依赖，所有 Pi 的直接及传递依赖都通过官方 `use-local-packages.mjs` 指向相同源码构建出的本地包。

## 安装

使用 **Node 24.15.0 / npm 11.12.1**。macOS 本机已有的运行时可以加入 PATH：

```sh
export PATH=/Users/youdongliang/.local/opt/node-v24.15.0-darwin-arm64/bin:$PATH
node scripts/bootstrap-pi.mjs
```

脚本默认完成以下步骤：

1. 在 `.cache/pi/source` 独立 clone 锁定的 Pi SHA；检查 origin、提交及工作区干净状态。保留既有改动，遇到变化时失败，不 reset 或 clean。
2. 取得源码 `nix/model-catalog.json` 对应的不可变 typed catalog；下载及缓存均检查 SHA256，不回退到实时目录。
3. 在缓存源码运行 `npm ci --ignore-scripts`，调用官方 `hydrate-model-catalog.ts`，再以 `pack-packages.mjs --offline-model-data` 构建和打包所有公开 Pi workspace。
4. 验证 manifest 绑定 `source.commit` 与 `dirty: false`，逐个检查 tarball SHA512，并核对锁文件内的包身份和内容。
5. 调用官方 `use-local-packages.mjs` 写入相对 `file:` 依赖和全部 Pi overrides；核实应用外部依赖的精确公开 registry 版本，再运行 `npm ci --ignore-scripts`（首次无 lock 时使用 install）。
6. 检查最终 consumer lock 的 Pi 包都来自该本地产物集，并 smoke import `createAgentSession`。此检查不读取认证，也不调用模型。

Electron 的下载生命周期被默认跳过。桌面构建由项目主构建流程显式执行已审查的 `node node_modules/electron/install.js`。

## 核验与重复构建

```sh
node scripts/bootstrap-pi.mjs --verify-only
node scripts/bootstrap-pi.mjs --skip-install
node scripts/bootstrap-pi.mjs --reproduce --skip-install
```

`--verify-only` 检查缓存源码、模型目录、tarball 和现有 consumer lock，不调用模型。缓存目录齐全时无需联网。`--skip-install` 仅准备和连接 Pi，不安装应用依赖。`--reproduce` 从另一路径 `.cache/pi/reproduction-source` 独立构建，逐包比较两套 tarball 字节摘要；仅相同后写入 `.cache/pi/reproduction-evidence.json`。验证报告中的实际结果是发布证据，脚本能力本身不代表已完成该验证。

失败构建的输出目录会重命名为 `.incomplete-<timestamp>` 保留。缓存校验失败不会覆盖损坏数据；先检查并保留原文件，再选择全新的检出或缓存目录。

## 产物与入口

- 官方 Pi manifest：`.cache/pi/artifacts/manifest.json`。
- 源码及 license：`.cache/pi/source`。官方 tarball 未包含上游 LICENSE，发行时须将 `.cache/pi/source/LICENSE` 显式保存至项目的第三方许可目录并随客户端分发，README 致谢不能代替版权文本。
- 本地 SDK：`node_modules/@earendil-works/pi-coding-agent/dist/index.js`。
- 本地 CLI：`node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，也可 `node_modules/.bin/pi`。

普通 bootstrap 不跟踪远端 main，也不修改锁定版本。升级 Pi 必须显式核对新提交、模型目录和许可证，重新生成完整产物并记录所有摘要，再通过同候选客户端验证。

## 已执行的底座验证

2026-10-07 使用 Node 24.15.0 / npm 11.12.1，固定 `eb326d265ae0b88489a6d10319307780df827cdf`，完成两次独立远端 clone、官方 hydrate、offline build 和 pack；13 个 tarball 的完整 SHA512 均相同，两个源码工作区均保持干净。独立空白 consumer 安装后导入三个直接 SDK 包通过；复制出的损坏 tarball 被 bootstrap 拒绝。主项目 SDK 导入、CLI `--version`（1.0.4）和缓存核验通过。

原始证据分别在 `.cache/pi/bootstrap-evidence.json`、`.cache/pi/reproduction-evidence.json`、`.cache/pi/bootstrap-check-evidence.json`。这些证明 Pi 底座和安装链路，不替代插件独立测试、真实模型或同候选 Computer Use 验证。
