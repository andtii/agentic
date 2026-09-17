/**
 * The OAuth 2.1 authorization server's records and its one persistence
 * seam (architecture §9, issue #50). Everything here is edge-safe data:
 * the actors in `actors.ts` and `memoryOAuthStore` in `memory-store.ts`
 * both implement `OAuthStore`, the server in `server.ts` only ever talks
 * to the interface.
 */
import type { Scope, WorkspaceId } from '@agentic/core';

/** The grant types a registered client may use — public clients, PKCE, refresh rotation; nothing else (OAuth 2.1). */
export type OAuthGrantType = 'authorization_code' | 'refresh_token';

/** A client registered through RFC 7591 Dynamic Client Registration. Public (no secret); metadata is not confidential. */
export interface RegisteredClient {
    readonly clientId: string;
    readonly name: string;
    readonly redirectUris: readonly string[];
    readonly grantTypes: readonly OAuthGrantType[];
    /** Epoch ms. */
    readonly issuedAt: number;
    /** The default scopes the client asked for at registration (space-separated, each a `Scope`). */
    readonly scope?: string;
    readonly clientUri?: string;
    readonly softwareId?: string;
    readonly softwareVersion?: string;
}

/** An authorization code the user consented to, waiting to be redeemed once at the token endpoint. */
export interface PendingCode {
    readonly id: string;
    readonly clientId: string;
    readonly redirectUri: string;
    /** PKCE S256 challenge — base64url(sha256(verifier)). */
    readonly codeChallenge: string;
    readonly scopes: readonly Scope[];
    readonly userId: string;
    /** RFC 8707 resource indicator, when the client sent one. */
    readonly resource?: string;
    /** Epoch ms; a code past this is refused. */
    readonly exp: number;
}

/** One consent: the client, the user who granted it, the scopes, and the refresh-token rotation counter. */
export interface OAuthGrant {
    readonly id: string;
    readonly clientId: string;
    readonly userId: string;
    readonly scopes: readonly Scope[];
    readonly createdAt: number;
    /** Incremented on every refresh; a refresh token carrying an older generation is a replay and revokes the grant. */
    readonly generation: number;
    readonly lastRefreshedAt?: number;
    readonly revokedAt?: number;
}

export type RotateGrantResult = { readonly ok: true; readonly grant: OAuthGrant } | { readonly ok: false; readonly reason: 'missing' | 'revoked' | 'reused' };

/**
 * Persistence for clients (global — registration happens before any
 * workspace is known) and per-workspace codes and grants. Every method is
 * atomic on its own record; `consumeCode` and `rotateGrant` are the two
 * single-use operations the protocol's replay protection rests on.
 */
export interface OAuthStore {
    registerClient(client: RegisteredClient): Promise<void>;
    client(clientId: string): Promise<RegisteredClient | null>;
    issueCode(workspaceId: WorkspaceId, code: PendingCode): Promise<void>;
    /** The code, and it is gone: a second call for the same id is `null`. Expired codes are `null` too. */
    consumeCode(workspaceId: WorkspaceId, codeId: string, now: number): Promise<PendingCode | null>;
    createGrant(workspaceId: WorkspaceId, grant: OAuthGrant): Promise<void>;
    grant(workspaceId: WorkspaceId, grantId: string): Promise<OAuthGrant | null>;
    /**
     * Refresh-token rotation: succeeds only when `generation` is the grant's
     * current one and bumps it. An older generation means the token was
     * already rotated — replay — and the whole grant is revoked (`reused`).
     */
    rotateGrant(workspaceId: WorkspaceId, grantId: string, generation: number, now: number): Promise<RotateGrantResult>;
    /** `false` when there was nothing to revoke. Idempotent. */
    revokeGrant(workspaceId: WorkspaceId, grantId: string, now: number): Promise<boolean>;
}

/** The user consenting on the authorization endpoint — resolved by the app from its own session cookie. */
export interface OAuthUser {
    readonly userId: string;
    readonly workspaceId: WorkspaceId;
}

/** RFC 6749 §5.2 error codes (plus the RFC 7591 registration ones). */
export type OAuthErrorCode =
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope'
    | 'unsupported_response_type'
    | 'access_denied'
    | 'server_error'
    | 'invalid_redirect_uri'
    | 'invalid_client_metadata';
