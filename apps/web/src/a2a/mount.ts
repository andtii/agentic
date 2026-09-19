/**
 * The A2A server, mounted as a plugin (#245, PLG-06). `createA2aHandler` from
 * `@agentic/a2a` over the platform, one handler per workspace:
 *
 *   GET  /.well-known/agent-card.json                         the one exposed agent's card (none, or several → 404)
 *   GET  /_agentic/a2a/{agentId}/.well-known/agent-card.json  that agent's card
 *   POST /_agentic/a2a/{agentId}                              JSON-RPC (SSE for SendStreamingMessage)
 *
 * Every request, in order:
 *   1. a bearer token of the platform's OAuth server (the one MCP clients use,
 *      `auth/oauth-server`) — none or invalid → 401 naming the resource metadata;
 *   2. the `agentic.a2a.server` plugin enabled in the token's workspace — off → 404,
 *      exactly as if nothing were mounted;
 *   3. the `tasks` and `sessions` scopes — missing → 403 `insufficient_scope`.
 *
 * Only the agents the plugin's `exposedAgents` names have a card or take a
 * task; any other id is 404. A task is an ordinary platform task of that
 * agent (`a2a/session.ts`): created as the client, placed by the router.
 */
import { A2A_SERVER_PLUGIN_ID, AGENT_CARD_PATH, createA2aHandler, type A2aHandler, type A2aServerConfig, type ExposedAgent, type SessionPort } from '@agentic/a2a';
import type { AgentId, Scope, WorkspaceId } from '@agentic/core';
import type { ExternalPrincipal } from '@agentic/mcp';
import { AgentActor, Workspace, actorOAuthStore, agentKey, asPrincipal, createOAuthServer, registryKey, userPrincipal, workspaceKey, type AgentView, type OAuthServer, type OAuthStore, type PluginView } from '@agentic/platform';
import type { AgentSession } from '@sigx/ai-agent';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import type { RouteHandler } from '../auth';
import { originOf, type AuthMountEnv } from '../auth/mount';
import { MCP_PATH, createActorPlatformPort } from '../auth/oauth-server';
import { platformA2aSession } from './session';

/** Where the per-agent endpoints live. */
export const A2A_BASE_PATH = '/_agentic/a2a';

/** What a client's grant must hold: tasks are created and cancelled, their sessions read and answered. */
export const A2A_SCOPES: readonly Scope[] = ['tasks', 'sessions'];

/** How many contexts a workspace keeps live in one isolate; the oldest goes first. */
const MAX_CONTEXTS = 500;

export interface A2aMountWiring {
    /** The registry the port binds to (`platformRegistry()`). */
    readonly actors: readonly AnyActorDefinition[];
    /** The OAuth store tokens are checked against. Default: `actorOAuthStore()`, the one the OAuth server writes. */
    readonly store?: OAuthStore;
    /** How often a running turn's session log is read. Default 250 ms. */
    readonly pollMs?: number;
    readonly now?: () => number;
}

/** Whether `pathname` is one the A2A mount answers. */
export function isA2aPath(pathname: string): boolean {
    return pathname === AGENT_CARD_PATH || pathname === A2A_BASE_PATH || pathname.startsWith(`${A2A_BASE_PATH}/`);
}

const byType = (actors: readonly AnyActorDefinition[], type: string): AnyActorDefinition => {
    const def = actors.find((d) => (d as { type: string }).type === type);
    if (!def) throw new Error(`[a2a/mount] no \`${type}\` actor in the registry`);
    return def;
};

const notFound = (): Response => new Response('Not found', { status: 404 });

/** The exposed entries of the plugin's config, trimmed; anything that is not a string is ignored. */
function exposedOf(plugin: PluginView): string[] {
    const list = (plugin.config as Partial<A2aServerConfig>).exposedAgents;
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
}

/** The card an agent is described by. */
function exposedAgent(view: AgentView): ExposedAgent {
    const { name, description, role } = view.config;
    return { id: view.id, name, description: description.trim() || role.trim() || `${name}, an agent on the agentic platform.`, promptParts: 'text' };
}

/**
 * Build the resolver the Worker mounts: `(request, env) → handler | undefined`.
 * Unmounted (`undefined`) without the session secret or an origin — the same
 * condition as the OAuth server it verifies tokens with.
 */
export function createA2aMount(wiring: A2aMountWiring): (request: Request, env: AuthMountEnv) => RouteHandler | undefined {
    const Registry = byType(wiring.actors, 'Registry');
    const pollMs = wiring.pollMs ?? 250;
    /** The principal each request authenticated as — the port reads it back in `session(…, request)`. */
    const principals = new WeakMap<Request, ExternalPrincipal>();
    const handlers = new Map<WorkspaceId, A2aHandler>();
    let oauth: { key: string; server: OAuthServer } | null = null;

    const owner = (ws: WorkspaceId) => asPrincipal(userPrincipal(ws, ws));
    const plugin = (ws: WorkspaceId): Promise<PluginView | null> => actor(Registry, registryKey(ws)).with({ context: owner(ws) }).get(A2A_SERVER_PLUGIN_ID) as Promise<PluginView | null>;

    /** The exposed agents, read as the workspace: what is exposed is the plugin's decision, not the client's scope. */
    async function exposedAgents(ws: WorkspaceId): Promise<ExposedAgent[]> {
        const p = await plugin(ws);
        if (!p?.enabled) return [];
        const wanted = exposedOf(p);
        if (wanted.length === 0) return [];
        const ids = new Set(wanted);
        const names = new Set(wanted.map((w) => w.toLowerCase()));
        const { agents } = await actor(Workspace, workspaceKey(ws)).with({ context: owner(ws) }).get();
        const out: ExposedAgent[] = [];
        for (const id of agents) {
            const view = await actor(AgentActor, agentKey(ws, id)).with({ context: owner(ws) }).get();
            if (ids.has(view.id) || names.has(view.config.name.toLowerCase())) out.push(exposedAgent(view));
        }
        return out;
    }

    function handlerFor(ws: WorkspaceId): A2aHandler {
        const existing = handlers.get(ws);
        if (existing) return existing;
        const sessions = new Map<string, AgentSession>();
        const port: SessionPort = {
            agents: () => exposedAgents(ws),
            async session(agentId, contextId, request) {
                const principal = principals.get(request);
                if (!principal) throw new Error('[a2a/mount] a session was asked for outside an authenticated request');
                // A context belongs to the client that opened it: another client's id opens a context of its own.
                const key = `${principal.clientId}\n${agentId}\n${contextId}`;
                let s = sessions.get(key);
                if (!s) {
                    s = platformA2aSession({ platform: createActorPlatformPort(principal, { actors: wiring.actors }), agentId: agentId as AgentId, contextId, pollMs });
                    sessions.set(key, s);
                    if (sessions.size > MAX_CONTEXTS) sessions.delete(sessions.keys().next().value!);
                }
                return s;
            }
        };
        const handler = createA2aHandler({ port, basePath: A2A_BASE_PATH, ...(wiring.now ? { now: wiring.now } : {}) });
        handlers.set(ws, handler);
        return handler;
    }

    function oauthFor(secret: string, origin: string): OAuthServer {
        const key = `${secret}\n${origin}`;
        if (oauth?.key !== key) {
            const issuer = origin.replace(/\/+$/, '');
            oauth = { key, server: createOAuthServer({ secret, issuer, resource: `${issuer}${MCP_PATH}`, store: wiring.store ?? actorOAuthStore(), ...(wiring.now ? { now: wiring.now } : {}) }) };
        }
        return oauth.server;
    }

    return (request, env) => {
        if (!isA2aPath(new URL(request.url).pathname)) return undefined;
        const secret = (env.SESSION_SECRET ?? '').length >= 32 ? env.SESSION_SECRET! : '';
        const origin = originOf(env, request);
        if (!secret || !origin) return undefined;
        const server = oauthFor(secret, origin);
        return async (req) => {
            const principal = await server.verify(req);
            if (!principal) return server.challenge();
            // Off → nothing is here: no hint that the workspace has an A2A server it has not turned on.
            if (!(await plugin(principal.workspaceId))?.enabled) return notFound();
            const missing = A2A_SCOPES.filter((s) => !principal.scopes.includes(s));
            if (missing.length > 0) {
                const challenge = server.challenge({ error: 'insufficient_scope', description: `A2A needs the ${A2A_SCOPES.join(' and ')} scopes`, scope: A2A_SCOPES });
                return new Response(null, { status: 403, headers: challenge.headers });
            }
            principals.set(req, principal);
            return handlerFor(principal.workspaceId).fetch(req);
        };
    };
}
