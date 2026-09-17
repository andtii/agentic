# @agentic/core

Edge-safe platform contracts. Types plus a few pure helpers, zero dependencies, no `node:` imports (enforced by a test). Every other package imports its cross-package types from here; a missing type is added here first in its own `contract` PR (see `AGENTS.md`).

| Module | What it defines |
|---|---|
| `ids` | Branded ids (`WorkspaceId`, `AgentId`, `ChatId`, `TaskId`, `SessionId`, `MachineId`, `EnvironmentId`, `ScheduleId`, `MessageId`), `createId`, `actorKey`, `workspaceOfKey` |
| `agent` | `AgentConfig`, `FrozenAgentConfig`, `AgentConfigVersion`, `Limits`, `ApprovalRule`, `MemoryPolicy`, `ExecutionDefaults`, `ToolGrant`, `SkillRef`, `RuntimeId`, `OfflinePolicy` |
| `chat` | `ChatEntry`, `Author`, `PromptPart`, `ChatMember`, `PostResult`, `resolveActivation` (the CHT-06 rule) |
| `task` | `TaskStatus`, `WaitReason`, `TaskOrigin`, `TaskContract`, `TaskResult`, `TaskSnapshot`, `TaskTransition`, `canTransition`, `isTerminal`, `childTaskId` |
| `environment` | `EnvironmentDescriptor`, `CapabilityReport`, `MachineInfo`, `AuthStatus`, `IsolationMechanism` |
| `plugin` | `PluginManifest`, `PluginKind`, `PermissionScope`, `PluginState`, `JsonSchema` |
| `memory` | `MemoryKind`, `MemoryEntry`, `NewMemoryEntry`, `MemoryQuery`, `RankedMemory`, `MemoryScope`, `MemoryStore`, `MemoryPlugin`, `ImportReport`, `PluginContext` |
| `learning` | `LearningPlugin`, `Proposal`, `Correction`, `TaskOutcome` |
| `principal` | `Principal` (user, machine, agent, external), `Scope`, `sameWorkspace`, `hasScope` |
| `daemon` | `DaemonFrame<F, R>`, `PlatformFrame<C>`, `Cursor`, `OpenSpec`, `DAEMON_PROTOCOL_VERSION` — generic over the `@sigx/ai-agent/wire` types so this package needs no dependency |
| `runtime` | `RuntimeDriver<S, P>` (`inspect` / `open` / `doctor`), `LocalEnvironment`, `EnvironmentInspection`, `RuntimeOpenContext`, `PlatformToolCaller`, `DoctorReport`, `toEnvironmentDescriptor` — the seam between the daemon and a runtime driver, generic over the session and policy types |
| `usage` | `Usage`, `UsageRow`, `addUsage`, `ZERO_USAGE` |
| `workspace` | `WorkspaceSettings`, `NotificationPrefs`, `NotificationKind`, `NOTIFICATION_KINDS` |

Design: `docs/architecture.md` §1, §4, §5b, §8, §9.
