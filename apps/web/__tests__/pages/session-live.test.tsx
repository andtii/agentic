/**
 * Session feeds and the live session page (#34): `connectSession` over the
 * Session actor, a turn of a mock runtime streamed through it — a feed
 * opened mid-turn (a reload) resumes from the durable log; the page folds
 * the record and the log into the session view.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { actorKey, type ChatId, type MessageId, type TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { openFeed } from '../../src/pages/chat/feeds';
import { inFlightMessages, type SessionActorClient } from '../../src/pages/chat/live';
import { capabilityReport, eventLines, liveSessionView } from '../../src/pages/session/live';
import { sessionHead } from '../../src/pages/session/LiveSession';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from './live-harness';

/** The mock runtime: ten characters, one per 20 ms — a turn that is visibly mid-way for ~200 ms. */
const SLOW = { respond: () => [{ text: 'abcdefghij', chunkSize: 1, delayMs: 20 }] };

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(SLOW);
});
afterEach(async () => {
    await h.stop();
});

/** A chat with one agent, a task from a message, routed — resolves once the session is running. */
async function startTurn() {
    const agentId = await h.agent('Atlas', 'Assistant');
    const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
    const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
    await chat.addAgent(agentId, 'all');
    const { messageId } = await chat.post('go', [agentId]);
    const taskId = 't_live' as TaskId;
    await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: 'go', origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    const view = await h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId);
    const sessionId = view.sessionId!;
    const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId)) as unknown as SessionActorClient;
    return { agentId, chatId, chat, taskId, sessionId, session };
}

const text = (feed: ReturnType<typeof openFeed>): string => feed.transcript.messages.filter((m) => m.role === 'assistant').flatMap((m) => m.parts).map((p) => (p as { text?: string }).text ?? '').join('');

describe('session feeds', () => {
    it('a feed opened mid-turn resumes from the session log: what streamed before it connected is there, what streams after arrives live', async () => {
        const { sessionId, session, agentId } = await startTurn();
        const errors: Error[] = [];
        // The first tab: follows from the start of the turn.
        const first = openFeed(session, sessionId, agentId, (e) => errors.push(e));
        await until(() => text(first).length >= 3, 'the first tab to see three characters', 3_000);
        expect(first.transcript.state).toBe('running');
        expect(inFlightMessages(first.transcript)).toHaveLength(1);
        // The tab closes mid-turn…
        first.disconnect();
        const seen = text(first).length;
        expect(seen).toBeLessThan(10);
        // …and reloads: the new feed replays the log from its start, so nothing streamed before it is missing.
        const second = openFeed(session, sessionId, agentId, (e) => errors.push(e));
        await until(() => text(second).length >= seen, 'the reloaded tab to catch up', 3_000);
        expect(text(second)).toBe('abcdefghij'.slice(0, text(second).length));
        // A chat member's session stays live after its task settles (#393): the turn ends, the session goes idle, nothing closes.
        await until(() => second.transcript.state === 'idle' && text(second) === 'abcdefghij', 'the turn to finish', 3_000);
        expect(inFlightMessages(second.transcript)).toEqual([]);
        expect(second.transcript.turn?.stopReason).toBe('end_turn');
        expect(second.client()?.agentId).toBe(agentId);
        expect(errors).toEqual([]);
        second.disconnect();
        // The record agrees: the durable log has the whole turn, and the session is idle, not closed.
        const info = await session.get();
        expect(info.status).toBe('idle');
        expect(info.running).toBeUndefined();
        expect(info.eventCount).toBeGreaterThan(10);
    });
});

describe('the session view', () => {
    it('lines the log one entry per event (deltas folded), reports capabilities as declared, and folds the record into the page view', async () => {
        const { sessionId, session, agentId } = await startTurn();
        let info: Awaited<ReturnType<SessionActorClient['get']>>;
        await (async () => {
            const deadline = Date.now() + 3_000;
            // The turn's end, not the session's close: a chat member's session is not closed when its task settles (#393).
            while ((await session.get()).running !== undefined) {
                if (Date.now() > deadline) throw new Error('turn did not end');
                await new Promise((r) => setTimeout(r, 20));
            }
        })();
        info = await session.get();
        const log = await h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId)).events();
        const lines = eventLines(log);
        expect(lines.map((l) => l.kind)).toEqual(['text', 'turn-end']);
        expect(lines[0]!.text).toBe('abcdefghij');
        expect(lines[1]!.text).toBe('end_turn');
        const report = capabilityReport('anthropic-api', info.capabilities);
        expect(report.supported).toContain('cancel');
        expect(report.unsupported.map((u) => u.op)).toContain('migrate');
        expect(capabilityReport('claude-code', undefined).supported).toEqual([]);
        const view = liveSessionView(sessionId, info, log, { id: agentId, name: 'Atlas', role: '', hue: 1, environment: { machine: 'platform', runtime: 'anthropic-api', account: 'byo-key' }, configVersion: 1 });
        expect(view).toMatchObject({ id: sessionId, agentId, state: 'idle', taskId: 't_live', openedFrom: expect.stringContaining('chat '), machine: { name: 'platform' }, runtimeVersion: 'anthropic-api', head: info.head });
        expect(view.interrupted).toBeUndefined();
        expect(view.events).toHaveLength(2);
        expect(view.current).toBeUndefined();
    });

    it('renders /sessions/:id from the actor: header, log tail, execution rail; the topbar reads the page’s head', async () => {
        const { sessionId } = await startTurn();
        const dom = await mountLive(`/sessions/${sessionId}`, h);
        await until(() => dom.querySelector('[data-session-id]') !== null, 'the session header');
        expect(dom.querySelector('[data-session-id]')!.textContent).toMatch(/^Session sess_/);
        expect(dom.querySelector('[data-session-main]')?.getAttribute('aria-label')).toBe('Session activity');
        await until(() => texts(dom.querySelectorAll('[data-event-kind]')).includes('turn-end'), 'the turn to end in the log');
        expect(texts(dom.querySelectorAll('[data-event-kind]'))).toEqual(['text', 'turn-end']);
        expect(dom.querySelector('[data-session-rail]')!.textContent).toContain('Atlas');
        expect(dom.querySelectorAll('[data-capability]').length).toBe(6);
        // No literals (#154): a platform session has no working dir, nothing prints a duration, no grant offers a Revoke.
        expect(dom.querySelector('[data-session-rail]')!.textContent).not.toContain('Working dir');
        expect(dom.textContent).not.toContain('3.4s');
        expect(dom.querySelectorAll('[data-grant] button')).toHaveLength(0);
        expect(sessionHead.value?.id).toBe(sessionId);
        // The turn ends and the session stays live, idle (#393); what the pill says of an idle live session is #398's.
        await until(() => sessionHead.value?.view.state === 'idle', 'the head to follow the turn end');
        expect(dom.querySelector('[data-session-head] [data-scope="ag-pill"]')!.textContent).not.toMatch(/active/i);
        const missing = await mountLive('/sessions/nope', h);
        await until(() => missing.querySelector('[data-scope="ag-empty"]') !== null, 'the not-found state');
        expect(missing.textContent).toContain('No session with that id');
    });
});
