import { serverFn, principal } from '@sigx/server';
import type { Principal, WorkspaceId } from '@agentic/core';

/** Who is looking: the signed-in user's workspace, or `null` when anonymous. */
export interface Viewer {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
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
        return p?.kind === 'user' ? { userId: p.userId, workspaceId: p.workspaceId } : null;
    }
});
