/**
 * Who may touch a memory scope (MEM-04, MEM-11, AC-10; architecture §4, §9).
 *
 * Two layers, because the actor runtime decides `authorize` OUTSIDE any turn
 * and therefore without state:
 *
 * 1. `memoryAuthorize` — the static policy on the definition: same workspace;
 *    a user (or an external client holding the `memory` scope) reaches every
 *    scope of its workspace; an agent reaches `agent:{id}` only when it IS that
 *    agent; a machine reaches nothing. `shared:*` admits every agent of the
 *    workspace here and defers to the ACL inside the turn.
 * 2. `aclAllows` — the per-scope ACL held in the actor's state, checked by
 *    every method against `ctx.principal`. A shared scope with no ACL admits
 *    no agent at all: sharing is explicit (MEM-04), never a side effect of
 *    chat membership (MEM-11).
 */

import { hasScope, sameWorkspace, type AgentId, type MemoryScope, type Principal, type WorkspaceId } from '@agentic/core';
import type { ActorPolicy } from '@sigx/actors';

export interface MemoryKey {
    readonly workspace: WorkspaceId;
    readonly scope: MemoryScope;
}

/** Access an agent is granted on a shared scope. `'*'` means every agent of the workspace. */
export interface MemoryAcl {
    readonly read: readonly AgentId[] | '*';
    readonly write: readonly AgentId[] | '*';
}

export type MemoryAccess = 'read' | 'write';

const MARKER = ':memory:';

/** `{ws}:memory:{scope}` → its parts, or `null` for anything else. */
export function parseMemoryKey(key: string): MemoryKey | null {
    const i = key.indexOf(MARKER);
    if (i <= 0) return null;
    const scope = key.slice(i + MARKER.length);
    if (!scope.startsWith('agent:') && !scope.startsWith('shared:')) return null;
    if (scope.length <= 'agent:'.length && scope.startsWith('agent:')) return null;
    if (scope.length <= 'shared:'.length && scope.startsWith('shared:')) return null;
    return { workspace: key.slice(0, i) as WorkspaceId, scope: scope as MemoryScope };
}

export function isAgentScope(scope: MemoryScope): scope is `agent:${AgentId}` {
    return scope.startsWith('agent:');
}

/** The agent a private scope belongs to. */
export function scopeAgent(scope: MemoryScope): AgentId | null {
    return isAgentScope(scope) ? (scope.slice('agent:'.length) as AgentId) : null;
}

/** True when the principal owns the workspace's memory outright: a user, or an external client with the `memory` scope. */
export function isMemoryOwner(principal: Principal): boolean {
    return principal.kind === 'user' || (principal.kind === 'external' && hasScope(principal, 'memory'));
}

/** The static half: decidable from the principal and the key alone. */
export function memoryKeyAllows(principal: Principal | null | undefined, key: string): boolean {
    if (!principal || !sameWorkspace(principal, key)) return false;
    const parsed = parseMemoryKey(key);
    if (!parsed) return false;
    if (isMemoryOwner(principal)) return true;
    if (principal.kind !== 'agent') return false;
    const owner = scopeAgent(parsed.scope);
    // A private scope admits its agent only; a shared one is decided by the ACL in the turn.
    return owner === null ? true : owner === principal.agentId;
}

/** The dynamic half: the ACL of a shared scope. Owners always pass; agents need a grant. */
export function aclAllows(principal: Principal | null | undefined, scope: MemoryScope, acl: MemoryAcl | null | undefined, access: MemoryAccess): boolean {
    if (!principal) return false;
    if (isMemoryOwner(principal)) return true;
    if (principal.kind !== 'agent') return false;
    const owner = scopeAgent(scope);
    if (owner !== null) return owner === principal.agentId;
    if (!acl) return false;
    const grant = acl[access];
    return grant === '*' || grant.includes(principal.agentId);
}

/** The `authorize` chain of the Memory actor. */
export const memoryAuthorize: ActorPolicy = (principal: Principal | null, _rq, op) => memoryKeyAllows(principal, op.resource?.key ?? '');
