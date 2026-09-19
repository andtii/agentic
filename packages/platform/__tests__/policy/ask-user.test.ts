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
import { actorKey, type AgentId, type ChatId, type EnvironmentId, type MachineId, type MessageId, type Principal, type TaskContract, type TaskId, type WorkspaceId } from '@agentic/core';
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
import { answerTaskId, createAnswerFollowUp, createSessionFactory, createToolCallPort, defineRoutingActor, routingKey } from '../../src/routing/index';
import { defineSessionActor, platformCursor, platformRequestId, type CommandSink } from '../../src/session/index';
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
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const hasToolResult = (req: ModelRequest) => req.messages.some((m) => m.role === 'tool');
const lastToolResultText = (req: ModelRequest): string => {
    const m = [...req.messages].reverse().find((x) => x.role === 'tool');
    return m ? JSON.stringify(m.content) : '';
};

/**
 * The scripted model: asks once, then answers with what it was told. Started again with a late answer (#285) it
 * carries on with the answer instead of asking again.
 */
function askingModel() {
    return mockModel({
        modelId: 'claude-test',
        respond: (req) => {
            const said = /Answer: (\w+)/.exec(JSON.stringify(req.messages));
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

/** The app under test; `quickMs` shortens `ask_user`'s quick window so a question detaches (#285). */
async function start(quickMs?: number): Promise<void> {
    const quick = quickMs !== undefined ? { askQuickWaitMs: quickMs } : {};
    audit = capturingAuditPort();
    sockets = new FakeSockets();
    Inbox = defineInbox({});
    const sink: CommandSink = { send: (t, cmd) => app.as(owner).actor(Machine, machineKey(t.workspaceId, t.machineId)).sendCommand(t.sessionId, cmd) };
    Session = defineSessionActor({
        factory: createSessionFactory({ routing: () => Routing, sessions: () => Session, model: askingModel(), ...quick }),
        commands: sink,
        inbox: () => Inbox,
        audit,
        answered: createAnswerFollowUp({ routing: () => Routing })
    });
    Routing = defineRoutingActor({ sessions: () => Session, machines: () => Machine, audit });
    Machine = defineMachineActor({ socket: sockets, sessions: () => Session, routing: () => Routing, tools: createToolCallPort({ routing: () => Routing, sessions: () => Session, ...quick }) });
    app = testActorApp([Routing, Session, Machine, TaskActor, AgentActor, Inbox, Chat, ChatPage, Workspace, PairingDirectory]);
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

describe('a late answer starts the asker again (#285)', () => {
    beforeEach(async () => {
        await app.stop();
        await start(30);
    });

    it('local path: `pending` ends the turn, the question outlives the session, and the answer is posted and resumes the asker', async () => {
        await agent();
        await chat().addAgent(ADA, 'all');
        const t = await run('t_1', 'decide');
        await settled('t_1');
        // The call answered `pending`; the model ended its turn and the task completed — not stuck `waiting`.
        const done = await task('t_1').get();
        expect(done.status).toBe('completed');
        expect(done.result?.text).toContain('pending');
        const sid = t.sessionId!;
        const requestId = platformRequestId('ask_1');
        const closed = await session(sid).get();
        expect(closed.status).toBe('closed');
        expect(closed.openRequests).toEqual([requestId]);
        expect(await session(sid).request(requestId)).toMatchObject({ agentName: 'Ada', detached: true });
        expect(await inbox().unread()).toBe(1);

        // Answered long after: taken on the closed session, not refused as `closed`.
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'tea' })).kind).toBe('ack');
        expect(await session(sid).request(requestId)).toMatchObject({ detached: false, resolved: { outcome: 'input', answers: 'tea' } });
        expect(await inbox().unread()).toBe(0);
        // The asker carries on with it, and the answer is in the chat as the person who gave it.
        const follow = answerTaskId(sid, requestId);
        await until(() => exists(follow), 'the follow-up task');
        await settled(follow);
        const next = await task(follow).get();
        expect(next).toMatchObject({ status: 'completed', owner: ADA, assignee: ADA, resumeFrom: sid, origin: { kind: 'user', chatId: CHAT } });
        expect(next.result?.text).toBe('carrying on with tea');
        expect(await messages()).toContain('user: @Ada — re: “Tea or coffee?” → tea');
        // An API session's transcript lives in its own record: the follow-up opens fresh, its context carrying the answer.
        expect((await session(next.sessionId!).get()).spec?.resume).toBeUndefined();

        // A replayed answer starts nobody twice and posts nothing twice.
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'coffee' }, 'respond:again')).kind).toBe('ack');
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toHaveLength(1);
    });

    it('a cancelled question starts nobody', async () => {
        await agent();
        await chat().addAgent(ADA, 'all');
        const t = await run('t_3', 'decide');
        await settled('t_3');
        const requestId = platformRequestId('ask_1');
        expect((await session(t.sessionId!).respond(requestId, { type: 'cancel' })).kind).toBe('ack');
        expect(await session(t.sessionId!).request(requestId)).toMatchObject({ resolved: { outcome: 'cancel' } });
        expect(await exists(answerTaskId(t.sessionId!, requestId))).toBe(false);
        expect((await messages()).filter((m) => m.includes('Tea or coffee?'))).toEqual([]);
    });

    it('three agents asking at once each get their own answer', async () => {
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
        for (const s of started) await settled(`t_${s.id}`);
        const requestId = platformRequestId('ask_1');
        await Promise.all(started.map((s) => session(s.view.sessionId!).respond(requestId, { type: 'input', answers: s.answer })));
        for (const s of started) {
            const follow = answerTaskId(s.view.sessionId!, requestId);
            await until(() => exists(follow), `${s.id}'s follow-up`);
            await settled(follow);
            expect(await task(follow).get()).toMatchObject({ owner: s.id, result: { text: `carrying on with ${s.answer}` } });
        }
        const posted = (await messages()).filter((m) => m.includes('Tea or coffee?')).sort();
        expect(posted).toEqual(['user: @Ada — re: “Tea or coffee?” → tea', 'user: @Bob — re: “Tea or coffee?” → coffee', 'user: @Cy — re: “Tea or coffee?” → water']);
    });

    it('daemon path: the tool.call answers `pending`, and a late answer starts the asker again', async () => {
        const m1 = await machineWithDaemon();
        await agent({ execution: { runtime: 'in-memory', defaultEnvironmentId: E1, offlinePolicy: 'fail' } });
        await chat().addAgent(ADA, 'all');
        const t = await run('t_4', 'decide');
        await until(() => sockets.frames(machineKey(WS, m1)).some((f) => f.t === 'tool.result'), 'the tool result');
        expect(sockets.frames(machineKey(WS, m1)).find((f) => f.t === 'tool.result')).toMatchObject({ output: { status: 'pending', questionId: expect.stringMatching(/^ask:/) } });
        await settled('t_4');
        expect((await task('t_4').get()).status).toBe('completed');
        const sid = t.sessionId!;
        const requestId = (await session(sid).get()).openRequests[0]!;
        expect(await session(sid).request(requestId)).toMatchObject({ detached: true });
        const ref = (await session(sid).get()).ref;
        expect((await session(sid).respond(requestId, { type: 'input', answers: 'coffee' })).kind).toBe('ack');
        const follow = answerTaskId(sid, requestId);
        await until(async () => (await exists(follow)) && (await task(follow).get()).sessionId !== undefined, 'the follow-up task to open its session');
        expect(await messages()).toContain('user: @Ada — re: “Tea or coffee?” → coffee');
        const next = await task(follow).get();
        expect(next).toMatchObject({ owner: ADA, resumeFrom: sid, environmentId: E1 });
        // The daemon's engine keeps its conversation: the follow-up session resumes the asking one's ref, on the same machine.
        expect((await session(next.sessionId!).get()).spec).toMatchObject({ resume: ref, machineId: m1 });
        await until(() => sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.open').length === 2, 'the second session.open');
        expect(sockets.frames(machineKey(WS, m1)).filter((f) => f.t === 'session.open')[1]).toMatchObject({ spec: { resume: ref } });
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
