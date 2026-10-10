# External capabilities source records

- Reviewed on 2026-10-10 against Friend's pinned Pi 1.0.4 source commit `eb326d265ae0b88489a6d10319307780df827cdf`.
- Pi public entry points: `createMcpExtension`, `DefaultResourceLoader.extensionFactories`, `ExtensionAPI.registerMcpServer`, `registerTool`, `tool_call`, and the documented non-TUI `/mcp` command. Pi owns protocol connections, tool execution and JSONL history. No Pi loop or MCP implementation was copied or forked.
- Public SDK example: <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/coding-agent/examples/sdk/14-codemode-mcp.ts>
- MCP extension contract: <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/coding-agent/src/extensions/mcp/index.ts>
- Public extension interfaces: <https://github.com/earendil-works/pi/blob/eb326d265ae0b88489a6d10319307780df827cdf/packages/coding-agent/src/core/extensions/types.ts>
- Pi is MIT licensed; its existing license and artifact provenance remain recorded in the repository's third-party records and `pi-source.lock.json`. No dependency was added by this change.
- Brave Search API: <https://api-dashboard.search.brave.com/app/documentation/web-search/query>. The implementation uses the documented Web Search GET endpoint, `q`/`count`, `X-Subscription-Token`, and `web.results` URL/title/description fields. No provider client code was copied.
- Web reads use Node's standard DNS and HTTP(S) libraries, with validated addresses pinned to each connection. HTML is reduced to inert text; linked resources and scripts are not executed.

## Compatibility and acceptance boundaries

- Pi 1.0.4 has no exported MCP connection-state snapshot. Friend uses the public `/mcp` non-TUI status output for diagnostics and parses only its known state labels. The focused tests include connected servers with zero tools and failed stdio servers; rerun them when upgrading Pi.
- MCP GUI configuration supports stdio and Streamable HTTP plus explicit environment variables/request headers. It does not provide a dedicated OAuth sign-in screen or legacy SSE transport.
- Unit and SDK-worker tests use an offline model or a local fake HTTP provider. They do not establish real model or packaged desktop acceptance.
- Live public `web_fetch` was checked against `https://example.com/`; real Brave search requires an explicitly configured user key and was not run with user credentials.
