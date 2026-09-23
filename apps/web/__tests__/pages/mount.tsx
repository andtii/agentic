/**
 * Mount a route in happy-dom: the real route table on a memory router, the
 * page rendered through `RouterView`, torn down after each test. Pages use
 * `useHead`, which is a no-op without the SSR head collector.
 */
import { afterEach } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { createServerRouter } from '../../src/router';

const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

export async function mountRoute(path: string): Promise<HTMLDivElement> {
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(<RouterView />);
    app.use(router);
    // happy-dom runs no Monaco: the plain grid draws every code surface (#564).
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

/** The DOM settles a tick after a reactive write. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export const page = (root: ParentNode, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-page="${name}"]`);
export const all = (root: ParentNode, scope: string, part: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`)];
export const texts = (els: readonly Element[]): string[] => els.map((el) => el.textContent?.trim() ?? '');
