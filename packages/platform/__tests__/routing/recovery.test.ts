/**
 * Failure distinction and recovery on the platform side (#46, #128; OPS-04,
 * OPS-05): a chat-originated task that cannot run is told to its chat as a
 * `task-failed` status (never silence), and a turn an eviction cut short is
 * marked, parked, and resumed only by a person — `Routing.resume` re-prompts
 * the session over its intact transcript, nothing is replayed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type MessageId, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { AgentActor, agentKey } from '../../src/agent/index';
import { workspaceKey } from '../../src/auth/index';
import { Chat } from '../../src/chat/index';
import { defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, interruptedTurn, isInterruptedTurnEnd, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

/** `slow` runs a long tool call (long enough to evict mid-turn); anything else echoes. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('slow')) return [{ text: 'working ' }, { tool: { name: 'slow', input: { n: 1 }, output: 'done', delayMs: 2_000 } }, { text: 'after' }];
            return [{ text: `echo: ${text}` }];
        }
    });
}

function localFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

/** The deployment without an API key: `createSessionFactory` refuses to open. */
const noKeyFactory: SessionFactory = async () => {
    throw new Error('no-api-key: ANTHROPIC_API_KEY is not set for this deployment');
};

let app: TestActorApp;
let agent: MockAgent;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;

async function start(factory?: SessionFactory): Promise<void> {
    agent = scriptedAgent();
    Session = defineSessionActor({ factory: factory ?? localFactory(agent) });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Workspace, Chat]);
    await app.start();
}

afterEach(async () => {
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const chat = (id: string) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));
const edges = (t: TaskView) => t.transitions.map((x) => `${x.from}>${x.to}`);

/** An API agent in a chat, a posted message and the task it activates — what `runActivation` does in the browser. */
async function chatTask(id: string, text: string): Promise<{ agentId: AgentId; chatId: ChatId }> {
    const agentId = 'atlas' as AgentId;
    await app.as(owner).actor(AgentActor, agentKey(WS, agentId)).update({ name: 'Atlas', instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    const { chatId } = await app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    await chat(chatId).addAgent(agentId, 'all');
    const { messageId } = await chat(chatId).post(text, [agentId]);
    await task(id).create({ objective: text, origin: { kind: 'user', chatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    return { agentId, chatId };
}

const statusEntries = async (chatId: string) => (await chat(chatId).history(null, 50)).entries.map((e) => e.entry).filter((e) => e.t === 'status');

describe('a session-open failure reaches the chat (#128)', () => {
    beforeEach(() => start(noKeyFactory));

    it('fails the task with session-open and appends a task-failed status row naming the task and the error', async () => {
        const { agentId, chatId } = await chatTask('t1', 'hello');
        const t = await routing().run('t1' as TaskId);
        expect(t.status).toBe('failed');
        expect(t.error).toMatchObject({ code: 'session-open', recoverable: false });
        expect(t.error!.message).toContain('no-api-key');
        await until(async () => (await statusEntries(chatId)).some((e) => e.kind === 'task-failed'), 'the chat to hear of the failure');
        const failed = (await statusEntries(chatId)).find((e) => e.kind === 'task-failed')!;
        expect(failed).toMatchObject({ t: 'status', kind: 'task-failed', agentId, ref: 't1', error: { code: 'session-open', recoverable: false } });
        expect((failed as { error: { message: string } }).error.message).toContain('no-api-key');
        // The route is gone: nothing retries a failure by itself.
        expect((await routing().get()).routes).toEqual([]);
    });
});

describe('an interrupted turn is marked and resumed by a person (OPS-05)', () => {
    beforeEach(() => start());

    it('parks the route as interrupted, the task waiting {input, resume:…}; resume re-prompts the same input and the task completes', async () => {
        const { chatId } = await chatTask('t1', 'slow please');
        const started = await routing().run('t1' as TaskId);
        const sessionId = started.sessionId!;
        await until(async () => (await session(sessionId).events()).some((e) => e.type === 'tool-call'), 'the tool call');

        // Evict the session mid-turn: the next activation closes the turn as interrupted, and the router hears it.
        await app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        await until(async () => (await task('t1').get()).status === 'waiting', 'the task to wait on the interruption');
        const waiting = await task('t1').get();
        expect(waiting.wait).toEqual({ kind: 'input', requestId: 'resume:t1:turn:1', sessionId });
        const events = await session(sessionId).events();
        expect(isInterruptedTurnEnd(events.at(-1)!)).toBe(true);
        expect(interruptedTurn(events)).toEqual({ turnId: 't1:turn:1', input: [{ type: 'text', text: 'slow please' }] });
        // The route is parked, not followed again, and the chat was told.
        await until(async () => (await routing().get()).routes[0]?.status === 'interrupted', 'the route to park');
        await until(async () => (await statusEntries(chatId)).some((e) => e.kind === 'task' && e.ref === 'interrupted:t1:turn:1'), 'the chat to hear of the interruption');
        // Nothing was replayed: one turn-start, one tool call.
        expect(events.filter((e) => e.type === 'turn-start')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(1);

        // Resume: a new turn with the same input, the task active again through a `resumed` transition.
        const resumed = await routing().resume('t1' as TaskId);
        expect(resumed.status).toBe('active');
        expect(edges(resumed)).toEqual(['queued>active', 'active>waiting', 'waiting>active']);
        expect(resumed.transitions.at(-1)!.why).toMatch(/^resumed/);
        expect((await routing().get()).routes[0]).toMatchObject({ taskId: 't1', status: 'running', turnId: 't1:turn:1:resume' });
        const starts = (await session(sessionId).events()).filter((e) => e.type === 'turn-start');
        expect(starts).toHaveLength(2);
        expect(starts[1]).toMatchObject({ turnId: 't1:turn:1:resume', input: [{ type: 'text', text: 'slow please' }] });
        // A second resume is not a second turn: the route is running, not interrupted.
        expect(await statusOf(routing().resume('t1' as TaskId))).toBe(409);

        await until(async () => (await task('t1').get()).status === 'completed', 'the resumed turn to finish', 6_000);
        const done = await task('t1').get();
        expect(done.result?.text).toContain('after');
        expect((await routing().get()).routes).toEqual([]);
    });

    it('Session.resume is refused when nothing was interrupted, and is idempotent per interruption', async () => {
        const { agentId } = await chatTask('t2', 'slow again');
        const started = await routing().run('t2' as TaskId);
        const sessionId = started.sessionId!;
        await until(async () => (await session(sessionId).events()).some((e) => e.type === 'tool-call'), 'the tool call');
        expect(agentId).toBe('atlas');
        // Mid-turn: nothing to resume.
        expect(await session(sessionId).resume()).toMatchObject({ kind: 'error', code: 'invalid' });
        await app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        await until(async () => (await task('t2').get()).status === 'waiting', 'the interruption');
        const first = await session(sessionId).resume();
        expect(first).toMatchObject({ kind: 'ack', commandId: 'resume:t2:turn:1', turnId: 't2:turn:1:resume' });
        // The same command again answers the same way and starts nothing new (OPS-06).
        expect(await session(sessionId).resume()).toEqual(first);
        expect((await session(sessionId).events()).filter((e) => e.type === 'turn-start')).toHaveLength(2);
    });
});
