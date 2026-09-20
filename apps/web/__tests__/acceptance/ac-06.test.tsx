/**
 * AC-06 — The user disconnects and returns on mobile. Chat history and
 * platform-recorded task status remain available.
 *
 * The chat page over the live harness (`../pages/live-harness`: the
 * platform actors on an in-process host behind the REAL actor wire, the
 * page mounted as a browser tab mounts it): a tab posts and the agent
 * starts answering; the tab is torn down mid-turn — the user is gone; the
 * turn finishes on the platform with nobody connected; a fresh tab opens
 * the same chat and finds the whole history — the message, the status
 * rows, the finished answer — and the task the platform recorded, with its
 * result, all from the actors. The phone regime of that page (app bar,
 * drawer, docked composer at 400 px) is the Playwright `e2e:mobile`
 * project; a real hand-held return is the manual half (docs/acceptance.md).
 * Deeper: `../pages/chat-live.test.tsx` (two tabs on one stream) and
 * `../pages/session-live.test.tsx` (a feed opened mid-turn resumes from
 * the log).
 */
import { defineApp } from 'sigx';
import '@sigx/runtime-dom';
import { RouterView } from '@sigx/router';
import { actorsPlugin } from '@sigx/actors/app';
import { Chat, TaskActor, Workspace, taskKey, workspaceKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { useActorDefs, useViewer } from '../../src/actors/defs';
import { chatKeyOf, sessionKeyOf } from '../../src/actors/keys';
import { setDataMode } from '../../src/data-mode';
import { createServerRouter } from '../../src/router';
import { USER, WS, owner, startLive, texts, tick, until, type LiveHarness } from '../pages/live-harness';

/** The mock runtime: ten characters, one per 20 ms — a turn that is visibly mid-way for ~200 ms. */
const SLOW = { respond: () => [{ text: 'abcdefghij', chunkSize: 1, delayMs: 20 }] };

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(SLOW);
});
afterEach(async () => {
    await h.stop();
    setDataMode('mock');
});

/** One browser tab on `path` — like the harness's `mountLive`, but the tab can be closed by the scenario itself. */
async function openTab(path: string): Promise<{ dom: HTMLDivElement; close(): void }> {
    setDataMode('live');
    const router = createServerRouter(path);
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(<RouterView />);
    app.use(router);
    app.use(actorsPlugin({ transport: h.transport, live: { debounceMs: 0, retryMs: 10, maxRetryMs: 50 } }));
    app.defineProvide(useActorDefs, clientDefs);
    app.defineProvide(useViewer, () => () => ({ workspaceId: USER, pending: false }));
    app.mount(container);
    await tick();
    return {
        dom: container,
        close() {
            app.unmount();
            container.remove();
        }
    };
}

/** Poll an async condition — the harness's `until` is for synchronous DOM checks. */
async function settled(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await tick(10);
    }
}

const names = (dom: ParentNode) => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="name"]'));
const bodies = (dom: ParentNode) => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]'));

describe('AC-06: the user disconnects mid-turn and returns', () => {
    it('a fresh tab finds the whole history, the finished answer and the recorded task', async () => {
        const atlas = await h.agent('Atlas', 'Personal assistant');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.addAgent(atlas, 'all');
        await chat.setCoordinator(atlas);

        // Tab 1: the user posts from the composer; the coordinator is activated and starts streaming.
        const first = await openTab(`/chats/${chatId}`);
        await until(() => first.dom.querySelector('[data-scope="ai-composer"] textarea') !== null, 'the composer');
        const ta = first.dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!;
        ta.value = 'what is up';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        first.dom.querySelector('form[data-scope="ai-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => names(first.dom).includes('Atlas') && bodies(first.dom).some((t) => t.length > 0 && 'abcdefghij'.startsWith(t) && t.length < 10), 'the answer to be mid-way', 3_000);
        const seenBeforeLeaving = bodies(first.dom).find((t) => 'abcdefghij'.startsWith(t) && t.length > 0)!;
        expect(seenBeforeLeaving.length).toBeLessThan(10);

        // The user disconnects: the tab is gone while the turn is still running.
        first.close();
        const history = await chat.history(null, 50);
        type Entry = (typeof history.entries)[number]['entry'];
        const userMessage = history.entries.find((e) => e.entry.t === 'msg' && e.entry.author.kind === 'user')!.entry as Extract<Entry, { t: 'msg' }>;
        const started = history.entries.find((e) => e.entry.t === 'status' && e.entry.kind === 'session-started')!.entry as Extract<Entry, { t: 'status' }>;
        const spec = (await h.app.as(owner).actor(h.Session, sessionKeyOf(USER, started.ref!)).get()).spec!;
        const taskId = spec.taskId!;
        const task = h.app.as(owner).actor(TaskActor, taskKey(WS, taskId));
        expect((await task.get()).origin).toEqual({ kind: 'user', chatId, messageId: userMessage.id });

        // Nobody is connected; the platform finishes the turn and records the task anyway.
        await settled(() => task.get().then((t) => t.status === 'completed'), 'the task to complete with no client attached');
        const recorded = await task.get();
        expect(recorded).toMatchObject({ assignee: atlas, objective: 'what is up', status: 'completed', result: { text: 'abcdefghij' } });

        // The user returns in a fresh tab (a phone, a laptop — the same page): everything is there, from the actors.
        const second = await openTab(`/chats/${chatId}`);
        await until(() => bodies(second.dom).includes('abcdefghij'), 'the finished answer in the new tab');
        // The user reads as "You" on the platform (#152); "Andii" is the mock workspace's person. The session
        // bookkeeping between the message and the answer is no row (#399).
        expect(names(second.dom).slice(0, 2)).toEqual(['You', 'Atlas']);
        expect(bodies(second.dom).slice(0, 2)).toEqual(['what is up', 'abcdefghij']);
        expect(bodies(second.dom)).not.toContain('started a session');
        expect(second.dom.querySelector('[data-scope="ai-composer"] textarea')).not.toBeNull();
        // The record agrees with the page: the history holds the message, the status rows and the bound answer.
        const entries = (await chat.history(null, 50)).entries;
        const kinds = entries.map((e) => (e.entry.t === 'status' ? `status:${e.entry.kind}` : e.entry.t));
        expect(kinds.slice(0, 3)).toEqual(['member', 'coordinator', 'msg']);
        expect(kinds).toContain('status:session-started');
        expect(kinds.filter((k) => k === 'msg')).toHaveLength(2);
        const answer = entries.filter((e) => e.entry.t === 'msg').at(-1)!.entry as Extract<(typeof entries)[number]['entry'], { t: 'msg' }>;
        expect(answer).toMatchObject({ author: { kind: 'agent', agentId: atlas }, taskId, parts: [{ type: 'text', text: 'abcdefghij' }] });
        second.close();
    });
});
