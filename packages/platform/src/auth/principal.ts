/**
 * Principal round-tripping for `createServerApp({ codec })` — what lets an
 * identity ride the actor envelope across `ctx.actor()` hops and between
 * hosts (rfc-server-v4 §7), plus the constructors each entry point uses to
 * mint one. All four `Principal` kinds from `@agentic/core` encode; anything
 * else decodes to `null` (anonymous), never to a different principal.
 */
import type { AgentId, MachineId, Principal, Scope, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from './encoding.js';

const SCOPES: readonly Scope[] = ['machines', 'environments', 'agents', 'sessions', 'tasks', 'chats', 'memory', 'schedules', 'usage'];

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Structural check: is `value` one of the four principal shapes? Extra keys are rejected. */
export function isPrincipal(value: unknown): value is Principal {
    if (typeof value !== 'object' || value === null) return false;
    const p = value as Record<string, unknown>;
    if (!str(p.workspaceId)) return false;
    switch (p.kind) {
        case 'user':
            return str(p.userId) && keysAre(p, ['kind', 'workspaceId', 'userId']);
        case 'machine':
            return str(p.machineId) && keysAre(p, ['kind', 'workspaceId', 'machineId']);
        case 'agent':
            return (
                str(p.agentId) &&
                str(p.sessionId) &&
                (p.taskId === undefined || str(p.taskId)) &&
                keysAre(p, ['kind', 'workspaceId', 'agentId', 'sessionId', 'taskId'])
            );
        case 'external':
            return (
                str(p.clientId) &&
                Array.isArray(p.scopes) &&
                p.scopes.every((s) => SCOPES.includes(s as Scope)) &&
                keysAre(p, ['kind', 'workspaceId', 'clientId', 'scopes'])
            );
        default:
            return false;
    }
}

function keysAre(p: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(p).every((k) => allowed.includes(k) && p[k] !== undefined);
}

/** The envelope string for a principal — compact, URL-safe, no secrets (identity is not proof). */
export function encodePrincipal(principal: Principal): string {
    return toBase64Url(utf8(JSON.stringify(canonical(principal))));
}

/** The inverse of `encodePrincipal`; `null` for anything that is not a well-formed principal. */
export function decodePrincipal(encoded: string): Principal | null {
    if (encoded === '') return null;
    const bytes = fromBase64Url(encoded);
    if (!bytes) return null;
    let value: unknown;
    try {
        value = JSON.parse(fromUtf8(bytes));
    } catch {
        return null;
    }
    return isPrincipal(value) ? canonical(value) : null;
}

/** Drop `undefined` members so equality and encoding are stable. */
function canonical(p: Principal): Principal {
    switch (p.kind) {
        case 'user':
            return { kind: 'user', userId: p.userId, workspaceId: p.workspaceId };
        case 'machine':
            return { kind: 'machine', workspaceId: p.workspaceId, machineId: p.machineId };
        case 'agent':
            return p.taskId === undefined
                ? { kind: 'agent', workspaceId: p.workspaceId, agentId: p.agentId, sessionId: p.sessionId }
                : { kind: 'agent', workspaceId: p.workspaceId, agentId: p.agentId, sessionId: p.sessionId, taskId: p.taskId };
        case 'external':
            return { kind: 'external', workspaceId: p.workspaceId, clientId: p.clientId, scopes: [...p.scopes] };
    }
}

/** The `codec` half of `createServerApp<Principal>({ authenticate, codec })`. */
export const principalCodec: { encode(principal: Principal): string; decode(encoded: string): Principal | null } = {
    encode: encodePrincipal,
    decode: decodePrincipal
};

export function userPrincipal(userId: string, workspaceId: WorkspaceId): Principal {
    return { kind: 'user', userId, workspaceId };
}

export function machinePrincipal(workspaceId: WorkspaceId, machineId: MachineId): Principal {
    return { kind: 'machine', workspaceId, machineId };
}

export interface AgentPrincipalInput {
    readonly workspaceId: WorkspaceId;
    readonly agentId: AgentId;
    readonly sessionId: SessionId;
    readonly taskId?: TaskId;
}

/**
 * The per-session agent principal for tool callbacks (architecture §9). The
 * Session actor mints one when it opens; `Task.delegate` re-mints for the
 * child so a delegated agent never acts as its parent (COL-10).
 */
export function mintAgentPrincipal(input: AgentPrincipalInput): Principal {
    return canonical({ kind: 'agent', workspaceId: input.workspaceId, agentId: input.agentId, sessionId: input.sessionId, taskId: input.taskId });
}
