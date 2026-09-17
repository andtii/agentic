# @agentic/mcp

MCP client (consume servers as platform tools) and the platform MCP server (orchestration surface for external clients).

Design: `docs/architecture.md` §9. What may move into the sigx estate later: `docs/promotion.md`.

## Client

A configured MCP server becomes a set of `@sigx/ai` tools any runtime can use (PLG-07), with what the client does *not* do written down (PLG-09).

```ts
import { createMcpClient, mcpConnector } from '@agentic/mcp';

const github = createMcpClient({ url: 'https://api.githubcopilot.com/mcp/', auth: () => secrets.get('github.token'), toolPrefix: 'github_' });
const tools = await github.tools(); // AnyTool[] — tools/list mapped to defineTool({ jsonSchema, annotations, execute })
const report = await github.capabilityReport(); // { supported, unsupported: [{ op, reason }], offeredButUnsupported, … }
await github.close();
```

- **Streamable HTTP** (`createMcpClient({ url })`) runs on `fetch` only — edge-safe, no SDK. JSON and SSE responses, `Mcp-Session-Id`, `MCP-Protocol-Version`, DELETE on `close()`, `notifications/cancelled` on abort. `auth` is a bearer token or a function returning one.
- **stdio** lives on `@agentic/mcp/node` (Node only; the daemon's side): `createStdioMcpClient({ command, args, cwd, env })` spawns the server through `@sigx/ai-agent-node` (no shell, Windows `.cmd` shims resolved, allowlisted env, tree-killed on close) and speaks NDJSON JSON-RPC with `@sigx/ai-agent/harness`.
- Any other transport: `createMcpClient({ transport })`.

### Tool mapping

`inputSchema` is passed to `defineTool({ jsonSchema })` verbatim, so `required`, `enum`, `$defs` and friends reach the model untouched. The local Standard Schema checks only that the arguments are an object with every `required` key present (`SchemaValidationError` before anything hits the wire); the server does the full validation anyway. `readOnlyHint / destructiveHint / idempotentHint / openWorldHint` map to `ToolAnnotations` one to one. Names are sanitised to what providers accept (`fs.read` → `fs_read`) and optionally prefixed; a collision is an error. A result's `structuredContent` wins, else text blocks are joined, else the content blocks are returned as they are; `isError: true` becomes a thrown `McpToolError`, which the `@sigx/ai` engine hands to the model as a tool error.

### Errors

| Class | When |
|---|---|
| `McpError` | the server answered with a JSON-RPC error (`code`, `data`) |
| `McpTransportError` | HTTP status, network failure, expired session, dead process (`status`, `cause`) |
| `McpToolError` | the tool ran and reported `isError` (`tool`, `content`) |

### Unsupported, on purpose

`MCP_UNSUPPORTED_OPS` (and `capabilityReport().unsupported`) list every feature the client leaves out, each with a reason: resources, prompts, sampling, elicitation, roots, logging, completions, tasks, `list_changed` subscriptions, progress, the standalone GET stream, stream resumption, OAuth discovery. Server-initiated requests are answered `-32601`, never dropped; `onServerMessage` sees them. `capabilityReport().offeredButUnsupported` names the ones a given server actually advertises.

### Connector manifest

`mcpConnector({ id, name, transport: 'streamable-http', url, secret })` (or `transport: 'stdio', command, machine, secrets`) returns a `PluginManifest` of kind `connector` with permissions declared up front — `network:<host>` or `machine:<id>`, `secret:<name>`, `tools:<id>` — and `capabilities` listing what works plus `unsupported:<op>` for each gap (AST-09, PLG-04, PLG-09).

## Server

The platform MCP server (`/_agentic/mcp`, orchestration surface) is a separate issue; see `docs/architecture.md` §9.
