/**
 * "Needs you" on Home over the real wire (#40, OPS-02 / CHT-09): an agent
 * whose policy asks on destructive calls raises a request that lands in
 * the Inbox; two tabs list it with the approval card; one answers from the
 * card and the row leaves both; the task completes. The input request
 * takes the same road through the answer box.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MessageId, TaskId } from '@agentic/core';
import { AgentActor, TaskActor, Workspace, agentKey, taskKey, workspaceKey } from '@agentic/platform';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, setText } from './helpers';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
            if (text.startsWith('ask')) return [{ request: { kind: 'input', message: 'Which branch?' } }, { text: 'thanks' }];
            return [{ text: `echo: ${text}` }];
        }
    });
});
afterEach(async () => {
    await h.stop();
});

/** Poll the task until it completed (the turn goes on after the answer). */
async function settled(task: { get(): Promise<{ status: string }> }): Promise<void> {
    const deadline = Date.now() + 5_000;
    while ((await task.get()).status !== 'completed') {
        if (Date.now() > deadline) throw new Error('timed out waiting for the task to complete');
        await new Promise((r) => setTimeout(r, 10));
    }
}

const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-home-needs] [data-scope="ag-needs-item"][data-part="root"]')];
const card = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-home-needs] [data-scope="ai-approval"][data-part="root"]');

/** Forge, asking on destructive calls, with a task in a chat run through the router. */
async function seed(objective: string) {
    const forge = await h.agent('Forge', 'Builds things');
    await h.app.as(owner).actor(AgentActor, agentKey(WS, forge)).update({ tools: [{ name: 'push' }], approvalPolicy: [{ id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'ask' }] }, 'ask on destructive');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const taskId = `t_${objective.split(' ')[0]}` as TaskId;
    await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective, origin: { kind: 'user', chatId, messageId: 'm1' as MessageId }, assignee: forge, context: [], constraints: {} }, { owner: forge });
    await h.app.as(owner).actor(h.Routing, `${USER}:routing:main`).run(taskId);
    return { forge, chatId, taskId, task: h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)) };
}

describe('/ Needs you (live)', () => {
    it('an approval raised by the agent reaches both tabs; answering from one settles the other and the task goes on', async () => {
        const { task, chatId, forge } = await seed('push it');
        const a = await mountLive('/', h);
        const b = await mountLive('/', h);
        await until(() => card(a) !== null && card(b) !== null, 'the approval card in both tabs');
        expect(rows(a).map((r) => r.getAttribute('data-kind'))).toEqual(['approval']);
        expect(rows(a)[0]!.getAttribute('aria-label')).toBe(`${forge} asks for approval: push`);
        expect(card(a)!.textContent).toContain('ask on destructive');
        expect(card(a)!.textContent).toContain('cmd: git push');
        expect(a.querySelector('[data-home-needs] a[data-scope="button"]')!.getAttribute('href')).toBe(`/chats/${chatId}`);
        expect((await task.get()).status).toBe('waiting');

        buttonNamed(card(b)!, 'Allow once').click();
        await until(() => rows(a).length === 0 && rows(b).length === 0, 'the row to leave both tabs');
        await settled(task);
        expect((await task.get()).result?.text).toBe('pushed');
    });

    it('an input request is answered from the row and the answer reaches the agent', async () => {
        const { task } = await seed('ask me');
        const dom = await mountLive('/', h);
        await until(() => rows(dom).length === 1, 'the input row');
        expect(rows(dom)[0]!.getAttribute('data-kind')).toBe('input');
        expect(rows(dom)[0]!.querySelector('[data-needs-question]')!.textContent).toBe('Which branch?');
        setText(rows(dom)[0]!.querySelector('textarea')!, 'main');
        await until(() => !buttonNamed(rows(dom)[0]!, 'Answer').disabled, 'the answer button');
        buttonNamed(rows(dom)[0]!, 'Answer').click();
        await until(() => rows(dom).length === 0, 'the row to leave');
        await settled(task);
        expect((await task.get()).result?.text).toBe('thanks');
    });
});
