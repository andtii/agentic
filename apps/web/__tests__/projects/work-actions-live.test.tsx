/**
 * Clearing the Work view on live data (#1040): a failed task's Dismiss clears it for every viewer and after a reload
 * (its TaskIndex row carries it) and Undo brings it back; Retry posts the brief again to the same agent in the same chat
 * and dismisses the failed one; a queued task's Stop cancels it once its Undo window closes; the work item page has the
 * same buttons.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, ChatId, MessageId, TaskId } from '@agentic/core';
import { TaskActor, TaskIndex, taskIndexKey, taskKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { closeWorkNotice, workHidden } from '../../src/pages/projects/work/actions';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    closeWorkNotice();
    workHidden.ids = [];
    projectHead.value = null;
    await h.stop();
});

async function project() {
    const agentId = (await h.agent('Forge', 'Builds things')) as AgentId;
    const defs = clientDefs();
    const { id: projectId } = await saveProjectWith(defs, USER, { name: 'agentic', members: { agentIds: [agentId], coordinator: agentId }, folders: {}, connectors: [], features: {} });
    const chatId = (await createChatWith(defs, USER, [agentId], agentId, projectId)) as ChatId;
    const task = (id: string) => h.app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
    const make = async (id: string, objective: string, status: 'failed' | 'queued') => {
        await task(id).create({ objective, origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        if (status === 'failed') {
            await task(id).start('router');
            await task(id).fail({ code: 'boom', message: 'it broke', recoverable: true }, 'router');
        }
    };
    return { agentId, projectId, chatId, task, make };
}

const rowOf = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-work-row="task:${id}"]`);
const button = (el: ParentNode | null, value: string) => el?.querySelector<HTMLButtonElement>(`button[name="work-action"][value="${value}"]`) ?? null;
const rows = () => h.app.as(owner).actor(TaskIndex, taskIndexKey(WS)).list();

describe('the Work view clears on live data (#1040)', () => {
    it('Dismiss clears a failed task for everyone and after a reload; Undo brings it back', { timeout: 30_000 }, async () => {
        const p = await project();
        await p.make('t_fail', 'fix the flaky test', 'failed');
        await p.make('t_other', 'bump the deps', 'failed');
        const dom = await mountLive(`/projects/${p.projectId}/work`, h);
        await until(() => rowOf(dom, 't_fail') !== null, 'the failed row', 10_000);
        expect(button(rowOf(dom, 't_fail'), 'retry')).not.toBeNull();
        button(rowOf(dom, 't_fail'), 'dismiss')!.click();
        await until(async () => (await p.task('t_fail').get()).dismissedAt !== undefined, 'the task dismissed');
        await until(() => rowOf(dom, 't_fail') === null && dom.querySelector('button[name="work-undo"]') !== null, 'the row gone, with Undo');
        // Another viewer, or a reload: the index row carries the dismissal.
        workHidden.ids = [];
        const again = await mountLive(`/projects/${p.projectId}/work`, h);
        await until(() => rowOf(again, 't_other') !== null, 'the Work view with its tasks', 10_000);
        expect((await rows()).find((r) => r.id === 't_fail')?.dismissedAt).toBeTypeOf('number');
        await until(() => rowOf(again, 't_fail') === null, 'the dismissed row out of the reloaded view', 8_000);
        // Undo.
        again.querySelector<HTMLButtonElement>('button[name="work-undo"]')!.click();
        await until(async () => (await p.task('t_fail').get()).dismissedAt === undefined, 'the dismissal undone');
        await until(() => rowOf(again, 't_fail') !== null, 'the row back', 10_000);
    });

    it('Retry starts the brief again for the same agent in the same chat and dismisses the failed task', { timeout: 30_000 }, async () => {
        const p = await project();
        await p.make('t_fail', 'write the release notes', 'failed');
        const dom = await mountLive(`/projects/${p.projectId}/work`, h);
        await until(() => rowOf(dom, 't_fail') !== null, 'the failed row', 10_000);
        button(rowOf(dom, 't_fail'), 'retry')!.click();
        await until(async () => (await p.task('t_fail').get()).dismissedAt !== undefined, 'the failed task dismissed', 10_000);
        const fresh = (await rows()).filter((r) => r.id !== 't_fail' && r.objective.includes('write the release notes'));
        expect(fresh).toHaveLength(1);
        expect(fresh[0]).toMatchObject({ assignee: p.agentId, chatId: p.chatId });
    });

    it('Stop cancels a queued task once its Undo window closes, and the item page has the buttons too', { timeout: 30_000 }, async () => {
        const p = await project();
        await p.make('t_queued', 'index the docs', 'queued');
        const item = await mountLive(`/projects/${p.projectId}/work/t_queued`, h);
        await until(() => button(item, 'stop') !== null, 'Stop on the work item page', 10_000);
        const dom = await mountLive(`/projects/${p.projectId}/work`, h);
        await until(() => rowOf(dom, 't_queued') !== null, 'the queued row', 10_000);
        button(rowOf(dom, 't_queued'), 'stop')!.click();
        await until(() => rowOf(dom, 't_queued') === null, 'the row gone');
        // Still undoable: nothing sent yet.
        expect((await p.task('t_queued').get()).status).toBe('queued');
        closeWorkNotice();
        await until(async () => (await p.task('t_queued').get()).status === 'cancelled', 'the task cancelled', 10_000);
    });
});
