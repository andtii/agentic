/**
 * The `network:` grant on a conduit connector's `fetch` (#642; PLG-04): a host
 * allowlist built from the connector plugin's granted `network:<host>` scopes
 * (`gmail.googleapis.com`, `oauth2.googleapis.com`). A request to any other
 * host never leaves — it fails with `ConnectorNetworkError`, whose message
 * names the missing scope and nothing else of the request (no path, no query,
 * no header), so it is safe to show the agent.
 *
 * It is a `ConduitError`, so conduit passes it through as it is: no retry, no
 * `request failed:` wrapping.
 */

import { ConduitError, type HttpClient } from '@aigntiq/conduit';

/** A request refused because its host is not among the connector's granted `network:` scopes. */
export class ConnectorNetworkError extends ConduitError {
    override readonly name = 'ConnectorNetworkError';
    constructor(readonly scope: `network:${string}`) {
        super('network_not_granted', `${scope} is not granted to this connector: the workspace owner can grant it on the connector's plugin page`);
    }
}

/** Whether `url` is on `allowedHosts` — by host (with its port) or by hostname. */
export function connectorHostAllowed(allowedHosts: readonly string[], url: URL): boolean {
    return allowedHosts.includes(url.host) || allowedHosts.includes(url.hostname);
}

/** conduit's `http` behind the allowlist: a request to a host not on it throws `ConnectorNetworkError` before anything is sent. */
export function guardHttp(http: HttpClient, allowedHosts: readonly string[]): HttpClient {
    const hosts = [...allowedHosts];
    return (request) => {
        const url = new URL(request.url);
        if (!connectorHostAllowed(hosts, url)) return Promise.reject(new ConnectorNetworkError(`network:${url.host}`));
        return http(request);
    };
}
