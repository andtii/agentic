/**
 * Ports the Routing actor is composed with (architecture §7).
 *
 * The router never imports the Session or Machine definitions: an app builds
 * them (they take ports of their own) and hands them in as thunks, because
 * Session, Machine and Routing reference each other.
 */

import type { Principal, SessionId, WorkspaceId } from '@agentic/core';
import type { AnyActorDefinition } from '@sigx/actors';

export interface RoutingPorts {
    /** The Session actor definition this app built (`defineSessionActor`). */
    readonly sessions: () => AnyActorDefinition;
    /** The Machine actor definition this app built (`defineMachineActor`). */
    readonly machines: () => AnyActorDefinition;
    /**
     * The principal the router drives Task, Session, Machine and Agent with.
     * Default: the workspace's user (v1: `workspaceId === userId`, see
     * `auth/same-workspace.ts`), which every driver-facing policy admits.
     */
    readonly driver?: (workspaceId: WorkspaceId) => Principal;
    /** Clock for tests. Default `Date.now`. */
    readonly now?: () => number;
    /** Session id allocation for tests. Default `createId('session')`. */
    readonly newSessionId?: () => SessionId;
}
