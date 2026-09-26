/**
 * The project Overview on live data (#933): Your move from the project's `your-move` work items, the recent chats as
 * project Chats rows, and the project's schedules — each filled over the real actor wire, the empty lines for a
 * project with nothing, and skeleton rows (never the empty line) while a card waits for its first read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ProjectId, WorkItem } from '@agentic/core';
import { Chat, Workspace, definePlanActor, defineScheduleActor, planKey, scheduleTrigger, workspaceKey, type ScheduleView } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { MOCK_EVENT_PROJECT } from '../../src/mock/projects/overview';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { OverviewView } from '../../src/pages/projects/overview/Overview';
import { overviewChatOf, overviewChatsOf, overviewMovesOf, overviewSchedulesOf } from '../../src/pages/projects/overview/live';
import { EMPTY_OVERVIEW } from '../../src/pages/projects/overview/model';
import type { ProjectChatRow } from '../../src/pages/projects/chats/groups';
import { mountAt } from '../pages/helpers';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

const item = (over: Partial<WorkItem>): WorkItem => ({ id: 'task:t1', title: 'T', stages: ['Ready', 'Do'], stage: 0, stageState: 'needs-you', owner: { kind: 'you' }, nextStep: 'Answer', group: 'your-move', updatedAt: 1, ...over } as WorkItem);
const chatRow = (over: Partial<ProjectChatRow>): ProjectChatRow => ({ id: 'c1', title: 'C', lastLine: 'Forge: on it', agentIds: ['forge'], waiting: false, working: false, updatedAt: 1, projectId: 'p1', work: [], ...over });

describe('the live Overview adapters (#933)', () => {
    it('keeps the your-move work items, newest first, linked to their work item pages', () => {
        const moves = overviewMovesOf([
            item({ id: 'task:t1', taskId: 't1' as WorkItem['taskId'], updatedAt: 1 }),
            item({ id: 'pr:7', pull: 7, updatedAt: 3 }),
            item({ id: 'item:4', itemRef: '#4', updatedAt: 2 }),
            item({ id: 'task:t2', group: 'agents', updatedAt: 9 })
        ], 'p1');
        expect(moves.map((m) => [m.id, m.ref, m.href])).toEqual([
            ['pr:7', '#7', '/projects/p1/work/pr:7'],
            ['item:4', '#4', '/projects/p1/work/item:4'],
            ['task:t1', 't1', '/projects/p1/work/t1']
        ]);
    });

    it('draws a chat row with its pill, speaker, members and linked work; drops archived and other projects', () => {
        expect(overviewChatOf(chatRow({ waiting: true, work: [{ kind: 'task', id: 't1' }, { kind: 'pull', number: 3 }] }))).toMatchObject({
            state: 'needs-you', lastBy: 'Forge', lastLine: 'on it', members: ['forge'], links: [{ label: 't1', icon: 'check' }, { label: '#3', icon: 'branch' }]
        });
        expect(overviewChatOf(chatRow({ working: true, lastLine: 'Forge joined' }))).toMatchObject({ state: 'working', lastLine: 'Forge joined' });
        expect(overviewChatOf(chatRow({ lastLine: 'Forge joined' })).lastBy).toBeUndefined();
        const rows = [chatRow({ id: 'a', updatedAt: 1 }), chatRow({ id: 'b', updatedAt: 5 }), chatRow({ id: 'x', archived: true }), chatRow({ id: 'y', projectId: 'p2' })];
        expect(overviewChatsOf(rows, 'p1').map((c) => c.id)).toEqual(['b', 'a']);
    });

    it("keeps the project's schedules with their next run", () => {
        const view = (id: string, projectId?: string): ScheduleView => ({ id, kind: 'agent-task', title: id, recurrence: { kind: 'at', at: 0 }, enabled: true, next: Date.UTC(2026, 8, 18, 12), agentId: 'forge', ...(projectId ? { projectId } : {}) } as unknown as ScheduleView);
        expect(overviewSchedulesOf([view('s1', 'p1'), view('s2'), view('s3', 'p2')], 'p1', 'UTC', Date.UTC(2026, 8, 18, 9))).toEqual([{ id: 's1', title: 's1', agentId: 'forge', next: 'today 12:00' }]);
    });
});

describe('the Overview while loading (#933)', () => {
    it('draws skeleton rows, never the empty lines, before the data arrives', async () => {
        const dom = await mountAt('/projects/p_event', <OverviewView project={MOCK_EVENT_PROJECT} data={EMPTY_OVERVIEW} names={(id) => ({ name: id })} views={() => undefined} loading={{ moves: true, chats: true, schedules: true }} />);
        expect(dom.querySelectorAll('[data-overview-empty]')).toHaveLength(0);
        expect(dom.querySelectorAll('[data-overview-loading] [data-skeleton]')).toHaveLength(3);
    });
});

describe('the Overview live (#933)', () => {
    let h: LiveHarness | undefined;
    const Plan = definePlanActor();
    const Schedule = defineScheduleActor({ trigger: scheduleTrigger() });
    afterEach(async () => {
        projectHead.value = null;
        await h?.stop();
        h = undefined;
    });

    it('fills Your move, Chats and Schedules from the project', { timeout: 30_000 }, async () => {
        h = await startLive(undefined, { actors: [Plan, Schedule] });
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const plan = await h.app.as(owner).actor(Plan, planKey(WS, id as ProjectId)).create({ title: 'Mobile', phases: [{ title: 'Shell', items: [{ title: 'Collapse the rail' }] }] });
        const first = plan.phases[0]!.items[0]!;
        await h.app.as(owner).actor(Plan, planKey(WS, id as ProjectId)).update(first.id, { state: 'needs-you', note: 'Which breakpoint?' });
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const { chatId: inside } = await ws.createChat({ title: 'Nav work' });
        await ws.createChat({ title: 'Elsewhere' });
        await h.app.as(owner).actor(Chat, chatKeyOf(USER, inside)).setProject(id as ProjectId);
        const at = Date.now() + 86_400_000;
        const { scheduleId: mine } = await ws.createSchedule();
        await h.app.as(owner).actor(Schedule, `${WS}:schedule:${mine}`).create({ kind: 'agent-task', title: 'Nightly triage', prompt: 'Triage', recurrence: { kind: 'at', at }, agentId: forge, projectId: id as ProjectId });
        const { scheduleId: other } = await ws.createSchedule();
        await h.app.as(owner).actor(Schedule, `${WS}:schedule:${other}`).create({ kind: 'reminder', title: 'Not this project', recurrence: { kind: 'at', at } });

        const dom = await mountLive(`/projects/${id}`, h);
        const card = (name: string) => dom.querySelector(`[data-overview-card="${name}"]`)!;
        await until(() => card('move')?.querySelectorAll('[data-overview-move]').length === 1, 'the your-move item', 10_000);
        expect(card('move').querySelector('[data-overview-row-title]')?.textContent).toBe('Collapse the rail');
        expect(card('move').querySelector('[data-overview-move] a')!.getAttribute('href')).toBe(`/projects/${id}/work/item:${first.id}`);
        await until(() => card('chats').querySelectorAll('[data-overview-chat]').length === 1, 'the project chat', 10_000);
        expect(card('chats').querySelector('[data-overview-chat]')!.getAttribute('data-overview-chat')).toBe(inside);
        expect(card('chats').querySelector('[data-overview-row-title]')?.textContent).toBe('Nav work');
        expect(card('chats').querySelector('[data-overview-card-aside] a')?.textContent).toBe('All 1 chats →');
        await until(() => card('schedules').querySelectorAll('[data-overview-schedule]').length === 1, 'the project schedule', 10_000);
        expect(texts(card('schedules').querySelectorAll('[data-overview-schedule] [data-overview-row-title]'))).toEqual(['Nightly triage']);
        expect(card('schedules').querySelector('[data-overview-v]')?.textContent).toMatch(/^tomorrow \d\d:\d\d$/);
        expect(dom.querySelectorAll('[data-overview-empty]')).toHaveLength(0);
    });

    it('says the empty lines for a project with nothing', { timeout: 30_000 }, async () => {
        h = await startLive(undefined, { actors: [Plan, Schedule] });
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'quiet', members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features: {} });
        const dom = await mountLive(`/projects/${id}`, h);
        await until(() => dom.querySelectorAll('[data-overview-empty]').length === 3, 'the empty lines', 10_000);
        expect(texts(dom.querySelectorAll('[data-overview-empty]'))).toEqual(['Nothing needs you here.', 'No chats in this project yet.', 'No schedules in this project.']);
        expect(dom.querySelectorAll('[data-overview-loading]')).toHaveLength(0);
    });
});
