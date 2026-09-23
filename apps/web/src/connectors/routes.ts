/**
 * The connector sign-in routes (#533; AGT-02, AST-09, PLG-04, EXE-10),
 * mounted by the Worker next to the auth and file routes
 * (`entry.cloudflare.ts`), after `actors.boot(env)`:
 *
 *   GET  /_agentic/connectors/:id/start       the signed-in owner → the provider's consent screen
 *   GET  /_agentic/connectors/callback        the provider → the account sealed, its id on the connector record
 *   POST /_agentic/connectors/:id/disconnect  revoke at the provider (best effort) and forget the account
 *
 * `:id` is a conduit connector plugin this build ships (`gmail`); the
 * connector record the routes keep has the same id, as an MCP connector's
 * does (`mcpConnectorSetup`). There is no HTTP `execute`: an operation runs
 * only as a session's tool (`./opener.ts`).
 *
 * Start: the plugin must be on. The workspace's engine secret is generated
 * on first use (`ensureEngineSecret`), the conduit connector record is
 * written if missing, and conduit's `beginAuth` runs with `owner` = the
 * workspace and `returnTo` = `/plugins/:id`. A record that already names an
 * account reconnects THAT account, so its id — and every agent's grant —
 * stays the same.
 *
 * Callback: conduit verifies the signed state and the single-use handshake
 * (both in the workspace's `ConnectorAccounts`), exchanges the code with
 * PKCE, seals the tokens and stores the account; the account id is written
 * onto the connector record, and the owner lands back on `returnTo` — a
 * same-site path only. Any failure lands on the plugin page with
 * `?connect_error=` instead of a raw error page.
 *
 * The redirect URI is the callback on the origin the request came in on —
 * the one the plugin page shows (`location.origin`) — so the provider sends
 * the owner back to the host that holds their session cookie, even when the
 * deployment answers on more than one hostname.
 *
 * Every route is the signed-in OWNER's (a user principal; the session
 * cookie is the credential), and every actor call is made as that owner, so
 * the Registry's and the accounts' own policies apply. Disconnect is a
 * `POST` with a same-origin `Origin` (the CSRF guard the file routes use).
 */
import type { Principal, WorkspaceId } from '@agentic/core';
import { CONNECTOR_ENGINE_SECRET, type ConnectorEngine } from '@agentic/connectors';
import { Registry, asPrincipal, authenticateRequest, registryKey } from '@agentic/platform';
import { actor } from '@sigx/actors';
import type { RouteHandler } from '../auth';
import { originOf, type AuthMountEnv } from '../auth/mount';
import { ensureEngineSecret, openPluginSecret, workspaceConnectorEngine, type ConnectorHttp, type ConnectorRegistry } from './engine';
import { CONNECT_ERROR_PARAM, CONNECTED_PARAM, CONNECTOR_CALLBACK_PATH, CONNECTORS_ROUTE_PREFIX, connectorPluginPage, connectorRedirectUri } from './paths';

export interface ConnectorMountWiring {
    /** Connector plugin id → the conduit connector it signs in to — the build's conduit connectors (`conduitConnectorCatalogue`). */
    readonly connectors: Readonly<Record<string, string>>;
    /** `fetch` replacement for the provider (tests). */
    readonly http?: ConnectorHttp;
}

const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

/** The longest state payload `unverifiedReturnTo` decodes. */
const MAX_STATE_PAYLOAD = 2048;

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

/** A same-site path to send the owner back to, or `undefined`: absolute, never protocol-relative, no backslash tricks. */
export function sameSitePath(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined;
    try {
        const url = new URL(value, 'http://x');
        return url.host === 'x' ? `${url.pathname}${url.search}` : undefined;
    } catch {
        return undefined;
    }
}

/**
 * `path` with `name` set to `value` (any earlier copy dropped), every parameter percent-encoded — `%20`, never `+`:
 * the app's router decodes with `decodeURIComponent`.
 */
export function withParam(path: string, name: string, value: string): string {
    const url = new URL(path, 'http://x');
    const params = [...url.searchParams].filter(([k]) => k !== name);
    params.push([name, value]);
    return `${url.pathname}?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/** The plugin id of a `/plugins/:id` path. */
function pluginOfPage(path: string | undefined): string | undefined {
    const m = path ? /^\/plugins\/([^/?#]+)/.exec(path) : null;
    if (!m) return undefined;
    try {
        const id = decodeURIComponent(m[1]!);
        return SEGMENT.test(id) ? id : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The `returnTo` a conduit state carries (`base64url(json).signature`), read WITHOUT verifying it — only to choose
 * which plugin's client to finish with and where a failure lands; conduit verifies the state itself before anything
 * is exchanged, and a success redirects to the verified value.
 */
export function unverifiedReturnTo(state: string | null): string | undefined {
    const payload = state?.split('.')[0];
    // A query string anyone can send: bounded before any decoding work (conduit's own states are a few hundred characters).
    if (!payload || payload.length > MAX_STATE_PAYLOAD) return undefined;
    try {
        const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as { r?: unknown };
        return sameSitePath(decoded.r);
    } catch {
        return undefined;
    }
}

/** What a failure says on the plugin page: the message, without the `[…]` prefixes internal errors carry, short. */
function failureText(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/^(\[[^\]]+\]\s*)+/, '').slice(0, 300) || 'the sign-in failed';
}

const secretOf = (env: AuthMountEnv): string => ((env.SESSION_SECRET ?? '').length >= 32 ? env.SESSION_SECRET! : '');

/** Build the resolver: `(request, env) → handler | undefined` — `undefined` for any path outside `/_agentic/connectors/`. */
export function createConnectorMount(wiring: ConnectorMountWiring): (request: Request, env: AuthMountEnv) => RouteHandler | undefined {
    const registryAs = (principal: Principal, ws: WorkspaceId): ConnectorRegistry => actor(Registry, registryKey(ws)).with({ context: asPrincipal(principal) }) as unknown as ConnectorRegistry;

    const engineFor = (principal: Principal, ws: WorkspaceId, registry: ConnectorRegistry, pluginId: string, engineSecret: string, origin: string): ConnectorEngine =>
        workspaceConnectorEngine({
            workspaceId: ws,
            principal,
            secret: (name) => openPluginSecret(registry, name, pluginId),
            engineSecret,
            redirectUri: connectorRedirectUri(origin),
            ...(wiring.http ? { http: wiring.http } : {})
        });

    /** The connector's sign-in method: the first that goes through a browser redirect. */
    const methodOf = async (engine: ConnectorEngine, connector: string): Promise<string> => {
        const described = await engine.connectors.describe(connector);
        const method = described.auth.find((a) => a.redirect) ?? described.auth[0];
        if (!method) throw new Error(`${connector} has no sign-in method`);
        return method.id;
    };

    const start = async (request: Request, env: AuthMountEnv, principal: Principal, pluginId: string, connector: string): Promise<Response> => {
        const ws = principal.workspaceId as WorkspaceId;
        const page = connectorPluginPage(pluginId);
        try {
            const registry = registryAs(principal, ws);
            const plugin = await registry.get(pluginId);
            if (!plugin) return redirect(withParam(page, CONNECT_ERROR_PARAM, 'this workspace does not have the plugin'));
            if (!plugin.enabled) return redirect(withParam(page, CONNECT_ERROR_PARAM, 'turn the plugin on first'));
            const engineSecret = await ensureEngineSecret(registry, pluginId);
            let record = await registry.getConnector(pluginId);
            if (!record || record.transport !== 'conduit' || record.connector !== connector) {
                await registry.putConnector({ id: pluginId, pluginId, transport: 'conduit', connector });
                record = null;
            }
            const engine = engineFor(principal, ws, registry, pluginId, engineSecret, new URL(request.url).origin);
            // Reconnect the record's own account when it still exists, so its id (and every grant) stays.
            const account = record?.account !== undefined && (await engine.accounts.get(record.account, ws)) ? record.account : undefined;
            const begun = await engine.auth.begin({ connector, method: await methodOf(engine, connector), owner: ws, returnTo: page, ...(account ? { account } : {}) });
            if (begun.type === 'connected') {
                await registry.putConnector({ id: pluginId, pluginId, transport: 'conduit', connector, account: begun.account.id });
                return redirect(withParam(page, CONNECTED_PARAM, '1'));
            }
            return redirect(begun.url);
        } catch (e) {
            return redirect(withParam(page, CONNECT_ERROR_PARAM, failureText(e)));
        }
    };

    const callback = async (request: Request, env: AuthMountEnv, principal: Principal): Promise<Response> => {
        const ws = principal.workspaceId as WorkspaceId;
        const url = new URL(request.url);
        const hinted = unverifiedReturnTo(url.searchParams.get('state'));
        const pluginId = pluginOfPage(hinted);
        const fallback = hinted ?? '/plugins';
        try {
            const connector = pluginId !== undefined ? wiring.connectors[pluginId] : undefined;
            if (pluginId === undefined || connector === undefined) throw new Error('this sign-in link is not one this workspace started — start again from the plugin page');
            const registry = registryAs(principal, ws);
            const engineSecret = await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId);
            if (engineSecret === undefined) throw new Error('this sign-in link has expired — start again');
            const engine = engineFor(principal, ws, registry, pluginId, engineSecret, url.origin);
            const { account, returnTo } = await engine.auth.complete({ callbackUrl: request.url });
            if (account.owner !== ws || account.connector !== connector) throw new Error('this sign-in belongs to another connector');
            await registry.putConnector({ id: pluginId, pluginId, transport: 'conduit', connector, account: account.id });
            return redirect(withParam(sameSitePath(returnTo) ?? connectorPluginPage(pluginId), CONNECTED_PARAM, '1'));
        } catch (e) {
            return redirect(withParam(fallback, CONNECT_ERROR_PARAM, failureText(e)));
        }
    };

    const disconnect = async (request: Request, env: AuthMountEnv, principal: Principal, pluginId: string, connector: string): Promise<Response> => {
        const origin = request.headers.get('origin');
        if (!origin || (origin !== new URL(request.url).origin && origin !== originOf(env, request)?.replace(/\/+$/, ''))) return json({ error: 'cross-origin' }, 403);
        const ws = principal.workspaceId as WorkspaceId;
        const registry = registryAs(principal, ws);
        const record = await registry.getConnector(pluginId);
        if (!record || record.transport !== 'conduit' || record.account === undefined) return json({ disconnected: false }, 200);
        let revoked = false;
        const engineSecret = await openPluginSecret(registry, CONNECTOR_ENGINE_SECRET, pluginId).catch(() => undefined);
        if (engineSecret !== undefined) {
            const engine = engineFor(principal, ws, registry, pluginId, engineSecret, new URL(request.url).origin);
            // Best effort at the provider; conduit deletes the account either way.
            revoked = await engine.auth
                .revoke(record.account, ws)
                .then(() => true)
                .catch(() => false);
        }
        await registry.putConnector({ id: pluginId, pluginId, transport: 'conduit', connector });
        return json({ disconnected: true, revoked }, 200);
    };

    return (request, env) => {
        const { pathname } = new URL(request.url);
        if (!pathname.startsWith(CONNECTORS_ROUTE_PREFIX)) return undefined;
        const isCallback = pathname === CONNECTOR_CALLBACK_PATH;
        const segments = pathname.slice(CONNECTORS_ROUTE_PREFIX.length).split('/');
        const action = isCallback ? 'callback' : segments.length === 2 && SEGMENT.test(segments[0]!) ? segments[1] : undefined;
        const method = action === 'disconnect' ? 'POST' : 'GET';
        const pluginId = isCallback ? undefined : segments[0]!;
        const connector = pluginId !== undefined ? wiring.connectors[pluginId] : undefined;
        // Anything else under the prefix fails closed rather than falling through to the document.
        if (!isCallback && (connector === undefined || (action !== 'start' && action !== 'disconnect'))) return async () => json({ error: 'not-found' }, 404);
        return async (req) => {
            if (req.method !== method) return new Response(null, { status: 405, headers: { allow: method } });
            const secret = secretOf(env);
            const principal = secret ? await authenticateRequest(req, { sessionSecret: secret }) : null;
            // The owner's alone: an agent token or a machine never signs the workspace in to a provider.
            if (!principal || principal.kind !== 'user') return json({ error: 'unauthorized' }, 401);
            if (isCallback) return callback(req, env, principal);
            if (action === 'start') return start(req, env, principal, pluginId!, connector!);
            return disconnect(req, env, principal, pluginId!, connector!);
        };
    };
}
