import { serverFn, principal } from '@sigx/server';
import type { Principal, WorkspaceId } from '@agentic/core';
import { viewerLogin } from '../auth/viewer-login';

/** Who is looking: the signed-in user's workspace, or `null` when anonymous. */
export interface Viewer {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
    /** The provider login (GitHub handle) the user signed in with (#893); absent for the dev login or a session from before it. */
    readonly login?: string;
}

/**
 * The browser learns its workspace here — every actor key it reads is
 * `{workspaceId}:…`, and the session cookie that carries the identity is
 * `HttpOnly`, so the page cannot read it itself. In-process during SSR
 * (the document then carries the answer), a fetch stub in the browser.
 * Anonymous callers get `null`, never a 401: the pages render the
 * signed-out state from it.
 */
export const whoami = serverFn({
    allowAnonymous: true,
    handler: async ({ rq }): Promise<Viewer | null> => {
        const p = await principal<Principal>(rq);
        if (p?.kind !== 'user') return null;
        const login = await loginOf(rq, p.userId);
        return { userId: p.userId, workspaceId: p.workspaceId, ...(login ? { login } : {}) };
    }
});

/** The login cookie's answer for `userId`; `undefined` off a request (a detached context throws on `rq.request`). */
async function loginOf(rq: { readonly request: Request }, userId: string): Promise<string | undefined> {
    let request: Request;
    try {
        request = rq.request;
    } catch {
        return undefined;
    }
    return request?.headers ? viewerLogin(request, userId) : undefined;
}
