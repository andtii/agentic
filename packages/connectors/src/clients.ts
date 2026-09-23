/**
 * `clientFromSecrets` — conduit's `ClientResolver` over a connector plugin's
 * own Registry secrets (decisions 2026-09-23: bring-your-own OAuth client per
 * workspace). The values are opened per lookup, under the plugin's
 * `secret:` grants (PLG-04), and never cached here.
 */

import type { ClientLookup, ClientResolver } from '@aigntiq/conduit';

/** The secret holding the OAuth client id. */
export const CONNECTOR_CLIENT_ID_SECRET = 'client-id';
/** The secret holding the OAuth client secret. */
export const CONNECTOR_CLIENT_SECRET_SECRET = 'client-secret';
/**
 * The workspace's own random engine secret (≥ 32 characters): conduit's
 * `secret`, which signs OAuth state and keys the credential cipher. The
 * platform generates it on the first Connect and keeps it as a Registry
 * secret; nobody types it. Every conduit connector plugin of a workspace
 * shares it, so its accounts open with one key per workspace.
 */
export const CONNECTOR_ENGINE_SECRET = 'connector-engine-secret';

/** Opens one secret of the connector plugin (`Registry.openSecret(name, pluginId)`); `undefined` when it is not set. */
export type OpenConnectorSecret = (name: string, lookup: ClientLookup) => Promise<string | undefined>;

/**
 * No `client-id` → no client, and conduit refuses to start the sign-in with
 * its own "no OAuth client" error. A client without a secret is passed on
 * as a public client.
 */
export function clientFromSecrets(openSecret: OpenConnectorSecret): ClientResolver {
    return async (lookup) => {
        const id = await openSecret(CONNECTOR_CLIENT_ID_SECRET, lookup);
        if (id === undefined || id === '') return undefined;
        const secret = await openSecret(CONNECTOR_CLIENT_SECRET_SECRET, lookup);
        return secret === undefined || secret === '' ? { id } : { id, secret };
    };
}
