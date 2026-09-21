import { actorKey, SESSION_EVENTS_TOPIC, type AgentId, type ChatId, type FrozenAgentConfig, type MachineId, type Principal, type SessionEvent, type TaskId, type WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { allowAll, createReducer, createTranscript, reduceAgentEvent, type AgentEvent, type AgentSession, type EventCursor } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality, mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import { serveSession, type WireCommand, type WireFrame } from '@sigx/ai-agent/wire';

import { defineSessionActor, isInterruptedTurnEnd, type CommandSink, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
import { applySessionEntry, type SessionEntry, type SessionState } from '../src/session/state';
import { statusOf, testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const machine: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_1' as MachineId };
const AGENT = 'agent_1' as AgentId;
const CHAT = 'chat_1' as ChatId;
const KEY = actorKey(WS, 'session', 'session_1');
const CHAT_KEY = actorKey(WS, 'chat', CHAT);

const config: FrozenAgentConfig = {
    agentId: AGENT,
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
const spec: SessionOpenSpec = { agentId: AGENT, runtime: 'anthropic-api', chatId: CHAT, taskId: 'task_1' as TaskId, config };

/** The chat side of the topic: records what a Session publishes for `CHAT_KEY`. */
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

/** A question form as Claude Code's `AskUserQuestion` raises it: one property per question, a multi-select as an array. */
const FORM = {
    type: 'object',
    properties: {
        q1: { type: 'string', title: 'Focus', description: 'Which area?', anyOf: [{ enum: ['bugs', 'docs'] }, { type: 'string' }] },
        q2: { type: 'array', title: 'Scope', description: 'Which size?', items: { type: 'string' } }
    },
    required: ['q1', 'q2'],
    additionalProperties: false
};

/** A scripted agent: `slow` runs a long tool call, anything else answers in words. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text === 'slow') return [{ text: 'working ' }, { tool: { name: 'slow', input: { n: 1 }, output: 'done', delayMs: 2_000 } }, { text: 'after' }];
            if (text === 'ask') return [{ request: { kind: 'input', message: 'Which colour?' } }, { text: 'picked' }];
            if (text === 'ask-form') return [{ request: { kind: 'input', message: 'Focus: Which area?\nScope: Which size?', schema: FORM } }, { text: 'picked' }];
            return [{ text: `echo: ${text}`, chunkSize: 4 }];
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

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

/** Replay `tail(from)` up to `head`, then stop following. */
async function collectTail(stream: AsyncIterable<AgentEvent>, head: EventCursor): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const ev of stream) {
        out.push(ev);
        if (ev.epoch === head.epoch && ev.seq === head.seq) break;
    }
    return out;
}

let app: TestActorApp;
let agent: MockAgent;
let Session: ReturnType<typeof defineSessionActor>;
const sent: WireCommand[] = [];
const sink: CommandSink = { send: async (_target, command) => void sent.push(command) };

beforeEach(() => {
    received.length = 0;
    sent.length = 0;
    agent = scriptedAgent();
    Session = defineSessionActor({ factory: localFactory(agent), commands: sink });
    app = testActorApp([Session, ChatStub]);
    return app.start();
});
afterEach(() => app.stop());

const session = () => app.as(owner).actor(Session, KEY);
const settled = () => until(async () => !(await session().get()).running, 'the turn to settle');

describe('Session authorization', () => {
    it('admits only principals of the workspace, and machines only on the daemon path', async () => {
        expect(await statusOf(app.as(userPrincipal('u2')).actor(Session, KEY).get())).toBe(403);
        expect(await statusOf(app.as(null).actor(Session, KEY).get())).toBe(401);
        expect(await statusOf(session().forwardFrames([]))).toBe(403);
        expect(await statusOf(session().noteRef({ agent: 'mock', v: 1, id: 'r' }))).toBe(403);
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['tasks'] };
        expect(await statusOf(app.as(external).actor(Session, KEY).get())).toBe(403);
    });

    it('lets only the hosting machine of a remote session forward frames and replies', async () => {
        const asMachine = app.as(machine).actor(Session, KEY);
        const reply = { v: 1, kind: 'ack', commandId: 'x' } as const;
        const ref = { agent: 'claude-code', v: 1, id: 'real' };
        // Not opened, then opened locally: no machine hosts it.
        expect(await statusOf(asMachine.forwardFrames([]))).toBe(403);
        await session().open(spec);
        expect(await statusOf(asMachine.forwardFrames([]))).toBe(403);
        expect(await statusOf(asMachine.commandReplied(reply))).toBe(403);
        expect(await statusOf(asMachine.noteRef(ref))).toBe(403);

        const REMOTE_KEY = actorKey(WS, 'session', 'session_2');
        await app.as(owner).actor(Session, REMOTE_KEY).open({ ...spec, runtime: 'claude-code', machineId: 'machine_1' as MachineId });
        expect(await statusOf(app.as(machine).actor(Session, REMOTE_KEY).forwardFrames([]))).toBeUndefined();
        expect(await statusOf(app.as(machine).actor(Session, REMOTE_KEY).commandReplied(reply))).toBeUndefined();
        expect(await statusOf(app.as(machine).actor(Session, REMOTE_KEY).noteRef(ref))).toBeUndefined();
        const other: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_2' as MachineId };
        expect(await statusOf(app.as(other).actor(Session, REMOTE_KEY).forwardFrames([]))).toBe(403);
        expect(await statusOf(app.as(other).actor(Session, REMOTE_KEY).commandReplied(reply))).toBe(403);
        expect(await statusOf(app.as(other).actor(Session, REMOTE_KEY).noteRef(ref))).toBe(403);
    });
});

describe('Session turns (local path)', () => {
    it('opens, runs a turn through the driver, appends every event and snapshots the transcript', async () => {
        const opened = await session().open(spec);
        expect(opened.mode).toBe('local');
        expect(opened.ref?.agent).toBe('mock');
        expect(opened.capabilities?.resume).toBe('portable');

        const reply = await session().prompt('hello', 't1');
        expect(reply).toMatchObject({ kind: 'ack', turnId: 't1' });
        await settled();

        const info = await session().get();
        expect(info.status).toBe('idle');
        expect(info.transcriptAt).toEqual(info.head);
        const events = await session().events();
        checkEventInvariants(events, { fromStart: true });
        expect(events.at(-1)).toMatchObject({ type: 'state', value: 'idle' });
        const transcript = await session().transcript();
        expect(transcript?.messages.at(-1)).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'echo: hello' }] });

        // The chat saw the session start, the typing status and the final message — never a delta.
        expect(received.map((e) => (e.kind === 'status' ? e.status : e.kind))).toEqual(['session-started', 'typing', 'message']);
        expect(received.at(-1)).toMatchObject({ kind: 'message', agentId: AGENT, sessionId: 'session_1', taskId: 'task_1', parts: [{ type: 'text', text: 'echo: hello' }] });
        expect(await app.as(null).actor(ChatStub, CHAT_KEY).count()).toBe(3);
    });

    it('executes a duplicate prompt(commandId) once, before and after a reactivation', async () => {
        await session().open(spec);
        const first = await session().prompt('hello', 't1');
        const again = await session().prompt('hello', 't1');
        expect(again).toEqual(first);
        await settled();
        const starts = () => session().events().then((evs) => evs.filter((e) => e.type === 'turn-start'));
        expect(await starts()).toHaveLength(1);

        await app.host.deactivate({ type: 'session', key: KEY });
        expect(await session().prompt('hello', 't1')).toEqual(first);
        expect(await starts()).toHaveLength(1);
        expect(agent.sessions).toHaveLength(1);

        // A different commandId with the same turnId is a busy or a new turn, never a silent no-op.
        const other = await session().prompt('hello again', 't2');
        expect(other).toMatchObject({ kind: 'ack', turnId: 't2' });
        await settled();
        expect(await starts()).toHaveLength(2);
    });

    it('closes an evicted turn as interrupted on the next activation — replay-equal, never re-run', async () => {
        await session().open(spec);
        await session().prompt('slow', 't1');
        await until(async () => (await session().events()).some((e) => e.type === 'tool-call'), 'the tool call');

        // Kill the activation mid-turn: the record keeps what was appended and the running turn —
        // a snapshot plus the entries appended since (`ctx.append`), folded as a load folds them.
        await app.host.deactivate({ type: 'session', key: KEY });
        const record = await app.storage.load('session', KEY);
        const stored = structuredClone(record!.state) as SessionState;
        for (const entry of record!.log ?? []) applySessionEntry(stored, entry as SessionEntry);
        expect(stored.running?.turnId).toBe('t1');
        // Every event went through the O(entry) append, not a full save of the growing record.
        expect(app.appends.filter((w) => w.type === 'session').length).toBeGreaterThan(app.saves.filter((w) => w.type === 'session').length);
        // Re-activation restarts the driver from the task ledger; it finds no live session and closes the turn.
        await settled();

        const events = await session().events();
        const last = events.at(-1)!;
        expect(last.type).toBe('turn-end');
        expect(isInterruptedTurnEnd(last)).toBe(true);
        expect(last).toMatchObject({ turnId: 't1', stopReason: 'error', error: { code: 'process_exited' } });
        checkEventInvariants(events, { fromStart: true });
        checkReplayEquality(events, reduceAgentEvent);
        // Nothing ran twice: one turn-start, one tool call — and the call is closed as cancelled, not completed.
        expect(events.filter((e) => e.type === 'turn-start')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'tool-call')).toHaveLength(1);
        const transcript = await session().transcript();
        const tool = transcript?.messages.flatMap((m) => m.parts).find((p) => p.type === 'tool');
        expect(tool).toMatchObject({ name: 'slow', status: 'cancelled' });
        expect(transcript?.turn).toMatchObject({ turnId: 't1', stopReason: 'error' });
        expect(transcript?.state).toBe('idle');
        expect((await session().get()).status).toBe('idle');
        expect(received.some((e) => e.kind === 'status' && e.status === 'task' && e.ref === 'interrupted:t1')).toBe(true);

        // The session goes on in a new epoch, and the whole log still replays gaplessly.
        expect(await session().prompt('after', 't2')).toMatchObject({ kind: 'ack', turnId: 't2' });
        await settled();
        const all = await session().events();
        expect(all.at(-1)!.epoch).toBe(2);
        checkEventInvariants(all, { fromStart: true });
        checkReplayEquality(all, reduceAgentEvent);
        expect((await session().transcript())?.messages.at(-1)).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'echo: after' }] });
    });

    it('waits on a request and resumes on respond — one decision per request', async () => {
        await session().open(spec);
        await session().prompt('ask', 't1');
        await until(async () => (await session().get()).status === 'awaiting', 'the request');
        const info = await session().get();
        expect(info.openRequests).toHaveLength(1);
        const requestId = info.openRequests[0]!;

        const reply = await session().respond(requestId, { type: 'input', answers: 'blue' });
        expect(reply).toMatchObject({ kind: 'ack' });
        expect(await session().respond(requestId, { type: 'input', answers: 'red' })).toEqual(reply);
        await settled();

        const events = await session().events();
        checkEventInvariants(events, { fromStart: true });
        expect(events.filter((e) => e.type === 'request-resolved')).toHaveLength(1);
        expect(await session().get()).toMatchObject({ status: 'idle', openRequests: [] });
        expect((await session().transcript())?.messages.at(-1)).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'picked' }] });
    });

    it('shapes a free-text answer to a question form into the form — one answer per question, never dropped', async () => {
        await session().open(spec);
        await session().prompt('ask-form', 't1');
        await until(async () => (await session().get()).status === 'awaiting', 'the request');
        const requestId = (await session().get()).openRequests[0]!;

        await session().respond(requestId, { type: 'input', answers: 'attachments please' });
        await settled();

        const resolved = (await session().events()).find((e) => e.type === 'request-resolved');
        expect(resolved).toMatchObject({ outcome: 'input', answers: { q1: 'attachments please', q2: ['attachments please'] } });
    });

    it('passes an answer already shaped to the form through untouched', async () => {
        await session().open(spec);
        await session().prompt('ask-form', 't1');
        await until(async () => (await session().get()).status === 'awaiting', 'the request');
        const requestId = (await session().get()).openRequests[0]!;

        await session().respond(requestId, { type: 'input', answers: { q1: 'bugs', q2: ['small'] } });
        await settled();

        expect((await session().events()).find((e) => e.type === 'request-resolved')).toMatchObject({ answers: { q1: 'bugs', q2: ['small'] } });
    });

    it('a second open re-opens the record with the new placement (#393): the spec is replaced, the runtime session is not opened twice, the chat hears session-started once; a running turn leaves it as it is', async () => {
        const first = await session().open({ ...spec, environmentId: 'env_a' as SessionOpenSpec['environmentId'], objective: 'first' });
        expect(first.spec).toMatchObject({ environmentId: 'env_a', objective: 'first', taskId: 'task_1' });
        const again = await session().open({ ...spec, environmentId: 'env_b' as SessionOpenSpec['environmentId'], taskId: 'task_2' as TaskId, objective: 'second' });
        expect(again).toMatchObject({ mode: 'local', status: 'idle', spec: { environmentId: 'env_b', taskId: 'task_2', objective: 'second' } });
        expect(again.spec?.machineId).toBeUndefined();
        expect(agent.sessions).toHaveLength(1);
        expect(received.filter((e) => e.kind === 'status' && e.status === 'session-started')).toHaveLength(1);
        // Mid-turn the record is not touched: the running turn keeps the task and objective it was prompted under (#395 decides what a mid-turn message does).
        await session().prompt('hello', 't1');
        await until(async () => (await session().get()).running?.turnId === 't1', 'the turn to start');
        const running = await session().open({ ...spec, taskId: 'task_3' as TaskId, objective: 'third' });
        expect(running.spec).toMatchObject({ taskId: 'task_2', objective: 'second' });
        expect(running.status).toBe('running');
        await settled();
    });

    it('cancels a running turn', async () => {
        await session().open(spec);
        await session().prompt('slow', 't1');
        await until(async () => (await session().events()).some((e) => e.type === 'tool-call'), 'the tool call');
        expect(await session().cancel()).toMatchObject({ kind: 'ack' });
        await settled();
        const events = await session().events();
        expect(events.find((e) => e.type === 'turn-end')).toMatchObject({ stopReason: 'cancelled' });
        checkEventInvariants(events, { fromStart: true });
    });
});

describe('Session tail', () => {
    it('replays from { epoch: 0, seq: 0 } to the late joiner the same transcript the driver snapshotted', async () => {
        await session().open(spec);
        await session().prompt('one', 't1');
        await settled();
        await session().prompt('two', 't2');
        await settled();
        const info = await session().get();
        const replayed = await collectTail(session().tail({ epoch: 0, seq: 0 }), info.head);
        expect(replayed.map((e) => `${e.epoch}:${e.seq}`)).toEqual((await session().events()).map((e) => `${e.epoch}:${e.seq}`));

        const reduce = createReducer();
        const joiner = createTranscript(replayed[0]!.sessionId);
        for (const ev of replayed) reduce(joiner, ev);
        expect(joiner).toEqual(await session().transcript());
    });

    it('follows live events after the replay and ends when the session closes', async () => {
        await session().open(spec);
        await session().prompt('one', 't1');
        await settled();
        const head = (await session().get()).head;

        const seen: AgentEvent[] = [];
        const following = (async () => {
            for await (const ev of session().tail(head)) seen.push(ev);
        })();
        await session().prompt('two', 't2');
        await settled();
        await until(() => seen.some((e) => e.type === 'turn-end' && e.turnId === 't2'), 'the followed turn-end');
        expect(seen.every((e) => e.epoch > head.epoch || e.seq > head.seq)).toBe(true);

        expect(await session().close()).toMatchObject({ kind: 'ack' });
        await following;
        expect(seen.at(-1)).toMatchObject({ type: 'state', value: 'closed' });
        const closed = await session().get();
        expect(closed.status).toBe('closed');
        expect(closed.closedAt).toBeTypeOf('number');
        expect(await session().prompt('three', 't3')).toMatchObject({ kind: 'error', code: 'closed' });
        expect(received.at(-1)).toMatchObject({ kind: 'status', status: 'session-ended' });
    });
});

describe('Session on the daemon path', () => {
    const remote: SessionOpenSpec = { ...spec, runtime: 'claude-code', machineId: 'machine_1' as MachineId };

    it('sends commands through the sink, folds forwarded frames and settles turns from their replies', async () => {
        const opened = await session().open(remote);
        expect(opened.mode).toBe('remote');

        // The daemon side: a served mock session whose frames are forwarded by the machine.
        const upstream: AgentSession = await agent.session({ policy: allowAll });
        const served = serveSession(upstream, { agentId: agent.id, capabilities: agent.capabilities });
        const frames: WireFrame[] = [];
        const pump = (async () => {
            for await (const f of served.events({ epoch: 0, seq: 0 })) frames.push(f);
        })();
        const asMachine = app.as(machine).actor(Session, KEY);
        const forward = async () => {
            const batch = frames.splice(0);
            if (batch.length) await asMachine.forwardFrames(batch);
        };

        const pending = await session().prompt('hello', 't1');
        expect(pending).toMatchObject({ kind: 'pending', commandId: 't1' });
        expect(await session().prompt('hello', 't1')).toEqual(pending); // idempotent while the reply is out
        expect(sent).toHaveLength(1);
        const replied = await served.handleCommand(sent[0]!);
        await asMachine.commandReplied(replied);
        expect((await session().get()).running?.turnId).toBe('t1');
        expect(await session().prompt('hello', 't1')).toEqual(replied);

        await until(() => frames.some((f) => f.kind === 'event' && f.event.type === 'turn-end'), 'the upstream turn-end');
        await forward();
        const info = await session().get();
        expect(info.running).toBeUndefined();
        // The wire hello's `sessionRef` is not recorded (#389): a remote record keeps only a ref the daemon reported with `noteRef`.
        expect(info.ref).toBeUndefined();
        expect(info.capabilities).toEqual(agent.capabilities);
        const events = await session().events();
        checkEventInvariants(events, { fromStart: true });
        expect((await session().transcript())?.messages.at(-1)).toMatchObject({ role: 'assistant', parts: [{ type: 'text', text: 'echo: hello' }] });
        expect(received.at(-1)).toMatchObject({ kind: 'message', parts: [{ type: 'text', text: 'echo: hello' }] });

        // A replayed batch folds once; a gap marks the session disconnected without losing the log.
        const before = (await session().get()).head;
        await asMachine.forwardFrames(events.map((e) => ({ v: 1, kind: 'event', epoch: e.epoch, seq: e.seq, event: e }) as WireFrame));
        expect((await session().get()).head).toEqual(before);
        await asMachine.forwardFrames([{ v: 1, kind: 'gap', from: before, resumeAt: { epoch: 2, seq: 0 } }]);
        expect(await session().get()).toMatchObject({ status: 'disconnected', head: { epoch: 2, seq: 0 }, gap: { from: before } });

        await served.close();
        await upstream.close();
        await pump;
    });

    it('keeps only the ref the daemon reports: noteRef records a new identity once and an unchanged one writes nothing (#389)', async () => {
        await session().open(remote);
        const asMachine = app.as(machine).actor(Session, KEY);
        // The wire hello carries the placeholder the open reported — recorded as capabilities, never as the ref.
        const placeholder = { agent: 'claude-code', v: 1, id: 'cc_placeholder' };
        await asMachine.forwardFrames([{ v: 1, kind: 'hello', agentId: AGENT, sessionId: 'session_1', sessionRef: placeholder, capabilities: agent.capabilities, head: { epoch: 0, seq: 0 } } as WireFrame]);
        expect((await session().get()).ref).toBeUndefined();

        const writes = () => [...app.saves, ...app.appends].filter((w) => w.type === 'session').length;
        const real = { agent: 'claude-code', v: 1, id: 'sess-real', data: { cwd: '/work', epoch: 1 } };
        await asMachine.noteRef(real);
        expect((await session().get()).ref).toEqual(real);
        const written = writes();
        // The same identity (id and data.epoch) again, whatever else the ref carries: no entry.
        await asMachine.noteRef({ ...real, data: { cwd: '/elsewhere', epoch: 1 } });
        expect((await session().get()).ref).toEqual(real);
        expect(writes()).toBe(written);
        // A new id replaces it; so does a new epoch under the same id.
        const renamed = { ...real, id: 'sess-real-2' };
        await asMachine.noteRef(renamed);
        expect((await session().get()).ref).toEqual(renamed);
        expect(writes()).toBe(written + 1);
        const regenerated = { ...renamed, data: { cwd: '/work', epoch: 2 } };
        await asMachine.noteRef(regenerated);
        expect((await session().get()).ref).toEqual(regenerated);
        expect(writes()).toBe(written + 2);
    });

    /** A remote record running turn `t1`: opened, named by its runtime unless `named` is false, prompted and acknowledged, its turn started. */
    async function runningRemote(named = true) {
        await session().open(remote);
        const asMachine = app.as(machine).actor(Session, KEY);
        if (named) await asMachine.noteRef({ agent: 'claude-code', v: 1, id: 'sess-real' });
        await session().prompt('hello', 't1');
        await asMachine.commandReplied({ v: 1, kind: 'ack', commandId: 't1', turnId: 't1' });
        const start: AgentEvent = { type: 'turn-start', turnId: 't1', input: [{ type: 'text', text: 'hello' }], sessionId: 'sess-real', epoch: 1, seq: 1 };
        await asMachine.forwardFrames([{ v: 1, kind: 'event', epoch: 1, seq: 1, event: start }]);
        expect((await session().get()).running?.turnId).toBe('t1');
        return asMachine;
    }

    it('hostEnded (#420): a running turn is interrupted with the host’s reason, stamped between the head and the daemon’s next event; the record waits idle with its ref, and resume re-prompts it', async () => {
        const asMachine = await runningRemote();
        await asMachine.hostEnded({ reason: 'the daemon restarted', code: 'restarted' });
        const info = await session().get();
        expect(info).toMatchObject({ status: 'idle', opened: true, ref: { id: 'sess-real' }, spec: { machineId: 'machine_1' } });
        expect(info.running).toBeUndefined();
        const events = await session().events();
        const end = events.at(-1)!;
        expect(isInterruptedTurnEnd(end)).toBe(true);
        expect(end).toMatchObject({ turnId: 't1', error: { message: 'interrupted: the daemon restarted' } });
        expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'interrupted: the daemon restarted', data: { interrupted: true, host: 'restarted' } });
        // Never an integer the daemon could stamp: every platform event sits after (1, 1) and before (1, 2).
        for (const e of events.slice(1)) expect(e.epoch === 1 && e.seq > 1 && e.seq < 2).toBe(true);
        expect(received).toContainEqual(expect.objectContaining({ kind: 'status', status: 'task', ref: 'interrupted:t1' }));

        // Idempotent: the same word again writes nothing.
        const writes = () => [...app.saves, ...app.appends].filter((w) => w.type === 'session').length;
        const written = writes();
        await asMachine.hostEnded({ reason: 'the daemon restarted', code: 'restarted' });
        expect(writes()).toBe(written);

        // The cut turn is resumable: a new prompt carrying its input.
        sent.length = 0;
        expect(await session().resume()).toMatchObject({ kind: 'pending', commandId: 'resume:t1' });
        expect(sent).toEqual([expect.objectContaining({ type: 'prompt', turnId: 't1:resume', input: [{ type: 'text', text: 'hello' }] })]);
    });

    it('hostEnded (#420): a record its runtime never named is closed — nothing to resume from — and says so; the code defaults to closed', async () => {
        const asMachine = await runningRemote(false);
        await asMachine.hostEnded({ reason: 'gone' });
        const info = await session().get();
        expect(info.status).toBe('closed');
        expect(info.running).toBeUndefined();
        const events = await session().events();
        expect(isInterruptedTurnEnd(events.at(-1)!)).toBe(true);
        expect(events.find((e) => e.type === 'error')).toMatchObject({ data: { interrupted: true, host: 'closed' } });
        expect(received).toContainEqual(expect.objectContaining({ kind: 'status', status: 'session-ended' }));
        await asMachine.hostEnded({ reason: 'gone' });
        expect((await session().get()).status).toBe('closed');
    });

    it('hostEnded (#420): an idle record keeps its ref and stays idle; only its hosting machine may say it', async () => {
        await session().open(remote);
        const asMachine = app.as(machine).actor(Session, KEY);
        await asMachine.noteRef({ agent: 'claude-code', v: 1, id: 'sess-real' });
        expect(await statusOf(session().hostEnded({ reason: 'x' }))).toBe(403);
        const other: Principal = { kind: 'machine', workspaceId: WS, machineId: 'machine_2' as MachineId };
        expect(await statusOf(app.as(other).actor(Session, KEY).hostEnded({ reason: 'x' }))).toBe(403);
        await asMachine.hostEnded({ reason: 'x' });
        expect(await session().get()).toMatchObject({ status: 'idle', ref: { id: 'sess-real' } });
        expect(await session().events()).toEqual([]);
    });

    it('refuses a command it has nowhere to send', async () => {
        const noSink = defineSessionActor({ factory: () => null });
        const other = testActorApp([noSink]);
        await other.start();
        try {
            const s = other.as(owner).actor(noSink, KEY);
            await s.open({ ...spec, machineId: undefined });
            expect(await s.prompt('x', 't1')).toMatchObject({ kind: 'error', code: 'unsupported' });
            expect(await s.close()).toMatchObject({ kind: 'ack' });
            expect((await s.get()).status).toBe('closed');
        } finally {
            await other.stop();
        }
    });
});
