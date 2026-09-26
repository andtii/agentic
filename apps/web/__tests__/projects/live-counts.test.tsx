/**
 * Live counts (#934): a `projectSummaries` line becomes the project menu's counts (Work with its needs-you badge, the
 * Plan section, Requests) and an index card's pills and `Next:` line; QUIET only when both counts are known to be 0.
 * The unassigned strip counts tasks, and `/chats?project=none` (its Show link) opens the list on chats in no project.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectRecord } from '@agentic/core';
import { CHATS, PROJECTS } from '../../src/mock/workspace';
import { cardPills, unassignedText } from '../../src/pages/projects/index/model';
import { liveCard, liveUnassigned } from '../../src/pages/projects/index/ProjectsIndex';
import { countsFor, countsOfLine, PLAN_FEATURE } from '../../src/pages/projects/layout/counts';
import { matchingChats, NO_PROJECT } from '../../src/pages/chat/ChatList';
import { mountRoute } from '../pages/mount';

const project = { id: 'p1', name: 'One' } as unknown as ProjectRecord;
const NOW = 1_000_000_000;

describe('menu counts from a summary line (#934)', () => {
    it('Work counts its open items and badges your move; Plan and Requests carry theirs', () => {
        const line = { projectId: 'p1', openChats: 4, work: { yourMove: 2, agentsOnIt: 3, waiting: 1, next: ['merge #7'] }, openPlanItems: 9, requestsNeedYou: 1 };
        expect(countsOfLine(line)).toEqual({ chats: 4, work: 6, needsYou: 2, features: { [PLAN_FEATURE]: 9 }, requests: 1 });
        expect(countsFor('p1', [line])).toEqual(countsOfLine(line));
    });

    it('leaves out what the summary could not read', () => {
        expect(countsOfLine({ projectId: 'p1', openChats: 0 })).toEqual({ chats: 0 });
        expect(countsOfLine({ projectId: 'p1', openChats: 1, openPlanItems: 0 })).toEqual({ chats: 1, features: { [PLAN_FEATURE]: 0 } });
    });
});

describe('index cards from a summary line (#934)', () => {
    it('shows the pills and the next moves', () => {
        const card = liveCard(project, { openChats: 3, work: { yourMove: 3, agentsOnIt: 1, next: ['merge #602', 'review #598', 'decide #605'] } }, NOW);
        expect(card.next).toBe('Next: merge #602 · review #598 · decide #605');
        expect(cardPills(card).map((p) => p.label)).toEqual(['3 YOUR MOVE', '1 AGENT ON IT']);
    });

    it('is QUIET only when both counts are known to be 0, and falls back to the chats line', () => {
        const quiet = liveCard(project, { openChats: 2, lastActivityAt: NOW - 60_000, work: { yourMove: 0, agentsOnIt: 0, next: [] } }, NOW);
        expect(cardPills(quiet).map((p) => p.label)).toEqual(['QUIET']);
        expect(quiet.next).toMatch(/^2 open chats · active /);
        const unknown = liveCard(project, { openChats: 2 }, NOW);
        expect(cardPills(unknown)).toEqual([]);
        expect(unknown.next).toBe('2 open chats');
        expect(liveCard(project, undefined, NOW)).toEqual({ project });
    });

    it('the unassigned strip counts tasks once the task index was read', () => {
        expect(unassignedText(liveUnassigned({ openChats: 2, openTasks: 1 }))).toBe('2 chats and 1 task are not in a project');
        expect(liveUnassigned({ openChats: 2 })).toEqual({ chats: 2 });
    });
});

describe('/chats?project=none (#934)', () => {
    it('keeps the chats in no project, or in one the workspace no longer has', () => {
        const chats = [{ id: 'a' }, { id: 'b', projectId: 'p1' }, { id: 'c', projectId: 'gone' }].map((c) => ({ title: c.id, lastLine: '', ...c })) as never[];
        expect(matchingChats(chats, '', NO_PROJECT, new Set(['p1'])).map((c: { id: string }) => c.id)).toEqual(['a', 'c']);
    });

    it('opens the list on "No project"', async () => {
        const dom = await mountRoute('/chats?project=none');
        const known = new Set<string>(PROJECTS.map((p) => p.id));
        const loose = CHATS.filter((c) => !c.projectId || !known.has(c.projectId));
        expect(loose.length).toBeGreaterThan(0);
        expect(loose.length).toBeLessThan(CHATS.length);
        const titles = [...dom.querySelectorAll('[data-chat-rows]:not(#chat-group-archived) [data-chat-title]')].map((e) => e.textContent);
        expect(titles.length).toBeGreaterThan(0);
        for (const t of titles) expect(loose.map((c) => c.title)).toContain(t);
    });
});
