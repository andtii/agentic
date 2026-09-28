/**
 * Session events carry the time the platform received them (#580): the actor stamps `at` on each `ev` entry as it
 * appends it (the reducer stays clock-free), the wire's own time wins where it carries one, the stamps never run
 * backwards, and they survive paging — `events()` and `tail()` read them back from the window and the pages alike.
 * An entry from before this change has no `at`, and nothing minds.
 */
import { actorKey, type AgentId, type FrozenAgentConfig, type TaskId, type WorkspaceId } from '@agentic/core';
import { allowAll, type AgentEvent, type EventCursor } from '@sigx/ai-agent';
import { mockAgent } from '@sigx/ai-agent/testing';

import { defineSessionActor, eventTime, SessionPage, stampEvent, type SessionFactory, type SessionOpenSpec } from '../src/session/index';
import { applySessionEntry, initialSessionState } from '../src/session/state';
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

/** About 1.5 MB of streamed text in 1 KB deltas: enough to page the window out more than once. */
const BIG = 'x'.repeat(1_500_000);

const factory: SessionFactory = async (runtime, c) => {
    if (runtime !== 'anthropic-api') return null;
    const agent = mockAgent({ respond: (input) => (input.some((p) => p.type === 'text' && p.text === 'big') ? [{ text: BIG, chunkSize: 1000 }] : [{ text: 'hi' }]) });
    const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
    return { session, agentId: agent.id, capabilities: agent.capabilities };
};

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** A clock that mostly moves forward but steps back now and then — the stamps must not follow it back. */
function wobblyClock(): () => number {
    let t = 1_790_000_000_000;
    let n = 0;
    return () => {
        n++;
        t += n % 7 === 0 ? -5_000 : 1_000;
        return t;
    };
}

function expectMonotonicTimes(events: readonly AgentEvent[]): void {
    let last = -Infinity;
    for (const ev of events) {
        const at = eventTime(ev);
        expect(at, `event (${ev.epoch}, ${ev.seq}) ${ev.type}`).toBeTypeOf('number');
        expect(at!).toBeGreaterThanOrEqual(last);
        last = at!;
    }
}

let app: TestActorApp;
let Session: ReturnType<typeof defineSessionActor>;

beforeEach(() => {
    Session = defineSessionActor({ factory, now: wobblyClock() });
    app = testActorApp([Session, SessionPage]);
    return app.start();
});
afterEach(() => app.stop());

const session = () => app.as(owner).actor(Session, KEY);

describe('session events carry a time (#580)', { timeout: 60_000 }, () => {
    it('events() and tail() read back a monotonic `at` on every event, across the pages and from a cursor inside them', async () => {
        await session().open(spec);
        await session().prompt('big', 't1');
        await until(async () => !(await session().get()).running, 'the turn to settle');
        await session().prompt('again', 't2');
        await until(async () => !(await session().get()).running, 'the second turn to settle');

        const info = await session().get();
        const all = await session().events();
        expect(all.length).toBe(info.eventCount);
        const { state } = (await app.storage.load('session', KEY))! as { state: { pages?: unknown[] } };
        expect(state.pages?.length ?? 0).toBeGreaterThanOrEqual(2);
        expectMonotonicTimes(all);

        // From a cursor inside the paged range: the same stamps.
        const mid = all[Math.floor(all.length / 3)]!;
        const since = await session().events({ epoch: mid.epoch, seq: mid.seq });
        expect(since.map(eventTime)).toEqual(all.slice(all.indexOf(mid) + 1).map(eventTime));

        const tailed: AgentEvent[] = [];
        const head: EventCursor = info.head;
        for await (const ev of session().tail({ epoch: 0, seq: 0 })) {
            tailed.push(ev);
            if (ev.epoch === head.epoch && ev.seq === head.seq) break;
        }
        expect(tailed.map(eventTime)).toEqual(all.map(eventTime));
    });

    it('stampEvent: the wire’s own time wins, never before the previous event; eventTime tolerates an entry from before', () => {
        const base = { sessionId: 's', epoch: 0, seq: 1 };
        const delta = { ...base, type: 'part-delta', partId: 'p', delta: 'x' } as AgentEvent;
        expect(eventTime(stampEvent(delta, 100))).toBe(100);
        expect(eventTime(stampEvent(delta, 100, 150))).toBe(150);
        const resolved = { ...base, type: 'request-resolved', requestId: 'r', outcome: 'allow', by: 'client', at: 90 } as AgentEvent;
        // The decision's own time is kept as is.
        expect(stampEvent(resolved, 100)).toBe(resolved);
        expect(eventTime(stampEvent(resolved, 100, 95))).toBe(95);
        // An event recorded before #580: no time, and the fold does not care.
        expect(eventTime(delta)).toBeUndefined();
        const state = initialSessionState();
        applySessionEntry(state, { t: 'ev', ev: delta });
        applySessionEntry(state, { t: 'ev', ev: stampEvent({ ...delta, seq: 2 }, 200, eventTime(delta)) });
        expect(state.events.map(eventTime)).toEqual([undefined, 200]);
    });
});
