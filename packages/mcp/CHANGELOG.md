# Changelog

All notable changes to `@agentic/mcp` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- MCP client: `createMcpClient({ url, auth })` — Streamable HTTP over `fetch` (edge-safe), `tools()` mapping `tools/list` to `@sigx/ai` `defineTool({ jsonSchema, annotations })`, `callTool`, `capabilityReport()` with every unsupported operation enumerated, `McpError` / `McpTransportError` / `McpToolError`.
- `@agentic/mcp/node`: `createStdioMcpClient({ command, args })` — the stdio client for the daemon, spawned through `@sigx/ai-agent-node`.
- `mcpConnector(...)`: the `PluginManifest` (kind `connector`) for one server with declared permissions and `unsupported:<op>` capabilities.
- Hardening: a JSON response with an unparsable body is an `McpTransportError`; per-request abort listeners are removed from a long-lived caller signal once the request settles; required-argument checks count own properties only.
