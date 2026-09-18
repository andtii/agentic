/**
 * AC-05 — The assistant delegates a task to the CLI agent. The task has an
 * owner, objective, traceable origin, status, and returned result.
 *
 * The app's registry on the in-process host (`host.ts`): a user asks the
 * assistant in a chat (the composer's own path, `runActivation`); the
 * assistant's session runs the real local runtime path with a scripted
 * model that calls the `delegate` platform tool; the child task is created
 * for the other agent, runs in its own session outside the chat, settles,
 * and its result comes back to the assistant as the tool result. The child
 * record is the AC-05 shape. Deeper: `packages/platform/__tests__/routing/delegation.test.ts`
 * (the collaborator check, stop cascade, idempotent child ids).
 */
import { childTaskId, createId, type ChatId, type TaskId } from '@agentic/core';
import { Chat, type IndexedEntry } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { runActivation, unknownAgent } from '../../src/pages/chat/live';
import { edges, startHost, until, type AcceptanceHost } from './host';

let h: AcceptanceHost;
beforeEach(async () => {
    h = await startHost();
});
afterEach(async () => {
    await h.stop();
});

describe('AC-05: the assistant delegates a task', () => {
    it('the child has an owner, objective, traceable origin, status and result; the assistant gets the result back', async () => {
        const me = h.user('ac05_user');
        const ada = await me.agent('Ada', { tools: [{ name: 'delegate' }] });
        const bob = await me.agent('Bob', { tools: [] });
        const { chatId } = await me.workspace().createChat({});
        const chat = h.as(me.principal).actor(Chat, chatKeyOf(me.userId, chatId));
        await chat.addAgent(ada, 'all');
        await chat.setCoordinator(ada);

        // The user's message, exactly as the composer sends it: post, one task per activated agent, `Routing.run`.
        const summary = await chat.get();
        const activation = await runActivation(
            {
                post: (text, mentions) => chat.post(text, mentions),
                createTask: (id, contract, owner) => me.task(id).create(contract, { owner }),
                run: (taskId) => me.routing().run(taskId),
                newTaskId: () => createId('task') as TaskId
            },
            { chatId: chatId as ChatId, text: `delegate ${bob}: Audit the dependencies.`, mentions: [], summary, entries: [], lookup: unknownAgent }
        );
        expect(activation.tasks.map((t) => t.agentId)).toEqual([ada]);
        const parentId = activation.tasks[0]!.taskId;
        const parent = await me.settled(parentId);
        expect(parent.status).toBe('completed');
        expect(parent.result?.text).toBe('parent done');

        // The child: owner, objective, traceable origin (which agent, from which task, session and tool call), status, result.
        const childId = childTaskId(parentId, 'd1');
        expect(parent.children).toEqual([childId]);
        const child = await me.task(childId).get();
        expect(child).toMatchObject({
            id: childId,
            owner: ada,
            assignee: bob,
            objective: 'Audit the dependencies.',
            origin: { kind: 'agent', agentId: ada, taskId: parentId, sessionId: parent.sessionId, callId: 'd1' },
            parentId,
            depth: 1,
            status: 'completed',
            result: { text: 'echo: Audit the dependencies.', artifacts: [], verified: false }
        });
        expect(edges(child)).toEqual(['queued>active', 'active>completed']);
        // The parent waited on its child and resumed when it settled (COL-05/07); the tree shows both.
        expect(edges(parent)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(parent.transitions[1]).toMatchObject({ by: `agent:${ada}`, wait: { kind: 'child', childTaskIds: [childId] } });
        expect(await me.task(parentId).tree()).toMatchObject({ id: parentId, status: 'completed', children: [{ id: childId, owner: ada, assignee: bob, status: 'completed', children: [] }] });

        // The child ran in its own session, outside the chat (COL-08); the parent's session belongs to the chat.
        const childSession = await me.session(child.sessionId!).get();
        expect(childSession.spec).toMatchObject({ agentId: bob, taskId: childId });
        expect(childSession.spec?.chatId).toBeUndefined();
        expect((await me.session(parent.sessionId!).get()).spec?.chatId).toBe(chatId);

        // The result reached the assistant as the tool result of its `delegate` call…
        const transcript = await me.session(parent.sessionId!).transcript();
        const call = transcript!.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.callId === 'd1');
        expect(call).toMatchObject({ type: 'tool', name: 'delegate', status: 'completed', output: { taskId: childId, status: 'completed', text: 'echo: Audit the dependencies.' } });
        // …and the assistant's answer landed in the chat, attributed and bound to the parent task.
        await until(async () => (await chat.history(null, 50)).entries.some((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent'), 'the answer in the chat');
        const answer = (await chat.history(null, 50)).entries.find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent')!.entry as Extract<IndexedEntry['entry'], { t: 'msg' }>;
        expect(answer.parts).toEqual([{ type: 'text', text: 'parent done' }]);
        expect(answer.taskId).toBe(parentId);
        expect(parent.origin).toEqual({ kind: 'user', chatId, messageId: activation.messageId });
        await until(async () => (await me.session(child.sessionId!).get()).status === 'closed', 'the child session to close');
        expect((await me.routing().get()).routes).toEqual([]);
    });
});
