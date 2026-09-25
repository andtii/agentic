/**
 * `/chats` grouped by project (#732, PRJ-04): the pure `groupChatsByProject`, and the wide list's
 * collapsible group headers on the mock workspace.
 */
import { describe, it, expect } from 'vitest';
import { groupChatsByProject } from '../../src/pages/chat/chat-groups';
import { CHATS, PROJECTS, type MockChatSummary } from '../../src/mock/workspace';
import { mountRoute, texts, tick } from '../pages/mount';

const chat = (id: string, updatedAt: number, projectId?: string): MockChatSummary => ({
    id, title: id, members: [], lastLine: '', unread: 0, waiting: false, updatedAt, ...(projectId ? { projectId } : {})
});
const projects = [{ id: 'pa', name: 'Alpha' }, { id: 'pb', name: 'Beta' }, { id: 'pc', name: 'Gamma' }];

describe('groupChatsByProject', () => {
    it('orders projects by their newest chat and puts "No project" last, keeping the chats in input order', () => {
        const groups = groupChatsByProject([chat('c1', 50), chat('c2', 10, 'pa'), chat('c3', 40, 'pb'), chat('c4', 30, 'pa'), chat('c5', 5)], projects);
        expect(groups.map((g) => g.key)).toEqual(['pb', 'pa', null]);
        expect(groups.map((g) => g.chats.map((c) => c.id))).toEqual([['c3'], ['c2', 'c4'], ['c1', 'c5']]);
        expect(groups.map((g) => g.lastActivityAt)).toEqual([40, 30, 50]);
        expect(groups[0]!.project).toEqual(projects[1]);
        expect(groups[2]!.project).toBeUndefined();
    });

    it('leaves out projects without chats and counts a chat in an unknown project as in none', () => {
        const groups = groupChatsByProject([chat('c1', 1, 'gone'), chat('c2', 2, 'pc')], projects);
        expect(groups.map((g) => [g.key, g.chats.map((c) => c.id)])).toEqual([['pc', ['c2']], [null, ['c1']]]);
    });

    it('breaks a tie in activity by project name, and has no "No project" group when every chat is in one', () => {
        const groups = groupChatsByProject([chat('c1', 7, 'pb'), chat('c2', 7, 'pa')], projects);
        expect(groups.map((g) => g.key)).toEqual(['pa', 'pb']);
        expect(groupChatsByProject([], projects)).toEqual([]);
    });
});

describe('/chats grouped by project (mock)', () => {
    it('draws one collapsible group per project with its square and a link to its Chats page, "No project" last', async () => {
        const dom = await mountRoute('/chats');
        const expected = groupChatsByProject(CHATS, PROJECTS);
        const sections = [...dom.querySelectorAll<HTMLElement>('[data-chat-list][data-wide] [data-chat-group]')];
        expect(sections.map((s) => s.getAttribute('data-chat-group'))).toEqual(expected.map((g) => g.key ?? '-'));
        expect(sections.at(-1)!.querySelector('[data-chat-group-name]')!.textContent).toBe('No project');
        const first = sections[0]!;
        expect(first.querySelector('[data-ag-project="square"]')).not.toBeNull();
        expect(first.querySelector('[data-chat-group-name] a')!.getAttribute('href')).toBe(`/projects/${expected[0]!.key}/chats`);
        expect(texts([...first.querySelectorAll('[data-chat-title]')])).toEqual(expected[0]!.chats.map((c) => c.title));
        expect(dom.querySelectorAll('[data-chat-row]')).toHaveLength(CHATS.length);

        const toggle = first.querySelector<HTMLButtonElement>('[data-chat-group-toggle]')!;
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        toggle.click();
        await tick();
        const collapsed = dom.querySelector<HTMLElement>(`[data-chat-group="${expected[0]!.key}"]`)!;
        expect(collapsed.querySelector('[data-chat-group-toggle]')!.getAttribute('aria-expanded')).toBe('false');
        expect(collapsed.querySelectorAll('[data-chat-row]')).toHaveLength(0);
        collapsed.querySelector<HTMLButtonElement>('[data-chat-group-toggle]')!.click();
        await tick();
        expect(dom.querySelectorAll('[data-chat-row]')).toHaveLength(CHATS.length);
    });

    it('keeps the column beside a chat one flat list', async () => {
        const dom = await mountRoute('/chats/c1');
        expect(dom.querySelector('[data-chat-list] [data-chat-group]')).toBeNull();
        expect(dom.querySelectorAll('[data-chat-list] [data-chat-row]')).toHaveLength(CHATS.length);
    });
});
