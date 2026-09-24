/**
 * `/plugins` on mock data (#90, #233): the catalogue by kind and the
 * dependents dialog behind a switch. Moved out of `ops.test.tsx` (#628) so
 * the plugins redesign's page issues own their own test file.
 */
import { PluginsView } from '../../src/pages/Plugins';
import { LAST_RUNTIME_WARNING, workspaceWideConsequence } from '../../src/pages/plugins/model';
import { opsPlugins } from '../../src/mock/ops';
import { buttonNamed, mountAt, tick } from './helpers';

describe('/plugins', () => {
    const card = (root: ParentNode, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-scope="ag-plugin-card"][data-part="root"][data-plugin="${id}"]`)!;
    const readinessOf = (el: ParentNode): string | null => el.querySelector('[data-readiness]')?.getAttribute('data-readiness') ?? null;

    it('renders a card per plugin by kind, with readiness, granted scopes, dependents and the link to its page', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        expect(root.querySelectorAll('[data-scope="ag-plugin-card"][data-part="root"]').length).toBe(opsPlugins.length);
        // The mock project feature (#333) groups under its own kind.
        expect([...root.querySelectorAll('[data-plugin-group]')].map(g => g.getAttribute('data-plugin-group'))).toEqual(['runtime:harness', 'runtime:model', 'connector', 'memory', 'learning', 'a2a', 'project-feature']);

        const claude = card(root, 'claude-code');
        expect(claude.getAttribute('aria-label')).toBe('Claude Code');
        // Runtimes by what they are (#313): the harness reports usage limits; the model runtime is labelled as one.
        expect([...claude.querySelectorAll('[data-part="tags"] [data-scope="ag-pill"] [data-part="label"]')].map(t => t.textContent)).toEqual(expect.arrayContaining(['harness runtime', 'usage limits']));
        expect(card(root, 'anthropic-api').querySelector('[data-part="tags"]')!.textContent).toContain('model runtime');
        expect(root.querySelector('[data-plugin-group="runtime:harness"] [data-plugin-group-note]')!.textContent).toContain('CLI or SDK');
        expect(claude.querySelector('[data-plugin-granted]')!.textContent).toContain('machine:*');
        expect(claude.querySelectorAll('[data-plugin-used] [data-scope="ag-agent-tile"][data-part="root"]').length).toBe(2);
        expect(claude.querySelector('[data-plugin-schedules]')!.textContent).toBe('1 schedule');
        // The mock workspace has a claude-code environment; its Anthropic key is not set yet.
        expect(readinessOf(claude)).toBe('ready');
        expect(readinessOf(card(root, 'anthropic-api'))).toBe('needs-secret');
        expect(card(root, 'anthropic-api').querySelector('a')!.getAttribute('href')).toBe('/plugins/anthropic-api');

        // The active memory plugin: used by everyone, nobody singled out.
        const memory = card(root, 'agentic.memory.default');
        expect(memory.hasAttribute('data-mod-selected')).toBe(true);
        expect(memory.querySelector('[data-workspace-wide]')!.textContent).toBe('Used by every agent');
        expect(card(root, 'agentic.memory.flat').hasAttribute('data-mod-selected')).toBe(false);

        const a2a = card(root, 'a2a');
        expect(a2a.textContent).toContain('No dependents');
        expect(readinessOf(a2a)).toBe('disabled');
        expect(a2a.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
    });

    it('turning off a plugin with dependents opens the dialog listing them; the switch holds until confirmed', async () => {
        // Without the other harnesses, so Claude Code is the last ready runtime.
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins.filter((p) => p.manifest.id !== 'copilot-cli' && p.manifest.id !== 'codex-cli')} />);
        const claude = card(root, 'claude-code');
        const control = () => claude.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(control().checked).toBe(true);
        control().click();
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.getAttribute('role')).toBe('alertdialog');
        expect(popup.textContent).toContain('Disable Claude Code?');
        expect(popup.textContent).toContain('Depends on it · 3');
        for (const name of ['Forge — runtime', 'Lint — runtime', 'Nightly dependency audit — schedule via Lint']) expect(popup.textContent).toContain(name);
        // It is the only runtime that is ready (the Anthropic key is not set): the dialog says so.
        expect(popup.textContent).toContain(LAST_RUNTIME_WARNING);
        const confirm = buttonNamed(popup, 'Disable Claude Code');
        // Still on while the dialog is open.
        expect(control().checked).toBe(true);
        confirm.click();
        await tick();
        expect(control().checked).toBe(false);
        expect(readinessOf(claude)).toBe('disabled');
    });

    it('the active memory plugin states the workspace-wide consequence instead of a list', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        card(root, 'agentic.memory.default').querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await tick();
        const popup = root.querySelector('[data-scope="dialog"][data-part="popup"]')!;
        expect(popup.textContent).toContain(workspaceWideConsequence('memory'));
        expect(popup.querySelector('[data-confirm-dependents]')).toBeNull();
    });

    it('a plugin nobody depends on switches without a dialog', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={opsPlugins} />);
        const control = card(root, 'a2a').querySelector<HTMLInputElement>('input[role="switch"]')!;
        control.click();
        await tick();
        expect(root.querySelector('[data-scope="dialog"][data-part="popup"]')).toBeNull();
        expect(card(root, 'a2a').querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    });
});
