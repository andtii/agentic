/**
 * Streamable HTTP client transport over `fetch` — edge-safe, no SDK.
 *
 * Every request is one POST; the server answers with `application/json`
 * (one message) or `text/event-stream` (messages until ours arrives).
 * `Mcp-Session-Id` from `initialize` is echoed on every later request and
 * released with DELETE on `close()`. `MCP-Protocol-Version` is sent once the
 * version is negotiated. Not implemented, and said so in the capability
 * report: the standalone GET stream (server-initiated notifications between
 * requests), resumption (`Last-Event-ID`), and OAuth discovery — `auth` is a
 * bearer token the host already holds.
 */

import { McpNetworkError, guardFetch } from './network.js';
import { JSON_RPC, McpTransportError, errorFrom, isJsonRpcId, isPlainObject, type JsonRpcId, type JsonRpcResponse } from './protocol.js';
import { readSse } from './sse.js';
import { CONSUMED_NOTIFICATIONS, type McpRequestOptions, type McpServerMessage, type McpTransport } from './transport.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A bearer token, or a function producing one per request (a host that refreshes tokens). */
export type McpAuth = string | (() => string | Promise<string>);

export interface StreamableHttpTransportOptions {
    readonly url: string | URL;
    readonly auth?: McpAuth;
    /** Extra headers on every request (an API version, say). Authorization comes from `auth`. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Default: the global `fetch`. */
    readonly fetch?: FetchLike;
    /** Per-request timeout; default 60 000 ms. */
    readonly timeoutMs?: number;
    /**
     * The hosts of the connector plugin's granted `network:` scopes (#642). Set: a request to any other host fails
     * with `McpNetworkError` before it is sent. Absent: no allowlist.
     */
    readonly allowedHosts?: readonly string[];
}

export interface StreamableHttpTransport extends McpTransport {
    /** The session the server assigned on `initialize`, if any. */
    readonly sessionId: string | undefined;
    /** Set once `initialize` negotiated a version; sent as `MCP-Protocol-Version` from then on. */
    protocolVersion: string | undefined;
}

/** One signal aborting when any source does, plus `dispose` to detach from sources that never aborted. */
const anySignal = (signals: readonly AbortSignal[]): { readonly signal: AbortSignal | undefined; readonly dispose: () => void } => {
    const none = () => {};
    if (signals.length <= 1) return { signal: signals[0], dispose: none };
    const any = (AbortSignal as unknown as { any?: (s: readonly AbortSignal[]) => AbortSignal }).any;
    if (any) return { signal: any(signals), dispose: none };
    const controller = new AbortController();
    const detach: (() => void)[] = [];
    const dispose = () => {
        for (const d of detach.splice(0)) d();
    };
    for (const s of signals) {
        if (s.aborted) {
            controller.abort(s.reason);
            break;
        }
        const onAbort = () => {
            dispose();
            controller.abort(s.reason);
        };
        s.addEventListener('abort', onAbort, { once: true });
        detach.push(() => s.removeEventListener('abort', onAbort));
    }
    if (controller.signal.aborted) dispose();
    return { signal: controller.signal, dispose };
};

export function createStreamableHttpTransport(options: StreamableHttpTransportOptions): StreamableHttpTransport {
    const url = String(options.url);
    const baseFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
    const fetchImpl: FetchLike = options.allowedHosts ? guardFetch(baseFetch, options.allowedHosts) : baseFetch;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const listeners = new Set<(m: McpServerMessage) => void>();
    let sessionId: string | undefined;
    let nextId = 0;
    let closed = false;

    const headersFor = async (accept: string): Promise<Record<string, string>> => {
        const h: Record<string, string> = { ...options.headers, accept, 'content-type': 'application/json' };
        if (options.auth !== undefined) {
            const token = typeof options.auth === 'function' ? await options.auth() : options.auth;
            h.authorization = `Bearer ${token}`;
        }
        if (sessionId !== undefined) h['mcp-session-id'] = sessionId;
        if (transport.protocolVersion !== undefined) h['mcp-protocol-version'] = transport.protocolVersion;
        return h;
    };

    const post = async (body: unknown, signal?: AbortSignal): Promise<Response> => {
        if (closed) throw new McpTransportError('MCP transport is closed');
        let response: Response;
        try {
            response = await fetchImpl(url, { method: 'POST', headers: await headersFor('application/json, text/event-stream'), body: JSON.stringify(body), signal });
        } catch (e) {
            if (signal?.aborted || e instanceof McpNetworkError) throw e;
            throw new McpTransportError(`MCP request to ${url} failed: ${e instanceof Error ? e.message : String(e)}`, undefined, e);
        }
        const sid = response.headers.get('mcp-session-id');
        if (sid !== null) sessionId = sid;
        return response;
    };

    /** Answer a request the server sent us: we implement none of them. */
    const refuse = (id: JsonRpcId, method: string) =>
        post({ jsonrpc: '2.0', id, error: { code: JSON_RPC.METHOD_NOT_FOUND, message: `Client does not support ${method}` } })
            .then((r) => r.body?.cancel())
            .catch(() => {});

    const dispatch = (message: unknown): void => {
        if (!isPlainObject(message) || typeof message.method !== 'string') return;
        const info: McpServerMessage = { method: message.method, params: message.params, ...(isJsonRpcId(message.id) ? { id: message.id } : {}) };
        if (isJsonRpcId(message.id)) void refuse(message.id, message.method);
        else if (CONSUMED_NOTIFICATIONS.includes(message.method)) return;
        for (const l of listeners) l(info);
    };

    const settle = async (response: Response, id: JsonRpcId, method: string, signal?: AbortSignal): Promise<JsonRpcResponse> => {
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 404 && sessionId !== undefined) throw new McpTransportError(`MCP session ${sessionId} expired (404 from ${url})`, 404);
            throw new McpTransportError(`MCP request "${method}" to ${url} failed with HTTP ${response.status}`, response.status);
        }
        const type = (response.headers.get('content-type') ?? '').toLowerCase();
        if (type.startsWith('application/json')) {
            let body: unknown;
            try {
                body = await response.json();
            } catch (e) {
                if (signal?.aborted) throw e;
                throw new McpTransportError(`MCP response for "${method}" from ${url} is invalid JSON`, response.status, e);
            }
            for (const m of Array.isArray(body) ? body : [body]) {
                if (isPlainObject(m) && m.id === id && typeof m.method !== 'string') return m as unknown as JsonRpcResponse;
                dispatch(m);
            }
            throw new McpTransportError(`MCP response for "${method}" did not carry a result for request ${String(id)}`);
        }
        if (type.startsWith('text/event-stream') && response.body) {
            for await (const event of readSse(response.body, signal)) {
                let m: unknown;
                try {
                    m = JSON.parse(event.data);
                } catch {
                    continue;
                }
                for (const one of Array.isArray(m) ? m : [m]) {
                    if (isPlainObject(one) && one.id === id && typeof one.method !== 'string') return one as unknown as JsonRpcResponse;
                    dispatch(one);
                }
            }
            if (signal?.aborted) throw new McpTransportError(`MCP request "${method}" was aborted`);
            throw new McpTransportError(`MCP event stream for "${method}" ended without a response`);
        }
        await response.body?.cancel().catch(() => {});
        throw new McpTransportError(`MCP response for "${method}" has an unexpected content-type: ${type || '(none)'}`);
    };

    const transport: StreamableHttpTransport = {
        get sessionId() {
            return sessionId;
        },
        protocolVersion: undefined,
        async request<R>(method: string, params?: unknown, reqOptions: McpRequestOptions = {}): Promise<R> {
            const id = ++nextId;
            const timeout = AbortSignal.timeout(timeoutMs);
            const { signal, dispose } = anySignal(reqOptions.signal ? [reqOptions.signal, timeout] : [timeout]);
            try {
                const response = await post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, signal);
                const reply = await settle(response, id, method, signal);
                if (reply.error !== undefined) throw errorFrom(reply.error);
                return reply.result as R;
            } catch (e) {
                // Aborted (by the caller or the timeout): tell the server, best effort, so it stops the work.
                if (signal?.aborted && !closed) void transport.notify('notifications/cancelled', { requestId: id, reason: reqOptions.signal?.aborted ? 'aborted' : 'timeout' }).catch(() => {});
                if (signal?.aborted && !(e instanceof McpTransportError)) throw new McpTransportError(`MCP request "${method}" ${reqOptions.signal?.aborted ? 'was aborted' : `timed out after ${timeoutMs} ms`}`, undefined, e);
                throw e;
            } finally {
                dispose();
            }
        },
        async notify(method, params) {
            const response = await post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
            await response.body?.cancel().catch(() => {});
            if (!response.ok) throw new McpTransportError(`MCP notification "${method}" to ${url} failed with HTTP ${response.status}`, response.status);
        },
        onServerMessage(handler) {
            listeners.add(handler);
            return () => {
                listeners.delete(handler);
            };
        },
        async close() {
            if (closed) return;
            closed = true;
            if (sessionId === undefined) return;
            try {
                const response = await fetchImpl(url, { method: 'DELETE', headers: await headersFor('application/json, text/event-stream') });
                await response.body?.cancel().catch(() => {});
            } catch {
                // A server may not support explicit session termination (405) or may be gone; either way the session is over for us.
            }
        }
    };
    return transport;
}
