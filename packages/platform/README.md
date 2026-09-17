# @agentic/platform

Actor definitions on @sigx/actors: Workspace, Agent, Chat, Task, Session, Machine, Schedule, Memory, Inbox, Ledger, Registry, Audit; auth helpers.

Design: `docs/architecture.md`. What may move into the sigx estate later: `docs/promotion.md`.

## Auth helpers (`src/auth`)

Every actor's `authorize` chain starts with `sameWorkspace`, then adds who may call that actor:

```ts
import { sameWorkspace, workspaceOwner } from '@agentic/platform';

defineActor({ type: 'Workspace', authorize: [sameWorkspace, workspaceOwner], … });
```

Keys: the Workspace root is `workspaceKey(id)` = `ws:{workspaceId}`; children are core's `actorKey(workspaceId, kind, id)` = `{workspaceId}:{kind}:{id}`. `workspaceOfActorKey(key)` reads either shape. v1 has one workspace per user, so `workspaceId === userId`.

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
