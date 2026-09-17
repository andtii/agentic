# Changelog

All notable changes to `@agentic/core` (Keep a Changelog, semver).

## [Unreleased]

### Added

- Platform contracts (#13): branded ids and `createId`/`actorKey`; `AgentConfig` with versions and limits; `ChatEntry` and the `resolveActivation` rule; `TaskStatus`/`WaitReason`/`TaskContract`/`TaskSnapshot` with `canTransition` and deterministic `childTaskId`; `EnvironmentDescriptor` and `CapabilityReport`; `PluginManifest`; `MemoryPlugin`/`MemoryStore`/`LearningPlugin` seams; `Principal` (user, machine, agent, external with scopes) and `sameWorkspace`; the daemon envelope `DaemonFrame`/`PlatformFrame` generic over the wire types; `Usage` helpers.
