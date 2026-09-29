/**
 * The signed-in viewer, as the pages and the app stores see it. The hook
 * itself (`whoami` through `useData` on the web) is wire-specific, so each
 * entry provides it: `app.defineProvide(useViewer, () => viewerHook)`.
 */
import { defineInjectable } from '@sigx/runtime-core';

/** The signed-in viewer, as the pages see it — reactive getters over `whoami`. */
export interface ViewerState {
    readonly workspaceId: string | null;
    /** The signed-in user's id (#939) — who "You" and "Mine" are in the Plan views; `null` when unknown or signed out. */
    readonly userId?: string | null;
    /** The provider login the viewer signed in with (#893) — PullCard's `me`; `null` when unknown or signed out. */
    readonly login?: string | null;
    /** Still asking; `workspaceId` is `null` meanwhile. */
    readonly pending: boolean;
}

/** A hook: called in a component's setup, returns the viewer state for its render. */
export type ViewerHook = () => ViewerState;

export const useViewer = defineInjectable<ViewerHook>('Viewer', { hint: 'app.defineProvide(useViewer, () => viewerHook) in the entry (see apps/web/src/actors/viewer.ts).' });
