/**
 * `memoryOAuthStore` — the `OAuthStore` over Maps: tests, and any host that
 * runs a single process. The same single-use and rotation rules as the
 * actor-backed store, so a server tested here behaves identically on the
 * Durable Objects one.
 */
import type { WorkspaceId } from '@agentic/core';
import type { OAuthGrant, OAuthStore, PendingCode, RegisteredClient, RotateGrantResult } from './types.js';

interface WorkspaceRecords {
    readonly codes: Map<string, PendingCode>;
    readonly grants: Map<string, OAuthGrant>;
}

export interface MemoryOAuthStore extends OAuthStore {
    /** Test seam: every grant of a workspace, newest last. */
    grants(workspaceId: WorkspaceId): readonly OAuthGrant[];
    clients(): readonly RegisteredClient[];
}

export function memoryOAuthStore(): MemoryOAuthStore {
    const clients = new Map<string, RegisteredClient>();
    const workspaces = new Map<string, WorkspaceRecords>();
    const ws = (id: WorkspaceId): WorkspaceRecords => {
        let r = workspaces.get(id);
        if (!r) {
            r = { codes: new Map(), grants: new Map() };
            workspaces.set(id, r);
        }
        return r;
    };
    return {
        async registerClient(client) {
            clients.set(client.clientId, client);
        },
        async client(clientId) {
            return clients.get(clientId) ?? null;
        },
        async issueCode(workspaceId, code) {
            ws(workspaceId).codes.set(code.id, code);
        },
        async consumeCode(workspaceId, codeId, now) {
            const { codes } = ws(workspaceId);
            const code = codes.get(codeId);
            if (!code) return null;
            codes.delete(codeId);
            return code.exp > now ? code : null;
        },
        async createGrant(workspaceId, grant) {
            ws(workspaceId).grants.set(grant.id, grant);
        },
        async grant(workspaceId, grantId) {
            return ws(workspaceId).grants.get(grantId) ?? null;
        },
        async rotateGrant(workspaceId, grantId, generation, now) {
            return rotate(ws(workspaceId).grants, grantId, generation, now);
        },
        async revokeGrant(workspaceId, grantId, now) {
            const { grants } = ws(workspaceId);
            const grant = grants.get(grantId);
            if (!grant) return false;
            if (grant.revokedAt === undefined) grants.set(grantId, { ...grant, revokedAt: now });
            return true;
        },
        grants: (workspaceId) => [...ws(workspaceId).grants.values()],
        clients: () => [...clients.values()]
    };
}

/** The rotation rule, shared with the actor: current generation → bump; older → replay → revoke. */
export function rotate(grants: Map<string, OAuthGrant>, grantId: string, generation: number, now: number): RotateGrantResult {
    const grant = grants.get(grantId);
    if (!grant) return { ok: false, reason: 'missing' };
    if (grant.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
    if (generation !== grant.generation) {
        grants.set(grantId, { ...grant, revokedAt: now });
        return { ok: false, reason: 'reused' };
    }
    const next: OAuthGrant = { ...grant, generation: grant.generation + 1, lastRefreshedAt: now };
    grants.set(grantId, next);
    return { ok: true, grant: next };
}
