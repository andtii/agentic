/**
 * The stdio MCP client — Node only, meant for the machine daemon. The server
 * is a child process (`spawnAgentProcess`: no shell, Windows `.cmd` shims
 * resolved, env allowlisted, tree-killed on close) and JSON-RPC runs over its
 * stdio with `createJsonRpcPeer` (NDJSON framing, which is what MCP stdio
 * is). Server-initiated requests get the peer's built-in -32601.
 */

import { JSON_RPC as PEER_RPC, JsonRpcAbortError, JsonRpcClosedError, JsonRpcError, createJsonRpcPeer, type JsonRpcPeer } from '@sigx/ai-agent/harness';
import { resolveExecutable, spawnAgentProcess, type AgentProcess } from '@sigx/ai-agent-node';
import { createMcpClient, McpError, McpTransportError, type McpClient, type McpClientBaseOptions, type McpServerMessage, type McpTransport } from '../client/index.js';
import { CONSUMED_NOTIFICATIONS } from '../client/transport.js';

export interface StdioMcpClientOptions extends McpClientBaseOptions {
    /** Executable name (searched on PATH, `.cmd` shims handled) or path. */
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    /** Added to the allowlisted environment; `undefined` removes a key. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** Copy the whole parent environment instead of the allowlist. Default `false`. */
    readonly inheritEnv?: boolean;
    /** Per-request timeout; default 60 000 ms. */
    readonly timeoutMs?: number;
}

export interface StdioMcpClient extends McpClient {
    readonly transport: StdioMcpTransport;
    readonly process: AgentProcess;
    /** The peer, for hosts that need the raw connection (its `closed` promise, say). */
    readonly peer: JsonRpcPeer;
}

export interface StdioMcpTransport extends McpTransport {
    readonly process: AgentProcess;
    readonly peer: JsonRpcPeer;
}

/** A transport over a spawned process; `createStdioMcpClient` is the usual entry. */
export async function createStdioTransport(options: StdioMcpClientOptions): Promise<StdioMcpTransport> {
    const resolved = await resolveExecutable(options.command, options.cwd !== undefined ? { cwd: options.cwd } : {});
    const process = spawnAgentProcess({
        command: resolved.command,
        args: [...resolved.args, ...(options.args ?? [])],
        kind: resolved.kind,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: { ...resolved.env, ...options.env },
        ...(options.inheritEnv !== undefined ? { inheritEnv: options.inheritEnv } : {})
    });
    await process.spawned;
    const peer = createJsonRpcPeer({
        readable: process.readable,
        writable: process.writable,
        framing: 'ndjson',
        cancelMethod: 'notifications/cancelled',
        cancelParams: (id) => ({ requestId: id })
    });
    const listeners = new Set<(m: McpServerMessage) => void>();
    peer.onUnhandled((m) => {
        if (m.id === undefined && CONSUMED_NOTIFICATIONS.includes(m.method)) return;
        const info: McpServerMessage = { method: m.method, params: m.params, ...(m.id !== undefined ? { id: m.id } : {}) };
        for (const l of listeners) l(info);
    });
    const timeoutMs = options.timeoutMs ?? 60_000;

    const failure = (e: unknown, method: string): Error => {
        if (e instanceof JsonRpcError) return e.code === PEER_RPC.REQUEST_CANCELLED ? new McpTransportError(`MCP request "${method}" timed out after ${timeoutMs} ms`, undefined, e) : new McpError(e.code, e.message, e.data);
        if (e instanceof JsonRpcClosedError) {
            const tail = process.stderrTail().trim();
            return new McpTransportError(`MCP server process closed while "${method}" was pending${tail ? `: ${tail}` : ''}`, undefined, e);
        }
        if (e instanceof JsonRpcAbortError) return e;
        return e instanceof Error ? e : new Error(String(e));
    };

    let closed = false;
    return {
        process,
        peer,
        async request<R>(method: string, params?: unknown, reqOptions: { readonly signal?: AbortSignal } = {}): Promise<R> {
            try {
                return await peer.request<R>(method, params, { timeoutMs, ...(reqOptions.signal ? { signal: reqOptions.signal } : {}) });
            } catch (e) {
                throw failure(e, method);
            }
        },
        notify: (method, params) => peer.notify(method, params),
        onServerMessage(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        async close() {
            if (closed) return;
            closed = true;
            await peer.close();
            await process.kill().catch(() => {});
        }
    };
}

export async function createStdioMcpClient(options: StdioMcpClientOptions): Promise<StdioMcpClient> {
    const transport = await createStdioTransport(options);
    const client = createMcpClient({ ...options, transport, transportKind: 'stdio' });
    return Object.assign(client, { transport, process: transport.process, peer: transport.peer });
}
