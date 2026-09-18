/**
 * The inbox page module (#40): "Needs you" over a `NeedsSource`. In `live`
 * mode (`data-mode.ts`) the source is the platform — the Inbox and Session
 * definitions from `useActorDefs`, the workspace (and its time zone) from
 * `useViewer` / `useWorkspaceZone` — else the
 * mock workspace; a test provides its own with `defineProvide`.
 */
import { defineInjectable } from 'sigx';
import { useActorDefs, useViewer } from '../../actors/defs';
import { dataMode } from '../../data-mode';
import { useWorkspaceZone } from '../../time';
import { liveNeedsSource } from './live';
import { mockNeedsSource } from './memory';
import type { NeedsSource } from './source';

export type { NeedsKind, NeedsRow, NeedsSource, RequestRef, RequestState, RequestView } from './source';
export { sortRows } from './source';
export { memoryNeedsSource, mockNeedsSource, type MemoryNeedsOptions, type MemoryNeedsSource } from './memory';
export { liveNeedsSource, rowOf, hueOf, interruptedRows, INTERRUPTED_CONTEXT, type LiveNeedsDefs } from './live';
export { NeedsYou, openRequestOf, decisionOf, hrefOf } from './NeedsYou';

/** The source "Needs you" renders from: a factory a page calls in its setup (it resolves `useActorDefs` / `useViewer` there in live mode). */
export const useNeedsSource = defineInjectable<() => NeedsSource>(() => () => {
    if (dataMode() !== 'live') return mockNeedsSource();
    const defs = useActorDefs();
    const viewer = useViewer()();
    return liveNeedsSource(defs, viewer, useWorkspaceZone(defs, viewer));
}, { name: 'NeedsSource' });
