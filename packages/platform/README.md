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

`defineSessionActor({ factory, commands?, now? })` builds the `session` actor, keyed `{ws}:session:{id}`. It never imports a runtime adapter: the `SessionFactory` port turns a runtime id into a live `AgentSession` (the platform-managed path) or `null` (a daemon hosts it), and the `CommandSink` port carries wire commands to that daemon's machine.

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
