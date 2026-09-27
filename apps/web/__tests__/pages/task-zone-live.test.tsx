/**
 * The live task page's times follow the workspace's zone (#155): the
 * transitions timeline formats each `at` in `Workspace.settings.timeZone`,
 * not the mock workspace's fixed Stockholm clock.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MessageId, TaskId } from '@agentic/core';
import { TaskActor, Workspace, taskKey, workspaceKey } from '@agentic/platform';
import { zoneFormat } from '../../src/time';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({ respond: () => [{ text: 'done' }] });
});
afterEach(async () => {
    await h.stop();
});

const times = (dom: ParentNode) => [...dom.querySelectorAll('[data-timeline-time]')].map((t) => t.textContent);

describe('/tasks/:id (live): times in the workspace zone', () => {
    it('lists each transition at its time in Workspace.settings.timeZone', async () => {
        // UTC+14: no instant reads the same there as in Stockholm or UTC.
        const zone = 'Pacific/Kiritimati';
        await h.app.as(owner).actor(Workspace, workspaceKey(WS)).updateSettings({ timeZone: zone });
        const forge = await h.agent('Forge', 'Builds things');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const taskId = 't_zone' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
        await task.create({ objective: 'echo', origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
        await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
        await until(async () => (await task.get()).status === 'completed', 'the task to complete');
        const transitions = (await task.get()).transitions;

        const dom = await mountLive(`/tasks/${taskId}`, h);
        await until(() => times(dom).length === transitions.length, 'the transitions timeline');
        expect(times(dom)).toEqual(transitions.map((t) => zoneFormat(zone).time(t.at)));
        expect(times(dom)).not.toEqual(transitions.map((t) => zoneFormat('Europe/Stockholm').time(t.at)));
    });
});
