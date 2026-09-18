/**
 * apps/web OAuth 2.1 server + MCP mount — a THIN binding (issue #50).
 * Everything with substance lives in `@agentic/platform` (the
 * authorization server, `packages/platform/src/auth/oauth-server`) and
 * `@agentic/mcp` (the tool surface, `packages/mcp/src/server`); this folder
 * resolves the signed-in user from the session cookie, binds the store to
 * the actors and exposes plain `(Request) => Promise<Response>` handlers
 * for the worker entry to mount:
 *
 *   GET  /.well-known/oauth-authorization-server              RFC 8414
 *   GET  /.well-known/oauth-protected-resource[/_agentic/mcp] RFC 9728
 *   POST /oauth/register                                      RFC 7591 (DCR)
 *   GET|POST /oauth/authorize                                 consent (PKCE S256)
 *   POST /oauth/token                                         code / refresh (rotating)
 *   POST /oauth/revoke                                        RFC 7009
 *   *    /_agentic/mcp                                        the platform MCP server, bearer = access token
 *
 * `claude mcp add --transport http agentic https://<origin>/_agentic/mcp`
 * needs nothing else: the 401 names the resource metadata, the client
 * registers itself, the user signs in and consents once.
 */
import { createPlatformMcpHandler, type PlatformMcpHandler, type PlatformPortFactory } from '@agentic/mcp';
import { actorOAuthStore, createOAuthServer, sessionFromRequest, type OAuthServer, type OAuthStore, type OAuthUser } from '@agentic/platform';
import type { ChatFileStore } from '@agentic/core';
import type { AnyActorDefinition } from '@sigx/actors';
import type { RouteHandler } from '../index';
import { createActorPlatformPort } from './port';

export { createActorPlatformPort, type ActorPortOptions } from './port';

/** The MCP mount path — the protected resource. */
export const MCP_PATH = '/_agentic/mcp';

export interface OAuthServerEnv {
    /** ≥ 32 chars; signs access, refresh and consent tokens (the same secret as the session cookie). */
    readonly SESSION_SECRET: string;
    /** Public origin — the OAuth issuer and the resource's origin. */
    readonly APP_ORIGIN: string;
}

export interface OAuthServerWiring {
    /** Clients, codes and grants. Default: `actorOAuthStore()` over `OAuthClients` / `OAuthGrants`. */
    readonly store?: OAuthStore;
    /** The registry the MCP port binds to (`platformActors()`); required for the MCP mount unless `port` is given. */
    readonly actors?: readonly AnyActorDefinition[];
    /** Override the port (tests). */
    readonly port?: PlatformPortFactory;
    /** The chat file store `chats_file_get` reads (#209). Absent: the tool returns metadata only. */
    readonly files?: ChatFileStore;
    readonly now?: () => number;
    readonly version?: string;
}

export type OAuthRouteKey =
    | 'GET /.well-known/oauth-authorization-server'
    | 'GET /.well-known/oauth-protected-resource'
    | `GET /.well-known/oauth-protected-resource${typeof MCP_PATH}`
    | 'POST /oauth/register'
    | 'GET /oauth/authorize'
    | 'POST /oauth/authorize'
    | 'POST /oauth/token'
    | 'POST /oauth/revoke';

export interface WebOAuthServer {
    readonly routes: Readonly<Record<OAuthRouteKey, RouteHandler>>;
    /** Every method on `/_agentic/mcp`. */
    readonly mcp: PlatformMcpHandler;
    readonly oauth: OAuthServer;
    readonly resource: string;
}

export function createOAuthRoutes(env: OAuthServerEnv, wiring: OAuthServerWiring = {}): WebOAuthServer {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('[web/oauth-server] SESSION_SECRET (≥ 32 chars) is required');
    const issuer = env.APP_ORIGIN.replace(/\/+$/, '');
    const resource = `${issuer}${MCP_PATH}`;
    const store = wiring.store ?? actorOAuthStore();
    const now = wiring.now ?? Date.now;
    const oauth = createOAuthServer({ secret: env.SESSION_SECRET, issuer, resource, store, now });

    /** The signed-in user, from the `__Host-session` cookie — the consent screen's identity. */
    const userOf = async (request: Request): Promise<OAuthUser | null> => {
        const session = await sessionFromRequest(request, env.SESSION_SECRET, now());
        return session ? { userId: session.userId, workspaceId: session.workspaceId } : null;
    };

    const port: PlatformPortFactory =
        wiring.port ??
        ((principal) => {
            if (!wiring.actors) throw new Error('[web/oauth-server] the MCP mount needs `actors` (the platform registry)');
            return createActorPlatformPort(principal, { actors: wiring.actors });
        });

    const mcp = createPlatformMcpHandler({
        authenticate: (request) => oauth.verify(request),
        port,
        ...(wiring.files ? { files: wiring.files } : {}),
        resourceMetadataUrl: oauth.resourceMetadataUrl,
        ...(wiring.version !== undefined ? { version: wiring.version } : {}),
        // A browser page on this origin must not drive the surface with a leaked token; native clients send no Origin.
        allowedOrigins: []
    });

    const authorize: RouteHandler = async (request) => oauth.authorize(request, await userOf(request));
    return {
        oauth,
        mcp,
        resource,
        routes: {
            'GET /.well-known/oauth-authorization-server': async () => oauth.metadata(),
            'GET /.well-known/oauth-protected-resource': async () => oauth.protectedResource(),
            [`GET /.well-known/oauth-protected-resource${MCP_PATH}`]: async () => oauth.protectedResource(),
            'POST /oauth/register': (request) => oauth.register(request),
            'GET /oauth/authorize': authorize,
            'POST /oauth/authorize': authorize,
            'POST /oauth/token': (request) => oauth.token(request),
            'POST /oauth/revoke': (request) => oauth.revoke(request)
        }
    };
}
