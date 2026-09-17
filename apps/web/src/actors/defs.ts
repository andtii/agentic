/**
 * The actor definitions the pages read through (#34), as an injectable so
 * each entry provides its own half of the wire without a build transform:
 *
 * - the server (SSR in the Worker) provides the platform definitions
 *   (`platformDefs()` in `actors.app.ts`) — `actor(def, key)` dispatches
 *   in-process through the host seam, straight to the Durable Objects;
 * - the browser provides `clientDefs()` (`./client.ts`): `__actorRef` stubs
 *   that speak the actor mount over HTTP, exactly what `@sigx/actors/vite`
 *   would emit for a `*.actor.ts` module — which the platform's definitions
 *   are not (they are built by `defineSessionActor(ports)` and friends, so
 *   the static extraction cannot see them).
 *
 * Tests provide either, plus their own transport.
 */
import { defineInjectable } from 'sigx';
import type { AgentActor, Chat, RoutingActor, SessionActor, TaskActor, Workspace } from '@agentic/platform';

export interface ActorDefs {
    readonly Workspace: typeof Workspace;
    readonly Chat: typeof Chat;
    readonly AgentActor: typeof AgentActor;
    readonly TaskActor: typeof TaskActor;
    readonly Session: SessionActor;
    readonly Routing: RoutingActor;
}

export const useActorDefs = defineInjectable<ActorDefs>('ActorDefs', { hint: 'app.defineProvide(useActorDefs, () => clientDefs()) in the entry (see src/actors/defs.ts).' });

/** The signed-in viewer, as the pages see it — reactive getters over `whoami`. */
export interface ViewerState {
    readonly workspaceId: string | null;
    /** Still asking; `workspaceId` is `null` meanwhile. */
    readonly pending: boolean;
}

/** A hook: called in a component's setup, returns the viewer state for its render. */
export type ViewerHook = () => ViewerState;

export const useViewer = defineInjectable<ViewerHook>('Viewer', { hint: 'app.defineProvide(useViewer, () => viewerHook) in the entry (see src/actors/viewer.ts).' });
