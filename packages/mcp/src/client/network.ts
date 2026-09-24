/**
 * The `network:` grant on an MCP connector's `fetch` (#642; PLG-04): a host
 * allowlist built from the connector plugin's granted `network:<host>` scopes.
 * A request to any other host never leaves — it fails with
 * `McpNetworkError`, whose message names the missing scope and nothing else
 * of the request (no path, no query, no header), so it is safe to show the
 * agent.
 *
 * A host matches a grant by `host` (with its port) or by `hostname`: the
 * manifest declares `network:<url.host>`.
 */

import type { FetchLike } from './http.js';

/** A request refused because its host is not among the connector's granted `network:` scopes. */
export class McpNetworkError extends Error {
    override readonly name = 'McpNetworkError';
    readonly code = 'network_not_granted';
    constructor(readonly scope: `network:${string}`) {
        super(`${scope} is not granted to this connector: the workspace owner can grant it on the connector's plugin page`);
    }
}

/** Whether `url` is on `allowedHosts` — by host (with its port) or by hostname. */
export function mcpHostAllowed(allowedHosts: readonly string[], url: URL): boolean {
    return allowedHosts.includes(url.host) || allowedHosts.includes(url.hostname);
}

/** `fetch` behind the allowlist: a request to a host not on it throws `McpNetworkError` before anything is sent. */
export function guardFetch(fetchImpl: FetchLike, allowedHosts: readonly string[]): FetchLike {
    const hosts = [...allowedHosts];
    return (input, init) => {
        const url = new URL(String(input));
        if (!mcpHostAllowed(hosts, url)) return Promise.reject(new McpNetworkError(`network:${url.host}`));
        return fetchImpl(input, init);
    };
}
