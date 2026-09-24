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

/** How many redirects `guardFetch` follows before it gives up — `fetch`'s own limit. */
const MAX_REDIRECTS = 20;

const isRedirect = (status: number): boolean => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

/**
 * `fetch` behind the allowlist: a request to a host not on it throws `McpNetworkError` before anything is sent.
 * Redirects are followed here, not by `fetch` (`redirect: 'manual'`), so every hop is checked: a granted server that
 * answers 3xx to a host not granted gets the same refusal, and nothing reaches that host. A 301 / 302 / 303 turns a
 * POST into a body-less GET and an `Authorization` header is dropped on a hop to another origin, as `fetch` does.
 */
export function guardFetch(fetchImpl: FetchLike, allowedHosts: readonly string[]): FetchLike {
    const hosts = [...allowedHosts];
    return async (input, init) => {
        let url = new URL(String(input));
        let hop: RequestInit | undefined = init;
        for (let redirects = 0; ; redirects++) {
            if (!mcpHostAllowed(hosts, url)) throw new McpNetworkError(`network:${url.host}`);
            const response = await fetchImpl(url.href, { ...hop, redirect: 'manual' });
            const location = response.headers.get('location');
            if (!isRedirect(response.status) || location === null || init?.redirect === 'manual') return response;
            if (init?.redirect === 'error') throw new TypeError(`MCP request to ${url.host} was redirected`);
            if (redirects >= MAX_REDIRECTS) throw new TypeError(`MCP request to ${url.host} was redirected too many times`);
            await response.body?.cancel();
            const next = new URL(location, url);
            if (next.origin !== url.origin && hop?.headers !== undefined) {
                // As `fetch` does: a credential never follows a redirect to another origin.
                const headers = new Headers(hop.headers);
                headers.delete('authorization');
                hop = { ...hop, headers };
            }
            url = next;
            const method = (hop?.method ?? 'GET').toUpperCase();
            if (response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST') {
                const { body: _body, ...rest } = hop ?? {};
                hop = { ...rest, method: method === 'HEAD' ? 'HEAD' : 'GET' };
            }
        }
    };
}
