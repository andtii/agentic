/** Who is calling (architecture §9). Every actor's `authorize` starts with `sameWorkspace`. */

import type { AgentId, MachineId, SessionId, TaskId, WorkspaceId } from './ids.js';
import { workspaceOfKey } from './ids.js';

/** Tool families an external client may be granted (the MCP orchestration surface). */
export type Scope = 'machines' | 'environments' | 'agents' | 'sessions' | 'tasks' | 'chats' | 'memory' | 'schedules' | 'usage' | 'projects';

export type Principal =
    | {
          readonly kind: 'user';
          readonly userId: string;
          readonly workspaceId: WorkspaceId;
          /**
           * Until when (ms epoch) the session is elevated (#355): the user re-confirmed through the login provider a few
           * minutes ago, so a security-sensitive machine change may go through. Set by the platform's `authenticate` from
           * the elevation cookie when it names this user; absent otherwise, and never on a bearer request.
           */
          readonly elevatedUntil?: number;
      }
    | { readonly kind: 'machine'; readonly workspaceId: WorkspaceId; readonly machineId: MachineId }
    | { readonly kind: 'agent'; readonly workspaceId: WorkspaceId; readonly agentId: AgentId; readonly sessionId: SessionId; readonly taskId?: TaskId }
    | { readonly kind: 'external'; readonly workspaceId: WorkspaceId; readonly clientId: string; readonly scopes: readonly Scope[] };

/** True when `key` is an actor key inside the principal's workspace. */
export function sameWorkspace(principal: Principal | null | undefined, key: string): boolean {
    if (!principal) return false;
    const ws = workspaceOfKey(key);
    return ws !== null && ws === principal.workspaceId;
}

/** An elevation (#355) lasts this long: ten minutes from the re-confirmation. */
export const ELEVATION_TTL_MS = 10 * 60 * 1000;
/** The message prefix of a 403 that asks for elevation — what the web turns into "Confirm with GitHub to continue". */
export const ELEVATION_REQUIRED = 'elevation-required';

/** Whether `principal` is a user whose elevation (#355) is still live at `now`. */
export function isElevated(principal: Principal | null | undefined, now: number = Date.now()): boolean {
    return principal?.kind === 'user' && typeof principal.elevatedUntil === 'number' && principal.elevatedUntil > now;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
    return principal.kind !== 'external' || principal.scopes.includes(scope);
}
