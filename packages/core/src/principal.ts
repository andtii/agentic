/** Who is calling (architecture §9). Every actor's `authorize` starts with `sameWorkspace`. */

import type { AgentId, MachineId, SessionId, TaskId, WorkspaceId } from './ids.js';
import { workspaceOfKey } from './ids.js';

/** Tool families an external client may be granted (the MCP orchestration surface). */
export type Scope = 'machines' | 'environments' | 'agents' | 'sessions' | 'tasks' | 'chats' | 'memory' | 'schedules' | 'usage' | 'projects';

export type Principal =
    | { readonly kind: 'user'; readonly userId: string; readonly workspaceId: WorkspaceId }
    | { readonly kind: 'machine'; readonly workspaceId: WorkspaceId; readonly machineId: MachineId }
    | { readonly kind: 'agent'; readonly workspaceId: WorkspaceId; readonly agentId: AgentId; readonly sessionId: SessionId; readonly taskId?: TaskId }
    | { readonly kind: 'external'; readonly workspaceId: WorkspaceId; readonly clientId: string; readonly scopes: readonly Scope[] };

/** True when `key` is an actor key inside the principal's workspace. */
export function sameWorkspace(principal: Principal | null | undefined, key: string): boolean {
    if (!principal) return false;
    const ws = workspaceOfKey(key);
    return ws !== null && ws === principal.workspaceId;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
    return principal.kind !== 'external' || principal.scopes.includes(scope);
}
