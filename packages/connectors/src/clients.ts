/**
 * `clientFromSecrets` — conduit's `ClientResolver` over a connector plugin's
 * own Registry secrets (decisions 2026-09-23: bring-your-own OAuth client per
 * workspace). The values are opened per lookup, under the plugin's
 * `secret:` grants (PLG-04), and never cached here.
 */

import type { ClientLookup, ClientResolver } from '@aigntiq/conduit';

/**
 * The Registry secrets holding a connector plugin's OAuth client:
 * `<pluginId>-client-id` / `<pluginId>-client-secret` (#548). Registry secret
 * names are workspace-wide, so each conduit connector plugin names its own:
 * two connectors never sign in with each other's client.
 */
export function connectorClientSecretNames(pluginId: string): { readonly id: string; readonly secret: string } {
    const names = { id: `${pluginId}-client-id`, secret: `${pluginId}-client-secret` };
    // The Registry takes secret names of at most 128 characters: refuse here, where the plugin id is still named.
    if (names.secret.length > MAX_SECRET_NAME) {
        throw new Error(`[connectors] plugin id "${pluginId}" is too long for its OAuth client secret names (at most ${MAX_SECRET_NAME - '-client-secret'.length} characters)`);
    }
    return names;
}

/** The Registry's secret-name limit (`NAME_RE` of `@agentic/platform`). */
const MAX_SECRET_NAME = 128;
/**
 * The workspace's own random engine secret (≥ 32 characters): conduit's
 * `secret`, which signs OAuth state and keys the credential cipher. The
 * platform generates it on the first Connect and keeps it as a Registry
 * secret; nobody types it. Unlike the OAuth client it is not per plugin:
 * every conduit connector plugin of a workspace shares it on purpose, as
 * they share the workspace's one `ConnectorAccounts` store, so its accounts
 * open with one key per workspace and one workspace's sealed accounts never
 * open with another's.
 */
export const CONNECTOR_ENGINE_SECRET = 'connector-engine-secret';

/** Opens one secret of the connector plugin (`Registry.openSecret(name, pluginId)`); `undefined` when it is not set. */
export type OpenConnectorSecret = (name: string, lookup: ClientLookup) => Promise<string | undefined>;

/**
 * `pluginId`'s OAuth client (`connectorClientSecretNames`). No client id → no client, and conduit refuses to start the sign-in with
 * its own "no OAuth client" error. A client without a secret is passed on
 * as a public client.
 */
export function clientFromSecrets(openSecret: OpenConnectorSecret, pluginId: string): ClientResolver {
    const names = connectorClientSecretNames(pluginId);
    return async (lookup) => {
        const id = await openSecret(names.id, lookup);
        if (id === undefined || id === '') return undefined;
        const secret = await openSecret(names.secret, lookup);
        return secret === undefined || secret === '' ? { id } : { id, secret };
    };
}
