import { describe, it, expect } from 'vitest';
import { NOBODY_HINT } from '@agentic/ui';
import { CHATS, loadChat, mentionedIn, resolveAddressing, type MockChatMember } from '../../src/mock/workspace';
import { topbarFor } from '../../src/components/topbar';
import { mountRoute, page, all, texts } from './mount';

const member = (agentId: string, coordinator = false): MockChatMember => ({ agentId, status: 'idle', coordinator, history: { access: 'all' } });

describe('/chats/:id (Chat)', () => {
    it('renders the three columns flush: chat list, conversation, members and tasks', async () => {
        const dom = await mountRoute('/chats/c1');
        const root = page(dom, 'chat')!;
        expect(root).not.toBeNull();
        expect(root.hasAttribute('data-flush')).toBe(true);
        expect(dom.querySelector('[data-chat-list]')?.getAttribute('aria-label')).toBe('Chats');
        expect(dom.querySelector('[data-chat-main]')?.getAttribute('aria-label')).toBe('Conversation');
        expect(dom.querySelector('[data-chat-context]')?.getAttribute('aria-label')).toBe('Members and tasks');
        // The current chat is marked in the list; the one with an open approval carries the amber pill.
        expect(dom.querySelector('[data-chat-row][data-current] [data-chat-title]')?.textContent).toBe('Mobile pass #47');
        expect(dom.querySelector('[data-chat-row][data-waiting] [data-scope="ag-pill"]')).not.toBeNull();
    });

    it('renders the transcript with attribution, tool cards with meta, the approval card with context rows, and the streaming pill', async () => {
        const dom = await mountRoute('/chats/c1');
        expect(texts(all(dom, 'ai-message', 'name'))).toEqual(['Andii', 'Atlas', 'Forge', 'Lint']);
        expect(all(dom, 'ai-message', 'environment').length).toBe(3);
        expect(texts(all(dom, 'ai-tool-call', 'meta'))).toContain('t_8f2c');
        expect(texts(all(dom, 'ai-tool-call', 'meta'))).toContain('+18 −6');
        const approval = dom.querySelector('[data-scope="ai-tool-call"] [data-scope="ai-approval"][data-part="root"]');
        expect(approval).not.toBeNull();
        expect(approval!.textContent).toContain('delegated by Atlas · task t_8f2c · depth 1');
        expect(approval!.textContent).toContain('alien01');
        expect(dom.querySelector('[data-scope="ag-pill"][data-status="streaming"]')).not.toBeNull();
    });

    it('resolves the composer "To" row by the four-case rule', async () => {
        const c1 = CHATS.find((c) => c.id === 'c1')!;
        // mentions ∩ members
        expect(resolveAddressing(c1.members, ['forge', 'nobody']).recipients.map((r) => r.name)).toEqual(['Forge']);
        expect(resolveAddressing(c1.members, ['forge', 'lint']).hint).toBe('Forge, Lint will answer');
        // else the coordinator
        const coordinator = resolveAddressing(c1.members, []);
        expect(coordinator.recipients.map((r) => `${r.name}:${r.role}`)).toEqual(['Atlas:coordinator']);
        expect(coordinator.hint).toBe('Atlas answers unless you @ someone');
        // else the single member
        const single = resolveAddressing([member('scout')], []);
        expect(single.recipients.map((r) => r.name)).toEqual(['Scout']);
        expect(single.hint).toBe('Scout answers');
        // else nobody
        expect(resolveAddressing([member('forge'), member('lint')], []).recipients).toEqual([]);
        // The draft's @Name tokens resolve case-insensitively, members only.
        expect(mentionedIn('@atlas and @Forge, not @scout', c1.members)).toEqual(['atlas', 'forge']);
    });

    it('renders the resolved recipients and hint in the composer, and the nobody hint when no one would answer', async () => {
        const dom = await mountRoute('/chats/c1');
        const addressing = dom.querySelector('[data-scope="ai-composer"][data-part="addressing"]')!;
        expect(addressing.textContent).toContain('Atlas');
        expect(addressing.textContent).toContain('coordinator');
        expect(addressing.textContent).toContain('Atlas answers unless you @ someone');
        const c4 = await mountRoute('/chats/c4');
        expect(c4.querySelector('[data-scope="ai-composer"][data-part="addressing"]')!.textContent).toContain(NOBODY_HINT);
    });

    it('lists the members with status, environment and history access, and the tasks in this chat', async () => {
        const page = await mountRoute('/chats/c1');
        // The panel renders inline (≥ 1280) and again inside the end drawer the topbar's tasks button opens below (#91).
        const dom = page.querySelector('[data-page="chat"] > [data-chat-context]')!;
        expect(dom).not.toBeNull();
        expect(page.querySelector('[data-context-drawer] [data-chat-context]')).not.toBeNull();
        expect(texts([...dom.querySelectorAll('[data-member-name]')])).toEqual(['Atlas', 'Forge', 'Lint']);
        expect(texts([...dom.querySelectorAll('[data-member-history]')])).toEqual(['Coordinator · sees all history', 'Sees all history', 'Added 14:02 · sees history from then']);
        expect(dom.querySelectorAll('[data-member] [data-scope="ag-env-line"][data-part="root"]')).toHaveLength(3);
        expect(dom.querySelectorAll('[data-mini-node]')).toHaveLength(3);
        expect(dom.querySelector('[data-privacy-note]')!.textContent).toContain('Membership shares the chat, not their memories.');
    });

    it('shows an empty chat as the composer only', async () => {
        const dom = await mountRoute('/chats/c6');
        expect(dom.querySelector('[data-scope="ai-thread"]')).toBeNull();
        expect(dom.querySelector('[data-chat-empty] [data-scope="ag-empty"]')).not.toBeNull();
        expect(dom.querySelector('[data-scope="ai-composer"][data-part="root"]')).not.toBeNull();
    });

    it('contributes the chat title as the breadcrumb label', () => {
        expect(topbarFor({ name: 'chat', path: '/chats/c1', params: { id: 'c1' } })?.crumb).toBe(loadChat('c1')!.chat.title);
    });

    it('renders the chat list at full width on /chats', async () => {
        const dom = await mountRoute('/chats');
        expect(page(dom, 'chats')).not.toBeNull();
        expect(dom.querySelector('[data-chat-list][data-wide]')).not.toBeNull();
        expect(dom.querySelectorAll('[data-chat-row]')).toHaveLength(CHATS.length);
    });
});
