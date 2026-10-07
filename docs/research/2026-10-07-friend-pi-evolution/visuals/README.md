# Friend-Pi 演进规划对比图

本目录包含 19 个优化点，每点有 before / after / comparison 三个 SVG。全部为产品布局示意，采用示例数据，**不是新客户端截图**；after 与 comparison 都明确标注未来未实现。当前依据源码及实测记录，证据 ID 在 manifest.json / catalog.json 中。真实截图由 Root 统一采集与管理。未来图统一采用用户明确的单入口、五个轻量 tabs，管理与长期配置放设置，不展示 Context tab；第 19 点标为用户已选方向，仍未实现。

生成器只写本目录；可选 PNG 只写 `.artifacts/qa/evolution-audit/report-render`。不修改业务代码、不调用 GUI、不读取凭据。

```sh
python3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py

# 只重建选定优化点；--catalog 可覆盖标题、当前/未来说明及证据 ID
python3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py --only 01,04 --catalog docs/research/2026-10-07-friend-pi-evolution/visuals/catalog.json

# 可选离线 PNG，使用已有 Pillow，不调用浏览器或真实 GUI
/Users/youdongliang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 docs/research/2026-10-07-friend-pi-evolution/visuals/generate_visuals.py --render-dir /Users/youdongliang/Desktop/Friend-Pi/.artifacts/qa/evolution-audit/report-render
```

`index.html` 是离线图集，无外部脚本。`validate_visuals.py` 可重新核对 19 点摘要、XML、文字边界和统一工作台约束，结果只写 QA 的 report-render 目录。`manifest.json` 记录 SVG/PNG 摘要和固定候选身份。`--font` 可指定支持中文的 TrueType/TTC 字体，`--scale` 指定 PNG 比例。SVG 生成不依赖 Pillow。

局部重建会使 manifest/index 只列出本次选择的图；完整交付前再次不带 --only 生成全 19 点。不要将 before 示意当成原始截图，也不要把 after 视为已实现。
