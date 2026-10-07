# Friend-Pi development

- Implement the approved four-plugin product in this repository only. Preserve the original Friend and reference repositories.
- Pi's public SDK and extensions own model execution and JSONL session history. Do not fork its loop or duplicate transcripts.
- Root agent owns package.json, lockfiles, packages/core, apps/desktop, shared build scripts, Git integration and GUI input. Plugin agents own only their assigned package and focused tests.
- Four plugins must work independently. Communicate through versioned Pi event-bus requests, not shared module singletons. GUI and model tools call the same controller.
- Use Node 24. Native plugins provide host Pi packages as peers and do not bundle Pi. Keep open-source license and source records.
- Default tests use a fake provider. Real models use only explicitly configured credentials; never print credentials.
- Never stash, reset --hard, clean -fd, overwrite unrelated changes, force push, publish npm or create a remote. Commit explicit owned paths.
- Final client evidence binds the exact candidate commit, Pi SHA, artifact hash and actual Computer Use journeys. Report unrun verification accurately.
