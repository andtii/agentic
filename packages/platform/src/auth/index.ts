/**
 * `@agentic/platform` auth (architecture §9) — edge-safe, framework-agnostic.
 *
 * - `same-workspace.ts` (#14): the `sameWorkspace` / `workspaceOwner`
 *   policies every actor's `authorize` chain starts with, and the key helpers.
 * - the rest (#32): the `AuthProvider` seam + GitHub, the `__Host-session`
 *   cookie, principal codec and minting, machine pairing and tokens, agent
 *   tokens, the `WORKSPACE_KEK` helpers, and the
 *   `createServerApp({ authenticate, codec })` pair that ties them together.
 *   Route handlers live in `apps/web/src/auth`.
 */
export * from './same-workspace.js';

export type { AuthProvider, AuthorizationRequest, CodeExchange, ExternalIdentity, AuthProviderErrorCode } from './provider.js';
export { AuthProviderError } from './provider.js';
export { githubAuthProvider, GITHUB_PROVIDER_ID, type GitHubAuthProviderConfig } from './providers/github.js';

export { SESSION_COOKIE, SESSION_TTL_MS, sealSession, openSession, sessionCookie, clearSessionCookie, sessionFromRequest, readCookie, serializeCookie, type SessionClaims, type SessionPayload, type SessionOptions, type CookieAttributes } from './cookie.js';

export {
    OAUTH_COOKIE,
    OAUTH_TRANSIENT_TTL_MS,
    beginOAuth,
    completeOAuth,
    clearOAuthCookie,
    createOAuthState,
    createCodeVerifier,
    codeChallengeS256,
    safeReturnTo,
    type BeginOAuthOptions,
    type BeginOAuthResult,
    type CompleteOAuthOptions,
    type CompleteOAuthResult
} from './oauth.js';

export { isPrincipal, encodePrincipal, decodePrincipal, principalCodec, userPrincipal, machinePrincipal, mintAgentPrincipal, type AgentPrincipalInput } from './principal.js';

export { AGENT_TOKEN_PREFIX, AGENT_TOKEN_TTL_MS, sealAgentToken, openAgentToken, asPrincipal, type AgentTokenOptions } from './agent-token.js';

export {
    MACHINE_TOKEN_PREFIX,
    issueMachineToken,
    hashMachineToken,
    parseMachineToken,
    verifyMachineToken,
    bearerToken,
    type MachineTokenRef,
    type IssuedMachineToken,
    type MachineTokenRecord,
    type MachineTokenVerdict
} from './machine-token.js';

export {
    PAIRING_TTL_MS,
    PAIRING_ALPHABET,
    normalizePairingCode,
    hashPairingCode,
    issuePairing,
    verifyPairing,
    consumePairing,
    isPairingLive,
    type PendingPairing,
    type IssuedPairing,
    type PairingVerdict
} from './pairing.js';

export { KEK_VERSION, importWorkspaceKek, generateWorkspaceKek, encryptSecret, decryptSecret } from './kek.js';

export { authenticateRequest, createAuthenticate, serverAuth, type AuthenticateFn, type AuthenticateOptions, type MachineTokenLookup } from './authenticate.js';

export { seal, open, hmacKey, type SealedPayload } from './seal.js';
export { toBase64Url, fromBase64Url, randomBytes, sha256, timingSafeEqual, timingSafeEqualText } from './encoding.js';
