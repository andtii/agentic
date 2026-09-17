# Changelog

All notable changes to `@agentic/platform` (Keep a Changelog, semver).

## [Unreleased]

- Package skeleton.
- `auth`: `sameWorkspace` / `workspaceOwner` policies, `workspaceKey`, `workspaceOfActorKey` (#14).
- `workspace`: the `Workspace` root actor — owner, agent/chat/machine/schedule index, settings, pairing codes, `exportAll` / `deleteAll` task stubs (#14).
- `testing`: shared actor test harness — `testActorApp`, `recordingStorage`, `userPrincipal`, `statusOf` (#14).
- `notify` (#29): `NotificationChannel` seam, `Inbox` actor (`{ws}:inbox`; append / push / list / unread / ack / subscriptions, capped at 500, `authorize: [sameWorkspace]`), `deliverAll` recording a `DeliveryAttempt` per channel, and `webPushChannel` with VAPID ES256 over WebCrypto (contentless push; payload encryption is a follow-up).
- Memory actor (#26): `Memory` keyed `{ws}:memory:{scope}` over the `@agentic/memory` core with `ctx.save()` per mutating turn; `memoryAuthorize` (same workspace; users and `memory`-scoped external clients own every scope; an agent reaches only `agent:{self}`; `shared:*` by a per-scope ACL checked in the turn — no ACL, no agent access); `memoryActorPlugin` / `actorMemoryStore` — the actor as a `MemoryPlugin` with paged export and batched import.
