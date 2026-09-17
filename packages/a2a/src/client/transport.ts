/**
 * JSON-RPC 2.0 over `fetch`, plus the SSE reader `SendStreamingMessage` needs.
 * Edge-safe: Web Streams, `TextDecoder`, no Node globals. A JSON-RPC error
 * becomes an `A2aError` with its code; an HTTP failure one with the status.
 */

import type { AgentCard, JsonRpcId, StreamResponse } from '../protocol/index.js';
import { A2A_ERROR, A2A_PROTOCOL_VERSION, A2aError, AGENT_CARD_PATH } from '../protocol/index.js';

export type FetchLike = (request: Request) => Promise<Response>;

export interface A2aTransportOptions {
    /** Default `globalThis.fetch`. A test passes its handler's `fetch` here. */
    readonly fetch?: FetchLike;
    /** A bearer token (or a full `Authorization` value), fixed or looked up per request. */
    readonly auth?: string | (() => string | Promise<string>);
    /** Extra request headers. */
    readonly headers?: Readonly<Record<string, string>>;
}

export interface A2aRpcClient {
    readonly url: string;
    call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
    stream(method: string, params: unknown, signal?: AbortSignal): AsyncGenerator<StreamResponse>;
}

async function headersFor(o: A2aTransportOptions, accept: string): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept, 'a2a-version': A2A_PROTOCOL_VERSION, ...o.headers };
    if (o.auth !== undefined) {
        const token = typeof o.auth === 'function' ? await o.auth() : o.auth;
        if (token) h.authorization = token.includes(' ') ? token : `Bearer ${token}`;
    }
    return h;
}

function httpError(res: Response): A2aError {
    const code = res.status === 401 || res.status === 403 ? A2A_ERROR.unsupportedOperation : A2A_ERROR.internal;
    return new A2aError(code, `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: res.status === 401 || res.status === 403 ? 'UNAUTHENTICATED' : 'HTTP_ERROR', domain: 'agentic', metadata: { status: res.status } }]);
}

function parseReply(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) throw new A2aError(A2A_ERROR.invalidAgentResponse, 'The agent answered with something other than a JSON-RPC response');
    const r = raw as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    if (r.error) throw new A2aError(typeof r.error.code === 'number' ? r.error.code : A2A_ERROR.internal, typeof r.error.message === 'string' ? r.error.message : undefined, r.error.data);
    return r.result;
}

export function createA2aRpcClient(url: string, options: A2aTransportOptions = {}): A2aRpcClient {
    const doFetch: FetchLike = options.fetch ?? ((r) => fetch(r));
    let seq = 0;
    const body = (method: string, params: unknown, id: JsonRpcId) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return {
        url,
        async call<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
            const res = await doFetch(new Request(url, { method: 'POST', headers: await headersFor(options, 'application/json'), body: body(method, params, ++seq), ...(signal ? { signal } : {}) }));
            if (!res.ok) throw httpError(res);
            return parseReply(await res.json()) as T;
        },
        async *stream(method: string, params: unknown, signal?: AbortSignal): AsyncGenerator<StreamResponse> {
            const res = await doFetch(new Request(url, { method: 'POST', headers: await headersFor(options, 'text/event-stream, application/json'), body: body(method, params, ++seq), ...(signal ? { signal } : {}) }));
            if (!res.ok) throw httpError(res);
            const type = res.headers.get('content-type') ?? '';
            if (!type.includes('text/event-stream')) {
                // A server that answers a stream request with one JSON reply (no streaming): one frame.
                const result = parseReply(await res.json());
                if (result !== undefined) yield result as StreamResponse;
                return;
            }
            for await (const data of sseData(res, signal)) {
                const result = parseReply(JSON.parse(data));
                if (result !== undefined) yield result as StreamResponse;
            }
        }
    };
}

/** The `data:` payload of each SSE event, in order. */
export async function* sseData(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const onAbort = () => void reader.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let at: number;
            while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
                const block = buffer.slice(0, at);
                buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
                const data = eventData(block);
                if (data !== undefined) yield data;
            }
        }
        const tail = eventData(buffer);
        if (tail !== undefined) yield tail;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        reader.releaseLock();
    }
}

function eventData(block: string): string | undefined {
    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
    }
    return lines.length ? lines.join('\n') : undefined;
}

/** The card URL for an origin or an explicit card URL. */
export function cardUrlFor(input: string): string {
    const url = new URL(input);
    if (url.pathname.endsWith('.json')) return url.toString();
    url.pathname = url.pathname.replace(/\/+$/, '') + AGENT_CARD_PATH;
    return url.toString();
}

export async function fetchAgentCard(cardUrl: string, options: A2aTransportOptions = {}): Promise<AgentCard> {
    const doFetch: FetchLike = options.fetch ?? ((r) => fetch(r));
    const headers = await headersFor(options, 'application/json');
    delete headers['content-type'];
    const res = await doFetch(new Request(cardUrl, { method: 'GET', headers }));
    if (!res.ok) throw httpError(res);
    const card = (await res.json()) as Partial<AgentCard>;
    if (typeof card !== 'object' || card === null || typeof card.name !== 'string' || !Array.isArray(card.supportedInterfaces)) {
        throw new A2aError(A2A_ERROR.invalidAgentResponse, `"${cardUrl}" is not an A2A agent card`);
    }
    return card as AgentCard;
}
