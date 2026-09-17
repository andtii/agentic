/**
 * The `OAuthStore` on actors (architecture §4, §9):
 *
 * - `OAuthClients` — `global:oauth-clients`, one directory for every
 *   registered client. Registration precedes any workspace (the client has
 *   no user yet), so like the `PairingDirectory` it is a global actor with
 *   an anonymous door: `register` and `get` need no principal — a public
 *   client's metadata is public by definition and the id it gets is random.
 * - `OAuthGrants` — `{ws}:oauth:grants`, the workspace's pending codes and
 *   consented grants. `authorize` is `[sameWorkspace, owner]`: the routes
 *   call it as the workspace's user (the one who consented, or the v1
 *   owner for token/refresh/verify where no session cookie is present).
 *
 * Both persist explicitly: every mutation ends in `ctx.save()` inside the
 * turn (Workers never run `onDeactivate`).
 */
import type { Principal, WorkspaceId } from '@agentic/core';
import { actor, defineActor, type ActorClientWith, type ActorPolicy, type AnyActorDefinition } from '@sigx/actors';
import { setPrincipal } from '@sigx/server/server';
import { asPrincipal } from '../agent-token.js';
import { userPrincipal } from '../principal.js';
import { sameWorkspace } from '../same-workspace.js';
import { rotate } from './memory-store.js';
import type { OAuthGrant, OAuthStore, PendingCode, RegisteredClient, RotateGrantResult } from './types.js';

export const OAUTH_CLIENTS_TYPE = 'OAuthClients';
export const OAUTH_CLIENTS_KEY = 'global:oauth-clients';
export const OAUTH_GRANTS_TYPE = 'OAuthGrants';

const GRANTS_SUFFIX = ':oauth:grants';

export function oauthGrantsKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}${GRANTS_SUFFIX}`;
}

/** Registered clients past this count drop the oldest — a public registration endpoint must not grow without bound. */
export const MAX_CLIENTS = 5000;
/** Grants kept per workspace (revoked ones expire out first). */
export const MAX_GRANTS = 500;

export interface OAuthClientsState {
    v: 1;
    clients: Record<string, RegisteredClient>;
}

/** The public door: anyone may register a client or read one back by id. */
const clientsPolicy: ActorPolicy = (principal: Principal | null, _rq, op) => {
    const method = (op.resource as { method?: string } | undefined)?.method;
    if (method === 'register' || method === 'get') return true;
    return principal?.kind === 'user';
};

export const OAuthClients = defineActor({
    type: OAUTH_CLIENTS_TYPE,
    allowAnonymous: true,
    authorize: [clientsPolicy],
    persistence: 'explicit',
    state: (): OAuthClientsState => ({ v: 1, clients: {} }),
    methods: (ctx) => ({
        async register(client: RegisteredClient): Promise<void> {
            const s = ctx.state;
            s.clients[client.clientId] = client;
            const ids = Object.keys(s.clients);
            if (ids.length > MAX_CLIENTS) {
                const oldest = ids.map((id) => s.clients[id]!).sort((a, b) => a.issuedAt - b.issuedAt).slice(0, ids.length - MAX_CLIENTS);
                for (const c of oldest) delete s.clients[c.clientId];
            }
            await ctx.save();
        },
        async get(clientId: string): Promise<RegisteredClient | null> {
            const c = ctx.state.clients[clientId];
            return c ? ctx.snapshot(c) : null;
        },
        async count(): Promise<number> {
            return Object.keys(ctx.state.clients).length;
        }
    })
});

export interface OAuthGrantsState {
    v: 1;
    codes: Record<string, PendingCode>;
    grants: Record<string, OAuthGrant>;
}

/** After `sameWorkspace`: the workspace's user. External clients never touch their own grant records. */
const owner: ActorPolicy = (principal: Principal | null) => principal?.kind === 'user';

export const OAuthGrants = defineActor({
    type: OAUTH_GRANTS_TYPE,
    authorize: [sameWorkspace, owner],
    persistence: 'explicit',
    state: (): OAuthGrantsState => ({ v: 1, codes: {}, grants: {} }),
    methods: (ctx) => {
        const pruneCodes = (now: number): void => {
            for (const [id, code] of Object.entries(ctx.state.codes)) if (code.exp <= now) delete ctx.state.codes[id];
        };
        const capGrants = (): void => {
            const s = ctx.state;
            const ids = Object.keys(s.grants);
            if (ids.length <= MAX_GRANTS) return;
            const ranked = ids.map((id) => s.grants[id]!).sort((a, b) => Number(a.revokedAt === undefined) - Number(b.revokedAt === undefined) || a.createdAt - b.createdAt);
            for (const g of ranked.slice(0, ids.length - MAX_GRANTS)) delete s.grants[g.id];
        };
        return {
            async issueCode(code: PendingCode): Promise<void> {
                pruneCodes(Date.now());
                ctx.state.codes[code.id] = code;
                await ctx.save();
            },
            async consumeCode(codeId: string, now: number): Promise<PendingCode | null> {
                pruneCodes(now);
                const code = ctx.state.codes[codeId];
                if (!code) {
                    await ctx.save();
                    return null;
                }
                delete ctx.state.codes[codeId];
                await ctx.save();
                return ctx.snapshot(code);
            },
            async createGrant(grant: OAuthGrant): Promise<void> {
                ctx.state.grants[grant.id] = grant;
                capGrants();
                await ctx.save();
            },
            async grant(grantId: string): Promise<OAuthGrant | null> {
                const g = ctx.state.grants[grantId];
                return g ? ctx.snapshot(g) : null;
            },
            async rotateGrant(grantId: string, generation: number, now: number): Promise<RotateGrantResult> {
                const map = new Map(Object.entries(ctx.state.grants));
                const result = rotate(map, grantId, generation, now);
                const updated = map.get(grantId);
                if (updated) ctx.state.grants[grantId] = updated;
                await ctx.save();
                return result.ok ? { ok: true, grant: ctx.snapshot(result.grant) } : result;
            },
            async revokeGrant(grantId: string, now: number): Promise<boolean> {
                const g = ctx.state.grants[grantId];
                if (!g) return false;
                if (g.revokedAt === undefined) ctx.state.grants[grantId] = { ...g, revokedAt: now };
                await ctx.save();
                return true;
            },
            /** Every grant of the workspace, for a settings page — newest first. */
            async list(): Promise<readonly OAuthGrant[]> {
                return ctx.snapshot(Object.values(ctx.state.grants).sort((a, b) => b.createdAt - a.createdAt));
            }
        };
    }
});

export type OAuthClientsActor = typeof OAuthClients;
export type OAuthGrantsActor = typeof OAuthGrants;

export interface ActorOAuthStoreOptions {
    /** The definitions this deployment registered (defaults: this module's). */
    readonly clients?: AnyActorDefinition;
    readonly grants?: AnyActorDefinition;
    /**
     * The principal the grants actor is driven with for a workspace. Default:
     * the workspace's user (v1: `workspaceId === userId`, see `same-workspace.ts`).
     */
    readonly driver?: (workspaceId: WorkspaceId) => Principal;
}

/** The `OAuthStore` over the two actors, for the routes in `apps/web`. */
export function actorOAuthStore(options: ActorOAuthStoreOptions = {}): OAuthStore {
    const Clients = (options.clients ?? OAuthClients) as OAuthClientsActor;
    const Grants = (options.grants ?? OAuthGrants) as OAuthGrantsActor;
    const driverOf = options.driver ?? ((ws: WorkspaceId): Principal => userPrincipal(ws, ws));
    const anonymous = (): { locals: Record<string, unknown> } => {
        const context = { locals: {} as Record<string, unknown> };
        setPrincipal(context, null);
        return context;
    };
    const clients = () => actor(Clients, OAUTH_CLIENTS_KEY).with({ context: anonymous() }) as ActorClientWith<OAuthClientsActor>;
    const grants = (ws: WorkspaceId) => actor(Grants, oauthGrantsKey(ws)).with({ context: asPrincipal(driverOf(ws)) }) as ActorClientWith<OAuthGrantsActor>;
    return {
        registerClient: (client) => clients().register(client),
        client: (clientId) => clients().get(clientId),
        issueCode: (ws, code) => grants(ws).issueCode(code),
        consumeCode: (ws, codeId, now) => grants(ws).consumeCode(codeId, now),
        createGrant: (ws, grant) => grants(ws).createGrant(grant),
        grant: (ws, grantId) => grants(ws).grant(grantId),
        rotateGrant: (ws, grantId, generation, now) => grants(ws).rotateGrant(grantId, generation, now),
        revokeGrant: (ws, grantId, now) => grants(ws).revokeGrant(grantId, now)
    };
}
