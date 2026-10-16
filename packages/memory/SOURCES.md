# Source record

This package is original Friend-Pi implementation using Pi public extension/SDK interfaces and the ordinary Friend-Pi runtime library. No third-party memory implementation has been copied or bundled.

Fixed design references:

- OpenAI Codex, `afb436df8b70bb5bc57b86d9a3e829968988cd21`, Apache-2.0: [write pipeline](https://github.com/openai/codex/tree/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/memories/write), [read projection](https://github.com/openai/codex/tree/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/ext/memories). Referenced extraction/consolidation separation, source snapshots, bounded retry, secret redaction and progressive retrieval. Friend-Pi keeps SQLite authority and does not copy Codex quota defaults, generated scripts or global file store.
- Xiaomi MiMo-Code, `6babeb0b98f9b4818bddf04a4331edfee04dbf85`, MIT, Copyright 2026 Xiaomi MiMo Code and 2025 opencode: [auto-dream](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/packages/cli/src/session/auto-dream.ts), [checkpoint](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/packages/cli/src/session/checkpoint.ts), [license](https://github.com/XiaomiMiMo/MiMo-Code/blob/6babeb0b98f9b4818bddf04a4331edfee04dbf85/LICENSE). Referenced detached background work, bounded pending ranges and success-only watermarks. MiMo actors are application fibers; Friend-Pi's independent Node host is a new adaptation, not a copied daemon. No MiMo tool/permission expansion is incorporated.
- DeepSeekHarness session-query and Mem0: source references and retrieval/update/deletion separation, as recorded in the root ledger. Neither hosted service is required.

Tests use synthetic data and public Pi faux providers. They do not verify real-model semantic quality, desktop Computer Use or packaged artifact identity; those are separate root-agent acceptance gates.

## Active-recall reference, 2026-10-12

Official XiaomiMiMo/MiMo-Code fixed commit `f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f`, MIT; Copyright (c) 2026 MiMo Code, Xiaomi Corporation; Copyright (c) 2025 opencode. Read the exact upstream files and license; this implementation borrows ideas only and copies no source code or prompt text.

- [tool/memory.txt](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/packages/cli/src/tool/memory.txt): a few distinctive search terms, complete body reading, original literal tracing. SHA256 `e78c35ac4d8f8b69190d3ba13f415090931a4a22d18c8f456a075f44612dd404`.
- [memory/fts-query.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/packages/cli/src/memory/fts-query.ts): literal quoted FTS terms and disjunction; Friend retains its own CJK bigrams, bounded term selection and existing matching modes. SHA256 `a6bba320bae3af8fcc5931e69060373fb6f544b19bc2effbaf1b24c48d4bdd2c`.
- [memory/service.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/packages/cli/src/memory/service.ts): BM25 ranking, scope filtering and retrieval limits. SHA256 `5fadc62b0ce14417ca09b306790cf20fb28ee58e0f07d03555d8fad0dfdf8e0a`.
- [tool/memory.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/packages/cli/src/tool/memory.ts): zero-hit explanation and full-body/original-reading guidance. SHA256 `e2aa8990bec8e70ca8321aa5dec48d3aa6a73e6702595449e505f5930598eff2`.
- [session/prompt.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/packages/cli/src/session/prompt.ts): conditional foreground recall reminder (`recallHintLines`, `buildRecallReminderText`, per-user-message reminder). SHA256 `622ac185cbec6d1fd4805ada697a9eec3ccd775249d292e708b6cf230b796fd8`.
- [LICENSE](https://github.com/XiaomiMiMo/MiMo-Code/blob/f98dcd1cf7e70e7eb42f721fdf72bc4a6b87914f/LICENSE), SHA256 `d7201a5532f4ce12324aec5469dc1dfe290654d085c2547bc7384932881ac448`.

Deliberately not adopted: upstream “hit is authoritative”, unregistered raw-history/SQL search, automatic scope widening, checkpoint/Topic/Rebuild coupling, vector/semantic recall, or an extra query-rewrite provider call. Memory checks effective revisions, source policy, complete conditions and permitted registered references. These are design references, not evidence of Friend model quality or acceptance.

## Contextual retrieval reference, 2026-10-17

Read-only source inspection used XiaomiMiMo/MiMo-Code fixed commit `bf0563ddc201b44e3f59c35b18dba17c4386564d`. MIT; Copyright (c) 2026 MiMo Code, Xiaomi Corporation; Copyright (c) 2025 opencode. Ideas only; no upstream source or prompt text is copied.

- [memory/service.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/bf0563ddc201b44e3f59c35b18dba17c4386564d/packages/cli/src/memory/service.ts): local FTS/BM25 and bounded scoped retrieval. SHA256 `5fadc62b0ce14417ca09b306790cf20fb28ee58e0f07d03555d8fad0dfdf8e0a`.
- [tool/memory.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/bf0563ddc201b44e3f59c35b18dba17c4386564d/packages/cli/src/tool/memory.ts): progressive full-body/original-source guidance and zero-hit boundaries. SHA256 `e2aa8990bec8e70ca8321aa5dec48d3aa6a73e6702595449e505f5930598eff2`.
- [tool/memory.txt](https://github.com/XiaomiMiMo/MiMo-Code/blob/bf0563ddc201b44e3f59c35b18dba17c4386564d/packages/cli/src/tool/memory.txt): distinctive query terms and literal recovery ideas. SHA256 `e78c35ac4d8f8b69190d3ba13f415090931a4a22d18c8f456a075f44612dd404`.
- [session/auto-dream.ts](https://github.com/XiaomiMiMo/MiMo-Code/blob/bf0563ddc201b44e3f59c35b18dba17c4386564d/packages/cli/src/session/auto-dream.ts): bounded background consolidation reference; Friend-Pi retains its existing independent learning pipeline and correction/forget/source-policy gates. SHA256 `d60ecc97ea89741343bd93580e56069f4137570aaea35dfc24696d3e332e6c64`.
- [LICENSE](https://github.com/XiaomiMiMo/MiMo-Code/blob/bf0563ddc201b44e3f59c35b18dba17c4386564d/LICENSE), SHA256 `d7201a5532f4ce12324aec5469dc1dfe290654d085c2547bc7384932881ac448`.

Explicitly excluded: authoritative-on-hit assumptions, automatic scope widening, arbitrary history/SQL inspection, provider query rewriting, embeddings, and replacing Pi JSONL. User relevance feedback and complete-condition semantic digests are original Friend-Pi implementation, not claims about upstream functionality or model/GUI acceptance.
