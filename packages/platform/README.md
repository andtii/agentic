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
