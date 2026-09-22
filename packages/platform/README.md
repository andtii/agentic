# @agentic/platform

Actor definitions on @sigx/actors: Workspace, Agent, Chat, Task, Session, Machine, Schedule, Memory, Inbox, Ledger, Registry, Audit; auth helpers.

## Agent (`src/agent`)

`AgentActor` is a persistent identity keyed `{ws}:agent:{id}` (`agentKey(ws, id)`). Its configuration is a log of versions: `update(patch, reason)` appends `{ t: 'config', v, patch, by, at, reason }` (`by` from `ctx.principal`, so the app's server `codec` must carry the `Principal`), `rollback(v, reason?)` appends a NEW version exactly equal to `v` (the entry carries the whole config and replaces, never merges) — history is never rewritten — and `snapshotForSession()` returns a detached `FrozenAgentConfig` stamped with `configVersion`, unaffected by later updates (AGT-06/07). A fresh agent is `configVersion 0` with `defaultAgentConfig()`; the first `update` creates v1 and a session cannot start before it. Patches merge `memoryPolicy` / `execution` (+ `limits`) one level deep and replace everything else wholesale (`mergeAgentConfig`). Skills and tool grants are separate fields; only `tools[]` feeds a policy (AGT-04). The private memory scope is `agent:{id}` (`agentMemoryScope`); `memoryPolicy.shared[]` lists the shared scopes it may read.

The reducer `applyAgentEntry(state, entry)` is the shape `@sigx/actors` `applyEntry` expects; until the installed release ships `ctx.append` the actor folds and `ctx.save()`s inside the turn.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.

## Auth helpers (`src/auth`)

Every actor's `authorize` chain starts with `sameWorkspace`, then adds who may call that actor:

```ts
import { sameWorkspace, workspaceOwner } from '@agentic/platform';

defineActor({ type: 'Workspace', authorize: [sameWorkspace, workspaceOwner], … });
```

Keys: the Workspace root is `workspaceKey(id)` = `ws:{workspaceId}`; children are core's `actorKey(workspaceId, kind, id)` = `{workspaceId}:{kind}:{id}`. `workspaceOfActorKey(key)` reads either shape. v1 has one workspace per user, so `workspaceId === userId`.

### Who is calling (architecture §9)

Edge-safe (WebCrypto + `fetch`, no `node:`), framework-agnostic. The web app binds it in `apps/web/src/auth`.

```ts
import { createServerApp } from '@sigx/server/server';
import { serverAuth } from '@agentic/platform';
import type { Principal } from '@agentic/core';

export const app = createServerApp<Principal>({
    ...serverAuth({ sessionSecret: env.SESSION_SECRET, machines: (ref) => actor(Machine, actorKey(ref.workspaceId, 'machine', ref.machineId)).tokenRecord() })
});
```

- **Authenticate** (`serverAuth` → `{ authenticate, codec }`): `Authorization: Bearer amt.…` → `{ kind: 'machine' }` (hash looked up through `machines`, revoked → anonymous); `Bearer agt.…` → `{ kind: 'agent' }` (sealed per session); otherwise the `__Host-session` cookie → `{ kind: 'user' }`; anything else `null`. Never throws. The `codec` round-trips every `Principal` kind so identity rides `ctx.actor()` hops unchanged.
- **Login**: `AuthProvider { id, pkce, authorizationUrl, exchangeCode }`; `githubAuthProvider({ clientId, clientSecret, fetch? })`. `beginOAuth` → 302 + sealed `__Host-oauth` transient (state, PKCE verifier, `returnTo`, 10 min); `completeOAuth(provider, request)` verifies state, exchanges the code, returns the `ExternalIdentity`. The route then `sealSession({ userId, workspaceId })` → `sessionCookie(...)`.
- **Agent principals**: `mintAgentPrincipal({ workspaceId, agentId, sessionId, taskId? })`; carry it over the wire as `sealAgentToken(...)`, or in process — task bodies inherit no principal — as `actor(Def, key).with({ context: asPrincipal(principal) })`.
- **Pairing** (USR-04): `issuePairing({ machineId })` → `{ code, pending }` (Workspace stores `pending`, hash only); `verifyPairing(pending, code, now)` → `{ ok } | { reason: 'used' | 'expired' | 'mismatch' | 'malformed' }`; `consumePairing` marks it used; `issueMachineToken({ workspaceId, machineId })` → `{ token, tokenHash }` (Machine stores `tokenHash`; `revokedAt` refuses the next request).
- **Secrets at rest**: `importWorkspaceKek(env.WORKSPACE_KEK)` → `encryptSecret(kek, apiKey, aad)` / `decryptSecret`.
- **External clients — OAuth 2.1 + DCR** (`src/auth/oauth-server`, #50): `createOAuthServer({ secret, issuer, resource, store })` → `{ metadata, protectedResource, challenge, register, authorize, token, revoke, verify }`, pure `Request → Response` over an `OAuthStore` (`memoryOAuthStore()`, or `actorOAuthStore()` over the `OAuthClients` directory + per-workspace `OAuthGrants` actor). RFC 8414 / 7591 / 9728 discovery and registration (public clients only), PKCE S256 required, consent HTML for a signed-in user (`authorize(request, user)` — the app supplies the user from its cookie; the user may untick scopes), sealed tokens on the `seal` envelope: `oacd` code (10 min, single use), `oaac` access (1 h → `verify` → `{ kind: 'external', workspaceId, clientId, scopes }`, refused once the grant is revoked), `oarf` refresh (30 d, rotates every use; a replay revokes the grant), RFC 7009 `revoke`. Scopes are core's `Scope` union (`ALL_SCOPES`); each is the tool family it gates on the MCP surface (`@agentic/mcp`).

## Workspace (`src/workspace`)

`ws:{userId}`; save persistence; every mutation ends in `ctx.save()` inside the turn. Methods: `get`, `createAgent`, `createChat({ title? })` (a title goes to the Chat actor's `rename` over a hop, #124), `createSchedule` / `removeSchedule` (index only; the Schedule actor is created under the id), `registerMachinePending` → `{machineId, pairingCode, expiresAt}`, `claimPairing(code)` (single use, 10 min), `listMachines`, `removeMachine`, `updateSettings` (the settings are core's `WorkspaceSettings`; `defaults` is `{ runtime, environmentId? }` — the router's last resort for a daemon-runtime task, and never a model), `exportAll` / `deleteAll` (OPS-10 detached tasks; progress in `get().ops`; `deleteAll` reaches every chat's bound sessions and their pages through the chat's binding, #399), `noteWorkdir(ref)` / `recentWorkdirs()` (#190: the folders work was started in lately, at most `RECENT_WORKDIRS_MAX` = 20, one per environment and path, most recent first).

`defineWorkspace({ sink, store })` binds the OPS-10 ports; the bare `Workspace` records `ops.<task>.error` and changes nothing. `ArtifactSink.put(path, body)` receives `{ws}/{stamp}/{kind}.ndjson` per actor kind (workspace, agents, memory, chats, schedules, inbox, registry — plus tasks and sessions when the store can `list`) and `manifest.json`; every row comes from the owning actor's `get` / `export` as the owner, secrets by name only, no pairing codes. `WorkspaceStore.purge({ type, key })` deletes one record (deactivate, then clear); the cascade purges every child the index implies, then `clearState()`s the root. `docs/retention.md` has the full table, the windows and what stays outside platform control.

```ts
const Workspace = defineWorkspace({
    sink: { put: (path, body) => env.ARTIFACTS.put(path, body) },
    store: { purge: (ref) => purgeDurableObject(ref) }
});
```

## Registry (`src/registry`)

`Registry` is the `{ws}:registry` actor (`registryKey(ws)`): plugins `{ manifest, enabled, config, grantedPermissions }`, MCP connectors, and secrets sealed under `WORKSPACE_KEK`. The app registers `defineRegistry({ kek: importWorkspaceKek(env.WORKSPACE_KEK), catalogue })`; the bare `Registry` has no built-ins and refuses secrets with `no-kek`.

- **Catalogue (#229, PLG-05):** `catalogue: readonly (PluginManifest | { manifest, enabledByDefault?: boolean })[]` is what the build ships, in the app's order. Each manifest is checked when the actor is defined (`bad-manifest` on a bad one or an id listed twice). A built-in is **virtual until touched**: a workspace that never mutated it stores nothing and reads the default — `enabled` (unless `enabledByDefault: false`), every declared scope granted, `config` at the schema's defaults, `registeredAt` / `updatedAt` `0`. **No read saves**; the first `configure` / `enable` / `disable` / `grant` / `revoke` materialises the record and saves it in that turn. A stored built-in always reads with the build's manifest: a grant it no longer declares lapses, a scope no build declared before is granted once (`PluginRecord.seenScopes`), a scope the owner revoked stays revoked across builds. `register` over a built-in id and `remove` of one refuse `builtin`; a plugin a later build drops falls back to its stored record (`builtin: false`) and can be removed. `exportRows` emits the effective rows.
- **Views:** reads return `PluginView` = the record with `config` merged over `configDefaults(manifest.config)` (state keeps the owner's values only, so a new build's defaults flow through), `builtin: boolean`, and — for a single-slot kind — `active: boolean`.
- **Config (PLG-02):** `configure(id, config)` and `register(manifest, { config })` hold the config, defaults filled in, to the manifest's `ConfigSchema` (`validateConfig`): `BadConfigError { code: 'bad-config', pluginId, errors: { path, message }[] }`, nothing stored. `assertPluginManifest` requires a `secret:<name>` (or `secret:*`) permission for every `manifest.secrets` entry.
- **Single-slot kinds:** `memory` and `learning` run on one ACTIVE plugin — `state.active[kind]` while that plugin exists, else the first of the kind in the catalogue, else the first installed. `activate(kind, id)` (owner) refuses `wrong-kind`, a missing or a disabled plugin; a change is saved and audited as `plugin.activated { pluginId, kind, previous? }`. It applies to NEW sessions. `activate('memory', id, { migrate: true })` first moves every scope's memories from the active plugin into `id` and verifies the counts (`defineRegistry({ memoryPlugins })`; `previewActivation('memory', id)` is the dry run); a failure is `migration-failed` and the old plugin stays active (#243).
- **One hop for Routing:** `gate({ runtime? })` → `RegistryGate { runtime: GateEntry | null, memory: GateEntry | null, learning: GateEntry | null, channels: { id, config }[] }`, `GateEntry = { id, enabled, config }` with `config` ready to use. `runtime` is `null` when no `runtime` plugin has that id; `channels` are the enabled `notification` plugins. It reports and never throws, is open to every same-workspace principal like `requireEnabled`, and is `methodReentrancy: 'always'`.
- **One read each for a page:** `overview()` (live read) → `{ plugins: PluginView[], active: { memory?, learning? }, secretNames: string[], hasKek: boolean }` — exactly the facts core's `pluginReadiness` takes, minus the machines. `dependentsAll()` → `Dependents[]` in id order over ONE walk of the workspace (the index, then every agent and schedule side by side).

- **Lifecycle (PLG-03, AC-13):** `register(manifest, { enabled?, config?, grant? })` validates the manifest and stores it disabled with no grants unless told otherwise (`grant: 'declared'` for built-ins, PLG-05); re-registering keeps `enabled` / `config` and drops grants the new manifest no longer declares. `enable(id)`, `disable(id)` → `{ plugin, dependents }`, `remove(id, { force? })` refuses `plugin-in-use` while anything depends on the plugin and drops its connectors. `dependents(id)` → `{ agents: [{ id, name, via: ('connector' | 'tool' | 'runtime' | 'fallback')[] }], schedules: [{ id, title, agentId }], workspaceWide?: true }`, computed from the Workspace index and each Agent's config (a `connectors[]` ref, a `tools[]` grant in the plugin's `tools:<id>` namespace — `<id>.x`, `<id>:x`, `<id>/x`, `<id>__x` — `execution.runtime`, or `offlinePolicy: 'fallback-api'` for `anthropic-api`) and each Schedule's agent. The ACTIVE memory / learning plugin serves every agent, so it answers `workspaceWide: true` with empty lists, and `remove` treats it as in use.
- **Gate:** `requireEnabled(ctx, workspaceId, pluginId)` from any actor (or `actor(Registry, key).requireEnabled(id)` in process) throws `PluginDisabledError { pluginId, state: 'disabled' | 'missing' }` — call it before a session opens on a runtime, a schedule fires through a connector, or a tool is exposed. Running work is never interrupted by a disable.
- **No implicit authority (PLG-04):** `grant(id, scopes)` accepts only scopes the manifest declares; `revoke` removes them. `openSecret(name, pluginId)` returns plaintext only for an enabled plugin holding `secret:<name>` (or `secret:*`), and is the only method that does — `secrets()` lists names, `exportRows()` carries names, state holds `kek1.…` ciphertext bound to `{ws}:secret:{name}`.
- **Connectors:** `putConnector({ id, pluginId, transport: 'streamable-http' | 'stdio', url | command, args?, machine?, secrets?, auth? })` — `auth: { bearer?, headers?, env? }` binds secret NAMES to where they go and may only name secrets the record lists (`mcpConnectorSetup` of `@agentic/mcp` builds both the manifest and this record) — `removeConnector`, `connectors()` (read), `getConnector`, `setConnectorStatus(id, { state, error? }, tools?)` after a probe or a session open. `gate({ runtime, connectors })` answers for the connectors an agent names in the same hop: `ready` (with endpoint, `auth` and last `tools` / `status`), `disabled` or `missing`.
- **Connectors on sessions (#240):** a local session opens the agent's ready Streamable HTTP connectors through the `connectors` opener given to `anthropicApiRuntime` (the app passes `openMcpConnector`), with credentials from `openSecret(name, connectorPluginId)`; tools are named `<id>__<tool>`, go through the agent's rules and grants (as `source: 'mcp'`, category from the MCP hints — `connectorCategory`), and a connector that cannot be used is left out and named in the system prompt, never failing the session. On a daemon-hosted session (#280) `Routing` puts the ready connectors on the daemon's `OpenSpec` with secret names only (`daemonConnectors`), and the daemon fetches the values over its own `tool.call` `connector_credentials`. `createToolCallPort({ registry })` answers that call (`connectorCredentials`) for a connector the calling session's gate names; without `registry` it refuses as `unsupported`.
- Authorization: `sameWorkspace` for reads (`list`, `overview`, `connectors`, `secrets` are live `reads`) and for `gate`; every mutation — `activate` included — is `ownerOnly`; `openSecret` admits the owner and agent principals.

```ts
await registry.register(mcpConnector({ id: 'github', name: 'GitHub', transport: 'streamable-http', url, secret: 'github-token' }));
await registry.setSecret('github-token', token);
await registry.grant('github', ['secret:github-token', 'tools:github']);
await registry.enable('github');
const { dependents } = await registry.disable('github'); // → the agents and schedules still referencing it
```

## Notifications (`src/notify`)

- `Inbox` — the `{ws}:inbox` actor (`inboxKey(workspaceId)`): `append`, `push`, `list({ unreadOnly, limit })` newest first, `unread`, `ack(ids | 'all')`, `ackRef(ref)` (every unread notification about a ref — `sameRef`, a ref without a `requestId` covers the session), `subscribe` / `unsubscribe` / `subscriptions`. `authorize: [sameWorkspace]`. Capped at `INBOX_CAP` (500); every mutation is a `reduceInbox` entry followed by `ctx.save()`. `list`, `unread` and `subscriptions` are declared `reads`, so `useActorState(Inbox, key).list(...)` is a live subscription.
- `NotificationChannel` — the outbound seam: `{ id, deliver(notification, { workspaceId, subscriptions }) → { ok, error?, expired? } }`. `defineInbox({ channels })` builds the Inbox the app registers; `push` records first, then fans out through `deliverAll`, and every channel's outcome — a rejection included — lands on the record as a `DeliveryAttempt`, never as a throw.
- Channels as plugins (#244): `defineInbox({ channelPlugins, registry })` asks `Registry.gate()` once per notification which `notification` plugins are on and opens each one it has a `ChannelPlugin` for — `open({ config, secret(name) })`, the secret through `openSecret` as the workspace owner. A Registry that cannot be asked is a failed attempt on `PLUGIN_CHANNELS`. `channels` (static) still work beside it.
- `webPushChannel({ fetch, vapid, ttlSeconds })` — RFC 8030 push with VAPID (ES256 over WebCrypto, edge-safe). Contentless in v1: the notification the service worker shows is generic. `vapidSigner(keys)` is exported on its own.
- `webPushPlugin` (`WEB_PUSH_PLUGIN_ID` = `agentic.notify.web-push`, kind `notification`, config `{ subject, publicKey }`, secret `VAPID_PRIVATE_KEY_SECRET`) and `webPushChannelPlugin(options)`, which opens the private key only for a notification that has a subscription and reports what is missing instead of sending an unsigned push.

```ts
const Inbox = defineInbox({ channels: [webPushChannel({ vapid: { publicKey, privateKey, subject } })] });
// Or, per workspace from the Registry (#244): each enabled notification plugin opens with its config and secrets.
const PluginInbox = defineInbox({ channelPlugins: { [WEB_PUSH_PLUGIN_ID]: webPushChannelPlugin() }, registry: () => Registry });
await actor(Inbox, inboxKey(ws)).push({ kind: 'task-done', title: 'Report ready', ref: { kind: 'task', taskId } });
```

## Test harness (`src/testing`, test-only)

Imported by `__tests__` through a relative path — it depends on `@sigx/server/testing`.

```ts
const app = testActorApp([Workspace]);          // defineActorApp over recordingStorage()
beforeEach(() => app.start());
afterEach(() => app.stop());
const ws = app.as(userPrincipal('u1')).actor(Workspace, workspaceKey('u1'));
await ws.createAgent({ name: 'Ada' });
expect(app.saves.filter((s) => s.type === 'Workspace')).toHaveLength(1);
expect(await statusOf(app.as(userPrincipal('u2')).actor(Workspace, workspaceKey('u1')).get())).toBe(403);
```

`as(principal)` binds a per-call context carrying that principal through the real in-process pipeline (policies, identity gate); `start()` stamps a JSON principal codec so `ctx.principal` reaches methods and survives `ctx.actor()` hops. `memoryStorage`, `recordingStorage`, `QUIET_DEFAULTS`, `rejectionStatus` and `statusOf` are exported alongside.
## Memory (`src/memory`)

`Memory` is one actor per scope, keyed `{ws}:memory:{scope}` (`agent:{id}` or `shared:{name}`): the `@agentic/memory` core state plus a shared-scope ACL. Methods: `put`, `update`, `retire`, `delete`, `get`, `query`, `exportPage(after, size)`, `importBatch(rows, { onConflict })`, `compact`, `setAcl` / `getAcl` (owner only / read), `stats`. Every mutating turn ends in `ctx.save()` (Workers eviction rule); the reducer `applyMemoryActorEntry` is shaped for `ctx.append` once `@sigx/actors` ships it.

Authorization: `memoryAuthorize` on the definition (same workspace; a user or a `memory`-scoped external client owns every scope; an agent reaches `agent:{id}` only as that agent; a machine nothing) and `aclAllows` inside every method for `shared:*` (`{ read, write }` lists or `"*"`; no ACL means no agent access — AC-10, MEM-11). The app must configure a principal `codec` on `createServerApp`, or `ctx.principal` is `null` and every in-turn check fails closed.

`memoryActorPlugin({ workspace })` is the platform's default `MemoryPlugin`: `open(scope)` returns `actorMemoryStore(actor(Memory, key))`, streaming `export()` by id-ordered pages and batching `import()`.

`FlatMemory` (#281) is the flat memory plugin's durable backend: one actor per scope under the SAME key as `Memory` but its own type (its own object — the two plugins' stores never mix), over the flat store's state (`createFlatMemoryState`) plus a `rev`. Same method table as `Memory` except `setAcl` (`compact` always `0`: nothing expires), same `memoryAuthorize`; a shared scope's ACL is the Memory actor's — read from that scope's `Memory` as the workspace owner when an agent asks, so switching the active plugin never changes who reads it. `flatMemoryActorPlugin({ workspace })` is its `MemoryPlugin` (`capabilities.export: 'partial'`), `flatMemoryActorImpl()` the platform's implementation of `agentic.memory.flat`; `actorMemoryStore` takes either actor's client (`MemoryStoreClient`). `exportAll` includes its entries (marked `plugin: 'agentic.memory.flat'`) and `deleteAll` purges its record of every scope.

## Schedule (`src/schedule`)

```ts
import { defineScheduleActor, scheduleTrigger } from '@agentic/platform';

// The platform's TriggerPort: Inbox reminder, or a Task for an entry with an agent (#42).
export const Schedule = defineScheduleActor({ trigger: scheduleTrigger({ environments /* the Machine actor's online status, wired by routing #37 */ }) });

const s = host.actor(Schedule, 'ws_alice:schedule:sch_1');
await s.create({ kind: 'reminder', title: 'standup', recurrence: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Stockholm' } });
await s.get(); // { next, lastRun, runs, log, ... }
await s.disable(); await s.enable(); await s.update({ recurrence: { kind: 'at', at: Date.now() + 3_600_000 } });
```

An agent entry may name a `workdir` (#190). It needs `environmentId` (400 otherwise), `update({ workdir: null })` clears it, and each firing carries it into the task's contract.

`TriggerPort.fired(event, hop)` — `hop` is the Schedule actor's own `ctx.actor`, so a port reaches other actors as trusted hops (a reminder runs with no principal; an in-process `actor()` would be refused by `sameWorkspace`). `scheduleTrigger({ environments?, onOutcome? })` is the platform's port (`trigger.ts`): a `reminder` entry, or any entry without an `agentId`, becomes one Inbox notification of kind `reminder` (`body` = the prompt, `ref: { kind: 'schedule' }`) pushed through every channel; an entry with an agent becomes a Task owned by and assigned to that agent, `origin { kind: 'schedule', scheduleId }`, id `scheduledTaskId(scheduleId, scheduledFor)` — deterministic, so a retried firing finds the task it already routed. An entry with an `environmentId` follows its offline policy when the `EnvironmentProbe` says offline (no probe → everything is offline; routing, #37, wires the Machine actor's online status): `queue` / `fallback-api` record `waiting { kind: 'environment-offline', policy }` for the router (#37); `fail` fails the task (`code: 'environment-offline'`) and pushes a `task-failed` notification. `deliverScheduleFired(event, hop, options)` is the same logic returning the `ScheduleTriggerOutcome`.

Each occurrence is a one-shot `ctx.reminders` entry re-armed from `onReminder`, so it fires from a Durable Object alarm with nothing else online. Cron subset: `*`, `n`, `a-b`, `a,b`, `*/n`, `a-b/n` over minute hour day month weekday (7 = Sunday). DST: a wall time inside the spring gap is skipped; one inside the fall overlap fires its first occurrence only. Catch-up policy is `skip` (fire once, log what was missed). `recur.ts` is pure and exported on its own (`parseCron`, `nextCron`, `resolveWallTime`, `nextOccurrence`).

## Session (`src/session`)

`defineSessionActor({ factory, commands?, usage?, now? })` builds the `session` actor, keyed `{ws}:session:{id}`. It never imports a runtime adapter: the `SessionFactory` port turns a runtime id into a live `AgentSession` (the platform-managed path) or `null` (a daemon hosts it), and the `CommandSink` port carries wire commands to that daemon's machine.

```ts
const Session = defineSessionActor({ factory: runtimesFactory, commands: { send: (t, cmd) => actor(Machine, machineKey(t)).sendCommand(t.sessionId, cmd) } });
const s = actor(Session, actorKey(ws, 'session', id));
await s.open({ agentId, runtime: 'anthropic-api', chatId, taskId, config });
await s.prompt('hello', turnId);                     // idempotent by commandId (default: turnId)
for await (const ev of s.tail({ epoch: 0, seq: 0 })) render(ev);   // replay, then follow until closed
```

- The record is the event log: one `applySessionEntry` entry per `AgentEvent`, then `ctx.save()` (switches to `ctx.append` when `@sigx/actors` ships it). `createEventLogStore` / `createTranscriptStore` expose it as `@sigx/ai-agent` stores.
- Local turns run in `tasks.drive`; after an eviction the restarted task closes the turn as interrupted — open calls cancelled, open requests resolved `cancel`, `error {code: 'process_exited', data: {interrupted: true}}`, `turn-end {stopReason: 'error'}` (`isInterruptedTurnEnd`). A model call is never re-run. `resume(commandId?)` (#46, OPS-05) is a person's word to go on: a NEW prompt carrying the cut turn's input (`interruptedTurn(events)`) over the intact transcript, turn id `resumeTurnId(turnId)` = `{turnId}:resume`, idempotent by `resumeCommandId(turnId)` = `resume:{turnId}`; `invalid` when the last turn was not interrupted or something started since.
- Daemon path: `forwardFrames(frames)` and `commandReplied(reply)` are internal (only the machine the session was opened on); a command sent to a daemon answers `pending` until its reply arrives.
- `authorize: [sameWorkspace, sessions scope]`. The chat hears `session-started`, `typing`, `request` / `request-resolved` (`ref` = `approval:{requestId}` | `input:{requestId}`), the final assistant `message` and `session-ended` on `SESSION_EVENTS_TOPIC`.
- Approvals (#40, OPS-02 / CHT-09): every `request` — both paths, task or chat — is one `approval` / `input` Inbox notification with a `{ kind: 'session', sessionId, requestId }` ref (`SessionPorts.inbox`, one-way) and a chat status entry; `respond(requestId, decision)` answers it from any client (`{ type: 'permission', outcome, scope: 'once' | 'session' }` or `{ type: 'input', answers }`), the `request-resolved` marks the notification read (`Inbox.ackRef`) and pairs the chat entry; `request(requestId)` / `requests({ openOnly })` are live reads returning `SessionRequestView` (the request, its call's input / category, the decision, who asks, the chat / task, and the `approvalPolicy` rule that asked — what the approval card renders); `get().grants` lists the session-scoped allows in force. Grants are listed, never revoked: the adapter keeps its `SessionGrants` private (`src/policy/requests.ts`).
- Platform-raised input requests (#122): `raiseInput({ callId, message, toolName?, options? })` — only the agent working the session — appends a synthetic `request { kind: 'input', requestId: 'ask:{callId}' }` to the log once per call id (a re-issued call re-finds it) and answers `{ requestId, resolved? }`; the event is the running turn's, stamped by `platformCursor(head)` strictly between the head and the runtime's next `seq` (fractional), so it never collides with a runtime event on either path. `respond` settles such a request itself (an input decision or a cancel; a permission decision is `invalid`; a second decision an idempotent ack), and the `resolution(requestId)` stream yields the `request-resolved` once it is in the log. The rest of the flow (chat status, Inbox row, the Task `waiting {input}`, `request(id)`) is unchanged; an input request is not audited.

## Machine (`src/machine`)

`defineMachineActor({ socket, sessions?, tools?, now?, heartbeatWindowMs?, commandTimeoutMs? })` builds the `machine` actor, keyed `machineKey(ws, id)` = `{ws}:machine:{id}`. The host owns the socket (`MachineSocketPort`: send / close by actor key — on Cloudflare the Machine's Durable Object holds the daemon's hibernated WebSocket, `apps/web/src/daemon`); the actor owns the protocol and the record.

```ts
const Machine = defineMachineActor({ socket: daemonSockets.port, sessions: () => Session, tools: platformTools });
const Session = defineSessionActor({ factory, commands: { send: (t, cmd) => actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) } });
const m = actor(Machine, machineKey(ws, id));
await m.pair(code, { name: 'laptop' });                // → { token, workspaceId, machineId }; only the hash is kept
await m.openSession(sessionId, environmentId, spec);   // 'opened' | 'queued' (EXE-09)
```

- Methods: `pair(code, info)` (redeems through `Workspace.claimPairing`), `tokenRecord()` (for `serverAuth({ machines })` and the socket handshake), `revoke()`, `rename(name)`, `get()` → `MachineView` (online, lastSeen, os, daemonVersion, capabilities, environments, hosted / queued sessions, pending commands, recent closures), `doctor(environmentId?)` → `MachineDoctorView` (the daemon's per-environment `doctor` verdicts — isolation and auth, EXE-05/07 — as last reported in `hello` / `env`; `ok` only when every environment has a verdict and none is an error; the `environments.doctor` shape for the MCP surface), `quota(environmentId?)` → `MachineQuotaView` (each environment's provider limits as the daemon last reported them in `quota` frames, `snapshot: null` until one arrives — merged with core's `mergeQuota`, dropped with the environment, kept while the machine is offline; readers judge staleness from `observedAt`; also on `MachineView.quota`), `openSession` / `closeSession` / `sendCommand` (session drivers), and the socket entry points `socketMessage(raw)` / `socketClosed()` / `heartbeat()` (the machine itself).
- Routing (§5b): `session.opened` → a synthesized wire `hello` to the Session; `session.frame` → `Session.forwardFrames`; `session.reply` → `Session.commandReplied`; `session.closed` frees the slot and dequeues; `tool.call` → `ToolCallPort.call(input, agentPrincipal)` → `tool.result` (a `ToolCallError` names the error code).
- Liveness: a socket close is offline at once; a silent daemon is offline after `heartbeatWindowMs` (90 s) on the `liveness` reminder, which also answers pending commands past `commandTimeoutMs` (120 s) with `error internal`. On reconnect `welcome.wanted` carries the last forwarded cursor per session and pending commands are re-sent.
- Environments from the web (#237, decisions 2026-09-19 (c)): `putEnvironment(input: EnvironmentInput)` → `{ requestId }` asks the daemon to create an environment, or change the one `input.id` names; `removeEnvironment(environmentId)` → `{ requestId }` asks it to forget one (in `fsRequest`'s order: 403 revoked, 404 unknown, 503 offline, then 409 `in-use` while this machine hosts or queues a session in it). Both send `env.request`; the daemon's `env.response` lands in state and `envResult(requestId)` → `EnvResultView { requestId, op, status: pending | done | error, requestedAt, finishedAt?, result?, error? }` reads it, live-keyable like `fsResult`. The daemon's machine-local policy decides: its refusal (`policy-disabled`, `outside-allowed-roots`, `unknown-runtime`, `in-use`, …) is stored unchanged. The input is checked against the strict protocol schema first (400; a `profileDir` is never accepted), 403 revoked, 503 `machine-offline` (`MACHINE_OFFLINE_CODE`). Pending requests fail `timeout` at `envTimeoutMs` (30 s) and on disconnect; at most `MAX_ENV_REQUESTS` = 16, pruned `ENV_RESULT_TTL_MS` = 2 min after they finish. Each answer is recorded once as `environment.put` / `environment.removed` with the roots that were asked for and the outcome. `get().policy` is the `MachinePolicy` the daemon last reported in `hello` / `env` (absent for a daemon that reports none), so a page can say why the web may not manage this machine.
- The folders the web may use (#355, #480; decisions 2026-09-22): `setPolicy({ allowedRoots })` → `{ requestId }` (owner, **elevated** — `requireElevated`, 403 `elevation-required: …` otherwise) checks the roots (`checkPolicyRoots`: ≤ 32, each a `~` form or an absolute path on the machine's OS, never a network path, the same folder spelled twice once), stores them as the desired set (`policyDesired { allowedRoots, setAt, by, lastAuto? }`), sends `policy.request { op: 'set' }`, records `machine.policy-set` and pushes a `machine-security` Inbox row at once; the daemon expands `~`, checks every folder and answers `policy.response`, read with `policyResult(requestId)` → `PolicyResultView { requestId, op, status, requestedAt, by, finishedAt?, result?, error? }` (the daemon's code unchanged: `policy-locked`, `protected`, …). `browseMachine(path?)` (owner, elevated) lists a folder or the machine's roots the same way. 409 when the daemon does not list the `policy` feature ("reinstall once"), 503 offline; `envTimeoutMs`, `MAX_POLICY_REQUESTS` = 16, `POLICY_RESULT_TTL_MS` = 2 min. **Reconcile:** on every `hello` and `env`, `shouldReconcile` (`machine/policy.ts`) sends the desired set once as `system:setup` when the daemon answers `policy.request`, the report is not `policyConverged` (core: `source: 'web'` and the same `requested` strings — `~` stays `~`, no home directory reaches the platform), the machine is not `locked`, nothing is in flight, and either no automatic request went out yet, the last one converged (a genuine drift, e.g. `policy off` on the machine), the owner changed the set since, or this is a fresh connection — so a refused automatic request holds until one of those, and the bound per connect is one plus the local drifts. `get().policy` carries `source` / `locked` / `requested` as reported; `get().policyDesired` the desired set with `converged`. The Pair page's preset rides `Workspace.registerMachinePending({ allowedRoots })` → the pending index entry → `claimPairing` → `pair`, which stores it as the desired set (no elevation: minting a code already pairs a machine); the first `hello` reconciles it. `putEnvironment` with `allowBypassPermissions: true` on an environment that lacks it is elevated too; keeping it or turning it off is not. `revoke` is elevated. `rename` records `machine.renamed`. `auth.elevated` is recorded once per elevation window, by the first change it lets through.
- `authorize: [sameWorkspace, machines scope]`; `pair` / `tokenRecord` for the owner or the machine itself, `revoke` / `rename` / `putEnvironment` / `removeEnvironment` / `envResult` / `setPolicy` / `browseMachine` / `policyResult` for the owner, the socket entry points for the machine only, session methods for anyone but a machine. No tool surface reaches the environment, policy, restart, log or login methods — not the platform tools, not the daemon `tool.call` port, not the platform MCP server (`__tests__/machine/tool-boundary.test.ts` scans for callers).
### Memory and learning on the path (`learning` port; architecture §8, #41)

`defineSessionActor({ factory, learning: platformLearningPorts({ plugin }) })` puts memory and learning on the execution path; without the port the actor neither retrieves nor learns.

```ts
const ledger = memoryCorrectionLedger();                    // or the Ledger actor's (LRN-09)
const Session = defineSessionActor({
    factory,
    learning: platformLearningPorts({ plugin: (c) => learningPlugin({ ledger, contextFor: () => ({ objective: c.objective, tags: c.tags }) }) })
});
await s.open({ agentId, runtime, taskId, objective, context, tags, config, system });   // objective/context/tags drive retrieval
await s.correct(messageId, 'Never mention internal ticket numbers', 'never');            // → onCorrection, as the agent
```

- **Session start** (MEM-07/10/11): before the runtime session exists, `open` queries `agent:{id}` plus every `memoryPolicy.shared` scope **as the agent principal** (`retrieveMemories`; the Memory actor's `authorize` and ACL decide — a refused scope is listed in `spec.retrieval.skipped`, never hidden), on `objective` + the last text part of `context`, filtered by `tags`, under one budget (`DEFAULT_RETRIEVAL_LIMIT = 8`, `DEFAULT_RETRIEVAL_MAX_BYTES = 4096`; `platformLearningPorts({ retrieval })` changes it). The hits are recorded on the spec as `memories` (a factory renders them natively: `createPlatformModelAgent({ memories: spec.memories })`) and appended to `spec.system` as the platform-owned block `## Platform memory` (`renderMemoryBlock` / `withMemoryBlock`, idempotent) — the same heading the Claude Code driver relabels to, so the daemon path shows it verbatim.
- **Turn end** (LRN-02/03): for a session with a `taskId`, the turn's outcome goes to `plugin.onTaskEnd` — `completed` for `end_turn` / `max_*`, `cancelled`, else `failed`; a result with text is `verification: 'claimed'`, `verified` / `refuted` only when the `verify` port says so (`taskOutcomeOf`). Memory proposals are applied by the plugin; instruction proposals are parked through `park` (default: `AgentActor.propose`). An interrupted turn is not an outcome. The result lands in `SessionInfo.learning`; a failure is recorded there, never thrown.
- **`correct(messageId, text, what)`** (`wrong` | `prefer` | `never`; users, external clients and agents, never a machine): the assistant message of this session becomes a `Correction` (`by: 'user'`, or `'agent'` for an agent principal — dropped by the default plugin) for `plugin.onCorrection`, run as the agent so the lesson lands in `agent:{id}` with the user's provenance; instruction proposals are parked; `SessionInfo.corrections` keeps one record per correction.
- `plugin` may be a factory over the session's context (`{ workspaceId, agentId, sessionId, taskId?, objective?, tags? }`), which is how a lesson's `conditions` name the task (LRN-04). The steps themselves are pure functions in `src/task/driver.ts`, so a Task driver can compose them too.
- **The active plugin** (#242, MEM-02, LRN-01, AC-13): `platformLearningPorts({ memoryPlugins, learningPlugins })` take the build's implementations by plugin id — `MemoryPluginImpl = (config) => { open: MemoryOpener, retrieval? }`, `LearningPluginImpl = (config) => LearningPlugin | LearningPluginFactory`. With a Registry answer on the spec (`spec.plugins`, recorded by `Routing.run`), a session uses the workspace's ACTIVE plugin of each over its config (`memoryAccess` / `learningAccess`); without one, `memory` / `plugin` / `retrieval` as above. `memoryActorImpl()` is the default (the Memory actor as the calling principal; its config's `retrievalLimit` is the budget, `0` asks no scope), `flatMemoryActorImpl()` is the flat one (the FlatMemory actor, #281), and `isolateMemoryImpl(make)` wraps a plugin with no ACL or durable backend of its own (one per workspace in the isolate, an agent's own scope only — tests). **Turned off** (or an active id the build does not implement): the memory plugin → nothing retrieved (the reason in `spec.retrieval.skipped`), written or learned, the stored memories untouched; the learning plugin → no `onTaskEnd`, and `correct` refuses with the reason. The memory tools reach the same store — `createActorToolPorts({ memory })`, `anthropicApiRuntime({ memory })`, `createToolCallPort({ memory })` (the daemon path reads the calling session's gate, for a memory tool only) — and, memory off, stay listed and answer why (`ToolCallError('unsupported')`).

## Chat (`src/chat`)

`Chat` is keyed `{ws}:chat:{id}` (`actorKey(ws, 'chat', id)`). It stores attributed entries, knows who is a member and since when, and decides which agents a message activates — it never starts a session or task.

```ts
import { actor } from '@sigx/actors';
import { Chat } from '@agentic/platform';

const chat = actor(Chat, key);
await chat.addAgent(agentId, 'from-now');            // 'all' opens the whole history
const { messageId, activated } = await chat.post('hi', [agentId]); // or 'all' for the group
const page = await chat.history(null, 50);           // newest page; page.next is the cursor for older entries
const hits = await chat.search('deploy');            // newest-first substring scan
```

- Activation (architecture §6): mentioned members → coordinator → the sole agent member → nobody. An agent's own post never activates itself.
- History access: an agent principal reads from its `historyFrom` (the join entry for `'from-now'`); non-members read nothing; users and external clients with the `chats` scope read everything.
- Persistence: the state keeps the last 200 entries and a `{seq, at}` index; every 100 older entries move to a `ChatPage` actor (`{chatKey}:p{n}`), so a post is one bounded write. Register `Chat` and `ChatPage` together.
- Title (#124): `rename(title)` — trimmed, one line, at most `MAX_TITLE_LENGTH` (120) characters, a user's or external client's call — appends a `rename` entry; `get().title` is the last one, absent until then (the web pages then title the chat by its members). `Workspace.createChat({ title })` writes the first one over a hop.
- Working folder (#190): `setWorkdir(agentId, ref | null)` — a member's sticky folder for this chat (404 for a non-member; users and external clients only) — sets `get().members[agentId].workdir` and appends a visible note ("Working folder for … → … on …" / "… cleared"): a user `msg` with `workdir`, activating nobody. The activation that builds a task copies it into the contract (`workdir` + `environmentId`), so it applies from the next activation.
- Sessions publish `SessionEvent`s on `sessionEvents(chatKey)` (`topic('session-events', chatKey)`); the chat folds status and final messages into entries and binds one session per member (#392): `get().sessions[agentId]` is `{ sessionId, since, seenSeq }` — created by `session-started` (with its `ref`; a later one replaces it), dropped by `session-ended` or the member's removal; `seenSeq` is the seq of that member's last own `msg` under that session id (0 until it has answered; a late answer from a replaced session moves nothing), moved by the reducer alone. `typing` is not durable. A payload that is not a well-formed `SessionEvent` (missing ids or `at`, unknown `kind` or `status`) throws, so `host.publish` reports a delivery failure and nothing is recorded.

## Task actor (`src/task/`)

`TaskActor` is the traceable unit of work (architecture §4 Task, §7). Key: `taskKey(workspaceId, taskId)` → `{ws}:task:{id}`; `authorize` admits principals of the same workspace.

```ts
import { actor } from '@sigx/actors';
import { TaskActor, taskKey } from '@agentic/platform';

const task = actor(TaskActor, taskKey(ws, id));
await task.create(contract, { owner: agentId });        // idempotent
await task.start('user:u1', sessionId);                  // queued → active
await task.reportWaiting({ kind: 'input', requestId }, 'agent:a');
await task.explain();                                    // the WaitReason, or null
const childId = await task.delegate({ callId, objective, assignee });   // parent → waiting {child}
for await (const outcome of task.result()) { /* yields once, on the terminal state */ }
const report = await task.cancel('user:u1', { timeoutMs: 10_000 });    // { stopped, notStopped }
```

- Every mutation is one `TaskEntry` folded by the pure reducer `applyTaskEntry` and made durable inside the turn — `ctx.append` where the runtime has it (@sigx/actors #312), otherwise the reducer plus `ctx.save()`.
- Illegal transitions throw `IllegalTransitionError`; `start` runs only from `queued` and `resolveWaiting` only from `waiting` (otherwise `TaskStateError` `wrong-state`); limits throw `TaskLimitError` (`kind: 'depth' | 'concurrency' | 'budget'`). Defaults when the contract sets none: `DEFAULT_MAX_DEPTH = 5`, `DEFAULT_MAX_CONCURRENT_CHILDREN = 8`.
- `delegate` clamps every budget the parent carries (`maxCostUsd`, `maxTokens`, `maxWallMs`, `maxTurns`, `maxSteps`) to the parent's remaining share after its own spend and its live children's reservations; a child settling frees its reservation and, when it was the last one waited on, resumes the parent.
- `cancel` transitions to `cancelled`, fans `stop` out to unsettled children one-way, waits for their acknowledgements and — when a session is attached — for `sessionStopped()` from the session driver, until the deadline. Each hop keeps a 20 % margin of the remaining time so a child's own report arrives before the parent's deadline. Whatever did not acknowledge lands in `notStopped`; late acknowledgements still update the snapshot.
- Budgets (COL-11, OPS-08): `recordUsage` and `delegate` run `checkBudget(constraints, spent)` from `src/ledger`; once a budget is spent (`spent >= max`) the task ends `failed` with `error.code === 'budget'` (`system:budget`), every unsettled child is cancelled one-way, and `delegate` throws `TaskLimitError('budget')` before any child is created.
- The workspace's list (#146): `TaskIndex`, keyed `taskIndexKey(ws)` → `{ws}:task-index`, holds one denormalised `TaskIndexRow` per task (`id`, `objective`, `assignee`, `owner`, `status`, `wait?`, `origin` kind, `chatId?`, `parentId?`, `depth`, `environmentId?`, `sessionId?`, `createdAt`, `updatedAt`, `n` = the transition count). The Task actor writes it over a `ctx.actor` hop (`indexTask`) on `create` and after every status or wait change — awaited so rows land in order, in a `try/catch` so a host without the index still runs tasks. `list({ status?, assignee?, parentId? | null, limit? })` is the pages' one live read, newest first; `upsert` is refused over the wire (`methodAuthorize: never`) and ignores a row whose `n` is below the one held (a late or retried hop never rolls a status back); `trimIndex` drops the oldest settled rows past `TASK_INDEX_CAP` (2000), never a live one. Register `TaskIndex` wherever `TaskActor` runs (`apps/web` does).

## Routing (`src/routing`)

`defineRoutingActor({ sessions, machines, registry?, runtimes?, driver?, store?, now?, newSessionId? })` builds the `routing` actor, keyed `routingKey(ws)` = `{ws}:routing:main` — the §7 driver: a task always runs where it was told to, or waits / fails with a visible reason (EXE-09/11/12, AST-05). `endSession(chatId, agentId, reason, sessionId?)` (#399; a user or an external client, never an agent) ends a chat member's live session on purpose: the routes on it fail `session-reset`, the Session is closed, the chat's binding dropped, and the record and its pages purged through `store` (the `WorkspaceStore` `deleteAll` uses); `Chat.removeAgent` reaches it through `defineChatActor({ routing })`.

```ts
const runtimes: RuntimeCatalogue = { 'anthropic-api': anthropicApiRuntime({ routing: () => Routing, sessions: () => Session }), 'claude-code': { host: 'daemon' } };
const Session = defineSessionActor({ factory: createSessionFactory({ routing: () => Routing, registry: () => Registry, runtimes }), commands, usage: ledgerRecorder() });
const Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, registry: () => Registry, runtimes });
const Machine = defineMachineActor({ socket, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session }) });
await actor(Routing, routingKey(ws)).run(taskId);   // queued → active (local or on its machine) | waiting {capacity | environment-offline | turn} | failed {reason}
```

- `run(taskId)` first asks the Registry one question (#230, §9): `gate({ runtime })`, before a route is written. No plugin of that id, or one turned off → the task fails `plugin-disabled` (recoverable, told to its chat) and nothing opens; a Registry that cannot be asked → `registry-unavailable`; a runtime the `runtimes` catalogue does not know → `unknown-runtime`. The answer (`RegistryGate`: the runtime plugin with its config, the active memory and learning plugins, the enabled channels) stays on the route (`Route.plugins`) and is recorded on the session spec (`SessionOpenSpec.plugins`); the plugin's `config.defaultModel` is the session's model where the agent names none. A `fallback-api` asks the gate again, for `anthropic-api`, before the task leaves its environment. Without `registry` nothing is gated; without `runtimes`, `anthropic-api` is local and every other id a daemon's.
- `run(taskId)` resolves the runtime, the environment and the working folder once and never changes them. The environment is the task's `environmentId`, else the agent's default, else a delegating task's (#220), else the workspace's `defaults.environmentId` (AGT-05). The folder (#190) is the task's `workdir`, else a delegating parent's folder in the same environment, else the agent's `defaultWorkdir` in its default environment, else the first `cwdRoots` entry. It is checked with `pathWithin` on the machine's OS before any session opens (`workdir-outside-roots` otherwise), recorded on the route, the `environment.chosen` entry and the Session record, and sent as `OpenSpec.cwd`. After that: a `local` runtime (`anthropic-api`) opens a local Session and prompts; a daemon runtime goes through `Machine.openSession` — `opened` (prompted on `sessionOpened`), `queued` (Task `waiting {capacity, position}`), offline, or not reported by any machine yet (Task `waiting {environment-offline, policy}` then `queue` / `fail` / `fallback-api` — the last only when configured, through a transition that says why; a `queue` route binds to the first machine that reports the environment and never moves). `createEnvironmentProbe({ machines })` answers the schedule trigger's `EnvironmentProbe` with the same scan, and `run` adopts a task the trigger parked `waiting {environment-offline}`.
- `machineOnline` / `sessionOpened` / `sessionClosed` are the Machine's one-way notifications (machine principal); `report(taskId, report)` is `task_report` from the task's agent — or from a task sharing its turn (#395), in which case both take it; the `follow` task settles the Task at the turn end and closes the session.
- A chat task whose turn ends with its `ask_user` question still open (#396; CHT-09, COL-06) stays `waiting {input}`: the route parks `waiting-answer` (`Route.question`) and nothing follows it. `deliverAnswer(sessionId, requestId, input)` — the Session's hand-over of the late answer — moves the task `active` (`request {id}: input`) and prompts the session with the answer under that task, into the turn `answerTurnId(taskId, requestId)`, through the same capacity check and seam as any prompt (a running turn takes it or the route parks with the answer on it, `Route.answer`, sent when the turn ends or a slot frees); it answers `{ delivered: true, taskId, turnId | parked }`, `{ delivered: false, reason: 'no-route' }` when no task waits on the question, or `{ delivered: false, reason: 'refused', code, message }` when the session refused the prompt (the task failed `prompt-{code}`) — on either `delivered: false` the caller starts the asker again with a follow-up task. `questionCancelled(sessionId, requestId)` releases every task waiting on a dismissed question, completed with what its asking turn said. `sessionClosed` fails a `waiting-answer` route `session-refused` like one still opening.
- A message into a session that runs another task's turn (#395, `steerOrPrompt`; CHT-09): decided from the Session record before anything is sent. A runtime that reports `steer` gets the prompt inside the running turn — the ack names that turn, the route binds to it (`Route.joined`) and the task settles with it, its record reading `waiting {turn, sessionId, turnId}` → `active "joined running turn …"`; one that cannot parks the route `waiting-turn` with the task `waiting {turn}` and nothing sent, and `turnEnded(sessionId, turnId)` (the follower's own call at every turn end) prompts it into a turn of its own. Cancelling a joined task does not cancel the turn (it is the other task's); cancelling the turn's task cancels it for both.
- `createSessionFactory({ routing, sessions?, runtimes?, registry?, model?, policy?, files? })` — the concrete `SessionFactory`: the runtime id is looked up in `runtimes` (`RuntimeImpl`: `{ host: 'local', open(context, plugin) }` opens in-process, `{ host: 'daemon' }` → `null`, unknown → `unknown-runtime`; without `runtimes`, `anthropic-api` → `anthropicApiRuntime(options)` and every other id → `null`). A local runtime gets `RuntimePluginAccess`: its plugin's `config` (from `spec.plugins`), and `secret(name)` → `Registry.openSecret(name, runtimeId)` as the workspace owner — `undefined` when unset, never cached, `plugin-disabled` when the plugin was turned off since the gate. `anthropicApiRuntime` takes its key from the `anthropic-api-key` secret whenever a `registry` is given (the `model` seam replaces the model only) and fails `no-api-key` naming `/plugins/anthropic-api`; without a `registry` only the `model` seam opens it (tests) — there is no other key source (#231). Every session opens under `sessionPolicy(spec)` from `src/policy` unless `policy` overrides it. `createToolCallPort({ routing, sessions })` — the Machine's `ToolCallPort` over the same tool definitions. `createActorToolPorts({ principal, chatId?, routing?, sessions? })` — the `PlatformPorts` both use. `ask_user` (#122) raises a platform input request on the Session (`Session.raiseInput`, idempotent by call id) and tails `Session.resolution(requestId)` for the decision: the `answers` are the tool result (`answerText`), a cancel a `cancelled` tool error; without `sessions` it is `unsupported`. In a chat the wait is only `askQuickWaitMs` (default `ASK_QUICK_WAIT_MS`, 25 s): then `Session.detachInput` and `{ status: 'pending', questionId }` — the question outlives the turn and the session, `respond` still takes its answer, and `SessionPorts.answered` (`createAnswerFollowUp({ routing })`) posts it in the chat and hands it to the asker: as a new message in its own live session under the asking task (`Routing.deliverAnswer`, #396), or — when no task waits on the question any more — by starting the asker again with a follow-up task, resuming its engine conversation on the same machine when it can (`TaskContract.resumeFrom`, #285). A hand-over that throws is retried on the Session's `answers` reminder (`ANSWER_RETRY_MS`: 5 s, 30 s, 2 min, 10 min; `ANSWER_ATTEMPTS`: 5) and then said in the chat as `answer-not-delivered:{step}:{cause}` (`AnswerDeliveryError`). On the daemon path `placeRemote` fills `OpenSpec.policy` (the agent's rules and grants, the ancestors' constraints) for the daemon to compile (#121).
- `follow` is one supervisor task per router that follows every `running` route (`ctx.tasks` is single-flight per name) and is the Task's session driver for the stop cascade: a task settled from outside while its turn runs has its session cancelled, and `Task.sessionStopped` is sent when the turn ends.
- Failure and recovery (#46, #128; OPS-04/05): a chat-originated task that fails — a session that could not open (`session-open`, e.g. `no-api-key`), an offline environment under `fail`, a turn that ended in error or cancelled — is told to its chat as a `task-failed` status (`ref` = task id, `error` = the `TaskError`), so the thread names the failure where the answer would have been. A turn the eviction cut short parks the route as `interrupted` (never followed again) with the task `waiting {input, resume:{turnId}}`; `resume(taskId)` is the person's Resume: `Session.resume()`, the task `waiting → active` through a `resumed: …` transition, the route `running` on the `{turnId}:resume` turn, which `follow` settles as any other.

### Delegation (`src/routing/tools.ts`, #39)

`createActorToolPorts().task.delegate(spec, call)` is what the `delegate` tool does on both paths (architecture §7; COL-03..10, AC-05, AC-12):

```ts
const ports = createActorToolPorts({ principal: agentPrincipal, routing: () => Routing });
const outcome = await ports.task.delegate({ assignee, objective, context, constraints }, { callId, signal, onDelegated });
// { taskId, status: 'completed', result } | { taskId, status: 'failed', error } | { taskId, status: 'cancelled', notStopped }
```

- Collaborators first (`forbidden`), then `Task.delegate` under the limits (`limit` / `invalid` with the Task's message), then `Routing.run(childId)` — a child already routed or already settled is left as it stands — then the child's `result` stream. The child id is `childTaskId(parentTaskId, callId)`, so a restarted parent re-issuing the call re-awaits the same child; a parent turn aborted mid-wait answers `cancelled` with `notStopped` naming the child unless its stop is confirmed.
- The child runs on its agent's runtime and environment with no chat; its record is the Task tree. Its session opens with `approvalConstraints` = the approval rules of every ancestor's agent, so `sessionPolicy` never widens the chain; a child `request` parks it `waiting {approval}` (the parent is `waiting {child}`) and reaches the Inbox; the decision goes to the child session (`Session.respond`).

## Policy (`src/policy`)

The compile lives in `@agentic/runtimes` (`packages/runtimes/src/policy`, #121) so the machine daemon runs the same code over the rules an `OpenSpec` carries; this package re-exports it. `compilePolicy(rules)` turns `ApprovalRule`s into a `@sigx/ai-agent` `Policy` (first match; `tools` / `categories` / `source`; no match → no opinion; input requests always go to the client), `grantPolicy(grants)` decides per `ToolGrant` (`ask` / `deny` / allow), `agentPolicy(config)` = `firstMatch(rules, grants, allowAll)`, `constrainPolicy(policy, constraints)` lets the stricter answer win (deny > ask > allow), and `sessionPolicy(spec)` is what a session opens under — the agent's own, constrained by `spec.approvalConstraints` when it works a delegated task; `sessionPolicyOf(OpenSpec.policy)` is the same compile over what travels to a daemon.

`src/policy/requests.ts` (#40) are the views over a session log the approval flow reads: `requestRecordOf` / `requestRecordsOf` (a `request` joined with its `tool-call` — input, category, annotations — and its `request-resolved`), `sessionGrantsOf` (`session`-scoped allows in force, one per permission key), `requestRef` / `parseRequestRef` (`approval:{id}` | `input:{id}`, the chat status ref), `permissionKeyOf`, `policyRequestOf`, `ruleFor(rules, request)` and `describeRule(rule)` (`ask on destructive`, what the card names).

## PairingDirectory (`src/pairing`)

`PairingDirectory`, keyed `PAIRING_DIRECTORY_KEY` = `global:pairing`: pairing code → `{workspaceId, machineId, expiresAt}`, filed by `Workspace.registerMachinePending` over a hop, resolved once (anonymously — the `POST /auth/pair` door) with `resolve(code)`, then redeemed with `Machine.pair(code, info)`. Single use, 10 minutes; only the mapping lives here.

## Ledger (`src/ledger`)

`LedgerActor` keeps the books of one workspace month: key `ledgerKey(ws, ledgerMonth(at))` → `{ws}:ledger:{yyyy-mm}` (UTC months). `authorize: [sameWorkspace]`.

```ts
const books = actor(LedgerActor, ledgerKey(ws, ledgerMonth(Date.now())));
await books.append(row);                                   // idempotent by row.key; a row of another month is refused
await books.rows({ taskId, limit: 50 });                   // newest first
await books.summary({ by: 'task' });                       // 'agent' | 'task' | 'session' | 'turn' | 'day' (+ timeZone)
await books.recordCorrection({ agentId, week, what, at });  // LRN-09 — the @agentic/learning CorrectionLedger
```

- A `LedgerRow` is the core `UsageRow` (`at`, `sessionId`, `agentId`, `taskId?`, `usage`, `costUsd?`, `estimated`) plus an idempotency `key` (`{sessionId}:{epoch}:{seq}` for a row born of a session event) and `turnId?`. Every mutation is one `LedgerEntry` folded by the pure `applyLedgerEntry` — `ctx.append` where the runtime has it, otherwise the reducer plus `ctx.save()`.
- `summary` (OPS-07) never presents a guess as fact: `costUsd` sums only the rows that carry a cost and is `null` when none does (never `0` for unreported data), `estimatedCostUsd` / `estimatedRows` break the guessed share out, `unpricedRows` counts provider data that is unavailable, and `quality` is `reported` | `estimated` | `partly-estimated` | `not-reported`. `summarize(rows, options)` is the pure function behind it.
- `checkBudget(limits, spent)` / `remainingBudget` / `budgetError` / `isBudgetFailure` are the budget rules the Task actor and the Session driver share (`BUDGET_ERROR_CODE = 'budget'`). Estimated costs count in full.
- `ledgerRecorder()` is the Session's `usage` port: `defineSessionActor({ factory, usage: ledgerRecorder() })`. For every **turn-scoped** `usage` event (session-scoped events are cumulative totals and never counted) the driver prices the row — the `OpenedSession.usageRow` the factory returned (`createPlatformModelAgent(...).usageRow`, `estimated: true` for an unlisted model), else the event's own `costUsd` as reported, else unpriced — appends it to the month's Ledger one-way, and, when the session works a task, `Task.recordUsage` charges it. A `failed {budget}` task comes back as the verdict and the driver cancels the running turn (locally on the served session; on the daemon path through the `CommandSink`). The books never fail a turn: a recorder that throws is ignored.
- `ledgerCorrectionLedger(hops, ws)` adapts the actor to `@agentic/learning`'s `CorrectionLedger` by the month of each correction.
- `src/task/driver.ts` holds the driver's memory and learning steps (architecture §7 "retrieve memories" / "learning hook", §8) as pure functions over `MemoryStore` and `LearningPlugin`: `retrieveMemories(open, principal, config, { objective, context, tags }, budget)` → `{ entries, hits, scopes, skipped, text }`, `renderMemoryBlock` / `withMemoryBlock` (the `## Platform memory` block), `taskOutcomeOf` / `verificationOf` / `turnStatusOf` (LRN-03), `correctionOf`, `instructionProposals`, and `platformLearningPorts({ plugin, retrieval, verify })` — the platform composition the Session actor runs (see Session).

## Agent proposals (`src/agent`, LRN-08)

Learning may propose an instruction change; only a review applies it. `propose(proposals, origin)` parks instruction proposals (`{ kind: 'instruction', patch, reason, requiresReview: true }` only; one per distinct pending patch; an agent principal parks on itself only, a machine never) with `origin: { kind: 'task-end' | 'correction', sessionId, taskId?, messageId? }`; `listProposals(status?)` lists them under the same access rule; `reviewProposal(id, 'accept' | 'reject', reason?)` (users and external clients) accepts as a NEW config version with the patch appended to `instructions` — reversible with `rollback` — or rejects. `AgentView.pendingProposals` counts the queue. Entries `{ t: 'proposal' }` / `{ t: 'review' }` fold through `applyAgentEntry` beside the config versions.

## Audit (`src/audit`, OPS-03 / COL-09 / AGT-06)

`AuditActor` is the inspectable record of every consequential action. Key `auditKey(ws)` → `{ws}:audit` (the live log); `auditMonthKey(ws, auditMonth(at))` → `{ws}:audit:{yyyy-mm}` (a UTC month archive the live log rolls into). `authorize: [sameWorkspace]`; only a user records over the wire.

```ts
const history = actor(AuditActor, auditKey(ws));
await history.record(event);                                              // idempotent by event.key; true when new
await history.list({ kinds: ['task.transition'], taskId, limit: 50 });   // { events (newest first), next }
await history.list({ agentId, since, until, cursor: page.next });       // exclusive seq cursor; null when nothing older can match
await history.stats();                                                    // { inState, recorded, archived, months }
```

- An `AuditEvent` is `{ key, seq, kind, at, by, summary, agentId?, taskId?, sessionId?, data }`; `kind` is one of `AUDIT_KINDS` (`approval.requested/resolved`, `delegation.created`, `environment.chosen`, `task.transition`, `config.versioned`, `proposal.reviewed`, `machine.paired/revoked`, `plugin.enabled/disabled/granted`, `secret.opened`) and `data` its typed payload (`AuditDataByKind`). The exact shapes and who emits them are in `docs/architecture.md` §4 Audit.
- `recordAudit(ctx, workspaceId, event)` is what an actor calls after the work is durable: a ONE-WAY hop to the live log that swallows every failure — a history that is unreachable never fails the turn. `AuditPort` is the same contract behind an interface (`SessionPorts.audit`, `RoutingPorts.audit`; `auditPort()` default, `capturingAuditPort()` for tests). Idempotency is the emitter's: derive `key` from the source record so a retry folds once.
- The live window keeps `AUDIT_WINDOW` (500) events; at `AUDIT_WINDOW + AUDIT_ROLL_BATCH` the oldest 100 roll into their month archives through the idempotent `archive` hop, and `list` on the live key walks the archives when a cursor passes the window (`since` / `until` prune months). Every mutation is one `AuditEntry` folded by the pure `applyAuditEntry`.
