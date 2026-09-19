/**
 * `openStdioMcpConnector` — one configured stdio connector as the tools a
 * daemon-hosted session gets (#280): spawn the server, list, namespace every
 * tool `<id>__<tool>` (`connectorToolPrefix`), and hand back a `close` that
 * kills the process. The stdio twin of `openMcpConnector`.
 *
 * Credentials come in as environment VALUES, already fetched by the caller,
 * and go only into the child's environment — on top of the stdio client's
 * allowlist, never the daemon's whole environment. Bounded: the spawn, the
 * handshake and `tools/list` share one deadline (`timeoutMs`, default 10 s);
 * a server that misses it is killed, even one that comes up afterwards.
 */

import { connectorToolPrefix, MCP_CONNECTOR_OPEN_TIMEOUT_MS, type OpenedMcpConnector } from '../client/index.js';
import { createStdioMcpClient, type StdioMcpClient } from './stdio.js';

export interface OpenStdioMcpConnectorOptions {
    /** The connector id; its tools are named `<id>__<tool>`. */
    readonly id: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    /** Credential variables by name, values already opened; added to the allowlisted environment. */
    readonly env?: Readonly<Record<string, string>>;
    /** The deadline for spawn + connect + `tools/list`, ms. Default 10 000. */
    readonly timeoutMs?: number;
    /** How the client is made; `createStdioMcpClient` by default (a fake in tests). */
    readonly create?: typeof createStdioMcpClient;
}

export async function openStdioMcpConnector(options: OpenStdioMcpConnectorOptions): Promise<OpenedMcpConnector> {
    const deadline = options.timeoutMs ?? MCP_CONNECTOR_OPEN_TIMEOUT_MS;
    const create = options.create ?? createStdioMcpClient;
    let client: StdioMcpClient | undefined;
    let late = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = (async () => {
        const c = await create({
            command: options.command,
            ...(options.args ? { args: options.args } : {}),
            ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
            ...(options.env ? { env: options.env } : {}),
            toolPrefix: connectorToolPrefix(options.id),
            timeoutMs: deadline
        });
        client = c;
        // Came up after the deadline: nobody will use it.
        if (late) await c.close().catch(() => undefined);
        return c.tools();
    })();
    try {
        const tools = await Promise.race([
            open,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`[agentic mcp] connector "${options.id}" did not list its tools within ${deadline} ms`)), deadline);
            })
        ]);
        const opened = client!;
        return { tools, toolNames: tools.map((t) => t.name), close: () => opened.close() };
    } catch (e) {
        late = true;
        open.catch(() => undefined);
        await client?.close().catch(() => undefined);
        throw e;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
