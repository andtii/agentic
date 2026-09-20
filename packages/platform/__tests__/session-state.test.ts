import { createTranscript, type AgentEvent } from '@sigx/ai-agent';
import type { WireCommand, WireReply } from '@sigx/ai-agent/wire';

import {
    INDEX_TURNS,
    MAX_COMMANDS,
    applySessionEntry,
    createEventLogStore,
    createTranscriptStore,
    cursorAfter,
    eventsAfter,
    findEvent,
    initialSessionState,
    knownEvents,
    parseSessionKey,
    requestById,
    type SessionState,
    type SessionStoreContext
} from '../src/session/index';

const ev = (epoch: number, seq: number, payload: Record<string, unknown>, sessionId = 's1'): AgentEvent => ({ sessionId, epoch, seq, ...payload }) as unknown as AgentEvent;

function fakeContext(state: SessionState = initialSessionState()): SessionStoreContext & { saves: number } {
    const c = {
        state,
        saves: 0,
        async save() {
            c.saves++;
        },
        snapshot: () => structuredClone(c.state)
    };
    return c;
}

describe('applySessionEntry', () => {
    it('folds an event once by (epoch, seq) and tracks status, requests and the running turn', () => {
        const s = initialSessionState();
        applySessionEntry(s, { t: 'set', patch: { running: { turnId: 't1', commandId: 't1', input: [], startedAt: 0 } } });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 1, { type: 'turn-start', turnId: 't1', input: [] }) });
        expect(s.status).toBe('running');
        applySessionEntry(s, { t: 'ev', ev: ev(1, 2, { type: 'request', turnId: 't1', requestId: 'r1' }) });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 2, { type: 'request', turnId: 't1', requestId: 'r1' }) });
        expect(s.events).toHaveLength(2);
        expect(s).toMatchObject({ status: 'awaiting', openRequests: ['r1'] });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 3, { type: 'request-resolved', turnId: 't1', requestId: 'r1' }) });
        expect(s).toMatchObject({ status: 'running', openRequests: [] });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 1, { type: 'turn-end', turnId: 't1' }) });
        expect(s.running).toBeDefined(); // behind the head: ignored
        applySessionEntry(s, { t: 'ev', ev: ev(1, 4, { type: 'turn-end', turnId: 't1' }) });
        expect(s.running).toBeUndefined();
        expect(s).toMatchObject({ status: 'idle', head: { epoch: 1, seq: 4 } });
        // A new epoch starts at seq 1 and is still after the head.
        applySessionEntry(s, { t: 'ev', ev: ev(2, 1, { type: 'error', code: 'x', recoverable: false }) });
        expect(s).toMatchObject({ status: 'error', head: { epoch: 2, seq: 1 } });
    });

    it('keeps a closed session closed until an explicit state event', () => {
        const s = initialSessionState();
        applySessionEntry(s, { t: 'set', patch: { status: 'closed' } });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 1, { type: 'turn-start', turnId: 't1', input: [] }) });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 2, { type: 'turn-end', turnId: 't1' }) });
        expect(s.status).toBe('closed');
    });

    it('patches with `set`, deleting undefined fields', () => {
        const s = initialSessionState();
        applySessionEntry(s, { t: 'set', patch: { mode: 'local', closedAt: 5 } });
        applySessionEntry(s, { t: 'set', patch: { closedAt: undefined } });
        expect(s.mode).toBe('local');
        expect('closedAt' in s).toBe(false);
    });

    it('remembers commands by id, keeps the first send time, forgets the input once replied (#391), and caps at MAX_COMMANDS oldest first', () => {
        const s = initialSessionState();
        const cmd = (id: string): WireCommand => ({ v: 1, commandId: id, type: 'prompt', turnId: id, input: [{ type: 'text', text: 'x'.repeat(1000) }] });
        const ack = (id: string): WireReply => ({ v: 1, kind: 'ack', commandId: id });
        applySessionEntry(s, { t: 'command', command: cmd('c0'), at: 1 });
        applySessionEntry(s, { t: 'command', command: cmd('c0'), at: 2 });
        // Sent, reply out: the whole command, for the reply to be applied against.
        expect(s.commands.c0).toEqual({ commandId: 'c0', type: 'prompt', at: 1, command: cmd('c0') });
        applySessionEntry(s, { t: 'reply', command: cmd('c0'), reply: ack('c0'), at: 3 });
        expect(s.commands.c0).toEqual({ commandId: 'c0', type: 'prompt', at: 1, reply: ack('c0') });
        for (let i = 1; i <= MAX_COMMANDS; i++) applySessionEntry(s, { t: 'reply', command: cmd(`c${i}`), reply: ack(`c${i}`), at: i });
        expect(s.commandOrder).toHaveLength(MAX_COMMANDS);
        expect(s.commands.c0).toBeUndefined();
        expect(s.commandOrder[0]).toBe('c1');
        // What MAX_COMMANDS replied prompts weigh: their ids and replies, never their inputs.
        expect(JSON.stringify(s.commands).length).toBeLessThan(MAX_COMMANDS * 200);
    });
});

describe('the index without prompts (#391)', () => {
    const image = { type: 'image', mediaType: 'image/png', data: 'A'.repeat(100_000) } as const;
    const start = (seq: number, turnId: string) => ev(1, seq, { type: 'turn-start', turnId, input: [{ type: 'text', text: 'hi' }, image] });

    it('indexes a turn-start stripped of its input, with the bytes the whole event took', () => {
        const s = initialSessionState();
        applySessionEntry(s, { t: 'ev', ev: start(1, 't1') });
        expect(s.index).toEqual([{ type: 'turn-start', turnId: 't1', epoch: 1, seq: 1, sessionId: 's1', bytes: JSON.stringify(start(1, 't1')).length }]);
        expect(JSON.stringify(s.index).length).toBeLessThan(200);
    });

    it('findEvent scans the window newest-first, then the index before the window — the full event while the window holds it', () => {
        const s = initialSessionState();
        applySessionEntry(s, { t: 'ev', ev: start(1, 't1') });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 2, { type: 'request', turnId: 't1', requestId: 'r1', kind: 'input' }) });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 3, { type: 'turn-end', turnId: 't1', stopReason: 'end_turn' }) });
        applySessionEntry(s, { t: 'ev', ev: start(4, 't2') });
        const inWindow = findEvent(s, (e) => e.type === 'turn-start' && e.turnId === 't1');
        expect(inWindow && 'input' in inWindow).toBe(true);
        expect(findEvent(s, (e) => e.type === 'turn-start')).toMatchObject({ turnId: 't2' });
        // Rolled out of the window: the stripped entry answers.
        applySessionEntry(s, { t: 'roll', page: { page: 0, count: 3, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: 3 } } });
        const paged = findEvent(s, (e) => e.type === 'turn-start' && e.turnId === 't1');
        expect(paged).toEqual({ type: 'turn-start', turnId: 't1', epoch: 1, seq: 1, sessionId: 's1', bytes: expect.any(Number) });
        expect(findEvent(s, (e) => e.type === 'part-delta')).toBeUndefined();
        expect(requestById(s, 'r1')).toEqual({ request: expect.objectContaining({ requestId: 'r1' }) });
        applySessionEntry(s, { t: 'ev', ev: ev(1, 5, { type: 'request-resolved', turnId: 't2', requestId: 'r1', outcome: 'input', by: 'client' }) });
        expect(requestById(s, 'r1')).toEqual({ request: expect.objectContaining({ requestId: 'r1' }), resolved: expect.objectContaining({ outcome: 'input' }) });
        expect(requestById(s, 'r9')).toBeUndefined();
    });

    it('a roll keeps the last INDEX_TURNS turns in the index and the requests still open, whatever their age', () => {
        const s = initialSessionState();
        let seq = 0;
        for (let t = 1; t <= INDEX_TURNS + 10; t++) {
            applySessionEntry(s, { t: 'ev', ev: ev(1, ++seq, { type: 'turn-start', turnId: `t${t}`, input: [] }) });
            applySessionEntry(s, { t: 'ev', ev: ev(1, ++seq, { type: 'tool-call', turnId: `t${t}`, callId: `c${t}`, name: 'ask_user', input: {} }) });
            applySessionEntry(s, { t: 'ev', ev: ev(1, ++seq, { type: 'request', turnId: `t${t}`, requestId: `r${t}`, callId: `c${t}`, kind: 'input' }) });
            // Every question but the third is answered.
            if (t !== 3) applySessionEntry(s, { t: 'ev', ev: ev(1, ++seq, { type: 'request-resolved', turnId: `t${t}`, requestId: `r${t}`, outcome: 'input', by: 'client' }) });
            applySessionEntry(s, { t: 'ev', ev: ev(1, ++seq, { type: 'turn-end', turnId: `t${t}`, stopReason: 'end_turn' }) });
        }
        const before = s.index!.length;
        applySessionEntry(s, { t: 'roll', page: { page: 0, count: seq - 5, first: { epoch: 1, seq: 1 }, last: { epoch: 1, seq: seq - 5 } } });
        const turns = s.index!.filter((e) => e.type === 'turn-start').map((e) => e.turnId);
        expect(turns).toHaveLength(INDEX_TURNS);
        expect(turns[0]).toBe('t11');
        expect(s.index!.length).toBeLessThan(before);
        // The open question of turn 3 and the call it asks about stay; its answered neighbours are gone.
        expect(s.index!.filter((e) => e.type === 'request').map((e) => e.requestId).slice(0, 2)).toEqual(['r3', 'r11']);
        expect(s.index!.filter((e) => e.type === 'tool-call').map((e) => e.callId).slice(0, 2)).toEqual(['c3', 'c11']);
        expect(requestById(s, 'r3')).toEqual({ request: expect.objectContaining({ requestId: 'r3' }) });
        expect(requestById(s, 'r4')).toBeUndefined();
        expect(knownEvents(s).some((e) => e.type === 'turn-start' && e.turnId === 't10')).toBe(false);
    });
});

describe('session helpers', () => {
    it('orders cursors by epoch, then seq', () => {
        expect(cursorAfter({ epoch: 1, seq: 9 }, { epoch: 2, seq: 1 })).toBe(true);
        expect(cursorAfter({ epoch: 1, seq: 2 }, { epoch: 1, seq: 3 })).toBe(true);
        expect(cursorAfter({ epoch: 1, seq: 3 }, { epoch: 1, seq: 3 })).toBe(false);
        expect(cursorAfter({ epoch: 2, seq: 0 }, { epoch: 1, seq: 9 })).toBe(false);
    });

    it('reads events after a cursor (exclusive), filtered by session id', () => {
        const events = [ev(1, 1, { type: 'x' }), ev(1, 2, { type: 'x' }), ev(2, 1, { type: 'x' }, 's2')];
        expect(eventsAfter(events).map((e) => `${e.epoch}:${e.seq}`)).toEqual(['1:1', '1:2', '2:1']);
        expect(eventsAfter(events, { epoch: 1, seq: 1 }).map((e) => `${e.epoch}:${e.seq}`)).toEqual(['1:2', '2:1']);
        expect(eventsAfter(events, { epoch: 2, seq: 1 })).toEqual([]);
        expect(eventsAfter(events, { epoch: 0, seq: 0 }, 's2').map((e) => e.sessionId)).toEqual(['s2']);
    });

    it('parses only `{ws}:session:{id}` keys', () => {
        expect(parseSessionKey('u1:session:abc')).toEqual({ workspaceId: 'u1', sessionId: 'abc' });
        expect(parseSessionKey('u1:chat:abc')).toBeNull();
        expect(parseSessionKey('u1:session:')).toBeNull();
        expect(parseSessionKey('ws:u1')).toBeNull();
    });
});

describe('session stores', () => {
    it('EventLogStore appends through the reducer with one save per event and reads from a snapshot', async () => {
        const c = fakeContext();
        const log = createEventLogStore(c);
        await log.append(ev(1, 1, { type: 'turn-start', turnId: 't1', input: [] }));
        await log.append(ev(1, 2, { type: 'turn-end', turnId: 't1' }));
        await log.append(ev(1, 2, { type: 'turn-end', turnId: 't1' }));
        expect(c.saves).toBe(3);
        expect(c.state.events).toHaveLength(2);
        const read: AgentEvent[] = [];
        for await (const e of log.read('s1', { epoch: 1, seq: 1 })) read.push(e);
        expect(read.map((e) => e.seq)).toEqual([2]);
        const other: AgentEvent[] = [];
        for await (const e of log.read('s2')) other.push(e);
        expect(other).toEqual([]);
    });

    it('TranscriptStore keeps one snapshot keyed by the runtime session id', async () => {
        const c = fakeContext();
        const store = createTranscriptStore(c);
        const t = createTranscript('s1');
        await store.save('s1', t);
        expect(await store.load('s1')).toEqual(t);
        expect(await store.load('s2')).toBeUndefined();
        await expect(store.save('s2', createTranscript('s1'))).rejects.toThrow(/saved under "s2"/);
        await store.delete?.('s2');
        expect(c.state.transcript).toBeDefined();
        await store.delete?.('s1');
        expect(c.state.transcript).toBeUndefined();
        expect(c.saves).toBe(2);
    });
});
