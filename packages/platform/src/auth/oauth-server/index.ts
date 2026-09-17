/**
 * OAuth 2.1 authorization server with Dynamic Client Registration for
 * external MCP clients (architecture §9, issue #50). Edge-safe; the app
 * mounts the handlers and supplies the signed-in user.
 */
export type { OAuthGrantType, RegisteredClient, PendingCode, OAuthGrant, RotateGrantResult, OAuthStore, OAuthUser, OAuthErrorCode } from './types.js';
export { ALL_SCOPES, isScope, parseScopes, formatScopes } from './scopes.js';
export {
    CODE_TTL_MS,
    ACCESS_TOKEN_TTL_MS,
    REFRESH_TOKEN_TTL_MS,
    CONSENT_TTL_MS,
    ACCESS_TOKEN_PREFIX,
    REFRESH_TOKEN_PREFIX,
    openAccessToken,
    openRefreshToken,
    type AccessTokenPayload,
    type RefreshTokenPayload
} from './tokens.js';
export { CLIENT_ID_PREFIX, isAcceptableRedirectUri, redirectUriMatches, validateClientMetadata, clientRegistrationResponse, type ClientMetadataVerdict } from './client.js';
export {
    AUTHORIZATION_PATH,
    TOKEN_PATH,
    REGISTRATION_PATH,
    REVOCATION_PATH,
    AS_METADATA_PATH,
    PROTECTED_RESOURCE_PREFIX,
    authorizationServerMetadata,
    protectedResourceMetadata,
    protectedResourceMetadataUrl,
    type MetadataOptions
} from './metadata.js';
export { renderConsent, renderError, escapeHtml, type ConsentView } from './consent.js';
export { createOAuthServer, type OAuthServer, type OAuthServerOptions, type ExternalPrincipal } from './server.js';
export { memoryOAuthStore, type MemoryOAuthStore } from './memory-store.js';
export {
    OAuthClients,
    OAuthGrants,
    OAUTH_CLIENTS_TYPE,
    OAUTH_CLIENTS_KEY,
    OAUTH_GRANTS_TYPE,
    MAX_CLIENTS,
    MAX_GRANTS,
    oauthGrantsKey,
    actorOAuthStore,
    type OAuthClientsState,
    type OAuthGrantsState,
    type OAuthClientsActor,
    type OAuthGrantsActor,
    type ActorOAuthStoreOptions
} from './actors.js';
