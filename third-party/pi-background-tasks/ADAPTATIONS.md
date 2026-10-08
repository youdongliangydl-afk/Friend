# Friend host adaptations

Upstream: pi-background-tasks 2.6.9, ISC. Original npm metadata, tarball URL, SHA-1 and SHA-512 integrity are retained in SOURCE.json. upstream-package.json and original compiled source/maps are retained for comparison.

The desktop adapter activates only `PI_BG_FEATURES=process`. It hides upstream tools, commands, shortcut, UI and automatic model messages. Friend's runtime controller owns presentation, continuation, session ownership and shutdown. It does not load attribution/delegate/Fusion extension factories or install an older Pi to satisfy the published peer range. Host compatibility is verified against the locked Pi 1.0.4 SDK with isolated fake-provider and ordinary-process tests.

Three localized compiled-source adaptations:

- dist/src/extension.js: package identity is pinned to the retained 2.6.9 metadata because the SDK bundle relocates import.meta.url.
- dist/src/extension.js: registry onChange emits a private `friend-pi:process-ownership:v1` event containing only admitted process identity, allowing the Electron supervisor to retain process-group ownership.
- dist/src/core/registry.js: onChange runs immediately after capturing a spawned child, before asynchronous admission metadata. Late admission cannot leave an unowned child after a worker crash.

No Pi runtime source was modified. Original source maps describe the upstream build; these three host adaptations are described here rather than represented as an upstream release. The original full backend LICENSE and THIRD_PARTY_NOTICES.md are retained in the packaged app.
