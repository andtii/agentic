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

## Workspace (`src/workspace`)

`ws:{userId}`; save persistence; every mutation ends in `ctx.save()` inside the turn. Methods: `get`, `createAgent`, `createChat`, `registerMachinePending` → `{machineId, pairingCode, expiresAt}`, `claimPairing(code)` (single use, 10 min), `listMachines`, `removeMachine`, `updateSettings`, `exportAll` / `deleteAll` (detached-task stubs for OPS-10).

## Notifications (`src/notify`)

- `Inbox` — the `{ws}:inbox` actor (`inboxKey(workspaceId)`): `append`, `push`, `list({ unreadOnly, limit })` newest first, `unread`, `ack(ids | 'all')`, `subscribe` / `unsubscribe` / `subscriptions`. `authorize: [sameWorkspace]`. Capped at `INBOX_CAP` (500); every mutation is a `reduceInbox` entry followed by `ctx.save()`. `list` and `unread` are declared `reads`, so `useActorState(Inbox, key).list(...)` is a live subscription.
- `NotificationChannel` — the outbound seam: `{ id, deliver(notification, { workspaceId, subscriptions }) → { ok, error?, expired? } }`. `defineInbox({ channels })` builds the Inbox the app registers; `push` records first, then fans out through `deliverAll`, and every channel's outcome — a rejection included — lands on the record as a `DeliveryAttempt`, never as a throw.
- `webPushChannel({ fetch, vapid, ttlSeconds })` — RFC 8030 push with VAPID (ES256 over WebCrypto, edge-safe). Contentless in v1: the service worker re-reads `Inbox.list` on a push event. `vapidSigner(keys)` is exported on its own.

```ts
const Inbox = defineInbox({ channels: [webPushChannel({ vapid: { publicKey, privateKey, subject } })] });
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

`Memory` is one actor per scope, keyed `{ws}:memory:{scope}` (`agent:{id}` or `shared:{name}`): the `@agentic/memory` core state plus a shared-scope ACL. Methods: `put`, `update`, `retire`, `get`, `query`, `exportPage(after, size)`, `importBatch(rows, { onConflict })`, `compact`, `setAcl` / `getAcl` (owner only / read), `stats`. Every mutating turn ends in `ctx.save()` (Workers eviction rule); the reducer `applyMemoryActorEntry` is shaped for `ctx.append` once `@sigx/actors` ships it.

Authorization: `memoryAuthorize` on the definition (same workspace; a user or a `memory`-scoped external client owns every scope; an agent reaches `agent:{id}` only as that agent; a machine nothing) and `aclAllows` inside every method for `shared:*` (`{ read, write }` lists or `"*"`; no ACL means no agent access — AC-10, MEM-11). The app must configure a principal `codec` on `createServerApp`, or `ctx.principal` is `null` and every in-turn check fails closed.

`memoryActorPlugin({ workspace })` is the platform's default `MemoryPlugin`: `open(scope)` returns `actorMemoryStore(actor(Memory, key))`, streaming `export()` by id-ordered pages and batching `import()`.

## Schedule (`src/schedule`)

```ts
import { defineScheduleActor, type TriggerPort } from '@agentic/platform';

const trigger: TriggerPort = { fired: (event) => inbox.push(event) }; // or create a Task
export const Schedule = defineScheduleActor({ trigger });

const s = host.actor(Schedule, 'ws_alice:schedule:sch_1');
await s.create({ kind: 'reminder', title: 'standup', recurrence: { kind: 'cron', cron: '0 9 * * 1-5', tz: 'Europe/Stockholm' } });
await s.get(); // { next, lastRun, runs, log, ... }
await s.disable(); await s.enable(); await s.update({ recurrence: { kind: 'at', at: Date.now() + 3_600_000 } });
```

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
- Local turns run in `tasks.drive`; after an eviction the restarted task closes the turn as interrupted — open calls cancelled, open requests resolved `cancel`, `error {code: 'process_exited', data: {interrupted: true}}`, `turn-end {stopReason: 'error'}` (`isInterruptedTurnEnd`). A model call is never re-run.
- Daemon path: `forwardFrames(frames)` and `commandReplied(reply)` are internal (only the machine the session was opened on); a command sent to a daemon answers `pending` until its reply arrives.
- `authorize: [sameWorkspace, sessions scope]`. The chat hears `session-started`, `typing`, the final assistant `message` and `session-ended` on `SESSION_EVENTS_TOPIC`.

## Machine (`src/machine`)

`defineMachineActor({ socket, sessions?, tools?, now?, heartbeatWindowMs?, commandTimeoutMs? })` builds the `machine` actor, keyed `machineKey(ws, id)` = `{ws}:machine:{id}`. The host owns the socket (`MachineSocketPort`: send / close by actor key — on Cloudflare the Machine's Durable Object holds the daemon's hibernated WebSocket, `apps/web/src/daemon`); the actor owns the protocol and the record.

```ts
const Machine = defineMachineActor({ socket: daemonSockets.port, sessions: () => Session, tools: platformTools });
const Session = defineSessionActor({ factory, commands: { send: (t, cmd) => actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) } });
const m = actor(Machine, machineKey(ws, id));
await m.pair(code, { name: 'laptop' });                // → { token, workspaceId, machineId }; only the hash is kept
await m.openSession(sessionId, environmentId, spec);   // 'opened' | 'queued' (EXE-09)
```

- Methods: `pair(code, info)` (redeems through `Workspace.claimPairing`), `tokenRecord()` (for `serverAuth({ machines })` and the socket handshake), `revoke()`, `rename(name)`, `get()` → `MachineView` (online, lastSeen, os, daemonVersion, capabilities, environments, hosted / queued sessions, pending commands, recent closures), `openSession` / `closeSession` / `sendCommand` (session drivers), and the socket entry points `socketMessage(raw)` / `socketClosed()` / `heartbeat()` (the machine itself).
- Routing (§5b): `session.opened` → a synthesized wire `hello` to the Session; `session.frame` → `Session.forwardFrames`; `session.reply` → `Session.commandReplied`; `session.closed` frees the slot and dequeues; `tool.call` → `ToolCallPort.call(input, agentPrincipal)` → `tool.result` (a `ToolCallError` names the error code).
- Liveness: a socket close is offline at once; a silent daemon is offline after `heartbeatWindowMs` (90 s) on the `liveness` reminder, which also answers pending commands past `commandTimeoutMs` (120 s) with `error internal`. On reconnect `welcome.wanted` carries the last forwarded cursor per session and pending commands are re-sent.
- `authorize: [sameWorkspace, machines scope]`; `pair` / `tokenRecord` for the owner or the machine itself, `revoke` / `rename` for the owner, the socket entry points for the machine only, session methods for anyone but a machine.

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
- Sessions publish `SessionEvent`s on `sessionEvents(chatKey)` (`topic('session-events', chatKey)`); the chat folds status and final messages into entries and tracks `activeSessions`. `typing` is not durable. A payload that is not a well-formed `SessionEvent` (missing ids or `at`, unknown `kind` or `status`) throws, so `host.publish` reports a delivery failure and nothing is recorded.

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
