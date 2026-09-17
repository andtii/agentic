/**
 * The slice of the MCP wire protocol this client speaks — tools only. Kept as
 * plain types (no zod at runtime) so the client stays edge-safe and small.
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25
 */

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26'];

export type JsonRpcId = string | number;

/** JSON-RPC 2.0 codes the client sends back to a server that asks something it cannot do. */
export const JSON_RPC = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603
} as const;

export interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id: JsonRpcId;
    readonly method: string;
    readonly params?: unknown;
}

export interface JsonRpcNotification {
    readonly jsonrpc: '2.0';
    readonly method: string;
    readonly params?: unknown;
}

export interface JsonRpcErrorBody {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

export interface JsonRpcResponse {
    readonly jsonrpc: '2.0';
    readonly id: JsonRpcId | null;
    readonly result?: unknown;
    readonly error?: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface McpImplementation {
    readonly name: string;
    readonly version: string;
    readonly title?: string;
}

/** What a server advertises on `initialize`; every member is optional by spec. */
export interface McpServerCapabilities {
    readonly tools?: { readonly listChanged?: boolean };
    readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
    readonly prompts?: { readonly listChanged?: boolean };
    readonly logging?: Record<string, never>;
    readonly completions?: Record<string, never>;
    readonly tasks?: Record<string, unknown>;
    readonly experimental?: Record<string, unknown>;
}

export interface McpInitializeResult {
    readonly protocolVersion: string;
    readonly capabilities: McpServerCapabilities;
    readonly serverInfo: McpImplementation;
    readonly instructions?: string;
}

/** MCP `ToolAnnotations` — hints, all optional. */
export interface McpToolAnnotations {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
}

/** One entry of `tools/list`. `inputSchema` is JSON Schema, passed through verbatim. */
export interface McpToolDefinition {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: { readonly type: 'object'; readonly [key: string]: unknown };
    readonly outputSchema?: { readonly [key: string]: unknown };
    readonly annotations?: McpToolAnnotations;
    readonly _meta?: Record<string, unknown>;
}

export interface McpListToolsResult {
    readonly tools: readonly McpToolDefinition[];
    readonly nextCursor?: string;
}

export type McpContentBlock =
    | { readonly type: 'text'; readonly text: string; readonly [key: string]: unknown }
    | { readonly type: 'image'; readonly data: string; readonly mimeType: string; readonly [key: string]: unknown }
    | { readonly type: 'audio'; readonly data: string; readonly mimeType: string; readonly [key: string]: unknown }
    | { readonly type: 'resource_link'; readonly uri: string; readonly name: string; readonly [key: string]: unknown }
    | {
          readonly type: 'resource';
          readonly resource: { readonly uri: string; readonly mimeType?: string; readonly text?: string; readonly blob?: string };
          readonly [key: string]: unknown;
      };

export interface McpCallToolResult {
    readonly content: readonly McpContentBlock[];
    readonly structuredContent?: Record<string, unknown>;
    readonly isError?: boolean;
    readonly _meta?: Record<string, unknown>;
}

/** A JSON-RPC error the server returned (`tools/call` for an unknown tool, say). */
export class McpError extends Error {
    override readonly name = 'McpError';
    constructor(
        readonly code: number,
        message: string,
        readonly data?: unknown
    ) {
        super(message);
    }
}

/** The transport failed: an HTTP status the protocol does not expect, a dead process, a closed connection. */
export class McpTransportError extends Error {
    override readonly name = 'McpTransportError';
    constructor(
        message: string,
        readonly status?: number,
        override readonly cause?: unknown
    ) {
        super(message);
    }
}

/**
 * The tool ran and reported failure (`isError: true`). Thrown from the tool's
 * `execute` so the `@sigx/ai` engine hands the text to the model as an error
 * result — the same thing an MCP host does with it.
 */
export class McpToolError extends Error {
    override readonly name = 'McpToolError';
    constructor(
        readonly tool: string,
        message: string,
        readonly content: readonly McpContentBlock[]
    ) {
        super(message);
    }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isJsonRpcId = (v: unknown): v is JsonRpcId => typeof v === 'string' || typeof v === 'number';

/** Narrow a decoded message to the response for `id` — the shape both transports settle on. */
export function responseFor(message: unknown, id: JsonRpcId): JsonRpcResponse | undefined {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || typeof message.method === 'string') return undefined;
    return message.id === id ? (message as unknown as JsonRpcResponse) : undefined;
}

/** Turn a JSON-RPC error body into the error the caller sees. */
export function errorFrom(body: unknown): McpError {
    const e = isPlainObject(body) ? body : {};
    return new McpError(
        typeof e.code === 'number' ? e.code : JSON_RPC.INTERNAL_ERROR,
        typeof e.message === 'string' ? e.message : 'Unknown MCP error',
        e.data
    );
}
