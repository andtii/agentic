/**
 * The `authenticate` hook for `createServerApp` (architecture §9): every
 * request — SSR, serverFn, actor wire, live socket, in-process `actor()` —
 * resolves to one `Principal` or `null`, once per request store.
 *
 * Precedence: a bearer token names its kind (`amt.` machine, `agt.` agent)
 * and is decided on its own — a bad bearer is anonymous, never a fallback
 * to the cookie. Only a request with no bearer reads `__Host-session`.
 *
 * `null` is the anonymous outcome; this never throws for bad input. A
 * request context with no request at all (a detached in-process call) is
 * anonymous too, so an actor called from a task body without
 * `asPrincipal(...)` is refused by the identity gate rather than crashing.
 */
import type { Principal } from '@agentic/core';
import type { ServerFnContext } from '@sigx/server';
import { openAgentToken, AGENT_TOKEN_PREFIX } from './agent-token.js';
import { sessionFromRequest } from './cookie.js';
import { bearerToken, parseMachineToken, verifyMachineToken, MACHINE_TOKEN_PREFIX, type MachineTokenRecord, type MachineTokenRef } from './machine-token.js';
import { principalCodec, userPrincipal } from './principal.js';

/** How `authenticate` finds a machine's stored token hash — the Machine actor lane implements it. */
export type MachineTokenLookup = (ref: MachineTokenRef) => Promise<MachineTokenRecord | null>;

export interface AuthenticateOptions {
    /** Signs sessions, OAuth transients and agent tokens. From Workers Secrets. */
    readonly sessionSecret: string;
    /** Absent → every machine token is refused (`unknown`). */
    readonly machines?: MachineTokenLookup;
    /** Clock for tests. */
    readonly now?: () => number;
}

export type AuthenticateFn = (rq: Pick<ServerFnContext, 'request'>) => Promise<Principal | null>;

/** Resolve the principal a raw request carries. */
export async function authenticateRequest(request: Request, options: AuthenticateOptions): Promise<Principal | null> {
    const now = options.now?.() ?? Date.now();
    const bearer = bearerToken(request.headers);
    if (bearer !== null) {
        if (bearer.startsWith(`${MACHINE_TOKEN_PREFIX}.`)) {
            const ref = parseMachineToken(bearer);
            if (!ref || !options.machines) return null;
            let record: MachineTokenRecord | null;
            try {
                record = await options.machines(ref);
            } catch {
                // A lookup fault is not proof of identity either way.
                return null;
            }
            const verdict = await verifyMachineToken(bearer, record);
            return verdict.ok ? verdict.principal : null;
        }
        if (bearer.startsWith(AGENT_TOKEN_PREFIX)) return openAgentToken(bearer, options.sessionSecret, now);
        return null;
    }
    const session = await sessionFromRequest(request, options.sessionSecret, now);
    return session ? userPrincipal(session.userId, session.workspaceId) : null;
}

/** The `createServerApp({ authenticate })` hook. */
export function createAuthenticate(options: AuthenticateOptions): AuthenticateFn {
    return async (rq) => {
        let request: Request;
        try {
            request = rq.request;
        } catch {
            // Detached context: `rq.request` throws by design. Anonymous.
            return null;
        }
        if (!(request instanceof Request) && !isRequestLike(request)) return null;
        return authenticateRequest(request, options);
    };
}

function isRequestLike(value: unknown): value is Request {
    if (typeof value !== 'object' || value === null || typeof (value as { url?: unknown }).url !== 'string') return false;
    const headers = (value as { headers?: unknown }).headers;
    return typeof headers === 'object' && headers !== null && typeof (headers as { get?: unknown }).get === 'function';
}

/** The pair to spread into `createServerApp<Principal>({ ...serverAuth(options) })`. */
export function serverAuth(options: AuthenticateOptions): { authenticate: AuthenticateFn; codec: typeof principalCodec } {
    return { authenticate: createAuthenticate(options), codec: principalCodec };
}
