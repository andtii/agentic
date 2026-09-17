/** The Streamable HTTP transport against a scripted server: SSE framing, server-initiated requests, failure statuses. */
// @vitest-environment node
import { JSON_RPC, McpTransportError, createStreamableHttpTransport, readSse, type McpServerMessage } from '@agentic/mcp';

const sse = (...messages: unknown[]) =>
    new Response(messages.map((m) => `event: message\r\ndata: ${JSON.stringify(m)}\r\n\r\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('readSse', () => {
    it('parses multi-line data, comments, CRLF and a final event without a trailing blank line', async () => {
        const body = new Blob([': keep-alive\n', 'id: 1\nevent: message\ndata: {"a":\ndata: 1}\n\n', 'data: x\r\n\r\n', 'data: last']).stream();
        const events = [];
        for await (const e of readSse(body)) events.push(e);
        expect(events).toEqual([{ id: '1', event: 'message', data: '{"a":\n1}' }, { id: '1', data: 'x' }, { id: '1', data: 'last' }]);
    });
});

describe('createStreamableHttpTransport', () => {
    it('answers a server-initiated request with METHOD_NOT_FOUND and reports it, before settling ours', async () => {
        const posted: unknown[] = [];
        const transport = createStreamableHttpTransport({
            url: 'http://x/mcp',
            fetch: async (_url, init) => {
                const body = JSON.parse(String(init?.body));
                posted.push(body);
                if (body.method === 'ping') {
                    return sse(
                        { jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: { messages: [] } },
                        { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } },
                        { jsonrpc: '2.0', method: 'notifications/resources/list_changed' },
                        { jsonrpc: '2.0', id: body.id, result: {} }
                    );
                }
                return new Response(null, { status: 202 });
            }
        });
        const seen: McpServerMessage[] = [];
        transport.onServerMessage((m) => seen.push(m));
        await expect(transport.request('ping')).resolves.toEqual({});
        await new Promise((r) => setTimeout(r, 0));
        expect(seen).toEqual([
            { method: 'sampling/createMessage', params: { messages: [] }, id: 'srv-1' },
            { method: 'notifications/resources/list_changed', params: undefined }
        ]);
        expect(posted).toContainEqual({ jsonrpc: '2.0', id: 'srv-1', error: { code: JSON_RPC.METHOD_NOT_FOUND, message: 'Client does not support sampling/createMessage' } });
    });

    it('turns HTTP failures, a missing response and a bad content-type into McpTransportError', async () => {
        const at = (response: Response) => createStreamableHttpTransport({ url: 'http://x/mcp', fetch: async () => response });
        await expect(at(new Response('nope', { status: 500 })).request('ping')).rejects.toMatchObject({ name: 'McpTransportError', status: 500 });
        await expect(at(new Response('{"jsonrpc":"2.0","id":99,"result":{}}', { headers: { 'content-type': 'application/json' } })).request('ping')).rejects.toBeInstanceOf(McpTransportError);
        await expect(at(new Response('<html>', { headers: { 'content-type': 'text/html' } })).request('ping')).rejects.toThrow(/content-type/);
        const network = createStreamableHttpTransport({
            url: 'http://x/mcp',
            fetch: async () => {
                throw new TypeError('fetch failed');
            }
        });
        await expect(network.request('ping')).rejects.toMatchObject({ name: 'McpTransportError', message: expect.stringContaining('fetch failed') });
    });

    it('maps a JSON-RPC error body to McpError with code and data', async () => {
        const transport = createStreamableHttpTransport({
            url: 'http://x/mcp',
            fetch: async (_u, init) => {
                const { id } = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Tool nope not found', data: { tool: 'nope' } } }), { headers: { 'content-type': 'application/json' } });
            }
        });
        await expect(transport.request('tools/call', { name: 'nope' })).rejects.toMatchObject({ name: 'McpError', code: -32602, message: 'Tool nope not found', data: { tool: 'nope' } });
    });

    it('times out a request that never answers', async () => {
        const transport = createStreamableHttpTransport({ url: 'http://x/mcp', timeoutMs: 20, fetch: (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))) });
        await expect(transport.request('ping')).rejects.toThrow();
    });
});
