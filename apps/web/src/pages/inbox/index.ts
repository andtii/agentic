/**
 * The inbox page module (#40): "Needs you" over a `NeedsSource`. The
 * default source is the mock workspace; an entry that hosts actors provides
 * the live one — `app.defineProvide(useNeedsSource, () => () =>
 * liveNeedsSource(defs, workspaceId))` — and every page renders from it.
 */
import { defineInjectable } from 'sigx';
import { mockNeedsSource } from './memory';
import type { NeedsSource } from './source';

export type { NeedsKind, NeedsRow, NeedsSource, RequestRef, RequestState, RequestView } from './source';
export { sortRows } from './source';
export { memoryNeedsSource, mockNeedsSource, type MemoryNeedsOptions, type MemoryNeedsSource } from './memory';
export { liveNeedsSource, rowOf, hueOf, type LiveNeedsDefs } from './live';
export { NeedsYou, openRequestOf, decisionOf, hrefOf } from './NeedsYou';

/** The source "Needs you" renders from: a factory, called once per page render. */
export const useNeedsSource = defineInjectable<() => NeedsSource>(() => mockNeedsSource, { name: 'NeedsSource' });
