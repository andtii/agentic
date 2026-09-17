# Changelog

All notable changes to `@agentic/mcp` (Keep a Changelog, semver).

## [Unreleased]

- Platform MCP server (#50, `src/server`): `createPlatformMcpHandler({ authenticate, port, resourceMetadataUrl })` — the orchestration surface at `/_agentic/mcp` over `@sigx/ai-agent/harness`'s `createMcpToolHandler`, one tool set per authenticated external principal; a missing or bad bearer is a 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728) so an MCP client can discover the OAuth server; `tools/list` carries `readOnlyHint` / `destructiveHint` / `idempotentHint` merged from the tools' annotations. `platformTools(port, principal)`: `machines_list`, `environments_list/doctor`, `agents_list/get`, `sessions_open/prompt/respond/cancel/tail`, `tasks_create/delegate/get/tree/cancel`, `chats_post/history`, `memory_search/remember`, `schedules_create` — `<family>_<op>`, the family is the OAuth scope that gates it (`McpScopeError` → `isError` result naming the scope); `sessions_open` requires an explicit `machineId` + `environmentId` (EXE-12); `sessions_tail` is a bounded page with a `next` cursor. `PlatformPort` / `PlatformPortFactory` is the seam the app binds to the actors. `tasks_delegate(taskId, agentId, objective, …, callId?)` delegates from an active task (COL-03, #39) and returns the child; `environments_doctor(machineId, environmentId?)` is the machine's doctor report (#43). `PLATFORM_MCP_UNSUPPORTED` lists the declared gaps: resources, prompts.

- Package skeleton.
- MCP client: `createMcpClient({ url, auth })` — Streamable HTTP over `fetch` (edge-safe), `tools()` mapping `tools/list` to `@sigx/ai` `defineTool({ jsonSchema, annotations })`, `callTool`, `capabilityReport()` with every unsupported operation enumerated, `McpError` / `McpTransportError` / `McpToolError`.
- `@agentic/mcp/node`: `createStdioMcpClient({ command, args })` — the stdio client for the daemon, spawned through `@sigx/ai-agent-node`.
- `mcpConnector(...)`: the `PluginManifest` (kind `connector`) for one server with declared permissions and `unsupported:<op>` capabilities.
- Hardening: a JSON response with an unparsable body is an `McpTransportError`; per-request abort listeners are removed from a long-lived caller signal once the request settles; required-argument checks count own properties only.
