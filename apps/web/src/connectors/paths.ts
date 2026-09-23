/**
 * The connector sign-in paths and names both halves of the app share (#533):
 * the Worker's routes (`./routes.ts`) and the plugin page (`pages/plugins`).
 * Pure constants — the page imports this without pulling conduit into the
 * client bundle.
 */

/** Every connector route lives under this prefix. */
export const CONNECTORS_ROUTE_PREFIX = '/_agentic/connectors/';

/** The OAuth callback: the redirect URI the owner registers with the provider. */
export const CONNECTOR_CALLBACK_PATH = '/_agentic/connectors/callback';

/**
 * The workspace's conduit engine secret — `CONNECTOR_ENGINE_SECRET` of
 * `@agentic/connectors`, pinned by `__tests__/connectors-routes.test.ts`. A
 * connector plugin that declares it is a conduit connector; the page never
 * offers a field for it (it is generated on the first Connect).
 */
export const CONNECTOR_ENGINE_SECRET_NAME = 'connector-engine-secret';

/** `<origin>/_agentic/connectors/callback`. */
export function connectorRedirectUri(origin: string): string {
    return `${origin.replace(/\/+$/, '')}${CONNECTOR_CALLBACK_PATH}`;
}

/** `GET` — starts the sign-in of one connector plugin. */
export function connectorStartPath(pluginId: string): string {
    return `${CONNECTORS_ROUTE_PREFIX}${encodeURIComponent(pluginId)}/start`;
}

/** `POST` — revokes the connected account at the provider and forgets it. */
export function connectorDisconnectPath(pluginId: string): string {
    return `${CONNECTORS_ROUTE_PREFIX}${encodeURIComponent(pluginId)}/disconnect`;
}

/** Where a connector's sign-in ends: its plugin page. */
export function connectorPluginPage(pluginId: string): string {
    return `/plugins/${encodeURIComponent(pluginId)}`;
}

/** The query parameters the routes hand the plugin page back. */
export const CONNECT_ERROR_PARAM = 'connect_error';
export const CONNECTED_PARAM = 'connected';
