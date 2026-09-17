/**
 * GitHub OAuth (web application flow) as an `AuthProvider`, over `fetch`.
 *
 * Every endpoint and the `fetch` itself are injectable so the provider is
 * unit-tested offline and points at a GitHub Enterprise host by config.
 * Secrets are values here, never read from the environment: the app passes
 * the client secret in from Workers Secrets.
 */
import { AuthProviderError, type AuthProvider, type ExternalIdentity } from '../provider.js';

export interface GitHubAuthProviderConfig {
    readonly clientId: string;
    readonly clientSecret: string;
    /** Default `read:user user:email` — enough for a stable id plus a primary email. */
    readonly scope?: string;
    /** Default `globalThis.fetch`; inject for tests and enterprise proxies. */
    readonly fetch?: typeof globalThis.fetch;
    readonly authorizeUrl?: string;
    readonly tokenUrl?: string;
    /** REST API base, default `https://api.github.com`. */
    readonly apiUrl?: string;
    /** Send a PKCE S256 challenge (GitHub accepts it). Default `true`. */
    readonly pkce?: boolean;
    /** GitHub requires a `User-Agent` on API calls. */
    readonly userAgent?: string;
}

interface GitHubUser {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string;
}

interface GitHubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

export const GITHUB_PROVIDER_ID = 'github';

export function githubAuthProvider(config: GitHubAuthProviderConfig): AuthProvider {
    if (!config.clientId || !config.clientSecret) throw new Error('[auth:github] clientId and clientSecret are required');
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const authorizeUrl = config.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
    const tokenUrl = config.tokenUrl ?? 'https://github.com/login/oauth/access_token';
    const apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    const scope = config.scope ?? 'read:user user:email';
    const userAgent = config.userAgent ?? 'agentic';
    const pkce = config.pkce ?? true;

    async function api<T>(path: string, accessToken: string): Promise<T> {
        let response: Response;
        try {
            response = await fetchImpl(`${apiUrl}${path}`, {
                headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${accessToken}`, 'user-agent': userAgent, 'x-github-api-version': '2022-11-28' }
            });
        } catch (error) {
            throw new AuthProviderError(GITHUB_PROVIDER_ID, 'network', `GET ${path} failed: ${String(error)}`);
        }
        if (!response.ok) throw new AuthProviderError(GITHUB_PROVIDER_ID, 'profile_failed', `GET ${path} → ${response.status}`);
        return (await response.json()) as T;
    }

    return {
        id: GITHUB_PROVIDER_ID,
        pkce,
        authorizationUrl({ redirectUri, state, codeChallenge }) {
            const url = new URL(authorizeUrl);
            url.searchParams.set('client_id', config.clientId);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('scope', scope);
            url.searchParams.set('state', state);
            url.searchParams.set('allow_signup', 'false');
            if (codeChallenge) {
                url.searchParams.set('code_challenge', codeChallenge);
                url.searchParams.set('code_challenge_method', 'S256');
            }
            return url.toString();
        },
        async exchangeCode({ code, redirectUri, codeVerifier }): Promise<ExternalIdentity> {
            const body = new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri });
            if (codeVerifier) body.set('code_verifier', codeVerifier);
            let response: Response;
            try {
                response = await fetchImpl(tokenUrl, {
                    method: 'POST',
                    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
                    body: body.toString()
                });
            } catch (error) {
                throw new AuthProviderError(GITHUB_PROVIDER_ID, 'network', `token exchange failed: ${String(error)}`);
            }
            if (!response.ok) throw new AuthProviderError(GITHUB_PROVIDER_ID, 'exchange_failed', `token endpoint → ${response.status}`);
            const token = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
            if (!token.access_token) {
                throw new AuthProviderError(GITHUB_PROVIDER_ID, 'exchange_failed', token.error_description ?? token.error ?? 'no access_token in response');
            }
            const user = await api<GitHubUser>('/user', token.access_token);
            if (typeof user.id !== 'number' || typeof user.login !== 'string') {
                throw new AuthProviderError(GITHUB_PROVIDER_ID, 'profile_failed', 'malformed /user response');
            }
            let email = user.email ?? undefined;
            if (!email && /\buser:email\b/.test(scope)) {
                // The profile email is the PUBLIC one and usually null; the
                // primary verified address needs the emails endpoint.
                try {
                    const emails = await api<GitHubEmail[]>('/user/emails', token.access_token);
                    email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email;
                } catch {
                    // Email is optional; login still succeeds without it.
                }
            }
            const identity: ExternalIdentity = {
                provider: GITHUB_PROVIDER_ID,
                subject: String(user.id),
                login: user.login,
                ...(user.name ? { name: user.name } : {}),
                ...(email ? { email } : {}),
                ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {})
            };
            return identity;
        }
    };
}
