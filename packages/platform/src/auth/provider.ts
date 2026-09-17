/**
 * `AuthProvider` — the seam a login provider implements (decisions: "GitHub
 * OAuth behind an `AuthProvider` interface so more providers can be added").
 *
 * A provider knows two things: where to send the browser, and how to turn
 * the code that comes back into an external identity. Everything else —
 * state, PKCE, the transient cookie, the session — is the flow's
 * (`oauth.ts`) and identical for every provider.
 */

export interface AuthorizationRequest {
    readonly redirectUri: string;
    /** Opaque CSRF token; the provider must echo it back on the callback. */
    readonly state: string;
    /** PKCE S256 challenge — present only when the provider declares `pkce`. */
    readonly codeChallenge?: string;
}

export interface CodeExchange {
    readonly code: string;
    readonly redirectUri: string;
    /** PKCE verifier matching the challenge sent at authorization. */
    readonly codeVerifier?: string;
}

/** Who the provider says the user is. `subject` is stable per provider account. */
export interface ExternalIdentity {
    readonly provider: string;
    readonly subject: string;
    readonly login?: string;
    readonly name?: string;
    readonly email?: string;
    readonly avatarUrl?: string;
}

export interface AuthProvider {
    /** Stable id: `'github'`. Part of the user id, so renaming it renames everyone. */
    readonly id: string;
    /** Whether to send a PKCE S256 challenge. GitHub accepts one; the flow honours it where declared. */
    readonly pkce: boolean;
    authorizationUrl(input: AuthorizationRequest): string;
    /** Throws `AuthProviderError` when the exchange or profile fetch fails. */
    exchangeCode(input: CodeExchange): Promise<ExternalIdentity>;
}

export type AuthProviderErrorCode = 'exchange_failed' | 'profile_failed' | 'network';

export class AuthProviderError extends Error {
    override readonly name = 'AuthProviderError';
    constructor(
        readonly provider: string,
        readonly code: AuthProviderErrorCode,
        message: string
    ) {
        super(`[auth:${provider}] ${message}`);
    }
}
