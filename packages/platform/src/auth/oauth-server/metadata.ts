/**
 * Discovery documents: RFC 8414 authorization-server metadata and RFC 9728
 * protected-resource metadata. An MCP client starts from the resource
 * (`WWW-Authenticate: Bearer resource_metadata="…"` on the 401), reads
 * which authorization server protects it, then that server's metadata —
 * every endpoint below is derived from the issuer so the two documents
 * cannot disagree.
 */
import type { Scope } from '@agentic/core';

export const AUTHORIZATION_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTRATION_PATH = '/oauth/register';
export const REVOCATION_PATH = '/oauth/revoke';
export const AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';

export interface MetadataOptions {
    /** The origin the server lives on, no trailing slash (`https://agentic.example`). */
    readonly issuer: string;
    /** The MCP endpoint's absolute URL (`https://agentic.example/_agentic/mcp`). */
    readonly resource: string;
    readonly scopes: readonly Scope[];
}

/** RFC 8414 §2. */
export function authorizationServerMetadata(options: MetadataOptions): Record<string, unknown> {
    const { issuer } = options;
    return {
        issuer,
        authorization_endpoint: `${issuer}${AUTHORIZATION_PATH}`,
        token_endpoint: `${issuer}${TOKEN_PATH}`,
        registration_endpoint: `${issuer}${REGISTRATION_PATH}`,
        revocation_endpoint: `${issuer}${REVOCATION_PATH}`,
        scopes_supported: [...options.scopes],
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        service_documentation: `${issuer}/docs/architecture.md`
    };
}

/** RFC 9728 §2. */
export function protectedResourceMetadata(options: MetadataOptions): Record<string, unknown> {
    return {
        resource: options.resource,
        authorization_servers: [options.issuer],
        scopes_supported: [...options.scopes],
        bearer_methods_supported: ['header'],
        resource_name: 'agentic platform MCP server'
    };
}

/**
 * Where the resource's metadata lives: the path-aware form of RFC 9728 §3
 * (`/.well-known/oauth-protected-resource/_agentic/mcp`), which is the URL
 * the 401 challenge names.
 */
export function protectedResourceMetadataUrl(issuer: string, resource: string): string {
    const path = new URL(resource).pathname.replace(/\/+$/, '');
    return `${issuer}${PROTECTED_RESOURCE_PREFIX}${path}`;
}
