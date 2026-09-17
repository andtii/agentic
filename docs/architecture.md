# Architecture — Unified Agent Platform

Status: v1 design, 2026-09-17. Requirements: [`requirements.md`](requirements.md). Decisions: [`decisions.md`](decisions.md). Promotion candidates: [`promotion.md`](promotion.md).

Every sub-issue of the tracking issue names the section here it implements. A section is the contract an implementing agent works to; change the section in the same PR when a seam changes.

## 1. Package layout

pnpm monorepo, `@agentic/*`, all private.

```
apps/web               sigx SSR + serverFn + actors host on Cloudflare (Worker + ActorHost Durable Object in one bundle); UI on @sigx/zero + zero-daisyui
apps/daemon            Node 22 bin `agentic-daemon` (pair | run | doctor); Windows first
packages/core          edge-safe types + tiny helpers, zero deps: ids, AgentConfig, ChatEntry, TaskState/WaitReason/TaskContract, EnvironmentDescriptor, CapabilityReport, PluginManifest, MemoryPlugin/LearningPlugin interfaces, daemon frame types, Principal kinds
packages/platform      defineActor definitions + services: Workspace, Agent, Chat, Task, Session, Machine, Schedule, Memory, Inbox, Ledger, Registry, Audit; auth helpers
packages/runtimes      runtime adapters: 'anthropic-api' (modelAgent), 'claude-code' (daemon driver); platform tools (memory.*, delegate, chat.post, task.report, ask_user)
packages/memory        default MemoryPlugin (Memory-actor backed, BM25-ish + recency, no embeddings) + memoryConformance
packages/learning      default LearningPlugin (corrections → lessons; proposals needing review)
packages/daemon-protocol  envelope validators + daemonConformance (types live in core)
packages/ui            @agentic/ui: zero fragment (ai-thread, ai-message, ai-composer, ai-tool-call, ai-reasoning, ai-approval) + layout shell (Stack/Row/Col on data-l-*) + StreamingMarkdown on @sigx/markdown
packages/mcp           MCP client (Streamable HTTP, edge-safe; stdio on the daemon) + platform MCP server (orchestration surface)
packages/a2a           A2A 1.0 JSON-RPC server (agent card + tasks) + client adapter implementing the @sigx/ai-agent Agent contract
```

Rules:

- `packages/*` never import the `sigx` umbrella (it drags `@sigx/runtime-dom/platform`). Peer on `@sigx/runtime-core` / `@sigx/reactivity` / `@sigx/actors` only, so packages stay edge-safe and renderer-neutral. Only `apps/web` and `packages/ui` touch the DOM.
- Import order (downward only): core ← daemon-protocol ← memory / learning ← runtimes ← platform ← apps.
- Source layout as in signalxjs/ai: one folder per concern, `index.ts` is the public surface, entry points are folders.
- Every sigx-estate version comes from the `catalog:` in `pnpm-workspace.yaml`.

## 2. What we build on (do not redesign)

- `@sigx/ai-agent`: `Agent` / `AgentSession` / `AgentTurn`; `AgentEvent` stamped `(sessionId, epoch, seq)`; `AgentCapabilities` (branch on capabilities, never on agent id); policy engine (`resolveRequest`, `allowAll`, `denyAll`, `allowReadOnly`, `allowTools`, `denyTools`, `firstMatch`, session grants); transcript reducer (`reduceAgentEvent`, `createReducer`); `TranscriptStore` / `EventLogStore` seams; `modelAgent`; `agentTool`; `./wire` `serveSession` / `connectSession`; `./harness` `createJsonRpcPeer`, `createMcpToolHandler`; `./app` `useAgentSession`; `./testing` `mockAgent`, `agentConformance`, record/replay. Adapters: `@sigx/ai-agent-claude-code`, `-copilot-cli`, `-codex-cli`, `-acp`; `@sigx/ai-agent-node` for process supervision.
- `@sigx/actors`: `defineActor({type, state, applyEntry, persistence, methods, streams, reads, watches, subscriptions, tasks, resumeTasks, authorize})`; `ctx.state` (deep signal proxy), `ctx.save()`, `ctx.append(entry)` (O(entry) durable log replayed on activation, compacted on save), `ctx.reminders` (durable, ≥ 60 s), `ctx.tasks` (detached, at-least-once restart), `ctx.actor(Def, key)` (principal and call chain propagate; cycles throw), `ctx.publish`, `ctx.changes()`; `authorize(principal, rq, op)` with `op.resource = {kind, type, key, method}` at every entry point; `useActorState(Def, key, method, ..., {live: true})`; `@sigx/actors-ws`; `@sigx/actors-cloudflare` (`createHostDurableObject`, `createWorkerHandler`, `durableObjectStorage`, `durableObjectReminders`).
- `@sigx/zero` + `@sigx/zero-daisyui`: 50 headless components with anatomy attributes; design systems as swappable CSS; ecosystem protocol (`"sigx-zero"` fragment + `sigx zero:extend`).
- sigx core: `serverFn` / `serverStream`, `useData` / `useStream`, `@sigx/cloudflare` adapter, `@sigx/router`, `@sigx/markdown`.

## 3. Hosting topology

- One Cloudflare Worker (`apps/web`) serves SSR pages, serverFns, static assets, the actor HTTP mount (`/_sigx/actor`), the browser live socket (`createWorkerHandler({socket: {terminate: 'object'}})`), the daemon socket (`/_agentic/daemon/{machineId}`, accepted by the Machine Durable Object), MCP (`/_agentic/mcp`), A2A (`/_agentic/a2a/{agentId}` and `/.well-known/agent-card.json`), webhooks (`/_agentic/hooks/{id}`), OAuth callbacks.
- One Durable Object namespace `ACTORS`, one object per actor, SQLite-backed (`migrations: [{tag: 'v1', new_sqlite_classes: ['ActorHost']}]` — never `new_classes`, it is irreversible), `durableObjectStorage()` + `durableObjectReminders()` (alarms). `wrangler.jsonc` needs `compatibility_flags: ["nodejs_compat"]` and `define: {"__DEV__": "false"}`.
- **Eviction is not deactivation.** `onDeactivate` never runs on Workers. Every mutation ends in `ctx.save()` or `ctx.append()` inside the turn.
- R2 bucket for artifacts and exports. Workers Secrets for the OAuth client secret, `WORKSPACE_KEK` (AES-GCM key for stored API keys), VAPID keys later. No D1 in v1.
- Follow-up, not v1: split the DO host into a second Worker so UI deploys cannot evict live sessions.

## 4. Actor catalogue

Keys are workspace-prefixed so every `authorize` chain starts with `sameWorkspace(op.resource.key)`.

| Actor | Key | Persistence | State essentials | Methods | Reqs |
|---|---|---|---|---|---|
| Workspace | `ws:{userId}` | save | owner, ids of agents/chats/machines/schedules, settings (tz, notification prefs, default env, retention), pending pairing codes | get, createAgent, createChat, registerMachinePending → {machineId, pairingCode, expiresAt}, claimPairing(code) → {machineId} \| null (single use, 10 min; called by Machine.pair over a hop), listMachines, removeMachine, updateSettings, exportAll (task), deleteAll (task) | USR-01/02, OPS-10 |
| Agent | `{ws}:agent:{id}` | append config versions | name/description/role, `config` (instructions, skills[], tools[] grants, connectors[]), `configVersion`, memoryPolicy {scope, shared[], autoLearn}, approvalPolicy rules, execution {runtime, defaultEnvironmentId, model, limits}, collaborators `'all'` \| ids, status | get, update(patch, reason) → new version, rollback(v), listVersions, snapshotForSession() → FrozenAgentConfig | AGT-01..09, LRN-08 |
| Chat | `{ws}:chat:{id}` | append entries; window of last 200 in state | members {since, historyFrom}, coordinator?, activeSessions {agentId → sessionId} | post(input, mentions) → {messageId, activated[]}, addAgent(id, access 'all' \| 'from-now'), removeAgent, setCoordinator, history(cursor), search(q) | CHT-01..11, MEM-11 |
| Task | `{ws}:task:{id}` | append transitions | objective, context, constraints/limits, expected, origin (user message or agent call), owner, assignee, environmentId, depth, status, `wait: WaitReason`, children, result {output, text, artifacts, verified}, cancel {requestedAt, stopped}, usage/cost, configVersion | create, start, reportWaiting, resolveWaiting, complete, fail, cancel (cascade), delegate(spec) → childId, get, tree, stream result | COL-03..12, EXE-11/12, OPS-03 |
| Session | `{ws}:session:{id}` | append AgentEvents (= EventLogStore) + transcript snapshot | agentId, chatId?, taskId?, runtime, environmentId?, machineId?, `ref: SessionRef`, configSnapshot, state idle/running/awaiting/closed/error/disconnected, head {epoch, seq}, openRequests, usage, capabilities | open, prompt(input, turnId, output?), respond(requestId, decision), cancel, configure, close, get, stream tail(from), forwardFrames (internal), commandReplied (internal) | EXE-01, CHT-09/11, OPS-05/06, AGT-09 |
| Machine | `{ws}:machine:{id}` | save | name, os, tokenHash, revoked, online, lastSeen, daemonVersion, capabilities[], environments {name, runtime, account {label, authStatus}, cwdRoots, concurrency, isolation}, activeSessions, queued[], pending replies | pair(code, info) → token, heartbeat, openSession(sessionId, envId, spec) → opened \| queued, closeSession, sendCommand(sessionId, WireCommand), revoke, get; WebSocket message handler | USR-04, EXE-02..09 |
| Schedule | `{ws}:schedule:{id}` | save + reminder | kind reminder/recurring/agent-task, cron/at, IANA tz, next, agentId?, environmentId?, prompt?, offlinePolicy, lastRun, enabled | create/update/enable/disable/get; onReminder → Inbox notification or Task creation, re-arm | AST-02..07 |
| Memory | `{ws}:memory:{scope}` (`agent:{id}` or `shared:{name}`) | append + compaction | entries {kind working/fact/preference/assumption/lesson/record, text, tags, subject, provenance {source, sessionId, taskId, messageId, at}, confidence verified/stated/assumed, conditions, evidence[], supersedes, retired, ttl}, indexes | put, update, retire, get, query(MemoryQuery) → ranked, export (NDJSON), import(rows) → fidelity report | MEM-01..12, LRN-04/06/07 |
| Inbox | `{ws}:inbox` | save, capped at 500 (every mutation is a `reduceInbox` entry + `ctx.save()`, so it moves to `ctx.append` when `@sigx/actors` ships log appends) | notifications {id `n_<seq>`, kind reminder/task-done/task-failed/approval/input, title, body?, ref task/schedule/session/chat, at, read, deliveries[] {channel, at, ok, error?}}, push subscriptions {endpoint, keys, addedAt, label?} | append, push (append → deliver through every `NotificationChannel` → record attempts, drop expired subscriptions), list({unreadOnly, limit}) newest first, unread, ack(ids \| 'all'), subscribe, unsubscribe, subscriptions; `list`/`unread` are declared `reads` and serve live (`useActorState`) subscriptions | AST-06, OPS-04 |
| Ledger | `{ws}:ledger:{yyyy-mm}` | append | usage rows {at, sessionId, agentId, taskId, usage, costUsd, estimated} | append, summary(by) | OPS-07/08 |
| Registry | `{ws}:registry` | save | plugins {manifest, enabled, config, grantedPermissions}, connectors {mcp url \| command, tools, status}, encrypted secrets | enable/disable/remove, dependents(id), setSecret, connectors CRUD | PLG-01..09, EXE-10 |
| Audit | `{ws}:audit` | append | approvals, delegations, environment choices, transitions, config changes | record, list(filter) | OPS-03, COL-09 |

`TaskStatus = queued | active | waiting | completed | failed | cancelled`. `WaitReason = approval {requestId, sessionId} | input {requestId} | environment-offline {environmentId, policy} | child {childTaskIds} | capacity {environmentId} | budget {limit}`.

## 5. Session execution paths

### 5a. Platform-managed API agent (`anthropic-api`)

The turn runs inside the Session Durable Object as a detached `tasks:` entry (`ctx.tasks.start('drive', {turnId})`):

```ts
const agent = modelAgent({ model: anthropic({ apiKey }).model(cfg.model), system, tools: platformTools, pricing, store });
const session = await agent.session({ resume: state.ref, policy: compile(approvalPolicy), interactive: true, requestTimeoutMs, agents: definedSubAgents, signal: ctx.abortSignal });
const turn = session.prompt(input, { turnId, output });
for await (const ev of turn) await ctx.turn((s) => apply(s, ev)); // ctx.append({t:'ev', ev}) + reduce
```

- Eviction mid-turn loses nothing already appended. On task restart, if the last event is not `turn-end`, emit `error {code: 'interrupted', recoverable: true}` + `turn-end` and mark the Task `waiting {input}` with "Resume?". Never auto-replay a model call (OPS-05/06).
- Approvals: `request` event → Task `waiting {approval}` + Inbox notification + Chat status entry → user responds → `Session.respond` reaches the live `AgentSession` via a per-activation map, or is stored as `pendingDecision` and replayed after restart.
- Limits `{maxTurns, maxSteps, maxTokens, maxCostUsd, maxWallMs, maxDepth, maxConcurrentChildren}` enforced in the driver; every `usage` event → Ledger (estimated flag when pricing is unknown).
- API keys are user-provided (BYO), encrypted in Registry with `WORKSPACE_KEK`.

### 5b. Daemon-hosted Claude Code

The daemon runs one `claudeCode({ settingSources: [], env: { CLAUDE_CONFIG_DIR: env.profileDir }, models })` per environment. Sessions open with `cwd` from `cwdRoots`, `system` = instructions + skills + retrieved memory block with `systemPromptPreset: true`, `maxTurns` / `maxBudgetUsd` from limits, policy compiled from the agent's approval rules. Per session: `serveSession(claudeSession, { agentId, capabilities, eventLog: diskLog })` and pump `served.events(from)` upward.

**One hibernatable WebSocket** from the daemon to its Machine DO carries the daemon-protocol envelope (types in `@agentic/core` as `DaemonFrame<F, R>` / `PlatformFrame<C>`, generic over the `@sigx/ai-agent/wire` frame, reply and command types so core stays dependency-free; `@agentic/daemon-protocol` instantiates and validates them):

```
daemon → platform: hello {machineId, daemonVersion, os, environments[], capabilities[], resume: {sessionId → cursor}}
                   env {environments[]} · heartbeat · session.opened {sessionId, ref, capabilities, head}
                   session.frame {sessionId, frame: WireFrame} · session.reply {sessionId, reply} · session.closed {sessionId, reason}
                   tool.call {callId, sessionId, tool, input} · pong
platform → daemon: welcome {serverTime, wanted: {sessionId → cursor}} · session.open {sessionId, environmentId, spec}
                   session.command {sessionId, command: WireCommand} · session.close {sessionId}
                   tool.result {callId, output | error} · ping
```

- Machine DO routes `session.frame` → `actor(Session, id).forwardFrames(frames)` (one-way); `session.reply` → `Session.commandReplied`; `tool.call` → the platform tool under an **agent principal** `{kind: 'agent', ws, agentId, sessionId, taskId}` so Memory/Task authorize correctly.
- Session → daemon: `Session.prompt` → `actor(Machine).sendCommand(sessionId, cmd)` → socket. Pending replies are stored in Machine state with a deadline so evictions do not leak promises.
- Reconnect: the daemon redials with backoff; `welcome.wanted` cursors drive gapless replay from the daemon's per-session NDJSON log (`%LOCALAPPDATA%/agentic/sessions/{id}.ndjson`); beyond that a `gap` marks the Session `disconnected` with "events lost" (OPS-04, distinct from failure).
- Multi-account isolation = `CLAUDE_CONFIG_DIR` per environment (the adapter's env allowlist passes it through). macOS Keychain behaviour is unverified, so v1 validates Windows only; `doctor()` implements EXE-07.
- Platform tools reach Claude Code through the adapter's local MCP tool server; their `execute` sends `tool.call` over the same socket and awaits `tool.result`.

## 6. Chat model

Entries: `msg {author: user | agent{agentId, sessionId?}, parts, mentions, replyTo?, sessionId?, taskId?}`, `member {op: add | remove, agentId, historyAccess}`, `status {agentId, kind: typing | session-started | session-ended | task, ref}`, `coordinator {agentId | null}`.

- Activation (CHT-06): activated = mentions ∩ members; none → coordinator if set; none and exactly one agent member → that agent; otherwise store only. Agent-originated posts may mention other agents (COL-06) with the depth counter from the originating Task.
- Each activation creates a Task (origin = user message, context = entries visible to that agent since `historyFrom`) and opens or reuses one Session per (chat, agent) when the runtime supports resume.
- Streaming deltas never pass through Chat: the UI subscribes to `Session.tail` for `chat.activeSessions`. Chat receives only final assistant messages and status through a topic subscription (CHT-11: a chat coordinates N sessions, never one provider conversation).
- History access (CHT-04): `members[agentId].historyFrom` is the message index at add time (`'all'` → 0); context assembly filters `index >= historyFrom`; removal closes the agent's session for that chat.
- Memory privacy (MEM-11): retrieval runs under the assignee's principal against its own scope + declared shared scopes; `Memory.authorize` enforces it.

## 7. Task and delegation

`queued → active → (waiting ⇄ active) → completed | failed | cancelled`; `waiting` always carries a `WaitReason`.

Driver (`Task.tasks.run`): resolve environment (fixed at creation; offline → `waiting {environment-offline}` and the agent's policy `queue | fail | fallback-api`, the last only when explicitly allowed — never silent) → `Agent.snapshotForSession` → `Session.open` → retrieve memories → prompt → mirror session state → result (`verified: false` unless a verification step set it, LRN-03) → learning hook.

**DelegateTool** (`packages/runtimes/src/tools/delegate.ts`, a `defineTool({name: 'delegate', annotations: {openWorld: true}})`): `execute` calls `Task.delegate(spec)`, which checks collaborators, depth, concurrency and budget split, creates the child with the deterministic id `(parentTaskId, callId)`, moves the parent to `waiting {child}`, then awaits the child's `Task.result` stream (idempotent across restarts). In-process `agentTool` is used only for `modelAgent` named sub-agents within one session, never across machines.

Stop cascade (COL-12): `Task.cancel` → `Session.cancel` → each child (one-way) → wait for acks with a deadline → unacked children recorded `stopped: false` and listed as "could not be stopped".

Approvals across delegation (AC-12): children run under `firstMatch(childPolicy, parentConstraints)` (never wider); a child `request` bubbles `waiting {child}` to the parent; the user's decision goes to the child session.

## 8. Memory and learning

Interfaces in `@agentic/core`:

```ts
interface MemoryPlugin { id: string; version: string; capabilities: { semantic: boolean; export: 'full' | 'partial' }; open(scope: MemoryScope, ctx: PluginContext): MemoryStore }
interface MemoryStore { put(e: NewMemoryEntry): Promise<MemoryEntry>; update(id, patch); retire(id, why); get(id); query(q: MemoryQuery): Promise<RankedMemory[]>; export(): AsyncIterable<MemoryEntry>; import(rows: AsyncIterable<MemoryEntry>, opts): Promise<ImportReport> }
interface MemoryQuery { text?: string; tags?: string[]; kinds?: MemoryKind[]; subject?: string; limit: number; since?: number }
interface LearningPlugin { id; version; onTaskEnd(ev: TaskOutcome, mem: MemoryStore): Promise<Proposal[]>; onCorrection(ev: Correction, mem: MemoryStore): Promise<Proposal[]> }
type Proposal = { kind: 'memory'; entry: NewMemoryEntry } | { kind: 'instruction'; patch: string; requiresReview: true }
```

Default memory (`@agentic/memory`, #26): a pure core — `MemoryState` + `applyMemoryLog` reducer, BM25 over text/tags/subject/`conditions` × kind weight (preference 1.3 > lesson 1.2 > fact 1.1 > working 1.0 > record 0.9 > assumption 0.8) × confidence weight × recency decay (30-day half-life, floor 0.5) — and `createMemoryStore({ state, now, commit })` over it. `query` filters on `tags` (any-of; `conditions` tokens count as tags), `kinds`, `subject`, `since`, ranks on `text`, and never exceeds `limit` (default 20) or `maxBytes` (default 4096 bytes of `text`; a non-fitting entry is skipped). `working` entries expire `ttl` ms after `provenance.at` and are compacted on the next working put; a new `record` for a task retires the previous ones (`supersedes`). `retire` is soft: hidden from `query`, kept for `get` and export. Export is NDJSON with a header `{ format: 'agentic-memory', version: 1 }`; `import` reports `imported` / `skipped` / `droppedFields`. `memoryConformance(make)` (`@agentic/memory/testing`) runs against the in-memory store and the Memory actor over `memoryStorage()`; the Durable Object run is a follow-up (#33).

The Memory actor (`@agentic/platform/src/memory`) is that store over `ctx.state` with `ctx.save()` per mutating turn (`ctx.append` once `@sigx/actors` ships signalxjs/actors#312). Methods: put, update, retire, get, query, exportPage, importBatch, compact, setAcl/getAcl, stats. Access: `memoryAuthorize` (same workspace; a user or a `memory`-scoped external client owns every scope; an agent only `agent:{self}`) and, inside the turn, the shared-scope ACL `{ read, write }` — no ACL, no agent access (MEM-04/11, AC-10). Embeddings later as a plugin via export/import (MEM-09) with the fidelity report.

Learning: explicit "Correct" action on any assistant message (v1); agent-detected correction classification is off by default. Memory writes are automatic; instruction/skill patches require review and land as new Agent config versions (AGT-06, LRN-08). Lessons retire through `supersedes` / `retire` (LRN-06). Copying a lesson into a shared scope keeps provenance (LRN-07). LRN-09: Ledger counts corrections per agent per week.

## 9. Plugins, MCP, A2A, auth

- `PluginManifest {id, version, kind: runtime | connector | memory | learning | notification | trigger | a2a, name, description, capabilities[], config: JsonSchema, permissions: [{scope, reason}], compat}`. v1 plugins are in-repo modules registered at build time. Registry holds enabled/config/grantedPermissions; `dependents()` lists agents/schedules referencing a plugin (AC-13). Nothing receives a secret unless `grantedPermissions` includes it (PLG-04). Notifications v1 (`packages/platform/src/notify`): the seam is `NotificationChannel {id, deliver(notification, {workspaceId, subscriptions}) → {ok, error?, expired?}}`; a `notification` plugin implements it and the app passes its instances to `defineInbox({channels})`. `Inbox.push` records first, then fans out through `deliverAll` — a channel that rejects or answers `ok: false` becomes a `DeliveryAttempt` on the record, never a throw (OPS-04). `webPushChannel({fetch, vapid, ttlSeconds})` POSTs one push per subscription with VAPID (RFC 8292) signed as ES256 over WebCrypto, so it is edge-safe; 404/410 endpoints are reported `expired` and the inbox drops them. **Gap:** v1 pushes are *contentless* — no RFC 8291 `aes128gcm` payload encryption — so the service worker treats a push event as "inbox changed" and re-reads `Inbox.list`; encrypted payloads (title/body in the push itself) are a follow-up. VAPID keys come from Workers Secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Triggers v1: HMAC-validated webhook → Task.
- MCP client: `createMcpClient({url, auth}).tools() → AnyTool[]` (Streamable HTTP, edge-safe; stdio servers run on the daemon). Resources, prompts and sampling are declared unsupported in the connector's capabilities (PLG-09).
- **Platform MCP server = orchestration surface** (`/_agentic/mcp`, `createMcpToolHandler`). Design constraint from day one: every platform capability is an actor method, and both the web UI and the MCP server are thin projections over the same methods, so an external MCP client (Claude Code on a laptop, Claude Desktop, any MCP- or A2A-speaking orchestrator) can drive every daemon on every machine. Tool families, annotated readOnly/destructive so `allowReadOnly` composes: `machines.list`, `environments.list/doctor`, `agents.list/get`, `sessions.open(agentId, environmentId, cwd)`, `sessions.prompt`, `sessions.respond`, `sessions.cancel`, `sessions.tail(from)`, `tasks.create/delegate/get/tree/cancel`, `chats.post/history`, `memory.search/remember`, `schedules.create`. Machine selection is explicit in every call (EXE-12). v1 ships the agent-scoped tools; the external-client OAuth and the orchestration families are a phase-3 issue, but actor methods and principal kinds are shaped for it from the contracts issue onward.
- A2A 1.0, JSON-RPC binding only: a card per agent flagged `exposeA2A`; SendMessage, SendStreamingMessage (SSE), GetTask, ListTasks, CancelTask. State mapping: SUBMITTED = queued, WORKING = active, INPUT_REQUIRED / AUTH_REQUIRED = waiting, terminals 1:1. Unsupported and declared: gRPC/REST bindings, push-notification config, extended card, Subscribe. Client `a2aAgent(card)` implements `Agent` (capabilities `resume: false, cancel: true, tools: 'none', permissions: 'none'`) and passes the conformance subset (AC-14).
- Principals: `{kind: 'user', userId, workspaceId}` (GitHub OAuth behind an `AuthProvider` interface → `__Host-session` cookie → `createServerApp({authenticate})`), `{kind: 'machine', workspaceId, machineId}` (pairing code: 6 chars, 10 min, single use → machine token, hash stored), `{kind: 'agent', workspaceId, agentId, sessionId, taskId}` (minted per session for tool callbacks), `{kind: 'external', clientId, scopes[]}` (OAuth 2.1 + Dynamic Client Registration, RFC 8414/7591/9728, so `claude mcp add --transport http agentic <url>` needs no manual token; scopes gate tool families). Every actor's `authorize` chain starts with `sameWorkspace`. Principal propagates unchanged across `ctx.actor()` hops; `Task.delegate` re-mints an agent principal for the child (COL-10).
- Credentials: Claude Code OAuth stays on the machine under `CLAUDE_CONFIG_DIR` (EXE-10); the platform stores only `authStatus`. API keys encrypted with `WORKSPACE_KEK` (AES-GCM via WebCrypto). Retention (OPS-10): workspace settings `{sessionLogDays, artifactDays}`; `exportAll` streams to R2 as NDJSON; `deleteAll` cascades; copies handed to runtimes are listed as outside platform control.

## 10. UI

Routes (`@sigx/router`): `/` (inbox + active tasks), `/chats/:id`, `/agents`, `/agents/:id` (overview, config + versions, memory, sessions), `/tasks/:id` (tree), `/sessions/:id`, `/machines`, `/machines/:id`, `/schedules`, `/plugins`, `/settings`, `/pair`.

- Live data via `useActorState(Def, key, 'get', {live: true})`; transcripts via `Session.tail` into `createReducer` / `reduceAgentEvent` (in-place mutation, one signal per part); markdown via `@sigx/markdown/dom`.
- Zero components per screen: shell `Navbar` + `Drawer`; chat `Chat` rows + `Avatar` / `Status` / `Badge`; composer `Textarea` (`modelModifiers`) + `Button` + `FileUpload` + `Kbd`; tasks `Table` / `TreeView` / `Timeline` / `Steps`; approvals `Dialog` / `Alert`; inbox `Toast`; settings `Field` + `Input` / `Select` / `Switch` / `Combobox`; cost `Stats`.
- `@agentic/ui` fragment scopes `ai-thread` (root/list/anchor), `ai-message` (root/avatar/meta/body/tools/footer), `ai-composer` (root/input/attachments/actions), `ai-tool-call` (root/header/input/output/status, `data-state` pending | running | done | error | denied), `ai-reasoning` (root/summary/body), `ai-approval`. Declared with `"sigx-zero": "dist/fragment.json"` + a recipe pack; the app adopts it with `sigx zero:extend` against `@sigx/zero-daisyui`.
- Responsive: no layout tier in zero yet (andtii/zero-wip#473), so one hand-written `shell.css` on `data-l-*` attributes; the drawer collapses below 768 px; single column otherwise. No virtualised list in zero: the thread windows its own rows.
- Failure distinction (OPS-04) from four signals: client socket status, `Machine.online`, environment `authStatus`, adapter `error` events, `Task.status`. Recovery (OPS-05): interrupted turns are marked, never auto-replayed; "Resume" issues a new prompt over the intact transcript.

## 11. Zero feedback loop

This app is the dogfood consumer for `@sigx/zero`. Friction (a missing part, a state the anatomy cannot express, a control that fights the model binding, a recipe the validator rejects) is filed on andtii/zero-wip labelled `from:agentic` as it is found, linked from the sub-issue here, with the smallest workaround under `packages/ui/src/_zero-gaps/`. Zero is never patched or vendored in this repo.

## 12. Risks and chosen defaults

| Risk | Default |
|---|---|
| Durable Object eviction during long model calls | task-based driver, append per event, "interrupted, resume?" |
| `CLAUDE_CONFIG_DIR` isolation on macOS Keychain | Windows only in v1; EXE-07 conformance test before enabling macOS |
| Node 22 global WebSocket in the daemon | assume it works; fall back to `ws` |
| Chat log growth | 200-entry window in state, rest in the log, compaction on save |
| Web Push on Workers | VAPID ES256 over WebCrypto ships in v1 (contentless push); `aes128gcm` payload encryption is a follow-up |
| Collaborator policy (open decision 4) | `'all'` within the workspace, depth 3, concurrency 3 |
| Learning review policy (6) | memory automatic, instructions reviewed |
| Billing (7) | user-provided keys |
| Search (CHT-10) | substring per chat; full-text later |
| `@sigx/actors` pre-1.0 churn | pin `^0.9.2`, accept minor churn |
| `@sigx/cli` `actors` scaffold layer throws | scaffold `--target cloudflare`, add the DO class by hand |
