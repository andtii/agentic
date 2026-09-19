# @agentic/core

Edge-safe platform contracts. Types plus a few pure helpers, zero dependencies, no `node:` imports (enforced by a test). Every other package imports its cross-package types from here; a missing type is added here first in its own `contract` PR (see `AGENTS.md`).

| Module | What it defines |
|---|---|
| `ids` | Branded ids (`WorkspaceId`, `AgentId`, `ChatId`, `TaskId`, `SessionId`, `MachineId`, `EnvironmentId`, `ScheduleId`, `MessageId`), `createId`, `actorKey`, `workspaceOfKey` |
| `agent` | `AgentConfig`, `FrozenAgentConfig`, `AgentConfigVersion`, `Limits`, `ApprovalRule`, `MemoryPolicy`, `ExecutionDefaults`, `ToolGrant`, `SkillRef`, `RuntimeId`, `OfflinePolicy` |
| `chat` | `ChatEntry`, `Author`, `PromptPart`, `ChatMember`, `PostResult`, `resolveActivation` (the CHT-06 rule) |
| `task` | `TaskStatus`, `WaitReason`, `TaskOrigin`, `TaskContract`, `TaskResult`, `TaskSnapshot`, `TaskTransition`, `canTransition`, `isTerminal`, `childTaskId` |
| `environment` | `EnvironmentDescriptor` (with the optional `doctor` verdict), `EnvironmentVerdict`, `DoctorFinding`, `CapabilityReport`, `MachineInfo`, `AuthStatus`, `IsolationMechanism`, and the `env.request` vocabulary (`EnvironmentInput` — no `profileDir`, `EnvOp`, `EnvResult`, `EnvError`, `EnvErrorCode`, `MachinePolicy`) |
| `plugin` | `PluginManifest` (with `secrets`), `PluginKind`, `PermissionScope`, `PluginState`, `SINGLE_SLOT_KINDS` / `isSingleSlot` (`memory` and `learning` run one active plugin per workspace), `JsonSchema` (deprecated alias of `ConfigSchema`) |
| `plugin-config` | `ConfigSchema` — the typed JSON-Schema subset a manifest's `config` is written in (string with `enum` / `format: 'uri'`, number / integer with bounds, boolean, string list, string map) — and `PluginSecretDeclaration`; the pure helpers `validateConfig` (unknown keys rejected once `properties` are declared; defaults not filled in), `configDefaults`, and `pluginReadiness(state, facts)` → `PluginReadiness` (`ready` | `disabled` | `needs-config` | `needs-secret` | `needs-grant` | `needs-machine` | `no-kek`), where the caller supplies the facts (`PluginReadinessFacts`); `DAEMON_HOSTED_CAPABILITY` |
| `memory` | `MemoryKind`, `MemoryEntry`, `NewMemoryEntry`, `MemoryQuery`, `RankedMemory`, `MemoryScope`, `MemoryStore`, `MemoryPlugin`, `ImportReport`, `PluginContext` |
| `learning` | `LearningPlugin`, `Proposal`, `Correction`, `TaskOutcome` |
| `principal` | `Principal` (user, machine, agent, external), `Scope`, `sameWorkspace`, `hasScope` |
| `daemon` | `DaemonFrame<F, R>`, `PlatformFrame<C>`, `Cursor`, `OpenSpec` (with its MCP `connectors`, secret names only), `CONNECTOR_CREDENTIALS_TOOL` + `ConnectorCredentials` (the daemon's own `tool.call` for their values, #280), `DAEMON_PROTOCOL_VERSION` — generic over the `@sigx/ai-agent/wire` types so this package needs no dependency |
| `runtime` | `RuntimeDriver<S, P>` (`inspect` / `open` / `doctor`), `LocalEnvironment`, `EnvironmentInspection`, `RuntimeOpenContext`, `PlatformToolCaller`, `DoctorReport`, `environmentVerdict`, `toEnvironmentDescriptor` — the seam between the daemon and a runtime driver, generic over the session and policy types |
| `usage` | `Usage`, `UsageRow`, `addUsage`, `ZERO_USAGE` |
| `quota` | `QuotaWindow`, `QuotaSnapshot`, `QuotaUnit`, `QuotaStatus`, `QuotaSignal`, the `QuotaSource` a runtime supplies (its plugin lists `usage-limits`), `mergeQuota`, `tightestWindow` — provider limits per account, not Ledger consumption |
| `workspace` | `WorkspaceSettings` (what the Workspace actor stores), `NotificationPrefs`, `WorkspaceDefaults`, `RetentionSettings`, `DEFAULT_WORKSPACE_SETTINGS`, `NotificationKind`, `NOTIFICATION_KINDS` |
| `workdir` | `WorkdirRef`, `HostOs`, the `fs.request` vocabulary (`FsOp` — `list`, `worktree`, `locate` —, `FsResult`, `FsListResult`, `FsEntry`, `FsGitInfo` with the repo's `origin`, `FsWorktreeResult`, `FsLocateResult`, `FsError`, `FsErrorCode`, `FS_LIST_MAX_ENTRIES`, `FS_LOCATE_MAX_DEPTH`, `FS_LOCATE_MAX_MATCHES`), the pure path helpers `pathWithin`, `normalizePath`, `suggestWorktreePath` — the one lexical `cwdRoots` check every layer shares — and `originKey` / `sameOrigin`, the one way a remote URL is compared |
| `project` | Projects (#329): `ProjectRecord` (name, default members, one folder per environment, connectors, feature settings), `ProjectPatch`, `PROJECTS_MAX`, the `project-feature` plugin kind (`ProjectFeatureManifest` with `projectSettings`, `ProjectFeaturePlugin` with `detect` / `beforeSession` / `instructions`), and `projectFolderFor` / `enabledProjectFeatures` |

Design: `docs/architecture.md` §1, §4, §5b, §8, §9.
