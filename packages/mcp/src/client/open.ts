/**
 * `openMcpConnector` — one configured Streamable HTTP connector as the tools
 * a session gets (#240): connect, list, namespace every tool `<id>__<tool>`
 * (`connectorToolPrefix`), and hand back a `close` the session calls on
 * dispose. Credentials come in as VALUES, already opened from the Registry by
 * the caller, and go only into request headers — never into a tool, a name,
 * an error message or anything returned.
 *
 * Bounded: the handshake and `tools/list` share one deadline
 * (`timeoutMs`, default 10 s), so a server that hangs costs a session open
 * that long at most. A failure closes what was opened and throws
 * `McpTransportError` / `McpError`; the caller decides what that means.
 */

import type { AnyTool } from '@sigx/ai';
import { createMcpClient } from './client.js';
import { connectorToolPrefix } from './connector.js';
import type { FetchLike } from './http.js';

export interface OpenMcpConnectorOptions {
    /** The connector id; its tools are named `<id>__<tool>`. */
    readonly id: string;
    readonly url: string;
    /** The bearer token's value, when the connector has one. */
    readonly bearer?: string;
    /** Credential headers by name, values already opened. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly fetch?: FetchLike;
    /**
     * The hosts of the connector plugin's granted `network:` scopes (#642; PLG-04). Set: the server is reached only
     * on one of them, anything else fails with `McpNetworkError` naming the scope. Absent: no allowlist.
     */
    readonly allowedHosts?: readonly string[];
    /** The deadline for connect + `tools/list`, ms. Default 10 000. */
    readonly timeoutMs?: number;
}

export interface OpenedMcpConnector {
    readonly tools: readonly AnyTool[];
    /** The tools' names as the session sees them (`github__create_issue`). */
    readonly toolNames: readonly string[];
    close(): Promise<void>;
}

export const MCP_CONNECTOR_OPEN_TIMEOUT_MS = 10_000;

export async function openMcpConnector(options: OpenMcpConnectorOptions): Promise<OpenedMcpConnector> {
    const client = createMcpClient({
        url: options.url,
        toolPrefix: connectorToolPrefix(options.id),
        timeoutMs: options.timeoutMs ?? MCP_CONNECTOR_OPEN_TIMEOUT_MS,
        ...(options.bearer !== undefined ? { auth: options.bearer } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {})
    });
    const deadline = options.timeoutMs ?? MCP_CONNECTOR_OPEN_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const tools = await Promise.race([
            client.tools(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`[agentic mcp] connector "${options.id}" did not list its tools within ${deadline} ms`)), deadline);
            })
        ]);
        return { tools, toolNames: tools.map((t) => t.name), close: () => client.close() };
    } catch (e) {
        await client.close().catch(() => undefined);
        throw e;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
