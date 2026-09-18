/**
 * The Session record under a Durable Object value's 2 MB (#198): the event
 * log keeps a window in the record and pages the rest out to `SessionPage`
 * actors, whole-history readers use the index, and the stored transcript
 * snapshot is bounded. What a client folds does not change: `tail` from the
 * start and `events()` yield every event, gapless and replay-equal, before and
 * after an eviction.
 */
import { actorKey, type AgentId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, createTranscript, reduceAgentEvent, type AgentEvent, type AgentTranscript, type EventCursor } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality, mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { boundTranscript, defineSessionActor, PAGE_BYTES, SessionPage, sessionPageKey, TRANSCRIPT_BYTES, WINDOW_BYTES, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
import { applySessionEntry, initialSessionState, knownEvents, type SessionEntry, type SessionState } from '../src/session/state';
import { testActorApp, userPrincipal, type TestActorApp } from '../src/testing/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const AGENT = 'agent_1' as AgentId;
const KEY = actorKey(WS, 'session', 'session_1');
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
const spec: SessionOpenSpec = { agentId: AGENT, runtime: 'anthropic-api', taskId: 'task_1' as TaskId, config };

/** About 1.5 MB of streamed text in 1 KB deltas: three windows' worth. */
const BIG = 'x'.repeat(1_500_000);

function scriptedAgent(): MockAgent {
    return mockAgent({
        respond: (input) => {
            const text = input.map((p) => (p.type === 'text' ? p.text : '')).join('');
            if (text === 'big') return [{ text: BIG, chunkSize: 1000 }];
            if (text === 'ask-then-big') return [{ request: { kind: 'input', message: 'Which colour?' } }, { text: BIG, chunkSize: 1000 }];
            if (text === 'big-then-slow') return [{ text: BIG, chunkSize: 1000 }, { tool: { name: 'slow', input: { n: 1 }, output: 'done', delayMs: 5_000 } }, { text: 'after' }];
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

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

async function collectTail(stream: AsyncIterable<AgentEvent>, head: EventCursor): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const ev of stream) {
        out.push(ev);
        if (ev.epoch === head.epoch && ev.seq === head.seq) break;
    }
    return out;
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;

beforeEach(() => {
    Session = defineSessionActor({ factory: localFactory(scriptedAgent()) });
    app = testActorApp([Session, SessionPage]);
    return app.start();
});
afterEach(() => app.stop());

const session = () => app.as(owner).actor(Session, KEY);
const settled = () => until(async () => !(await session().get()).running, 'the turn to settle');

/** The record as storage holds it, folded the way a load folds it (snapshot + appended log). */
async function storedState(): Promise<{ state: SessionState; bytes: number }> {
    const record = await app.storage.load('session', KEY);
    const state = structuredClone(record!.state) as SessionState;
    for (const entry of record!.log ?? []) applySessionEntry(state, entry as SessionEntry);
    return { state, bytes: JSON.stringify(record!.state).length + JSON.stringify(record!.log ?? []).length };
}

describe('Session event log paging (#198)', { timeout: 60_000 }, () => {
    it('keeps the record under its budget however much the turn streams; every page is under its own', async () => {
        await session().open(spec);
        await session().prompt('big', 't1');
        await settled();

        const { state, bytes } = await storedState();
        const info = await session().get();
        expect(state.pages!.length).toBeGreaterThanOrEqual(2);
        expect(info.eventCount).toBe(state.archived! + state.events.length);
        expect(state.windowBytes).toBeLessThanOrEqual(WINDOW_BYTES);
        // The record: the window, the index, the bounded transcript — far from 2 MB.
        expect(bytes).toBeLessThan(2 * 1024 * 1024 - 256 * 1024);
        for (const p of state.pages!) {
            const page = await app.storage.load('session-page', sessionPageKey(KEY, p.page));
            expect(JSON.stringify(page!.state).length).toBeLessThan(PAGE_BYTES + 64 * 1024);
        }
    });

    it('events() and tail() from the start yield every event across the pages — gapless and replay-equal', async () => {
        await session().open(spec);
        await session().prompt('big', 't1');
        await settled();
        const info = await session().get();
        const all = await session().events();
        expect(all).toHaveLength(info.eventCount);
        checkEventInvariants(all, { fromStart: true });
        checkReplayEquality(all, reduceAgentEvent);
        const tailed = await collectTail(session().tail({ epoch: 0, seq: 0 }), info.head);
        expect(tailed).toEqual(all);
        // The fold of every event carries the whole text: nothing was lost to the pages.
        const t = createTranscript('x');
        for (const ev of all) reduceAgentEvent(t, ev);
        const text = t.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : '')).join('');
        expect(text).toBe(BIG);
        // A reader from a cursor inside a page gets exactly what follows it.
        const mid = all[Math.floor(all.length / 2)]!;
        expect(await session().events({ epoch: mid.epoch, seq: mid.seq })).toEqual(all.slice(Math.floor(all.length / 2) + 1));
    });

    it('a request whose events were paged out still reads, resolves and lists — the index keeps it', async () => {
        await session().open(spec);
        await session().prompt('ask-then-big', 't1');
        await until(async () => (await session().get()).openRequests.length === 1, 'the request');
        const requestId = (await session().get()).openRequests[0]!;
        await session().respond(requestId, { type: 'input', answers: 'blue' });
        await settled();

        const { state } = await storedState();
        expect(state.events.some((e) => e.type === 'request')).toBe(false);
        const view = await session().request(requestId);
        expect(view).toMatchObject({ request: { requestId, kind: 'input', message: 'Which colour?' }, resolved: { outcome: 'input', answers: 'blue' } });
        expect((await session().requests()).map((r) => r.request.requestId)).toEqual([requestId]);
    });

    it('a reload after the window rolled folds the same record, and an evicted turn whose start is paged out still closes and resumes', async () => {
        await session().open(spec);
        await session().prompt('big-then-slow', 't1');
        await until(async () => (await session().events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await app.host.deactivate({ type: 'session', key: KEY });

        const { state } = await storedState();
        expect(state.running?.turnId).toBe('t1');
        expect(state.events.some((e) => e.type === 'turn-start')).toBe(false);
        expect(knownEvents(state).some((e) => e.type === 'turn-start' && e.turnId === 't1')).toBe(true);

        await until(async () => !(await session().get()).running, 'the interrupted turn to close');
        const all = await session().events();
        checkEventInvariants(all, { fromStart: true });
        expect(all.filter((e) => e.type === 'turn-start')).toHaveLength(1);
        expect(all.at(-1)).toMatchObject({ type: 'turn-end', turnId: 't1', stopReason: 'error', error: { code: 'process_exited' } });
        expect(await session().resume()).toMatchObject({ kind: expect.stringMatching(/ack|accepted|ok/) });
    });

    it('a record from before #198 — whole log in the window, no index — rolls down on its next append', () => {
        const state = initialSessionState();
        state.opened = true;
        let seq = 0;
        const ev = (e: Record<string, unknown>): AgentEvent => ({ sessionId: 's', epoch: 1, seq: ++seq, ...e }) as AgentEvent;
        state.events.push(ev({ type: 'turn-start', turnId: 't1', input: [] }), ev({ type: 'request', requestId: 'r1', kind: 'input', turnId: 't1' }));
        for (let i = 0; i < 20; i++) state.events.push(ev({ type: 'part-delta', partId: 'p', delta: 'x'.repeat(1000), turnId: 't1' }));
        state.head = { epoch: 1, seq };
        delete state.windowBytes;
        delete state.index;
        applySessionEntry(state, { t: 'ev', ev: { sessionId: 's', epoch: 1, seq: seq + 1, type: 'part-delta', partId: 'p', delta: 'y', turnId: 't1' } as AgentEvent });
        expect(state.windowBytes).toBeGreaterThan(20_000);
        expect(state.index!.map((e) => e.type)).toEqual(['turn-start', 'request']);
        // A roll drops the oldest events and the index still answers for them.
        applySessionEntry(state, { t: 'roll', page: { page: 0, count: 10, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: 10 } } });
        expect(state.events).toHaveLength(13);
        expect(state.archived).toBe(10);
        expect(knownEvents(state).slice(0, 2).map((e) => e.type)).toEqual(['turn-start', 'request']);
        // Replayed twice, a roll drops nothing more.
        applySessionEntry(state, { t: 'roll', page: { page: 0, count: 10, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: 10 } } });
        expect(state.events).toHaveLength(13);
    });
});

describe('boundTranscript (#198)', () => {
    function transcript(messages: number, outputBytes: number): AgentTranscript {
        const t = createTranscript('s');
        for (let i = 0; i < messages; i++) {
            t.messages.push({
                id: `m${i}`,
                role: 'assistant',
                turnId: 't1',
                parts: [
                    { type: 'reasoning', id: `r${i}`, text: 'thinking '.repeat(100) },
                    { type: 'tool', callId: `c${i}`, name: 'Read', status: 'completed', input: { path: `f${i}` }, output: 'o'.repeat(outputBytes) } as never,
                    { type: 'text', id: `x${i}`, text: `answer ${i}` }
                ]
            });
        }
        return t;
    }

    it('leaves a transcript under the budget untouched', () => {
        const t = transcript(3, 1000);
        expect(boundTranscript(t)).toBe(t);
    });

    it('trims the oldest messages first — outputs and reasoning, with a marker — until it fits; the newest message and the text stay', () => {
        const t = transcript(40, 60_000);
        expect(JSON.stringify(t).length).toBeGreaterThan(TRANSCRIPT_BYTES);
        const b = boundTranscript(t);
        expect(JSON.stringify(b).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
        const tool = (i: number) => b.messages[i]!.parts[1] as { output?: unknown };
        expect(String(tool(0).output)).toMatch(/^\[trimmed from the stored snapshot: \d+ KB/);
        expect(tool(39).output).toBe('o'.repeat(60_000));
        expect(b.messages.map((m) => (m.parts[2] as { text: string }).text)).toEqual(t.messages.map((_, i) => `answer ${i}`));
        // The input: the original, never the caller's object.
        expect((t.messages[0]!.parts[1] as { output?: unknown }).output).toBe('o'.repeat(60_000));
    });

    it('is a guarantee: one message alone past the budget is trimmed too, largest parts first', () => {
        const t = transcript(1, 3_000_000);
        const b = boundTranscript(t);
        expect(JSON.stringify(b).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
        expect(String((b.messages[0]!.parts[1] as { output?: unknown }).output)).toMatch(/^\[trimmed/);
    });
});
