/**
 * The app stores. Each concrete store module is imported here (one line each)
 * so defining it registers it with `initAppStores()` before the shell runs.
 */
export { defineAppStore, initAppStores } from './define';
export { useLiveActorState, type LiveActorState } from './live';
export { DEFAULT_WORKSPACE_ZONE, useWorkspaceStore } from './workspace';
