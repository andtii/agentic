# Changelog

All notable changes to `@agentic/core` (Keep a Changelog, semver).

## [Unreleased]

### Changed

- `WorkspaceSettings` is the shape the Workspace actor stores (#227, part of #224): `{ timeZone, notifications: { inbox, push }, defaults: { runtime, environmentId? }, retention: { sessionLogDays, artifactDays } }`, with `WorkspaceDefaults`, `RetentionSettings` and `DEFAULT_WORKSPACE_SETTINGS`. It replaces the shape from #25 (`notifications.kinds`, a flat `defaultEnvironmentId`), which no actor ever stored; `NotificationPrefs` is now `{ inbox, push }`. There is no `defaults.model`: a model is a runtime's to default. `NotificationKind` / `NOTIFICATION_KINDS` are unchanged.

### Added

- Provider quota contract (#267, part of #261; OPS-07, PLG-09), in `quota.ts`: `QuotaWindow` / `QuotaSnapshot` (normalized limits: `utilization` 0..1 or `null`, `resetsAt` ISO, `status` `ok` | `warning` | `exhausted` | `unknown`; `availability` `reported` | `partial` | `not-reported` with a `reason`), `QuotaUnit`, `QuotaStatus`, `QuotaSignal` and the `QuotaSource` seam (`probe?(env, ctx)`, `fromSignal?(signal, env)`). `QuotaAccount` / `UsageLimitsQuery` / `UsageLimits` are the `usage_limits` tool's shape. Helpers `mergeQuota(prev, next)` (next's windows replace same-id windows, the rest are kept; `not-reported` replaces everything) and `tightestWindow(snapshot)`. New plugin kind `'quota'` (not single-slot), new scope `'usage'`, new daemon frame `quota { environmentId, snapshot }` in `DAEMON_FRAME_TYPES`.
- `env.request` / `env.response` on `PlatformFrame` / `DaemonFrame` (#236), carrying the `EnvOp` / `EnvResult` / `EnvError` vocabulary; both frame-type lists include them. `hello` and `env` carry the optional `policy: MachinePolicy`. `put` is an upsert, so `unknown-environment` answers a `remove` only.
- Web-managed environments vocabulary (#236, part of #224; decisions 2026-09-19 (c)), in `environment.ts`:
  - `EnvironmentInput` (`id?`, `name`, `runtime`, `cwdRoots`, `concurrency?`, `accountLabel?`): what the platform may ask a daemon to create or change. It has no `profileDir` — the daemon allocates it and it never crosses the wire.
  - `EnvOp` (`put` | `remove`), `EnvResult`, `EnvError` / `EnvErrorCode` (`policy-disabled`, `outside-allowed-roots`, `unknown-runtime`, `in-use`, `unknown-environment`, `invalid`, `io`, and the platform-side `timeout`).
  - `MachinePolicy` (`webManaged`, `allowedRoots`): the machine-local policy a daemon reports. The frames themselves land with their schemas.
- Plugin configuration contract (#226, part of #224; PLG-02, PLG-04), in `plugin-config.ts`:
  - `ConfigSchema`: the typed JSON-Schema SUBSET a manifest's `config` is written in. Properties are a string (with `enum`, `format: 'uri'`), a number / integer (with `minimum` / `maximum`), a boolean, a string list or a string map, each with `title`, `description`, `default`; plus `required` and `additionalProperties`. A bare `{ type: 'object' }` or `{}` still means "anything". `JsonSchema` stays as a deprecated alias of it, so existing manifests compile unchanged.
  - `PluginManifest.secrets` (`PluginSecretDeclaration`: `name`, `title`, `description`, `required`). A secret is never a config property.
  - `validateConfig(schema, value)` → `{ ok: true, value } | { ok: false, errors: { path, message }[] }`. Unknown keys are rejected once the schema declares `properties`, unless `additionalProperties: true`. Defaults are not filled in.
  - `configDefaults(schema)`.
  - `PluginReadiness` and the pure `pluginReadiness(state, facts)`: `disabled`, then `needs-config`, `no-kek` / `needs-secret`, `needs-grant`, `needs-machine` (a `runtime` plugin listing the `daemon-hosted` capability, `DAEMON_HOSTED_CAPABILITY`, with no environment of its id), else `ready`. The caller supplies `PluginReadinessFacts` (`secretNames`, `environments`, `hasKek`).
  - `SINGLE_SLOT_KINDS` (`memory`, `learning`) and `isSingleSlot(kind)`.
- Chat attachments contract (#204, part of #203), in `files.ts`:
  - `ChatFile`: a file attached to a chat. Messages reference it as `agentic-file:<chatId>/<fileId>` in the `url` of an `image` or `file` part, never inline.
  - URI helpers: `chatFileUri`, `parseChatFileUri` (strict, url-safe segments) and `isChatFilePart` / `ChatFilePart`.
  - `isTextLikeMediaType`.
  - Limits: `CHAT_FILE_MAX_BYTES` (10 MiB), `CHAT_FILE_TEXT_MAX_BYTES` (256 KiB), `CHAT_FILE_INLINE_BUDGET` (700 KiB of base64 per turn, under the 1 MiB daemon frame) and `MODEL_IMAGE_TYPES`.
  - Ports: `ChatFileStore` (`put` / `get` / `markPosted` / `deleteChat` / `sweepOrphans`, bytes only, no access decisions), `ChatFileBody` and `ChatFileRead` (what `chat_file_read` returns).
- `ChatEntry` `msg` carries an optional `workdir: { agentId, ref: WorkdirRef | null }` (#190): the note `Chat.setWorkdir` writes when a member's working folder for the chat changes. Whoever folds the entries copies `ref` onto the member (`null` clears it), so the member's folder replays like every other piece of chat state.
- `fs.request` / `fs.response` on `PlatformFrame` / `DaemonFrame` (#187), carrying the `FsOp` / `FsResult` / `FsError` vocabulary from #186. Both frame-type lists include them.
- `ChatRoster` / `ChatRosterMember` (#194, CHT-07): who a session's agent shares its chat with — the members by id, name and role, the coordinator, and which member the session runs as (`self`). The router fills it in for a chat-originated task; the runtime renders it into the system prompt.
- Working folders (#186, part of #185):
  - `TaskContract.workdir`, `ExecutionDefaults.defaultWorkdir` and `ChatMember.workdir` (`WorkdirRef`) say which folder a task's session runs in. The folder is absolute, machine-native and within the environment's `cwdRoots`.
  - The `fs.request` vocabulary: `FsOp` (`list` | `worktree`), `FsResult`, `FsListResult` / `FsEntry` / `FsGitInfo`, `FsWorktreeResult`, `FsError` / `FsErrorCode`, `FS_LIST_MAX_ENTRIES`. The frames themselves land with their schemas (#187).
  - Pure path helpers:
    - `pathWithin(path, roots, os)`: case-insensitive and separator-agnostic on Windows; never matches a sibling prefix or a relative path.
    - `normalizePath`.
    - `suggestWorktreePath`: `<repo>/main` → `<repo>/branches/<slug>`, else `<repo>-worktrees/<slug>`.
- `MemoryStore.delete(id): Promise<boolean>` (#149, MEM-05 / MEM-08): remove an entry for good; `false` when there is no such entry. `retire` stays the soft form that keeps the history. Every `MemoryStore` implements it.
- `ChatEntry` kind `rename` (#124): `{ t: 'rename', title, at }` — the chat's title as an entry, so a fold over the entries carries the title (the last `rename` wins) like every other piece of chat state.
- `ChatEntry` status kind `task-failed` (#128): the task an agent was activated for could not run or ended in error — `ref` is the task id, `error` the `TaskError`; `SessionEvent` status carries the optional `error` so the router can publish it to the chat (OPS-04).
- `ChatEntry` status kinds `request` / `request-resolved` (#40): a session's open request and its settlement as chat status entries; their `ref` is required and typed `RequestStatusRef` (`approval:{requestId}` | `input:{requestId}`, `isRequestStatusRef`) on both so they always pair up.
- `EnvironmentVerdict` and the optional `EnvironmentDescriptor.doctor` (#43): the runtime's per-environment `doctor` verdict (`ok`, the findings naming the environment, `checkedAt`) travels in `hello` / `env` so the Machine can keep it; `environmentVerdict(report, environmentId, checkedAt)` derives it from a `DoctorReport`, `toEnvironmentDescriptor` takes it as a fifth argument. `DoctorFinding` moved to `environment.ts` (same export).

- `RuntimeDriver` seam (#75): `LocalEnvironment`, `EnvironmentInspection`, `RuntimeOpenContext` with `callTool`, `OpenedRuntimeSession`, `DoctorReport` and `toEnvironmentDescriptor` — the daemon (#19) consumes it, the Claude Code driver (#20) implements it.
- `WorkspaceSettings` / `NotificationPrefs` / `NotificationKind` / `NOTIFICATION_KINDS` (#25): the workspace settings form binds to them.
- Platform contracts (#13): branded ids and `createId`/`actorKey`; `AgentConfig` with versions and limits; `ChatEntry` and the `resolveActivation` rule; `TaskStatus`/`WaitReason`/`TaskContract`/`TaskSnapshot` with `canTransition` and deterministic `childTaskId`; `EnvironmentDescriptor` and `CapabilityReport`; `PluginManifest`; `MemoryPlugin`/`MemoryStore`/`LearningPlugin` seams; `Principal` (user, machine, agent, external with scopes) and `sameWorkspace`; the daemon envelope `DaemonFrame`/`PlatformFrame` generic over the wire types; `Usage` helpers.
- `SESSION_EVENTS_TOPIC` and `SessionEvent` (#16): the topic a Session publishes status and final messages on, keyed by the chat's actor key, and the Chat actor subscribes to.
