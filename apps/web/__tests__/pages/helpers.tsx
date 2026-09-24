/**
 * Mount a routed page in happy-dom: a memory router positioned at `path`
 * (the same `createServerRouter` the server uses), the page as the app.
 */
import { afterEach } from 'vitest';
import { defineApp, type JSXElement } from '@sigx/runtime-core';
import '@sigx/runtime-dom';
import { createServerRouter } from '../../src/router';

const closers: (() => void)[] = [];

afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

export async function mountAt(path: string, tree: JSXElement): Promise<HTMLDivElement> {
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(tree);
    app.use(router);
    app.mount(container);
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

/** The DOM settles a tick after a reactive write. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

export const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A button found by its visible text. */
export function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
    const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no button "${label}"`);
    return button;
}

/** The `<col>` widths a `DataTable` renders from its `cols` template (zero's `--table-column-width`; `auto` for an `fr` track). */
export function colWidths(table: ParentNode): string[] {
    return [...table.querySelectorAll<HTMLElement>('colgroup > col')].map((c) => c.style.getPropertyValue('--table-column-width') || 'auto');
}

/** A `DataTable` cell's value: its text without the column label zero prints inside it for the stacked layout. */
export function cellText(cell: Element | null | undefined): string {
    if (!cell) return '';
    const copy = cell.cloneNode(true) as Element;
    copy.querySelectorAll('[data-scope="table"][data-part="cell-label"]').forEach((label) => label.remove());
    return text(copy);
}
