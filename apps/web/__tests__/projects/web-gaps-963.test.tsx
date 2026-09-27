/**
 * #963: the audit round's small web gaps — the opened GitHub issue on the Requests detail and the chat's result card,
 * project Chats rows that load as mock chats, the mock composer's `#` / `pr:` ref sources, and a Plan board whose You
 * column holds only the viewer's items.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ChatId, PlanActor, PlanItem, ProjectId, ProjectMembers, ProjectRecord, ProjectRequest } from '@agentic/core';
import { MOCK_PROJECT_CHATS } from '../../src/mock/projects/chats';
import { PROJECTS, PROJECT_CHATS, loadChat, loadChats } from '../../src/mock/workspace';
import { RequestCard } from '../../src/pages/chat/entries/RequestCard';
import { mockChatRefs } from '../../src/pages/Chat';
import { boardColumns, columnOf, moveItem } from '../../src/pages/projects/features/plan/board/model';
import { issueLinkOf, type RequestEntry } from '../../src/pages/projects/requests/model';
import { RequestsView } from '../../src/pages/projects/requests/RequestsView';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, tick } from '../pages/mount';

const ISSUE = 'https://github.com/andtii/signalx/issues/57';
const accepted = (over: Partial<ProjectRequest> & { issueUrl?: string } = {}): ProjectRequest => ({
    id: 'req_1',
    fromProject: 'p_signalx' as ProjectId,
    fromChat: 'c_rings' as ChatId,
    sender: { kind: 'agent', agentId: 'forge' as AgentId },
    toProject: 'p_agentic' as ProjectId,
    title: 'batch() drops updates when an effect throws',
    body: '',
    refs: [],
    state: 'accepted',
    resultItem: 14,
    createdAt: 1,
    updatedAt: 9,
    ...over
} as ProjectRequest);

describe('the opened GitHub issue (#963, #932)', () => {
    it('issueLinkOf: a GitHub issue as owner/repo#n, another https URL as itself, nothing else', () => {
        expect(issueLinkOf(accepted({ issueUrl: ISSUE }))).toEqual({ href: ISSUE, label: 'andtii/signalx#57' });
        expect(issueLinkOf(accepted({ issueUrl: 'https://gitlab.example/x/-/issues/3' }))).toEqual({ href: 'https://gitlab.example/x/-/issues/3', label: 'https://gitlab.example/x/-/issues/3' });
        expect(issueLinkOf(accepted({ issueUrl: 'javascript:alert(1)' }))).toBeUndefined();
        expect(issueLinkOf(accepted())).toBeUndefined();
    });

    it('the Requests detail links the issue of an accepted request', async () => {
        const entry: RequestEntry = { request: accepted({ issueUrl: ISSUE }), box: 'incoming', fromProjectName: 'SignalX', toProjectName: 'agentic' };
        const dom = await mountAt('/projects/p_agentic/requests', (
            <RequestsView project={PROJECTS[0]! as ProjectRecord} entries={[entry]} manager="Atlas" names={(id: string) => ({ name: id })} you="you" phases={[]} now={10}
                onAccept={() => {}} onAskForMore={() => {}} onDecline={() => {}} />
        ));
        dom.querySelector<HTMLElement>('[data-requests-row="req_1"]')?.click();
        await tick();
        const link = dom.querySelector<HTMLAnchorElement>('[data-requests-outcome="accepted"] [data-requests-issue]');
        expect(link?.getAttribute('href')).toBe(ISSUE);
        expect(text(link)).toBe('andtii/signalx#57');
        expect(link?.getAttribute('rel')).toContain('noopener');
    });

    it('the sent card links it on the result card, and draws no link without one', async () => {
        const time = (at: number): string => `t${at}`;
        const withIssue = await mountAt('/chats/c_rings', <RequestCard request={accepted({ issueUrl: ISSUE })} part="result" toProjectName="agentic" managerName="Atlas" time={time} />);
        const link = withIssue.querySelector<HTMLAnchorElement>('[data-chat-request-result] [data-chat-request-issue]');
        expect(link?.getAttribute('href')).toBe(ISSUE);
        expect(text(link)).toBe('andtii/signalx#57');
        const without = await mountAt('/chats/c_rings', <RequestCard request={accepted()} part="result" toProjectName="agentic" managerName="Atlas" time={time} />);
        expect(without.querySelector('[data-chat-request-issue]')).toBeNull();
    });
});

describe('project Chats rows load as mock chats (#963, #929)', () => {
    it('every row is a loadable chat with the row’s project, title and last line', () => {
        expect(MOCK_PROJECT_CHATS.map((r) => r.id)).toEqual(PROJECT_CHATS.map((c) => c.id));
        for (const row of MOCK_PROJECT_CHATS) {
            const view = loadChat(row.id);
            expect(view?.chat.title).toBe(row.title);
            expect(view?.chat.projectId).toBe(row.projectId);
            expect(view?.transcript.messages.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: row.lastLine });
        }
        // The global chat list keeps its own sample.
        expect(loadChats().some((c) => c.id.startsWith('pc'))).toBe(false);
    });

    it('keeps the rows the board draws: speaker, working, archived and work chips', () => {
        const pc2 = MOCK_PROJECT_CHATS.find((r) => r.id === 'pc2')!;
        expect(pc2).toMatchObject({ speaker: 'Forge', working: true, waiting: false, work: [{ kind: 'pull', number: 603 }, { kind: 'task', id: 't_91a0' }] });
        expect(MOCK_PROJECT_CHATS.find((r) => r.id === 'pc4')!.speaker).toBe('You');
        expect(MOCK_PROJECT_CHATS.filter((r) => r.archived).map((r) => r.id)).toEqual(['pc6', 'pc7']);
    });

    it('opens a project chat inside the project instead of "Chat not found"', async () => {
        const dom = await mountRoute('/projects/p_agentic/chats/pc1');
        expect(dom.querySelector('[data-page="chat"] [data-chat-main]')).not.toBeNull();
        expect(dom.textContent).not.toContain('Chat not found');
        expect(dom.textContent).toContain('Should the plugin kind rename go under Breaking?');
    });
});

describe('the mock composer’s ref sources (#963, #940)', () => {
    it('lists the project’s plan items under # and its pull requests under pr:', () => {
        const refs = mockChatRefs('p_agentic');
        expect(refs.map((r) => r.prefix).sort()).toEqual(['#', 'pr:']);
        expect(refs.find((r) => r.prefix === '#')!.items.length).toBeGreaterThan(0);
        expect(refs.find((r) => r.prefix === 'pr:')!.items.length).toBeGreaterThan(0);
    });

    it('lists nothing outside a project or for a project with no ref features', () => {
        expect(mockChatRefs(undefined)).toEqual([]);
        expect(mockChatRefs('p_docs')).toEqual([]);
        expect(mockChatRefs('p_gone')).toEqual([]);
    });
});

describe('the Plan board’s You column (#963)', () => {
    const me: PlanActor = { kind: 'user', userId: 'u_me' };
    const other: PlanActor = { kind: 'user', userId: 'u_other' };
    const members: ProjectMembers = { agentIds: ['forge'] as AgentId[], coordinator: null };
    const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `Item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
    const items = [item(1, { assignee: me, queueIndex: 0 }), item(2, { assignee: other, queueIndex: 0 }), item(3)];

    it('columnOf: the viewer’s items are You, another person’s are theirs', () => {
        expect(columnOf(items[0]!, 'u_me')).toBe('you');
        expect(columnOf(items[1]!, 'u_me')).toBe('user:u_other');
        // No viewer known: every person counts as You.
        expect(columnOf(items[1]!)).toBe('you');
    });

    it('boardColumns: You holds only the viewer’s items', () => {
        const you = boardColumns(items, members, 0, 'u_me').find((c) => c.key === 'you')!;
        expect(you.queue.map((i) => i.id)).toEqual([1]);
        const signedOut = boardColumns(items, members, 0, '').find((c) => c.key === 'you')!;
        expect(signedOut.queue).toEqual([]);
    });

    it('moveItem: taking an item into You renumbers only the viewer’s queue', () => {
        const next = moveItem(items, 3, { column: 'you', index: 0 }, { you: me, at: 1 });
        expect(next.find((i) => i.id === 3)).toMatchObject({ assignee: me, queueIndex: 0 });
        expect(next.find((i) => i.id === 1)!.queueIndex).toBe(1);
        expect(next.find((i) => i.id === 2)!.queueIndex).toBe(0);
    });
});
