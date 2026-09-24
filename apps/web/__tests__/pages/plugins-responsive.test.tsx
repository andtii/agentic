/**
 * The plugins redesign's phone pass (#641; AC-13, #47): below 768 px the category menu is a `Select` above the
 * view, and the add page's preview is a full-screen sheet that closes back to the list. The layout itself is the
 * stylesheet's (`styles/plugins/*.css`, checked at 400 px by `e2e/mobile.spec.ts`); these pin the markup it needs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView, type Router } from '@sigx/router';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { createServerRouter } from '../../src/router';
import { text, tick } from './helpers';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

async function mountAt(path: string): Promise<{ dom: HTMLDivElement; router: Router }> {
    const router = createServerRouter(path);
    await router.isReady();
    const dom = document.createElement('div');
    document.body.appendChild(dom);
    const app = defineApp(<RouterView />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(dom);
    await tick();
    closers.push(() => {
        app.unmount();
        dom.remove();
    });
    return { dom, router };
}

const until = async (check: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await tick();
    }
    throw new Error(`timed out waiting for ${what}`);
};

describe('/plugins below 768 px: the category Select (#641)', () => {
    it('offers every menu item with its count, grouped, on the current category', async () => {
        const { dom } = await mountAt('/plugins?kind=memory');
        const select = dom.querySelector('[data-plugins-menu] [data-plugins-select]')!;
        expect(select).not.toBeNull();
        // The menu column is still there for wider screens; the stylesheet shows one or the other.
        expect(dom.querySelector('[data-plugins-menu] [data-plugins-menu-column] [data-category-menu]')).not.toBeNull();
        expect(text(select.querySelector('[data-scope="field"][data-part="label"]'))).toBe('Category');
        expect(text(select.querySelector('[data-scope="select"][data-part="value"]'))).toMatch(/^Memory · \d+$/);
        const options = [...select.querySelectorAll('[role="option"]')].map((o) => text(o).replace('✓', ''));
        expect(options[0]).toMatch(/^All plugins · \d+$/);
        expect(options[1]).toMatch(/^Needs attention · \d+$/);
        expect(options.some((o) => /^Connectors · \d+$/.test(o))).toBe(true);
        expect([...select.querySelectorAll('[data-scope="select"][data-part="group-label"]')].map(text)).toEqual(['Runtimes', 'Reach', 'Keep', 'Projects']);
    });

    it('choosing a category follows its link and keeps the search and status', async () => {
        const { dom, router } = await mountAt('/plugins?kind=memory&q=a&status=on');
        const select = dom.querySelector('[data-plugins-select]')!;
        (select.querySelector('[data-scope="select"][data-part="trigger"]') as HTMLElement).click();
        await tick();
        const harness = [...select.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => text(o).startsWith('Harness'))!;
        harness.click();
        await until(() => router.currentRoute.query.kind === 'harness', 'the harness category');
        expect(router.currentRoute.query).toMatchObject({ kind: 'harness', q: 'a', status: 'on' });
        await until(() => /^Harness · \d+$/.test(text(dom.querySelector('[data-plugins-select] [data-scope="select"][data-part="value"]'))), 'the select to follow the URL');
    });
});

describe('/plugins/connectors/add below 768 px: the preview sheet (#641)', () => {
    it('a selected connector is a sheet with a close control that clears ?selected=', async () => {
        const { dom, router } = await mountAt('/plugins/connectors/add?category=email-calendar&selected=gmail');
        const preview = dom.querySelector<HTMLElement>('[data-add-preview]')!;
        expect(preview.hasAttribute('data-sheet')).toBe(true);
        expect(preview.querySelector('[data-preview-foot]')).not.toBeNull();
        const close = preview.querySelector<HTMLElement>('[data-preview-close] button')!;
        expect(close.getAttribute('aria-label')).toBe('Close preview');
        close.click();
        await until(() => router.currentRoute.query.selected === undefined, 'the preview to close');
        expect(router.currentRoute.query.category).toBe('email-calendar');
        expect(dom.querySelector('[data-add-preview]')!.hasAttribute('data-sheet')).toBe(false);
    });
});
