/**
 * A chat with saved view choices hydrates cleanly (#1113, CHT-09): the server cannot read `localStorage`, so it
 * renders the automatic view; the client's first render must match it, and the saved pin applies after mount.
 * Pinned Lanes on the four-agent register chat (`cm2`): the server sends Team, the client hydrates Team with no
 * mismatch, then shows Lanes; switching to Team leaves exactly one thread in the conversation column.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { renderToString } from '@sigx/server-renderer';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { plainCodeRenderer, useCodeRenderer } from '@agentic/ui';
import { createServerRouter } from '../../src/router';
import { USER } from '../../src/mock/workspace';
import { useKeyValueStorage } from '@agentic/client';
import { webKeyValueStorage } from '../../src/actors/storage';
import { tick } from './mount';
import { clearViewPrefs, savePin } from './chat-view-prefs';

const CHAT = '/projects/p_agentic/chats/cm2';
const THREAD = '[data-scope="ai-thread"][data-part="root"]';

async function appAt(path: string) {
    const router = createServerRouter(path);
    await router.isReady();
    const app = defineApp(<RouterView />);
    app.use(router);
    app.defineProvide(useCodeRenderer, () => plainCodeRenderer);
    app.defineProvide(useKeyValueStorage, () => webKeyValueStorage);
    return app;
}

const pressed = (dom: ParentNode): string => dom.querySelector('[data-chat-control="view"] button[aria-pressed="true"]')?.textContent?.trim() ?? '';

let container: HTMLElement | null = null;
afterEach(() => {
    container?.remove();
    container = null;
    clearViewPrefs();
});

describe('chat view prefs hydrate (#1113)', () => {
    it('a saved Lanes pin hydrates the server’s Team with no mismatch, then applies; Team again holds one thread', async () => {
        // The server: no storage, so the automatic view.
        clearViewPrefs();
        const html = await renderToString((await appAt(CHAT)) as never);
        expect(html).toContain('data-chat-team-crew');
        expect(html).not.toContain('data-chat-lanes');

        // The viewer saved a Lanes pin on an earlier visit; this page load has not read it yet.
        savePin('cm2', 'lanes', USER.workspace);

        const logs: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
        const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
        try {
            container = document.createElement('div');
            container.innerHTML = html;
            document.body.appendChild(container);
            const app = await appAt(CHAT);
            app.use(ssrClientPlugin).hydrate!(container);
            await tick();
            await tick();

            expect(logs.filter((l) => /hydrat|mismatch/i.test(l))).toEqual([]);
            // The saved pin applied after mount.
            expect(pressed(container)).toBe('Lanes');
            expect(container.querySelector('[data-chat-lanes]')).not.toBeNull();

            const team = [...container.querySelectorAll<HTMLButtonElement>('[data-chat-control="view"] button')].find((b) => b.textContent?.trim() === 'Team')!;
            team.click();
            await tick();
            const main = container.querySelector('[data-chat-main]')!;
            expect(main.querySelectorAll(THREAD)).toHaveLength(1);
            expect(container.querySelector('[data-chat-lanes]')).toBeNull();
            expect(logs.filter((l) => /hydrat|mismatch/i.test(l))).toEqual([]);
        } finally {
            warn.mockRestore();
            error.mockRestore();
        }
    });
});
