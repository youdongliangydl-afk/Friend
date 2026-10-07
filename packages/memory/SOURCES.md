# Source record

This package is original Friend-Pi implementation using Pi public extension/SDK interfaces and the ordinary Friend-Pi runtime library. No third-party memory implementation has been copied or bundled.

Fixed design references:

- OpenAI Codex, `afb436df8b70bb5bc57b86d9a3e829968988cd21`, Apache-2.0: [write pipeline](https://github.com/openai/codex/tree/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/memories/write), [read projection](https://github.com/openai/codex/tree/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/ext/memories). Referenced extraction/consolidation separation, source snapshots, bounded retry, secret redaction and progressive retrieval. Friend-Pi keeps SQLite authority and does not copy Codex quota defaults, generated scripts or global file store.
- Xiaomi MiMo-Code, `6babeb0b98f9b4818bddf04a4331edfee04dbf85`, MIT, Copyright 2026 Xiaomi MiMo Code and 2025 opencode: [auto-dream](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/packages/cli/src/session/auto-dream.ts), [checkpoint](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/packages/cli/src/session/checkpoint.ts), [license](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/LICENSE). Referenced detached background work, bounded pending ranges and success-only watermarks. MiMo actors are application fibers; Friend-Pi's independent Node host is a new adaptation, not a copied daemon. No MiMo tool/permission expansion is incorporated.
- DeepSeekHarness session-query and Mem0: source references and retrieval/update/deletion separation, as recorded in the root ledger. Neither hosted service is required.

Tests use synthetic data and public Pi faux providers. They do not verify real-model semantic quality, desktop Computer Use or packaged artifact identity; those are separate root-agent acceptance gates.
