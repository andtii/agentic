/**
 * `createConnectorEngine` — conduit (`@aigntiq/conduit`) with every
 * host-specific piece injected (#531, architecture §9 "connectors that sign
 * in"). The stores are the workspace's (`ConnectorAccounts`, #532), the OAuth
 * client comes from the connector plugin's Registry secrets
 * (`clientFromSecrets`), and `secret` is the workspace's own random value, so
 * one workspace's sealed accounts never open with another's key.
 *
 * Edge-safe: conduit's root entry runs on `fetch` + WebCrypto; its `/node`
 * subpath is never imported here.
 */

import { createConduit, type AccountStore, type ClientResolver, type Conduit, type ConnectorSource, type HttpClient, type LockProvider, type TransientStore } from '@aigntiq/conduit';
import { connectorCatalog } from '@aigntiq/conduit-connectors';

export interface ConnectorEngineOptions {
    /** The workspace's random secret (≥ 32 characters): signs OAuth state and keys the credential cipher. */
    readonly secret: string;
    readonly accounts: AccountStore;
    /** OAuth state and PKCE verifiers: TTL, read-and-delete. */
    readonly transient: TransientStore;
    /** So a token is refreshed once when calls race. */
    readonly locks: LockProvider;
    /** The OAuth client per connector — `clientFromSecrets(openSecret)`. */
    readonly clients: ClientResolver;
    /** The absolute URL of the OAuth callback route. */
    readonly redirectUri: string;
    /** `fetch` replacement (tests). Default `globalThis.fetch`. */
    readonly http?: HttpClient;
    /** Where connector specs come from. Default: every connector of `@aigntiq/conduit-connectors`. */
    readonly sources?: ConnectorSource | ConnectorSource[];
    /** Clock, epoch ms (tests). */
    readonly now?: () => number;
}

/** The engine a workspace runs its native connectors on: conduit's runtime surface, as is. */
export type ConnectorEngine = Conduit;

/** The checks conduit leaves to the first sign-in, made at construction so a misconfigured workspace fails where it is set up. */
function checkOptions(options: ConnectorEngineOptions): void {
    if (typeof options.secret !== 'string' || options.secret.length < 32) throw new Error('[agentic connectors] the engine secret must be at least 32 characters');
    let redirect: URL;
    try {
        redirect = new URL(options.redirectUri);
    } catch {
        throw new Error(`[agentic connectors] redirectUri "${options.redirectUri}" is not an absolute URL`);
    }
    if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') throw new Error(`[agentic connectors] redirectUri "${options.redirectUri}" must be http(s)`);
}

export function createConnectorEngine(options: ConnectorEngineOptions): ConnectorEngine {
    checkOptions(options);
    return createConduit({
        sources: options.sources ?? connectorCatalog({ include: '*' }),
        secret: options.secret,
        accounts: options.accounts,
        transient: options.transient,
        locks: options.locks,
        clients: options.clients,
        redirectUri: options.redirectUri,
        ...(options.http ? { http: options.http } : {}),
        ...(options.now ? { now: options.now } : {})
    });
}
