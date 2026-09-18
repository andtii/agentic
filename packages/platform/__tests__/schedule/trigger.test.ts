/**
 * The platform's `TriggerPort` (issue #42): what a `ScheduleFired` becomes.
 * The direct cases call `deliverScheduleFired` with a principal-bound hop on
 * the shared harness; the end-to-end case runs Schedule, Inbox and Task in
 * one host on the manual scheduler with NO machine registered, so a reminder
 * reaches the inbox from the entry's own alarm (AC-08 in process).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, EnvironmentId, Principal, ScheduleId, TaskId, WorkspaceId } from '@agentic/core';
import { actor, type ActorClient, type AnyActorDefinition, type Host } from '@sigx/actors';
import { defineActorApp, manualScheduler, memoryStorage } from '@sigx/actors/host';
import { createTestServerFnContext, stubServerApp } from '@sigx/server/testing';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Inbox, defineInbox, inboxKey, type InboxNotification, type NotificationChannel } from '../../src/notify/index';
import { TaskActor, taskKey } from '../../src/task/index';
import {
    defineScheduleActor,
    deliverScheduleFired,
    scheduleTrigger,
    scheduledTaskId,
    type ScheduleFired,
    type ScheduleTriggerOutcome,
    type TriggerHop
} from '../../src/schedule/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const SCH = 'sch_1' as ScheduleId;
const AGENT = 'agent_a' as AgentId;
const ENV = 'env_laptop' as EnvironmentId;
const AT = Date.parse('2026-09-17T10:00:00Z');

const fired = (extra: Partial<ScheduleFired> = {}): ScheduleFired => ({
    type: 'ScheduleFired',
    workspaceId: WS,
    scheduleId: SCH,
    key: `${WS}:schedule:${SCH}`,
    kind: 'reminder',
    title: 'Stand-up',
    scheduledFor: AT,
    firedAt: AT + 5,
    occurrence: 1,
    skipped: 0,
    offlinePolicy: 'queue',
    ...extra
});

const agentEntry = (extra: Partial<ScheduleFired> = {}): ScheduleFired =>
    fired({ kind: 'agent-task', title: 'Nightly digest', prompt: 'Write the digest', agentId: AGENT, ...extra });

function recordingChannel() {
    const sent: InboxNotification[] = [];
    const channel: NotificationChannel = {
        id: 'test-push',
        async deliver(notification) {
            sent.push(notification);
            return { ok: true };
        }
    };
    return { sent, channel };
}

// ---------------------------------------------------------------------------
// Direct delivery on the shared harness

describe('deliverScheduleFired', () => {
    let app: TestActorApp;
    let push: ReturnType<typeof recordingChannel>;
    let hop: TriggerHop;

    beforeEach(async () => {
        push = recordingChannel();
        // The app registers the Inbox WITH channels; the trigger hops by the shared type `Inbox`.
        app = testActorApp([defineInbox({ channels: [push.channel] }), TaskActor]);
        await app.start();
        hop = app.as(owner);
    });
    afterEach(() => app.stop());

    const inbox = () => app.as(owner).actor(Inbox, inboxKey(WS));
    const task = (id: TaskId) => app.as(owner).actor(TaskActor, taskKey(WS, id));

    it('a plain reminder becomes one Inbox notification of kind reminder, pushed through every channel', async () => {
        const outcome = await deliverScheduleFired(fired({ prompt: 'Standup in 5' }), hop);
        expect(outcome).toEqual({ kind: 'notified', notificationId: 'n_1' });

        const rows = await inbox().list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: 'n_1',
            kind: 'reminder',
            title: 'Stand-up',
            body: 'Standup in 5',
            ref: { kind: 'schedule', scheduleId: SCH },
            read: false
        });
        expect(rows[0]!.deliveries).toEqual([{ channel: 'test-push', at: expect.any(Number), ok: true }]);
        expect(push.sent.map((n) => n.id)).toEqual(['n_1']);
        expect(await inbox().unread()).toBe(1);
    });

    it('a recurring entry without an agent is a recurring reminder: Inbox, no Task', async () => {
        const outcome = await deliverScheduleFired(fired({ kind: 'recurring', title: 'Water the plants' }), hop);
        expect(outcome.kind).toBe('notified');
        const rows = await inbox().list();
        expect(rows.map((n) => [n.kind, n.title])).toEqual([['reminder', 'Water the plants']]);
        expect(rows[0]!.body).toBeUndefined();
    });

    it('an agent entry with no environment creates a Task in queued with origin {kind: schedule}', async () => {
        const outcome = await deliverScheduleFired(agentEntry(), hop);
        const id = scheduledTaskId(SCH, AT);
        expect(outcome).toEqual({ kind: 'task', taskId: id, status: 'queued' });

        const view = await task(id).get();
        expect(view).toMatchObject({
            id,
            status: 'queued',
            owner: AGENT,
            assignee: AGENT,
            objective: 'Write the digest',
            origin: { kind: 'schedule', scheduleId: SCH },
            depth: 0,
            constraints: {}
        });
        expect(view.environmentId).toBeUndefined();
        expect(view.wait).toBeUndefined();
        expect(view.context).toEqual([{ type: 'text', text: expect.stringContaining('"Nightly digest" (sch_1), occurrence 1, due 2026-09-17T10:00:00.000Z') }]);
        // Nothing reached the inbox: a scheduled task is not a reminder.
        expect(await inbox().list()).toEqual([]);
    });

    it('an agent entry with a workdir carries it into the task contract with its environment (#190)', async () => {
        await deliverScheduleFired(agentEntry({ environmentId: ENV, workdir: 'C:/src/app' }), hop);
        expect(await task(scheduledTaskId(SCH, AT)).get()).toMatchObject({ environmentId: ENV, workdir: 'C:/src/app' });
    });

    it('the objective falls back to the title when the entry has no prompt', async () => {
        await deliverScheduleFired(agentEntry({ prompt: undefined }), hop);
        expect((await task(scheduledTaskId(SCH, AT)).get()).objective).toBe('Nightly digest');
    });

    it('AST-05 queue: an environment that is offline (no machine registered) lands waiting {environment-offline}', async () => {
        const outcome = await deliverScheduleFired(agentEntry({ environmentId: ENV }), hop);
        const wait = { kind: 'environment-offline', environmentId: ENV, policy: 'queue' } as const;
        expect(outcome).toEqual({ kind: 'task', taskId: scheduledTaskId(SCH, AT), status: 'waiting', wait });

        const t = task(scheduledTaskId(SCH, AT));
        const view = await t.get();
        expect(view.status).toBe('waiting');
        expect(view.environmentId).toBe(ENV);
        expect(await t.explain()).toEqual(wait);
        expect(view.transitions).toEqual([{ from: 'queued', to: 'waiting', at: expect.any(Number), by: 'schedule:sch_1', why: 'waiting: environment-offline', wait }]);
    });

    it('AST-05 fallback-api: recorded as the wait reason for the router, the task is not failed', async () => {
        const outcome = await deliverScheduleFired(agentEntry({ environmentId: ENV, offlinePolicy: 'fallback-api' }), hop);
        expect(outcome).toMatchObject({ status: 'waiting', wait: { kind: 'environment-offline', environmentId: ENV, policy: 'fallback-api' } });
        expect(await inbox().list()).toEqual([]);
    });

    it('AST-05 fail: the task fails with environment-offline and the inbox is told', async () => {
        const outcome = await deliverScheduleFired(agentEntry({ environmentId: ENV, offlinePolicy: 'fail' }), hop);
        const id = scheduledTaskId(SCH, AT);
        expect(outcome).toEqual({ kind: 'task', taskId: id, status: 'failed' });

        const view = await task(id).get();
        expect(view.status).toBe('failed');
        expect(view.error).toEqual({ code: 'environment-offline', message: expect.stringContaining('"fail"'), recoverable: false });
        expect(view.transitions.map((t) => [t.to, t.by])).toEqual([['failed', 'schedule:sch_1']]);

        const rows = await inbox().list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'task-failed', title: 'Nightly digest', ref: { kind: 'task', taskId: id } });
        expect(rows[0]!.deliveries.map((d) => d.ok)).toEqual([true]);
    });

    it('AST-05 fail: a retry after the task-failed push threw delivers the notification exactly once', async () => {
        const event = agentEntry({ environmentId: ENV, offlinePolicy: 'fail' });
        const id = scheduledTaskId(SCH, AT);
        // The first attempt: `task.fail` lands, the inbox push throws — what the Schedule actor retries.
        let pushesToFail = 1;
        const flaky: TriggerHop = {
            actor: (def, key) => {
                const client = hop.actor(def, key);
                if ((def as { type?: string }).type !== 'Inbox') return client;
                return new Proxy(client, {
                    get: (target, prop) =>
                        prop === 'push' && pushesToFail > 0
                            ? () => {
                                  pushesToFail--;
                                  return Promise.reject(new Error('inbox unreachable'));
                              }
                            : Reflect.get(target, prop)
                }) as typeof client;
            }
        };
        await expect(deliverScheduleFired(event, flaky)).rejects.toThrow('inbox unreachable');
        expect((await task(id).get()).status).toBe('failed');
        expect(await inbox().list()).toEqual([]);

        // The retry finds the task already failed and still owes the inbox its word.
        expect(await deliverScheduleFired(event, hop)).toEqual({ kind: 'task', taskId: id, status: 'failed' });
        expect((await inbox().list()).map((n) => [n.kind, n.ref])).toEqual([['task-failed', { kind: 'task', taskId: id }]]);

        // A further retry adds nothing.
        await deliverScheduleFired(event, hop);
        expect(await inbox().list()).toHaveLength(1);
        expect((await task(id).get()).transitions).toHaveLength(1);
    });

    it('an environment the probe reports online leaves the task queued', async () => {
        const asked: [WorkspaceId, EnvironmentId][] = [];
        const environments = {
            isOnline(workspaceId: WorkspaceId, environmentId: EnvironmentId) {
                asked.push([workspaceId, environmentId]);
                return true;
            }
        };
        const outcome = await deliverScheduleFired(agentEntry({ environmentId: ENV }), hop, { environments });
        expect(outcome).toEqual({ kind: 'task', taskId: scheduledTaskId(SCH, AT), status: 'queued' });
        expect(asked).toEqual([[WS, ENV]]);
        expect((await task(scheduledTaskId(SCH, AT)).get()).environmentId).toBe(ENV);
    });

    it('is exactly-once per occurrence: a retried firing finds the task it already routed', async () => {
        const event = agentEntry({ environmentId: ENV });
        const first = await deliverScheduleFired(event, hop);
        const again = await deliverScheduleFired(event, hop);
        expect(again).toEqual(first);
        expect((await task(scheduledTaskId(SCH, AT)).get()).transitions).toHaveLength(1);

        // The next occurrence is a different task.
        const next = await deliverScheduleFired(agentEntry({ scheduledFor: AT + 60_000, occurrence: 2 }), hop);
        expect(next).toEqual({ kind: 'task', taskId: scheduledTaskId(SCH, AT + 60_000), status: 'queued' });
        expect(scheduledTaskId(SCH, AT)).not.toBe(scheduledTaskId(SCH, AT + 60_000));
    });

    it('scheduleTrigger() is a TriggerPort that reports every outcome', async () => {
        const outcomes: [ScheduleFired, ScheduleTriggerOutcome][] = [];
        const port = scheduleTrigger({ onOutcome: (event, outcome) => outcomes.push([event, outcome]) });
        await port.fired(fired(), hop);
        await port.fired(agentEntry({ scheduledFor: AT + 1 }), hop);
        expect(outcomes.map(([e, o]) => [e.kind, o.kind])).toEqual([
            ['reminder', 'notified'],
            ['agent-task', 'task']
        ]);
    });

    it('onOutcome is observation only: a throw or a rejection never fails the firing (no retry, no duplicate)', async () => {
        const throwing = scheduleTrigger({
            onOutcome: () => {
                throw new Error('observer down');
            }
        });
        await expect(throwing.fired(fired(), hop)).resolves.toBeUndefined();
        const rejecting = scheduleTrigger({ onOutcome: () => Promise.reject(new Error('observer down')) as unknown as void });
        await expect(rejecting.fired(fired({ scheduledFor: AT + 1 }), hop)).resolves.toBeUndefined();
        expect((await inbox().list()).map((n) => n.kind)).toEqual(['reminder', 'reminder']);
    });
});

// ---------------------------------------------------------------------------
// End to end on the manual scheduler: Schedule → alarm → trigger → Inbox / Task,
// no machine registered, no browser, no chat (AST-03/04, AC-08).

describe('Schedule → scheduleTrigger end to end', () => {
    const TICK = 60_000;
    const codec = { encode: (p: unknown) => JSON.stringify(p), decode: (s: string) => (s === '' ? null : (JSON.parse(s) as unknown)) };
    let host: Host | null = null;
    let restore: (() => void) | null = null;
    let push: ReturnType<typeof recordingChannel>;
    let scheduler: ReturnType<typeof manualScheduler>;
    let Schedule: ReturnType<typeof defineScheduleActor>;

    const as = (principal: Principal) => ({
        actor: <D extends AnyActorDefinition>(def: D, key: string): ActorClient<D> =>
            actor(def, key).with({ context: createTestServerFnContext(undefined, { principal }) })
    });

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(AT);
        push = recordingChannel();
        scheduler = manualScheduler();
        Schedule = defineScheduleActor({ trigger: scheduleTrigger() });
        const app = defineActorApp({
            actors: [Schedule, defineInbox({ channels: [push.channel] }), TaskActor],
            storage: memoryStorage(),
            scheduler,
            defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 }
        });
        restore = stubServerApp({ codec });
        host = await app.start();
    });

    afterEach(async () => {
        await host?.stop({ timeoutMs: 1000 });
        host = null;
        restore?.();
        restore = null;
        vi.useRealTimers();
    });

    /** One reminder tick after `ms` of virtual time, then let the dispatches and hops land. */
    const tick = async (ms = TICK) => {
        vi.setSystemTime(Date.now() + ms);
        scheduler.advance(TICK);
        for (let i = 0; i < 30; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
    };

    it('AC-08: a reminder due with no machine online reaches the inbox from its own alarm, with push delivery', async () => {
        const me = as(owner);
        const schedule = me.actor(Schedule, `${WS}:schedule:${SCH}`);
        await schedule.create({ kind: 'reminder', title: 'Tea', prompt: 'Kettle on', recurrence: { kind: 'at', at: AT + 30_000 } });
        expect(await me.actor(Inbox, inboxKey(WS)).list()).toEqual([]);

        await tick();

        const rows = await me.actor(Inbox, inboxKey(WS)).list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'reminder', title: 'Tea', body: 'Kettle on', ref: { kind: 'schedule', scheduleId: SCH } });
        expect(rows[0]!.deliveries).toEqual([{ channel: 'test-push', at: expect.any(Number), ok: true }]);
        expect(push.sent).toHaveLength(1);

        const view = await schedule.get();
        expect(view.runs).toBe(1);
        expect(view.next).toBeNull(); // one-shot, delivered
        expect(view.log.map((l) => l.kind)).toEqual(['fired', 'exhausted']);
    });

    it('a recurring agent task creates a Task in queued, once per occurrence', async () => {
        const me = as(owner);
        const schedule = me.actor(Schedule, `${WS}:schedule:sch_digest`);
        await schedule.create({
            kind: 'agent-task',
            title: 'Digest',
            prompt: 'Write the digest',
            agentId: AGENT,
            recurrence: { kind: 'cron', cron: '* * * * *', tz: 'UTC' }
        });

        await tick();
        const first = scheduledTaskId('sch_digest' as ScheduleId, AT + TICK);
        const view = await me.actor(TaskActor, taskKey(WS, first)).get();
        expect(view).toMatchObject({ status: 'queued', assignee: AGENT, owner: AGENT, objective: 'Write the digest', origin: { kind: 'schedule', scheduleId: 'sch_digest' } });

        await tick();
        const second = scheduledTaskId('sch_digest' as ScheduleId, AT + 2 * TICK);
        expect((await me.actor(TaskActor, taskKey(WS, second)).get()).status).toBe('queued');
        expect((await schedule.get()).runs).toBe(2);
        expect(await me.actor(Inbox, inboxKey(WS)).list()).toEqual([]);
    });
});
