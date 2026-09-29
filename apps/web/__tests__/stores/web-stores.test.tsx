/**
 * The page-head stores (#1124): one instance per app, so what one app's page publishes never reaches another
 * app's render — two concurrent SSR requests stay apart — and a page that comes back finds the same store.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { component, defineApp, signal } from 'sigx';
import '@sigx/runtime-dom';
import { renderToString } from '@sigx/server-renderer';
import { machineHead, useMachineHeadStore } from '../../src/pages/machines/head';
import { openContextDrawer, useContextDrawerStore } from '../../src/pages/chat/context-drawer';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

/** A page that publishes a machine's head in setup, and a topbar that reads it as the shell does, while it renders. */
function appFor(id: string) {
    const Page = component(() => {
        const { head } = useMachineHeadStore();
        head.value = { id, name: id } as never;
        return () => <p>page</p>;
    });
    const Topbar = component(() => () => <h1>{machineHead.value?.name ?? 'none'}</h1>);
    const Shell = component(() => () => <main><Page /><Topbar /></main>);
    return defineApp(<Shell />);
}

describe('page-head stores (#1124)', () => {
    it('two server renders at once each read their own head', async () => {
        const [a, b] = await Promise.all([renderToString(appFor('alpha') as never), renderToString(appFor('beta') as never)]);
        expect(a).toContain('alpha');
        expect(a).not.toContain('beta');
        expect(b).toContain('beta');
        expect(b).not.toContain('alpha');
    });

    it('pages mounting and unmounting share the app’s store, and a handler outside any component reaches it', async () => {
        const at = signal({ page: 'a' as 'a' | 'b' | 'none' });
        const seen = new Set<unknown>();
        const Page = component(() => {
            const store = useContextDrawerStore();
            seen.add(store);
            return () => <p data-open={String(store.drawer.open)}>page</p>;
        });
        const Shell = component(() => () => <main>{at.page === 'none' ? null : <Page key={at.page} />}</main>);
        const container = document.createElement('div');
        document.body.appendChild(container);
        const app = defineApp(<Shell />);
        app.mount(container);
        closers.push(() => {
            app.unmount();
            container.remove();
        });
        for (const page of ['none', 'b', 'none', 'a'] as const) {
            at.page = page;
            await tick();
        }
        expect(seen.size).toBe(1);
        // The topbar's button: a click handler, no component running.
        openContextDrawer();
        await tick();
        expect(container.querySelector('p')?.dataset.open).toBe('true');
    });
});
