# Changelog

All notable changes to `@agentic/a2a` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- A2A 1.0 wire (`protocol`): JSON-RPC types, method names (0.3 names as aliases), error codes with `google.rpc.ErrorInfo` details, zod request validation answering `-32602` with the violating field, prompt part ↔ A2A part mapping, and the `agentic` extension (tool calls, requests, usage and the turn result as data parts, declared on the card with `required: false`).
- Server: `createA2aHandler({ port, basePath?, defaultAgentId?, tasks?, cancelWaitMs? })` fetch handler over a `SessionPort` — Agent Cards per exposed agent (well-known path, `ETag`, `Cache-Control`), `SendMessage` (blocking or `returnImmediately`), `SendStreamingMessage` (SSE), `GetTask`, `ListTasks` (filters, paging), `CancelTask`; `INPUT_REQUIRED` continued by a message on the task; `SubscribeToTask` / extended card answer `-32004`, push-notification methods `-32003`, never a 500. `memoryTaskStore()` default `TaskStore`.
- Client: `a2aAgent(cardUrl | card, { fetch?, auth?, headers?, id? })` — a remote A2A agent as an `@sigx/ai-agent` `Agent`: context = session, task = turn, SSE streaming or `SendMessage` + `GetTask` polling, `INPUT_REQUIRED` → `request`, `AUTH_REQUIRED` → recoverable `auth_required`, `cancel()` → `CancelTask`; capabilities from the card (AC-14) and `agent.a2a` with the declared-unsupported list `A2A_UNSUPPORTED` (PLG-09). Snapshots (stream opening, polls) emit only what an artifact gained, so a turn joined mid-artifact keeps one part.
- Passes the `agentConformance` subset (text, cancel, input-request, tool-error, model-error, usage, busy-session, late-join, prompt-after-close, respond-unknown) against an in-process server; the rest are asserted skips.
