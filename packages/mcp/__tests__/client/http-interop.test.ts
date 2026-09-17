/**
 * Interop: our `fetch`-based Streamable HTTP client against the official
 * `@modelcontextprotocol/sdk` server, in process — `fetch` is routed straight
 * to the SDK's Web-standard transport. Covers list, call, error mapping,
 * sessions, both response modes (SSE and JSON) and the capability report.
 */
// @vitest-environment node
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SchemaValidationError, type AnyTool } from '@sigx/ai';
import { MCP_SUPPORTED_VERSIONS, McpError, McpToolError, McpTransportError, createMcpClient, createStreamableHttpTransport, type FetchLike, type McpClient, type StreamableHttpTransport } from '@agentic/mcp';
import { fixtureServer } from '../fixtures/sdk-server';

interface Harness {
    readonly client: McpClient;
    readonly transport: StreamableHttpTransport;
    readonly requests: { method: string; headers: Headers; body: string }[];
    close(): Promise<void>;
}

/** Like a real `fetch`, reject as soon as the signal aborts instead of waiting for the handler. */
const raceAbort = <T>(p: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> =>
    signal ? Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))]) : p;

async function harness(options: { json?: boolean; stateless?: boolean; auth?: string } = {}): Promise<Harness> {
    const closers: (() => Promise<void>)[] = [];
    const serverTransport = async () => {
        const server = fixtureServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: options.stateless ? undefined : () => crypto.randomUUID(),
            enableJsonResponse: options.json ?? false
        });
        await server.connect(transport);
        closers.push(() => server.close());
        return transport;
    };
    // The SDK's stateless mode wants a fresh transport per request (like a Worker would give it).
    const shared = options.stateless ? undefined : await serverTransport();
    const requests: Harness['requests'] = [];
    const fetchToServer: FetchLike = async (input, init) => {
        const request = new Request(String(input), init);
        requests.push({ method: request.method, headers: request.headers, body: typeof init?.body === 'string' ? init.body : '' });
        if (options.auth !== undefined && request.headers.get('authorization') !== `Bearer ${options.auth}`) return new Response(null, { status: 401 });
        return raceAbort((shared ?? (await serverTransport())).handleRequest(request), init?.signal);
    };
    const transport = createStreamableHttpTransport({ url: 'http://mcp.test/mcp', fetch: fetchToServer, auth: options.auth });
    const client = createMcpClient({ transport, transportKind: 'streamable-http', name: 'interop', version: '0.0.1' });
    return {
        client,
        transport,
        requests,
        close: async () => {
            await client.close();
            for (const c of closers) await c();
        }
    };
}

const byName = (tools: readonly AnyTool[], name: string): AnyTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
};
const ctx = () => ({ signal: new AbortController().signal, toolCallId: 'call-1' });

describe('MCP client ↔ @modelcontextprotocol/sdk server (Streamable HTTP)', () => {
    it('initializes, negotiates a supported version and keeps the session', async () => {
        const h = await harness();
        const info = await h.client.connect();
        expect(MCP_SUPPORTED_VERSIONS).toContain(info.protocolVersion);
        expect(info.server).toMatchObject({ name: 'fixture', version: '1.2.3' });
        expect(info.instructions).toBe('be nice');
        expect(info.capabilities.tools).toBeDefined();
        await h.client.ping();
        const sid = h.requests.at(-1)?.headers.get('mcp-session-id');
        expect(sid).toBeTruthy();
        expect(h.requests.at(-1)?.headers.get('mcp-protocol-version')).toBe(info.protocolVersion);
        await h.close();
        expect(h.requests.at(-1)?.method).toBe('DELETE');
        expect(h.requests.at(-1)?.headers.get('mcp-session-id')).toBe(sid);
    });

    it('lists tools as @sigx/ai tools with the wire schema and annotations preserved', async () => {
        const h = await harness();
        const tools = await h.client.tools();
        expect(tools.map((t) => t.name).sort()).toEqual(['fails', 'shout', 'slow', 'snapshot', 'throws', 'weather']);
        const weather = byName(tools, 'weather');
        expect(weather.description).toBe('Weather for a city');
        expect(weather.spec.inputSchema).toMatchObject({ type: 'object', required: ['city'], properties: { city: { type: 'string', description: 'City name' }, units: { enum: ['c', 'f'] } } });
        expect(weather.annotations).toEqual({ readOnly: true, openWorld: true });
        expect(byName(tools, 'snapshot').annotations).toEqual({ destructive: false });
        expect(byName(tools, 'shout').annotations).toBeUndefined();
        await h.close();
    });

    it('calls a tool: structuredContent wins, text blocks join, other blocks pass through', async () => {
        const h = await harness();
        const tools = await h.client.tools();
        await expect(byName(tools, 'weather').run({ city: 'Oslo', units: 'f' }, ctx())).resolves.toEqual({ city: 'Oslo', tempC: 21 });
        await expect(byName(tools, 'shout').run({ text: 'hi' }, ctx())).resolves.toBe('HI\n!');
        await expect(byName(tools, 'snapshot').run({}, ctx())).resolves.toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]);
        await h.close();
    });

    it('maps errors: isError → McpToolError, a throwing tool → McpToolError, missing required → SchemaValidationError before the wire', async () => {
        const h = await harness();
        const tools = await h.client.tools();
        const before = h.requests.length;
        await expect(byName(tools, 'weather').run({}, ctx())).rejects.toBeInstanceOf(SchemaValidationError);
        expect(h.requests.length).toBe(before);
        await expect(byName(tools, 'fails').run({ why: 'bad input' }, ctx())).rejects.toMatchObject({ name: 'McpToolError', tool: 'fails', message: 'failed: bad input' });
        const thrown = await byName(tools, 'throws')
            .run({}, ctx())
            .catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(McpToolError);
        expect((thrown as Error).message).toContain('kaput');
        // The raw call reports isError instead of throwing — the mapped tool is what throws.
        await expect(h.client.callTool('fails', {})).resolves.toMatchObject({ isError: true });
        // The SDK server answers an unknown tool and bad arguments as isError results (its choice); both reach the model as errors.
        await expect(h.client.callTool('nope', {})).resolves.toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('nope') }] });
        await expect(h.client.callTool('weather', { city: 42 })).resolves.toMatchObject({ isError: true });
        await h.close();
    });

    it('maps a JSON-RPC error from the server (unknown method) to McpError with its code', async () => {
        const h = await harness();
        await h.client.connect();
        const err = await h.transport.request('resources/list').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(-32601);
        expect(err).not.toBeInstanceOf(McpTransportError);
        await h.close();
    });

    it('works in JSON response mode and stateless mode too', async () => {
        const h = await harness({ json: true, stateless: true });
        const tools = await h.client.tools();
        await expect(byName(tools, 'weather').run({ city: 'Rome' }, ctx())).resolves.toEqual({ city: 'Rome', tempC: 21 });
        expect(h.requests.some((r) => r.headers.get('mcp-session-id') !== null)).toBe(false);
        await h.close();
        expect(h.requests.at(-1)?.method).toBe('POST');
    });

    it('sends the bearer token and surfaces a 401 as a transport error with the status', async () => {
        const ok = await harness({ auth: 'tok-1' });
        await expect(ok.client.tools()).resolves.toHaveLength(6);
        await ok.close();
        const server = fixtureServer();
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        const client = createMcpClient({ url: 'http://mcp.test/mcp', auth: async () => 'wrong', fetch: async (i, init) => (new Request(String(i), init).headers.get('authorization') === 'Bearer tok-1' ? transport.handleRequest(new Request(String(i), init)) : new Response(null, { status: 401 })) });
        const err = await client.tools().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(McpTransportError);
        expect((err as McpTransportError).status).toBe(401);
        await client.close();
        await server.close();
    });

    it('aborts a call through the tool context signal and tells the server', async () => {
        const h = await harness();
        const tools = await h.client.tools();
        const controller = new AbortController();
        const pending = byName(tools, 'slow').run({ ms: 10_000 }, { signal: controller.signal, toolCallId: 'c' });
        await new Promise((r) => setTimeout(r, 20));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'McpTransportError', message: expect.stringContaining('aborted') });
        await new Promise((r) => setTimeout(r, 0));
        const cancelled = h.requests.filter((r) => r.body.includes('"notifications/cancelled"'));
        expect(cancelled).toHaveLength(1);
        expect(JSON.parse(cancelled[0]!.body).params).toMatchObject({ reason: 'aborted' });
        await h.close();
    });

    it('reports capabilities honestly: what the server offers that this client will not use', async () => {
        const h = await harness();
        const report = await h.client.capabilityReport();
        expect(report.transport).toBe('streamable-http');
        expect(report.server.name).toBe('fixture');
        expect(report.supported).toContain('tools/call');
        expect(report.unsupported.map((u) => u.op)).toEqual(expect.arrayContaining(['resources', 'prompts', 'sampling', 'elicitation']));
        expect(report.offeredButUnsupported).toEqual(expect.arrayContaining(['resources', 'prompts', 'logging']));
        expect(report.toolsUnavailable).toBe(false);
        await h.close();
    });
});
