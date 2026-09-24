/**
 * `/plugins/:id` on mock data (#233): the plugin page's settings, permissions,
 * write-only keys, Make active and Remove. Moved out of `ops.test.tsx` (#628)
 * so the plugins redesign's page issues own their own test file.
 */
import { PluginPageView } from '../../src/pages/Plugin';
import { opsPluginDependents, opsPlugins } from '../../src/mock/ops';
import { buttonNamed, mountAt, setText, tick } from './helpers';
import { mountRoute, texts } from './mount';

describe('/plugins/:id', () => {
    const plugin = (id: string) => opsPlugins.find(p => p.manifest.id === id)!;
    const dependents = (id: string) => opsPluginDependents.find(d => d.pluginId === id);
    const secretInput = (root: ParentNode, name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-secret="${name}"] input`)!;

    it('the route renders the plugin, and an unknown id says so', async () => {
        const root = await mountRoute('/plugins/agentic.memory.default');
        expect(root.querySelector('[data-plugin-detail]')!.getAttribute('data-plugin')).toBe('agentic.memory.default');
        expect(root.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        expect(root.querySelector('[data-plugin-panel="config"]')!.textContent).toContain('Nothing to configure.');
        // Built in: no Remove.
        expect(root.querySelector('[data-plugin-action="remove"]')).toBeNull();

        const missing = await mountRoute('/plugins/nope');
        expect(missing.textContent).toContain('No plugin with id nope');
    });

    it('settings on the schema form, permissions with their reasons, and a key that is write-only', async () => {
        const root = await mountAt('/plugins/anthropic-api', <PluginPageView plugin={plugin('anthropic-api')} dependents={dependents('anthropic-api')} />);
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
        buttonNamed(row, 'Revoke').click();
        await tick();
        expect(root.querySelector('[data-readiness]')!.getAttribute('data-readiness')).toBe('needs-grant');
    });

    it('a memory plugin that is not the active one can be made active; a connector can be removed', async () => {
        const flat = await mountAt('/plugins/agentic.memory.flat', <PluginPageView plugin={plugin('agentic.memory.flat')} dependents={dependents('agentic.memory.flat')} />);
        buttonNamed(flat, 'Make active').click();
        await tick();
        expect(flat.querySelector('[data-plugin-action="activate"]')!.textContent).toContain('This is the memory plugin the workspace runs.');
        expect(flat.querySelector('[data-plugin-action="activate"] button')).toBeNull();

        const github = await mountAt('/plugins/github-mcp', <PluginPageView plugin={plugin('github-mcp')} dependents={dependents('github-mcp')} />);
        expect(buttonNamed(github, 'Remove')).not.toBeNull();
        expect(github.querySelector('[data-secret="github-token"]')!.hasAttribute('data-set')).toBe(true);
    });
});
