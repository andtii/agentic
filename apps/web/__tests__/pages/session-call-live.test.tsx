/**
 * `/sessions/:id?call=<callId>` on the platform (#1056): the page reads the Session's log (window and pages) until
 * it finds the call, and shows that call's input and whole output — for a call still in the log's tail, for one
 * past it, and says so for a call the session does not hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentEvent } from '@sigx/ai-agent';
import { actorKey, type ChatId, type MessageId, type TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { LOG_TAIL } from '../../src/pages/session/live';
import { callRowId } from '../../src/pages/session/call';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

/** One long first call, then enough short ones to push it past the log's tail. */
const LONG = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
const SHORT_CALLS = LOG_TAIL;
const SCRIPT = {
    respond: () => [
        { tool: { name: 'build', input: { command: 'pnpm build' }, output: LONG } },
        ...Array.from({ length: SHORT_CALLS }, (_, i) => ({ tool: { name: 'probe', input: { n: i }, output: `ok ${i}` } })),
        { text: 'done' }
    ]
};

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(SCRIPT);
});
afterEach(async () => {
    await h.stop();
});

/** A chat with one agent, a task routed to it; resolves once its turn has ended, with the session's tool calls in order. */
async function runTurn(): Promise<{ sessionId: string; calls: string[] }> {
    const agentId = await h.agent('Atlas', 'Assistant');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(agentId, 'all');
    const { messageId } = await chat.post('go', [agentId]);
    const taskId = 't_calls' as TaskId;
    await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: 'go', origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    const view = await h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId);
    const sessionId = view.sessionId!;
    const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
    await until(async () => (await session.get()).status === 'idle', 'the turn to end', 10_000);
    const events = (await session.events()) as AgentEvent[];
    const calls = events.flatMap((e) => (e.type === 'tool-call' ? [e.callId] : []));
    return { sessionId, calls };
}

describe('/sessions/:id?call= (live)', () => {
    it('a call in the tail, a call past it and a missing call', { timeout: 30_000 }, async () => {
        const { sessionId, calls } = await runTurn();
        expect(calls).toHaveLength(SHORT_CALLS + 1);

        // The last call: still in the log's tail — its row carries the id and the highlight, and its time.
        const last = calls.at(-1)!;
        const inTail = await mountLive(`/sessions/${sessionId}?call=${encodeURIComponent(last)}`, h);
        await until(() => inTail.querySelector('[data-call-focus][data-status="found"]') !== null, 'the tail call to be found');
        const row = inTail.querySelector(`[id="${callRowId(last)}"]`)!;
        expect(row).not.toBeNull();
        expect(row.hasAttribute('data-focus')).toBe(true);
        expect(row.querySelector('[data-event-at] time')).not.toBeNull();
        expect(inTail.querySelector('[data-call-focus] [data-call-output] pre')!.textContent).toBe(`ok ${SHORT_CALLS - 1}`);

        // The first call: past the tail — no row in the log, the whole output unclipped.
        const first = calls[0]!;
        const past = await mountLive(`/sessions/${sessionId}?call=${encodeURIComponent(first)}`, h);
        await until(() => past.querySelector('[data-call-focus][data-status="found"]') !== null, 'the old call to be found');
        expect(past.querySelector(`[id="${callRowId(first)}"]`)).toBeNull();
        const out = past.querySelector('[data-call-focus] [data-call-output] pre')!.textContent!;
        expect(out).toBe(LONG);
        expect(past.querySelector('[data-call-focus] [data-call-input] pre')!.textContent).toContain('"command": "pnpm build"');

        // A call the session never held: said so.
        const gone = await mountLive(`/sessions/${sessionId}?call=c_gone`, h);
        await until(() => gone.querySelector('[data-call-focus][data-status="missing"]') !== null, 'the missing call to be said');
        expect(gone.querySelector('[data-call-missing]')!.textContent).toContain('no longer holds call c_gone');
    });
});
