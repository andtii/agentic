/**
 * The Lanes view on the mock page (#1061, CHT-09, COL-09; `docs/design/chat-modes/screenshots/ChatLanes.png`):
 * pinned on the four-agent register chat (`cm2`) it shows Atlas's latest word on top, then a lane each for
 * Forge (working), Lint (done with #22) and Scout (asking you); the coordinator and idle members get none;
 * the question in Scout's footer is answered from the lane; below 1024 px the pin shows Team.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { all, mountRoute, texts, tick } from './mount';
import { clearViewPrefs } from './chat-view-prefs';

afterEach(clearViewPrefs);

const CHAT = '/projects/p_agentic/chats/cm2';
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string =>
    dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}
const lanes = (dom: ParentNode): HTMLElement[] => [...dom.querySelectorAll<HTMLElement>('[data-chat-lane]')];
const lane = (dom: ParentNode, id: string): HTMLElement => {
    const el = dom.querySelector<HTMLElement>(`[data-chat-lane="${id}"]`);
    if (!el) throw new Error(`no lane for ${id}`);
    return el;
};
const part = (el: ParentNode, name: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-scope="ai-lane"][data-part="${name}"]`);

describe('Lanes (mock)', () => {
    it('is reached by pinning it: the coordinator on top, a lane per agent at work, at Steps', async () => {
        const dom = await mountRoute(CHAT);
        expect(pressed(dom, 'view')).toBe('Team');
        expect(dom.querySelector('[data-chat-lanes]')).toBeNull();
        await press(dom, 'view', 'Lanes');
        expect(pressed(dom, 'view')).toBe('Lanes');
        expect(pressed(dom, 'detail')).toBe('Steps');
        expect(dom.querySelector('[data-chat-view-note] > span')?.textContent).toBe('pinned by you · one column per agent at work');

        const top = dom.querySelector('[data-chat-lanes-top]')!;
        expect(top.getAttribute('data-chat-lanes-top')).toBe('atlas');
        expect(top.querySelector('[data-chat-lanes-top-text]')?.textContent).toContain('Splitting it three ways');
        expect(top.querySelector('[data-chat-lanes-top-time]')?.textContent).not.toBe('');

        // Forge works, Lint finished #22, Scout waits on you; Atlas (the coordinator, idle) has no lane.
        expect(lanes(dom).map((l) => l.getAttribute('data-chat-lane'))).toEqual(['forge', 'lint', 'scout']);
        expect(texts(all(dom, 'ai-lane', 'name'))).toEqual(['Forge', 'Lint', 'Scout']);
        expect(lanes(dom).map((l) => part(l, 'root')!.getAttribute('data-state'))).toEqual(['running', 'complete', 'loading']);
        expect(part(lane(dom, 'forge'), 'task')?.textContent).toBe('#21 · Build the register in packages/ui');
        // Forge's live step is its running step line.
        expect(texts([...lane(dom, 'forge').querySelectorAll('[data-scope="ai-steps"][data-part="target"]')])).toEqual(['pnpm --filter @agentic/ui build']);
        // Lint: its steps, then its message, then the done footer.
        expect(lane(dom, 'lint').querySelectorAll('[data-scope="ai-steps"][data-part="step"]')).toHaveLength(3);
        expect(part(lane(dom, 'lint'), 'message')?.textContent).toContain('41 of 43 parts');
        expect(part(lane(dom, 'lint'), 'footer')?.textContent).toBe('Done · #22 ticked');
        expect(dom.querySelector('[data-chat-lanes-hint]')?.textContent).toBe('or @ an agent to post in its lane');
        // Three lanes fit: no sideways scroll.
        expect(dom.querySelector('[data-chat-lanes-row]')!.hasAttribute('data-scroll')).toBe(false);
    });

    it('Messages leaves the steps out of the lanes', async () => {
        const dom = await mountRoute(CHAT);
        await press(dom, 'view', 'Lanes');
        await press(dom, 'detail', 'Messages');
        expect(lanes(dom)).toHaveLength(3);
        expect(dom.querySelectorAll('[data-chat-lanes] [data-scope="ai-steps"][data-part="step"]')).toHaveLength(0);
        expect(part(lane(dom, 'lint'), 'message')).not.toBeNull();
    });

    it("answers Scout's question from its lane footer", async () => {
        const dom = await mountRoute(CHAT);
        await press(dom, 'view', 'Lanes');
        const q = part(lane(dom, 'scout'), 'question')!;
        expect(q.textContent).toContain("Asks you: Should the register follow zero's naming");
        // A free-text question: the footer offers the typed answer.
        const button = [...q.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Answer in text')!;
        button.click();
        await tick();
        const card = lane(dom, 'scout').querySelector('[data-chat-lane-answer] [data-scope="ai-question"][data-part="root"]')!;
        expect(card).not.toBeNull();
        const box = card.querySelector<HTMLTextAreaElement>('[data-part="other"]')!;
        box.value = 'ours';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Answer')!.click();
        await tick();
        expect(part(lane(dom, 'scout'), 'question')).toBeNull();
        expect(lane(dom, 'scout').querySelector('[data-chat-lane-answer]')).toBeNull();
    });

    it('falls back to Team below 1024 px', async () => {
        const dom = await mountRoute(CHAT);
        await press(dom, 'view', 'Lanes');
        const width = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
        try {
            const narrow = await mountRoute(CHAT);
            expect(narrow.querySelector('[data-chat-lanes]')).toBeNull();
            expect(pressed(narrow, 'view')).toBe('Team');
            expect(narrow.querySelector('[data-chat-view-note] > span')?.textContent).toBe('pinned by you · Lanes needs a wider screen, showing Team');
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        }
    });
});
