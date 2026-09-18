/**
 * AC-15 — An integration cannot resume or cancel a session. The limitation
 * is visible; the platform does not report a capability it lacks.
 *
 * The session page over the live harness (`../pages/live-harness`): the
 * runtime behind the Session actor declares `resume: false` and
 * `cancel: false`; a turn is running. `/sessions/:id` lists both as
 * unsupported with the runtime's own reason, renders no Cancel control in
 * the topbar (the page's contribution, as `App` mounts it) and no control
 * for migration, which no integration supports; a capability the runtime
 * did report (approvals) is listed as supported. The record agrees: the
 * Session stores the capabilities as declared, nothing more. Deeper:
 * `../pages/session.test.tsx` (the mock workspace's reduced runtimes) and
 * `../pages/session-live.test.tsx` (the report from a full runtime).
 */
import { component } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView, useRoute } from '@sigx/router';
import { actorKey, type ChatId, type MessageId, type TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, routingKey, taskKey, workspaceKey } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { topbarFor } from '../../src/components/topbar';
import { capabilityReport } from '../../src/pages/session/live';
import { sessionHead } from '../../src/pages/session/LiveSession';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from '../pages/live-harness';

/** A runtime that streams slowly (so the turn is visibly running) and cannot resume or cancel. */
const REDUCED = { capabilities: { resume: false as const, cancel: false, steer: false }, respond: () => [{ text: 'abcdefghij', chunkSize: 1, delayMs: 30 }] };

/** The topbar's actions slot, exactly as `App` renders the route's contribution. */
const TopbarActions = component(() => {
    const route = useRoute();
    return () => <div data-topbar-actions>{topbarFor(route)?.actions?.() ?? null}</div>;
});

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(REDUCED);
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
    const taskId = 't_reduced' as TaskId;
    await h.app.as(owner).actor(TaskActor, taskKey(WS, taskId)).create({ objective: 'go', origin: { kind: 'user', chatId: chatId as ChatId, messageId: messageId as MessageId }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
    const view = await h.app.as(owner).actor(h.Routing, routingKey(WS)).run(taskId);
    return { sessionId: view.sessionId!, session: h.app.as(owner).actor(h.Session, actorKey(WS, 'session', view.sessionId!)) };
}

describe('AC-15: a runtime that cannot resume or cancel', () => {
    it('the session page lists the limitation and renders no control the runtime lacks', async () => {
        const { sessionId, session } = await startTurn();
        // The record stores what the runtime declared — no more.
        const info = await session.get();
        expect(info.capabilities).toMatchObject({ resume: false, cancel: false, steer: false });
        const report = capabilityReport('anthropic-api', info.capabilities);
        expect(report.unsupported.map((u) => [u.op, u.reason])).toEqual([
            ['resume', 'the runtime cannot resume a session'],
            ['cancel', 'the runtime cannot cancel a turn'],
            ['steer', 'the model runs one turn at a time'],
            ['migrate', 'not supported']
        ]);
        expect(report.supported).toEqual(['approvals', 'usage']);

        const dom = await mountLive(
            `/sessions/${sessionId}`,
            h,
            <>
                <RouterView />
                <TopbarActions />
            </>
        );
        await until(() => dom.querySelectorAll('[data-capability]').length === 6, 'the capability list');
        await until(() => sessionHead.value?.view.state === 'running', 'the head to see the turn running');

        // Every operation is listed; the unsupported ones say why, in the runtime's words.
        const rows = [...dom.querySelectorAll('[data-capability]')];
        expect(rows.map((r) => r.getAttribute('data-supported'))).toEqual(['true', 'true', 'false', 'false', 'false', 'false']);
        const unsupported = rows.filter((r) => r.getAttribute('data-supported') === 'false');
        expect(texts(unsupported.map((r) => r.querySelector('[data-capability-note]')!))).toEqual(['the runtime cannot resume a session', 'the runtime cannot cancel a turn', 'the model runs one turn at a time', 'not supported']);
        expect(texts(unsupported.map((r) => r.querySelector('[data-capability-label]')!))).toContain('Live migration to another machine');

        // The turn is running, yet there is no Cancel control anywhere — only what the runtime can do (Close) is offered.
        const actions = dom.querySelector('[data-topbar-actions]')!;
        expect(texts(actions.querySelectorAll('button'))).toEqual(['Close session']);
        const buttons = texts(dom.querySelectorAll('button'));
        expect(buttons.some((b) => /cancel/i.test(b))).toBe(false);
        expect(buttons.some((b) => /migrate|resume/i.test(b))).toBe(false);
        expect(dom.textContent).not.toContain('Cancel turn');
        expect(sessionHead.value?.view.capabilities.cancel).toBe(false);
    });
});
