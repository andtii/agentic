/**
 * Interruption causes and resume states (#368; OPS-04, OPS-05, OPS-06, CHT-09):
 * the cut turn names why (the daemon restarted, the machine was updated, the
 * runtime's harness was updated, the session ended, the platform restarted)
 * wherever it shows — the failure card, the chat's status row, the task node,
 * the session page, the inbox row — and where its resume stands (Resume,
 * "Resuming…", "Resuming automatically", "resumed"). A task waiting on its
 * machine reads as a wait with the machine and the deadline; `machine-lost`
 * reads as a failure naming the machine, with Retry where the task allows it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { actorKey, type AgentId, type SessionId, type TaskId } from '@agentic/core';
import { AuditActor, Chat, TaskActor, Workspace, auditKey, workspaceKey, type AuditEvent, type MachineView, type SessionInfo } from '@agentic/platform';
import { chatKeyOf } from '../../src/actors/keys';
import type { AgentEvent } from '@sigx/ai-agent';
import { cutOfEvents, failureAction, failureOf, interruptionCause, interruptionLine, interruptionOf, machineOfflineDetail, machineOfflineText, routeResume, type RouteSignal } from '../../src/components/status';
import { chatFailure, entryTranscript, lookupOver, type AgentIdentity } from '../../src/pages/chat/live';
import { interruptedRows } from '../../src/pages/inbox';
import { liveSessionView, sessionSignals } from '../../src/pages/session/live';
import { waitDetailOf } from '../../src/pages/task/LiveTask';
import { taskListRow } from '../../src/pages/task/live';
import { formatTime, loadTask } from '../../src/mock/workspace';
import { mountRoute } from './mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16);

const interrupted = (over: Partial<{ turnId: string; taskId: string; host: string; by: string; at: number }> = {}): AuditEvent => ({
    seq: 1,
    key: `k:${over.turnId ?? 't1:turn:1'}`,
    kind: 'session.interrupted',
    at: over.at ?? 1_000,
    by: over.by ?? 'machine:m1',
    summary: '',
    data: { sessionId: 's1' as SessionId, taskId: (over.taskId ?? 't1') as TaskId, turnId: over.turnId ?? 't1:turn:1', host: (over.host ?? 'restart') as never }
}) as AuditEvent;

const resumed = (by: string, at = 2_000, taskId = 't1'): AuditEvent => ({
    seq: 2, key: `r:${at}`, kind: 'session.resumed', at, by, summary: '', data: { sessionId: 's1' as SessionId, taskId: taskId as TaskId, how: 're-host', by }
}) as AuditEvent;

const route = (over: Partial<RouteSignal> & Record<string, unknown> = {}): RouteSignal => ({
    taskId: 't1', status: 'interrupted', machineId: 'm1', runtime: 'claude-code', turnId: 't1:turn:1', config: { execution: {} }, ...over
});

const names = (id: string): string | undefined => ({ m1: 'alien01' })[id];

describe('the cause (interruptionCause)', () => {
    it('names the daemon restart, the update, the harness update and a plain close, each on its machine; no record is the platform', () => {
        expect(interruptionCause({ host: 'restart', machine: 'alien01' })).toBe('the daemon on alien01 restarted');
        expect(interruptionCause({ host: 'update', machine: 'alien01' })).toBe('alien01 was updated');
        expect(interruptionCause({ host: 'harness-update', machine: 'alien01', runtime: 'claude-code' })).toBe('the claude-code harness on alien01 was updated');
        expect(interruptionCause({ host: 'closed', machine: 'alien01' })).toBe('the session on alien01 ended');
        expect(interruptionCause({ host: 'draining', machine: 'alien01' })).toBe('the session on alien01 ended');
        expect(interruptionCause({ machine: 'alien01' })).toBe('the session on alien01 ended');
        expect(interruptionCause(null)).toBe('the platform restarted mid-turn');
        expect(interruptionCause({})).toBe('the platform restarted mid-turn');
    });

    it('the one-line account adds where the resume stands', () => {
        const cut = { host: 'restart' as const, machine: 'alien01' };
        expect(interruptionLine(cut)).toBe('interrupted: the daemon on alien01 restarted');
        expect(interruptionLine({ ...cut, resume: 'auto' })).toBe('interrupted: the daemon on alien01 restarted · resuming automatically');
        expect(interruptionLine({ ...cut, resume: 'resuming' })).toBe('interrupted: the daemon on alien01 restarted · resuming…');
        expect(interruptionLine({ ...cut, resume: 'resumed' })).toBe('interrupted: the daemon on alien01 restarted · resumed');
        expect(interruptionLine({ ...cut, resume: 'resumed', auto: true })).toBe('interrupted: the daemon on alien01 restarted · resumed automatically');
    });
});

describe('interruptionOf — the Audit row, the route, the log', () => {
    it('reads the host and the machine from the session.interrupted row of the turn (a resume turn id names its cut)', () => {
        expect(interruptionOf({ audit: [interrupted()], turnId: 't1:turn:1:resume', machineName: names })).toEqual({ host: 'restart', machineId: 'm1', machine: 'alien01' });
        expect(interruptionOf({ audit: [interrupted({ by: 'machine:unknown' })], taskId: 't1' })).toEqual({ host: 'restart' });
        expect(interruptionOf({ audit: [interrupted()], turnId: 't2:turn:1' })).toBeNull();
    });

    it('a parked route says where the resume stands: re-opening, auto once per cut turn, else a person', () => {
        expect(routeResume(route())).toBe('ask');
        expect(routeResume(route({ rehosting: true }))).toBe('resuming');
        expect(routeResume(route({ config: { execution: { onInterrupt: 'auto' } } }))).toBe('auto');
        // Already resumed on its own once for this cut: the next word is a person's.
        expect(routeResume(route({ config: { execution: { onInterrupt: 'auto' } }, autoResumed: 't1:turn:1', turnId: 't1:turn:1:resume' }))).toBe('ask');
        expect(routeResume(route({ status: 'running' }))).toBeUndefined();
        expect(interruptionOf({ audit: [interrupted({ host: 'harness-update' })], taskId: 't1', route: route({ config: { execution: { onInterrupt: 'auto' } } }), machineName: names })).toEqual({ host: 'harness-update', machineId: 'm1', machine: 'alien01', runtime: 'claude-code', resume: 'auto' });
    });

    it('a session.resumed row at or after the cut says it went on — automatically when the router asked', () => {
        expect(interruptionOf({ audit: [resumed('user:u1'), interrupted()], taskId: 't1' })?.resume).toBe('resumed');
        expect(interruptionOf({ audit: [resumed('system:routing'), interrupted()], taskId: 't1' })).toMatchObject({ resume: 'resumed', auto: true });
        // A resume of an earlier cut does not count for this one.
        expect(interruptionOf({ audit: [interrupted({ at: 3_000 }), resumed('user:u1', 2_000)], taskId: 't1' })?.resume).toBeUndefined();
        // An eviction records no cause, but its resume is audited.
        expect(interruptionOf({ audit: [resumed('user:u1')], taskId: 't1' })).toEqual({ resume: 'resumed' });
    });

    it('cutOfEvents: the interrupted error event carries the host; a later resume turn of the same cut says resumed', () => {
        const ev = (seq: number, e: Record<string, unknown>) => ({ sessionId: 's1', epoch: 1, seq, ...e }) as unknown as AgentEvent;
        const cut = [
            ev(1, { type: 'turn-start', turnId: 't1:turn:1' }),
            ev(2, { type: 'error', turnId: 't1:turn:1', code: 'process_exited', message: 'interrupted: restarting', recoverable: true, data: { host: 'update', interrupted: true } }),
            ev(3, { type: 'turn-end', turnId: 't1:turn:1', stopReason: 'error', error: { code: 'process_exited', message: 'interrupted: restarting' } })
        ];
        expect(cutOfEvents(cut)).toEqual({ host: 'update', resumed: false });
        expect(cutOfEvents([...cut, ev(4, { type: 'turn-start', turnId: 't1:turn:1:resume' })])).toEqual({ host: 'update', resumed: true });
        // An eviction's cut has no host; an ordinary runtime error is no cut.
        expect(cutOfEvents([ev(1, { type: 'error', turnId: 't', code: 'process_exited', message: 'x', recoverable: true, data: { interrupted: true } })])).toEqual({ resumed: false });
        expect(cutOfEvents([ev(1, { type: 'error', turnId: 't', code: 'provider_error', message: 'x', recoverable: false })])).toBeNull();
    });
});

describe('the Interrupted card names the cause and the resume state', () => {
    const task = { id: 't1', status: 'waiting' as const, wait: { kind: 'input' as const, requestId: 'resume:t1:turn:1' } };

    it('the detail names the cause and the signal the close code; the platform eviction keeps its wording', () => {
        const state = failureOf({ task, interruption: { host: 'restart', machineId: 'm1', machine: 'alien01', resume: 'ask' } });
        expect(state).toMatchObject({ kind: 'interrupted', taskId: 't1', machineId: 'm1', signal: 'session.closed restart', uncertain: true });
        expect(state?.detail).toMatch(/^Interrupted: the daemon on alien01 restarted\. Nothing was replayed/);
        expect(state?.detail).toContain('Resume sends a new prompt over the intact transcript.');
        expect(failureOf({ task })?.detail).toMatch(/^Interrupted: the platform restarted mid-turn\./);
    });

    it('Resume is disabled with "Resuming automatically" for an auto agent and "Resuming…" while the session re-opens', () => {
        const onResume = () => undefined;
        const auto = failureOf({ task, interruption: { host: 'harness-update', machine: 'alien01', runtime: 'claude-code', resume: 'auto' } })!;
        expect(auto.resume).toBe('auto');
        expect(auto.detail).toContain('The agent resumes it automatically, once.');
        expect(failureAction(auto, { onResume })).toEqual({ disabled: true, label: 'Resuming automatically' });
        const rehosting = failureOf({ task, interruption: { host: 'restart', machine: 'alien01', resume: 'resuming' } })!;
        expect(failureAction(rehosting, { onResume })).toEqual({ disabled: true, loading: true, label: 'Resuming…' });
        const ask = failureOf({ task, interruption: { host: 'restart', machine: 'alien01', resume: 'ask' } })!;
        expect(failureAction(ask, { onResume })).toMatchObject({ onAction: onResume });
    });

    it('a mock task shows every state: the cause with Resume, resuming automatically, and resumed', async () => {
        const ask = await mountRoute('/tasks/t7');
        expect(ask.querySelector('[data-failure-notice]')?.textContent).toContain('Interrupted: the daemon on alien01 restarted.');
        const auto = await mountRoute('/tasks/t8');
        expect(auto.querySelector('[data-failure-notice] button')?.textContent).toContain('Resuming automatically');
        expect(auto.querySelector<HTMLButtonElement>('[data-failure-notice] button')?.disabled).toBe(true);
        const done = await mountRoute('/tasks/t9');
        expect(done.querySelector('[data-failure-notice]')).toBeNull();
        expect(done.querySelector('[data-interruption-note]')?.textContent).toBe('interrupted: alien01 was updated · resumed');
    });
});

describe('machine-offline is a wait; machine-lost a failure naming the machine', () => {
    const wait = { kind: 'machine-offline' as const, machineId: 'm1' as never, since: Date.UTC(2026, 8, 17, 12, 2) };

    it('reads as a wait with the machine, since when and the deadline — never a failure', () => {
        expect(machineOfflineText(wait, 'alien01', clock)).toBe('Waiting for alien01 (offline since 12:02); fails after 24 h');
        expect(machineOfflineDetail(wait, undefined, clock)).toBe('m1 offline since 12:02 · fails after 24 h');
        expect(waitDetailOf(wait, names, clock)).toBe('alien01 offline since 12:02 · fails after 24 h');
        expect(failureOf({ task: { id: 't1', status: 'waiting', wait } })).toBeNull();
        const row = taskListRow({ id: 't1' as TaskId, objective: 'x', assignee: 'a1' as AgentId, owner: 'a1' as AgentId, status: 'waiting', wait, origin: 'user', depth: 0, createdAt: 0, updatedAt: 0, n: 1 } as never, lookupOver({}), names);
        expect(row.waitDetail).toMatch(/^alien01 offline since /);
    });

    it('machine-lost names the machine, and Retry is the action where the page has one and the task allows it', () => {
        const error = { code: 'machine-lost', message: 'machine m1 has been offline since 2026-09-16T11:20:00.000Z; the turn is lost', recoverable: true };
        const state = failureOf({ task: { id: 't1', status: 'failed', error }, machineName: names })!;
        expect(state).toMatchObject({ kind: 'machine', machineId: 'm1', taskId: 't1', retry: true, signal: 'Task.error machine-lost' });
        expect(state.detail).toBe('alien01 stayed offline for 24 h, so the turn is lost. Nothing was replayed. Retry sends the work again once it is back.');
        const onRetry = () => undefined;
        expect(failureAction(state, { onRetry })).toEqual({ onAction: onRetry, loading: false, label: 'Retry' });
        expect(failureAction(state, {})).toEqual({ href: '/machines/m1' });
        expect(failureOf({ task: { id: 't1', status: 'failed', error: { ...error, recoverable: false } } })?.retry).toBeUndefined();
    });

    it('the mock pages show the wait and the lost machine', async () => {
        expect(loadTask('t5')?.task.waitDetail).toBe(machineOfflineDetail(loadTask('t5')!.task.wait as typeof wait, 'nuc-lab', formatTime));
        const waiting = await mountRoute('/tasks/t5');
        expect(waiting.querySelector('[data-task-wait]')?.textContent).toMatch(/^Waiting for nuc-lab \(offline since \d\d:\d\d\); fails after 24 h Open machine$/);
        expect(waiting.querySelector('[data-task-wait] a')?.getAttribute('href')).toBe('/machines/nuc-lab');
        expect(waiting.querySelector('[data-failure-notice]')).toBeNull();
        const lost = await mountRoute('/tasks/t6');
        expect(lost.querySelector('[data-failure-notice]')?.getAttribute('data-failure-kind')).toBe('machine');
        expect(lost.querySelector('[data-failure-notice]')?.textContent).toContain('nuc-lab stayed offline for 24 h');
        const tasks = await mountRoute('/tasks');
        expect(tasks.textContent).toContain('wait: machine-offline · nuc-lab offline since');
    });
});

describe('the chat names the cause (chatFailure, the status row)', () => {
    const atlas: AgentIdentity = { id: 'a1', name: 'Atlas', role: '', hue: 1, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 1 };
    const lookup = lookupOver({ a1: atlas });
    const cutRow = { seq: 1, entry: { t: 'status' as const, agentId: 'a1' as AgentId, kind: 'task' as const, ref: 'interrupted:t1:turn:1', at: 0 } };
    const of = (resume?: 'auto' | 'resumed') => (turnId: string | undefined) => (turnId === 't1:turn:1' ? { interruption: { host: 'restart' as const, machine: 'alien01', ...(resume ? { resume } : {}) }, taskId: 't1' } : null);

    it('the card takes the task from the router when the feed has none, and names the cause', () => {
        const failure = chatFailure([cutRow as never], [], of())!;
        expect(failure.state).toMatchObject({ kind: 'interrupted', taskId: 't1' });
        expect(failure.state.detail).toContain('Interrupted: the daemon on alien01 restarted.');
        expect(chatFailure([cutRow as never], [], of('auto'))!.state.resume).toBe('auto');
        // Without the page's context the generic wording stays.
        expect(chatFailure([cutRow as never], [])!.state.detail).toContain('the platform restarted mid-turn');
    });

    it('the status row in the thread says the cause and the resume, never the raw ref', () => {
        const row = (t: ReturnType<typeof entryTranscript>) => (t.messages[0]!.parts[0] as { text: string }).text;
        expect(row(entryTranscript([cutRow as never], lookup, 'You', clock, of()))).toBe('*interrupted: the daemon on alien01 restarted*');
        expect(row(entryTranscript([cutRow as never], lookup, 'You', clock, of('resumed')))).toBe('*interrupted: the daemon on alien01 restarted · resumed*');
        expect(row(entryTranscript([cutRow as never], lookup, 'You', clock))).toBe('*interrupted: the platform restarted mid-turn*');
    });
});

describe('the session page and the inbox', () => {
    const forge: AgentIdentity = { id: 'a_forge', name: 'Forge', role: '', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 3 };
    const ev = (seq: number, e: Record<string, unknown>) => ({ sessionId: 's1', epoch: 1, seq, ...e }) as unknown as AgentEvent;
    const CUT = [
        ev(1, { type: 'turn-start', turnId: 't1:turn:1' }),
        ev(2, { type: 'error', turnId: 't1:turn:1', code: 'process_exited', message: 'interrupted: harness', recoverable: true, data: { host: 'harness-update', interrupted: true } }),
        ev(3, { type: 'turn-end', turnId: 't1:turn:1', stopReason: 'error', error: { code: 'process_exited', message: 'interrupted: harness' } })
    ];
    const info = { key: 'k', opened: true, status: 'idle', head: { epoch: 1, seq: 3 }, openRequests: [], eventCount: 3, corrections: [], grants: [], spec: { agentId: 'a_forge', runtime: 'claude-code', machineId: 'm1', taskId: 't1', config: { configVersion: 3, execution: { runtime: 'claude-code' } } } } as unknown as SessionInfo;
    const machine = (hosted: boolean) => ({ id: 'm1', name: 'alien01', os: 'Windows 11', online: true, environments: [], activeSessions: hosted ? [{ sessionId: 's1' }] : [] }) as unknown as MachineView;

    it('the session view names the cause from its own log, and an idle session its machine lost says it re-opens', () => {
        const v = liveSessionView('s1', info, CUT, forge, machine(true), route({ config: { execution: { onInterrupt: 'auto' } } }));
        expect(v.interruption).toEqual({ host: 'harness-update', machineId: 'm1', machine: 'alien01', runtime: 'claude-code', resume: 'auto' });
        expect(v.hostLost).toBeUndefined();
        const card = failureOf(sessionSignals(v))!;
        expect(card.detail).toContain('Interrupted: the claude-code harness on alien01 was updated.');
        expect(card.resume).toBe('auto');
        expect(liveSessionView('s1', info, CUT, forge, machine(false)).hostLost).toBe(true);
    });

    it('the mock session pages show the resuming-automatically card, and the resumed note with the lost-session line', async () => {
        const auto = await mountRoute('/sessions/s7');
        expect(auto.querySelector('[data-failure-notice] button')?.textContent).toContain('Resuming automatically');
        const lost = await mountRoute('/sessions/s8');
        expect(lost.querySelector('[data-interruption-note]')?.textContent).toBe('interrupted: alien01 was updated · resumed');
        expect(lost.querySelector('[data-session-lost]')?.textContent).toBe('The machine lost this session; it re-opens with the next message.');
    });

    it('an inbox row names the cause; Resume is disabled while the resume is under way', () => {
        const r = (over: Record<string, unknown>) => ({ agentId: 'a1', updatedAt: 1, ...route(over), config: { name: 'Atlas', execution: over.config ? (over.config as { execution: object }).execution : {} } }) as never;
        const rows = interruptedRows({ routes: [r({}), r({ taskId: 't2', turnId: 't2:turn:1', rehosting: true }), r({ taskId: 't3', turnId: 't3:turn:1', config: { execution: { onInterrupt: 'auto' } } })] }, [interrupted()], names);
        expect(rows.map((x) => [x.context, x.primary])).toEqual([
            ['Interrupted: the daemon on alien01 restarted. Nothing was replayed. The transcript is intact.', { label: 'Resume' }],
            ['Interrupted: the session on alien01 ended. Nothing was replayed. The transcript is intact.', { label: 'Resuming…', disabled: true }],
            ['Interrupted: the session on alien01 ended. Nothing was replayed. The transcript is intact.', { label: 'Resuming automatically', disabled: true }]
        ]);
    });
});

describe('the task page (live): the cause from the Audit, Resume, then "resumed"', () => {
    let h: LiveHarness;
    afterEach(async () => {
        await h?.stop();
    });

    it('names the recorded cause on the card, resumes from it, and says resumed afterwards', { timeout: 20_000 }, async () => {
        h = await startLive({ respond: (input) => (input.some((p) => p.type === 'text' && p.text.includes('slow')) ? [{ text: 'working ' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }] : [{ text: 'quick' }]) });
        const agentId = await h.agent('Atlas', 'Assistant');
        const taskId = 't_cut' as TaskId;
        const task = h.app.as(owner).actor(TaskActor, actorKey(WS, 'task', taskId));
        await task.create({ objective: 'slow work', origin: { kind: 'external', clientId: 'c1' }, assignee: agentId, context: [], constraints: {} }, { owner: agentId });
        const routing = h.app.as(owner).actor(h.Routing, `${WS}:routing:main`);
        const sessionId = (await routing.run(taskId)).sessionId!;
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        await until(async () => (await session.events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await h.app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        await until(async () => (await task.get()).status === 'waiting', 'the task parked');
        // What `Session.hostEnded` records when a daemon restart cuts the turn (#366); here the cut was an eviction.
        await h.app.as(owner).actor(AuditActor, auditKey(WS)).record({ key: `test:${taskId}:interrupted`, kind: 'session.interrupted', at: Date.now(), by: 'machine:m_lab', summary: 'cut', taskId, sessionId: sessionId as SessionId, data: { sessionId: sessionId as SessionId, taskId, turnId: `${taskId}:turn:1`, host: 'restart' } });

        const dom = await mountLive(`/tasks/${taskId}`, h);
        const card = () => dom.querySelector('[data-failure-notice]');
        await until(() => card()?.textContent?.includes('Interrupted: the daemon on m_lab restarted.') === true, 'the cause on the card');
        expect(dom.querySelector('[data-failure-signal]')?.textContent).toBe('session.closed restart');
        card()!.querySelector<HTMLButtonElement>('button')!.click();
        await until(async () => (await task.get()).status === 'completed', 'the resumed turn to finish', 8_000);
        await until(() => dom.querySelector('[data-interruption-note]')?.textContent === 'interrupted: the daemon on m_lab restarted · resumed', 'the resumed note');
        expect(card()).toBeNull();
    });
});

describe('the chat page (live): the cause on the card and in the thread, Resume, then "resumed"', () => {
    let h: LiveHarness;
    afterEach(async () => {
        await h?.stop();
    });

    it('names the recorded cause, resumes from the card, and the status row reads resumed afterwards', { timeout: 20_000 }, async () => {
        h = await startLive({ respond: (input) => (input.some((p) => p.type === 'text' && p.text.includes('slow')) ? [{ text: 'working ' }, { tool: { name: 'slow', input: {}, output: 'done', delayMs: 1_500 } }, { text: 'after' }] : [{ text: 'quick' }]) });
        const agentId = await h.agent('Atlas', 'Assistant');
        const { chatId } = await h.app.as(owner).actor(Workspace, workspaceKey(WS)).createChat({});
        const chat = h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId));
        await chat.addAgent(agentId, 'all');
        const dom = await mountLive(`/chats/${chatId}`, h);
        await until(() => dom.querySelector('[data-scope="ai-composer"] textarea') !== null, 'the composer');
        const ta = dom.querySelector<HTMLTextAreaElement>('[data-scope="ai-composer"] textarea')!;
        ta.value = 'slow please';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        dom.querySelector<HTMLFormElement>('form[data-scope="ai-composer"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        let sessionId = '';
        await until(async () => {
            sessionId = Object.values((await chat.get()).sessions)[0]?.sessionId ?? '';
            return sessionId !== '';
        }, 'the session');
        const session = h.app.as(owner).actor(h.Session, actorKey(WS, 'session', sessionId));
        await until(async () => (await session.events()).some((e) => e.type === 'tool-call'), 'the tool call');
        await h.app.host.deactivate({ type: 'session', key: actorKey(WS, 'session', sessionId) });
        const routing = h.app.as(owner).actor(h.Routing, `${WS}:routing:main`);
        await until(async () => (await routing.get()).routes[0]?.status === 'interrupted', 'the route to park');
        const taskId = (await routing.get()).routes[0]!.taskId;
        await h.app.as(owner).actor(AuditActor, auditKey(WS)).record({ key: `test:${taskId}:interrupted`, kind: 'session.interrupted', at: Date.now(), by: 'machine:m_lab', summary: 'cut', taskId, sessionId: sessionId as SessionId, data: { sessionId: sessionId as SessionId, taskId, turnId: `${taskId}:turn:1`, host: 'update' } });

        const bodies = () => [...dom.querySelectorAll('[data-scope="ai-message"][data-part="body"]')].map((b) => b.textContent ?? '');
        const card = () => dom.querySelector('[data-failure-notice]');
        await until(() => card()?.textContent?.includes('Interrupted: m_lab was updated.') === true, 'the cause on the card', 8_000);
        await until(() => bodies().some((t) => t.includes('interrupted: m_lab was updated')), 'the cause in the thread');
        const task = h.app.as(owner).actor(TaskActor, actorKey(WS, 'task', taskId));
        await until(async () => (await task.get()).status === 'waiting', 'the task parked');
        card()!.querySelector<HTMLButtonElement>('button')!.click();
        await until(async () => (await task.get()).status === 'completed', 'the resumed turn to finish', 8_000);
        await until(() => bodies().some((t) => t.includes('interrupted: m_lab was updated · resumed')), 'the resumed row', 8_000);
        await until(() => card() === null, 'the card to clear');
    });
});
