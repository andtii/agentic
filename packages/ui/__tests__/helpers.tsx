/**
 * Test helpers: mount a JSX tree into a fresh container in happy-dom, and
 * tear it down after each test — the same `defineApp(...).mount()` route
 * `examples/agent` in signalxjs/ai uses, on `@sigx/runtime-core` directly.
 */
import { afterEach } from 'vitest';
import { defineApp, type JSXElement } from '@sigx/runtime-core';
// Registers the DOM platform the runtime renders through.
import '@sigx/runtime-dom';

const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

export function mount(tree: JSXElement): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree).mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

/** Unmount everything mounted so far — for tests that check what a teardown leaves behind. */
export function unmountAll(): void {
    for (const close of closers.splice(0).reverse()) close();
}

/** The DOM settles a tick after a reactive write. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Poll until `check` holds, or fail after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > until) throw new Error('waitFor: condition not met in time');
        await tick();
    }
}

export const all = (root: ParentNode, scope: string, part: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`)];
export const one = (root: ParentNode, scope: string, part: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-scope="${scope}"][data-part="${part}"]`);

/** A button found by its visible text. */
/** A button's accessible name: its `aria-label`, else its text. */
export const buttonName = (b: Element): string => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();

export function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
    const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => buttonName(b) === text);
    if (!button) throw new Error(`no button "${text}"`);
    return button;
}

/** Snapshot-stable HTML: generated ids differ by test order, the rest is the contract. */
export function stableHtml(el: Element): string {
    return el.innerHTML.replace(/ (id|for|aria-controls|aria-labelledby|aria-describedby)="[^"]*"/g, ' $1="…"');
}
