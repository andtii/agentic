/**
 * The chat's View and Detail controls on the mock page (#1058, CHT-09): the build:ds chat (`cm1`, one agent
 * at work) picks Focus, the four-agent register chat (`cm2`) picks Team; each detail level; a pin that
 * survives a remount; the failed turn that opens itself; Stop on the live line.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { all, mountRoute, texts, tick } from './mount';
import { clearViewPrefs, saveDetail } from './chat-view-prefs';

afterEach(clearViewPrefs);

const note = (dom: ParentNode): string => dom.querySelector('[data-chat-view-note] > span')?.textContent ?? '';
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string =>
    dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}
const summaries = (dom: ParentNode): string[] => texts(all(dom, 'ai-steps', 'label'));

describe('the chat header', () => {
    it('shows the title, the note naming the rule, and the View and Detail controls', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        expect(dom.querySelector('[data-chat-head-title]')?.textContent).toBe('Leaner build:ds for the static lane');
        expect(note(dom)).toBe('one agent working · Focus picked automatically');
        expect(texts([...dom.querySelectorAll('[data-chat-control="view"] button')])).toEqual(['Focus', 'Team', 'Lanes']);
        expect(texts([...dom.querySelectorAll('[data-chat-control="detail"] button')])).toEqual(['Messages', 'Steps', 'Raw']);
        expect(pressed(dom, 'view')).toBe('Focus');
        expect(pressed(dom, 'detail')).toBe('Steps');
        expect(dom.querySelector('[data-chat-view-auto]')).toBeNull();
    });

    it('picks Team when two or more agents are at work, at Messages', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm2');
        expect(note(dom)).toBe('2 agents working · Team picked automatically');
        expect(pressed(dom, 'view')).toBe('Team');
        expect(pressed(dom, 'detail')).toBe('Messages');
        // Messages: prose, the question, no steps box.
        expect(all(dom, 'ai-steps', 'root')).toHaveLength(0);
        expect(dom.querySelector('[data-scope="ai-question"][data-part="root"]')).not.toBeNull();
    });
});

describe('Focus', () => {
    it('Steps: each finished turn is one steps box; the one a failure stopped opens itself, the recovered one stays shut', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        expect(summaries(dom)).toEqual(['5 steps · 3 commands, 2 reads · 1 failed, recovered', '4 steps · 3 commands, 1 read · 1 failed']);
        const boxes = all(dom, 'ai-steps', 'summary');
        expect(boxes.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
        // The open box: one line per step, the failed one with its excerpt, its note and Full output.
        expect(all(dom, 'ai-steps', 'step')).toHaveLength(4);
        const excerpt = all(dom, 'ai-steps', 'excerpt')[0]!;
        expect(excerpt.textContent).toContain("Cannot find module '@agentic/core/dist/index.js'");
        expect(all(dom, 'ai-steps', 'excerpt-meta')[0]!.textContent).toContain('exit 1 · 2 of 14 lines, picked by error');
        expect(all(dom, 'ai-steps', 'full')[0]!.getAttribute('href')).toBe('/sessions/s1?call=c_bd8');
        // No tool cards at Steps.
        expect(all(dom, 'ai-tool-call', 'root')).toHaveLength(0);
    });

    it('Messages drops the steps boxes; Raw shows every call as a tool card', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        await press(dom, 'detail', 'Messages');
        expect(all(dom, 'ai-steps', 'root')).toHaveLength(0);
        expect(all(dom, 'ai-tool-call', 'root')).toHaveLength(0);
        expect(texts(all(dom, 'ai-message', 'name'))).toEqual(['Andii', 'Forge', 'Forge']);
        await press(dom, 'detail', 'Raw');
        expect(all(dom, 'ai-steps', 'root')).toHaveLength(0);
        expect(all(dom, 'ai-tool-call', 'root')).toHaveLength(9);
        expect(pressed(dom, 'detail')).toBe('Raw');
    });

    it('remembers a box the reader opened, and the detail, across a remount', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        all(dom, 'ai-steps', 'summary')[0]!.click();
        await tick();
        expect(all(dom, 'ai-steps', 'summary')[0]!.getAttribute('aria-expanded')).toBe('true');
        await press(dom, 'detail', 'Raw');
        await press(dom, 'detail', 'Steps');
        const again = await mountRoute('/projects/p_agentic/chats/cm1');
        expect(all(again, 'ai-steps', 'summary').map((b) => b.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    });

    it('a box that opened itself can be shut', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        all(dom, 'ai-steps', 'summary')[1]!.click();
        await tick();
        expect(all(dom, 'ai-steps', 'summary')[1]!.getAttribute('aria-expanded')).toBe('false');
    });

    it('the live line sits under the last turn: the agent, its step, and Stop', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm1');
        const rows = [...dom.querySelectorAll('[data-scope="ai-thread"][data-part="list"] > li')];
        const line = rows[rows.length - 1]!.querySelector('[data-scope="ai-live-line"][data-part="root"]');
        expect(line).not.toBeNull();
        expect(line!.querySelector('[data-part="agent"]')?.textContent).toContain('Forge');
        expect(line!.querySelector('[data-part="step"]')?.textContent).toBe('Edit · packages/ui/package.json · build:ds');
        expect(line!.querySelector('[data-part="elapsed"]')?.textContent).toBe('6s');
        // Stop: the line goes, and nobody is at work any more.
        (line!.querySelector('[data-part="stop"] button') as HTMLButtonElement).click();
        await tick();
        expect(dom.querySelector('[data-scope="ai-live-line"]')).toBeNull();
        expect(note(dom)).toBe('one agent working · Focus picked automatically');
    });
});

describe('pinning', () => {
    it('a pinned view overrides the count, says so, and survives a remount; Auto unpins', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/cm2');
        await press(dom, 'view', 'Focus');
        expect(pressed(dom, 'view')).toBe('Focus');
        expect(note(dom)).toBe('pinned by you · one thread, each turn folded');
        // Focus's default detail: Steps.
        expect(pressed(dom, 'detail')).toBe('Steps');
        expect(summaries(dom)).toEqual(['3 steps · 3 handoffs', '3 steps · 2 reads, 1 command', '1 step · 1 search']);

        const again = await mountRoute('/projects/p_agentic/chats/cm2');
        expect(pressed(again, 'view')).toBe('Focus');
        expect(note(again)).toBe('pinned by you · one thread, each turn folded');
        (again.querySelector('[data-chat-view-auto]') as HTMLButtonElement).click();
        await tick();
        expect(pressed(again, 'view')).toBe('Team');
        expect(note(again)).toBe('2 agents working · Team picked automatically');
    });

    it('a saved detail wins over the view default', async () => {
        saveDetail('cm2', 'steps');
        const dom = await mountRoute('/projects/p_agentic/chats/cm2');
        expect(pressed(dom, 'view')).toBe('Team');
        expect(pressed(dom, 'detail')).toBe('Steps');
    });

    it('Lanes is not offered below 1024 px', async () => {
        const width = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
        try {
            const dom = await mountRoute('/projects/p_agentic/chats/cm1');
            expect(texts([...dom.querySelectorAll('[data-chat-control="view"] button')])).toEqual(['Focus', 'Team']);
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
        }
    });
});
