/**
 * `/plugins` on mock data (#637, board `Plugins`): the category menu, search
 * and status chips round-tripping through the URL, the needs-attention box,
 * compact rows by group (memory and learning as pick-one radios, the
 * Connectors group truncated), and the switch's dependents confirm (AC-13).
 */
import { afterEach } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { createServerRouter } from '../../src/router';
import { PluginsView } from '../../src/pages/Plugins';
import { LAST_RUNTIME_WARNING } from '../../src/pages/plugins/model';
import { listPlugins } from '../../src/mock/plugins-list';
import { buttonNamed, mountAt, setText, text, tick } from './helpers';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** The real route table at `path`, with the router to read the URL back from. */
async function mountPlugins(path: string) {
    const router = createServerRouter(path);
    await router.isReady();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = defineApp(<RouterView />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(root);
    await tick();
    closers.push(() => {
        app.unmount();
        root.remove();
    });
    return { root, router };
}

const row = (root: ParentNode, id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-plugin-rows] [data-plugin-row][data-plugin="${id}"]`)!;
const rowIds = (root: ParentNode): string[] => [...root.querySelectorAll('[data-plugin-rows] [data-plugin-row]')].map((r) => r.getAttribute('data-plugin')!);
const switchOf = (el: ParentNode): HTMLInputElement => el.querySelector<HTMLInputElement>('input[role="switch"]')!;
const query = (router: { currentRoute: { query: Record<string, unknown> } }) => router.currentRoute.query;

describe('/plugins (#637)', () => {
    it('draws the menu, chips, needs attention and compact rows by group', async () => {
        const { root } = await mountPlugins('/plugins');
        const menu = root.querySelector('[data-plugins-menu] [data-category-menu]')!;
        expect(menu.querySelector('a[aria-current="page"]')!.getAttribute('data-category')).toBe('all');
        expect(text(menu.querySelector('[data-category="attention"] [data-count]'))).toBe('2');
        expect(menu.querySelector('[data-category="attention"] [data-count]')!.getAttribute('data-tone')).toBe('needs-you');
        expect(menu.querySelector('[data-category="remote"]')!.hasAttribute('data-empty')).toBe(true);

        expect([...root.querySelectorAll('[data-status-chip]')].map((c) => `${text(c.firstElementChild)} ${text(c.querySelector('[data-count]'))}`)).toEqual([`All ${listPlugins.length}`, `On ${listPlugins.length - 1}`, 'Off 1', 'Needs setup 2']);
        expect(root.querySelector('[data-page-actions] a[href="/plugins/connectors/add"]')!.textContent).toContain('Add connector');

        // Needs attention: each enabled plugin that is not ready, with its fix.
        const attention = root.querySelector('[data-plugin-attention]')!;
        expect(text(attention.querySelector('[data-plugin-attention-title]'))).toBe('2 enabled plugins can’t be used yet');
        expect([...attention.querySelectorAll('li')].map((li) => [li.getAttribute('data-plugin'), text(li.querySelector('[data-plugin-attention-text]')), [...li.querySelectorAll('a')].at(-1)!.getAttribute('href')])).toEqual([
            ['anthropic-api', 'needs the anthropic-api-key secret', '/plugins/anthropic-api#secrets'],
            ['linear', 'its sign-in expired', '/plugins/linear#account']
        ]);

        // Groups with a mono label and a note; runtimes split by what they are.
        expect([...root.querySelectorAll('[data-plugin-group]')].map((g) => g.getAttribute('data-plugin-group'))).toEqual(['runtime:harness', 'runtime:model', 'connector', 'memory', 'learning', 'a2a', 'project-feature']);
        expect(text(root.querySelector('[data-plugin-group="runtime:harness"] [data-plugin-group-note]'))).toContain('CLI or SDK');
        expect(text(root.querySelector('[data-plugin-group="memory"] [data-plugin-group-note]'))).toContain('fidelity report');

        const claude = row(root, 'claude-code');
        expect(claude.tagName).toBe('A');
        expect(claude.getAttribute('href')).toBe('/plugins/claude-code');
        expect(claude.getAttribute('data-readiness')).toBe('ready');
        expect(text(claude.querySelector('[data-plugin-row-part="kind"]'))).toBe('harness');
        expect(text(claude.querySelector('[data-plugin-row-part="title"]'))).toContain('usage limits');
        expect(claude.querySelectorAll('[data-plugin-used] [data-plugin-dependent]').length).toBe(2);
        expect(text(claude.querySelector('[data-plugin-schedules]'))).toBe('1 schedule');
        expect(row(root, 'anthropic-api').getAttribute('data-readiness')).toBe('needs-secret');
        expect(text(row(root, 'anthropic-api').querySelector('[data-plugin-row-part="readiness"]'))).toContain('NEEDS KEY');
        expect(text(row(root, 'a2a'))).toContain('No dependents');
        expect(switchOf(row(root, 'a2a')).checked).toBe(false);

        // Connectors: two, then the count and the way to the Connectors view.
        const connectors = root.querySelector('[data-plugin-group="connector"]')!;
        expect(connectors.querySelectorAll('[data-plugin-row]').length).toBe(2);
        expect(text(connectors.querySelector('[data-plugin-more]'))).toContain('+ 2 more connected');
        expect(connectors.querySelector('[data-plugin-more] a')!.getAttribute('href')).toBe('/plugins?kind=connector');
        expect(text(connectors.querySelector('[data-plugin-more] a'))).toBe('All connectors');
        expect(text(row(root, 'gmail').querySelector('[data-plugin-row-part="kind"]'))).toBe('conduit');

        // Memory and learning: pick one. The active one is marked, the other offers Make active and says what it drops.
        const memory = row(root, 'agentic.memory.default');
        expect(memory.getAttribute('data-plugin-row')).toBe('radio');
        expect(memory.hasAttribute('data-active')).toBe(true);
        expect(text(memory)).toContain('ACTIVE');
        const flat = row(root, 'agentic.memory.flat');
        expect(flat.hasAttribute('data-active')).toBe(false);
        expect(text(flat.querySelector('[data-plugin-row-part="consequence"]'))).toBe('switching into it drops conditions, evidence, superseding and expiry');
        expect(flat.querySelector('input[role="switch"]')).toBeNull();
        expect(row(root, 'agentic.learning.default').getAttribute('data-plugin-row')).toBe('radio');
    });

    it('`?kind=memory&q=flat` shows only Flat memory, and the search and chips write back to the URL', async () => {
        const { root, router } = await mountPlugins('/plugins?kind=memory&q=flat');
        expect(rowIds(root)).toEqual(['agentic.memory.flat']);
        expect(root.querySelector('[data-plugins-menu] a[aria-current="page"]')!.getAttribute('data-category')).toBe('memory');
        expect(root.querySelector<HTMLInputElement>('[data-search-field] input')!.value).toBe('flat');
        // The menu's links keep the search.
        expect(root.querySelector('[data-plugins-menu] [data-category="harness"]')!.getAttribute('href')).toBe('/plugins?kind=harness&q=flat');
        expect(root.querySelector('[data-plugin-attention]')).toBeNull();

        setText(root.querySelector<HTMLInputElement>('[data-search-field] input')!, '');
        await tick();
        await tick();
        expect(query(router).q).toBeUndefined();
        expect(query(router).kind).toBe('memory');
        expect(rowIds(root)).toEqual(['agentic.memory.default', 'agentic.memory.flat']);

        root.querySelector<HTMLButtonElement>('[data-status-chip="off"]')!.click();
        await tick();
        await tick();
        expect(query(router)).toMatchObject({ kind: 'memory', status: 'off' });
        expect(root.querySelector('[data-status-chip="off"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(text(root.querySelector('[data-plugin-empty]'))).toBe('No plugins match.');
    });

    it('the search follows the URL when history moves across `?kind=` (the view stays mounted)', async () => {
        const { root, router } = await mountPlugins('/plugins?kind=memory');
        const input = () => root.querySelector<HTMLInputElement>('[data-search-field] input')!;
        setText(input(), 'flat');
        await tick();
        await tick();
        expect(query(router)).toMatchObject({ kind: 'memory', q: 'flat' });
        await router.push('/plugins?kind=harness&q=flat');
        await tick();
        setText(input(), '');
        await tick();
        await tick();
        expect(query(router).q).toBeUndefined();

        // Back: the memory entry, whose search the input had replaced into it.
        router.back();
        for (let i = 0; i < 20 && query(router).kind !== 'memory'; i++) await tick();
        await tick();
        expect(query(router).q).toBe('flat');
        expect(input().value).toBe('flat');
        expect(rowIds(root)).toEqual(['agentic.memory.flat']);
    });

    it('a filter lists every matching connector; only the unfiltered All view truncates them', async () => {
        const connectors = listPlugins.filter((p) => p.manifest.kind === 'connector');
        const { root } = await mountPlugins('/plugins?status=on');
        const group = root.querySelector('[data-plugin-group="connector"]')!;
        expect(group.querySelectorAll('[data-plugin-row]').length).toBe(connectors.filter((p) => p.enabled).length);
        expect(group.querySelectorAll('[data-plugin-row]').length).toBeGreaterThan(2);
        expect(group.querySelector('[data-plugin-more]')).toBeNull();
    });

    it('"googleapis" finds Gmail by its permission scope; the menu goes through the router', async () => {
        const { root, router } = await mountPlugins('/plugins?q=googleapis');
        expect(rowIds(root)).toEqual(['gmail']);
        root.querySelector<HTMLAnchorElement>('[data-plugins-menu] [data-category="connector"]')!.click();
        await tick();
        expect(router.currentRoute.fullPath ?? router.currentRoute.path).toContain('kind=connector');
    });

    it('clicking a row opens its page; its switch does not', async () => {
        const { root, router } = await mountPlugins('/plugins');
        const a2a = row(root, 'a2a');
        switchOf(a2a).click();
        await tick();
        expect(router.currentRoute.path).toBe('/plugins');
        expect(switchOf(row(root, 'a2a')).checked).toBe(true);

        a2a.querySelector<HTMLElement>('[data-plugin-row-part="name"]')!.click();
        await tick();
        await tick();
        expect(router.currentRoute.path).toBe('/plugins/a2a');
    });

    it('turning off a plugin with dependents opens the dialog listing them; the switch holds until confirmed', async () => {
        // Without the other harnesses, so Claude Code is the last ready runtime.
        const root = await mountAt('/plugins', <PluginsView plugins={listPlugins.filter((p) => p.manifest.id !== 'copilot-cli' && p.manifest.id !== 'codex-cli')} />);
        const control = () => switchOf(row(root, 'claude-code'));
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
        expect(row(root, 'claude-code').getAttribute('data-readiness')).toBe('disabled');
    });

    it('a plugin nobody depends on switches without a dialog', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={listPlugins} />);
        switchOf(row(root, 'a2a')).click();
        await tick();
        expect(root.querySelector('[data-scope="dialog"][data-part="popup"]')).toBeNull();
        expect(switchOf(row(root, 'a2a')).checked).toBe(true);
    });

    it('Make active moves the memory slot on mock data', async () => {
        const root = await mountAt('/plugins', <PluginsView plugins={listPlugins} />);
        buttonNamed(row(root, 'agentic.memory.flat'), 'Make active').click();
        await tick();
        expect(row(root, 'agentic.memory.flat').hasAttribute('data-active')).toBe(true);
        expect(row(root, 'agentic.memory.default').hasAttribute('data-active')).toBe(false);
    });
});
