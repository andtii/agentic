/**
 * Delegation end to end (architecture §7; COL-03..10, AC-05, AC-12, #39):
 * the `delegate` platform tool → `Task.delegate` → `Routing.run(child)` →
 * the child's `result` stream → the tool result, over a real in-process
 * host. The parent runs the REAL local path — `createSessionFactory` over
 * `createPlatformModelAgent` with a scripted `mockModel` — so the tool's
 * `execute` and its `agent-start` / `agent-update` pair in the parent
 * session are exercised; the stop and restart cases drive the port itself
 * over `mockAgent` sessions. Offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, childTaskId, type AgentId, type ChatId, type MessageId, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import type { DelegateOutcome } from '@agentic/runtimes';
import { mockModel } from '@sigx/ai/testing';
import { allowAll, type AgentEvent } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import type { ModelRequest } from '@sigx/ai';

import { AgentActor, agentKey, type AgentConfigPatch } from '../../src/agent/index';
import { mintAgentPrincipal } from '../../src/auth/index';
import { ToolCallError } from '../../src/machine/index';
import { Memory } from '../../src/memory/index';
import { defineInbox, inboxKey } from '../../src/notify/index';
import { createActorToolPorts, createSessionFactory, defineRoutingActor, routingKey, type AgentPrincipal } from '../../src/routing/index';
import { defineSessionActor, type SessionFactory } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const ADA = 'agent_ada' as AgentId;
const BOB = 'agent_bob' as AgentId;
const EVE = 'agent_eve' as AgentId;

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const hasTool = (req: ModelRequest, name: string) => !!req.tools?.some((t) => t.name === name);
const hasToolResult = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');

/**
 * One scripted model for every session: the parent (the one with `delegate` on its roster)
 * delegates once and then reports; a child with `memory_search` calls it once and then
 * answers; any other child just answers.
 */
function scriptedModel(delegate: { assignee: string; objective: string; context?: string }) {
    return mockModel({
        modelId: 'claude-test',
        respond: (req) => {
            if (hasTool(req, 'delegate')) return hasToolResult(req) ? { text: 'parent done' } : { toolCalls: [{ name: 'delegate', input: delegate, id: 'd1' }] };
            if (hasTool(req, 'memory_search')) return hasToolResult(req) ? { text: 'child done after the call' } : { toolCalls: [{ name: 'memory_search', input: { query: 'x' }, id: 'm1' }] };
            return { text: 'child done' };
        }
    });
}

/** `mockAgent` sessions for the port-level cases: `slow` holds a turn open on an abortable tool. */
function slowAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text.startsWith('slow')) return [{ text: 'working' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 20_000 } }, { text: 'after' }];
            return [{ text: `echo: ${text}` }];
        }
    });
}

function mockFactory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Inbox: ReturnType<typeof defineInbox>;

async function start(factory: (routing: () => ReturnType<typeof defineRoutingActor>) => SessionFactory): Promise<void> {
    Session = defineSessionActor({ factory: factory(() => Routing) });
    Inbox = defineInbox({});
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session, inbox: () => Inbox });
    app = testActorApp([Routing, Session, TaskActor, AgentActor, Memory, Inbox]);
    await app.start();
}

afterEach(async () => {
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS));

async function agent(id: AgentId, patch: AgentConfigPatch): Promise<void> {
    await app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: id, instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' }, ...patch }, 'create');
}

async function createTask(id: string, assignee: AgentId, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    return task(id).create({ objective: 'do the thing', origin: { kind: 'external', clientId: 'c1' }, assignee, context: [], constraints: {}, ...extra }, { owner: assignee });
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const edges = (t: TaskView) => t.transitions.map((x) => `${x.from}>${x.to}`);
const events = async (sessionId: string): Promise<AgentEvent[]> => session(sessionId).events();

describe('AC-05: the assistant delegates a task and gets the result back as a tool result', () => {
    beforeEach(() => start((routingDef) => createSessionFactory({ routing: routingDef, model: scriptedModel({ assignee: BOB, objective: 'Audit the deps.', context: 'Repo is pnpm.' }) })));

    it('creates the child (owner, objective, traceable origin, status, result), runs it outside the chat, and returns its result to the parent', async () => {
        await agent(ADA, { tools: [{ name: 'delegate' }] });
        await agent(BOB, { tools: [] });
        const CHAT = 'chat_1' as ChatId;
        await createTask('t_parent', ADA, { origin: { kind: 'user', chatId: CHAT, messageId: 'msg_1' as MessageId } });
        await routing().run('t_parent' as TaskId);
        await settled('t_parent');

        const parent = await task('t_parent').get();
        expect(parent.status).toBe('completed');
        expect(parent.result?.text).toBe('parent done');
        const childId = childTaskId('t_parent' as TaskId, 'd1');
        expect(parent.children).toEqual([childId]);
        // The parent waited on its child and resumed when it settled (COL-05/07).
        expect(edges(parent)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(parent.transitions[1]).toMatchObject({ by: `agent:${ADA}`, wait: { kind: 'child', childTaskIds: [childId] } });
        expect(parent.transitions[2]).toMatchObject({ by: `task:${childId}`, why: 'child completed' });

        // The child: the AC-05 shape.
        const child = await task(childId).get();
        expect(child).toMatchObject({
            id: childId,
            owner: ADA,
            assignee: BOB,
            objective: 'Audit the deps.',
            context: [{ type: 'text', text: 'Repo is pnpm.' }],
            origin: { kind: 'agent', agentId: ADA, taskId: 't_parent', sessionId: parent.sessionId, callId: 'd1' },
            parentId: 't_parent',
            depth: 1,
            status: 'completed',
            result: { text: 'child done', artifacts: [], verified: false }
        });
        expect(edges(child)).toEqual(['queued>active', 'active>completed']);
        expect(child.configVersion).toBe(parent.configVersion);

        // Background collaboration (COL-08): the child ran in its own session, outside the parent's chat; the record is the task tree.
        const childSession = await session(child.sessionId!).get();
        expect(childSession.spec).toMatchObject({ agentId: BOB, taskId: childId, approvalConstraints: [] });
        expect(childSession.spec?.chatId).toBeUndefined();
        expect((await session(parent.sessionId!).get()).spec?.chatId).toBe(CHAT);
        expect(await task('t_parent').tree()).toMatchObject({ id: 't_parent', status: 'completed', children: [{ id: childId, owner: ADA, assignee: BOB, status: 'completed', children: [] }] });

        // The tool result carries the child's result (COL-07)…
        const transcript = await session(parent.sessionId!).transcript();
        const call = transcript!.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.callId === 'd1');
        expect(call).toMatchObject({ type: 'tool', name: 'delegate', status: 'completed', output: { taskId: childId, status: 'completed', text: 'child done', artifacts: [], verified: false } });
        // …and the parent session shows the child as a sub-agent card bound to the call, without nesting its events.
        const parentEvents = await events(parent.sessionId!);
        expect(parentEvents.find((e) => e.type === 'agent-start')).toMatchObject({ agentId: childId, callId: 'd1', kind: 'delegate', title: `${BOB}: Audit the deps.`, background: true });
        expect(parentEvents.find((e) => e.type === 'agent-update')).toMatchObject({ agentId: childId, status: 'completed', summary: 'child done' });
        expect(parentEvents.filter((e) => e.type === 'part-delta' && (e as { delta: string }).delta.includes('child'))).toEqual([]);
        // The child's session is closed once its task settled; nothing is left on the router.
        await until(async () => (await session(child.sessionId!).get()).status === 'closed', 'the child session to close');
        expect((await routing().get()).routes).toEqual([]);
    });

    it('refuses an assignee outside the parent agent collaborators (COL-10) before any child exists', async () => {
        await agent(ADA, { tools: [{ name: 'delegate' }], collaborators: [BOB] });
        await createTask('t_parent', ADA);
        await task('t_parent').start('user:u1', 'session_p' as SessionId);
        const principal = mintAgentPrincipal({ workspaceId: WS, agentId: ADA, sessionId: 'session_p' as SessionId, taskId: 't_parent' as TaskId }) as AgentPrincipal;
        const ports = createActorToolPorts({ principal, routing: () => Routing });
        const call = { callId: 'c1', signal: new AbortController().signal };
        await expect(ports.task.delegate({ assignee: EVE, objective: 'x', context: [], constraints: {} }, call)).rejects.toMatchObject({ name: 'ToolCallError', code: 'forbidden' });
        expect((await task('t_parent').get()).children).toEqual([]);
    });
});

describe('AC-12: a delegated action that requires approval', () => {
    it('the child request bubbles waiting {approval} on the child, waiting {child} on the parent and an inbox notification; the user decision resolves in the child', async () => {
        await start((routingDef) => createSessionFactory({ routing: routingDef, model: scriptedModel({ assignee: BOB, objective: 'Look it up.' }) }));
        await agent(ADA, { tools: [{ name: 'delegate' }] });
        await agent(BOB, { tools: [{ name: 'memory_search' }], approvalPolicy: [{ id: 'ask-memory', match: { tools: ['memory_search'] }, outcome: 'ask' }] });
        await createTask('t_parent', ADA);
        await routing().run('t_parent' as TaskId);
        const childId = childTaskId('t_parent' as TaskId, 'd1');

        await until(async () => (await task(childId).get().catch(() => null))?.status === 'waiting', 'the child to wait for approval');
        const child = await task(childId).get();
        expect(child.wait).toEqual({ kind: 'approval', requestId: expect.any(String), sessionId: child.sessionId });
        const parent = await task('t_parent').get();
        expect(parent.status).toBe('waiting');
        expect(parent.wait).toEqual({ kind: 'child', childTaskIds: [childId] });
        const { requestId } = child.wait as { requestId: string };
        // The request is exposed to the user: the child session is awaiting it, and the inbox links to it.
        expect((await session(child.sessionId!).get()).openRequests).toEqual([requestId]);
        expect(await inbox().list()).toMatchObject([{ kind: 'approval', title: `${BOB} asks for approval: memory_search`, ref: { kind: 'session', sessionId: child.sessionId, requestId } }]);

        // The decision goes to the CHILD session.
        const reply = await session(child.sessionId!).respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        expect(reply.kind).toBe('ack');
        await settled('t_parent');
        const done = await task(childId).get();
        expect(done.status).toBe('completed');
        expect(done.result?.text).toBe('child done after the call');
        expect(edges(done)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(done.transitions[2]!.why).toBe(`request ${requestId}: allow`);
        expect((await events(done.sessionId!)).find((e) => e.type === 'request-resolved')).toMatchObject({ requestId, outcome: 'allow', by: 'client' });
        const p = await task('t_parent').get();
        expect(p.status).toBe('completed');
        expect(edges(p)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
    });

    it('a child session is never wider than its parent: a parent deny rule constrains the child even where the child allows', async () => {
        await start((routingDef) => createSessionFactory({ routing: routingDef, model: scriptedModel({ assignee: BOB, objective: 'Look it up.' }) }));
        await agent(ADA, { tools: [{ name: 'delegate' }], approvalPolicy: [{ id: 'no-memory-below-me', match: { tools: ['memory_search'] }, outcome: 'deny' }] });
        await agent(BOB, { tools: [{ name: 'memory_search' }], approvalPolicy: [{ id: 'bob-allows', match: { tools: ['memory_search'] }, outcome: 'allow' }] });
        await createTask('t_parent', ADA);
        await routing().run('t_parent' as TaskId);
        await settled('t_parent');
        const childId = childTaskId('t_parent' as TaskId, 'd1');
        const child = await task(childId).get();
        expect(child.status).toBe('completed');
        expect((await session(child.sessionId!).get()).spec?.approvalConstraints).toEqual([{ id: 'no-memory-below-me', match: { tools: ['memory_search'] }, outcome: 'deny' }]);
        const childEvents = await events(child.sessionId!);
        expect(childEvents.find((e) => e.type === 'request-resolved')).toMatchObject({ outcome: 'deny', by: 'policy', ruleId: 'no-memory-below-me' });
        expect(childEvents.filter((e) => e.type === 'tool-update' && e.callId === 'm1').map((e) => (e as { status: string }).status)).toContain('denied');
        // The child never waited for anyone: the policy answered, and the parent got a result (the model went on after the denial).
        expect(edges(child)).toEqual(['queued>active', 'active>completed']);
        expect((await task('t_parent').get()).result?.text).toBe('parent done');
    });
});

describe('stop and restart over the port (COL-12, idempotent child ids)', () => {
    let ports: ReturnType<typeof createActorToolPorts>;
    const spec = { assignee: BOB, objective: 'slow child', context: [], constraints: {} };

    beforeEach(async () => {
        await start(() => mockFactory(slowAgent()));
        await agent(ADA, { tools: [] });
        await agent(BOB, { tools: [] });
    });

    /** A parent whose turn is in flight (its mock session holds a slow tool open), with the port bound to its agent principal. */
    async function runningParent(objective = 'slow parent'): Promise<TaskView> {
        await createTask('t_parent', ADA, { objective });
        const started = await routing().run('t_parent' as TaskId);
        const principal = mintAgentPrincipal({ workspaceId: WS, agentId: ADA, sessionId: started.sessionId!, taskId: 't_parent' as TaskId }) as AgentPrincipal;
        ports = createActorToolPorts({ principal, routing: () => Routing });
        return started;
    }

    it('parent cancel stops the child; the tool result and the stop report name what could not be confirmed stopped', async () => {
        await runningParent();
        const turn = new AbortController();
        const pending = ports.task.delegate(spec, { callId: 'c1', signal: turn.signal });
        const childId = childTaskId('t_parent' as TaskId, 'c1');
        await until(async () => (await task(childId).get().catch(() => null))?.status === 'active', 'the child to run');
        expect((await task('t_parent').get()).wait).toEqual({ kind: 'child', childTaskIds: [childId] });

        // A deadline that has already passed: the cascade is fanned out but nothing can acknowledge in time — a straggler by construction.
        const report = await task('t_parent').cancel('user:u1', { timeoutMs: 0 });
        expect(report.stopped).toBe(false);
        expect(report.notStopped).toContain(childId);
        // The parent's turn is aborted by the cancel; the tool answers honestly.
        turn.abort();
        const outcome: DelegateOutcome = await pending;
        expect(outcome.status).toBe('cancelled');
        expect(outcome).toMatchObject({ taskId: childId, status: 'cancelled', notStopped: [childId] });

        // The cascade does finish: the child ends cancelled, its session is cancelled and closed, and both records settle `stopped`.
        await until(async () => (await task(childId).get()).cancel?.stopped === true, 'the child to confirm its stop');
        const child = await task(childId).get();
        expect(child.status).toBe('cancelled');
        expect(child.notStopped).toEqual([]);
        await until(async () => (await session(child.sessionId!).get()).status === 'closed', 'the child session to close');
        expect((await events(child.sessionId!)).find((e) => e.type === 'turn-end')).toMatchObject({ stopReason: 'cancelled' });
        await until(async () => (await task('t_parent').get()).cancel?.stopped === true, 'the parent to confirm its stop');
        expect((await task('t_parent').get()).notStopped).toEqual([]);
        expect((await routing().get()).routes).toEqual([]);
    });

    it('a restarted parent re-issuing the call re-awaits the SAME child: one child, one result', async () => {
        await runningParent();
        const first = ports.task.delegate({ ...spec, objective: 'quick child' }, { callId: 'c1', signal: new AbortController().signal });
        const childId = childTaskId('t_parent' as TaskId, 'c1');
        // A second call with the same id while the first is in flight (an eviction replayed the call) attaches to the same child.
        const again = ports.task.delegate({ ...spec, objective: 'quick child' }, { callId: 'c1', signal: new AbortController().signal });
        const [a, b] = await Promise.all([first, again]);
        expect(a).toEqual({ taskId: childId, status: 'completed', result: { text: 'echo: quick child', artifacts: [], verified: false } });
        expect(b).toEqual(a);
        // And after the child settled, the same call answers from the record without a new child or a new run.
        const later = await ports.task.delegate({ ...spec, objective: 'quick child' }, { callId: 'c1', signal: new AbortController().signal });
        expect(later).toEqual(a);
        const parent = await task('t_parent').get();
        expect(parent.children).toEqual([childId]);
        expect(parent.status).toBe('active');
        expect(edges(parent)).toEqual(['queued>active', 'active>waiting', 'waiting>active']);
        // A different call id is a different child.
        const other = await ports.task.delegate({ ...spec, objective: 'second child' }, { callId: 'c2', signal: new AbortController().signal });
        expect(other.taskId).toBe(childTaskId('t_parent' as TaskId, 'c2'));
        expect((await task('t_parent').get()).children).toEqual([childId, other.taskId]);
    });

    it('a child that fails reports its error; a limit refuses the call with a code', async () => {
        await runningParent();
        // An assignee with no configuration: the router fails the child with a reason, the tool result says so.
        const failed = await ports.task.delegate({ ...spec, assignee: EVE }, { callId: 'c1', signal: new AbortController().signal });
        expect(failed).toMatchObject({ status: 'failed', error: { code: 'agent-unconfigured' } });
        await task('t_parent').get();
        // Depth: the parent's contract allows none below it.
        await createTask('t_shallow', ADA, { objective: 'slow parent', constraints: { maxDepth: 0 } });
        const started = await routing().run('t_shallow' as TaskId);
        const shallow = createActorToolPorts({ principal: mintAgentPrincipal({ workspaceId: WS, agentId: ADA, sessionId: started.sessionId!, taskId: 't_shallow' as TaskId }) as AgentPrincipal, routing: () => Routing });
        let error: unknown;
        await shallow.task.delegate(spec, { callId: 'c1', signal: new AbortController().signal }).catch((e: unknown) => (error = e));
        expect(error).toBeInstanceOf(ToolCallError);
        expect(error).toMatchObject({ code: 'limit' });
        expect((error as Error).message).toMatch(/depth 1 exceeds maxDepth 0/);
    });
});
