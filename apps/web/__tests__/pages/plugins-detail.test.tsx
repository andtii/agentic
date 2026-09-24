/**
 * `/plugins/:id` on mock data (#233, #640), board `PluginDetail`: the header,
 * Account (a conduit connector's sign-in, an MCP connector's endpoint), the
 * Tools with allow / ask / deny, Granted with Revoke and Grant (a `tools:`
 * revoke asks first), settings and write-only keys, Make active, and the rail
 * — Used by, then Remove with its consequence and every dependent before the
 * button. The topbar trail names the plugin.
 */
import { PluginPageView } from '../../src/pages/Plugin';
import { opsPluginDependents, opsPlugins } from '../../src/mock/ops';
import { withMockTools } from '../../src/mock/plugins-detail';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import { buttonNamed, mountAt, setText, text, tick } from './helpers';
import { mountRoute, texts } from './mount';

const plugin = (id: string) => withMockTools(opsPlugins.find(p => p.manifest.id === id)!);
const dependents = (id: string) => opsPluginDependents.find(d => d.pluginId === id);
const secretInput = (root: ParentNode, name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-secret="${name}"] input`)!;
const view = (id: string) => mountAt(`/plugins/${id}`, <PluginPageView plugin={plugin(id)} dependents={dependents(id)} />);
const granted = (root: ParentNode) => [...root.querySelectorAll('#granted [data-permission][data-granted]')].map((li) => li.getAttribute('data-permission'));
const declared = (root: ParentNode) => [...root.querySelectorAll('#granted [data-permission]:not([data-granted])')].map((li) => li.getAttribute('data-permission'));
const pressed = (root: ParentNode, tool: string) => root.querySelector(`[data-tool-policy="${tool}"] [aria-pressed="true"]`)?.textContent ?? null;
const popup = (root: ParentNode) => root.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"]');

describe('/plugins/:id', () => {
    it('the route renders the plugin, and an unknown id says so', async () => {
        const root = await mountRoute('/plugins/agentic.memory.default');
        expect(root.querySelector('[data-plugin-detail]')!.getAttribute('data-plugin')).toBe('agentic.memory.default');
        expect(root.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        // Nothing to set: no Settings panel, and no Account or Tools either.
        expect(root.querySelector('#config')).toBeNull();
        expect(root.querySelector('#account')).toBeNull();
        expect(root.querySelector('#tools')).toBeNull();
        // Built in: no Remove button, and the card says why.
        expect(root.querySelector('[data-plugin-action="remove"]')).toBeNull();
        expect(text(root.querySelector('[data-plugin-panel="remove"]'))).toContain('ships with this deployment, so it cannot be removed');
        expect(text(root.querySelector('[data-plugin-panel="dependents"]'))).toContain('Every agent uses it');

        const missing = await mountRoute('/plugins/nope');
        expect(missing.textContent).toContain('No plugin with id nope');
    });

    it('the header: 52 px tile, name and version, kind and transport tags, the description, readiness and the switch', async () => {
        const root = await view('gmail');
        const head = root.querySelector('[data-plugin-detail-head]')!;
        expect(head.querySelector('[data-scope="ag-agent-tile"]')!.getAttribute('style')).toContain('--ag-tile: 52px');
        expect(text(head.querySelector('[data-plugin-detail-name] > span'))).toBe('Gmail');
        expect(text(head.querySelector('[data-plugin-detail-version]'))).toBe('1.0.0');
        expect(texts([...head.querySelectorAll('[data-plugin-detail-tags] [data-scope="ag-pill"][data-part="label"]')]).slice(0, 2)).toEqual(['connector', 'conduit']);
        expect(text(head.querySelector('[data-plugin-detail-description]'))).toBe('Search, read, draft and send email in a Gmail account.');
        expect(head.querySelector('[data-plugin-detail-status] [data-readiness]')!.getAttribute('data-readiness')).toBe('ready');
        expect(head.querySelector('[data-plugin-detail-status] input[role="switch"]')).not.toBeNull();
        // Every section a link can land on.
        for (const anchor of ['account', 'tools', 'granted', 'secrets']) expect(root.querySelector(`#${anchor}`), anchor).not.toBeNull();
    });

    it('Account: signed in as whom and since when, the OAuth client, Reconnect and Sign out', async () => {
        const root = await view('gmail');
        const account = root.querySelector('#account')!;
        expect(text(account.querySelector('[data-connect-text]'))).toBe('you@example.com');
        expect(text(account.querySelector('[data-account-meta]'))).toBe('connected 20 Sep');
        expect(text(account.querySelector('[data-account-row="client"] dd'))).toBe('your own · stored as two secrets');
        buttonNamed(account, 'Sign out').click();
        await tick();
        expect(root.querySelector('#account')!.getAttribute('data-connection')).toBe('not-connected');
        buttonNamed(root.querySelector('#account')!, 'Connect').click();
        await tick();
        expect(buttonNamed(root.querySelector('#account')!, 'Reconnect')).not.toBeNull();
    });

    it('an MCP connector shows its endpoint and token secret, and the tools it reported', async () => {
        const root = await view('github-mcp');
        expect(text(root.querySelector('[data-plugin-detail-head] [data-part="monogram"]'))).toBe('GM');
        const tags = texts([...root.querySelectorAll('[data-plugin-detail-tags] [data-scope="ag-pill"][data-part="label"]')]);
        expect(tags.slice(0, 2)).toEqual(['connector', 'mcp']);
        expect(text(root.querySelector('#account [data-account-row="endpoint"] dd'))).toBe('https://api.github.com/mcp');
        expect(text(root.querySelector('#account [data-account-row="token"] dd'))).toBe('secret:github-tokenstored');
        expect([...root.querySelectorAll('#tools [data-tool-policy]')].map((r) => r.getAttribute('data-tool-policy'))).toEqual(['github-mcp__create_issue', 'github-mcp__create_pull_request', 'github-mcp__get_issue', 'github-mcp__list_issues', 'github-mcp__merge_pull_request']);
    });

    it('Tools: one row per tool at its mode, the workspace-default caption, and a change that sticks', async () => {
        const root = await view('gmail');
        const tools = root.querySelector('#tools')!;
        expect(text(tools.querySelector('[data-label]'))).toBe('Tools · 9');
        expect(text(tools.querySelector('[data-plugin-panel-caption]'))).toBe('workspace default; an agent’s own policy can only be stricter');
        expect(pressed(root, 'gmail__search-messages')).toBe('allow');
        expect(pressed(root, 'gmail__send-email')).toBe('ask');
        expect(text(tools.querySelector('[data-tool-policy="gmail__send-email"] [data-tool-policy-part="description"]'))).toBe('Send email');
        [...tools.querySelectorAll<HTMLButtonElement>('[data-tool-policy="gmail__send-email"] button')].find((b) => b.textContent === 'deny')!.click();
        await tick();
        expect(pressed(root, 'gmail__send-email')).toBe('deny');
    });

    it('Granted: each scope with its reason and Revoke, then the declared ones with Grant — a round trip', async () => {
        const root = await view('gmail');
        expect(granted(root)).toEqual(['secret:gmail-client-id', 'secret:gmail-client-secret', 'secret:connector-engine-secret', 'network:gmail.googleapis.com', 'network:oauth2.googleapis.com', 'tools:gmail']);
        expect(declared(root)).toEqual([]);
        expect(text(root.querySelector('[data-permission="network:gmail.googleapis.com"] [data-permission-reason]'))).toBe('Call gmail.googleapis.com');

        buttonNamed(root.querySelector('[data-permission="network:gmail.googleapis.com"]')!, 'Revoke').click();
        await tick();
        expect(granted(root)).not.toContain('network:gmail.googleapis.com');
        expect(declared(root)).toEqual(['network:gmail.googleapis.com']);
        expect(text(root.querySelector('#granted'))).toContain('Declared, not granted · 1');

        buttonNamed(root.querySelector('[data-permission="network:gmail.googleapis.com"]')!, 'Grant').click();
        await tick();
        expect(granted(root)).toContain('network:gmail.googleapis.com');
        expect(declared(root)).toEqual([]);
    });

    it('revoking tools:<ns> asks first, naming the tools agents lose', async () => {
        const root = await view('gmail');
        buttonNamed(root.querySelector('[data-permission="tools:gmail"]')!, 'Revoke').click();
        await tick();
        const dialog = popup(root)!;
        expect(dialog.getAttribute('role')).toBe('alertdialog');
        expect(dialog.textContent).toContain('Revoke tools:gmail?');
        expect(dialog.textContent).toContain('Agents lose these tools on their next session');
        expect(dialog.textContent).toContain('gmail__send-email');
        // Nothing changed while it asks; Keep granted leaves it.
        expect(granted(root)).toContain('tools:gmail');
        buttonNamed(dialog, 'Keep granted').click();
        await tick();
        expect(granted(root)).toContain('tools:gmail');

        buttonNamed(root.querySelector('[data-permission="tools:gmail"]')!, 'Revoke').click();
        await tick();
        buttonNamed(popup(root)!, 'Revoke tools:gmail').click();
        await tick();
        expect(declared(root)).toEqual(['tools:gmail']);
    });

    it('settings on the schema form, permissions with their reasons, and a key that is write-only', async () => {
        const root = await view('anthropic-api');
        expect(root.querySelector('#config')).not.toBeNull();
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('needs-secret');
        expect(root.querySelector<HTMLSelectElement>('select')!.value).toBe('claude-opus-5');
        const row = root.querySelector('[data-permission="secret:anthropic-api-key"]')!;
        expect(row.hasAttribute('data-granted')).toBe(true);
        expect(row.querySelector('[data-permission-reason]')!.textContent).toBe('Calls the Anthropic API with your key when a session starts, and once or twice per chat to title it.');
        expect(texts([...root.querySelectorAll('[data-dependent-via]')])).toEqual(['runtime', 'runtime', 'fallback']);

        // The field hydrates enabled; the value leaves through `save` once and the page keeps the NAME only.
        await tick();
        const SECRET = 'sk-ant-mock-0123456789';
        setText(secretInput(root, 'anthropic-api-key'), SECRET);
        await tick();
        root.querySelector<HTMLFormElement>('[data-secret="anthropic-api-key"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(root.querySelector('[data-secret="anthropic-api-key"]')!.hasAttribute('data-set')).toBe(true);
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('ready');
        expect(root.innerHTML).not.toContain(SECRET);
        expect(root.querySelector('[data-secret="anthropic-api-key"] input')).toBeNull();

        // Revoking the scope it declared takes it out of service again.
        buttonNamed(root.querySelector('[data-permission="secret:anthropic-api-key"]')!, 'Revoke').click();
        await tick();
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('needs-grant');
    });

    it('Used by: agent tiles and how they use it, with the connector note', async () => {
        const root = await view('gmail');
        const used = root.querySelector('[data-plugin-panel="dependents"]')!;
        expect(used.querySelector('[data-dependent="scout"] [data-scope="ag-agent-tile"]')).not.toBeNull();
        expect(text(used.querySelector('[data-dependent="scout"] [data-dependent-name] > span'))).toBe('Scout');
        expect(text(used.querySelector('[data-dependents-note]'))).toBe('Agents get a connector only when you add it to their tools.');
    });

    it('Remove states its consequences and lists every dependent before the button', async () => {
        const root = await view('github-mcp');
        const card = root.querySelector('[data-plugin-panel="remove"][data-plugin-action="remove"]')!;
        expect(text(card.querySelector('[data-plugin-consequence]'))).toBe('Removes GitHub (MCP), its settings, its tool policy and its connectors from the workspace. Forge still uses it and will point at nothing. Its stored secret is kept: delete it under Keys first if you want it gone.');
        const list = card.querySelector('[data-remove-dependents]')!;
        expect(texts([...list.querySelectorAll('li')])).toEqual(['Forge — connector, tool']);
        const button = buttonNamed(card, 'Remove GitHub (MCP)');
        expect(list.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('a memory plugin that is not the active one can be made active', async () => {
        const flat = await view('agentic.memory.flat');
        buttonNamed(flat, 'Make active').click();
        await tick();
        expect(flat.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        expect(flat.querySelector('[data-plugin-action="activate"] button')).toBeNull();
    });

    it('the crumb names the plugin: Plugins › Connectors › Gmail for a connector, Plugins › Memory otherwise', () => {
        const trail = (id: string) => {
            const route = { name: 'plugin', path: `/plugins/${id}`, params: { id } };
            return trailFor(route, topbarFor(route)).map((c) => c.label);
        };
        expect(trail('gmail')).toEqual(['Plugins', 'Connectors', 'Gmail']);
        expect(trail('agentic.memory.default')).toEqual(['Plugins', 'Memory']);
        expect(trail('nope')).toEqual(['Plugins', 'nope']);
    });
});
