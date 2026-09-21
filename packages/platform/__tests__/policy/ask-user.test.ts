/**
 * `ask_user` end to end (#122; COL-06, CHT-09, OPS-02): a platform-raised
 * input request the user answers from any client. The local path runs the
 * REAL `createSessionFactory` over `createPlatformModelAgent` with a scripted
 * `mockModel` that calls `ask_user`; the daemon path runs the in-memory
 * daemon whose scripted tool call is `ask_user`, through the real Machine
 * actor and `createToolCallPort`. Either way the question is one `request
 * {kind: 'input'}` in the session log: the Task parks `waiting {input}`, the
 * Inbox gets an `input` row, the chat a `request` status, no audit event
 * (input is not an approval), and the answer from `Session.respond` is the
 * tool's result. Offline and deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type SessionId, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon, type PlatformSeat } from '@agentic/daemon-protocol/testing';
import type { ModelRequest } from '@sigx/ai';
import { mockModel } from '@sigx/ai/testing';
import type { AgentEvent } from '@sigx/ai-agent';

import { AgentActor, agentKey, type AgentConfigPatch } from '../../src/agent/index';
import { capturingAuditPort } from '../../src/audit/index';
import { workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { defineMachineActor, machineKey, parseMachineKey, type MachineSocketPort } from '../../src/machine/index';
import { defineInbox, inboxKey } from '../../src/notify/index';
import { PairingDirectory } from '../../src/pairing/index';
import { AnswerDeliveryError, answerObjective, answerTaskId, answerTurnId, createAnswerFollowUp, createSessionFactory, createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { ANSWER_ATTEMPTS, defineSessionActor, platformCursor, platformRequestId, type AnswerFollowUp, type CommandSink } from '../../src/session/index';
import { TaskActor, taskKey, type TaskView } from '../../src/task/index';
import { Workspace } from '../../src/workspace/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const ADA = 'agent_ada' as AgentId;
const CHAT = 'chat_1' as ChatId;
const E1 = 'env_1' as EnvironmentId;
const asMachine = (id: MachineId): Principal => ({ kind: 'machine', workspaceId: WS, machineId: id });

const until = async (check: () => Promise<boolean> | boolean, what: string, timeoutMs = 4_000): Promise<void> => {
    const deadline = performance.now() + timeoutMs;
    while (!(await check())) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const hasToolResult = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');
const lastToolResultText = (req: ModelRequest): string => {
    const m = [...req.messages].reverse().find((x) => x.role === 'tool');
    return m ? JSON.stringify(m.content) : '';
};

/**
 * The scripted model: asks once, then answers with what it was told. A late answer (#285) reaches it as a new user
 * message in its own live session (`The answer to your question “…”: tea`, #396) — or, started afresh with a
 * follow-up task, as the contract's `Answer:` line — and it carries on with it instead of asking again.
 */
function askingModel() {
    return mockModel({
        modelId: 'claude-test',
        respond: (req) => {
            const said = /(?:Answer|question “[^”]*”): (tea|coffee|water)/.exec(JSON.stringify(req.messages));
            if (said) return { text: `carrying on with ${said[1]}` };
            return hasToolResult(req) ? { text: `you said: ${lastToolResultText(req)}` } : { toolCalls: [{ name: 'ask_user', input: { question: 'Tea or coffee?', choices: ['tea', 'coffee'] }, id: 'ask_1' }] };
        }
    });
}

/** A fake socket layer bridged to `InMemoryDaemon` seats (the routing test's). */
class FakeSockets implements MachineSocketPort {
    readonly seats = new Map<string, PlatformSeat>();
    readonly sent = new Map<string, string[]>();
    connected = new Set<string>();
    send(key: string, text: string): boolean {
        if (!this.connected.has(key)) return false;
        (this.sent.get(key) ?? this.sent.set(key, []).get(key)!).push(text);
        this.seats.get(key)?.send(JSON.parse(text));
        return true;
    }
    close(key: string): void {
        this.seats.get(key)?.drop();
        this.seats.delete(key);
        this.connected.delete(key);
    }
    frames(key: string): Record<string, unknown>[] {
        return (this.sent.get(key) ?? []).map((t) => JSON.parse(t) as Record<string, unknown>);
    }
}

let app: TestActorApp;
let sockets: FakeSockets;
let Session: ReturnType<typeof defineSessionActor>;
let Routing: ReturnType<typeof defineRoutingActor>;
let Machine: ReturnType<typeof defineMachineActor>;
let Inbox: ReturnType<typeof defineInbox>;
let audit: ReturnType<typeof capturingAuditPort>;
const daemons: InMemoryDaemon[] = [];


interface StartOptions {
    /** Shortens `ask_user`'s quick window so a question detaches (#285). */
    readonly quickMs?: number;
    /** Wraps the real `createAnswerFollowUp` port (#396): the retry tests make an attempt throw, or watch what each hears. */
    readonly answered?: (real: (f: AnswerFollowUp) => Promise<void>) => (f: AnswerFollowUp) => Promise<void>;
    /** A reminder tick this fast (ms), when a test waits for a reminder in real time; the default never ticks. */
    readonly reminderTickMs?: number;
    /** A shorter retry schedule than `ANSWER_RETRY_MS` (#396), so the tests run in real time. */
    readonly answerRetry?: { readonly delaysMs?: readonly number[]; readonly attempts?: number };
}

/** The app under test. */
async function start(options: StartOptions = {}): Promise<void> {
    const quick = options.quickMs !== undefined ? { askQuickWaitMs: options.quickMs } : {};
    audit = capturingAuditPort();
    sockets = new FakeSockets();
    Inbox = defineInbox({});
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    const real = createAnswerFollowUp({ routing: () => Routing });
    Session = defineSessionActor({
        factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, model: askingModel(), ...quick }),
        commands: sink,
        inbox: () => Inbox,
        audit,
        answered: options.answered ? options.answered(real) : real,
        ...(options.answerRetry ? { answerRetry: options.answerRetry } : {})
    });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, audit });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session, ...quick }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Inbox, Chat, ChatPage, Workspace, PairingDirectory], options.reminderTickMs ? { defaults: { reminderTickMs: options.reminderTickMs } } : {});
    await app.start();
}

beforeEach(() => start());

afterEach(async () => {
    for (const d of daemons.splice(0)) d.stop();
    await app.stop();
});

const routing = () => app.as(owner).actor(Routing, routingKey(WS));
const task = (id: string) => app.as(owner).actor(TaskActor, taskKey(WS, id as TaskId));
const session = (id: string) => app.as(owner).actor(Session, actorKey(WS, 'session', id));
const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS));
const chat = () => app.as(owner).actor(Chat, actorKey(WS, 'chat', CHAT));
const machine = (id: MachineId, principal: Principal = owner) => app.as(principal).actor(Machine, machineKey(WS, id));

async function agent(patch: AgentConfigPatch = {}): Promise<void> {
    await app.as(owner).actor(AgentActor, agentKey(WS, ADA)).update({ name: 'Ada', instructions: 'Be brief.', tools: [{ name: 'ask_user' }], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' }, ...patch }, 'create');
}

async function run(id: string, objective: string, extra: Partial<TaskContract> = {}): Promise<TaskView> {
    await task(id).create({ objective, origin: { kind: 'user', chatId: CHAT, messageId: 'msg_1' as MessageId }, assignee: ADA, context: [], constraints: {}, ...extra }, { owner: ADA });
    return routing().run(id as TaskId);
}

const settled = (id: string) => until(async () => ['completed', 'failed', 'cancelled'].includes((await task(id).get()).status), `task ${id} to settle`);
const awaiting = (id: string) => until(async () => (await task(id).get()).status === 'waiting', `task ${id} to wait`);
const events = async (sessionId: string): Promise<AgentEvent[]> => session(sessionId).events();
const statuses = async () => (await chat().history()).entries.map((e) => e.entry).filter((e) => e.t === 'status').map((e) => `${e.kind}${e.ref && !e.ref.startsWith('session_') ? `:${e.ref}` : ''}`);
const routeOf = async (taskId: string) => (await routing().get()).routes.find((r) => r.taskId === taskId);
const transitions = async (taskId: string) => (await task(taskId).get()).transitions.map((t) => ({ to: t.to, why: t.why }));
/** The turn ended with the question open (#396): the task waits on it, its route parked and followed by nobody. */
const parked = (taskId: string) => until(async () => (await routeOf(taskId))?.status === 'waiting-answer', `task ${taskId}'s route to park waiting-answer`);
/** The text parts of a turn's input. */
const inputText = (ev: AgentEvent): string => (ev.type === 'turn-start' ? ev.input.map((p) => (p.type === 'text' ? p.text : '')).join('') : '');

/** Register + pair a machine and connect its in-memory daemon whose scripted tool is `ask_user`. */
async function machineWithDaemon(): Promise<MachineId> {
    const { machineId, pairingCode } = await app.as(owner).actor(Workspace, workspaceKey(WS)).registerMachinePending({ name: 'laptop' });
    await machine(machineId).pair(pairingCode, { name: 'laptop' });
    const d = inMemoryHarness({ machineId, environments: [inMemoryEnvironment(machineId, E1)] }).start({ events: 3, heartbeatMs: 600_000, tool: { name: 'ask_user', input: { question: 'Tea or coffee?' } } }) as InMemoryDaemon;
    daemons.push(d);
    const key = machineKey(WS, machineId);
    const ids = parseMachineKey(key)!;
    const seat = d.dial();
    sockets.seats.set(key, seat);
    sockets.connected.add(key);
    const asDaemon = machine(ids.machineId, asMachine(ids.machineId));
    void (async () => {
        try {
            for (;;) await asDaemon.socketMessage((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    await until(async () => (await machine(machineId).get()).online, 'the machine to come online');
    return machineId;
}

describe('ask_user on the local path (mockModel through createPlatformModelAgent)', () => {
    it('parks the task waiting {input}, lands an input notification and a chat status, and the answer from Session.respond is the tool result', async () => {
        await agent();
        const t = await run('t_1', 'decide');
        await awaiting('t_1');
        const sid = t.sessionId!;
        const requestId = platformRequestId('ask_1');
        const info = await session(sid).get();
        expect(info.status).toBe('awaiting');
        expect(info.openRequests).toEqual([requestId]);
        expect((await task('t_1').get()).wait).toEqual({ kind: 'input', requestId, sessionId: sid });
        // The Inbox: one unread `input` row deep-linked to the request; the chat: the paired status.
        expect(await inbox().list()).toMatchObject([{ kind: 'input', title: `Ada needs input`, body: 'Tea or coffee?', read: false, ref: { kind: 'session', sessionId: sid, requestId } }]);
        expect(await statuses()).toEqual(['session-started', `request:input:${requestId}`]);
        // The record a card renders: the question, the choices, the tool call's input from the transcript, the running turn.
        const record = (await session(sid).request(requestId))!;
        expect(record).toMatchObject({ sessionId: sid, agentId: ADA, chatId: CHAT, taskId: 't_1', request: { kind: 'input', toolName: 'ask_user', callId: 'ask_1', message: 'Tea or coffee?', options: [{ id: 'tea', label: 'tea' }, { id: 'coffee', label: 'coffee' }], turnId: 't_1:turn:1' }, input: { question: 'Tea or coffee?', choices: ['tea', 'coffee'] } });
        expect(record.rule).toBeUndefined();
        // Stamped between the runtime's events: after the head at the time, before the next integer seq.
        const request = (await events(sid)).find((e) => e.type === 'request')!;
        expect(Number.isInteger(request.seq)).toBe(false);
        // Not an approval: nothing audited.
        expect(audit.events.filter((e) => e.kind.startsWith('approval.'))).toEqual([]);

        const reply = await session(sid).respond(requestId, { type: 'input', answers: 'tea' });
        expect(reply.kind).toBe('ack');
        await settled('t_1');
        expect((await task('t_1').get()).status).toBe('completed');
        // The model saw the answer as the tool result and said so.
        expect((await task('t_1').get()).result?.text).toContain('tea');
        expect((await task('t_1').get()).result?.text).not.toContain('coffee');
        expect((await inbox().list()).map((n) => n.read)).toEqual([true]);
        expect(await statuses()).toContain(`request-resolved:input:${requestId}`);
        expect((await session(sid).request(requestId))!.resolved).toMatchObject({ outcome: 'input', by: 'client', answers: 'tea' });
        // One question, one answer, and every runtime event after the question still folded (the fractional stamp never collided).
        const evs = await events(sid);
        expect(evs.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(evs.filter((e) => e.type === 'request-resolved' && (e as { by: string }).by === 'client')).toHaveLength(1);
        expect(evs.filter((e) => e.type === 'tool-update' && (e as { status: string }).status === 'completed')).toHaveLength(1);
        expect(evs.some((e) => e.type === 'turn-end')).toBe(true);
        expect(audit.events.filter((e) => e.kind.startsWith('approval.'))).toEqual([]);
    });
});

describe('ask_user on the daemon path (tool.call through the Machine and createToolCallPort)', () => {
    it('tool.call → one input request on the session → inbox row → answer → tool.result with the answer; a re-sent call finds the same request', async () => {
        const m1 = await machineWithDaemon();
        await agent({ execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } });
        const t = await run('t_2', 'decide');
        await awaiting('t_2');
        const sid = t.sessionId!;
        const info = await session(sid).get();
        expect(info.mode).toBe('remote');
        expect(info.openRequests).toHaveLength(1);
        const requestId = info.openRequests[0]!;
        const call = sockets.frames(machineKey(WS, m1)).find((f) => f.t === 'session.open');
        expect(call).toBeDefined();
        expect((await task('t_2').get()).wait).toEqual({ kind: 'input', requestId, sessionId: sid });
        expect(await inbox().list()).toMatchObject([{ kind: 'input', title: `Ada needs input`, body: 'Tea or coffee?', ref: { kind: 'session', sessionId: sid, requestId } }]);
        expect(await statuses()).toContain(`request:input:${requestId}`);
        expect(sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'tool.result')).toEqual([]);

        await session(sid).respond(requestId, { type: 'input', answers: 'coffee' });
        await settled('t_2');
        expect((await task('t_2').get()).status).toBe('completed');
        const results = sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'tool.result');
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ output: { answer: 'coffee' } });
        expect(await inbox().unread()).toBe(0);
        // The daemon's events (integer seq) all folded after the platform's (fractional) ones: one request, one resolution, a turn end.
        const evs = await events(sid);
        expect(evs.filter((e) => e.type === 'request')).toHaveLength(1);
        expect(evs.filter((e) => e.type === 'request-resolved' && (e as { by: string }).by === 'client')).toHaveLength(1);
        expect(evs.some((e) => e.type === 'turn-end')).toBe(true);
        expect(audit.events.filter((e) => e.kind.startsWith('approval.'))).toEqual([]);
    });
});

/** The chat's messages as `author: text`. */
const messages = async () =>
    (await chat().history()).entries
        .map((e) => e.entry)
        .filter((e) => e.t === 'msg')
        .map((e) => `${e.author.kind === 'user' ? 'user' : e.author.agentId}: ${e.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')}`);
const exists = (id: TaskId) =>
    task(id)
        .get()
        .then(
            () => true,
            () => false
        );

describe('a late answer reaches the asker in its own session (#285, #396)', () => {
    beforeEach(async () => {
        await app.stop();
        await start({ quickMs: 30 });
    });

    it('local path: `pending` ends the turn, the task keeps waiting on the question in the live chat session, and the answer is steered into that session under the same task — no second task', async () => {
        await agent();
        await chat().addAgent(ADA, 'all');
        const t = await run('t_1', 'decide');
        const sid = t.sessionId!;
        const requestId = platformRequestId('ask_1');
        // The call answered `pending`; the model ended its turn saying so — and the task keeps waiting on the question,
        // its route parked and followed by nobody, in the member's session, which is idle, not closed.
        await parked('t_1');
        expect(await task('t_1').get()).toMatchObject({ status: 'waiting', wait: { kind: 'input', requestId, sessionId: sid } });
        expect(await routeOf('t_1')).toMatchObject({ status: 'waiting-answer', question: requestId, sessionId: sid });
        const idle = await session(sid).get();
        expect(idle.status).not.toBe('closed');
        expect(idle.running).toBeUndefined();
        expect(idle.openRequests).toEqual([requestId]);
        expect((await events(sid)).filter((e) => e.type === 'turn-end')).toHaveLength(1);
        expect(await session(sid).request(requestId)).toMatchObject({ agentName: 'Ada', detached: true });
        expect(await inbox().unread()).toBe(1);

        // Answered long after, while no turn runs: taken, delivered at once, and the asker carries on in the SAME task and
        // session — the answer is a new user message in a turn of its own, and the engine still holds the question.
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'tea' })).kind).toBe('ack');
        expect(await session(sid).request(requestId)).toMatchObject({ detached: false, resolved: { outcome: 'input', answers: 'tea' } });
        expect(await inbox().unread()).toBe(0);
        await settled('t_1');
        const done = await task('t_1').get();
        expect(done).toMatchObject({ status: 'completed', sessionId: sid });
        expect(done.result?.text).toBe('carrying on with tea');
        expect(await transitions('t_1')).toEqual([
            { to: 'active', why: 'started' },
            { to: 'waiting', why: 'waiting: input' },
            { to: 'active', why: `request ${requestId}: input` },
            { to: 'completed', why: 'completed' }
        ]);
        // No second task, and the route is done with.
        expect(await exists(answerTaskId(sid, requestId))).toBe(false);
        expect((await routing().get()).routes).toEqual([]);
        // The answer's turn in the same session, deterministic per question, carrying the answer as the prompt.
        const evs = await events(sid);
        const starts = evs.filter((e) => e.type === 'turn-start');
        expect(starts.map((e) => e.turnId)).toEqual(['t_1:turn:1', answerTurnId('t_1' as TaskId, requestId)]);
        expect(inputText(starts[1]!)).toContain(answerObjective('Tea or coffee?', 'tea'));
        expect(evs.filter((e) => e.type === 'turn-end')).toHaveLength(2);
        // The answer is in the chat as the person who gave it, and the session lives on.
        expect(await messages()).toContain('user: @Ada — re: “Tea or coffee?” → tea');
        expect((await session(sid).get())).toMatchObject({ status: 'idle' });
        expect(await statuses()).not.toContainEqual(expect.stringContaining('answer-not-delivered'));

        // A replayed answer prompts nobody twice and posts nothing twice.
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'coffee' }, 'respond:again')).kind).toBe('ack');
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toHaveLength(1);
        expect((await events(sid)).filter((e) => e.type === 'turn-start')).toHaveLength(2);
    });

    it('a dismissed question releases the task as it stands and starts nobody', async () => {
        await agent();
        await chat().addAgent(ADA, 'all');
        const t = await run('t_3', 'decide');
        await parked('t_3');
        const requestId = platformRequestId('ask_1');
        expect((await session(t.sessionId!).respond(requestId, { type: 'cancel' })).kind).toBe('ack');
        expect(await session(t.sessionId!).request(requestId)).toMatchObject({ resolved: { outcome: 'cancel' } });
        await settled('t_3');
        // Completed with what the asking turn said, no new turn, no follow-up, nothing posted.
        const done = await task('t_3').get();
        expect(done.status).toBe('completed');
        expect(done.result?.text).toContain('pending');
        expect(await transitions('t_3')).toEqual([
            { to: 'active', why: 'started' },
            { to: 'waiting', why: 'waiting: input' },
            { to: 'active', why: `request ${requestId}: cancel` },
            { to: 'completed', why: 'completed' }
        ]);
        expect((await events(t.sessionId!)).filter((e) => e.type === 'turn-start')).toHaveLength(1);
        expect(await exists(answerTaskId(t.sessionId!, requestId))).toBe(false);
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toEqual([]);
        expect((await routing().get()).routes).toEqual([]);
    });

    it('three agents asking at once each get their own answer, each in its own session and task', async () => {
        const agents = ['agent_ada', 'agent_bob', 'agent_cy'] as AgentId[];
        for (const [i, id] of agents.entries()) {
            await app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name: ['Ada', 'Bob', 'Cy'][i]!, instructions: 'Be brief.', tools: [{ name: 'ask_user' }], execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
            await chat().addAgent(id, 'all');
        }
        const started = await Promise.all(
            agents.map(async (id, i) => {
                await task(`t_${id}`).create({ objective: 'decide', origin: { kind: 'user', chatId: CHAT, messageId: 'msg_1' as MessageId }, assignee: id, context: [], constraints: {} }, { owner: id });
                return { id, answer: ['tea', 'coffee', 'water'][i]!, view: await routing().run(`t_${id}` as TaskId) };
            })
        );
        for (const s of started) await parked(`t_${s.id}`);
        const requestId = platformRequestId('ask_1');
        await Promise.all(started.map((s) => session(s.view.sessionId!).respond(requestId, { type: 'input', answers: s.answer })));
        for (const s of started) {
            await settled(`t_${s.id}`);
            expect(await task(`t_${s.id}`).get()).toMatchObject({ status: 'completed', owner: s.id, sessionId: s.view.sessionId, result: { text: `carrying on with ${s.answer}` } });
            expect(await exists(answerTaskId(s.view.sessionId!, requestId))).toBe(false);
        }
        const posted = (await messages()).filter((m) => m.includes('Tea or coffee?')).sort();
        expect(posted).toEqual(['user: @Ada — re: “Tea or coffee?” → tea', 'user: @Bob — re: “Tea or coffee?” → coffee', 'user: @Cy — re: “Tea or coffee?” → water']);
    });

    it('daemon path: the tool.call answers `pending`, and the late answer is prompted into the hosted session under the asking task — no second open, no second task', async () => {
        const m1 = await machineWithDaemon();
        await agent({ execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } });
        await chat().addAgent(ADA, 'all');
        const t = await run('t_4', 'decide');
        await until(() => sockets.frames(machineKey(WS, m1)).some((f) => f.t === 'tool.result'), 'the tool result');
        expect(sockets.frames(machineKey(WS, m1)).find((f) => f.t === 'tool.result')).toMatchObject({ output: { status: 'pending', questionId: expect.stringMatching(/^ask:/) } });
        await parked('t_4');
        const sid = t.sessionId!;
        const requestId = (await session(sid).get()).openRequests[0]!;
        expect(await task('t_4').get()).toMatchObject({ status: 'waiting', wait: { kind: 'input', requestId, sessionId: sid } });
        expect(await session(sid).request(requestId)).toMatchObject({ detached: true });
        const ref = (await session(sid).get()).ref;
        const prompts = () => sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.command' && (f.command as { type: string }).type === 'prompt');
        expect(prompts()).toHaveLength(1);

        expect((await session(sid).respond(requestId, { type: 'input', answers: 'coffee' })).kind).toBe('ack');
        // The asker's own hosted session (#393): no second `session.open` — a second prompt in the one session, under the asking task.
        await until(() => prompts().length === 2, 'the answer prompt');
        expect(await messages()).toContain('user: @Ada — re: “Tea or coffee?” → coffee');
        const answer = prompts()[1]!.command as { turnId: string; input: { type: string; text?: string }[] };
        expect(answer.turnId).toBe(answerTurnId('t_4' as TaskId, requestId));
        expect(answer.input.map((p) => p.text ?? '').join('')).toContain(answerObjective('Tea or coffee?', 'coffee'));
        expect(sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.open')).toHaveLength(1);
        expect(await exists(answerTaskId(sid, requestId))).toBe(false);
        // The record still opened for the asking task, the ref untouched; the task runs its answer turn.
        await until(async () => (await session(sid).get()).running?.turnId === answer.turnId, 'the answer turn to run');
        expect((await session(sid).get()).running).toMatchObject({ taskId: 't_4' });
        expect((await session(sid).get()).spec).toMatchObject({ taskId: 't_4', machineId: m1 });
        expect((await session(sid).get()).ref).toEqual(ref);
        expect(await routeOf('t_4')).toMatchObject({ status: 'running', turnId: answer.turnId });
        // Still the one task, at work (the daemon's scripted turn asks again, so it may already be waiting on that).
        expect(['active', 'waiting']).toContain((await task('t_4').get()).status);
    });
});

describe('a late answer no route can take: the follow-up task, retried and named (#396)', () => {
    /** The retry delay under test, in real time — `ANSWER_RETRY_MS` is the production schedule — and the reminder tick that fires it. */
    const RETRY_MS = 40;
    const TICK_MS = 25;
    /** Every hand-over the port heard, in order, with what it threw. */
    let heard: { f: AnswerFollowUp; error?: unknown }[];
    /** Throws at the hand-overs whose (1-based) attempt is listed, before the real port runs. */
    let failAt: Set<number>;

    beforeEach(async () => {
        await app.stop();
        heard = [];
        failAt = new Set();
        await start({
            quickMs: 30,
            reminderTickMs: TICK_MS,
            answerRetry: { delaysMs: [RETRY_MS] },
            answered: (real) => async (f) => {
                const attempt = heard.push({ f });
                try {
                    if (failAt.has(attempt)) throw new Error('the router could not be reached');
                    await real(f);
                } catch (e) {
                    heard[attempt - 1]!.error = e;
                    throw e;
                }
            }
        });
    });

    /** Long enough for the retry delay to pass and the reminder to tick (it fires "at or after due", the tick its resolution). */
    const tick = () => new Promise((r) => setTimeout(r, RETRY_MS + TICK_MS * 3));

    /** The asking task parked on its question, then cancelled: no route waits on the answer any more. */
    async function askedThenCancelled(id: string): Promise<{ sid: SessionId; requestId: string }> {
        await agent();
        await chat().addAgent(ADA, 'all');
        const t = await run(id, 'decide');
        await parked(id);
        const sid = t.sessionId!;
        await task(id).cancel('user:u1', { timeoutMs: 200 });
        expect((await task(id).get()).status).toBe('cancelled');
        return { sid, requestId: platformRequestId('ask_1') };
    }

    it('with the asking task settled, the answer starts the asker again with a follow-up task in its live session', async () => {
        const { sid, requestId } = await askedThenCancelled('t_5');
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'tea' })).kind).toBe('ack');
        const follow = answerTaskId(sid, requestId);
        await until(() => exists(follow), 'the follow-up task');
        await settled(follow);
        const next = await task(follow).get();
        expect(next).toMatchObject({ status: 'completed', owner: ADA, assignee: ADA, resumeFrom: sid, sessionId: sid, origin: { kind: 'user', chatId: CHAT } });
        expect(next.result?.text).toBe('carrying on with tea');
        expect(await messages()).toContain('user: @Ada — re: “Tea or coffee?” → tea');
        expect((await session(sid).get()).status).not.toBe('closed');
        // The settled task's route is gone, and the hand-over ran once.
        expect((await routing().get()).routes).toEqual([]);
        expect(heard).toHaveLength(1);
        expect(heard[0]!.error).toBeUndefined();
    });

    it('a hand-over that throws is retried on the answers reminder, after the first delay, and the answer is not lost', async () => {
        failAt = new Set([1]);
        const { sid, requestId } = await askedThenCancelled('t_6');
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'tea' })).kind).toBe('ack');
        await until(() => heard.length === 1, 'the first hand-over');
        expect(heard[0]!.error).toBeInstanceOf(Error);
        // Nothing said, nothing posted, no follow-up: the answer is parked for its retry.
        expect(await exists(answerTaskId(sid, requestId))).toBe(false);
        expect(await statuses()).not.toContainEqual(expect.stringContaining('answer-not-delivered'));
        expect(heard).toHaveLength(1);

        // The delay passes and the reminder ticks: the retry runs and delivers.
        await until(() => heard.length === 2, 'the retried hand-over');
        expect(heard[1]!.error).toBeUndefined();
        const follow = answerTaskId(sid, requestId);
        await until(() => exists(follow), 'the follow-up task');
        await settled(follow);
        expect((await task(follow).get()).result?.text).toBe('carrying on with tea');
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toHaveLength(1);
        expect(await statuses()).not.toContainEqual(expect.stringContaining('answer-not-delivered'));
    });

    it('when every attempt fails, the chat names the failed step and its cause once; the answer was posted once, and each retry knew it', async () => {
        const { sid, requestId } = await askedThenCancelled('t_7');
        // The asker leaves the chat: the post still goes out, the follow-up's creation cannot.
        expect(await chat().removeAgent(ADA)).toBe(true);
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'tea' })).kind).toBe('ack');
        await until(() => heard.length === 1, 'the first hand-over');
        for (let attempt = 1; attempt < ANSWER_ATTEMPTS; attempt++) {
            await until(() => heard[attempt - 1]!.error !== undefined, `attempt ${attempt} to fail`);
            expect(await statuses()).not.toContainEqual(expect.stringContaining('answer-not-delivered'));
            await until(() => heard.length === attempt + 1, `attempt ${attempt + 1}`);
        }
        await until(() => heard[ANSWER_ATTEMPTS - 1]!.error !== undefined, 'the last attempt to fail');
        await until(async () => (await statuses()).some((s) => s.includes('answer-not-delivered')), 'the failure to be said');
        // Every attempt failed at the same step, for the same reason, named as such.
        const cause = 'Ada is no longer a member of this chat; the answer is posted, nobody was started';
        for (const h of heard) {
            expect(h.error).toBeInstanceOf(AnswerDeliveryError);
            expect(h.error).toMatchObject({ step: 'create', cause, message: `create:${cause}`, status: 500, data: { code: 'answer-not-delivered', step: 'create', cause } });
        }
        expect(heard).toHaveLength(ANSWER_ATTEMPTS);
        // The answer was posted by the first attempt only; every later one was told so and posted nothing.
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toEqual(['user: @Ada — re: “Tea or coffee?” → tea']);
        expect(heard[0]!.f.posted).toBeUndefined();
        const posted = (heard[0]!.error as AnswerDeliveryError).posted;
        expect(posted).toBeDefined();
        for (const h of heard.slice(1)) expect(h.f.posted).toBe(posted);
        // Said once, naming the step and the cause — not `Internal error`.
        expect((await statuses()).filter((s) => s.includes('answer-not-delivered'))).toEqual([`task:answer-not-delivered:create:${cause}`]);
        expect(await exists(answerTaskId(sid, requestId))).toBe(false);
        // Given up: no further attempt however many ticks pass.
        await tick();
        expect(heard).toHaveLength(ANSWER_ATTEMPTS);
    });
});

describe('platformCursor', () => {
    it('is strictly after the head and strictly before the next integer seq, however many times it is applied', () => {
        let head = { epoch: 2, seq: 7 };
        for (let i = 0; i < 20; i++) {
            const next = platformCursor(head);
            expect(next.epoch).toBe(2);
            expect(next.seq).toBeGreaterThan(head.seq);
            expect(next.seq).toBeLessThan(8);
            head = next;
        }
        expect(platformCursor({ epoch: 0, seq: 0 })).toEqual({ epoch: 0, seq: 0.5 });
    });
});
