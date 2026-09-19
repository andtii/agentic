/**
 * What a Codex profile is signed in as, from the app-server's `account/read` — Codex keeps its
 * credentials in `CODEX_HOME` (or the OS keyring), so the driver asks Codex rather than reading
 * token files. Never a token: only the kind of login and the ChatGPT email.
 */

import type { AuthStatus } from '@agentic/core';
import type { CodexPeer } from './client.js';
import type { Account, GetAccountResponse } from './protocol.js';

export interface CodexAuth {
    readonly authStatus: AuthStatus;
    readonly identity?: string;
    /** The ChatGPT plan (`plus`, `pro`, `team`, …) when signed in with ChatGPT. */
    readonly plan?: string;
    readonly account: Account | null;
}

/** `account/read` as an auth status: no account where Codex needs OpenAI auth is `missing`. */
export function authFromAccount(response: GetAccountResponse): CodexAuth {
    const account = response.account;
    if (!account) return { authStatus: response.requiresOpenaiAuth ? 'missing' : 'ok', account: null };
    switch (account.type) {
        case 'chatgpt':
            return { authStatus: 'ok', ...(account.email ? { identity: account.email } : {}), plan: account.planType, account };
        case 'apiKey':
            return { authStatus: 'ok', identity: 'API key', account };
        default:
            return { authStatus: 'ok', identity: 'Amazon Bedrock', account };
    }
}

export async function readCodexAuth(peer: CodexPeer, timeoutMs = 20_000): Promise<CodexAuth> {
    return authFromAccount(await peer.request<GetAccountResponse>('account/read', { refreshToken: false }, { timeoutMs }));
}
