/**
 * The Follow panel on the mock page (#1060, CHT-09, AGT-09): the register chat (`cm2`) — Forge at work on
 * the handoff `#21`. A crew chip opens the panel in place of the context panel; it shows the task, the
 * environment and the live cursor; Message puts `@Forge ` into the composer; Stop stops Forge; closing
 * brings the context panel back; nothing is added to the thread; below 1280 px it opens as a drawer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, mountRoute, texts, tick } from './mount';
import { clearViewPrefs } from './chat-view-prefs';
import { crewChip, withCrewStrip } from './chat-follow-crew';
import { followPlacement } from '../../src/pages/chat/follow';

const WIDTH = window.innerWidth;
/** The viewport the panel reads on mount (happy-dom's default is 1024); put back after each test. */
const setWidth = (width: number): void => { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }); };

let undo: () => void;
beforeEach(() => { undo = withCrewStrip(); });
afterEach(() => {
    undo();
    clearViewPrefs();
    setWidth(WIDTH);
});

const CHAT = '/projects/p_agentic/chats/cm2';
const panel = (dom: ParentNode): HTMLElement | null => dom.querySelector<HTMLElement>('[data-scope="ai-follow"][data-part="root"]');
const rows = (dom: ParentNode): number => dom.querySelectorAll('[data-scope="ai-thread"][data-part="list"] > li').length;
const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label || x.getAttribute('aria-label') === label);
    if (!b) throw new Error(`no ${label} button`);
    return b;
};

describe('placement', () => {
    it('the right column at 1280 and up, a drawer below, a bottom sheet on a phone', () => {
        expect(followPlacement(undefined)).toBe('column');
        expect(followPlacement(1440)).toBe('column');
        expect(followPlacement(1280)).toBe('column');
        expect(followPlacement(1024)).toBe('drawer');
        expect(followPlacement(767)).toBe('sheet');
        expect(followPlacement(400)).toBe('sheet');
    });
});

describe('the Follow panel (mock)', () => {
    it('opens from a crew chip in place of the context panel, and closing brings the context panel back', async () => {
        setWidth(1440);
        const dom = await mountRoute(CHAT);
        expect(panel(dom)).toBeNull();
        expect(dom.querySelector('[data-page="chat"] > [data-chat-context]')?.getAttribute('aria-label')).toBe('Members and tasks');
        crewChip(dom, 'Forge').click();
        await tick();
        const p = panel(dom)!;
        expect(p).not.toBeNull();
        // The right column holds the panel, not the context panel.
        expect(dom.querySelector('[data-page="chat"] > [data-chat-follow="forge"]')).not.toBeNull();
        expect(dom.querySelector('[data-page="chat"] > aside[data-chat-context]')).toBeNull();
        expect(p.querySelector('[data-part="title"]')?.textContent).toBe('Following Forge');
        expect(p.querySelector('[data-part="task"]')?.textContent).toContain('Build the register in packages/ui · #21');
        expect(p.querySelector('[data-part="env"]')?.textContent).toContain(' / ');
        // At work: the live output well with its cursor, and Stop.
        expect(p.querySelector('[data-part="cursor"]')).not.toBeNull();
        expect(crewChip(dom, 'Forge').getAttribute('aria-pressed')).toBe('true');

        button(p, 'Close').click();
        await tick();
        expect(panel(dom)).toBeNull();
        expect(dom.querySelector('[data-page="chat"] > aside[data-chat-context]')).not.toBeNull();
    });

    it('Message puts the mention into the composer; Stop stops the agent; nothing reaches the thread', async () => {
        setWidth(1440);
        const dom = await mountRoute(CHAT);
        const before = rows(dom);
        const messages = texts(all(dom, 'ai-message', 'body'));
        crewChip(dom, 'Forge').click();
        await tick();
        expect(rows(dom)).toBe(before);

        button(panel(dom)!, 'Message Forge').click();
        await tick();
        await tick();
        const composer = dom.querySelector<HTMLTextAreaElement>('[data-chat-composer] textarea')!;
        expect(composer.value).toContain('@Forge ');

        button(panel(dom)!, 'Stop').click();
        await tick();
        // Stopped: no live line, no cursor, no Stop — and the panel stays open.
        expect(dom.querySelector('[data-scope="ai-live-line"]')).toBeNull();
        expect(panel(dom)).not.toBeNull();
        expect(panel(dom)!.querySelector('[data-part="cursor"]')).toBeNull();
        expect([...panel(dom)!.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Stop')).toBe(false);
        // Following wrote nothing: the thread's messages are the ones it had (the live line is the one row that went).
        expect(texts(all(dom, 'ai-message', 'body'))).toEqual(messages);
        expect(rows(dom)).toBe(before - 1);
    });

    it('a finished member shows its last steps and its result', async () => {
        setWidth(1440);
        const dom = await mountRoute(CHAT);
        crewChip(dom, 'Lint').click();
        await tick();
        const p = panel(dom)!;
        expect(p.querySelector('[data-part="title"]')?.textContent).toBe('Following Lint');
        expect(p.querySelector('[data-part="task"]')?.textContent).toContain('Check the register against the anatomy · #22');
        expect(p.querySelectorAll('[data-scope="ai-steps"][data-part="step"]')).toHaveLength(3);
        expect(p.querySelector('[data-scope="ai-follow"][data-part="result"]')?.textContent).toContain('41 of 43 parts');
        expect(p.querySelector('[data-part="cursor"]')).toBeNull();
    });

    for (const [width, placement] of [[1024, 'drawer'], [400, 'sheet']] as const) {
        it(`opens as a ${placement} at ${width} px`, async () => {
            setWidth(width);
            const dom = await mountRoute(CHAT);
            crewChip(dom, 'Forge').click();
            await tick();
            const drawer = document.querySelector<HTMLElement>(`[data-follow-drawer="${placement}"]`);
            expect(drawer).not.toBeNull();
            expect(drawer!.querySelector('[data-scope="ai-follow"][data-part="root"]')).not.toBeNull();
            // Not in the grid's right column.
            expect(dom.querySelector('[data-page="chat"] > [data-chat-follow]')).toBeNull();
            const drawerPanel = drawer!.closest<HTMLElement>('[data-scope="drawer"][data-part="panel"]');
            expect(drawerPanel?.getAttribute('data-state')).toBe('open');
            // Closing the panel closes the drawer.
            button(drawer!, 'Close').click();
            await tick();
            expect(document.querySelector('[data-follow-drawer]')).toBeNull();
        });
    }
});
