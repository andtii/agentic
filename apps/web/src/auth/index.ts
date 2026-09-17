/**
 * apps/web auth — a THIN STUB (issue #32). Everything with substance lives
 * in `@agentic/platform` (`packages/platform/src/auth`); this folder only
 * binds it to the Worker's secrets and exposes plain
 * `(Request) => Promise<Response>` handlers for the app-shell (#23) and
 * worker-entry (#33) lanes to mount. Nothing here is imported yet: those
 * lanes call `createWebAuth(env, wiring)` and register `routes` on the
 * fetch handler and `serverApp` on `createServerApp<Principal>`.
 *
 * Owner path: `apps/web/src/auth/**`. Do not scaffold the app from here.
 */
import type { MachineId, Principal, WorkspaceId } from '@agentic/core';
import {
    beginOAuth,
    clearSessionCookie,
    completeOAuth,
    githubAuthProvider,
    normalizePairingCode,
    PAIRING_CODE_LENGTH,
    sealSession,
    serverAuth,
    sessionCookie,
    type AuthProvider,
    type ExternalIdentity,
    type MachineTokenLookup,
    type PairedMachine,
    type PairInfo
} from '@agentic/platform';
import { authenticateRequest } from '@agentic/platform';
import { isServerFnError } from '@sigx/server';

/** Workers Secrets the auth routes read (architecture §3). Never defaults, never files. */
export interface AuthEnv {
    readonly GITHUB_CLIENT_ID: string;
    readonly GITHUB_CLIENT_SECRET: string;
    /** ≥ 32 random chars; signs `__Host-session`, `__Host-oauth` and agent tokens. */
    readonly SESSION_SECRET: string;
    /** base64, 32 bytes — see `importWorkspaceKek`. Not read here; listed so the secret set is one place. */
    readonly WORKSPACE_KEK?: string;
    /** Public origin, e.g. `https://agentic.example`; the OAuth callback is `${origin}/auth/callback`. */
    readonly APP_ORIGIN: string;
}

/** The actor-backed seams the worker entry supplies (#14 Workspace, Machine lane). */
export interface AuthWiring {
    /** External identity → the user and their (v1: personal) workspace. */
    readonly resolveUser: (identity: ExternalIdentity) => Promise<{ userId: string; workspaceId: WorkspaceId }>;
    /** Stored token hash for a machine — `Machine.get`-backed. */
    readonly machines?: MachineTokenLookup;
    /**
     * Pairing (#37): `resolve` names the machine a live code was issued for
     * (the `PairingDirectory`, single use), `pair` redeems it on that machine
     * (`Machine.pair(code, info)` under the machine's principal — it consumes
     * the Workspace's record and mints the token). A `ServerFnError` from
     * `pair` names the refusal: 401 code, 403 revoked, 409 already paired.
     */
    readonly pairing?: {
        readonly resolve: (code: string) => Promise<{ workspaceId: WorkspaceId; machineId: MachineId } | null>;
        readonly pair: (target: { workspaceId: WorkspaceId; machineId: MachineId }, code: string, info: PairInfo) => Promise<PairedMachine>;
    };
    readonly provider?: AuthProvider;
    readonly now?: () => number;
}

export type RouteHandler = (request: Request) => Promise<Response>;

export interface WebAuth {
    /** Mount on the Worker: method + path → handler. */
    readonly routes: Readonly<Record<'GET /auth/login' | 'GET /auth/callback' | 'POST /auth/logout' | 'GET /auth/me' | 'POST /auth/pair', RouteHandler>>;
    /** Spread into `createServerApp<Principal>({ ...serverApp })`. */
    readonly serverApp: ReturnType<typeof serverAuth>;
    readonly provider: AuthProvider;
}

/**
 * v1 identity mapping (decision, #32): one personal workspace per user, so
 * the workspace id IS the user id — `gh_<github id>` — colon-free so every
 * actor key `${workspaceId}:${kind}:${id}` parses with `workspaceOfKey`.
 * The Workspace lane may override through `wiring.resolveUser`.
 */
export async function defaultResolveUser(identity: ExternalIdentity): Promise<{ userId: string; workspaceId: WorkspaceId }> {
    const userId = `${identity.provider === 'github' ? 'gh' : identity.provider}_${identity.subject}`;
    return { userId, workspaceId: userId as WorkspaceId };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const redirect = (location: string, setCookie?: string): Response => {
    const headers = new Headers({ location, 'cache-control': 'no-store' });
    if (setCookie) headers.append('set-cookie', setCookie);
    return new Response(null, { status: 302, headers });
};

export function createWebAuth(env: AuthEnv, wiring: AuthWiring): WebAuth {
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('[web/auth] SESSION_SECRET (≥ 32 chars) is required — set it with `wrangler secret put`');
    const provider = wiring.provider ?? githubAuthProvider({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET });
    const origin = env.APP_ORIGIN.replace(/\/+$/, '');
    const redirectUri = `${origin}/auth/callback`;
    const secret = env.SESSION_SECRET;
    const now = wiring.now ?? Date.now;
    const resolveUser = wiring.resolveUser ?? defaultResolveUser;
    const authOptions = { sessionSecret: secret, ...(wiring.machines ? { machines: wiring.machines } : {}), now };

    const login: RouteHandler = async (request) => {
        const returnTo = new URL(request.url).searchParams.get('returnTo');
        const { location, setCookie } = await beginOAuth(provider, { secret, redirectUri, returnTo: returnTo ?? '/', now: now() });
        return redirect(location, setCookie);
    };

    const callback: RouteHandler = async (request) => {
        const result = await completeOAuth(provider, request, { secret, redirectUri, now: now() });
        if (!result.ok) {
            const status = result.reason === 'exchange_failed' ? 502 : 400;
            return json({ error: result.reason }, status, { 'set-cookie': result.clearCookie });
        }
        const user = await resolveUser(result.identity);
        const headers = new Headers({ location: result.returnTo, 'cache-control': 'no-store' });
        headers.append('set-cookie', sessionCookie(await sealSession(user, secret, { now: now() })));
        headers.append('set-cookie', result.clearCookie);
        return new Response(null, { status: 302, headers });
    };

    const logout: RouteHandler = async () => redirect('/', clearSessionCookie());

    const me: RouteHandler = async (request) => {
        const principal = await authenticateRequest(request, authOptions);
        return principal ? json({ principal }) : json({ error: 'unauthorized' }, 401);
    };

    /**
     * `agentic-daemon pair`: `{ code, name }` → `{ token, workspaceId, machineId }`.
     * Anonymous by design — the code is the proof: the directory says which
     * machine it was issued for (once), and that machine redeems it.
     */
    const pair: RouteHandler = async (request) => {
        if (!wiring.pairing) return json({ error: 'pairing_unavailable' }, 503);
        let body: { code?: unknown; name?: unknown };
        try {
            body = (await request.json()) as typeof body;
        } catch {
            return json({ error: 'bad_request' }, 400);
        }
        if (typeof body.code !== 'string' || typeof body.name !== 'string' || !body.name.trim()) return json({ error: 'bad_request' }, 400);
        const code = normalizePairingCode(body.code);
        if (code.length !== PAIRING_CODE_LENGTH) return json({ error: 'malformed' }, 401);
        const target = await wiring.pairing.resolve(code);
        if (!target) return json({ error: 'mismatch' }, 401);
        try {
            const paired = await wiring.pairing.pair(target, code, { name: body.name.trim() });
            return json({ token: paired.token, workspaceId: paired.workspaceId, machineId: paired.machineId });
        } catch (e) {
            if (!isServerFnError(e)) throw e;
            if (e.status === 409) return json({ error: 'used' }, 409);
            if (e.status === 403) return json({ error: 'revoked' }, 403);
            return json({ error: 'mismatch' }, 401);
        }
    };

    return {
        routes: { 'GET /auth/login': login, 'GET /auth/callback': callback, 'POST /auth/logout': logout, 'GET /auth/me': me, 'POST /auth/pair': pair },
        serverApp: serverAuth(authOptions),
        provider
    };
}

/** Narrow to a signed-in user inside a handler; `null` otherwise. */
export function userOf(principal: Principal | null): (Principal & { kind: 'user' }) | null {
    return principal?.kind === 'user' ? principal : null;
}
