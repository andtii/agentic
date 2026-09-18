# Changelog

All notable changes to `@agentic/core` (Keep a Changelog, semver).

## [Unreleased]

### Added

- `ChatEntry` `msg` carries an optional `workdir: { agentId, ref: WorkdirRef | null }` (#190): the note `Chat.setWorkdir` writes when a member's working folder for the chat changes. Whoever folds the entries copies `ref` onto the member (`null` clears it), so the member's folder replays like every other piece of chat state.
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
