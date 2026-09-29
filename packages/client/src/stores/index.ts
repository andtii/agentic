/**
 * The app stores. Each concrete store module is imported here (one line each)
 * so defining it registers it with `initAppStores()` before the shell runs.
 */
export { defineAppStore, initAppStores } from './define';
export { useLiveActorState, type LiveActorState } from './live';
export { DEFAULT_WORKSPACE_ZONE, useWorkspaceStore } from './workspace';
export { INTERRUPTION_AUDIT_KINDS, INTERRUPTION_AUDIT_ROWS, useInboxStore } from './inbox';
export { useRegistryStore } from './registry';
export { foldEnvironments, machineKeyOf, pairedOf, useMachineStore, type EnvironmentEntry, type MachineEntry } from './machines';
export { useAgentStore, type AgentEntry } from './agents';
