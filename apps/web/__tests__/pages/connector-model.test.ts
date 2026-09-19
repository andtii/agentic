/** The Add MCP server dialog's model (#241): ids, validation, what `mcpConnector` gets, and the connection test. */
import { describe, expect, it } from 'vitest';
import { mcpConnectorSetup } from '@agentic/mcp';
import { connectorIdOf, connectorOptions, connectorStatusLabel, emptyConnectorDraft, probeConnector, validateConnectorDraft, type ConnectorDraft } from '../../src/pages/plugins/connector';

const draft = (patch: Partial<ConnectorDraft>): ConnectorDraft => ({ ...emptyConnectorDraft(), ...patch });

describe('connectorIdOf', () => {
    it('turns a name into a plugin id the Registry and the tool namespace accept', () => {
        expect(connectorIdOf('Acme Tools')).toBe('acme-tools');
        expect(connectorIdOf('  GitHub (work)  ')).toBe('github-work');
        expect(connectorIdOf('linear.app')).toBe('linear.app');
        expect(connectorIdOf('***')).toBe('');
    });
});

describe('validateConnectorDraft', () => {
    it('names every missing or wrong field, and a name that collides with a plugin', () => {
        expect(validateConnectorDraft(draft({}), new Set())).toEqual({ name: 'Give it a name.', url: 'The server’s Streamable HTTP URL.' });
        expect(validateConnectorDraft(draft({ name: '***', url: 'ftp://x' }), new Set()).name).toBe('Use letters or digits in the name.');
        expect(validateConnectorDraft(draft({ name: 'x', url: 'ftp://x' }), new Set()).url).toMatch(/http\(s\) URL/);
        expect(validateConnectorDraft(draft({ name: 'Claude Code', url: 'https://x.test/mcp' }), new Set(['claude-code'])).name).toBe('A plugin called "claude-code" already exists.');
        expect(validateConnectorDraft(draft({ name: 'x', url: 'https://x.test/mcp', auth: 'header', header: 'bad header' }), new Set())).toEqual({ header: 'A header name, like X-Api-Key.', secret: 'The key the header carries.' });
        expect(validateConnectorDraft(draft({ name: 'x', url: 'https://x.test/mcp', auth: 'bearer', secret: 't' }), new Set())).toEqual({});
    });
});

describe('connectorOptions', () => {
    it('binds the credential by secret NAME — the bearer, or the header it rides in; none without auth', () => {
        const header = mcpConnectorSetup(connectorOptions(draft({ name: 'Acme', url: 'https://acme.test/mcp', auth: 'header', header: 'X-Api-Key', secret: 'v' })));
        expect(header.connector).toMatchObject({ id: 'acme', secrets: ['acme.token'], auth: { headers: { 'X-Api-Key': 'acme.token' } } });
        expect(header.manifest.secrets?.map((s) => s.name)).toEqual(['acme.token']);
        expect(JSON.stringify(header)).not.toContain('"v"');
        const open = mcpConnectorSetup(connectorOptions(draft({ name: 'Open', url: 'https://open.test/mcp' })));
        expect(open.connector.secrets).toEqual([]);
        expect(open.connector).not.toHaveProperty('auth');
    });
});

describe('probeConnector', () => {
    const server = (expect: { header: string; value: string }): typeof fetch =>
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'DELETE') return new Response(null, { status: 200 });
            const got = new Headers(init?.headers).get(expect.header);
            if (got !== expect.value) return new Response(`denied for ${got}`, { status: 403 });
            const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
            if (message.id === undefined) return new Response(null, { status: 202 });
            const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } } : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;

    it('lists the tools under the connector namespace, sending the key in its header', async () => {
        const answer = await probeConnector(draft({ name: 'Acme', url: 'https://acme.test/mcp', auth: 'header', header: 'X-Api-Key', secret: 'k-1' }), { fetch: server({ header: 'x-api-key', value: 'k-1' }) });
        expect(answer).toEqual({ ok: true, tools: ['acme__ping'] });
    });

    it('says why it failed, with the credential cut out even when the server echoes it', async () => {
        const answer = await probeConnector(draft({ name: 'Acme', url: 'https://acme.test/mcp', auth: 'bearer', secret: 'sekrit-77' }), { fetch: server({ header: 'authorization', value: 'Bearer other' }) });
        expect(answer.ok).toBe(false);
        expect(JSON.stringify(answer)).not.toContain('sekrit-77');
    });

    it('fails on an unreachable server without throwing', async () => {
        const answer = await probeConnector(draft({ name: 'Down', url: 'https://down.test/mcp' }), { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
        expect(answer).toMatchObject({ ok: false });
    });
});

describe('connectorStatusLabel', () => {
    it('counts tools when the last check passed', () => {
        expect(connectorStatusLabel({ status: { state: 'ok' }, tools: ['a'] })).toBe('1 tool');
        expect(connectorStatusLabel({ status: { state: 'error', error: 'x' }, tools: [] })).toBe('ERROR');
        expect(connectorStatusLabel({ status: { state: 'unknown' }, tools: [] })).toBe('UNCHECKED');
    });
});
