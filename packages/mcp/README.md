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

`mcpConnector({ id, name, transport: 'streamable-http', url, secret?, headerSecrets? })` (or `transport: 'stdio', command, args?, machine?, secrets?, envSecrets?`) returns a `PluginManifest` of kind `connector` with permissions declared up front — `network:<host>` or `machine:<id>`, `secret:<name>`, `tools:<namespace>` — and `capabilities` listing what works plus `unsupported:<op>` for each gap (AST-09, PLG-04, PLG-09). Every credential is a declared `manifest.secrets` entry; the config holds only the endpoint (`url`, or `command` / `args` / `cwd`) — no `headers`, no `env`.

To add a server the app stores what `mcpConnectorSetup(options)` returns: `Registry.register(manifest, { enabled: true, grant: 'declared' })`, `Registry.putConnector(connector)` (same id; `connector.auth` binds each secret name to the bearer, a header or an environment variable), then `Registry.setSecret(name, value)` for each `manifest.secrets` entry.

### A connector on a session

`openMcpConnector({ id, url, bearer?, headers?, fetch?, timeoutMs? })` → `{ tools, toolNames, close }` connects, lists and namespaces every tool `<id>__<tool>` (`connectorToolPrefix(id)`; an id with a `.` becomes `_`), with one deadline (default 10 s) for the handshake and the list. The platform injects it as the `connectors` opener of its local runtime (`apps/web/src/plugins/catalogue.ts`); credential values arrive already opened and go only into request headers. **Not yet:** stdio connectors on the daemon, and connectors on daemon-hosted sessions (#280).

## Server

The platform MCP server — the orchestration surface (`docs/architecture.md` §9, #50): an external MCP client (Claude Code on a laptop, any orchestrator) drives every daemon on every machine through the same actor methods the web UI uses.

```ts
import { createPlatformMcpHandler, type PlatformPortFactory } from '@agentic/mcp';

const port: PlatformPortFactory = (principal) => createActorPlatformPort(principal, { actors }); // apps/web binds it to the actors
const mcp = createPlatformMcpHandler({ authenticate: (request) => oauth.verify(request), port, resourceMetadataUrl: oauth.resourceMetadataUrl });
// mount: every method of /_agentic/mcp → mcp(request)
```

- **Transport**: `@sigx/ai-agent/harness`'s `createMcpToolHandler` — Streamable HTTP, JSON responses, tools only, stateless (GET/DELETE are 405, which the official client accepts). Built per request for the authenticated principal, so the tool set and the scope decision are made for that identity.
- **Auth**: bearer = the OAuth 2.1 access token from `@agentic/platform`'s `createOAuthServer` (RFC 8414 / 7591 / 9728, PKCE). No or bad token → 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/_agentic/mcp"`, which is where an MCP client starts discovery; `claude mcp add --transport http agentic https://<origin>/_agentic/mcp` then registers itself and opens the browser for login + consent.
- **Tools** (`platformTools(port, principal)`), named `<family>_<op>` because provider tool names cannot carry a dot; the family is the OAuth scope that gates it — a call without it is an `isError` result naming the scope, never a silent no-op:

  | Family / scope | Tools | Hints |
  |---|---|---|
  | `machines` | `machines_list` | readOnly |
  | `environments` | `environments_list(machineId?)`, `environments_doctor(machineId, environmentId?)` | readOnly |
  | `agents` | `agents_list`, `agents_get(agentId)` | readOnly |
  | `sessions` | `sessions_open(agentId, machineId, environmentId, cwd?, objective?)`, `sessions_prompt(sessionId, text)`, `sessions_respond(sessionId, requestId, decision)`, `sessions_cancel(sessionId)`, `sessions_tail(sessionId, from?, limit?)` | open/prompt/respond write, cancel destructive, tail readOnly |
  | `tasks` | `tasks_create(agentId, objective, environmentId?, context?, constraints?)`, `tasks_get`, `tasks_tree`, `tasks_cancel`, `tasks_delegate(taskId, agentId, objective, context?, constraints?, environmentId?, callId?)` | get/tree readOnly, cancel destructive |
  | `chats` | `chats_post(chatId, text, mentions?)`, `chats_history(chatId, cursor?, limit?)`, `chats_file_get(chatId, fileId)` | history, file_get readOnly |
  | `memory` | `memory_search(scope, …)`, `memory_remember(scope, kind, text, …)` | search readOnly |
  | `schedules` | `schedules_create(title, kind, recurrence, agentId?, environmentId?, prompt?, offlinePolicy?)` | write |
  | `usage` | `usage_limits(machineId?, runtime?)`: every account's provider limits (`UsageLimits`: per account its snapshot's windows with `utilization`, `status`, `resetsAt`, plus `ageMs`), #272 | readOnly |

  `tools/list` carries the hints as MCP `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`), merged by the handler until the harness emits them itself (signalxjs/ai#37). Machine selection is explicit in every call that opens execution (EXE-12): `sessions_open` needs the machine AND the environment, and the app's port refuses a machine that does not report the environment. `sessions_tail` returns a bounded page (default 100, max 500) with a `next` cursor and `truncated`.
- **Chat files** (`chats_file_get`, #209): attachments appear in `chats_history` as `image` / `file` parts whose `url` is an `agentic-file:<chatId>/<fileId>` URI, never bytes. `chats_file_get` asks the chat first (`PlatformPort.chats.fileAccess` → `Chat.fileAccess` as the client: every posted file, its own pending uploads; missing and not visible are the same `not found` error), then reads the bytes from the `files` store passed to `createPlatformMcpHandler({ …, files })` — the same `ChatFileStore` the actors write. `content[0]` is always a JSON summary text block, `{ file, uri, kind, truncated?, note? }` (also the `structuredContent`); for a text-like file `content[1]` is a text block with the file's text (cut at 256 KB, flagged `truncated`), for a JPEG / PNG / GIF / WebP an MCP `image` block (base64); anything else is the summary alone (`kind: 'metadata'`). Without a store the record comes back with the note `file bytes unavailable on this host`; without `fileAccess` on the port the call is an error.
- **`PlatformPort`**: the seam the tools call (`machines.list`, `sessions.open`, `tasks.create`, …), one instance per principal (`PlatformPortFactory`). Tests hand in fakes; `apps/web/src/auth/oauth-server/port.ts` is the real one over `actor()`.
- **Declared gaps** (`PLATFORM_MCP_UNSUPPORTED`, PLG-09): MCP resources and prompts — `sessions_tail` is the only read stream. `tasks_delegate` is `Task.delegate` on the parent (COL-03, #39) + `Routing.run` on the child; `environments_doctor` is `Machine.doctor` (#43): the daemon's isolation/auth verdicts as last reported, with `unverified` for environments that sent none.
