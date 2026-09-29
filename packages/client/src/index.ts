/**
 * `@agentic/client` — the DOM-free client layer: the app-lifetime stores and the
 * injectables they read through. No DOM, `window`, `localStorage`, `sigx`
 * umbrella or `@sigx/runtime-dom` here (oxlint + `__tests__/dom-free.test.ts`).
 */
export { useActorDefs, type ActorDefs } from './defs';
export { useViewer, type ViewerHook, type ViewerState } from './viewer';
export { memoryKeyValueStorage, useKeyValueStorage, type KeyValueStorage } from './storage';
export { defineAppStore, initAppStores, useLiveActorState, type LiveActorState } from './stores/index';
