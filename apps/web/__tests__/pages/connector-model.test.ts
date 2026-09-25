/** The Add MCP server dialog's model (#241): ids, validation, what `mcpConnector` gets, and the connection test. */
import { describe, expect, it } from 'vitest';
import { mcpConnectorSetup } from '@agentic/mcp';
import type { PluginManifest } from '@agentic/core';
import { addConnector, connectorIdOf, connectorOptions, connectorStatusLabel, emptyConnectorDraft, probeConnector, validateConnectorDraft, type ConnectorDraft, type ConnectorProbe, type ConnectorRegistry } from '../../src/pages/plugins/connector';

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
        expect(validateConnectorDraft(draft({ name: 'x', url: 'https://x.test/mcp', auth: 'bearer', secret: '  \n' }), new Set())).toEqual({ secret: 'The token the server expects.' });
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
    const server = (expect: { header: string; value: string }, tools: readonly object[] = [{ name: 'ping', inputSchema: { type: 'object' } }]): typeof fetch =>
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'DELETE') return new Response(null, { status: 200 });
            const got = new Headers(init?.headers).get(expect.header);
            if (got !== expect.value) return new Response(`denied for ${got}`, { status: 403 });
            const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
            if (message.id === undefined) return new Response(null, { status: 202 });
            const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } } : { tools };
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;

    it('lists the tools under the connector namespace, sending the key in its header', async () => {
        const answer = await probeConnector(draft({ name: 'Acme', url: 'https://acme.test/mcp', auth: 'header', header: 'X-Api-Key', secret: 'k-1' }), { fetch: server({ header: 'x-api-key', value: 'k-1' }) });
        expect(answer).toEqual({ ok: true, tools: ['acme__ping'], declared: [{ name: 'ping' }] });
    });

    it('does not declare an undescribed tool\'s own name as its description, even when sanitizing changed it', async () => {
        const tools = [{ name: 'delete.repo', inputSchema: { type: 'object' } }];
        const answer = await probeConnector(draft({ name: 'Acme', url: 'https://acme.test/mcp', auth: 'header', header: 'X-Api-Key', secret: 'k-1' }), { fetch: server({ header: 'x-api-key', value: 'k-1' }, tools) });
        expect(answer).toEqual({ ok: true, tools: ['acme__delete_repo'], declared: [{ name: 'delete_repo' }] });
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

describe('addConnector', () => {
    /** A Registry that keeps what it was handed. */
    const registry = () => {
        const got: { manifest?: PluginManifest; status?: unknown; tools?: readonly string[] } = {};
        const r: ConnectorRegistry = {
            register: async (manifest) => {
                got.manifest = manifest;
                return {} as never;
            },
            putConnector: async () => ({}) as never,
            setSecret: async () => undefined,
            setConnectorStatus: async (_id, status, tools) => {
                got.status = status;
                got.tools = tools;
                return {} as never;
            },
            remove: async () => ({}) as never
        };
        return { r, got };
    };
    /** A server listing a read-only, a destructive and an unhinted tool. */
    const server = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE') return new Response(null, { status: 200 });
        const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const tools = [
            { name: 'list_items', description: 'List items', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
            { name: 'delete_item', description: 'Delete an item', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, readOnlyHint: false } },
            { name: 'ping', inputSchema: { type: 'object' } }
        ];
        const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } } : { tools };
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const acme = draft({ name: 'Acme Tools', url: 'https://acme.test/mcp' });

    it('registers a manifest whose tools match the probe, destructive and unannotated ones asking (#672)', async () => {
        const probe = await probeConnector(acme, { fetch: server });
        expect(probe.ok).toBe(true);
        const { r, got } = registry();
        expect(await addConnector(r, acme, probe)).toBe('acme-tools');
        expect(got.manifest?.tools).toEqual([
            { name: 'acme-tools__list_items', description: 'List items', defaultMode: 'allow' },
            { name: 'acme-tools__delete_item', description: 'Delete an item', defaultMode: 'ask' },
            { name: 'acme-tools__ping', defaultMode: 'ask' }
        ]);
        expect(got.manifest?.tools?.map((t) => t.name)).toEqual(probe.ok ? probe.tools : []);
        expect(got.status).toEqual({ state: 'ok' });
        expect(got.tools).toEqual(['acme-tools__list_items', 'acme-tools__delete_item', 'acme-tools__ping']);
    });

    it('declares the names alone from a probe that carries no details, and no tools without a probe or after a failed one', async () => {
        const names: ConnectorProbe = { ok: true, tools: ['acme-tools__ping'] };
        const a = registry();
        await addConnector(a.r, acme, names);
        expect(a.got.manifest?.tools).toEqual([{ name: 'acme-tools__ping', defaultMode: 'ask' }]);
        const b = registry();
        await addConnector(b.r, acme);
        expect(b.got.manifest).not.toHaveProperty('tools');
        const c = registry();
        await addConnector(c.r, acme, { ok: false, error: 'down' });
        expect(c.got.manifest).not.toHaveProperty('tools');
    });
});

describe('connectorStatusLabel', () => {
    it('counts tools when the last check passed', () => {
        expect(connectorStatusLabel({ status: { state: 'ok' }, tools: ['a'] })).toBe('1 tool');
        expect(connectorStatusLabel({ status: { state: 'error', error: 'x' }, tools: [] })).toBe('ERROR');
        expect(connectorStatusLabel({ status: { state: 'unknown' }, tools: [] })).toBe('UNCHECKED');
    });
});
