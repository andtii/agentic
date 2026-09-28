/**
 * The Team view's crew strip (#1109): a chip follows its agent, and clicking the selected chip again stops
 * following — the way a work card's `Following` does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { all, mountRoute, tick } from './mount';
import { clearViewPrefs } from './chat-view-prefs';

afterEach(clearViewPrefs);

const CM2 = '/projects/p_agentic/chats/cm2';

describe('Team crew strip (mock)', () => {
    it('the selected chip toggles following off', async () => {
        const dom = await mountRoute(CM2);
        all(dom, 'ai-crew', 'chip')[1]!.click();
        await tick();
        expect(all(dom, 'ai-crew', 'chip')[1]!.getAttribute('aria-pressed')).toBe('true');
        all(dom, 'ai-crew', 'chip')[1]!.click();
        await tick();
        expect(all(dom, 'ai-crew', 'chip')[1]!.getAttribute('aria-pressed')).not.toBe('true');
        expect(dom.querySelector('[data-chat-team-agent="forge"] [data-part="follow"] button')?.textContent?.trim()).not.toBe('Following');
    });
});
