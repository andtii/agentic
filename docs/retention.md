# Retention and deletion (OPS-10)

What the platform keeps, for how long, what `exportAll` / `deleteAll` do, and
which copies are outside the platform's control. Requirement: **OPS-10 —
retention and deletion behaviour MUST be explicit, including plugin-managed
data and copies supplied to external runtimes.** Design: `docs/architecture.md`
§4 (Workspace, Registry), §9. Code: `packages/platform/src/workspace/cascade.ts`,
`packages/platform/src/registry`.

## What is stored, and where

Every durable record of a workspace is an actor record under the workspace's
key prefix (`ws:{ws}` for the root, `{ws}:{kind}:{id}` for children), one
Durable Object each on Cloudflare (`apps/web`). Nothing of a workspace lives
in a shared table.

| Actor | Holds | Index that reaches it |
|---|---|---|
| Workspace `ws:{ws}` | owner, ids of agents / chats / machines / schedules, settings (time zone, notification prefs, defaults, **retention**), pending pairing codes, the `ops` log of the last export / delete | — (root) |
| Agent `{ws}:agent:{id}` | identity, every config version | `Workspace.agents` |
| Memory `{ws}:memory:{scope}` | entries of one scope (`agent:{id}` private, `shared:{name}`) and the shared-scope ACL | implied: every agent's own scope + every `memoryPolicy.shared` scope any agent names |
| FlatMemory `{ws}:memory:{scope}` (#281) | the flat memory plugin's entries of one scope (its ACL is the Memory actor's) | implied: the same scopes as Memory |
| Chat `{ws}:chat:{id}` + ChatPage `…:p{n}` | members, the last 200 entries, archived pages of 100 | `Workspace.chats` (pages `0..seq/100`) |
| Schedule `{ws}:schedule:{id}` | recurrence, target agent, firing log | `Workspace.schedules` (`createSchedule` allocates the id) |
| Inbox `{ws}:inbox` | notifications (capped at 500), push subscriptions | implied (one per workspace) |
| Registry `{ws}:registry` | plugins (manifest, enabled, config, grantedPermissions), connectors, **secrets sealed under `WORKSPACE_KEK`** | implied (one per workspace) |
| Task `{ws}:task:{id}` | task transitions | **not indexed** by the Workspace — reachable only through a `WorkspaceStore.list` (see below) |
| Session `{ws}:session:{id}` + SessionPage `…:p{n}` + SessionTranscriptPage `…:t{n}` | the recent event window, its index, the bounded transcript view; older events in pages of ~256 KB; on the `anthropic-api` path the whole transcript (the model's history) in pages of ~512 KB (#397) | a chat member's live session through the chat's binding (`Chat.get().sessions`, #399); its pages through the record: `Session.get().pages` counts every `SessionPage` ever written (a daemon session keeps only the newest `RETAINED_PAGES` = 16 and forgets the rest — the record deleted at once, #397 — so a delete of an older number finds nothing) and `transcriptPages` the transcript's. `Routing.endSession` (New session, removal) and `Workspace.deleteAll` purge both kinds before the record; a session no chat binds is reachable only through a `WorkspaceStore.list` |
| Ledger `{ws}:ledger:{yyyy-mm}`, Audit `{ws}:audit` | usage rows; approvals and transitions | not built yet; same rule as Task / Session |
| Machine `{ws}:machine:{id}` | machine token hash, environments, activity | not built yet; `Workspace.machines` is the index |
| Chat attachments (R2, not an actor) | the bytes of every file uploaded into a chat, under `files/{ws}/{chat}/{fileId}` in the `ARTIFACTS` bucket; the record (name, type, size, which message) is in the Chat's state | the Chat: `Workspace.deleteAll` deletes each indexed chat's files (`ChatFileStore.deleteChat`) before purging the records |

Runtime bookkeeping the actor host keeps beside a record (task ledger
`$sigx:tasks`, reminder shards) is not workspace data: the host clears a task
ledger when its task settles, and a reminder that fires for a purged actor
finds an empty state and disarms itself.

## Retention windows

`Workspace.settings.retention` (`updateSettings({ retention })`):

| Setting | Default | Applies to |
|---|---|---|
| `sessionLogDays` | 90 | Session event logs and transcripts, Task result payloads. A sweeper that retires records older than this is **not implemented in v1** — the setting is recorded and exported so the window is explicit; enforcement is a follow-up on the Session / Task actors. |
| `artifactDays` | 30 | Objects in the `ARTIFACTS` R2 bucket: exports written by `exportAll` and task artifacts. Enforced by an R2 lifecycle rule on the bucket, configured per deployment to this number — the platform does not delete artifacts itself. |

Chat attachments (#203, #207) are kept as long as their chat: the `files/`
prefix of the `ARTIFACTS` bucket must have **no lifecycle rule** — scope the
`artifactDays` rule to the export and artifact prefixes, never the whole
bucket. An upload that is never posted into a message is an orphan: the Chat
forgets it after 24 h (`PENDING_TTL_MS`) and the web app deletes its bytes
once they are a day old — there is no cron yet, so the sweep runs
opportunistically after an upload, at most once an hour per isolate, one
listing page of `files/` per run, resuming where the last run stopped
(`apps/web/src/files`). A posted file is never swept.

Everything else (agent configs, memory, chats, schedules, registry) is kept
until the user removes it or runs `deleteAll`. Memory `working` entries with a
`ttl` are dropped by `Memory.compact`. The Inbox keeps the newest 500
notifications. Pairing codes expire after 10 minutes.

## `exportAll`

`Workspace.exportAll()` starts a detached task that writes, through the
app-level `ArtifactSink` (R2 on Cloudflare), under `{ws}/{ISO stamp}/`:

| File | One row per | Source |
|---|---|---|
| `workspace.ndjson` | workspace | `Workspace.get` — machines without their pairing codes, no `ops` |
| `agents.ndjson` | agent | `Agent.get` + `listVersions` |
| `memory.ndjson` | memory entry | `Memory.exportPage` over every implied scope, then `FlatMemory.exportPage` (rows marked `plugin: 'agentic.memory.flat'`) |
| `chats.ndjson` | chat, then every entry | `Chat.get` + `history` (oldest first) |
| `schedules.ndjson` | schedule | `Schedule.get` |
| `inbox.ndjson` | notification, push subscription | `Inbox.list` + `subscriptions` |
| `registry.ndjson` | plugin, connector, **secret name** | `Registry.exportRows` — no sealed values, no plaintext |
| `tasks.ndjson`, `sessions.ndjson` | task; session + its events | only when the store can `list` the workspace's records |
| `manifest.json` | — | files written, the retention settings, and `notExported` (records the cascade saw but could not read: types without a reader, and typed records whose read failed — an indexed schedule never created, a task or session that refused) |

Every row is read through the owning actor's own methods as the workspace
OWNER (the task carries the owner's principal), never from raw storage.
Progress is in `Workspace.get().ops.export` (`startedAt`, `finishedAt`,
`prefix`, `count`, `error`).

## `deleteAll`

`Workspace.deleteAll()` starts a detached task that purges, through the
app-level `WorkspaceStore` port, every child record the index implies (table
above) plus everything `WorkspaceStore.list(ws)` returns, then clears its own
record last. After it, activating any of the workspace's actors yields a
fresh, unsaved state. The unit test `packages/platform/__tests__/workspace-cascade.test.ts`
checks that no record of the workspace remains in storage.

`WorkspaceStore.purge(ref)` is the deployment's: in tests it is
`host.deactivate` + `storage.clear` over `memoryStorage`. On Cloudflare each
actor is its own Durable Object, so `apps/web` (`src/retention.ts`, #100)
asks the target object to purge itself: a `POST /_agentic/purge` to that
object, authenticated with `SESSION_SECRET` and never forwarded by the
Worker, deactivates the actor and runs `storage.deleteAll()` +
`deleteAlarm()`. A namespace cannot be enumerated, so the Cloudflare store
has no `list`: tasks, ledger months, audit records and sessions no chat
binds stay behind until their own retention lands — a chat's sessions and
their pages are reached through the binding and the record (table above).
Without `SESSION_SECRET` every purge is
refused and `ops.delete.error` records it; the purge of already-reached
children is not rolled back.

Deletion is not reversible; there is no grace period. Export first.

## Plugin-managed data

- A plugin's **config** and **granted permissions** live in the Registry and
  go with `deleteAll`. Disabling a plugin (`Registry.disable`) keeps its
  config; removing it (`remove`) drops the plugin and its connectors.
- **Secrets** are sealed with AES-GCM under the deployment's `WORKSPACE_KEK`,
  bound to `{ws}:secret:{name}`. They are handed out only by
  `Registry.openSecret(name, pluginId)` to a plugin that is enabled and holds
  the matching `secret:` grant, and are purged with the Registry. Rotating
  `WORKSPACE_KEK` makes every stored secret unreadable; re-enter them.
- Memory written by the default Memory plugin is in Memory actors, by the flat plugin in FlatMemory actors (above). A
  third-party memory or learning plugin that stores elsewhere must say so in
  its manifest description; the platform cannot reach it.

## Copies outside the platform's control

These are NOT deleted by `deleteAll` and NOT covered by the retention settings:

| Copy | Where | Who removes it |
|---|---|---|
| Claude Code sessions, transcripts, credentials | on each paired machine under the profile's `CLAUDE_CONFIG_DIR` (EXE-10) | the machine's owner (`agentic-daemon` does not delete them) |
| Daemon event logs — **the history of a daemon session** (#397): the platform keeps only its newest pages and reads older events from here | `apps/daemon` NDJSON logs on the machine, `%LOCALAPPDATA%/agentic/sessions/{sessionId}.ndjson`, trimmed after every turn to the newest whole turns under `retention.maxBytes` (64 MB); a session's file is not deleted when the session ends | the daemon's retention for what is old, the machine's owner for the file |
| Prompts, tool inputs and outputs sent to a model provider | the provider (Anthropic API) under its own retention policy | the provider |
| Data an MCP connector or A2A peer received | the remote server | that operator |
| Push notifications already delivered | the browser / push service | the user's device |
| Exports and artifacts in R2 | the `ARTIFACTS` bucket, until `artifactDays` | the bucket lifecycle rule, or the operator |
| Chat attachments inlined into a prompt or read with `chat_file_read` | the model provider (as for any prompt), and a claude-code session's transcript on the machine | the provider / the machine's owner |
| Backups / point-in-time recovery of Durable Object storage | Cloudflare | Cloudflare's retention |
| GitHub identity (`gh_<id>`) used for login | GitHub | the user, at GitHub |

An export contains `notExported` for anything the cascade saw but could not
read, so a user can tell what an archive does not hold.
