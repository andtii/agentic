# Changelog

All notable changes to `@agentic/core` (Keep a Changelog, semver).

## [Unreleased]

### Added

- `ChatEntry` status kinds `request` / `request-resolved` (#40): a session's open request and its settlement as chat status entries; their `ref` is required and typed `RequestStatusRef` (`approval:{requestId}` | `input:{requestId}`, `isRequestStatusRef`) on both so they always pair up.
- `EnvironmentVerdict` and the optional `EnvironmentDescriptor.doctor` (#43): the runtime's per-environment `doctor` verdict (`ok`, the findings naming the environment, `checkedAt`) travels in `hello` / `env` so the Machine can keep it; `environmentVerdict(report, environmentId, checkedAt)` derives it from a `DoctorReport`, `toEnvironmentDescriptor` takes it as a fifth argument. `DoctorFinding` moved to `environment.ts` (same export).

- `RuntimeDriver` seam (#75): `LocalEnvironment`, `EnvironmentInspection`, `RuntimeOpenContext` with `callTool`, `OpenedRuntimeSession`, `DoctorReport` and `toEnvironmentDescriptor` — the daemon (#19) consumes it, the Claude Code driver (#20) implements it.
- `WorkspaceSettings` / `NotificationPrefs` / `NotificationKind` / `NOTIFICATION_KINDS` (#25): the workspace settings form binds to them.
- Platform contracts (#13): branded ids and `createId`/`actorKey`; `AgentConfig` with versions and limits; `ChatEntry` and the `resolveActivation` rule; `TaskStatus`/`WaitReason`/`TaskContract`/`TaskSnapshot` with `canTransition` and deterministic `childTaskId`; `EnvironmentDescriptor` and `CapabilityReport`; `PluginManifest`; `MemoryPlugin`/`MemoryStore`/`LearningPlugin` seams; `Principal` (user, machine, agent, external with scopes) and `sameWorkspace`; the daemon envelope `DaemonFrame`/`PlatformFrame` generic over the wire types; `Usage` helpers.
- `SESSION_EVENTS_TOPIC` and `SessionEvent` (#16): the topic a Session publishes status and final messages on, keyed by the chat's actor key, and the Chat actor subscribes to.
