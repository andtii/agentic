/**
 * Clearing the Work view (#1040, PRJ-05, COL-12): a failed task row offers Retry and Dismiss, a queued, running or
 * waiting one Stop. Dismissed tasks and failed ones older than a week leave the view; the row actions hold a row off
 * the board while their Undo counts down; live, Dismiss is recorded on the task (every viewer, every reload), Stop
 * cancels it and Retry starts the same brief for the same agent in the same project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, ChatId, MessageId, TaskId, TaskStatus } from '@agentic/core';
import { TaskActor, TaskIndex, taskIndexKey, taskKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { createWorkActions, type WorkActionPorts, type WorkNotifier } from '../../src/pages/projects/work/actions';
import { workTaskOf } from '../../src/pages/projects/work/live';
import { WEEK_MS, workActionsOf, workItemsOf, type WorkFeatures, type WorkTask } from '../../src/pages/projects/work/model';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const plain: WorkFeatures = { enabled: [], uiOf: () => undefined };
const task = (id: string, more: Partial<WorkTask> = {}): WorkTask => ({ id: id as TaskId, title: id, status: 'failed', assignee: 'forge' as AgentId, updatedAt: NOW - 60_000, ...more });

describe('the Work model clears failures (#1040)', () => {
    it('leaves out dismissed tasks and failed ones older than a week', () => {
        const items = workItemsOf([task('t_fresh'), task('t_dismissed', { dismissedAt: NOW }), task('t_old', { updatedAt: NOW - WEEK_MS - 1 })], [], [], plain, NOW);
        expect(items.map((i) => i.id)).toEqual(['task:t_fresh']);
        expect(items[0]!.group).toBe('your-move');
    });

    it('a failed row offers Retry and Dismiss, work in flight Stop, anything else nothing', () => {
        const actions = (status: TaskStatus, more: { pull?: number } = {}) => {
            const t = task('t1', { status });
            return workActionsOf({ taskId: t.id, ...more }, t);
        };
        expect(actions('failed')).toEqual(['retry', 'dismiss']);
        expect(actions('queued')).toEqual(['stop']);
        expect(actions('active')).toEqual(['stop']);
        expect(actions('waiting')).toEqual(['stop']);
        expect(actions('completed')).toEqual([]);
        expect(actions('failed', { pull: 5 })).toEqual([]);
        expect(workActionsOf({}, undefined)).toEqual([]);
    });

    it('workTaskOf carries the row’s dismissedAt', () => {
        const row = { id: 't1' as TaskId, objective: 'x', status: 'failed' as const, assignee: 'a' as AgentId, updatedAt: 5 };
        expect(workTaskOf({ ...row, dismissedAt: 9 }).dismissedAt).toBe(9);
        expect('dismissedAt' in workTaskOf(row)).toBe(false);
    });
});

describe('createWorkActions (#1040)', () => {
    let shown: { id: string; title?: string; onUndo?: () => void }[];
    let closed: string[];
    const notifier: WorkNotifier = {
        show: (o) => {
            const id = `toast${shown.length}`;
            shown.push({ id, ...(o.title ? { title: o.title } : {}), ...(o.action?.onClick ? { onUndo: o.action.onClick } : {}) });
            return id;
        },
        close: (id) => { closed.push(id); }
    };
    const ports = (): WorkActionPorts & { calls: string[] } => {
        const calls: string[] = [];
        return {
            calls,
            cancel: async (id) => { calls.push(`cancel ${id}`); },
            dismiss: async (id) => { calls.push(`dismiss ${id}`); },
            undismiss: async (id) => { calls.push(`undismiss ${id}`); },
            retry: async (id) => { calls.push(`retry ${id}`); }
        };
    };
    const t1 = { id: 't1', title: 'Fix the build' };

    beforeEach(() => {
        shown = [];
        closed = [];
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    it('Stop hides the row at once and cancels only when the Undo runs out', async () => {
        const actions = createWorkActions({ notifier, undoMs: 1_000 });
        const p = ports();
        await actions.run('stop', t1, p);
        expect(actions.hidden('t1')).toBe(true);
        expect(shown[0]!.title).toBe('Stopped “Fix the build”');
        expect(p.calls).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(p.calls).toEqual(['cancel t1']);
        expect(actions.hidden('t1')).toBe(true);
    });

    it('Undo on a Stop brings the row back and never cancels', async () => {
        const actions = createWorkActions({ notifier, undoMs: 1_000 });
        const p = ports();
        await actions.run('stop', t1, p);
        shown[0]!.onUndo!();
        expect(actions.hidden('t1')).toBe(false);
        expect(closed).toEqual(['toast0']);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(p.calls).toEqual([]);
    });

    it('flush sends a Stop still counting down', async () => {
        const actions = createWorkActions({ notifier, undoMs: 1_000 });
        const p = ports();
        await actions.run('stop', t1, p);
        actions.flush();
        expect(p.calls).toEqual(['cancel t1']);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(p.calls).toEqual(['cancel t1']);
    });

    it('Dismiss is recorded at once; Undo takes it back', async () => {
        const actions = createWorkActions({ notifier });
        const p = ports();
        await actions.run('dismiss', t1, p);
        expect(p.calls).toEqual(['dismiss t1']);
        expect(actions.hidden('t1')).toBe(true);
        shown[0]!.onUndo!();
        await vi.advanceTimersByTimeAsync(0);
        expect(p.calls).toEqual(['dismiss t1', 'undismiss t1']);
        expect(actions.hidden('t1')).toBe(false);
    });

    it('Retry starts the new task, then dismisses the failed one', async () => {
        const actions = createWorkActions({ notifier });
        const p = ports();
        await actions.run('retry', t1, p);
        expect(p.calls).toEqual(['retry t1', 'dismiss t1']);
        expect(actions.hidden('t1')).toBe(true);
        expect(actions.busy('t1')).toBe(false);
    });

    it('a Retry whose dismiss fails keeps the failure on Work and says so', async () => {
        const actions = createWorkActions({ notifier });
        const p = { ...ports(), dismiss: async () => { throw new Error('offline'); } };
        expect(await actions.run('retry', t1, p)).toBe(true);
        expect(actions.hidden('t1')).toBe(false);
        expect(actions.busy('t1')).toBe(false);
        expect(shown.at(-1)!.title).toBe('Retrying “Fix the build” — the failed task could not be dismissed');
    });

    it('a row counting down a Stop takes no second action', async () => {
        const actions = createWorkActions({ notifier, undoMs: 1_000 });
        const p = ports();
        expect(await actions.run('stop', t1, p)).toBe(true);
        expect(await actions.run('stop', t1, p)).toBe(false);
    });

    it('a failed call brings the row back and says why', async () => {
        const actions = createWorkActions({ notifier });
        const p = { ...ports(), dismiss: async () => { throw new Error('offline'); } };
        await actions.run('dismiss', t1, p);
        expect(actions.hidden('t1')).toBe(false);
        expect(shown.at(-1)!.title).toBe('Could not dismiss “Fix the build”');
    });
});

describe('the row actions on live data (#1040)', () => {
    let h: LiveHarness;
    beforeEach(async () => {
        h = await startLive();
    });
    afterEach(async () => {
        projectHead.value = null;
        await h.stop();
    });

    const setup = async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const defs = clientDefs();
        const { id: projectId } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const chatId = await createChatWith(defs, USER, [forge], forge, projectId);
        const make = async (id: string, objective: string) => {
            const t = h.app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
            await t.create({ objective, origin: { kind: 'user', chatId: chatId as ChatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
            return t;
        };
        return { forge, projectId, make };
    };
    const button = (dom: HTMLElement, taskId: string, label: string) =>
        [...dom.querySelectorAll<HTMLButtonElement>(`[data-work-row="task:${taskId}"] [data-work-actions] button`)].find((b) => b.textContent?.trim() === label);

    it('Dismiss clears a failed task for every viewer and after a reload', { timeout: 30_000 }, async () => {
        const { projectId, make } = await setup();
        const failed = await make('t_failed', 'Fix the flaky test');
        await failed.start('router');
        await failed.fail({ code: 'runtime', message: 'boom', recoverable: false }, 'router');

        const dom = await mountLive(`/projects/${projectId}/work`, h);
        await until(() => !!button(dom, 't_failed', 'Dismiss'), 'the failed row with its actions', 10_000);
        expect(button(dom, 't_failed', 'Retry')).toBeDefined();
        button(dom, 't_failed', 'Dismiss')!.click();
        await until(() => !dom.querySelector('[data-work-row="task:t_failed"]'), 'the row to leave', 10_000);
        await until(async () => (await failed.get()).dismissedAt !== undefined, 'the dismissal on the task', 10_000);

        // Another tab (a fresh mount reads the index again): still gone, and the task page keeps its history.
        const again = await mountLive(`/projects/${projectId}/work`, h);
        await until(() => (again.textContent ?? '').includes('Nothing waits on you.'), 'the other tab', 10_000);
        expect(again.querySelector('[data-work-row="task:t_failed"]')).toBeNull();
        expect((await failed.get()).status).toBe('failed');
    });

    it('Stop cancels a queued task and its row goes', { timeout: 30_000 }, async () => {
        const { projectId, make } = await setup();
        const queued = await make('t_queued', 'Never started');
        const dom = await mountLive(`/projects/${projectId}/work`, h);
        await until(() => !!button(dom, 't_queued', 'Stop'), 'the queued row with Stop', 10_000);
        button(dom, 't_queued', 'Stop')!.click();
        await until(() => !dom.querySelector('[data-work-row="task:t_queued"]'), 'the row to leave', 5_000);
        await until(async () => (await queued.get()).status === 'cancelled', 'the task cancelled after the Undo window', 15_000);
    });

    it('Retry starts the same brief for the same agent in the project and dismisses the failure', { timeout: 30_000 }, async () => {
        const { forge, projectId, make } = await setup();
        const failed = await make('t_retry', 'Write the release notes');
        await failed.start('router');
        await failed.fail({ code: 'runtime', message: 'boom', recoverable: false }, 'router');

        const dom = await mountLive(`/projects/${projectId}/work`, h);
        await until(() => !!button(dom, 't_retry', 'Retry'), 'the failed row with Retry', 10_000);
        button(dom, 't_retry', 'Retry')!.click();
        const index = h.app.as(owner).actor(TaskIndex, taskIndexKey(WS));
        await until(async () => (await index.list()).some((r) => r.id !== 't_retry' && r.objective === 'Write the release notes'), 'the new task', 15_000);
        const fresh = (await index.list()).find((r) => r.id !== 't_retry' && r.objective === 'Write the release notes')!;
        expect(fresh.assignee).toBe(forge);
        await until(async () => (await failed.get()).dismissedAt !== undefined, 'the failure dismissed', 10_000);
        // The new task is the project's: it shows on this Work view.
        await until(() => !!dom.querySelector(`[data-work-row="task:${fresh.id}"]`), 'the new task on Work', 10_000);
    });

    it('the work item page shows the same actions, and Dismiss goes back to Work', { timeout: 30_000 }, async () => {
        const { projectId, make } = await setup();
        const failed = await make('t_item', 'Bump the deps');
        await failed.start('router');
        await failed.fail({ code: 'runtime', message: 'boom', recoverable: false }, 'router');
        const queued = await make('t_item_q', 'Queued work');

        const dom = await mountLive(`/projects/${projectId}/work/t_item`, h);
        const labels = (root: HTMLElement) => [...root.querySelectorAll('[data-work-item-head] [data-work-actions] button')].map((b) => b.textContent?.trim());
        await until(() => labels(dom).length > 0, 'the item page actions', 10_000);
        expect(labels(dom)).toEqual(['Retry', 'Dismiss']);
        const q = await mountLive(`/projects/${projectId}/work/t_item_q`, h);
        await until(() => labels(q).length > 0, 'the queued item page actions', 10_000);
        expect(labels(q)).toEqual(['Stop']);
        expect((await queued.get()).status).toBe('queued');

        [...dom.querySelectorAll<HTMLButtonElement>('[data-work-item-head] [data-work-actions] button')].find((b) => b.textContent?.trim() === 'Dismiss')!.click();
        await until(() => !!dom.querySelector('[data-page="project-work"]'), 'back on Work', 10_000);
        await until(async () => (await failed.get()).dismissedAt !== undefined, 'the dismissal on the task', 10_000);
    });
});
