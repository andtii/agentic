/**
 * `/tasks` and Home's active tasks over the real wire (#146): a task
 * created through a chat's activation path (`Task.create` + `Routing.run`)
 * appears on `/tasks` with its status, its wait reason and a link to the
 * tree; the chips filter by status; Home lists it while it is active and
 * "Stop all" cancels the chain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, MessageId, TaskId } from '@agentic/core';
import { TaskActor, TaskIndex, Workspace, taskIndexKey, taskKey, workspaceKey } from '@agentic/platform';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, text } from './helpers';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const t = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (t.startsWith('ask')) return [{ request: { kind: 'input', message: 'Which branch?' } }, { text: 'thanks' }];
            return [{ text: `echo: ${t}` }];
        }
    });
});
afterEach(async () => {
    await h.stop();
});

/** A task in a chat, run through the router — the chat page's activation path. */
async function seed(objective: string, agentId?: AgentId) {
    const forge = agentId ?? (await h.agent('Forge', 'Builds things'));
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const taskId = `t_${objective.replace(/\W+/g, '_')}` as TaskId;
    await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective, origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
    await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
    return { forge, taskId, task: h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)) };
}

const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-page="tasks"] tbody tr, [data-home-tasks] tbody tr')];
const statusOf = (row: Element) => row.querySelector('[data-cell-status] [data-scope="badge"][data-part="root"]')!.getAttribute('data-status');
const chip = (dom: ParentNode, label: string) => [...dom.querySelectorAll<HTMLButtonElement>('[data-chip]')].find((b) => b.textContent!.trim().startsWith(label))!;

describe('/tasks (live)', () => {
    it('lists a task created through chat with its status, its wait reason and a link to the tree; the chips filter', async () => {
        const { taskId, task, forge } = await seed('ask me something');
        await until(async () => (await task.get()).status === 'waiting', 'the task to wait for input');
        const dom = await mountLive('/tasks', h);
        await until(() => rows(dom).length === 1, 'the task row');
        const row = rows(dom)[0]!;
        expect(statusOf(row)).toBe('waiting');
        expect(row.querySelector('[data-scope="ag-task-node"][data-part="wait"]')!.textContent).toBe('wait: input');
        expect(row.querySelector('[data-cell-title] a')!.getAttribute('href')).toBe(`/tasks/${taskId}`);
        expect(text(row.querySelector('[data-cell-agent] > span:last-child'))).toBe('Forge');
        expect(text(row.querySelector('[data-scope="ag-env-line"]'))).toContain('anthropic-api');
        expect(chip(dom, 'Waiting').querySelector('[data-chip-count]')!.textContent).toBe('1');
        expect(chip(dom, 'Completed').querySelector('[data-chip-count]')!.textContent).toBe('0');

        // A second task settles; the index row follows and the chips count it.
        const done = await seed('echo this', forge);
        await until(async () => (await done.task.get()).status === 'completed', 'the second task to complete');
        // The record settles first; the index row follows over a hop and the live read after that (#174).
        await until(() => rows(dom).length === 2 && statusOf(rows(dom)[0]!) === 'completed', 'both rows, the new one completed');
        expect(rows(dom).map(statusOf)).toEqual(['completed', 'waiting']);
        chip(dom, 'Completed').click();
        await until(() => rows(dom).length === 1 && statusOf(rows(dom)[0]!) === 'completed', 'the completed filter');
        chip(dom, 'Queued').click();
        await until(() => rows(dom).length === 0, 'an empty filter');
        expect(text(dom.querySelector('[data-scope="empty-state"][data-part="root"]'))).toContain('No queued tasks');

        // The row is what the Task actor wrote: the index and the record agree.
        const index = await h.app.as(owner).actor(TaskIndex, taskIndexKey(WS)).list();
        expect(index.map((r) => [r.id, r.status, r.chatId !== undefined])).toEqual([[done.taskId, 'completed', true], [taskId, 'waiting', true]]);
    });
});

describe('/ active tasks (live)', () => {
    it('shows the active task, drops it once settled, and "Stop all" cancels the chain', { timeout: 15_000 }, async () => {
        const { task, taskId } = await seed('ask me again');
        await until(async () => (await task.get()).status === 'waiting', 'the task to wait for input');
        const dom = await mountLive('/', h);
        await until(() => rows(dom).length === 1, 'the active row on Home');
        expect(dom.querySelector('[data-home-tasks]')!.getAttribute('aria-label')).toBe('Active tasks');
        expect(rows(dom)[0]!.querySelector('[data-cell-title] a')!.getAttribute('href')).toBe(`/tasks/${taskId}`);
        // The rail reads the workspace and the ledger: no spend yet is `n/a`, never 0.
        expect(text(dom.querySelector('[data-spend-value]'))).toBe('n/a');
        expect(dom.querySelector('[data-home-rail] [data-today]')).not.toBeNull();

        buttonNamed(dom, 'Stop all').click();
        await until(() => document.querySelector('[role="alertdialog"]') !== null, 'the confirm dialog');
        const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
        expect(dialog.textContent).toContain('ask me again');
        buttonNamed(dialog, 'Stop 1 chain').click();
        // The index row follows the `cancelled` transition at once; the Task's own turn stays parked on the stop cascade.
        await until(() => rows(dom).length === 0, 'the row to leave Home');
        expect(text(dom.querySelector('[data-home-tasks] [data-scope="empty-state"][data-part="root"]'))).toContain('No active tasks');
        expect((await task.get()).status).toBe('cancelled');
    });

    it('with no agent yet shows the workspace empty state', async () => {
        const dom = await mountLive('/', h);
        await until(() => dom.querySelector('[data-scope="empty-state"][data-part="root"][data-empty="workspace"]') !== null, 'the workspace empty state');
        expect(dom.querySelector('[data-home-tasks]')).toBeNull();
    });
});
