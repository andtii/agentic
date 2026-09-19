/**
 * `openMcpConnector` (#240): one Streamable HTTP connector as a session's
 * tools — against the official SDK server in process (`fetch` routed to its
 * Web-standard transport). Tools come back namespaced `<id>__<tool>`, the
 * bearer goes on the wire and nowhere else, a failure closes what it opened,
 * and a server that never answers costs the deadline, not a hung open.
 */
// @vitest-environment node
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { connectorToolPrefix, openMcpConnector, type FetchLike } from '@agentic/mcp';
import { fixtureServer } from '../fixtures/sdk-server';

const TOKEN = 'tok-9f2c-SECRET';

async function sdkFetch(options: { token?: string } = {}) {
    const server = fixtureServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
    await server.connect(transport);
    const methods: string[] = [];
    const fetch: FetchLike = async (input, init) => {
        const request = new Request(String(input), init);
        methods.push(request.method);
        if (options.token !== undefined && request.headers.get('authorization') !== `Bearer ${options.token}`) return new Response(null, { status: 401 });
        return transport.handleRequest(request);
    };
    return { fetch, methods, close: () => server.close() };
}

describe('openMcpConnector', () => {
    it('lists the server tools namespaced <id>__<tool>, calls them, and closes the session', async () => {
        const s = await sdkFetch({ token: TOKEN });
        const opened = await openMcpConnector({ id: 'acme', url: 'http://mcp.test/mcp', bearer: TOKEN, fetch: s.fetch });
        expect(opened.toolNames).toEqual(expect.arrayContaining(['acme__weather', 'acme__shout']));
        expect(opened.toolNames.every((n) => n.startsWith('acme__'))).toBe(true);
        const weather = opened.tools.find((t) => t.name === 'acme__weather')!;
        expect(weather.annotations).toMatchObject({ readOnly: true });
        const out = await weather.run({ city: 'Oslo' }, { signal: new AbortController().signal, toolCallId: 'c1' });
        expect(out).toEqual({ city: 'Oslo', tempC: 21 });
        await opened.close();
        expect(s.methods).toContain('DELETE');
        await s.close();
    });

    it('sanitises an id a provider would refuse into the namespace', () => {
        expect(connectorToolPrefix('acme.tools')).toBe('acme_tools__');
    });

    it('a refused credential throws, and the credential is not in the error', async () => {
        const s = await sdkFetch({ token: 'the-right-one' });
        const failure = await openMcpConnector({ id: 'acme', url: 'http://mcp.test/mcp', bearer: TOKEN, fetch: s.fetch }).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String((failure as Error).message)).not.toContain(TOKEN);
        await s.close();
    });

    it('a server that never answers costs the deadline, not a hung open', async () => {
        const hang: FetchLike = (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
        const started = Date.now();
        await expect(openMcpConnector({ id: 'acme', url: 'http://mcp.test/mcp', fetch: hang, timeoutMs: 50 })).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(2_000);
    });
});
