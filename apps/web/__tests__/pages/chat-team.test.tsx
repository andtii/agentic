/**
 * The Team view on the mock page (#1059, CHT-09, COL-09): the four-agent register chat (`cm2`) — the crew
 * strip, the coordinator's handoffs as one-line rows, Lint's answer as a done work card, Forge's live work card
 * at the tail, Scout's question with the assignment it blocks, and the composer's coordinator hint. The switch
 * back to Focus is on the platform (`chat-team-live.test.tsx`): the mock's members keep their status.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { all, mountRoute, texts, tick } from './mount';
import { clearViewPrefs } from './chat-view-prefs';

afterEach(clearViewPrefs);

const CM2 = '/projects/p_agentic/chats/cm2';
const note = (dom: ParentNode): string => dom.querySelector('[data-chat-view-note] > span')?.textContent ?? '';
const pressed = (dom: ParentNode, control: 'view' | 'detail'): string =>
    dom.querySelector(`[data-chat-control="${control}"] button[aria-pressed="true"]`)?.textContent?.trim() ?? '';
async function press(dom: ParentNode, control: 'view' | 'detail', label: string): Promise<void> {
    const button = [...dom.querySelectorAll<HTMLButtonElement>(`[data-chat-control="${control}"] button`)].find((b) => b.textContent?.trim() === label);
    if (!button) throw new Error(`no ${label} in ${control}`);
    button.click();
    await tick();
}
/** The thread's rows, top to bottom, as what each one is. */
const rowKinds = (dom: ParentNode): string[] => [...dom.querySelectorAll('[data-scope="ai-thread"][data-part="list"] > li')].map((li) => {
    if (li.querySelector('[data-chat-team-handoff]')) return `handoff:${li.querySelector('[data-scope="ai-handoff"][data-part="to"] > span:last-child')?.textContent?.trim()}`;
    if (li.querySelector('[data-chat-team-work]')) return `work:${li.querySelector('[data-scope="ai-work-card"][data-part="name"]')?.textContent?.trim()}`;
    if (li.querySelector('[data-chat-team-question]')) return 'question';
    if (li.querySelector('[data-chat-team-talk]')) return 'talk';
    return `message:${li.querySelector('[data-scope="ai-message"][data-part="name"]')?.textContent?.trim()}`;
});

describe('Team (mock)', () => {
    it('picks itself with two agents at work: the note, Messages, the crew strip', async () => {
        const dom = await mountRoute(CM2);
        expect(note(dom)).toBe('2 agents working · Team picked automatically');
        expect(pressed(dom, 'view')).toBe('Team');
        expect(pressed(dom, 'detail')).toBe('Messages');
        const chips = all(dom, 'ai-crew', 'chip');
        expect(texts(all(dom, 'ai-crew', 'name'))).toEqual(['Atlas', 'Forge', 'Lint', 'Scout']);
        expect(chips.map((c) => c.getAttribute('data-state'))).toEqual(['paused', 'running', 'complete', 'loading']);
        expect(chips[0]!.querySelector('[data-part="step"]')?.textContent).toBe('waiting on Forge and Scout');
        expect(chips[1]!.querySelector('[data-part="step"]')?.textContent).toBe('Bash · pnpm --filter @agentic/ui build');
        expect(chips[1]!.querySelector('[data-part="elapsed"]')?.textContent).toMatch(/^2m 1[2-5]s$/);
        expect(chips[3]!.querySelector('[data-part="ask"]')?.textContent).toContain("asks you: Should the register follow zero's naming");
    });

    it('reads top to bottom: your message, the coordinator, its handoffs, Lint’s card, Scout’s question, Forge’s live card', async () => {
        const dom = await mountRoute(CM2);
        expect(rowKinds(dom)).toEqual([
            'message:Andii',
            'message:Atlas',
            'handoff:Forge',
            'handoff:Lint',
            'handoff:Scout',
            'work:Lint',
            'message:Scout',
            'question',
            'work:Forge'
        ]);
        const handoff = dom.querySelector('[data-chat-team-handoff="forge"]')!;
        expect(handoff.querySelector('[data-part="from"] > span:last-child')?.textContent).toBe('Atlas');
        expect(handoff.querySelector('[data-part="task"]')?.textContent).toBe('Build the register in packages/ui');
        expect(handoff.querySelector('[data-part="ref"]')?.textContent).toBe('#21');
    });

    it('a finished assignment is a done card with its result; the live one shows its current step', async () => {
        const dom = await mountRoute(CM2);
        const lint = dom.querySelector('[data-chat-team-agent="lint"] [data-scope="ai-work-card"][data-part="root"]')!;
        expect(lint.getAttribute('data-state')).toBe('complete');
        expect(lint.querySelector('[data-part="task"]')?.textContent).toBe('Check the register against the anatomy · #22');
        expect(lint.querySelector('[data-part="meta"]')?.textContent).toMatch(/^3 steps · /);
        expect(lint.querySelector('[data-part="result"]')?.textContent).toContain('The anatomy check passes for 41 of 43 parts.');
        // Lint's answer is the card, not a message row as well.
        expect(texts(all(dom, 'ai-message', 'name'))).not.toContain('Lint');
        const forge = dom.querySelector('[data-chat-team-agent="forge"] [data-scope="ai-work-card"][data-part="root"]')!;
        expect(forge.getAttribute('data-state')).toBe('running');
        expect(forge.querySelector('[data-part="task"]')?.textContent).toBe('Build the register in packages/ui · #21');
        expect(texts([...forge.querySelectorAll('[data-scope="ai-steps"][data-part="target"]')])).toEqual(['pnpm --filter @agentic/ui build']);
    });

    it('Scout’s question says what it blocks and answers through the request path', async () => {
        const dom = await mountRoute(CM2);
        const q = dom.querySelector('[data-chat-team-question]')!;
        expect(q.querySelector('[data-chat-team-blocks]')?.textContent).toBe('blocks #23');
        expect(q.querySelector('[data-scope="ai-question"][data-part="title"]')?.textContent).toBe('Scout asks');
        expect(dom.querySelectorAll('[data-scope="ai-question"][data-part="root"]')).toHaveLength(1);
        (q.querySelector('[data-chat-team-answer-text] button') as HTMLButtonElement).click();
        expect(document.activeElement).toBe(q.querySelector('textarea'));
    });

    it('a chip or a card’s Follow follows the agent', async () => {
        const dom = await mountRoute(CM2);
        all(dom, 'ai-crew', 'chip')[1]!.click();
        await tick();
        expect(all(dom, 'ai-crew', 'chip')[1]!.getAttribute('aria-pressed')).toBe('true');
        const follow = dom.querySelector('[data-chat-team-agent="forge"] [data-part="follow"] button')!;
        expect(follow.textContent?.trim()).toBe('Following');
    });

    it('the composer says the coordinator answers unless you @ someone', async () => {
        const dom = await mountRoute(CM2);
        expect(dom.querySelector('[data-scope="ai-composer"][data-part="hint"]')?.textContent).toBe('Atlas answers unless you @ someone');
    });
});
