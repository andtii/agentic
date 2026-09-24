/**
 * `createMcpClient` — a configured MCP server as platform tools.
 *
 * `connect()` runs `initialize` + `notifications/initialized` once (lazily,
 * from the first `tools()` / `callTool()`), negotiates the protocol version
 * and keeps the server's capabilities for `capabilityReport()`. `tools()`
 * lists on every call — no cache, so no stale list and no need to subscribe
 * to `list_changed`. Pass `url` for Streamable HTTP (edge-safe) or a
 * `transport` (the stdio client on `@agentic/mcp/node` does that).
 */

import type { AnyTool } from '@sigx/ai';
import { capabilityReportFor, type McpCapabilityReport } from './capabilities.js';
import { createStreamableHttpTransport, type FetchLike, type McpAuth } from './http.js';
import {
    MCP_PROTOCOL_VERSION,
    MCP_SUPPORTED_VERSIONS,
    McpTransportError,
    isPlainObject,
    type McpCallToolResult,
    type McpImplementation,
    type McpInitializeResult,
    type McpListToolsResult,
    type McpServerCapabilities,
    type McpToolDefinition
} from './protocol.js';
import { mcpTools } from './tools.js';
import type { McpRequestOptions, McpServerMessage, McpTransport } from './transport.js';

export interface McpClientBaseOptions {
    /** Reported to the server as `clientInfo`; default `agentic`. */
    readonly name?: string;
    readonly version?: string;
    /** Prepended to every tool name (`github_`); see `mcpTools`. */
    readonly toolPrefix?: string;
    /** Server-initiated requests and unconsumed notifications land here (they are refused either way). */
    readonly onServerMessage?: (message: McpServerMessage) => void;
}

export interface McpHttpClientOptions extends McpClientBaseOptions {
    readonly url: string | URL;
    readonly auth?: McpAuth;
    readonly headers?: Readonly<Record<string, string>>;
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
    /** The connector plugin's granted `network:` hosts (#642): any other host is refused before a request leaves. */
    readonly allowedHosts?: readonly string[];
    readonly transport?: undefined;
}

export interface McpTransportClientOptions extends McpClientBaseOptions {
    readonly transport: McpTransport;
    readonly transportKind?: McpCapabilityReport['transport'];
    readonly url?: undefined;
}

export type McpClientOptions = McpHttpClientOptions | McpTransportClientOptions;

export interface McpServerInfo {
    readonly protocolVersion: string;
    readonly server: McpImplementation;
    readonly capabilities: McpServerCapabilities;
    readonly instructions?: string;
}

export interface McpClient {
    /** Handshake; idempotent and lazy — `tools()` and `callTool()` call it for you. */
    connect(): Promise<McpServerInfo>;
    /** The server's tools as `@sigx/ai` tools, listed afresh on every call. */
    tools(): Promise<AnyTool[]>;
    /** Raw `tools/list`, every page. */
    listTools(): Promise<McpToolDefinition[]>;
    /** Raw `tools/call`; `isError` results are returned as-is here (the mapped tools throw `McpToolError`). */
    callTool(name: string, args?: Record<string, unknown>, options?: McpRequestOptions): Promise<McpCallToolResult>;
    ping(options?: McpRequestOptions): Promise<void>;
    /** What this client will and will not do against THIS server (PLG-09). Connects if needed. */
    capabilityReport(): Promise<McpCapabilityReport>;
    /** `undefined` until connected. */
    readonly serverInfo: McpServerInfo | undefined;
    close(): Promise<void>;
}

export function createMcpClient(options: McpClientOptions): McpClient {
    const kind: McpCapabilityReport['transport'] = options.transport ? (options.transportKind ?? 'custom') : 'streamable-http';
    const transport: McpTransport = options.transport ?? createStreamableHttpTransport(options);
    const clientInfo: McpImplementation = { name: options.name ?? 'agentic', version: options.version ?? '0.0.0' };
    if (options.onServerMessage) transport.onServerMessage(options.onServerMessage);

    let serverInfo: McpServerInfo | undefined;
    let connecting: Promise<McpServerInfo> | undefined;

    const initialize = async (): Promise<McpServerInfo> => {
        const result = await transport.request<McpInitializeResult>('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo });
        if (!isPlainObject(result) || typeof result.protocolVersion !== 'string' || !isPlainObject(result.serverInfo)) {
            throw new McpTransportError('MCP initialize returned a malformed result');
        }
        if (!MCP_SUPPORTED_VERSIONS.includes(result.protocolVersion)) {
            throw new McpTransportError(`MCP server speaks protocol ${result.protocolVersion}; this client supports ${MCP_SUPPORTED_VERSIONS.join(', ')}`);
        }
        if ('protocolVersion' in transport) (transport as { protocolVersion?: string }).protocolVersion = result.protocolVersion;
        await transport.notify('notifications/initialized');
        serverInfo = {
            protocolVersion: result.protocolVersion,
            server: result.serverInfo,
            capabilities: isPlainObject(result.capabilities) ? (result.capabilities as McpServerCapabilities) : {},
            ...(typeof result.instructions === 'string' ? { instructions: result.instructions } : {})
        };
        return serverInfo;
    };

    const connect = (): Promise<McpServerInfo> => {
        if (serverInfo) return Promise.resolve(serverInfo);
        connecting ??= initialize().catch((e: unknown) => {
            connecting = undefined;
            throw e;
        });
        return connecting;
    };

    const listTools = async (): Promise<McpToolDefinition[]> => {
        await connect();
        const all: McpToolDefinition[] = [];
        let cursor: string | undefined;
        do {
            const page = await transport.request<McpListToolsResult>('tools/list', cursor !== undefined ? { cursor } : undefined);
            if (!isPlainObject(page) || !Array.isArray(page.tools)) throw new McpTransportError('MCP tools/list returned a malformed result');
            all.push(...(page.tools as McpToolDefinition[]));
            cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        } while (cursor !== undefined);
        return all;
    };

    const callTool = async (name: string, args: Record<string, unknown> = {}, reqOptions?: McpRequestOptions): Promise<McpCallToolResult> => {
        await connect();
        const result = await transport.request<McpCallToolResult>('tools/call', { name, arguments: args }, reqOptions);
        if (!isPlainObject(result)) throw new McpTransportError(`MCP tools/call "${name}" returned a malformed result`);
        return { ...result, content: Array.isArray(result.content) ? result.content : [] } as McpCallToolResult;
    };

    return {
        connect,
        listTools,
        callTool,
        async tools() {
            const defs = await listTools();
            return mcpTools(defs, (name, args, signal) => callTool(name, args, { signal }), { prefix: options.toolPrefix });
        },
        async ping(reqOptions) {
            await connect();
            await transport.request('ping', undefined, reqOptions);
        },
        async capabilityReport() {
            const info = await connect();
            return capabilityReportFor({ transport: kind, protocolVersion: info.protocolVersion, server: info.server, serverCapabilities: info.capabilities });
        },
        get serverInfo() {
            return serverInfo;
        },
        async close() {
            serverInfo = undefined;
            connecting = undefined;
            await transport.close();
        }
    };
}
