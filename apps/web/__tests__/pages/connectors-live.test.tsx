/**
 * Adding, testing and removing an MCP server from `/plugins` over the real
 * wire (#241; PLG-03, AST-09): the dialog tests the connection against a
 * Streamable HTTP server (a fake behind `fetch`) and lists its tools, adding
 * installs the connector plugin with its credential sealed and the test's
 * result recorded, an agent can pick it, and removing refuses while the agent
 * does, names it, and removes on confirm — credential included.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActor, agentKey, AuditActor, auditKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { MEMORY_PLUGINS } from '@agentic/memory';
import { learningDefaultPlugin } from '@agentic/learning';
import { agentCatalog } from '../../src/pages/agent/catalog';
import { buttonNamed, setText, text, tick } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...RUNTIME_PLUGINS, ...MEMORY_PLUGINS, learningDefaultPlugin] });

const MCP_URL = 'https://mcp.acme.test/mcp';
const TOKEN = 'tok-acme-DO-NOT-SHOW-41f9';

/** A Streamable HTTP MCP server behind `fetch`: JSON answers, the bearer checked, two tools listed. */
function fakeMcpFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url !== MCP_URL) throw new TypeError(`fetch failed: nothing at ${url}`);
        if (init?.method === 'DELETE') return new Response(null, { status: 200 });
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return new Response(`unauthorized: got ${new Headers(init?.headers).get('authorization')}`, { status: 401 });
        const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { protocolVersion?: string } };
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
            message.method === 'initialize'
                ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'acme', version: '1' } }
                : message.method === 'tools/list'
                  ? { tools: ['echo', 'search'].map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object' } })) }
                  : null;
        const body = result ? { jsonrpc: '2.0', id: message.id, result } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    };
}

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { actors: [Registry] });
    vi.stubGlobal('fetch', fakeMcpFetch());
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await h.stop();
});

const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const popup = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const field = (root: ParentNode, name: string) => root.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const setSelect = (el: HTMLSelectElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
};

describe('/plugins: MCP servers (live)', () => {
    it('add → tested, with its tools → an agent picks it → remove refuses and names the agent → removes on confirm', async () => {
        const ada = await h.agent('Ada');
        // MCP servers are managed in the Connectors view (#637 took them off the list).
        const dom = await mountLive('/plugins?kind=connector', h);
        await until(() => dom.querySelector('[data-plugin-connectors] [data-plugin-none]')?.textContent?.includes('No connectors') === true, 'the empty connector list');

        buttonNamed(dom, 'Add MCP server').click();
        await until(() => popup(dom) !== null, 'the dialog');
        // Nothing filled in: the dialog stays, the fields say why.
        buttonNamed(popup(dom)!, 'Add connector').click();
        await tick();
        expect(popup(dom)!.textContent).toContain('Give it a name.');
        expect(await registry().connectors()).toEqual([]);

        setText(field(popup(dom)!, 'connector-name'), 'Acme Tools');
        setText(field(popup(dom)!, 'connector-url'), MCP_URL);
        setSelect(popup(dom)!.querySelector<HTMLSelectElement>('select[name="connector-auth"]')!, 'bearer');
        await until(() => popup(dom)!.querySelector('input[name="connector-secret"]') !== null, 'the token field');
        expect(field(popup(dom)!, 'connector-secret').type).toBe('password');

        // A wrong token: the test says so, and does not repeat what was typed.
        setText(field(popup(dom)!, 'connector-secret'), 'wrong-token');
        buttonNamed(popup(dom)!, 'Test connection').click();
        await until(() => popup(dom)!.querySelector('[data-connector-probe="error"]') !== null, 'the failed test');
        expect(popup(dom)!.querySelector('[data-connector-probe="error"]')!.textContent).not.toContain('wrong-token');

        setText(field(popup(dom)!, 'connector-secret'), TOKEN);
        // A test of other values says nothing about these.
        await until(() => popup(dom)!.querySelector('[data-connector-probe]') === null, 'the stale result to go');
        buttonNamed(popup(dom)!, 'Test connection').click();
        await until(() => popup(dom)!.querySelector('[data-connector-probe="ok"]') !== null, 'the passed test');
        expect(text(popup(dom)!.querySelector('[data-connector-probe="ok"]'))).toContain('2 tools');
        expect([...popup(dom)!.querySelectorAll('[data-connector-probe] [data-connector-tools] li')].map((li) => text(li))).toEqual(['acme-tools__echo', 'acme-tools__search']);

        buttonNamed(popup(dom)!, 'Add connector').click();
        await until(() => dom.querySelector('[data-connector="acme-tools"]') !== null && popup(dom) === null, 'the connector row');

        // Installed: enabled, its declared scopes granted, the record, the sealed credential, the test's result.
        const plugin = (await registry().get('acme-tools'))!;
        expect(plugin.enabled).toBe(true);
        expect([...plugin.grantedPermissions].sort()).toEqual(['network:mcp.acme.test', 'secret:acme-tools.token', 'tools:acme-tools']);
        const [record] = await registry().connectors();
        expect(record).toMatchObject({ id: 'acme-tools', pluginId: 'acme-tools', transport: 'streamable-http', url: MCP_URL, secrets: ['acme-tools.token'], auth: { bearer: 'acme-tools.token' }, status: { state: 'ok' } });
        expect(record!.tools).toEqual(['acme-tools__echo', 'acme-tools__search']);
        expect((await registry().secrets()).map((s) => s.name)).toContain('acme-tools.token');
        expect(await registry().openSecret('acme-tools.token', 'acme-tools')).toBe(TOKEN);

        // The row shows it, and the plugins menu counts it; the token shows nowhere.
        const row = () => dom.querySelector<HTMLElement>('[data-connector="acme-tools"]')!;
        await until(() => row().querySelectorAll('[data-connector-tools] li').length === 2, 'the tools on the row');
        expect(text(row())).toContain('2 tools');
        await until(() => dom.querySelector('[data-plugins-menu] [data-category="connector"] [data-count]')?.textContent === '1', 'the menu to count the connector');
        expect(dom.innerHTML).not.toContain(TOKEN);
        expect(JSON.stringify(await h.app.as(owner).actor(AuditActor, auditKey(WS)).list())).not.toContain(TOKEN);

        // The agent form offers it; Ada picks it.
        const config = (await h.app.as(owner).actor(AgentActor, agentKey(WS, ada)).get()).config;
        expect(agentCatalog(config, await registry().connectors()).connectors).toContainEqual({ value: 'acme-tools', label: 'acme-tools (streamable-http)' });
        await h.app.as(owner).actor(AgentActor, agentKey(WS, ada)).update({ connectors: [{ id: 'acme-tools' }] }, 'pick acme');

        // Remove: refused while Ada picks it — the dialog names her; nothing is removed until confirmed.
        buttonNamed(row(), 'Remove').click();
        await until(() => popup(dom) !== null, 'the in-use dialog');
        expect(popup(dom)!.textContent).toContain('Remove acme-tools?');
        expect([...popup(dom)!.querySelectorAll('[data-confirm-dependents] li')].map((li) => text(li))).toEqual(['Ada — connector']);
        expect(await registry().get('acme-tools')).not.toBeNull();

        buttonNamed(popup(dom)!, 'Remove acme-tools anyway').click();
        await until(() => dom.querySelector('[data-connector="acme-tools"]') === null, 'the row to go');
        expect(await registry().get('acme-tools')).toBeNull();
        expect(await registry().connectors()).toEqual([]);
        expect((await registry().secrets()).map((s) => s.name)).not.toContain('acme-tools.token');
    }, 30_000);
});
