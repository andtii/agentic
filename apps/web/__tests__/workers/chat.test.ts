/**
 * The chat path inside workerd (#34): a post through `runActivation` — the
 * same function the composer calls — creates a task and routes it; the
 * session (a mock runtime, `worker.ts`) runs; the chat's LIVE view (the
 * `$live` subscription the browser's `useActorState` rides) shows the
 * status entry and the answer without a re-read.
 */
import type { AgentId, ChatId, TaskId, WorkspaceId } from '@agentic/core';
import { createId } from '@agentic/core';
import { AgentActor, Chat, TaskActor, Workspace, agentKey, taskKey, workspaceKey, type IndexedEntry, type RoutingActor } from '@agentic/platform';
import { fetchTransport } from '@sigx/actors/client';
import { SELF } from 'cloudflare:test';
import { chatKeyOf, routingKeyOf } from '../../src/actors/keys';
import { runActivation, unknownAgent } from '../../src/pages/chat/live';
import { overHttp, signIn } from './http';

const userId = 'gh_chat';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
/** Only the `type` matters on the wire. */
const Routing = { type: 'routing' } as unknown as RoutingActor;

/** Subscribe to a read on the `$live` stream and collect every value pushed, exactly as the browser channel does. */
function liveRead(cookie: string, wire: { t: string; k: string; m: string; a?: readonly unknown[] }): { values: unknown[]; stop(): void } {
    const transport = fetchTransport({ endpoint: `${ORIGIN}/_sigx/actor`, headers: { cookie, origin: ORIGIN }, fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : (input as URL).href, init) });
    const controller = new AbortController();
    const values: unknown[] = [];
    void (async () => {
        try {
            for await (const frame of transport.stream('$live#subscribe', [[wire]], { signal: controller.signal })) {
                const f = frame as { i?: number; v?: unknown; e?: unknown };
                if (f.i === 0 && 'v' in f) values.push(f.v);
                if (f.e) throw new Error(JSON.stringify(f.e));
            }
        } catch (e) {
            if (!controller.signal.aborted) throw e;
        }
    })();
    return { values, stop: () => controller.abort() };
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

describe('worker: a post activates an agent — task, route, session, and the chat’s live view', () => {
    it('shows the status entry and the answer on the live subscription', async () => {
        const cookie = await signIn(userId);
        const ws = overHttp(Workspace, workspaceKey(WS), cookie);
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Ada', instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
        const { chatId } = await ws.createChat({});
        const chatKey = chatKeyOf(WS, chatId as ChatId);
        const chat = overHttp(Chat, chatKey, cookie);
        await chat.addAgent(agentId as AgentId, 'all');

        const live = liveRead(cookie, { t: 'Chat', k: chatKey, m: 'history', a: [null, 50] });
        await until(() => live.values.length >= 1, 'the first live value');

        const summary = await chat.get();
        const result = await runActivation(
            {
                post: (text, mentions) => chat.post(text, mentions),
                createTask: (id, contract, owner) => overHttp(TaskActor, taskKey(WS, id), cookie).create(contract, { owner }),
                run: (taskId) => overHttp(Routing, routingKeyOf(WS), cookie).run(taskId),
                newTaskId: () => createId('task') as TaskId
            },
            { chatId: chatId as ChatId, text: 'hello from the worker', mentions: [], summary, entries: [], lookup: unknownAgent }
        );
        expect(result.tasks).toHaveLength(1);
        expect(result.tasks[0]!.agentId).toBe(agentId);

        const entries = (): IndexedEntry[] => ((live.values[live.values.length - 1] as { entries: IndexedEntry[] } | undefined)?.entries ?? []);
        await until(() => entries().some((e) => e.entry.t === 'status' && e.entry.kind === 'session-started'), 'the status entry on the live view');
        await until(() => entries().some((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent'), 'the answer on the live view');
        live.stop();

        const seen = entries();
        const answer = seen.find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'agent')!.entry as Extract<IndexedEntry['entry'], { t: 'msg' }>;
        expect(answer.parts).toEqual([{ type: 'text', text: 'echo: hello from the worker' }]);
        expect(answer.taskId).toBe(result.tasks[0]!.taskId);
        const task = await overHttp(TaskActor, taskKey(WS, result.tasks[0]!.taskId), cookie).get();
        expect(task.origin).toEqual({ kind: 'user', chatId, messageId: result.messageId });
        expect(['active', 'completed']).toContain(task.status);
    });
});
