/**
 * What a Claude Code profile is signed in as, read from its config dir without
 * starting the CLI. On Windows and Linux the CLI keeps OAuth credentials in
 * `<config dir>/.credentials.json` and the account in `.claude.json`; on macOS
 * credentials live in the Keychain, so the status there is `unknown`
 * (architecture §5b: v1 validates Windows only).
 */

import type { AuthStatus } from '@agentic/core';

export interface ProfileAuth {
    readonly authStatus: AuthStatus;
    readonly identity?: string;
}

export interface ProfileAuthDeps {
    /** Resolves the file's text, or `undefined` when it does not exist. */
    readonly readText: (path: string) => Promise<string | undefined>;
    readonly platform: NodeJS.Platform;
    readonly now: () => number;
}

interface Credentials {
    readonly claudeAiOauth?: { readonly accessToken?: unknown; readonly refreshToken?: unknown; readonly expiresAt?: unknown };
}

function parse<T>(text: string | undefined): T | undefined | null {
    if (text === undefined) return undefined;
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

const join = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, '')}/${file}`;

/**
 * `configDir` is the dir the CLI uses; `accountFile` is where it keeps
 * `.claude.json` — inside `configDir` when `CLAUDE_CONFIG_DIR` is set, next to
 * `~/.claude` otherwise.
 */
export async function readProfileAuth(configDir: string, accountFile: string, deps: ProfileAuthDeps): Promise<ProfileAuth> {
    const account = parse<{ oauthAccount?: { emailAddress?: unknown } }>(await deps.readText(accountFile));
    const email = account?.oauthAccount?.emailAddress;
    const identity = typeof email === 'string' && email !== '' ? { identity: email } : {};

    if (deps.platform === 'darwin') return { authStatus: 'unknown', ...identity };

    const creds = parse<Credentials>(await deps.readText(join(configDir, '.credentials.json')));
    if (creds === undefined) return { authStatus: 'missing', ...identity };
    const oauth = creds?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== 'string') return { authStatus: 'unknown', ...identity };
    // A refresh token renews the access token on the CLI's next start.
    if (typeof oauth.refreshToken === 'string' && oauth.refreshToken !== '') return { authStatus: 'ok', ...identity };
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= deps.now()) return { authStatus: 'expired', ...identity };
    return { authStatus: 'ok', ...identity };
}
