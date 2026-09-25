/**
 * The project Chats (#731, PRJ-04): the group rules as pure functions, the page on mock data (groups, defaults strip,
 * search, Review and move), and the move on the live wire (`Chat.setProject`).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Chat, Workspace, workspaceKey } from '@agentic/platform';
import type { AgentId, ChatId, ProjectRecord, TaskId } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';
import { chatTasks, workingAgents } from '../../src/pages/chat/live';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { taskChips } from '../../src/pages/projects/chats/ProjectChats';
import { chatTaskSummaries, summaryOf } from '../../src/pages/projects/chats/tasks';
import { chatDefaults, chatGroupOf, defaultsTail, groupChats, matchesSearch, suggestedProject, unassignedChats, type ProjectChatRow } from '../../src/pages/projects/chats/groups';
import { mountRoute, tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const chat = (id: string, over: Partial<ProjectChatRow> = {}): ProjectChatRow => ({ id, title: id, lastLine: '', agentIds: [], waiting: false, working: false, updatedAt: 0, projectId: 'p1', work: [], ...over });

describe('the chat groups (#731)', () => {
    it('an open approval or question is Needs you, a running session Agents working, nothing Quiet; archived wins', () => {
        expect(chatGroupOf({ waiting: true, working: true })).toBe('needs-you');
        expect(chatGroupOf({ waiting: false, working: true })).toBe('working');
        expect(chatGroupOf({ waiting: false, working: false })).toBe('quiet');
        expect(chatGroupOf({ waiting: true, working: true, archived: true })).toBe('archived');
    });

    it('groups only the project’s chats, newest first, and filters by the search', () => {
        const chats = [
            chat('a', { waiting: true, updatedAt: 1 }),
            chat('b', { working: true, updatedAt: 2 }),
            chat('c', { updatedAt: 3, title: 'Drawer on tablets' }),
            chat('d', { updatedAt: 5 }),
            chat('e', { archived: true }),
            chat('f', { projectId: 'p2', waiting: true }),
            chat('g', { projectId: undefined })
        ];
        const g = groupChats(chats, 'p1');
        expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((c) => c.id)]))).toEqual({ 'needs-you': ['a'], working: ['b'], quiet: ['d', 'c'], archived: ['e'] });
        expect(groupChats(chats, 'p1', 'drawer TABLETS').quiet.map((c) => c.id)).toEqual(['c']);
        expect(matchesSearch({ title: 'x', lastLine: 'ship it', speaker: 'Forge' }, 'forge ship')).toBe(true);
        expect(matchesSearch({ title: 'x', lastLine: 'ship it' }, 'nope')).toBe(false);
    });

    it('a chat in no project suggests the project it names as a word', () => {
        const projects = [{ id: 'p1', name: 'agentic' }, { id: 'p2', name: 'docs-site' }];
        expect(suggestedProject({ title: 'Try it', lastLine: 'works with Agentic today' }, projects)?.id).toBe('p1');
        expect(suggestedProject({ title: 'agentically', lastLine: '' }, projects)).toBeUndefined();
        expect(suggestedProject({ title: 'the docs-site build', lastLine: '' }, projects)?.id).toBe('p2');
        const out = unassignedChats([chat('x', { projectId: undefined, updatedAt: 9 }), chat('y', { projectId: undefined, title: 'agentic nav' }), chat('z', { projectId: undefined, archived: true, title: 'agentic' }), chat('w')], projects, 'p1');
        expect(out.map((u) => [u.chat.id, u.suggested])).toEqual([['y', true], ['x', false]]);
    });

    it('the defaults strip names the folder, the coordinator, the members and the features with rules', () => {
        const project = {
            folders: { 'm:alien01': 'C:\\Dev\\agentic\\main' },
            members: { agentIds: ['forge', 'lint', 'atlas'], coordinator: 'atlas' },
            features: { 'agentic.feature.git': { instructions: 'Branch first.' }, 'agentic.feature.plan': {} }
        } as unknown as Pick<ProjectRecord, 'folders' | 'members' | 'features'>;
        const d = chatDefaults(project, (id) => id[0]!.toUpperCase() + id.slice(1));
        expect(d).toEqual({ folder: 'C:\\Dev\\agentic\\main', coordinator: 'Atlas', members: ['Forge', 'Lint'], rules: ['Git'] });
        expect(defaultsTail(d)).toBe('with Atlas coordinating, Forge and Lint on hand and the Git feature’s rules.');
        expect(defaultsTail({ coordinator: null, members: [], rules: [] })).toBe('with nobody on hand yet.');
        expect(chatDefaults({ folders: {}, members: { agentIds: [], coordinator: null }, features: {} } as unknown as ProjectRecord, (id) => id).folder).toBeNull();
    });

    it('a chat’s root tasks are chips, or their count past two', () => {
        expect(taskChips(['t1', 't2'])).toEqual([{ kind: 'task', id: 't1' }, { kind: 'task', id: 't2' }]);
        expect(taskChips(['t1', 't2', 't3', 't4'])).toEqual([{ kind: 'tasks', count: 4 }]);
    });
});

const task = (id: string, extra: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
    id: id as TaskId, objective: `do ${id}`, assignee: 'a1' as AgentId, owner: 'a1' as AgentId, status: 'active', origin: 'user', depth: 0, createdAt: 1000, updatedAt: 1000, n: 1, ...extra
});

describe('chat task summaries in one pass (#804)', () => {
    const rows: TaskIndexRow[] = [
        task('c1-old', { chatId: 'c1' as ChatId, status: 'completed', createdAt: 1 }),
        task('c1-old-kid', { parentId: 'c1-old' as TaskId, depth: 1, status: 'active', assignee: 'a2' as AgentId, createdAt: 2 }),
        task('c1-new', { chatId: 'c1' as ChatId, status: 'completed', createdAt: 5 }),
        task('c1-newest', { chatId: 'c1' as ChatId, status: 'failed', createdAt: 9 }),
        task('c2-root', { chatId: 'c2' as ChatId, status: 'waiting', wait: { kind: 'input', requestId: 'r1' }, createdAt: 3 }),
        task('c3-root', { chatId: 'c3' as ChatId, status: 'completed', createdAt: 4 }),
        task('c3-kid', { parentId: 'c3-root' as TaskId, depth: 1, status: 'completed', createdAt: 5 }),
        task('c3-grandkid', { parentId: 'c3-kid' as TaskId, depth: 2, status: 'waiting', wait: { kind: 'child', childTaskIds: [] }, createdAt: 6 }),
        task('orphan', { parentId: 'gone' as TaskId, depth: 1, status: 'active', createdAt: 7 }),
        task('loop-a', { parentId: 'loop-b' as TaskId, depth: 1, createdAt: 8 }),
        task('loop-b', { parentId: 'loop-a' as TaskId, depth: 1, createdAt: 8 })
    ];

    it('gives each chat the roots and working flag the per-chat reads give', () => {
        const summaries = chatTaskSummaries(rows);
        for (const chatId of ['c1', 'c2', 'c3', 'c4']) {
            const s = summaryOf(summaries, chatId);
            expect(s.roots).toEqual(chatTasks(rows, chatId, Number.POSITIVE_INFINITY).filter((t) => t.depth === 0).map((t) => t.id));
            expect(s.working).toBe(workingAgents(rows, chatId).size > 0);
        }
    });

    it('orders a still-running chain first, then newest, and reads a delegated child as work', () => {
        const summaries = chatTaskSummaries(rows);
        expect(summaryOf(summaries, 'c1')).toEqual({ roots: ['c1-old', 'c1-newest', 'c1-new'], working: true });
        expect(summaryOf(summaries, 'c2')).toEqual({ roots: ['c2-root'], working: false });
        expect(summaryOf(summaries, 'c3')).toEqual({ roots: ['c3-root'], working: true });
        expect(summaryOf(summaries, 'none')).toEqual({ roots: [], working: false });
        expect(chatTaskSummaries([]).size).toBe(0);
    });
});

const rowIds = (root: ParentNode, group: string): string[] => [...root.querySelectorAll<HTMLElement>(`[data-project-chat-group="${group}"] [data-project-chat-row]`)].map((el) => el.dataset.projectChatRow!);
const button = (root: ParentNode, label: string): HTMLButtonElement => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;

describe('the project Chats page on mock data (#731)', () => {
    it('groups the project’s chats by who acts next, archived collapsed, with the defaults strip', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats');
        expect(dom.querySelector('[data-stub]')).toBeNull();
        expect(rowIds(dom, 'needs-you')).toEqual(['pc1']);
        expect(rowIds(dom, 'working')).toEqual(['pc2', 'pc3']);
        expect(rowIds(dom, 'quiet')).toEqual(['pc4', 'pc5']);
        expect(rowIds(dom, 'archived')).toEqual([]);
        expect(dom.querySelector('[data-project-chats-counts]')!.textContent).toBe('5 open · 2 archived');
        const archived = dom.querySelector<HTMLButtonElement>('[data-project-chat-group="archived"] [data-project-chat-group-head]')!;
        expect(archived.getAttribute('aria-expanded')).toBe('false');
        archived.click();
        await tick();
        expect(rowIds(dom, 'archived')).toEqual(['pc6', 'pc7']);
        const strip = dom.querySelector('[data-project-chats-defaults]')!;
        expect(strip.textContent).toContain('C:\\Dev\\agentic\\main');
        expect(strip.textContent).toContain('Atlas coordinating');
        expect(strip.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic/settings/general');
        const pc2 = dom.querySelector('[data-project-chat-row="pc2"]')!;
        expect([...pc2.querySelectorAll('[data-work-chip]')].map((c) => c.textContent)).toEqual(['#603', 't_91a0']);
    });

    it('searches within the project', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats');
        const input = dom.querySelector<HTMLInputElement>('[data-project-chats-head] input[type="search"]')!;
        input.value = 'tablets';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(rowIds(dom, 'quiet')).toEqual(['pc4']);
        expect(dom.querySelector('[data-project-chat-group="needs-you"]')).toBeNull();
    });

    it('Review and move lists the chats in no project, suggested ones ticked, and moves them in', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats');
        const strip = dom.querySelector('[data-project-chats-unassigned]')!;
        expect(strip.textContent).toContain('3 chats aren’t in any project');
        expect(strip.textContent).toContain('“Try the new MCP inspector” and “Compare A2A clients” both mention agentic');
        button(strip, 'Review and move').click();
        await tick();
        const boxes = [...document.querySelectorAll<HTMLElement>('[data-move-chat]')];
        expect(boxes.map((b) => b.dataset.moveChat)).toEqual(['pc9', 'pc10', 'pc11']);
        document.querySelector('[data-project-chats-move]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        await tick();
        expect(rowIds(dom, 'quiet')).toEqual(['pc9', 'pc4', 'pc5', 'pc10']);
        expect(dom.querySelector('[data-project-chats-unassigned]')!.textContent).toContain('1 chat isn’t in any project');
        expect(document.querySelector('[data-project-chats-move]')).toBeNull();
    });
});

describe('the project Chats page live (#731)', () => {
    let h: LiveHarness | undefined;
    afterEach(async () => {
        projectHead.value = null;
        await h?.stop();
        h = undefined;
    });

    it('moves a chat in no project into this one with Chat.setProject', { timeout: 30_000 }, async () => {
        h = await startLive();
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({ title: 'Try agentic with MCP' });
        const dom = await mountLive(`/projects/${id}/chats`, h);
        await until(() => dom.querySelector('[data-project-chats-unassigned]') !== null, 'the unassigned strip');
        expect(dom.querySelector('[data-project-chats-unassigned]')!.textContent).toContain('mentions agentic');
        button(dom.querySelector('[data-project-chats-unassigned]')!, 'Review and move').click();
        await until(() => document.querySelector(`[data-move-chat="${chatId}"]`) !== null, 'the move dialog');
        document.querySelector('[data-project-chats-move]')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => rowIds(dom, 'quiet').includes(chatId), 'the chat in the project');
        expect((await h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId)).get()).projectId).toBe(id);
        expect(dom.querySelector('[data-project-chats-unassigned]')).toBeNull();
    });
});
