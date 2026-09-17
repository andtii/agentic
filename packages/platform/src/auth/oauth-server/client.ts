/**
 * RFC 7591 Dynamic Client Registration for public clients — what lets
 * `claude mcp add --transport http agentic <url>` register itself with no
 * manual step. Only the metadata this server acts on is kept; the rest of
 * RFC 7591's vocabulary is accepted and ignored. A client is public by
 * construction: `token_endpoint_auth_method` must be `none`, no secret is
 * ever issued, and PKCE is what binds a code to the client that asked.
 */
import { parseScopes } from './scopes.js';
import { randomId } from './tokens.js';
import type { OAuthErrorCode, OAuthGrantType, RegisteredClient } from './types.js';

export const CLIENT_ID_PREFIX = 'oac_';
const GRANT_TYPES: readonly OAuthGrantType[] = ['authorization_code', 'refresh_token'];
const MAX_NAME = 200;
const MAX_REDIRECT_URIS = 16;

export type ClientMetadataVerdict =
    | { readonly ok: true; readonly client: Omit<RegisteredClient, 'clientId' | 'issuedAt'> }
    | { readonly ok: false; readonly error: Extract<OAuthErrorCode, 'invalid_client_metadata' | 'invalid_redirect_uri'>; readonly description: string };

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/** RFC 8252 §7.3 / §8.3: `https`, or plain `http` to a loopback address only. Never a fragment. */
export function isAcceptableRedirectUri(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return LOOPBACK_HOSTS.includes(url.hostname);
    return false;
}

/**
 * Exact string match, except that a loopback `http` redirect may vary its
 * port between registration and use (RFC 8252 §7.3): a CLI binds whatever
 * port is free when it starts the flow.
 */
export function redirectUriMatches(registered: readonly string[], candidate: string): boolean {
    if (registered.includes(candidate)) return true;
    let c: URL;
    try {
        c = new URL(candidate);
    } catch {
        return false;
    }
    if (c.protocol !== 'http:' || !LOOPBACK_HOSTS.includes(c.hostname)) return false;
    return registered.some((r) => {
        let u: URL;
        try {
            u = new URL(r);
        } catch {
            return false;
        }
        return u.protocol === 'http:' && u.hostname === c.hostname && u.pathname === c.pathname && u.search === c.search;
    });
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validate an RFC 7591 registration request body. */
export function validateClientMetadata(body: unknown): ClientMetadataVerdict {
    const bad = (error: 'invalid_client_metadata' | 'invalid_redirect_uri', description: string): ClientMetadataVerdict => ({ ok: false, error, description });
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('invalid_client_metadata', 'the registration request must be a JSON object');
    const m = body as Record<string, unknown>;

    if (!isStringArray(m.redirect_uris) || m.redirect_uris.length === 0) return bad('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
    if (m.redirect_uris.length > MAX_REDIRECT_URIS) return bad('invalid_redirect_uri', `at most ${MAX_REDIRECT_URIS} redirect_uris`);
    for (const uri of m.redirect_uris) if (!isAcceptableRedirectUri(uri)) return bad('invalid_redirect_uri', `redirect_uri "${uri}" must be https, or http on a loopback address, without a fragment`);

    const authMethod = m.token_endpoint_auth_method ?? 'none';
    if (authMethod !== 'none') return bad('invalid_client_metadata', 'only public clients are registered here: token_endpoint_auth_method must be "none"');

    let grantTypes: OAuthGrantType[] = [...GRANT_TYPES];
    if (m.grant_types !== undefined) {
        if (!isStringArray(m.grant_types) || m.grant_types.length === 0) return bad('invalid_client_metadata', 'grant_types must be a non-empty array');
        for (const g of m.grant_types) if (!GRANT_TYPES.includes(g as OAuthGrantType)) return bad('invalid_client_metadata', `grant_type "${g}" is not supported (authorization_code, refresh_token)`);
        grantTypes = m.grant_types as OAuthGrantType[];
        if (!grantTypes.includes('authorization_code')) return bad('invalid_client_metadata', 'grant_types must include authorization_code');
    }
    if (m.response_types !== undefined) {
        if (!isStringArray(m.response_types) || m.response_types.some((r) => r !== 'code')) return bad('invalid_client_metadata', 'response_types may only contain "code"');
    }

    let name = 'MCP client';
    if (m.client_name !== undefined) {
        if (typeof m.client_name !== 'string' || !m.client_name.trim()) return bad('invalid_client_metadata', 'client_name must be a non-empty string');
        name = m.client_name.trim().slice(0, MAX_NAME);
    }

    let scope: string | undefined;
    if (m.scope !== undefined) {
        if (typeof m.scope !== 'string') return bad('invalid_client_metadata', 'scope must be a string');
        const parsed = parseScopes(m.scope);
        if (parsed === null) return bad('invalid_client_metadata', `scope "${m.scope}" names a scope this server does not issue`);
        if (parsed.length > 0) scope = parsed.join(' ');
    }

    const optional = (key: 'client_uri' | 'software_id' | 'software_version'): string | undefined => (typeof m[key] === 'string' && (m[key] as string).length > 0 ? (m[key] as string).slice(0, MAX_NAME) : undefined);
    const clientUri = optional('client_uri');
    const softwareId = optional('software_id');
    const softwareVersion = optional('software_version');
    return {
        ok: true,
        client: {
            name,
            redirectUris: [...m.redirect_uris],
            grantTypes,
            ...(scope !== undefined ? { scope } : {}),
            ...(clientUri !== undefined ? { clientUri } : {}),
            ...(softwareId !== undefined ? { softwareId } : {}),
            ...(softwareVersion !== undefined ? { softwareVersion } : {})
        }
    };
}

export function newClientId(): string {
    return randomId(CLIENT_ID_PREFIX);
}

/** The RFC 7591 §3.2.1 response body: the registered metadata, echoed, plus the issued id. */
export function clientRegistrationResponse(client: RegisteredClient): Record<string, unknown> {
    return {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.issuedAt / 1000),
        client_name: client.name,
        redirect_uris: [...client.redirectUris],
        grant_types: [...client.grantTypes],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(client.scope !== undefined ? { scope: client.scope } : {}),
        ...(client.clientUri !== undefined ? { client_uri: client.clientUri } : {}),
        ...(client.softwareId !== undefined ? { software_id: client.softwareId } : {}),
        ...(client.softwareVersion !== undefined ? { software_version: client.softwareVersion } : {})
    };
}
