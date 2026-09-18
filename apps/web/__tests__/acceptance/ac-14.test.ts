/**
 * AC-14 — A compatible remote A2A agent is connected. Its declared
 * capabilities and supported task/message operations are available
 * through the adapter.
 *
 * The app's registry on the in-process host (`host.ts`) with one extra
 * runtime: `a2a`, whose session factory is `a2aAgent` from `@agentic/a2a`
 * over an in-process A2A server (`createA2aHandler`, the same one the
 * platform exposes). A platform Session opens on it: the capabilities the
 * card declares are what the session records — cancel supported, resume
 * declared unsupported, the adapter's own limits listed — a message turn
 * streams through the session log to its answer, and `cancel` on a turn
 * in flight reaches the remote task (`CancelTask`). Deeper:
 * `packages/a2a/__tests__/client.test.ts` and `conformance.test.ts` (the
 * `agentConformance` subset through the adapter).
 *
 * The Routing actor opens local sessions for `anthropic-api` only, so a
 * remote A2A agent is not yet a runtime a task can be routed to — that is
 * the `a2a` plugin kind's follow-up (PLG-01, architecture §12); this
 * scenario opens the Session directly, exactly as the router would.
 */
import type { AgentId, SessionId } from '@agentic/core';
import { A2A_UNSUPPORTED, a2aAgent, agentCard, capabilitiesFrom } from '@agentic/a2a';
import { allowAll, type AgentEvent } from '@sigx/ai-agent';
import type { MockStep } from '@sigx/ai-agent/testing';
import { AGENT, fakeServer, type FakeServer } from '../../../../packages/a2a/__tests__/fake';
import { startHost, until, type AcceptanceHost } from './host';

let server: FakeServer;
let h: AcceptanceHost;
beforeEach(async () => {
    // The remote: a scripted agent behind the A2A server; turn 1 answers, turn 2 holds a slow tool open.
    const steps = (turn: number): readonly MockStep[] => (turn === 0 ? [{ text: 'Hello from A2A!' }] : [{ tool: { name: 'slow', delayMs: 60_000 } }]);
    server = fakeServer({ steps });
    h = await startHost({
        factory: () => async (runtime, c) => {
            if (runtime !== 'a2a') return null;
            const agent = a2aAgent(server.cardUrl, { fetch: server.fetch });
            await agent.connect();
            const session = await agent.session({ policy: allowAll, signal: c.signal, ...(c.resume ? { resume: c.resume } : {}) });
            return { session, agentId: agent.id, capabilities: agent.capabilities };
        }
    });
});
afterEach(async () => {
    await h.stop();
    for (const s of server.sessions.values()) await s.close().catch(() => {});
});

const textOf = (events: readonly AgentEvent[]): string => events.map((e) => (e.type === 'part-delta' ? (e as { delta: string }).delta : '')).join('');

describe('AC-14: a remote A2A agent through the adapter', () => {
    it('declares its capabilities from the card, answers a message through a platform session, and cancels a task in flight', async () => {
        const me = h.user('ac14_user');
        const agentId = await me.agent('Remote helper', { execution: { runtime: 'a2a', offlinePolicy: 'fail' } });
        const config = await me.agentActor(agentId).snapshotForSession();

        // What the card declares is what the adapter reports — and it says what it does not do (PLG-09).
        const adapter = a2aAgent(server.cardUrl, { fetch: server.fetch });
        const card = await adapter.connect();
        expect(card).toEqual(agentCard(AGENT, server.endpoint));
        expect(adapter.capabilities).toEqual(capabilitiesFrom(card));
        expect(adapter.capabilities).toMatchObject({ cancel: true, resume: false, steer: false, tools: 'none', promptParts: 'text+image' });
        expect(adapter.a2a).toMatchObject({ streaming: true, agentic: true, unsupported: A2A_UNSUPPORTED });
        expect(adapter.a2a?.skills.map((s) => s.id)).toEqual(['chat']);

        // A platform session on the remote runtime records those capabilities and streams a turn to its answer.
        const sessionId = 'session_a2a' as SessionId;
        const session = me.session(sessionId);
        const opened = await session.open({ agentId: agentId as AgentId, runtime: 'a2a', config });
        expect(opened.status).toBe('idle');
        expect(opened.capabilities).toEqual(adapter.capabilities);
        expect(await session.prompt('Say hello', 'turn-1')).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).some((e) => e.type === 'turn-end'), 'the first turn to end');
        const first = await session.events();
        expect(textOf(first)).toBe('Hello from A2A!');
        expect(first.find((e) => e.type === 'turn-end')).toMatchObject({ type: 'turn-end', stopReason: 'end_turn' });
        expect((await session.transcript())?.messages.at(-1)).toMatchObject({ role: 'assistant' });
        // The server saw one context (session) with one task (turn) so far.
        expect(server.sessions.size).toBe(1);

        // A turn in flight is cancelled through the session — `CancelTask` on the remote — and the log says so.
        expect(await session.prompt('Do the slow thing', 'turn-2')).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).some((e) => e.type === 'tool-update' && (e as { status: string }).status === 'in_progress'), 'the slow tool to start');
        expect((await session.get()).status).toBe('running');
        expect(await session.cancel()).toMatchObject({ kind: 'ack' });
        await until(async () => (await session.events()).filter((e) => e.type === 'turn-end').length === 2, 'the second turn to end');
        const events = await session.events();
        expect(events.filter((e) => e.type === 'turn-end').at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
        expect(events.filter((e) => e.type === 'tool-update').at(-1)).toMatchObject({ status: 'cancelled' });
        const [live] = server.sessions.values();
        const remote: AgentEvent[] = [];
        for await (const e of live!.subscribe({ epoch: 0, seq: 0 })) {
            remote.push(e);
            if (e.type === 'turn-end' && e.stopReason === 'cancelled') break;
        }
        expect(remote.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'cancelled' });
        expect(['idle', 'running']).toContain((await session.get()).status);
        expect(await session.close()).toMatchObject({ kind: 'ack' });
        expect((await session.get()).status).toBe('closed');
    });
});
