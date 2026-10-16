# Third-party notices

Friend-Pi's original controllers and desktop interface are newly authored; persistent Swarm teammate/mailbox, member roster and conversation tool disclosure interactions adapt MIT DeepSeek Harness code. Pi owns the Agent loop. Architecture references remain references; the ISC process backend identified below is retained separately. Pi's published SDK, runtime, model catalog and extension interfaces are consumed without modifying Pi source.

The machine-readable revision, license and use ledger is [docs/sources.json](docs/sources.json). npm package versions, download integrity and dependency relationships are fixed in `package-lock.json`; Pi tarballs and their source commit are fixed in `pi-source.lock.json`.

## Distributed dependencies

- DeepSeek Harness, commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, MIT, Copyright (c) 2026 DeepSeek. Adapted roster/mailbox and TeamAction interaction code is documented in Swarm SOURCES.md. Full notice is retained in Swarm DEEPSEEK-LICENSE and desktop third-party-licenses/deepseek-harness/LICENSE. Pi remains the execution runtime.

- DeepSeek Harness, commit `4878cdabd87d4041bdaff61d04c966883b9fd07a`, MIT, Copyright (c) 2026 DeepSeek. Conversation process grouping, activity summaries and two-level tool disclosures adapt the UI files recorded in `docs/sources.json`; the same complete DeepSeek MIT notice above is retained in the desktop artifact. Pi history and execution remain authoritative.

- [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks), version 2.6.9, ISC. The original compiled process backend is retained under `third-party/pi-background-tasks`; its LICENSE, upstream notices, source integrity and documented host adaptations are copied into `third-party-licenses/pi-background-tasks` in the app. Only ordinary process execution is enabled; no delegate, Fusion or attribution extension is activated.

- [Pi](https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/LICENSE), MIT, copyright 2025 Mario Zechner. The complete original MIT text is copied to `third-party-licenses/pi/LICENSE` in the application and `PI-LICENSE` in plugin tarballs. Official Pi tarballs do not themselves contain this root license.
- [Electron](https://github.com/electron/electron/blob/87cd122b5de69555831cd752578b810dd6e504d8/LICENSE), MIT. Electron's `LICENSE` and `LICENSES.chromium.html` are retained in `third-party-licenses/electron`. Packaging replaces only the outer application seal with a local ad-hoc signature required for ARM64 execution, preserving upstream nested framework signatures. No Developer ID certificate, distribution signing or notarization is used.
- [Node.js](https://github.com/nodejs/node/blob/848430679556aed0bd073f2bc263331ad84fa119/LICENSE), original full license including its bundled component notices, copied to `third-party-licenses/node/LICENSE` and the runtime.
- [npm CLI](https://github.com/npm/cli/blob/a62dc76bfd7cb797c6f3fb7c0dd11b8610034956/LICENSE), Artistic-2.0 and its bundled dependency licenses, retained under the packaged runtime.
- [React and React DOM](https://github.com/facebook/react/blob/1dd4ecbdabf826f527fc9a58c05ea70375b7d170/LICENSE), MIT. React, React DOM and scheduler licenses are retained for browser-bundled code.
- CodeMirror 6.0.2 and the locked CodeMirror language/state/view/search/Lezer packages, MIT; xterm.js 6.0.0 and addon-fit 0.11.0, MIT; node-pty 1.1.0, MIT with its bundled third-party notices. These power the editor, terminal browser display and independent Node24 PTY host. Original LICENSE files and node-pty nested notices remain in their packaged directories and are listed in the dependency ledger.
- Other runtime npm dependency directories retain their original license/notice files. `third-party-licenses/dependencies.json` records the actual packaged versions and available retained notice paths. This root project's MIT license does not replace any third-party license.

## Adapted interaction behavior

DeepSeek Harness, MIT, Copyright (c) 2026 DeepSeek, revision `4878cdabd87d4041bdaff61d04c966883b9fd07a`: changed-file hover/review behavior and preview placement formulas are adapted for Friend-Pi. Original license, exact source hashes and adaptation boundaries are retained under `third-party/deepseek-harness` and shipped in `third-party-licenses/deepseek-harness`. No DeepSeek runtime or model loop is bundled.

## Architecture references

OpenSwarm, MIT, fixed revision `ca0aeb278aee013b12f8e2db71b8d84261153168`, informs specialist routing and unified delivery. MiMo-Code revision `bf0563ddc201b44e3f59c35b18dba17c4386564d` informs progressive local retrieval and background organization. These are design references; no source is copied or runtime bundled.

Thanks to [OpenSwarm](https://github.com/VRSEN/OpenSwarm), [DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness), [MiniMax Code](https://github.com/MiniMax-AI/minimax-code), [ZCode](https://github.com/zai-org/ZCode), [Codex](https://github.com/openai/codex), [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code), [pi-gui](https://github.com/minghinmatthewlam/pi-gui), [pi-subagents](https://github.com/tintinweb/pi-subagents), [pi-agent-orchestrator](https://github.com/GroepOnline/pi-agent-orchestrator), and [Mem0](https://github.com/mem0ai/mem0). Their roles and checked immutable revisions are recorded in the ledger. Except for the specifically documented DeepSeek source adaptations above, references are not shipped frameworks or hosted-service dependencies, and no performance or correctness endorsement is implied.

The user's original Friend project informed client layout and scope. Its checkout, configuration and data remain separate; it is not bundled or migrated into this product.
