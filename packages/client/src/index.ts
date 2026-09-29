/**
 * `@agentic/client` — the DOM-free client layer: the app-lifetime stores and the
 * injectables they read through. No DOM, `window`, `localStorage`, `sigx`
 * umbrella or `@sigx/runtime-dom` here (oxlint + `__tests__/dom-free.test.ts`).
 */
export { useActorDefs, type ActorDefs } from './defs';
export { useViewer, type ViewerHook, type ViewerState } from './viewer';
export { memoryKeyValueStorage, useKeyValueStorage, type KeyValueStorage } from './storage';
export { defineAppStore, initAppStores, useLiveActorState, type LiveActorState } from './stores/index';
export { DEFAULT_WORKSPACE_ZONE, useWorkspaceStore } from './stores/index';
export { INTERRUPTION_AUDIT_KINDS, INTERRUPTION_AUDIT_ROWS, useInboxStore } from './stores/index';
export { useRegistryStore } from './stores/index';
export { isAuthError, readinessById, readinessFacts, readyRuntimeIds, signedOutPluginIds } from './readiness';
export { foldEnvironments, machineKeyOf, pairedOf, useMachineStore, type EnvironmentEntry, type MachineEntry } from './stores/index';
export { useAgentStore, type AgentEntry } from './stores/index';
export { useTaskStore } from './stores/index';
export { EXPANDED_CAP, chatSeenKey, chatViewKey, parseReadMarks, parseViewPrefs, useChatPrefsStore, type ChatDetailLevel, type ChatViewName, type ChatViewPrefs, type ReadMarks } from './stores/index';
