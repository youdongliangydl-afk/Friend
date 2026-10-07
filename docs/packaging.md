# 本地交付打包

使用 Node 24.15.0 / npm 11.12.1。先运行 `npm run bootstrap`，按项目构建流程显式安装 Electron 下载生命周期，再执行测试和构建。下面的打包脚本不创建远端、不发布 npm、不签名或公证。

```sh
node scripts/package-plugins.mjs
node scripts/package-desktop.mjs
```

四个 npm tarball 和解包后的安装目录位于 `.artifacts/packages`，清单为 `manifest.json`。`.artifacts/mac/Friend-Pi.app` 是自包含 macOS arm64 客户端，旁边的 `delivery-manifest.json` 记录源码、Pi、运行时和制品摘要；默认还生成 zip。

## 插件安装

Pi 将本地 `.tgz` 视为扩展文件，**不会自动解包**。应安装解包后的包目录：

```sh
mkdir -p /absolute/path/plugins/swarm
tar -xzf /absolute/path/friend-pi-swarm-VERSION-HASH.tgz -C /absolute/path/plugins/swarm
pi install /absolute/path/plugins/swarm/package
```

另外三个包使用同样步骤。也可以直接安装打包脚本已生成的 `.artifacts/packages/unpacked/<插件>/package` 绝对路径。宿主使用本项目锁定 Pi 1.0.4 的公开接口与 Node 24.15，Pi 和 Typebox 来自宿主 peer；包中不携带第二份 Pi。

默认打包在系统临时目录建立独立 Pi 宿主，复制锁定依赖闭包，逐个运行真正的 `pi install <directory>`，从其配置加载唯一插件，再由 Pi SDK 与显式 fake Provider 执行该插件的 `snapshot` 模型工具。该宿主位于项目外，没有 workspace aliases 或开发目录的依赖回退。结果记录在清单；`--skip-install-test` 明确标记该检查未运行。

## 桌面包内容

```text
Friend-Pi.app/Contents
├─ MacOS/Friend-Pi             Electron 主入口
└─ Resources
   ├─ runtime                Node 24.15.0、npm 11.12.1、npx 和原始许可证
   └─ app
      ├─ apps/desktop/dist    主进程、preload、SDK worker、renderer
      ├─ packages             四插件和普通 core 库的构建输出
      ├─ node_modules         锁文件的实际运行依赖与实体本地包
      ├─ .cache/pi/artifacts  相同源码的完整固定 Pi tarball 集
      ├─ third-party-licenses Pi、Node、Electron/Chromium、React 及依赖记录
      └─ build-info.json      构建候选身份
```

打包离线复制锁文件对应的实际 production 依赖，校验版本和完整 Pi tarball 摘要，并重新解包规范 Pi 文件。Workspace 包复制为实体目录；所有 symlink 必须仍在 `.app` 内。自带 Node 从仓库外 smoke import SDK/core，并运行自带 Pi CLI 的 `--version`。客户端默认使用自身 runtime 与独立 Friend-Pi 用户目录；QA 可以明确覆盖环境变量。Electron 主入口中不允许开发机 checkout 的绝对路径。

上游 Electron 二进制和 framework 保持原发行内容；只改应用标识并移除外层继承签名。不执行项目签名或公证。原始 npm/Node 及 Electron/Chromium 的许可证随包保存，浏览器中内联的 React 许可证另行保存。

## 最终候选与摘要

首次未提交开发工作允许初测打包，但会记录 `commit:null` 或 `dirty:true`，不能当作最终交付。最终使用：

```sh
node scripts/package-plugins.mjs --require-clean
node scripts/package-desktop.mjs --require-clean
```

`--require-clean` 要求已提交干净候选、与构建信息一致的 commit，以及 sourceDirty=false。打包期间源码变化会停止，保留 stage。已有制品保留为 previous 文件；运行中的交付客户端不会被替换。`--skip-build` 只用于已验证的相同构建候选。

`.app` 摘要使用 `sha256-tree-v1`：按相对路径顺序遍历，依次哈希条目类型、相对路径、权限、文件 SHA256 或链接原始目标。具体字节清单在 `files.json`。Zip 和插件 tarball 使用普通文件 SHA256/SHA512。摘要不包含外部验证报告，因此补充 GUI 证据不会改变制品自身身份。

打包检查不代表 GUI 或真实模型验收。交付报告必须另外绑定此清单中的准确 commit、Pi SHA、应用 hash，以及真正执行的 Computer Use 与真实模型旅程；未运行项目需明确记录。
