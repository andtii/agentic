/**
 * Per-turn task identity (#390; COL-04, OPS-08, MEM-07, AGT-06): one session, many
 * tasks, each turn attributed to its own. A session opened for task A serves a
 * second turn for task B, and everything that turn attributes to a task — the
 * `delegate` parent, the `task_report`, the Ledger row and the budget charge,
 * the audit row, a memory's provenance, the chat message at turn end — names B,
 * never A. Both paths: the in-process ports over `SessionFactoryContext.currentTaskId`,
 * and a daemon's `tool.call` through `createToolCallPort`, which reads the
 * running turn from the Session although the Machine minted the principal for A.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, childTaskId, SESSION_EVENTS_TOPIC, type AgentId, type ChatId, type FrozenAgentConfig, type MachineId, type Principal, type SessionEvent, type SessionId, type TaskId, type WorkspaceId } from '@agentic/core';
import { platformTools } from '@agentic/runtimes';
import { defineActor } from '@sigx/actors';
import { firstMatch, type AgentSession } from '@sigx/ai-agent';
import { mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import { serveSession, type WireCommand, type WireFrame } from '@sigx/ai-agent/wire';

import { AgentActor, agentKey, agentMemoryScope } from '../src/agent/index';
import { capturingAuditPort } from '../src/audit/index';
import { mintAgentPrincipal } from '../src/auth/index';
import { LedgerActor, ledgerKey, ledgerMonth, ledgerRecorder } from '../src/ledger/index';
import { Memory, memoryActorKey } from '../src/memory/index';
import { createActorToolPorts, createToolCallPort, defineRoutingActor, routingKey, type AgentPrincipal } from '../src/routing/index';
import { currentTaskId, defineSessionActor, type CommandSink, type SessionFactory, type SessionFactoryContext } from '../src/session/index';
import { TaskActor, taskKey } from '../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
const ADA = 'agent_ada' as AgentId;
const BOB = 'agent_bob' as AgentId;
const CHAT = 'chat_1' as ChatId;
const A = 'task_a' as TaskId;
const B = 'task_b' as TaskId;
const USAGE = { inputTokens: 100, outputTokens: 50 };

const config: FrozenAgentConfig = {
    agentId: ADA,
    configVersion: 1,
    name: 'Ada',
    description: '',
    role: 'assistant',
    instructions: 'Be brief.',
    skills: [],
    tools: [],
    connectors: [],
    approvalPolicy: [],
    memoryPolicy: { shared: [], autoLearn: 'off' },
    execution: { runtime: 'anthropic-api', limits: {}, offlinePolicy: 'fail' },
    collaborators: 'all'
};

/** The chat side of the topic: what a Session publishes for its chat. */
const received: SessionEvent[] = [];
const ChatStub = defineActor({
    type: 'chat-stub',
    allowAnonymous: true,
    state: () => ({ count: 0 }),
    methods: (ctx) => ({ count: () => ctx.state.count }),
    subscriptions: {
        [SESSION_EVENTS_TOPIC]: (ctx, event) => {
            received.push(event.payload as SessionEvent);
            ctx.state.count++;
        }
    }
});

/**
 * `hold` bills 0.25 and then runs a tool — under the asking policy every session opens with, the turn waits on a
 * permission request until the test answers it; anything else bills 0.1 and answers in words.
 */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text === 'hold') return [{ usage: USAGE, costUsd: 0.25 }, { tool: { name: 'work', input: {}, output: 'done' } }, { text: 'held and done' }];
            return [{ usage: USAGE, costUsd: 0.1 }, { text: `echo: ${text}` }];
        }
    });
}

/** What the factory was handed for every local open — `currentTaskId` is what the ports read per call. */
let contexts: SessionFactoryContext[];
function factory(agent: MockAgent): SessionFactory {
    return async (runtime, c) => {
        if (runtime !== 'anthropic-api') return null;
        contexts.push(c);
        const session = await agent.session({ policy: firstMatch(), signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
        return { session, agentId: agent.id, capabilities: agent.capabilities };
    };
}

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

let app: TestActorApp;
let agent: MockAgent;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let audit: ReturnType<typeof capturingAuditPort>;
const sent: WireCommand[] = [];
const sink: CommandSink = { send: async (_target, command) => void sent.push(command) };

beforeEach(async () => {
    received.length = 0;
    sent.length = 0;
    contexts = [];
    agent = scriptedAgent();
    audit = capturingAuditPort();
    Session = defineSessionActor({ factory: factory(agent), commands: sink, usage: ledgerRecorder(), audit });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Session });
    app = testActorApp([Session, Routing, TaskActor, AgentActor, Memory, LedgerActor, ChatStub]);
    await app.start();
    for (const id of [ADA, BOB]) {
        await app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: id, instructions: 'Be brief.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    }
});
afterEach(() => app.stop());

const session = (id: string, principal: Principal = owner) => app.as(principal).actor(Session, actorKey(WS, 'session', id));
const task = (id: TaskId) => app.as(owner).actor(TaskActor, taskKey(WS, id));
const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const ledger = () => app.as(owner).actor(LedgerActor, ledgerKey(WS, ledgerMonth(Date.now())));
const memory = () => app.as(owner).actor(Memory, memoryActorKey(WS, agentMemoryScope(ADA)));
const settled = (id: string) => until(async () => !(await session(id).get()).running, `session ${id} to settle`);
const signal = () => new AbortController().signal;

/** Tasks A and B, both Ada's, both active on `sessionId` — the session opens for A and then serves B. */
async function twoTasks(sessionId: SessionId): Promise<void> {
    for (const id of [A, B]) {
        await task(id).create({ objective: `work ${id}`, origin: { kind: 'external', clientId: 'c1' }, assignee: ADA, context: [], constraints: {} }, { owner: ADA });
        await task(id).start('user:u1', sessionId);
    }
}

/** The rows one session's turns wrote, as `[turnId, taskId]` by turn — a delegated child's rows are its own session's. */
async function billed(sessionId: string): Promise<(string | undefined)[][]> {
    return (await ledger().rows())
        .filter((r) => r.sessionId === sessionId)
        .map((r) => [r.turnId, r.taskId])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
}

describe('one session, many tasks: the turn owns the task (#390)', () => {
    it('local path: the second turn is attributed to its own task — delegate, task_report, Ledger and budget, audit, memory, chat', async () => {
        await twoTasks('session_1' as SessionId);
        await session('session_1').open({ agentId: ADA, runtime: 'anthropic-api', chatId: CHAT, taskId: A, config });
        const c = contexts.find((x) => x.sessionId === 'session_1')!;
        expect(c.currentTaskId()).toBe(A);
        // The ports as `anthropicApiRuntime` builds them: the identity minted once at open, the task read per call.
        const principal = mintAgentPrincipal({ workspaceId: WS, agentId: ADA, sessionId: 'session_1' as SessionId, taskId: A }) as AgentPrincipal;
        const ports = createActorToolPorts({ principal, taskId: c.currentTaskId, routing: () => Routing });

        // Turn A: the task the session opened with.
        expect(await session('session_1').prompt('first', 'tA')).toMatchObject({ kind: 'ack' });
        await settled('session_1');
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: A, parts: [{ type: 'text', text: 'echo: first' }] });
        expect(await billed('session_1')).toEqual([['tA', A]]);
        // A settles: from here on nothing may delegate from it or bill it.
        await task(A).complete({ artifacts: [], verified: false }, 'user:u1');

        // Turn B, for task B, held open on its permission request.
        expect(await session('session_1').prompt('hold', 'tB', undefined, undefined, { taskId: B })).toMatchObject({ kind: 'ack', turnId: 'tB' });
        await until(async () => (await session('session_1').get()).status === 'awaiting', 'turn B to ask');
        const info = await session('session_1').get();
        expect(info.running).toMatchObject({ turnId: 'tB', taskId: B });
        expect(currentTaskId(info)).toBe(B);
        expect(c.currentTaskId()).toBe(B);
        expect(audit.events.find((e) => e.kind === 'approval.requested')).toMatchObject({ sessionId: 'session_1', taskId: B });

        // delegate: a child of B, not of A.
        const outcome = await ports.task.delegate({ assignee: BOB, objective: 'child work', context: [], constraints: {} }, { callId: 'c1', signal: signal() });
        expect(outcome).toMatchObject({ taskId: childTaskId(B, 'c1'), status: 'completed' });
        expect((await task(B).get()).children).toEqual([childTaskId(B, 'c1')]);
        expect((await task(A).get()).children).toEqual([]);

        // task_report: filed against B; nothing lands on A.
        await ports.task.report({ status: 'progress', summary: 'halfway' }, { callId: 'r1', signal: signal() });
        expect((await routing().get()).reports).toEqual({ [B]: { status: 'progress', summary: 'halfway' } });

        // memory_remember: the provenance names B.
        const remember = platformTools(ports).find((t) => t.name === 'memory_remember')!;
        const stored = (await remember.run({ text: 'The user drinks tea.', kind: 'preference', tags: ['drinks'] }, { toolCallId: 'm1', signal: signal() })) as { id: string };
        expect((await memory().get(stored.id))?.provenance).toMatchObject({ sessionId: 'session_1', taskId: B });

        // The answer ends the turn: its chat message, its decision's audit row and its Ledger row all name B.
        await session('session_1').respond(info.openRequests[0]!, { type: 'permission', outcome: 'allow', scope: 'once' });
        await settled('session_1');
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: B, parts: [{ type: 'text', text: 'held and done' }] });
        expect(audit.events.find((e) => e.kind === 'approval.resolved')).toMatchObject({ sessionId: 'session_1', taskId: B });
        expect(await billed('session_1')).toEqual([
            ['tA', A],
            ['tB', B]
        ]);
        expect((await task(B).get()).costUsd).toBeCloseTo(0.25);
        expect((await task(A).get()).costUsd).toBeCloseTo(0.1);
    });

    it('daemon path: a tool.call on the second turn runs as that turn\'s task, although the Machine minted the principal for the first', async () => {
        await twoTasks('session_2' as SessionId);
        await session('session_2').open({ agentId: ADA, runtime: 'claude-code', chatId: CHAT, taskId: A, machineId: 'machine_1' as MachineId, config });
        // The daemon side: a served mock session; the test plays the Machine, forwarding its frames and relaying replies.
        const upstream: AgentSession = await agent.session({ policy: firstMatch() });
        const served = serveSession(upstream, { agentId: agent.id, capabilities: agent.capabilities });
        const frames: WireFrame[] = [];
        const pump = (async () => {
            for await (const f of served.events({ epoch: 0, seq: 0 })) frames.push(f);
        })();
        const asMachine = session('session_2', machine);
        const forward = async () => {
            const batch = frames.splice(0);
            if (batch.length) await asMachine.forwardFrames(batch);
        };
        const relay = async () => {
            for (const command of sent.splice(0)) await asMachine.commandReplied(await served.handleCommand(command));
        };
        const upstreamHas = (type: string, turnId?: string) => frames.some((f) => f.kind === 'event' && f.event.type === type && (turnId === undefined || f.event.turnId === turnId));
        // The principal as the Machine mints it (`onToolCall`): fixed at `openSession`, for task A.
        const minted = mintAgentPrincipal({ workspaceId: WS, agentId: ADA, sessionId: 'session_2' as SessionId, taskId: A });
        const port = createToolCallPort({ routing: () => Routing, sessions: () => Session });
        const call = (tool: string, input: unknown, callId: string) => port.call({ callId, sessionId: 'session_2' as SessionId, tool, input }, minted);

        // Turn A.
        expect(await session('session_2').prompt('first', 'tA')).toMatchObject({ kind: 'pending' });
        await relay();
        expect((await session('session_2').get()).running).toMatchObject({ turnId: 'tA', taskId: A });
        await until(() => upstreamHas('turn-end', 'tA'), 'turn A to end upstream');
        await forward();
        expect((await session('session_2').get()).running).toBeUndefined();
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: A });
        await task(A).complete({ artifacts: [], verified: false }, 'user:u1');

        // Turn B for task B: the task rides on the command record, so the daemon's ack starts the turn under it.
        expect(await session('session_2').prompt('hold', 'tB', undefined, undefined, { taskId: B })).toMatchObject({ kind: 'pending' });
        expect((await session('session_2').get()).running).toBeUndefined();
        await relay();
        expect((await session('session_2').get()).running).toMatchObject({ turnId: 'tB', taskId: B });
        await until(() => upstreamHas('request'), 'the permission request upstream');
        await forward();
        expect(audit.events.find((e) => e.kind === 'approval.requested' && e.sessionId === 'session_2')).toMatchObject({ taskId: B });

        // Every tool.call under the principal minted for A runs as B.
        expect(await call('task_report', { status: 'progress', summary: 'halfway' }, 'r1')).toEqual({ ok: true, status: 'progress' });
        expect((await routing().get()).reports).toEqual({ [B]: { status: 'progress', summary: 'halfway' } });
        const stored = (await call('memory_remember', { text: 'The user drinks coffee.', kind: 'preference', tags: ['drinks'] }, 'm1')) as { id: string };
        expect((await memory().get(stored.id))?.provenance).toMatchObject({ sessionId: 'session_2', taskId: B });
        const outcome = (await call('delegate', { assignee: BOB, objective: 'child work' }, 'c1')) as { taskId: string; status: string };
        expect(outcome).toMatchObject({ taskId: childTaskId(B, 'c1'), status: 'completed' });
        expect((await task(B).get()).children).toEqual([childTaskId(B, 'c1')]);
        expect((await task(A).get()).children).toEqual([]);

        // The answer ends the turn: the chat message, the decision's audit row and the Ledger row name B.
        const requestId = (await session('session_2').get()).openRequests[0]!;
        await session('session_2').respond(requestId, { type: 'permission', outcome: 'allow', scope: 'once' });
        await relay();
        await until(() => upstreamHas('turn-end', 'tB'), 'turn B to end upstream');
        await forward();
        expect((await session('session_2').get()).running).toBeUndefined();
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: B, parts: [{ type: 'text', text: 'held and done' }] });
        expect(audit.events.find((e) => e.kind === 'approval.resolved' && e.sessionId === 'session_2')).toMatchObject({ taskId: B });
        expect(await billed('session_2')).toEqual([
            ['tA', A],
            ['tB', B]
        ]);
        expect((await task(B).get()).costUsd).toBeCloseTo(0.25);
        expect((await task(A).get()).costUsd).toBeCloseTo(0.1);

        await served.close();
        await upstream.close();
        await pump;
    });
});

describe('a turn the runtime starts itself (#510)', () => {
    /**
     * Claude Code starts a turn of its own when a background task it waited on finishes: a `turn-start` with a turn id
     * the runtime minted and no prompt of ours behind it. The test plays it by prompting the served session directly —
     * the daemon's side — so the platform sees only its frames.
     */
    async function daemonSession(sessionId: string) {
        await twoTasks(sessionId as SessionId);
        await session(sessionId).open({ agentId: ADA, runtime: 'claude-code', chatId: CHAT, taskId: A, machineId: 'machine_1' as MachineId, config });
        const upstream: AgentSession = await agent.session({ policy: firstMatch() });
        const served = serveSession(upstream, { agentId: agent.id, capabilities: agent.capabilities });
        const frames: WireFrame[] = [];
        const pump = (async () => {
            for await (const f of served.events({ epoch: 0, seq: 0 })) frames.push(f);
        })();
        const asMachine = session(sessionId, machine);
        const upstreamHas = (type: string, turnId: string) => frames.some((f) => f.kind === 'event' && f.event.type === type && f.event.turnId === turnId);
        /** Forward what the daemon has, up to and including the first event matching `upTo`. */
        const forward = async (upTo?: (ev: WireFrame) => boolean) => {
            const i = upTo ? frames.findIndex(upTo) : frames.length - 1;
            const batch = frames.splice(0, i + 1);
            if (batch.length) await asMachine.forwardFrames(batch);
        };
        const handle = () => Promise.all(sent.splice(0).map((command) => served.handleCommand(command)));
        const relay = async () => {
            for (const reply of await handle()) await asMachine.commandReplied(reply);
        };
        /** The runtime starts turn `turnId` on its own and runs it to its end on the daemon's side. */
        const runtimeTurn = async (turnId: string, text: string) => {
            await served.handleCommand({ v: 1, commandId: turnId, type: 'prompt', turnId, input: [{ type: 'text', text }] });
            await until(() => upstreamHas('turn-end', turnId), `${turnId} to end upstream`);
        };
        const stop = async () => {
            await served.close();
            await upstream.close();
            await pump;
        };
        return { asMachine, forward, handle, relay, runtimeTurn, upstreamHas, stop };
    }
    const isStart = (f: WireFrame) => f.kind === 'event' && f.event.type === 'turn-start';

    it('is the running turn with no task; its end publishes the reply, and its usage bills no task', async () => {
        const d = await daemonSession('session_3');
        // A prompted turn for task A first.
        await session('session_3').prompt('first', 'tA');
        await d.relay();
        await until(() => d.upstreamHas('turn-end', 'tA'), 'turn A to end upstream');
        await d.forward();
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: A });

        await d.runtimeTurn('rt-1', 'background');
        await d.forward(isStart);
        const info = await session('session_3').get();
        expect(info.running).toMatchObject({ turnId: 'rt-1', commandId: 'rt-1', implicit: true });
        expect(info.running?.taskId).toBeUndefined();
        expect(info.status).toBe('running');
        expect(received.at(-1)).toMatchObject({ kind: 'status', status: 'typing', ref: 'rt-1' });

        await d.forward();
        const after = await session('session_3').get();
        expect(after.running).toBeUndefined();
        expect(after.status).toBe('idle');
        const reply = received.at(-1)!;
        expect(reply).toMatchObject({ kind: 'message', parts: [{ type: 'text', text: 'echo: background' }] });
        expect(reply).not.toHaveProperty('taskId');
        // The Ledger keeps the row, attributed to no task; task A is charged for its own turn only.
        expect(await billed('session_3')).toEqual([
            ['rt-1', undefined],
            ['tA', A]
        ]);
        expect((await task(A).get()).costUsd).toBeCloseTo(0.1);
        await d.stop();
    });

    it('a turn-start for a prompt whose ack is still out is that prompt’s turn, under its task', async () => {
        const d = await daemonSession('session_4');
        await session('session_4').prompt('first', 'tB', undefined, undefined, { taskId: B });
        // The daemon's frames race its reply: the turn-start lands before the ack.
        const replies = await d.handle();
        await until(() => d.upstreamHas('turn-end', 'tB'), 'turn B to end upstream');
        await d.forward(isStart);
        expect((await session('session_4').get()).running).toBeUndefined();
        for (const r of replies) await d.asMachine.commandReplied(r);
        expect((await session('session_4').get()).running).toMatchObject({ turnId: 'tB', taskId: B });
        expect((await session('session_4').get()).running).not.toHaveProperty('implicit');
        await d.forward();
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: B });
        await d.stop();
    });

    it('an ack that lands after its whole turn does not leave the session running, and the reply still reaches the chat (#605)', async () => {
        const d = await daemonSession('session_6');
        await session('session_6').prompt('first', 'tC', undefined, undefined, { taskId: B });
        // The frames and the reply travel apart: the turn's `turn-end` is in before its ack.
        const replies = await d.handle();
        await until(() => d.upstreamHas('turn-end', 'tC'), 'turn C to end upstream');
        await d.forward();
        for (const r of replies) await d.asMachine.commandReplied(r);
        const info = await session('session_6').get();
        expect(info.running).toBeUndefined();
        expect(info.status).toBe('idle');
        expect(received.at(-1)).toMatchObject({ kind: 'message', taskId: B, parts: [{ type: 'text', text: 'echo: first' }] });
        await d.stop();
    });

    it('hostEnded cuts it like any other turn: interrupted, the record idle, no task named', async () => {
        const d = await daemonSession('session_5');
        await d.asMachine.noteRef({ agent: 'claude-code', v: 1, id: 'sess-real' });
        await d.runtimeTurn('rt-2', 'background');
        await d.forward(isStart);
        expect((await session('session_5').get()).running).toMatchObject({ turnId: 'rt-2', implicit: true });

        await d.asMachine.hostEnded({ reason: 'the daemon restarted', code: 'restart' });
        const info = await session('session_5').get();
        expect(info.running).toBeUndefined();
        expect(info.status).toBe('idle');
        const end = (await session('session_5').events()).at(-1)!;
        expect(end).toMatchObject({ type: 'turn-end', turnId: 'rt-2', stopReason: 'error' });
        expect(received).toContainEqual(expect.objectContaining({ kind: 'status', status: 'task', ref: 'interrupted:rt-2' }));
        await d.stop();
    });
});
