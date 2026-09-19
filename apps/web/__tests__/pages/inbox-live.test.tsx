/**
 * "Needs you" on Home over the real wire (#40, OPS-02 / CHT-09): an agent
 * whose policy asks on destructive calls raises a request that lands in
 * the Inbox; two tabs list it with the approval card; one answers from the
 * card and the row leaves both; the task completes. The input request
 * takes the same road through the answer box. An evicted turn parks its
 * route as `interrupted` (OPS-05): that is a row too, and its Resume goes
 * through the router (#151).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { actorKey, type MessageId, type TaskId } from '@agentic/core';
import { AgentActor, TaskActor, Workspace, agentKey, taskKey, workspaceKey } from '@agentic/platform';
import { interruptedRows, mockNeedsSource } from '../../src/pages/inbox';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';
import { buttonNamed, setText } from './helpers';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('push')) return [{ tool: { name: 'push', category: 'destructive', input: { cmd: 'git push' }, output: 'ok', permissionKey: 'push:origin' } }, { text: 'pushed' }];
            if (text.startsWith('slow')) return [{ text: 'working ' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }];
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
        const { task, chatId } = await seed('push it');
        const a = await mountLive('/', h);
        const b = await mountLive('/', h);
        await until(() => card(a) !== null && card(b) !== null, 'the approval card in both tabs');
        expect(rows(a).map((r) => r.getAttribute('data-kind'))).toEqual(['approval']);
        expect(rows(a)[0]!.getAttribute('aria-label')).toBe('Forge asks for approval: push');
        expect(card(a)!.textContent).toContain('ask on destructive');
        expect(card(a)!.textContent).toContain('cmd: git push');
        expect(a.querySelector('[data-home-needs] a[data-scope="button"]')!.getAttribute('href')).toBe(`/chats/${chatId}`);
        // The Task parks through the router's follow of the session (throttled, #196), a beat after the row shows.
        await until(async () => (await task.get()).status === 'waiting', 'the task to park');

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
        expect(rows(dom)[0]!.querySelector('[data-scope="ai-question"][data-part="prompt"]')!.textContent).toBe('Which branch?');
        setText(rows(dom)[0]!.querySelector('textarea')!, 'main');
        await until(() => !buttonNamed(rows(dom)[0]!, 'Answer').disabled, 'the answer button');
        buttonNamed(rows(dom)[0]!, 'Answer').click();
        await until(() => rows(dom).length === 0, 'the row to leave');
        await settled(task);
        expect((await task.get()).result?.text).toBe('thanks');
    });

    it('an interrupted turn is a row: it names the agent, leads to the chat, and Resume re-prompts through the router', { timeout: 20_000 }, async () => {
        const { task, chatId, taskId } = await seed('slow please');
        const dom = await mountLive('/', h);
        expect(rows(dom)).toHaveLength(0);
        // Mid-turn: the tool call is in the session log; evict the session object.
        const routing = h.app.as(owner).actor(h.Routing, `${USER}:routing:main`);
        let sessionId = '';
        await until(async () => {
            sessionId = (await routing.get()).routes[0]?.sessionId ?? '';
            return sessionId !== '';
        }, 'the session');
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        await until(async () => (await session.events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await h.app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });

        await until(() => rows(dom).length === 1, 'the interrupted row', 8_000);
        const row = rows(dom)[0]!;
        expect(row.getAttribute('data-kind')).toBe('interrupted');
        expect(row.textContent).toContain('Forge was interrupted mid-turn');
        expect(dom.querySelector('[data-home-needs] a[data-scope="button"]')!.getAttribute('href')).toBe(`/chats/${chatId}`);
        // The Task parks through the router's follow of the session (throttled, #196), a beat after the row shows.
        await until(async () => (await task.get()).status === 'waiting', 'the task to park');

        buttonNamed(row, 'Resume').click();
        await until(() => rows(dom).length === 0, 'the row to leave', 8_000);
        await settled(task);
        // The result carries the cut turn's partial text, then the resumed turn's answer.
        expect((await task.get()).result?.text).toContain('after');
        expect((await session.events()).filter((e) => e.type === 'turn-start').map((e) => e.turnId)).toEqual([`${taskId}:turn:1`, `${taskId}:turn:1:resume`]);
    });
});

describe('interrupted rows (model)', () => {
    const route = (over: Record<string, unknown>) => ({ taskId: 't1', agentId: 'a1', status: 'interrupted', updatedAt: 42, config: { name: 'Atlas' }, ...over }) as never;

    it('only the routes parked interrupted become rows; the chat is where they lead, else the task', () => {
        const rows = interruptedRows({ routes: [route({}), route({ taskId: 't2', status: 'running' }), route({ taskId: 't3', chatId: 'c9', config: { name: '' } })] });
        expect(rows.map((r) => [r.id, r.kind, r.title, r.at, r.taskId, r.href, r.hrefLabel, r.primary?.label])).toEqual([
            ['interrupted:t1', 'interrupted', 'Atlas was interrupted mid-turn', 42, 't1', '/tasks/t1', 'Open task', 'Resume'],
            ['interrupted:t3', 'interrupted', 'a1 was interrupted mid-turn', 42, 't3', '/chats/c9', 'Open chat', 'Resume']
        ]);
        expect(interruptedRows(null)).toEqual([]);
    });

    it('the mock source resumes in memory: the row leaves, once', async () => {
        const source = mockNeedsSource();
        const row = source.useRows()().find((r) => r.kind === 'interrupted')!;
        await source.resume!(row);
        await source.resume!(row);
        expect(source.useRows()().some((r) => r.kind === 'interrupted')).toBe(false);
        expect(source.resumed).toEqual([row]);
    });
});
