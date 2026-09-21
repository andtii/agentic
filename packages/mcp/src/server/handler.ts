/**
 * `createPlatformMcpHandler` — the platform MCP server (architecture §9),
 * a `(Request) => Promise<Response>` for `/_agentic/mcp` over
 * `@sigx/ai-agent/harness`'s `createMcpToolHandler` (Streamable HTTP,
 * JSON responses, tools only, stateless).
 *
 * Per request: the bearer token is verified through `authenticate` into
 * an external principal (a miss is a 401 that names the protected-resource
 * metadata, RFC 9728 §5.1, so an MCP client can start OAuth discovery from
 * it); the tool set is built for THAT principal (`platformTools`) and the
 * harness handler is created over it — cheap, and it keeps the scope
 * decision next to the identity it was made for. `tools/list` is patched
 * to carry the annotations as MCP hints, which the harness does not emit
 * yet (signalxjs/ai#37); a `tools/call` of a tool in `MCP_CONTENT_TOOLS`
 * is patched to carry the result's own content blocks (an image, a file's
 * text), since the harness only emits the result as JSON text.
 */
import { createMcpToolHandler, MCP_PROTOCOL_VERSION } from '@sigx/ai-agent/harness';
import type { AnyTool } from '@sigx/ai';
import type { ChatFileStore } from '@agentic/core';
import type { ExternalPrincipal, PlatformPortFactory } from './port.js';
import { MCP_CONTENT_KEY, MCP_CONTENT_TOOLS, platformTools } from './tools.js';

export interface PlatformMcpHandlerOptions {
    /** The bearer token's principal, or `null` (→ 401). Typically `OAuthServer.verify`. */
    readonly authenticate: (request: Request) => Promise<ExternalPrincipal | null>;
    /** The port for a principal — `apps/web` binds it to the actors. */
    readonly port: PlatformPortFactory;
    /** Where chat attachment bytes live — the same store the platform's actors write (R2 in the web app). Absent: `chats_file_get` returns metadata only. */
    readonly files?: ChatFileStore;
    /** Absolute URL of the RFC 9728 document the 401 names. */
    readonly resourceMetadataUrl: string;
    readonly name?: string;
    readonly version?: string;
    readonly instructions?: string;
    /** Requests with an `Origin` outside this list → 403 (a browser page must never drive the surface with a leaked token). */
    readonly allowedOrigins?: readonly string[];
    /** Test seam: replace the tool set built for a principal. */
    readonly tools?: (principal: ExternalPrincipal) => readonly AnyTool[];
}

export type PlatformMcpHandler = (request: Request) => Promise<Response>;

export const PLATFORM_MCP_NAME = 'agentic';
export const PLATFORM_MCP_INSTRUCTIONS =
    'The agentic platform orchestration surface. Every daemon on every machine of the workspace is reachable here: list machines and environments, check each account’s provider usage limits (usage_limits), then open sessions on an explicitly chosen machine (sessions_open), prompt and follow them (sessions_prompt, sessions_tail), create and inspect tasks, post into chats and read their files, search memory, create schedules, list projects and set the project a chat belongs to (projects_list, chats_set_project), and the machine a chat runs on (chats_set_machine). Tool families are gated by the OAuth scopes granted to this client; a tool reports "forbidden" with the scope it needs.';

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** MCP `ToolAnnotations` hints from `@sigx/ai`'s. */
function hintsOf(tool: AnyTool): Record<string, boolean> | undefined {
    const a = tool.annotations;
    if (!a) return undefined;
    const out: Record<string, boolean> = {};
    if (a.readOnly !== undefined) out.readOnlyHint = a.readOnly;
    if (a.destructive !== undefined) out.destructiveHint = a.destructive;
    if (a.idempotent !== undefined) out.idempotentHint = a.idempotent;
    if (a.openWorld !== undefined) out.openWorldHint = a.openWorld;
    return Object.keys(out).length > 0 ? out : undefined;
}

/** The JSON-RPC method a POST carries (and the tool, for `tools/call`), without consuming the body the harness will read. */
async function peekMethod(request: Request): Promise<{ readonly method: string | null; readonly tool: string | null }> {
    try {
        const body = (await request.clone().json()) as unknown;
        if (!isPlainObject(body) || typeof body.method !== 'string') return { method: null, tool: null };
        const tool = isPlainObject(body.params) && typeof body.params.name === 'string' ? body.params.name : null;
        return { method: body.method, tool };
    } catch {
        return { method: null, tool: null };
    }
}

/** Lift a result's own content blocks into `content`; the rest of it stays `structuredContent`. */
async function withOwnContent(response: Response): Promise<Response> {
    const body = (await response.json()) as { result?: { content?: unknown; structuredContent?: Record<string, unknown>; isError?: boolean } };
    const structured = body.result?.structuredContent;
    if (body.result && !body.result.isError && isPlainObject(structured) && Array.isArray(structured[MCP_CONTENT_KEY])) {
        const { [MCP_CONTENT_KEY]: content, ...rest } = structured;
        body.result = { ...body.result, content, structuredContent: rest };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
}

export function createPlatformMcpHandler(options: PlatformMcpHandlerOptions): PlatformMcpHandler {
    const name = options.name ?? PLATFORM_MCP_NAME;
    const version = options.version ?? '0.0.0';
    const instructions = options.instructions ?? PLATFORM_MCP_INSTRUCTIONS;
    const challenge = (detail?: string): Response =>
        new Response(null, {
            status: 401,
            headers: { 'www-authenticate': `Bearer resource_metadata="${options.resourceMetadataUrl}"${detail ? `, error="invalid_token", error_description="${detail}"` : ''}`, 'cache-control': 'no-store' }
        });

    return async (request) => {
        // The harness answers GET/DELETE with 405 (no server stream, no session); the official client accepts both.
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
        const authorization = request.headers.get('authorization');
        if (!authorization) return challenge();
        const principal = await options.authenticate(request);
        if (!principal) return challenge('the access token is invalid, expired or revoked');

        const tools = options.tools ? options.tools(principal) : platformTools(options.port(principal), principal, options.files ? { files: options.files } : {});
        const handler = createMcpToolHandler(tools, {
            name,
            version,
            instructions,
            ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {})
        });
        const { method, tool } = await peekMethod(request);
        const response = await handler(request);
        if (response.status !== 200) return response;
        if (method === 'tools/call' && tool !== null && MCP_CONTENT_TOOLS.has(tool)) return withOwnContent(response);
        if (method !== 'tools/list') return response;
        // Merge the annotations in (readOnlyHint & co.), keeping everything else the harness said.
        const body = (await response.json()) as { result?: { tools?: Record<string, unknown>[] } };
        const byName = new Map(tools.map((t) => [t.name, t]));
        if (body.result?.tools) {
            body.result.tools = body.result.tools.map((t) => {
                const tool = typeof t.name === 'string' ? byName.get(t.name) : undefined;
                const hints = tool ? hintsOf(tool) : undefined;
                return hints ? { ...t, annotations: hints } : t;
            });
        }
        return new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    };
}

export { MCP_PROTOCOL_VERSION };
