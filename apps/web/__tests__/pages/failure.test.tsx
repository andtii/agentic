/**
 * Failure distinction and recovery (#46, #128; OPS-04, OPS-05): `failureOf`
 * yields exactly one named state per combination of the live signals; each
 * of the five states — and the interrupted, uncertain one — renders a
 * distinct, named status on the pages and in the shell's connection strip;
 * "Resume" re-prompts an interrupted turn and clears the marker.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component } from 'sigx';
import { actorKey, type MachineId, type SessionId, type TaskId } from '@agentic/core';
import { Chat, TaskActor, Workspace, machineKey, workspaceKey, type SessionFactory } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import { clientConnection, failureAction, failureOf, pluginOfFailure, setClientConnection, taskFailureKind, watchTransport, LiveConnection, machineRowsOf, UNCERTAIN_LINE } from '../../src/components/status';
import { SessionView } from '../../src/pages/Session';
import { chatFailure, unknownAgent } from '../../src/pages/chat/live';
import { transitionText, waitDetailOf } from '../../src/pages/task/LiveTask';
import { API_CAPABILITIES, type MockSessionView } from '../../src/mock/workspace';
import { USER, WS, mountLive, owner, startLive, texts, until, type LiveHarness } from './live-harness';

const NOW = 1_700_000_000_000;

describe('failureOf — one named state from the signals', () => {
    it('yields nothing when every signal is fine', () => {
        expect(failureOf({ client: 'live', machine: { id: 'm1', name: 'alien01', online: true }, auth: { status: 'ok' }, session: { status: 'running' }, task: { id: 't1', status: 'active' } })).toBeNull();
        expect(failureOf({})).toBeNull();
    });

    it('client disconnected: the socket, before everything else', () => {
        const state = failureOf({ client: 'reconnecting', machine: { id: 'm1', name: 'alien01', online: false }, task: { id: 't1', status: 'failed', error: { code: 'x', message: 'y', recoverable: false } } });
        expect(state?.kind).toBe('client-offline');
    });

    it('daemon disconnected: Machine.online false, or a session its daemon left disconnected', () => {
        const machine = failureOf({ client: 'live', machine: { id: 'm1', name: 'alien01', online: false, lastSeen: NOW - 3 * 3_600_000 }, auth: { status: 'expired' } }, NOW);
        expect(machine).toMatchObject({ kind: 'machine', machineId: 'm1' });
        expect(machine?.detail).toContain('alien01 stopped answering 3h ago');
        expect(failureOf({ session: { status: 'disconnected' } })?.kind).toBe('machine');
        // A task the router failed for an offline environment names the machine as the cause.
        expect(failureOf({ task: { id: 't1', status: 'failed', error: { code: 'environment-offline', message: 'env_1 on machine m1 is offline', recoverable: true } } })).toMatchObject({ kind: 'machine', taskId: 't1', signal: 'Task.error environment-offline' });
    });

    it('auth unavailable: authStatus missing / expired, or an auth-shaped doctor error', () => {
        expect(failureOf({ machine: { id: 'm1', name: 'alien01', online: true }, auth: { status: 'missing', account: 'work' } })).toMatchObject({ kind: 'auth', machineId: 'm1', signal: 'authStatus missing' });
        expect(failureOf({ auth: { status: 'expired' } })?.detail).toContain("sign-in has expired");
        const verdict = { ok: false, checkedAt: NOW, findings: [{ level: 'error' as const, code: 'auth-token-invalid', message: 'The stored credential was rejected.' }] };
        expect(failureOf({ auth: { status: 'unknown', verdict } })).toMatchObject({ kind: 'auth', detail: expect.stringContaining('The stored credential was rejected.') });
        expect(failureOf({ auth: { status: 'unknown', verdict: { ...verdict, findings: [{ level: 'warn', code: 'slow-disk', message: 'x' }] } } })).toBeNull();
    });

    it('runtime failure: a non-recoverable adapter error, the session in error, or a task failed on an adapter code', () => {
        expect(failureOf({ session: { status: 'idle', error: { code: 'provider_error', message: 'The provider returned 500.', recoverable: false } }, task: { id: 't1', status: 'active' } })).toMatchObject({ kind: 'runtime', signal: 'error provider_error', taskId: 't1' });
        expect(failureOf({ session: { status: 'error' } })?.kind).toBe('runtime');
        expect(failureOf({ session: { status: 'idle', error: { code: 'rate_limited', message: 'slow down', recoverable: true } } })).toBeNull();
        expect(failureOf({ task: { id: 't1', status: 'failed', error: { code: 'provider_error', message: 'The provider returned 500.', recoverable: false } } })).toMatchObject({ kind: 'runtime', signal: 'Task.error provider_error' });
        for (const code of ['turn-error', 'prompt-busy', 'context_exceeded', 'protocol_error']) expect(taskFailureKind({ code, message: '', recoverable: false })).toBe('runtime');
        expect(taskFailureKind({ code: 'auth_required', message: '', recoverable: false })).toBe('auth');
    });

    it('task failure: Task.status failed on the router’s own codes — session-open (no-api-key), a mismatch, the agent’s report', () => {
        const state = failureOf({ task: { id: 't1', status: 'failed', error: { code: 'session-open', message: 'no-api-key: ANTHROPIC_API_KEY is not set', recoverable: false } } });
        expect(state).toMatchObject({ kind: 'task', taskId: 't1', signal: 'Task.error session-open' });
        expect(state?.detail).toContain('no-api-key');
        expect(failureOf({ task: { id: 't1', status: 'failed' } })).toMatchObject({ kind: 'task', detail: expect.stringContaining('could not finish') });
        for (const code of ['runtime-mismatch', 'turn-cancelled', 'agent-unconfigured', 'no-environment', 'budget']) expect(taskFailureKind({ code, message: '', recoverable: false })).toBe('task');
    });

    it('plugin failures (#230, #233): plugin-disabled links to the plugin it names, unknown-runtime to the catalogue, registry-unavailable is retried', () => {
        const off = failureOf({ task: { id: 't1', status: 'failed', error: { code: 'plugin-disabled', message: 'the "claude-code" runtime plugin is turned off; turn it on at /plugins/claude-code', recoverable: true } } });
        expect(off).toMatchObject({ kind: 'task', signal: 'Task.error plugin-disabled', link: { href: '/plugins/claude-code', label: 'Open plugin' } });
        expect(failureAction(off!, {})).toEqual({ href: '/plugins/claude-code', label: 'Open plugin' });
        const missing = failureOf({ task: { id: 't1', status: 'failed', error: { code: 'plugin-disabled', message: 'no runtime plugin "a2a:peer" is installed in this workspace', recoverable: true } } });
        expect(missing?.link).toEqual({ href: '/plugins/a2a%3Apeer', label: 'Open plugin' });
        expect(pluginOfFailure('plugin-disabled: the "anthropic-api" runtime plugin is turned off for workspace w1')).toBe('anthropic-api');
        expect(pluginOfFailure('nothing named here')).toBeNull();

        expect(failureOf({ task: { id: 't1', status: 'failed', error: { code: 'unknown-runtime', message: 'agent a1 runs on "x", which this build does not have', recoverable: false } } }))
            .toMatchObject({ kind: 'task', link: { href: '/plugins', label: 'Open plugins' } });
        expect(failureOf({ task: { id: 't1', status: 'failed', error: { code: 'registry-unavailable', message: 'the plugin registry could not be asked about runtime anthropic-api: boom', recoverable: true } } }))
            .toMatchObject({ kind: 'runtime', taskId: 't1', signal: 'Task.error registry-unavailable' });

        // `no-api-key` names the page that sets the key: the task card links there instead of to the task.
        const noKey = failureOf({ task: { id: 't1', status: 'failed', error: { code: 'session-open', message: 'no-api-key: workspace w1 has no Anthropic API key — add it at /plugins/anthropic-api', recoverable: false } } });
        expect(noKey).toMatchObject({ kind: 'task', link: { href: '/plugins/anthropic-api' } });
    });

    it('interrupted, uncertain: the session’s marker or the task’s resume wait — before a runtime error, after the machine and the account', () => {
        const fromSession = failureOf({ session: { status: 'idle', interrupted: true, error: { code: 'process_exited', message: 'interrupted', recoverable: false } }, task: { id: 't1', status: 'waiting' } });
        expect(fromSession).toMatchObject({ kind: 'interrupted', uncertain: true, taskId: 't1' });
        expect(failureOf({ task: { id: 't1', status: 'waiting', wait: { kind: 'input', requestId: 'resume:t1:turn:1', sessionId: 's1' as SessionId } } })).toMatchObject({ kind: 'interrupted', uncertain: true });
        expect(failureOf({ task: { id: 't1', status: 'waiting', wait: { kind: 'input', requestId: 'r_1' } } })).toBeNull();
        expect(failureOf({ session: { status: 'idle', interrupted: true }, machine: { id: 'm1', name: 'm', online: false } })?.kind).toBe('machine');
        expect(failureOf({ session: { status: 'idle', interrupted: true }, auth: { status: 'missing' } })?.kind).toBe('auth');
    });

    it('wires each state to its one action: links where the state names a place, the page’s callback where it has one, Resume disabled without one', () => {
        expect(failureAction({ kind: 'task', detail: '', taskId: 't1' }, {})).toEqual({ href: '/tasks/t1' });
        expect(failureAction({ kind: 'machine', detail: '', machineId: 'm1' }, {})).toEqual({ href: '/machines/m1' });
        expect(failureAction({ kind: 'auth', detail: '' }, {})).toEqual({ href: '/machines', label: 'Open machine' });
        expect(failureAction({ kind: 'interrupted', detail: '' }, {})).toEqual({ disabled: true });
        const onResume = () => undefined;
        expect(failureAction({ kind: 'interrupted', detail: '' }, { onResume, busy: true })).toEqual({ onAction: onResume, loading: true });
        expect(failureAction({ kind: 'client-offline', detail: '' }, {})).toEqual({});
    });
});

describe('this browser’s connection', () => {
    afterEach(() => setClientConnection('live'));

    it('a watched transport says live on every frame and answer, reconnecting on a dropped stream or a network failure', async () => {
        const calls: string[] = [];
        let fail = false;
        const inner = {
            name: 'fake',
            call: async (symbol: string) => {
                calls.push(symbol);
                if (fail) throw new TypeError('Failed to fetch');
                return 'ok';
            },
            stream: () => ({
                async *[Symbol.asyncIterator]() {
                    yield { p: 1 };
                    if (fail) throw new Error('network error');
                }
            })
        };
        const t = watchTransport(inner);
        expect(clientConnection()).toBe('live');
        fail = true;
        await expect(t.call('x', [])).rejects.toThrow('Failed to fetch');
        expect(clientConnection()).toBe('reconnecting');
        fail = false;
        expect(await t.call('y', [])).toBe('ok');
        expect(clientConnection()).toBe('live');
        fail = true;
        const frames: unknown[] = [];
        await expect((async () => { for await (const f of t.stream('$live', [])) frames.push(f); })()).rejects.toThrow('network error');
        expect(frames).toEqual([{ p: 1 }]);
        expect(clientConnection()).toBe('reconnecting');
        expect(calls).toEqual(['x', 'y']);
    });
});

/** A session view with every signal fine; tests override one. */
function sessionView(over: Partial<MockSessionView>): MockSessionView {
    return {
        id: 's_1' as SessionId,
        ref: 's_1',
        agentId: 'atlas',
        state: 'idle',
        openedAt: 0,
        openedFrom: 'task t_1',
        taskId: 't_1' as TaskId,
        environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' },
        machine: { id: 'm_1' as MachineId, name: 'alien01', os: 'windows', online: true },
        runtimeVersion: 'claude-code 2.4',
        authStatus: 'auth-ok',
        cwd: 'C:\\work',
        head: { epoch: 1, seq: 3 },
        configVersion: 1,
        events: [],
        capabilities: API_CAPABILITIES,
        grants: [],
        ...over
    };
}

const cardOf = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-scope="empty-state"][data-part="root"][data-failure]');
const cardName = (dom: ParentNode) => dom.querySelector('[data-failure-name]')?.textContent?.trim();

describe('the session page names each state (fake signals over the page)', () => {
    let h: LiveHarness;
    afterEach(async () => {
        setClientConnection('live');
        await h?.stop();
    });

    async function mountView(v: MockSessionView, onResume?: () => void) {
        h = await startLive();
        const View = component(() => () => <SessionView v={v} agent={{ ...unknownAgent('atlas'), name: 'Atlas' }} {...(onResume ? { onResume } : {})} />);
        return mountLive('/sessions/s_1', h, <View />);
    }

    it('daemon disconnected — Machine.online false: "Machine disconnected", Open machine', async () => {
        const dom = await mountView(sessionView({ state: 'disconnected', machine: { id: 'm_1' as MachineId, name: 'alien01', os: 'windows', online: false } }));
        expect(cardOf(dom)?.getAttribute('data-failure')).toBe('machine');
        expect(cardName(dom)).toBe('Machine disconnected');
        expect(cardOf(dom)?.querySelector('a')?.getAttribute('href')).toBe('/machines/m_1');
    });

    it('auth unavailable — authStatus expired: "Sign-in needed on the machine"', async () => {
        const dom = await mountView(sessionView({ authStatus: 'auth-expired', auth: { status: 'expired', account: 'work' } }));
        expect(cardOf(dom)?.getAttribute('data-failure')).toBe('auth');
        expect(cardName(dom)).toBe('Sign-in needed on the machine');
        expect(cardOf(dom)?.textContent).toContain("work's sign-in has expired");
    });

    it('runtime failure — a non-recoverable adapter error: "Runtime error" with the code as the signal', async () => {
        const dom = await mountView(sessionView({ state: 'error', error: { code: 'provider_error', message: 'The provider returned 500.', recoverable: false } }));
        expect(cardOf(dom)?.getAttribute('data-failure')).toBe('runtime');
        expect(cardName(dom)).toBe('Runtime error');
        expect(dom.querySelector('[data-failure-signal]')?.textContent).toBe('error provider_error');
    });

    it('interrupted — the last turn did not end: "Interrupted", marked uncertain, Resume wired to the page', async () => {
        let resumed = 0;
        const dom = await mountView(sessionView({ interrupted: true }), () => { resumed++; });
        const card = cardOf(dom)!;
        expect(card.getAttribute('data-failure')).toBe('interrupted');
        expect(cardName(dom)).toBe('Interrupted');
        expect(dom.querySelector('[data-failure-notice]')?.hasAttribute('data-uncertain')).toBe(true);
        expect(dom.querySelector('[data-failure-uncertain]')?.textContent).toBe(UNCERTAIN_LINE);
        const button = card.querySelector<HTMLButtonElement>('button')!;
        expect(button.textContent).toContain('Resume');
        button.click();
        expect(resumed).toBe(1);
    });

    it('nothing wrong: no card at all', async () => {
        const dom = await mountView(sessionView({ state: 'running' }));
        expect(cardOf(dom)).toBeNull();
    });
});

describe('the shell’s connection strip (live)', () => {
    let h: LiveHarness;
    afterEach(async () => {
        setClientConnection('live');
        await h?.stop();
    });

    const rows = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-scope="ag-connection"][data-part="row"]')].map((el) => ({ name: el.querySelector('[data-part="name"]')?.textContent, state: el.querySelector('[data-part="state"]')?.textContent, tone: el.getAttribute('data-tone'), hollow: el.hasAttribute('data-mod-hollow') }));

    it('this browser first — live, then reconnecting… when the socket drops — then every paired machine by Machine.online', { timeout: 15_000 }, async () => {
        h = await startLive();
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const { machineId, pairingCode } = await ws.registerMachinePending({ name: 'alien01' });
        const asMachine = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(h.Machine, machineKey(WS, machineId));
        await asMachine.pair(pairingCode, { name: 'alien01', os: 'windows' });
        const dom = await mountLive('/', h, <LiveConnection />);
        await until(() => rows(dom).length === 2, 'the machine row');
        expect(rows(dom)).toEqual([
            { name: 'This browser', state: 'live', tone: 'live', hollow: false },
            { name: 'alien01', state: 'offline', tone: 'muted', hollow: true }
        ]);
        // The daemon says hello: online, with its session count.
        await asMachine.heartbeat();
        await until(() => rows(dom)[1]?.state === 'online', 'the machine online');
        expect(rows(dom)[1]).toEqual({ name: 'alien01', state: 'online', tone: 'live', hollow: false });
        // The socket drops: the daemon is offline at once (the age is shown once it is known).
        await asMachine.socketClosed();
        await until(() => rows(dom)[1]?.state?.startsWith('offline') === true, 'the machine offline');
        expect(rows(dom)[1]).toMatchObject({ tone: 'muted', hollow: true });
        // This browser's socket drops: the first row says so, hollow.
        setClientConnection('reconnecting');
        await until(() => rows(dom)[0]?.state === 'reconnecting…', 'the browser row');
        expect(rows(dom)[0]).toEqual({ name: 'This browser', state: 'reconnecting…', tone: 'muted', hollow: true });
        expect(failureOf({ client: clientConnection() })?.kind).toBe('client-offline');
    });

    it('machineRowsOf lists paired machines only, with the session count while online and the age while offline', () => {
        const rowsOf = machineRowsOf(
            [{ id: 'a', name: 'A', status: 'paired' }, { id: 'b', name: 'B', status: 'pending' }, { id: 'c', name: 'C', status: 'paired' }],
            { a: { online: true, sessions: 2 }, c: { online: false, sessions: 0, lastSeen: NOW - 5 * 60_000 } },
            NOW
        );
        expect(rowsOf).toEqual([{ id: 'a', name: 'A', online: true, sessions: 2 }, { id: 'c', name: 'C', online: false, lastSeen: '5m' }]);
    });
});

describe('the chat page (live): a failure where the answer would have been, never silence', () => {
    let h: LiveHarness;
    afterEach(async () => {
        await h?.stop();
    });

    const noKey: SessionFactory = async () => {
        throw new Error('no-api-key: ANTHROPIC_API_KEY is not set for this deployment');
    };

    async function seed(text: string) {
        const agentId = await h.agent('Atlas', 'Assistant');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.addAgent(agentId, 'all');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-composer"] textarea') !== null, 'the composer');
        const ta = dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!;
        ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        dom.querySelector<HTMLFormElement>('form[data-scope="ai-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return { agentId, chatId, chat, dom };
    }

    it('#128 — a session-open failure (no-api-key) appends a task-failed status row and shows the "Task failed" card with Open task', { timeout: 20_000 }, async () => {
        h = await startLive(undefined, { factory: noKey });
        const { dom, chat } = await seed('hello?');
        await until(() => cardOf(dom) !== null, 'the failure card', 8_000);
        expect(cardOf(dom)?.getAttribute('data-failure')).toBe('task');
        expect(cardName(dom)).toBe('Task failed');
        expect(cardOf(dom)?.textContent).toContain('no-api-key');
        expect(dom.querySelector('[data-failure-signal]')?.textContent).toBe('Task.error session-open');
        const link = cardOf(dom)?.querySelector('a');
        expect(link?.textContent).toContain('Open task');
        expect(link?.getAttribute('href')).toMatch(/^\/tasks\/task_/);
        // The row is in the thread too, attributed to the agent, after the user's message.
        const history = await chat.history(null, 50);
        const failed = history.entries.map((e) => e.entry).find((e) => e.t === 'status' && e.kind === 'task-failed');
        expect(failed).toMatchObject({ kind: 'task-failed', error: { code: 'session-open' } });
        await until(() => texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]')).some((t) => t.includes('could not finish: session-open')), 'the status row in the thread');
    });

    it('a turn that errors in the adapter: the task fails on the adapter code and the chat shows "Runtime error"', { timeout: 20_000 }, async () => {
        h = await startLive({ respond: () => [{ text: 'starting… ' }, { error: { code: 'provider_error', message: 'The provider returned 500.', recoverable: false } }] });
        const { dom, chat } = await seed('try');
        void chat;
        await until(() => cardOf(dom)?.getAttribute('data-failure') === 'runtime', 'the runtime card', 8_000);
        expect(cardName(dom)).toBe('Runtime error');
        expect(cardOf(dom)?.textContent).toContain('The provider returned 500.');
    });

    it('interrupted, uncertain: an evicted turn is marked with Resume; Resume re-prompts over the intact transcript and clears the marker', { timeout: 20_000 }, async () => {
        h = await startLive({ respond: (input) => (input.some((p) => p.type === 'text' && p.text.includes('slow')) ? [{ text: 'working ' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }] : [{ text: 'quick' }]) });
        const { dom, chat, chatId } = await seed('slow please');
        // Mid-turn: the tool call is in the session log; evict the session object.
        let sessionId = '';
        await until(async () => {
            const s = (await chat.get()).sessions;
            sessionId = Object.values(s)[0]?.sessionId ?? '';
            return sessionId !== '';
        }, 'the session');
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        await until(async () => (await session.events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await h.app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        await until(() => cardOf(dom)?.getAttribute('data-failure') === 'interrupted', 'the interrupted card', 8_000);
        expect(cardName(dom)).toBe('Interrupted');
        expect(dom.querySelector('[data-failure-uncertain]')?.textContent).toBe(UNCERTAIN_LINE);
        const routing = h.app.as(owner).actor(h.Routing, `${WS}:routing:main`);
        await until(async () => (await routing.get()).routes[0]?.status === 'interrupted', 'the route to park');
        const taskId = (await routing.get()).routes[0]!.taskId;
        const task = h.app.as(owner).actor(TaskActor, actorKey(WS, 'task', taskId));
        await until(async () => (await task.get()).status === 'waiting', 'the task parked');
        // Resume from the card.
        const button = cardOf(dom)!.querySelector<HTMLButtonElement>('button')!;
        expect(button.textContent).toContain('Resume');
        button.click();
        await until(async () => (await task.get()).status === 'completed', 'the resumed turn to finish', 8_000);
        const done = await task.get();
        expect(done.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['queued>active', 'active>waiting', 'waiting>active', 'active>completed']);
        expect(done.transitions[2]!.why).toMatch(/^resumed/);
        // The marker is gone once the agent answered after it.
        await until(() => cardOf(dom) === null, 'the marker to clear');
        // The resumed turn's answer is in the thread, after the partial text of the cut one; nothing ran twice.
        const bodies = texts(dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]'));
        expect(bodies.some((t) => t.includes('after'))).toBe(true);
        const events = await session.events();
        expect(events.filter((e) => e.type === 'turn-start').map((e) => e.turnId)).toEqual([`${taskId}:turn:1`, `${taskId}:turn:1:resume`]);
        expect(chatId).toBeTruthy();
    });
});

describe('the task view marks interrupted work as uncertain (OPS-05)', () => {
    it('a resume wait reads "interrupted · uncertain" on the node and in the transition, other waits by their kind', () => {
        const resume = { kind: 'input' as const, requestId: 'resume:t1:turn:1', sessionId: 's1' as SessionId };
        expect(waitDetailOf(resume)).toBe('interrupted · uncertain');
        expect(waitDetailOf({ kind: 'environment-offline', environmentId: 'env_1' as never, policy: 'queue' })).toBe('env_1 offline · queue');
        expect(waitDetailOf({ kind: 'approval', requestId: 'r', sessionId: 's1' as SessionId })).toBeUndefined();
        expect(transitionText({ from: 'active', to: 'waiting', at: 0, by: 'system:routing', why: 'waiting: input', wait: resume })).toBe('waiting · waiting: input · interrupted — uncertain until resumed');
        expect(transitionText({ from: 'waiting', to: 'active', at: 0, by: 'system:routing', why: 'resumed: a new prompt' })).toBe('active · resumed: a new prompt');
    });

    it('chatFailure: a stale marker is cleared by a later message, suppressed while the agent’s feed is mid-turn', () => {
        const at = 0;
        const failed = { t: 'status' as const, agentId: 'a' as never, kind: 'task-failed' as const, ref: 't1' as TaskId, error: { code: 'session-open', message: 'no-api-key', recoverable: false }, at };
        const user = { t: 'msg' as const, id: 'm1' as never, author: { kind: 'user' as const }, parts: [{ type: 'text' as const, text: 'hi' }], at, mentions: [] };
        expect(chatFailure([{ seq: 0, entry: user }, { seq: 1, entry: failed }], [])?.state).toMatchObject({ kind: 'task', taskId: 't1' });
        const answer = { ...user, id: 'm2' as never, author: { kind: 'agent' as const, agentId: 'a' as never } };
        expect(chatFailure([{ seq: 0, entry: user }, { seq: 1, entry: failed }, { seq: 2, entry: answer }], [])).toBeNull();
        const running = { sessionId: 's', agentId: 'a', transcript: { state: 'running' } as never };
        expect(chatFailure([{ seq: 0, entry: user }, { seq: 1, entry: failed }], [running])).toBeNull();
    });
});

describe('the task page (live): interrupted work is marked uncertain and resumed from the page', () => {
    let h: LiveHarness;
    afterEach(async () => {
        await h?.stop();
    });

    it('shows the node as "interrupted · uncertain", the Interrupted card, the resume wait in the transitions; Resume completes the task', { timeout: 20_000 }, async () => {
        h = await startLive({ respond: (input) => (input.some((p) => p.type === 'text' && p.text.includes('slow')) ? [{ text: 'working ' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }] : [{ text: 'quick' }]) });
        const agentId = await h.agent('Atlas', 'Assistant');
        const taskId = 't_page' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, actorKey(WS, 'task', taskId));
        await task.create({ objective: 'slow work', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        const routing = h.app.as(owner).actor(h.Routing, `${WS}:routing:main`);
        const started = await routing.run(taskId);
        const sessionId = started.sessionId!;
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        await until(async () => (await session.events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await h.app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        await until(async () => (await task.get()).status === 'waiting', 'the task parked');

        const dom = await mountLive(`/tasks/${taskId}`, h);
        await until(() => cardOf(dom)?.getAttribute('data-failure') === 'interrupted', 'the interrupted card');
        expect(cardName(dom)).toBe('Interrupted');
        expect(dom.querySelector('[data-task-tree]')?.hasAttribute('data-uncertain')).toBe(true);
        expect(dom.querySelector('[data-scope="ag-task-node"]')?.textContent).toContain('interrupted · uncertain');
        expect(texts(dom.querySelectorAll('[data-scope="timeline"] li, [data-timeline-entry]')).join('\n') || dom.querySelector('[data-task-rail]')?.textContent).toContain('interrupted — uncertain until resumed');
        expect(dom.querySelector('[data-uncertain-note]')?.textContent).toContain('uncertain');

        cardOf(dom)!.querySelector<HTMLButtonElement>('button')!.click();
        await until(async () => (await task.get()).status === 'completed', 'the resumed turn to finish', 8_000);
        await until(() => cardOf(dom) === null, 'the marker to clear');
        await until(() => dom.querySelector('[data-result-text]')?.textContent?.includes('after') === true, 'the result');
        expect(dom.querySelector('[data-task-tree]')?.hasAttribute('data-uncertain')).toBe(false);
        expect(dom.querySelector('[data-task-rail]')?.textContent).toContain('resumed');
    });
});
