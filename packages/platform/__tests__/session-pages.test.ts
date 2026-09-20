/**
 * The Session record under a Durable Object value's 2 MB (#198): the event
 * log keeps a window in the record and pages the rest out to `SessionPage`
 * actors, whole-history readers use the index, and the stored transcript
 * snapshot is bounded. What a client folds does not change: `tail` from the
 * start and `events()` yield every event, gapless and replay-equal, before and
 * after an eviction.
 */
import { actorKey, CHAT_FILE_INLINE_BUDGET, type AgentId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, createTranscript, reduceAgentEvent, type AgentEvent, type AgentTranscript, type EventCursor } from '@sigx/ai-agent';
import { checkEventInvariants, checkReplayEquality, mockAgent, type MockAgent } from '@sigx/ai-agent/testing';

import { boundTranscript, defineSessionActor, jsonBytes, PAGE_BYTES, SessionPage, sessionPageKey, TRANSCRIPT_BYTES, utf8Bytes, WINDOW_BYTES, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
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
    return { state, bytes: jsonBytes(record!.state) + jsonBytes(record!.log ?? []) };
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
            expect(jsonBytes(page!.state)).toBeLessThan(PAGE_BYTES + 64 * 1024);
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

    it('a roll is idempotent: replayed twice, it drops nothing more', () => {
        const state = initialSessionState();
        state.opened = true;
        let seq = 0;
        const ev = (e: Record<string, unknown>): AgentEvent => ({ sessionId: 's', epoch: 1, seq: ++seq, ...e }) as AgentEvent;
        applySessionEntry(state, { t: 'ev', ev: ev({ type: 'turn-start', turnId: 't1', input: [] }) });
        applySessionEntry(state, { t: 'ev', ev: ev({ type: 'request', requestId: 'r1', kind: 'input', turnId: 't1' }) });
        for (let i = 0; i < 21; i++) applySessionEntry(state, { t: 'ev', ev: ev({ type: 'part-delta', partId: 'p', delta: 'x'.repeat(1000), turnId: 't1' }) });
        expect(state.windowBytes).toBeGreaterThan(20_000);
        // A roll drops the oldest events and the index still answers for them.
        applySessionEntry(state, { t: 'roll', page: { page: 0, count: 10, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: 10 } } });
        expect(state.events).toHaveLength(13);
        expect(state.archived).toBe(10);
        expect(knownEvents(state).slice(0, 2).map((e) => e.type)).toEqual(['turn-start', 'request']);
        applySessionEntry(state, { t: 'roll', page: { page: 0, count: 10, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: 10 } } });
        expect(state.events).toHaveLength(13);
    });
});

describe('the record stays bounded over a long session (#391)', { timeout: 180_000 }, () => {
    /** A prompt as the chat sends one: text plus an image inlined up to the budget. */
    const image = { type: 'image', mediaType: 'image/png', data: 'A'.repeat(CHAT_FILE_INLINE_BUDGET) } as const;
    const TURNS = 50;

    it('50 turns each prompting with a 700 KB inlined image keep writing: the record and every page stay under the value limit, and the events, tail and fold still say everything', async () => {
        await session().open(spec);
        for (let i = 1; i <= TURNS; i++) {
            const reply = await session().prompt([{ type: 'text', text: `turn ${i}` }, image], `t${i}`);
            expect(reply.kind).toBe('ack');
            await settled();
        }

        const { state, bytes } = await storedState();
        const info = await session().get();
        // The record: a window, an index without prompts, replied commands without inputs, a bounded transcript.
        expect(bytes).toBeLessThan(2 * 1024 * 1024 - 256 * 1024);
        expect(state.windowBytes).toBeLessThanOrEqual(WINDOW_BYTES);
        const starts = state.index!.filter((e) => e.type === 'turn-start');
        expect(starts).toHaveLength(TURNS);
        for (const e of starts) {
            expect('input' in e).toBe(false);
            expect((e as { bytes: number }).bytes).toBeGreaterThan(CHAT_FILE_INLINE_BUDGET);
        }
        expect(Object.keys(state.commands)).toHaveLength(TURNS);
        for (const c of Object.values(state.commands)) {
            expect(c).toMatchObject({ type: 'prompt', reply: { kind: 'ack' } });
            expect(c.command).toBeUndefined();
        }
        for (const p of state.pages!) {
            const page = await app.storage.load('session-page', sessionPageKey(KEY, p.page));
            expect(jsonBytes(page!.state)).toBeLessThan(2 * 1024 * 1024 - 256 * 1024);
        }

        // Nothing was lost: every turn's prompt, image included, is still read back across the pages.
        const all = await session().events();
        expect(all).toHaveLength(info.eventCount);
        checkEventInvariants(all, { fromStart: true });
        const allStarts = all.filter((e) => e.type === 'turn-start');
        expect(allStarts).toHaveLength(TURNS);
        for (const e of allStarts) expect(e.type === 'turn-start' && e.input[1]).toEqual(image);
        const tailed = await collectTail(session().tail({ epoch: 0, seq: 0 }), info.head);
        expect(tailed).toEqual(all);
        const t = createTranscript('x');
        for (const ev of all) reduceAgentEvent(t, ev);
        const answers = t.messages.filter((m) => m.role === 'assistant').map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
        expect(answers).toEqual(Array.from({ length: TURNS }, (_, i) => `echo: turn ${i + 1}`));
        // The stored snapshot folded the same turns; only its old images gave way to notes.
        const stored = (await session().transcript())!;
        expect(stored.messages.map((m) => m.id)).toEqual(t.messages.map((m) => m.id));
        expect(jsonBytes(stored)).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
    });

    it('a replied command is still idempotent by its id after its input was dropped', async () => {
        await session().open(spec);
        const first = await session().prompt([{ type: 'text', text: 'hello' }, image], 't1');
        await settled();
        const { state } = await storedState();
        expect(state.commands.t1).toMatchObject({ commandId: 't1', type: 'prompt', reply: first });
        expect(state.commands.t1!.command).toBeUndefined();
        const before = (await session().get()).eventCount;
        // The retry, with another input even: the remembered reply, and no second turn.
        expect(await session().prompt('something else', 't1')).toEqual(first);
        expect((await session().get()).eventCount).toBe(before);
    });
});

describe('sizes are UTF-8 bytes, what a Durable Object value counts (#198)', () => {
    it('counts past-ASCII text at its encoded size, surrogate pairs as four', () => {
        for (const text of ['plain', 'åäö', '你好世界', '👍🏽 done', '\uD800 lone']) {
            expect(utf8Bytes(text), text).toBe(new TextEncoder().encode(text).length);
        }
        const ev = { sessionId: 's', epoch: 1, seq: 1, type: 'part-delta', partId: 'p', delta: '你好'.repeat(1000) };
        expect(jsonBytes(ev)).toBe(new TextEncoder().encode(JSON.stringify(ev)).length);
        expect(jsonBytes(ev)).toBeGreaterThan(JSON.stringify(ev).length * 2);
    });

    it('bounds a multi-byte transcript by its encoded size, not its code units', () => {
        const t = createTranscript('s');
        for (let i = 0; i < 20; i++) t.messages.push({ id: `m${i}`, role: 'assistant', parts: [{ type: 'tool', callId: `c${i}`, name: 'Read', status: 'completed', input: {}, output: '你'.repeat(40_000) } as never] });
        // 800 K code units — under the budget by `.length`, 2.4 MB encoded.
        expect(JSON.stringify(t).length).toBeLessThan(TRANSCRIPT_BYTES);
        expect(new TextEncoder().encode(JSON.stringify(boundTranscript(t))).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
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

    it('an old inlined image becomes exactly a text note — nothing of the attachment lingers (#391)', () => {
        const t = createTranscript('s');
        for (let i = 0; i < 3; i++) {
            t.messages.push({ id: `u${i}`, role: 'user', turnId: `t${i}`, parts: [{ type: 'text', text: `turn ${i}` }, { type: 'image', mediaType: 'image/png', data: 'A'.repeat(600_000), name: 'shot.png', size: 450_000 } as never] });
            t.messages.push({ id: `a${i}`, role: 'assistant', turnId: `t${i}`, parts: [{ type: 'text', id: `x${i}`, text: `answer ${i}` }] });
        }
        const b = boundTranscript(t);
        expect(JSON.stringify(b).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
        expect(b.messages[0]!.parts[1]).toEqual({ type: 'text', text: expect.stringMatching(/^\[image image\/png\] \[trimmed from the stored snapshot: \d+ KB/) });
        expect(Object.keys(b.messages[0]!.parts[1]!)).toEqual(['type', 'text']);
    });

    it('is a guarantee: one message alone past the budget is trimmed too, largest parts first', () => {
        const t = transcript(1, 3_000_000);
        const b = boundTranscript(t);
        expect(JSON.stringify(b).length).toBeLessThanOrEqual(TRANSCRIPT_BYTES);
        expect(String((b.messages[0]!.parts[1] as { output?: unknown }).output)).toMatch(/^\[trimmed/);
    });
});
