/** A Copilot profile's sign-in, as the runtime itself reports it — never read from token files (EXE-10). */

import type { EnvironmentInspection } from '@agentic/core';
import type { CopilotClientLike } from './sdk.js';

export type CopilotAuth = Pick<EnvironmentInspection, 'authStatus' | 'identity'> & {
    /** How it is signed in: `user` (Copilot's own login), `gh-cli`, `env`, … as the runtime says. */
    readonly authType?: string;
};

export async function readCopilotAuth(client: Pick<CopilotClientLike, 'getAuthStatus'>): Promise<CopilotAuth> {
    const status = await client.getAuthStatus();
    if (!status.isAuthenticated) return { authStatus: 'missing' };
    return { authStatus: 'ok', ...(status.login ? { identity: status.login } : {}), ...(status.authType ? { authType: status.authType } : {}) };
}
