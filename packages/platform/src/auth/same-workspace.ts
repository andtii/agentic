/**
 * Authorization helpers every actor in this package composes (architecture
 * §4, §9). Keys are workspace-prefixed, so the first policy in every
 * `authorize` chain is {@link sameWorkspace}: it reads the workspace out of
 * `op.resource.key` and compares it with the principal's `workspaceId`
 * before anything else runs.
 *
 * Key shapes (architecture §4):
 *
 *  - the Workspace root actor: `ws:{workspaceId}` — {@link workspaceKey}
 *  - every child actor: `{workspaceId}:{kind}:{id}` — core's `actorKey`
 *
 * v1 has one workspace per user, so `workspaceId === userId` and the root
 * key reads `ws:{userId}` as the catalogue spells it.
 */

import type { Principal, WorkspaceId } from '@agentic/core';
import { sameWorkspace as inWorkspace, workspaceOfKey } from '@agentic/core';
import type { ActorPolicy } from '@sigx/actors';

/** Prefix of the Workspace root actor's key. */
export const WORKSPACE_KEY_PREFIX = 'ws:';

/** The key of a workspace's root actor. */
export function workspaceKey(workspaceId: WorkspaceId | string): string {
    return `${WORKSPACE_KEY_PREFIX}${workspaceId}`;
}

/**
 * The workspace an actor key belongs to — root or child — or `null` when the
 * key has neither shape. The root shape is exactly two segments (`ws:{id}`);
 * a child key always has at least three, so `ws:agent:x` still reads as a
 * child of workspace `ws`.
 */
export function workspaceOfActorKey(key: string): WorkspaceId | null {
    if (key.startsWith(WORKSPACE_KEY_PREFIX)) {
        const rest = key.slice(WORKSPACE_KEY_PREFIX.length);
        if (rest.length === 0) return null;
        if (!rest.includes(':')) return rest as WorkspaceId;
    }
    return workspaceOfKey(key);
}

/**
 * The policy every actor lists first: the caller must be a principal of the
 * workspace the addressed key belongs to. Fails closed on a missing
 * resource, an anonymous caller, or a key of neither shape.
 */
export const sameWorkspace: ActorPolicy = (principal: Principal | null, _rq, op) => {
    if (!op.resource || !principal) return false;
    const key = op.resource.key;
    if (key.startsWith(WORKSPACE_KEY_PREFIX)) return workspaceOfActorKey(key) === principal.workspaceId;
    return inWorkspace(principal, key);
};

/**
 * The Workspace root's second policy: only the owning user, never an agent,
 * machine or external client — those reach workspace data through the
 * child actors, or through a `ctx.actor()` hop, which is not an entry point.
 */
export const workspaceOwner: ActorPolicy = (principal: Principal | null, _rq, op) => {
    if (!op.resource || !principal || principal.kind !== 'user') return false;
    return op.resource.key === workspaceKey(principal.userId);
};
