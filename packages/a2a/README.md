# @agentic/a2a

A2A 1.0 (JSON-RPC binding) both ways, on the `@sigx/ai-agent` contract:

- **Server** — `createA2aHandler({ port })` is a `(Request) => Promise<Response>` fetch handler that gives every exposed platform agent an Agent Card and runs its sessions as A2A tasks: `SendMessage`, `SendStreamingMessage` (SSE), `GetTask`, `ListTasks`, `CancelTask`. It sits on a `SessionPort` (no actors here) and an optional `TaskStore`.
- **Client** — `a2aAgent(cardUrl | card, { fetch?, auth?, headers? })` is a remote A2A agent as an `Agent`: a session is a context, a `prompt()` is a task, `INPUT_REQUIRED` is a `request`, `cancel()` is `CancelTask`. Capabilities come from the card (AC-14).

Edge-safe: Web Streams and `fetch`, no `node:` imports. Design: `docs/architecture.md` §9. What may move into the sigx estate later: `docs/promotion.md`.

## Server

```ts
import { createA2aHandler, type SessionPort } from '@agentic/a2a';

const port: SessionPort = {
    agents: () => [{ id: 'helper', name: 'Helper', description: 'Answers questions.', promptParts: 'text+image' }],
    // A contextId IS a session: the same id returns the same live session while it runs.
    session: (agentId, contextId, request) => openPlatformSession(agentId, contextId, principalOf(request)),
    authorize: (request) => checkBearer(request) // optional; false → 401
};
const a2a = createA2aHandler({ port, basePath: '/a2a' });
export default { fetch: (request: Request) => a2a.fetch(request) };
```

Routes: `GET /.well-known/agent-card.json` (the only exposed agent, or `defaultAgentId`), `GET /a2a/{agentId}/.well-known/agent-card.json`, `POST /a2a/{agentId}` (JSON-RPC; SSE for `SendStreamingMessage`). Cards carry `Cache-Control` and an `ETag` (spec §8.6).

Every refusal is a JSON-RPC error with HTTP 200 — never a 500: `SubscribeToTask` and `GetExtendedAgentCard` answer `-32004` (UnsupportedOperation), the push-notification methods `-32003`, an unknown method `-32601`, bad parameters `-32602` with a `google.rpc.BadRequest` detail naming the field, an `A2A-Version` other than `1.x` `-32009`. The 0.3 method names (`message/send`, `tasks/get`, …) are accepted as aliases; responses are always 1.0 shapes.

### Mapping (session events → A2A)

| `@sigx/ai-agent` | A2A |
|---|---|
| session | `contextId` |
| turn (`prompt()`) | task; the task id is the turn id |
| `turn-start` | `TASK_STATE_WORKING` |
| `part-start` / `part-delta` / `part-end` (text, reasoning) | `TaskArtifactUpdateEvent` — one artifact per part, `append` chunks, `lastChunk` on end; `metadata.kind` names reasoning; in task snapshots a finished artifact carries `metadata.complete` |
| `request` (input or permission) | `TASK_STATE_INPUT_REQUIRED`; the request travels as a data part; the follow-up message on the task answers it |
| `tool-call`, `tool-update`, `ext`, `usage`, `error`, … | `TASK_STATE_WORKING` status whose message carries the event as a data part (`application/vnd.agentic.agent-event+json`) |
| `turn-end` | `COMPLETED` (`end_turn`, `max_tokens`, `max_turns`) · `FAILED` (`error`) · `CANCELED` (`cancelled`) · `REJECTED` (`refusal`); the result rides the terminal status as a data part |
| sub-agent events (`parentCallId`) | not exposed |

The data-part conventions are the **agentic extension**, declared on the card under `capabilities.extensions` (`required: false`) — a plain A2A peer sees text and files only.

## Client

```ts
import { a2aAgent } from '@agentic/a2a';

const agent = a2aAgent('https://helper.example.com', { auth: token }); // an origin or a card URL
await agent.connect();          // fetches the card; capabilities settle here
agent.capabilities;             // resume: false, cancel: true, tools: 'none', promptParts from defaultInputModes,
                                // permissions: 'harness-filtered' for an agentic peer, 'none' otherwise
agent.a2a;                      // { streaming, pushNotifications, extendedAgentCard, extensions, agentic, skills, unsupported }

const session = await agent.session({ contextId?: 'ctx-…', pollMs?: 500 });
for await (const e of session.prompt('Plan my trip.')) { /* text parts, tool events, requests */ }
```

A card without `capabilities.streaming` runs `SendMessage` (blocking) and polls `GetTask`. `INPUT_REQUIRED` becomes a `request` event; `session.respond()` sends a follow-up message on the task carrying the decision as a data part plus a plain rendering (text or data) for servers without the extension. `AUTH_REQUIRED` ends the turn with a recoverable `auth_required` error.

Declared unsupported (PLG-09, `A2A_UNSUPPORTED`): push notifications, `SubscribeToTask`, the extended card, the gRPC and HTTP+JSON bindings, resume, fork, structured output, client tools, sub-agents, steering, configure.

## Conformance

`__tests__/conformance.test.ts` runs `agentConformance` against `a2aAgent` over an in-process server built from `createA2aHandler` over `mockAgent` sessions: `text`, `slow-tool` (cancel), `input-request`, `tool-error`, `model-error`, `usage`, `busy-session`, `late-join`, `prompt-after-close` and `respond-unknown` pass; the rest are asserted skips (`resume: false`, no structured output, no client tools, no sub-agents, no steering).
