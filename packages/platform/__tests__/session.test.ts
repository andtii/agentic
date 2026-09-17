import { actorKey, SESSION_EVENTS_TOPIC, type AgentId, type ChatId, type FrozenAgentConfig, type MachineId, type Principal, type SessionEvent, type TaskId, type WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { allowAll, createReducer, createTranscript, reduceAgentEvent, type AgentEvent, type AgentSession, type EventCursor } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality, mockAgent, type MockAgent } from '@sigx/ai-agent/testing';
import { serveSession, type WireCommand, type WireFrame } from '@sigx/ai-agent/wire';

import { defineSessionActor, isInterruptedTurnEnd, type CommandSink, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
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

/** A scripted agent: `slow` runs a long tool call, anything else answers in words. */
function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text === 'slow') return [{ text: 'working ' }, { tool: { name: 'slow', input: { n: 1 }, output: 'done', delayMs: 2_000 } }, { text: 'after' }];
            if (text === 'ask') return [{ request: { kind: 'input', message: 'Which colour?' } }, { text: 'picked' }];
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
        expect(await statusOf(app.as(machine).actor(Session, KEY).forwardFrames([]))).toBeUndefined();
        const external: Principal = { kind: 'external', workspaceId: WS, clientId: 'c', scopes: ['tasks'] };
        expect(await statusOf(app.as(external).actor(Session, KEY).get())).toBe(403);
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

        // Kill the activation mid-turn: the record keeps what was appended and the running turn.
        await app.host.deactivate({ type: 'session', key: KEY });
        const stored = (await app.storage.load('session', KEY))?.state as { running?: { turnId: string } } | undefined;
        expect(stored?.running?.turnId).toBe('t1');
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

    it('never switches a recorded session to another environment or machine on a second open', async () => {
        const first = await session().open({ ...spec, environmentId: 'env_a' as SessionOpenSpec['environmentId'] });
        const again = await session().open({ ...spec, environmentId: 'env_b' as SessionOpenSpec['environmentId'], machineId: 'machine_2' as MachineId });
        expect(again.spec).toEqual(first.spec);
        expect(again).toMatchObject({ mode: 'local', spec: { environmentId: 'env_a' } });
        expect(again.spec?.machineId).toBeUndefined();
        expect(agent.sessions).toHaveLength(1);
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
        expect(info.ref?.id).toBe(upstream.id);
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
