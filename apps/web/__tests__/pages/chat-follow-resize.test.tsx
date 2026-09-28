/**
 * The Follow panel's `resize` listener (#1109): added when the panel mounts, removed when it closes — every
 * follow-then-close used to leak one (its `onUnmounted` was registered outside setup).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountRoute, tick } from './mount';
import { clearViewPrefs } from './chat-view-prefs';

const WIDTH = window.innerWidth;
const setWidth = (width: number): void => { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }); };

afterEach(() => {
    vi.restoreAllMocks();
    clearViewPrefs();
    setWidth(WIDTH);
});

const CHAT = '/projects/p_agentic/chats/cm2';

describe('the Follow panel (mock)', () => {
    it('removes its resize listener when it closes', async () => {
        setWidth(1440);
        const dom = await mountRoute(CHAT);
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        const chip = [...dom.querySelectorAll<HTMLButtonElement>('[data-scope="ai-crew"][data-part="chip"]')].find((b) => b.querySelector('[data-part="name"]')?.textContent === 'Forge')!;
        chip.click();
        await tick();
        const panel = dom.querySelector('[data-scope="ai-follow"][data-part="root"]')!;
        expect(panel).not.toBeNull();
        const added = add.mock.calls.filter(([type]) => type === 'resize').map(([, fn]) => fn);
        expect(added.length).toBeGreaterThan(0);

        [...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Close' || b.getAttribute('aria-label') === 'Close')!.click();
        await tick();
        expect(dom.querySelector('[data-scope="ai-follow"][data-part="root"]')).toBeNull();
        const removed = remove.mock.calls.filter(([type]) => type === 'resize').map(([, fn]) => fn);
        for (const fn of added) expect(removed).toContain(fn);
    });
});
