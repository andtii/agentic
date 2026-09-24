/**
 * The Connectors view, `/plugins?kind=connector` (#638; PLG-03, OPS-04),
 * board `PluginsConnectors`: only the connectors the workspace has, each with
 * its account or endpoint line, transport, readiness with an inline Sign in,
 * dependents, switch and link; the chips count and filter them; Remove goes
 * through the `plugin-in-use` confirm. The model, the mock page and the
 * platform page over the real wire.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginReadiness, WorkspaceId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { AgentActor, agentKey, ConnectorAccounts, connectorAccountsKey, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, type ConnectorAccountSummary, type ConnectorRecord, type StoredAccount } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { connectorAccounts, connectorPlugins, connectorRecords } from '../../src/mock/plugins-connectors';
import { opsPlugins } from '../../src/mock/ops';
import { addConnector, type ConnectorDraft, type ConnectorProbe } from '../../src/pages/plugins/connector';
import { connectorChips, connectorLine, connectorRows, connectorTransport, endpointOf, filterConnectorRows, mcpCredentialOf, mcpSignInDraft } from '../../src/pages/plugins/connectors-model';
import { ConnectorsList } from '../../src/pages/plugins/ConnectorsView';
import { LiveConnectorsView } from '../../src/pages/plugins/LiveConnectorsView';
import { buttonNamed, mountAt, setText, text, tick } from './helpers';
import { mountRoute } from './mount';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const READY: PluginReadiness = { status: 'ready' };
const SIGNED_OUT: PluginReadiness = { status: 'needs-sign-in', missing: [] };
const rec = (r: Partial<ConnectorRecord> & Pick<ConnectorRecord, 'id' | 'transport'>): ConnectorRecord => ({ pluginId: r.id, tools: [], status: { state: 'ok' }, updatedAt: 0, ...r });

describe('connectors model (#638)', () => {
    it('tags the transport: conduit, mcp, mcp stdio', () => {
        expect(connectorTransport({ transport: 'conduit' })).toBe('conduit');
        expect(connectorTransport({ transport: 'streamable-http' })).toBe('mcp');
        expect(connectorTransport({ transport: 'stdio' })).toBe('mcp stdio');
    });

    it('says who a connector is signed in as, where it is and what its last check said', () => {
        const account: ConnectorAccountSummary = { id: 'a1', connector: 'gmail', method: 'oauth', status: 'active', displayName: 'Google account', createdAt: Date.parse('2026-09-12T10:00:00Z'), updatedAt: 0 };
        const gmail = rec({ id: 'gmail', transport: 'conduit', connector: 'gmail', account: 'a1' });
        expect(connectorLine(gmail, [account])).toBe('Google account · connected 12 Sep');
        expect(connectorLine(gmail, [{ ...account, status: 'needsReauth' }])).toBe('Google account · sign-in expired');
        expect(connectorLine(gmail, [])).toBe('account gone');
        expect(connectorLine(rec({ id: 'linear', transport: 'streamable-http', url: 'https://mcp.linear.app/', status: { state: 'error', error: 'initialize failed with HTTP 401' } }), [])).toBe('mcp.linear.app · token expired');
        expect(connectorLine(rec({ id: 'x', transport: 'streamable-http', url: 'https://x.test/mcp', status: { state: 'error', error: 'HTTP 500' } }), [])).toBe('x.test/mcp · check failed');
        expect(connectorLine(rec({ id: 'gh', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp', tools: Array.from({ length: 38 }, (_, i) => `gh__t${i}`) }), [])).toBe('api.githubcopilot.com/mcp · 38 tools');
        expect(connectorLine(rec({ id: 'gh', transport: 'streamable-http', url: 'https://a.test/mcp', status: { state: 'unknown' } }), [])).toBe('a.test/mcp · not checked yet');
        expect(connectorLine(rec({ id: 'fs', transport: 'stdio', command: 'npx', machine: 'alien01' }), [])).toBe('alien01 · runs on the daemon');
        expect(endpointOf('http://localhost:3000/mcp/')).toBe('localhost:3000/mcp');
    });

    it('lists only connected connectors, and what Sign in does when the sign-in lapsed', () => {
        const readiness: Record<string, PluginReadiness> = { gmail: SIGNED_OUT, github: READY, linear: SIGNED_OUT, filesystem: READY };
        const unconnected = connectorRecords.map((r) => (r.id === 'gmail' ? { ...r, account: undefined } : r));
        // A runtime plugin and a conduit connector nobody connected are not rows.
        const rows = connectorRows([...opsPlugins.filter((p) => p.manifest.kind === 'runtime'), ...connectorPlugins], unconnected, connectorAccounts, readiness);
        expect(rows.map((r) => r.id)).toEqual(['github', 'linear', 'filesystem']);

        const all = connectorRows(connectorPlugins, connectorRecords, connectorAccounts, readiness);
        expect(all.map((r) => [r.id, r.transport])).toEqual([['gmail', 'conduit'], ['github', 'mcp'], ['linear', 'mcp'], ['filesystem', 'mcp stdio']]);
        expect(all.find((r) => r.id === 'gmail')!.signIn).toEqual({ kind: 'conduit', href: '/_agentic/connectors/gmail/start' });
        expect(all.find((r) => r.id === 'linear')!.signIn).toEqual({ kind: 'mcp' });
        expect(all.find((r) => r.id === 'github')!.signIn).toBeUndefined();
    });

    it('counts the chips and filters by chip and query', () => {
        const rows = connectorRows(connectorPlugins, connectorRecords, connectorAccounts, { gmail: READY, github: READY, linear: SIGNED_OUT, filesystem: READY });
        expect(connectorChips(rows).map((c) => [c.label, c.count])).toEqual([['All', 4], ['Ready', 3], ['Needs sign-in', 1]]);
        expect(filterConnectorRows(rows, 'needs-sign-in', '').map((r) => r.id)).toEqual(['linear']);
        expect(filterConnectorRows(rows, 'ready', '').map((r) => r.id)).toEqual(['gmail', 'github', 'filesystem']);
        expect(filterConnectorRows(rows, 'all', 'STDIO').map((r) => r.id)).toEqual(['filesystem']);
        expect(filterConnectorRows(rows, 'all', 'githubcopilot').map((r) => r.id)).toEqual(['github']);
        expect(filterConnectorRows(rows, 'ready', 'linear')).toEqual([]);
    });

    it('re-checks an MCP server with its own URL and auth and the credential just typed', () => {
        expect(mcpCredentialOf({ auth: { bearer: 'linear.token' } })).toEqual({ auth: 'bearer', secret: 'linear.token' });
        expect(mcpCredentialOf({ auth: { headers: { 'X-Api-Key': 'k.token' } } })).toEqual({ auth: 'header', header: 'X-Api-Key', secret: 'k.token' });
        expect(mcpCredentialOf({ secrets: ['old.token'] })).toEqual({ auth: 'bearer', secret: 'old.token' });
        expect(mcpCredentialOf({})).toEqual({ auth: 'none' });
        // A stdio server binding a host and a token: sign in replaces the token, not the host.
        expect(mcpCredentialOf({ auth: { env: { GH_HOST: 'gh.host', GH_TOKEN: 'gh.token' } } })).toEqual({ auth: 'bearer', secret: 'gh.token' });
        expect(mcpCredentialOf({ auth: { env: { ONLY: 'only.value' } } })).toEqual({ auth: 'bearer', secret: 'only.value' });
        expect(mcpSignInDraft({ id: 'linear', url: 'https://mcp.linear.app', auth: { bearer: 'linear.token' } }, 'tok')).toEqual({ name: 'linear', url: 'https://mcp.linear.app', auth: 'bearer', header: '', secret: 'tok' });
    });
});

const rowOf = (root: ParentNode, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-connector-item="${id}"]`)!;
const ids = (root: ParentNode): string[] => [...root.querySelectorAll('[data-connector-item]')].map((li) => li.getAttribute('data-connector-item')!);
const readinessOf = (row: ParentNode): string | null => row.querySelector('[data-plugin-row]')?.getAttribute('data-readiness') ?? null;
const chip = (root: ParentNode, id: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>(`[data-connector-chips] [data-chip="${id}"]`)!;
/** The open dialog: zero portals it out of the mounted root. */
const popup = (_root?: ParentNode) => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');

describe('/plugins?kind=connector (#638, mock)', () => {
    it('draws the board: the connected connectors with their line, transport, readiness, dependents, switch and link', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        expect(ids(root)).toEqual(['gmail', 'github', 'linear', 'filesystem']);
        expect(text(root.querySelector('[data-connectors-label] [data-scope="ag-label"], [data-connectors-label] > :first-child'))).toBe('Connected · 4');
        expect(text(root.querySelector('[data-connectors-note]'))).toBe('Each connector signs in once; agents only get it when you add it to their tools');
        expect(root.querySelector('[data-search-field] input')!.getAttribute('placeholder')).toBe('Filter your connectors');
        const add = [...root.querySelectorAll<HTMLAnchorElement>('[data-page-actions] a')].find((a) => text(a) === 'Add connector')!;
        expect(add.getAttribute('href')).toBe('/plugins/connectors/add');
        expect(add.getAttribute('data-intent')).toBe('primary');

        const github = rowOf(root, 'github');
        const row = github.querySelector('[data-plugin-row]')!;
        expect(row.getAttribute('data-plugin-row')).toBe('connector');
        expect(row.getAttribute('href')).toBe('/plugins/github');
        expect(text(row.querySelector('[data-plugin-row-part="description"]'))).toBe('api.githubcopilot.com/mcp · 38 tools');
        expect(text(row.querySelector('[data-plugin-row-part="kind"]'))).toBe('mcp');
        expect(readinessOf(github)).toBe('ready');
        expect(github.querySelectorAll('[data-connector-deps] [data-scope="ag-agent-tile"][data-part="root"]').length).toBe(1);
        expect(github.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);

        expect(text(rowOf(root, 'gmail').querySelector('[data-plugin-row-part="description"]'))).toBe('you@example.com · connected 20 Sep');
        expect(text(rowOf(root, 'gmail').querySelector('[data-plugin-row-part="kind"]'))).toBe('conduit');
        expect(text(rowOf(root, 'filesystem').querySelector('[data-plugin-row-part="description"]'))).toBe('alien01 · runs on the daemon');
        expect(text(rowOf(root, 'filesystem').querySelector('[data-plugin-row-part="kind"]'))).toBe('mcp stdio');
        expect(text(rowOf(root, 'linear').querySelector('[data-connector-deps]'))).toBe('No dependents');
    });

    it('an expired Linear connector shows NEEDS SIGN-IN with an inline Sign in; the Needs sign-in chip filters to it', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        const linear = rowOf(root, 'linear');
        expect(readinessOf(linear)).toBe('needs-sign-in');
        expect(text(linear.querySelector('[data-plugin-row-part="readiness"] [data-readiness]'))).toBe('NEEDS SIGN-IN');
        expect(text(linear.querySelector('[data-plugin-row-part="description"]'))).toBe('mcp.linear.app · token expired');
        const signIn = linear.querySelector<HTMLButtonElement>('[data-plugin-row-part="fix"] button')!;
        expect(text(signIn)).toBe('Sign in');
        expect(signIn.getAttribute('data-intent')).toBe('wait');
        // Only the one that needs it offers Sign in.
        expect(root.querySelectorAll('[data-plugin-row-part="fix"] button').length).toBe(1);

        expect([...root.querySelectorAll('[data-connector-chips] [data-filter-chip]')].map((c) => text(c))).toEqual(['All 4', 'Ready 3', 'Needs sign-in 1']);
        chip(root, 'needs-sign-in').click();
        await tick();
        expect(chip(root, 'needs-sign-in').getAttribute('aria-pressed')).toBe('true');
        expect(ids(root)).toEqual(['linear']);
        chip(root, 'ready').click();
        await tick();
        expect(ids(root)).toEqual(['gmail', 'github', 'filesystem']);
        chip(root, 'all').click();
        await tick();
        expect(ids(root)).toHaveLength(4);
    });

    it('the filter box matches the name, the line and the transport', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        setText(root.querySelector<HTMLInputElement>('[data-search-field] input')!, 'stdio');
        await tick();
        expect(ids(root)).toEqual(['filesystem']);
        setText(root.querySelector<HTMLInputElement>('[data-search-field] input')!, 'nothing like it');
        await tick();
        expect(ids(root)).toEqual([]);
        expect(text(root.querySelector('[data-plugin-connectors] [data-plugin-none]'))).toContain('No connector matches');
    });

    it('Sign in on an MCP connector opens the MCP sign-in form; saved, the row reads READY', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        // The button sits inside the row's link: its click must not follow the link too.
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        rowOf(root, 'linear').querySelector<HTMLButtonElement>('[data-plugin-row-part="fix"] button')!.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        await tick();
        const form = popup(root)!;
        expect(text(form)).toContain('Sign in to Linear');
        const field = form.querySelector<HTMLInputElement>('input[name="connector-secret"]')!;
        expect(field.type).toBe('password');
        setText(field, 'lin_api_new');
        form.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(readinessOf(rowOf(root, 'linear'))).toBe('ready');
        expect(text(chip(root, 'needs-sign-in'))).toBe('Needs sign-in 0');
    });

    it('Remove confirms by name while an agent picks the connector, and removes one nobody picks at once', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        const removeButton = rowOf(root, 'github').querySelector<HTMLButtonElement>('[data-connector-remove] button')!;
        expect(removeButton.getAttribute('aria-label')).toBe('Remove GitHub');
        removeButton.click();
        await tick();
        const dialog = popup(root)!;
        expect(text(dialog)).toContain('Remove GitHub?');
        expect(text(dialog)).toContain('Forge — connector');
        expect(ids(root)).toContain('github');
        buttonNamed(dialog, 'Remove GitHub anyway').click();
        await tick();
        expect(ids(root)).not.toContain('github');

        rowOf(root, 'linear').querySelector<HTMLButtonElement>('[data-connector-remove] button')!.click();
        await tick();
        expect(ids(root)).toEqual(['gmail', 'filesystem']);
    });

    it('offers no Remove on a connector that ships with the build (Gmail): the Registry would refuse it', async () => {
        const root = await mountRoute('/plugins?kind=connector');
        expect(rowOf(root, 'gmail').querySelector('[data-connector-remove]')).toBeNull();
        expect(rowOf(root, 'github').querySelector('[data-connector-remove]')).not.toBeNull();
    });

    it('with no connectors, the empty state points at Add connector', async () => {
        const root = await mountAt('/plugins?kind=connector', <ConnectorsList rows={[]} dependents={{}} agentOf={(id: string) => ({ name: id })} toggle={() => <span />} />);
        const empty = root.querySelector('[data-plugin-connectors] [data-empty]')!;
        expect(text(empty)).toContain('No connectors yet');
        const add = [...empty.querySelectorAll('a')].find((a) => text(a) === 'Add connector')!;
        expect(add.getAttribute('href')).toBe('/plugins/connectors/add');
        // The MCP form is offered only where the page can run it.
        expect([...empty.querySelectorAll('button')].some((b) => text(b) === 'Add MCP server')).toBe(false);
        expect(root.querySelector('[data-connector-rows]')).toBeNull();
    });
});

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [...RUNTIME_PLUGINS, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });

describe('/plugins?kind=connector (#638, live)', () => {
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Registry, ConnectorAccounts] });
    });
    afterEach(async () => {
        await h.stop();
    });
    const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
    const accounts = () => h.app.as(owner).actor(ConnectorAccounts, connectorAccountsKey(WS as WorkspaceId));
    const draft = (name: string): ConnectorDraft => ({ name, url: 'https://mcp.linear.test/mcp', auth: 'bearer', header: '', secret: 'old-token' });

    it('an MCP server whose token was refused reads NEEDS SIGN-IN; Sign in seals the new token, checks it and reads READY', async () => {
        await addConnector(registry(), draft('Linear'), { ok: false, error: 'initialize failed with HTTP 401' });
        const probes: ConnectorDraft[] = [];
        const probe = async (d: ConnectorDraft): Promise<ConnectorProbe> => {
            probes.push(d);
            return d.secret === 'new-token' ? { ok: true, tools: ['linear__list_issues', 'linear__create_issue'] } : { ok: false, error: 'initialize failed with HTTP 401' };
        };
        const dom = await mountLive('/plugins?kind=connector', h, <LiveConnectorsView probe={probe} />);
        const row = () => rowOf(dom, 'linear');
        await until(() => !!row() && readinessOf(row()) === 'needs-sign-in', 'the signed-out row');
        expect(text(row().querySelector('[data-plugin-row-part="description"]'))).toBe('mcp.linear.test/mcp · token expired');
        expect(text(chip(dom, 'needs-sign-in'))).toBe('Needs sign-in 1');

        buttonNamed(row(), 'Sign in').click();
        await until(() => popup(dom) !== null, 'the sign-in form');
        setText(popup(dom)!.querySelector<HTMLInputElement>('input[name="connector-secret"]')!, 'new-token');
        popup(dom)!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => readinessOf(row()) === 'ready', 'the row to read READY');
        expect(probes.at(-1)).toEqual({ name: 'linear', url: 'https://mcp.linear.test/mcp', auth: 'bearer', header: '', secret: 'new-token' });
        expect(await registry().openSecret('linear.token', 'linear')).toBe('new-token');
        expect((await registry().connectors())[0]).toMatchObject({ status: { state: 'ok' }, tools: ['linear__list_issues', 'linear__create_issue'] });
        expect(text(row().querySelector('[data-plugin-row-part="description"]'))).toBe('mcp.linear.test/mcp · 2 tools');
        expect(dom.innerHTML).not.toContain('new-token');
    }, 20_000);

    it('Sign in on a conduit connector goes to its sign-in route', async () => {
        await registry().enable('gmail');
        await registry().setSecret('gmail-client-id', 'cid');
        await registry().setSecret('gmail-client-secret', 'cs');
        const account: StoredAccount = { id: 'acct_1', owner: WS, connector: 'gmail', method: 'oauth', status: 'needsReauth', credentials: 'sealed.NOT-A-TOKEN', displayName: 'owner@example.com', version: 1, createdAt: 1, updatedAt: 1 };
        await accounts().createAccount(account);
        await registry().putConnector({ id: 'gmail', pluginId: 'gmail', transport: 'conduit', connector: 'gmail', account: 'acct_1' });
        const went: string[] = [];
        const dom = await mountLive('/plugins?kind=connector', h, <LiveConnectorsView navigate={(href: string) => went.push(href)} />);
        await until(() => !!rowOf(dom, 'gmail') && readinessOf(rowOf(dom, 'gmail')) === 'needs-sign-in', 'the signed-out Gmail row');
        expect(text(rowOf(dom, 'gmail').querySelector('[data-plugin-row-part="description"]'))).toBe('owner@example.com · sign-in expired');
        buttonNamed(rowOf(dom, 'gmail'), 'Sign in').click();
        expect(went).toEqual(['/_agentic/connectors/gmail/start']);
        // Gmail ships with the build: Registry.remove refuses it (`builtin`), so the row offers no Remove.
        expect(rowOf(dom, 'gmail').querySelector('[data-connector-remove]')).toBeNull();
    }, 20_000);

    it('Remove refuses while an agent picks it, names the agent, and removes on confirm — credential included', async () => {
        await addConnector(registry(), draft('Acme'), { ok: true, tools: ['acme__echo'] });
        const ada = await h.agent('Ada');
        await h.app.as(owner).actor(AgentActor, agentKey(WS, ada)).update({ connectors: [{ id: 'acme' }] }, 'pick acme');
        const dom = await mountLive('/plugins?kind=connector', h, <LiveConnectorsView />);
        await until(() => !!rowOf(dom, 'acme') && readinessOf(rowOf(dom, 'acme')) === 'ready', 'the row');
        await until(() => rowOf(dom, 'acme').querySelectorAll('[data-connector-deps] [data-scope="ag-agent-tile"][data-part="root"]').length === 1, 'its dependent');

        rowOf(dom, 'acme').querySelector<HTMLButtonElement>('[data-connector-remove] button')!.click();
        await until(() => popup(dom) !== null, 'the in-use dialog');
        expect(text(popup(dom))).toContain('Remove Acme?');
        expect([...popup(dom)!.querySelectorAll('[data-confirm-dependents] li')].map((li) => text(li))).toEqual(['Ada — connector']);
        expect(await registry().get('acme')).not.toBeNull();

        buttonNamed(popup(dom)!, 'Remove Acme anyway').click();
        await until(() => dom.querySelector('[data-connector-item="acme"]') === null, 'the row to go');
        expect(await registry().get('acme')).toBeNull();
        expect((await registry().secrets()).map((s) => s.name)).not.toContain('acme.token');
    }, 20_000);

    it('with none added, the empty state points at Add connector and offers the MCP form', async () => {
        const dom = await mountLive('/plugins?kind=connector', h);
        await until(() => dom.querySelector('[data-plugin-connectors] [data-empty]') !== null, 'the empty state');
        const empty = dom.querySelector('[data-plugin-connectors] [data-empty]')!;
        expect([...empty.querySelectorAll('a')].find((a) => text(a) === 'Add connector')!.getAttribute('href')).toBe('/plugins/connectors/add');
        buttonNamed(empty, 'Add MCP server').click();
        await until(() => popup(dom) !== null && text(popup(dom)).includes('Add MCP server'), 'the MCP form');
    }, 20_000);
});
