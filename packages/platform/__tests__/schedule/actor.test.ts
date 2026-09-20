import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorStorage, Host } from '@sigx/actors';
import { defineActorApp, manualScheduler, memoryStorage, type ManualScheduler } from '@sigx/actors/host';
import type { AgentId, EnvironmentId, ProjectId } from '@agentic/core';
import { defineScheduleActor, FIRE, type ScheduleFired, type ScheduleLogEntry, type TriggerPort } from '../../src/schedule/index';

const TZ = 'Europe/Stockholm';
const T = (iso: string) => Date.parse(iso);
const MIN = 60_000;
/** The host's reminder tick — the platform's 60 s resolution. */
const TICK = MIN;

// ---------------------------------------------------------------------------
// Harness: a virtual clock shared by Date (what reminders judge "due" on)
// and a manual scheduler (what drives the reminder tick).

class Recorder implements TriggerPort {
    events: ScheduleFired[] = [];
    failFor = 0;
    async fired(event: ScheduleFired): Promise<void> {
        if (this.failFor > 0) {
            this.failFor--;
            throw new Error('consumer down');
        }
        this.events.push(event);
    }
}

interface Rig {
    host: Host;
    storage: ActorStorage;
    scheduler: ManualScheduler;
    trigger: Recorder;
    logs: ScheduleLogEntry[];
    Schedule: ReturnType<typeof defineScheduleActor>;
    /**
     * Move the clock to `t`, running one reminder tick per step. `stepMs`
     * (default one tick) is how far Date jumps between ticks: a coarse step
     * models a host that slept, so use it only across spans where nothing
     * is due.
     */
    runTo(t: number, stepMs?: number): Promise<void>;
    /** Advance `ms`, running every tick on the way (see `runTo`). */
    advance(ms: number, stepMs?: number): Promise<void>;
}

const running: Host[] = [];

async function rig(opts: { storage?: ActorStorage; trigger?: Recorder; maxAttempts?: number } = {}): Promise<Rig> {
    const storage = opts.storage ?? memoryStorage();
    const scheduler = manualScheduler();
    const trigger = opts.trigger ?? new Recorder();
    const logs: ScheduleLogEntry[] = [];
    const Schedule = defineScheduleActor({
        trigger,
        allowAnonymous: true,
        maxAttempts: opts.maxAttempts,
        onLog: (_key, entry) => logs.push(entry)
    });
    const app = defineActorApp({
        actors: [Schedule],
        storage,
        scheduler,
        defaults: { reminderTickMs: TICK, sweepIntervalMs: 0, callTimeoutMs: 0 }
    });
    const host = await app.start();
    running.push(host);
    // Macrotask yields; `setImmediate` where it exists (a Windows `setTimeout(0)` is ~15 ms).
    const yieldTurns = async (n: number) => {
        for (let i = 0; i < n; i++) await new Promise((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
    };
    const advance = async (ms: number, stepMs = TICK) => {
        let left = ms;
        while (left > 0) {
            const step = Math.min(left, stepMs);
            vi.setSystemTime(Date.now() + step);
            scheduler.advance(TICK); // one tick per step, at the step's end
            await yieldTurns(1);
            left -= step;
        }
        // The tick is async; let its dispatches and re-arms land.
        await yieldTurns(20);
    };
    return {
        host,
        storage,
        scheduler,
        trigger,
        logs,
        Schedule,
        advance,
        runTo: (t, stepMs) => advance(t - Date.now(), stepMs)
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(async () => {
    for (const host of running.splice(0)) await host.stop({ timeoutMs: 1000 });
    vi.useRealTimers();
});

const KEY = 'ws_alice:schedule:sch_1';

// ---------------------------------------------------------------------------

describe('Schedule actor', () => {
    it('creates, computes next, arms a one-shot reminder and fires through the TriggerPort', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        const created = await client.create({
            kind: 'reminder',
            title: 'standup',
            recurrence: { kind: 'cron', cron: '0 12 * * *', tz: TZ },
            prompt: 'Standup in 5'
        });
        expect(created.workspaceId).toBe('ws_alice');
        expect(created.id).toBe('sch_1');
        expect(created.enabled).toBe(true);
        expect(created.next).toBe(T('2026-09-18T10:00:00Z')); // 12:00 CEST tomorrow (today's 12:00 CEST = 10:00Z is not strictly after)

        // No firing before due (coarse steps: nothing is due in this span).
        await r.runTo(T('2026-09-18T09:59:00Z'), 60 * MIN);
        expect(r.trigger.events).toEqual([]);

        await r.runTo(T('2026-09-18T10:00:00Z'));
        expect(r.trigger.events).toHaveLength(1);
        const [event] = r.trigger.events;
        expect(event).toMatchObject({
            type: 'ScheduleFired',
            workspaceId: 'ws_alice',
            scheduleId: 'sch_1',
            key: KEY,
            kind: 'reminder',
            title: 'standup',
            prompt: 'Standup in 5',
            scheduledFor: T('2026-09-18T10:00:00Z'),
            occurrence: 1,
            skipped: 0,
            offlinePolicy: 'queue'
        });
        expect(event!.firedAt).toBeGreaterThanOrEqual(event!.scheduledFor);

        const after = await client.get();
        expect(after.runs).toBe(1);
        expect(after.lastRun).toBe(event!.firedAt);
        expect(after.next).toBe(T('2026-09-19T10:00:00Z'));
        expect(after.log.map((l) => l.kind)).toEqual(['fired']);
    });

    it('fires Europe/Stockholm spring and fall fixtures at the documented instants', async () => {
        vi.setSystemTime(T('2026-03-27T12:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        await client.create({ kind: 'recurring', title: 'nightly', recurrence: { kind: 'cron', cron: '30 2 * * *', tz: TZ } });

        // 28 Mar 02:30 CET = 01:30Z.
        await r.runTo(T('2026-03-28T01:29:00Z'), 60 * MIN);
        expect(r.trigger.events).toEqual([]);
        await r.runTo(T('2026-03-28T01:30:00Z'));
        expect(r.trigger.events.map((e) => e.scheduledFor)).toEqual([T('2026-03-28T01:30:00Z')]);
        // 29 Mar 02:30 does not exist (spring gap) → skipped: nothing on the 29th.
        expect((await client.get()).next).toBe(T('2026-03-30T00:30:00Z'));
        await r.runTo(T('2026-03-30T00:29:00Z'), 60 * MIN);
        expect(r.trigger.events).toHaveLength(1);
        // 30 Mar 02:30 CEST = 00:30Z.
        await r.runTo(T('2026-03-30T00:30:00Z'));
        expect(r.trigger.events.map((e) => e.scheduledFor)).toEqual([T('2026-03-28T01:30:00Z'), T('2026-03-30T00:30:00Z')]);

        // Jump to the fall, disabled so the idle months fire nothing; enable recomputes from "now".
        await client.disable();
        await r.runTo(T('2026-10-24T00:00:00Z'), 24 * 60 * MIN);
        r.trigger.events.length = 0;
        await client.enable();
        expect((await client.get()).next).toBe(T('2026-10-24T00:30:00Z'));
        await r.runTo(T('2026-10-24T00:29:00Z'), 60 * MIN);
        await r.runTo(T('2026-10-24T00:30:00Z'));
        await r.runTo(T('2026-10-25T00:29:00Z'), 60 * MIN);
        await r.runTo(T('2026-10-25T02:00:00Z'));
        // 24th at 02:30 CEST (00:30Z), 25th FIRST 02:30 (00:30Z, CEST) — not the second at 01:30Z.
        expect(r.trigger.events.map((e) => e.scheduledFor)).toEqual([T('2026-10-24T00:30:00Z'), T('2026-10-25T00:30:00Z')]);
        expect((await client.get()).next).toBe(T('2026-10-26T01:30:00Z')); // 02:30 CET
    });

    it('a reminder survives eviction and a host restart on the same storage', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const storage = memoryStorage();
        const trigger = new Recorder();
        const a = await rig({ storage, trigger });
        const at = T('2026-09-17T10:05:00Z');
        await a.host.actor(a.Schedule, KEY).create({ kind: 'reminder', title: 'tea', recurrence: { kind: 'at', at } });

        // Evict: the DO-style "activation gone, storage intact" case.
        await a.host.deactivateType('Schedule');
        expect(a.host.stats().activations).toBe(0);
        await a.runTo(at);
        expect(trigger.events.map((e) => e.scheduledFor)).toEqual([at]);
        expect(a.host.stats().activations).toBe(1); // re-activated by the reminder
        const got = await a.host.actor(a.Schedule, KEY).get();
        expect(got.next).toBeNull(); // one-shot: exhausted after firing
        expect(got.log.map((l) => l.kind)).toEqual(['fired', 'exhausted']);

        // Restart: arm on host A, stop it, host B over the same storage fires.
        const at2 = T('2026-09-17T11:00:00Z');
        await a.host.actor(a.Schedule, 'ws_alice:schedule:sch_2').create({ kind: 'reminder', title: 'coffee', recurrence: { kind: 'at', at: at2 } });
        await a.host.stop();
        running.splice(running.indexOf(a.host), 1);
        trigger.events.length = 0;

        const b = await rig({ storage, trigger });
        await b.runTo(at2);
        expect(trigger.events.map((e) => [e.scheduleId, e.scheduledFor])).toEqual([['sch_2', at2]]);
    });

    it('manual scheduler fires entries in due order, never early, on the 60 s tick', async () => {
        const t0 = T('2026-09-17T10:00:00Z');
        vi.setSystemTime(t0);
        const r = await rig();
        const mk = (id: string, at: number) =>
            r.host.actor(r.Schedule, `ws_alice:schedule:${id}`).create({ kind: 'reminder', title: id, recurrence: { kind: 'at', at } });
        await mk('a', t0 + 90_000);
        await mk('b', t0 + 200_000);
        await mk('c', t0 + 30_000);

        await r.advance(TICK); // +60 s: c (+30 s) is due — nothing fires between ticks
        expect(r.trigger.events.map((e) => e.scheduleId)).toEqual(['c']);
        await r.advance(TICK); // +120 s: a (+90 s)
        expect(r.trigger.events.map((e) => e.scheduleId)).toEqual(['c', 'a']);
        await r.advance(TICK); // +180 s: nothing
        expect(r.trigger.events).toHaveLength(2);
        await r.advance(TICK); // +240 s: b (+200 s)
        expect(r.trigger.events.map((e) => e.scheduleId)).toEqual(['c', 'a', 'b']);
        for (const e of r.trigger.events) {
            expect(e.firedAt).toBeGreaterThanOrEqual(e.scheduledFor); // never early
            expect(e.firedAt - e.scheduledFor).toBeLessThan(TICK); // within one floor
        }
    });

    it('an every-minute cron fires exactly once per 60 s tick — no burst, never early', async () => {
        const t0 = T('2026-09-17T10:00:00Z');
        vi.setSystemTime(t0);
        const r = await rig();
        await r.host.actor(r.Schedule, 'ws_alice:schedule:m').create({
            kind: 'recurring',
            title: 'every minute',
            recurrence: { kind: 'cron', cron: '* * * * *', tz: 'UTC' }
        });
        for (let i = 1; i <= 4; i++) {
            await r.advance(TICK);
            expect(r.trigger.events.map((e) => e.scheduledFor)).toEqual([1, 2, 3, 4].slice(0, i).map((k) => t0 + k * MIN));
        }
        for (const e of r.trigger.events) expect(e.firedAt).toBe(e.scheduledFor);
    });

    it('catch-up policy skip: a late reminder fires once, logs the missed occurrences and re-arms from now', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        await client.create({ kind: 'recurring', title: 'q', recurrence: { kind: 'cron', cron: '*/15 * * * *', tz: TZ } });
        expect((await client.get()).next).toBe(T('2026-09-17T10:15:00Z'));

        // The host sleeps for 65 minutes (no ticks), then one tick runs.
        vi.setSystemTime(T('2026-09-17T11:20:00Z'));
        r.scheduler.advance(TICK);
        await new Promise((res) => setTimeout(res, 20));

        expect(r.trigger.events).toHaveLength(1);
        expect(r.trigger.events[0]).toMatchObject({ scheduledFor: T('2026-09-17T10:15:00Z'), skipped: 4 });
        const s = await client.get();
        expect(s.next).toBe(T('2026-09-17T11:30:00Z'));
        expect(s.log).toEqual([
            { kind: 'fired', at: T('2026-09-17T11:20:00Z'), scheduledFor: T('2026-09-17T10:15:00Z'), skipped: 4 },
            { kind: 'skipped', at: T('2026-09-17T11:20:00Z'), from: T('2026-09-17T10:15:00Z'), to: T('2026-09-17T11:20:00Z'), count: 4 }
        ]);
        expect(r.logs).toEqual(s.log);
    });

    it('retries a failing consumer one floor later, then drops the occurrence and moves on', async () => {
        const t0 = T('2026-09-17T10:00:00Z');
        vi.setSystemTime(t0);
        const r = await rig({ maxAttempts: 2 });
        const client = r.host.actor(r.Schedule, KEY);
        await client.create({ kind: 'agent-task', title: 'digest', recurrence: { kind: 'cron', cron: '0 * * * *', tz: 'UTC' } });
        r.trigger.failFor = 1;

        await r.runTo(t0 + 59 * MIN, 10 * MIN);
        await r.runTo(t0 + 60 * MIN); // 11:00 due → attempt 1 fails
        expect(r.trigger.events).toEqual([]);
        let s = await client.get();
        expect(s.attempts).toBe(1);
        expect(s.next).toBe(t0 + 60 * MIN); // same occurrence
        expect(s.log.map((l) => l.kind)).toEqual(['retry']);

        await r.advance(TICK); // retry lands one floor later and succeeds
        expect(r.trigger.events.map((e) => e.scheduledFor)).toEqual([t0 + 60 * MIN]);
        s = await client.get();
        expect(s.attempts).toBe(0);
        expect(s.next).toBe(t0 + 120 * MIN);

        // Two failures in a row hit maxAttempts: dropped, re-armed for the next hour.
        r.trigger.failFor = 2;
        await r.runTo(t0 + 119 * MIN, 10 * MIN);
        await r.runTo(t0 + 120 * MIN);
        await r.advance(TICK);
        s = await client.get();
        expect(s.log.map((l) => l.kind)).toEqual(['retry', 'fired', 'retry', 'dropped']);
        expect(s.next).toBe(t0 + 180 * MIN);
        expect(r.trigger.events).toHaveLength(1);
    });

    it('disable clears the reminder, enable and update re-arm from now', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        await client.create({ kind: 'reminder', title: 'x', recurrence: { kind: 'cron', cron: '0 11 * * *', tz: 'UTC' } });

        const disabled = await client.disable();
        expect(disabled.enabled).toBe(false);
        expect(disabled.next).toBeNull();
        await r.runTo(T('2026-09-17T12:00:00Z'), 60 * MIN);
        expect(r.trigger.events).toEqual([]);

        const enabled = await client.enable();
        expect(enabled.next).toBe(T('2026-09-18T11:00:00Z'));

        const updated = await client.update({ recurrence: { kind: 'cron', cron: '30 12 * * *', tz: 'UTC' }, offlinePolicy: 'fail' });
        expect(updated.next).toBe(T('2026-09-17T12:30:00Z'));
        expect(updated.offlinePolicy).toBe('fail');
        await r.runTo(T('2026-09-17T12:29:00Z'), 10 * MIN);
        await r.runTo(T('2026-09-17T12:30:00Z'));
        expect(r.trigger.events.map((e) => [e.scheduledFor, e.offlinePolicy])).toEqual([[T('2026-09-17T12:30:00Z'), 'fail']]);
    });

    it('rejects a bad key, a second create, use before create, and an unknown zone', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        await expect(
            r.host.actor(r.Schedule, 'nokey').create({ kind: 'reminder', title: 'x', recurrence: { kind: 'at', at: Date.now() + MIN } })
        ).rejects.toThrow(/key must be/);
        const client = r.host.actor(r.Schedule, KEY);
        await expect(client.get()).rejects.toThrow(/does not exist/);
        await expect(
            client.create({ kind: 'reminder', title: 'x', recurrence: { kind: 'cron', cron: '0 9 * * *', tz: 'Mars/Olympus' } })
        ).rejects.toThrow(/unknown IANA/);
        await client.create({ kind: 'reminder', title: 'x', recurrence: { kind: 'at', at: Date.now() + MIN } });
        await expect(client.create({ kind: 'reminder', title: 'y', recurrence: { kind: 'at', at: Date.now() + MIN } })).rejects.toThrow(
            /already exists/
        );
    });

    it('never arms a period: every occurrence is a one-shot named "fire"', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        // A period under 60 s would be rejected by the runtime; a one-shot every minute is fine.
        await client.create({ kind: 'recurring', title: 'tick', recurrence: { kind: 'cron', cron: '* * * * *', tz: 'UTC' } });
        await r.advance(3 * TICK);
        expect(r.trigger.events).toHaveLength(3);
        expect(FIRE).toBe('fire');
    });
});

describe('Schedule working folder (#190)', () => {
    const ENV = 'env_laptop' as EnvironmentId;

    it('carries its workdir into the firing, refuses one without an environment, and clears it with null', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        const base = { kind: 'agent-task', title: 'digest', recurrence: { kind: 'at', at: T('2026-09-17T10:05:00Z') }, agentId: 'agent_a' as AgentId } as const;
        await expect(client.create({ ...base, workdir: 'C:/src/app' })).rejects.toMatchObject({ status: 400 });
        const created = await client.create({ ...base, environmentId: ENV, workdir: 'C:/src/app' });
        expect(created.workdir).toBe('C:/src/app');
        await r.runTo(T('2026-09-17T10:05:00Z'));
        expect(r.trigger.events).toHaveLength(1);
        expect(r.trigger.events[0]).toMatchObject({ environmentId: ENV, workdir: 'C:/src/app' });

        await expect(client.update({ workdir: '  ' })).rejects.toMatchObject({ status: 400 });
        expect((await client.update({ workdir: ' C:/src/other ' })).workdir).toBe('C:/src/other');
        const cleared = await client.update({ workdir: null });
        expect(cleared.workdir).toBeUndefined();
        expect('workdir' in cleared).toBe(false);
    });
});

describe('Schedule project (#332)', () => {
    const ENV = 'env_laptop' as EnvironmentId;
    const PROJECT = 'project_1' as ProjectId;

    it('carries its projectId into the firing, refuses one beside an environment or a folder, and clears it with null', async () => {
        vi.setSystemTime(T('2026-09-17T10:00:00Z'));
        const r = await rig();
        const client = r.host.actor(r.Schedule, KEY);
        const base = { kind: 'agent-task', title: 'digest', recurrence: { kind: 'at', at: T('2026-09-17T10:05:00Z') }, agentId: 'agent_a' as AgentId } as const;
        // A project says where the work lives: never beside an environment or a folder.
        await expect(client.create({ ...base, projectId: PROJECT, environmentId: ENV })).rejects.toMatchObject({ status: 400 });
        await expect(client.create({ ...base, projectId: PROJECT, environmentId: ENV, workdir: 'C:/src/app' })).rejects.toMatchObject({ status: 400 });
        await expect(client.create({ ...base, projectId: '  ' as ProjectId })).rejects.toMatchObject({ status: 400 });
        const created = await client.create({ ...base, projectId: PROJECT });
        expect(created.projectId).toBe(PROJECT);
        expect(created.environmentId).toBeUndefined();
        await r.runTo(T('2026-09-17T10:05:00Z'));
        expect(r.trigger.events).toHaveLength(1);
        expect(r.trigger.events[0]).toMatchObject({ projectId: PROJECT });
        expect('environmentId' in r.trigger.events[0]!).toBe(false);

        // A patch is checked against what stays: an environment beside the kept project is refused; clearing the project first lets it in.
        await expect(client.update({ environmentId: ENV })).rejects.toMatchObject({ status: 400 });
        const cleared = await client.update({ projectId: null, environmentId: ENV, workdir: 'C:/src/app' });
        expect(cleared.projectId).toBeUndefined();
        expect('projectId' in cleared).toBe(false);
        expect(cleared).toMatchObject({ environmentId: ENV, workdir: 'C:/src/app' });
        // Back to a project: the environment and the folder go together with `null`.
        await expect(client.update({ projectId: PROJECT })).rejects.toMatchObject({ status: 400 });
        const back = await client.update({ projectId: PROJECT, environmentId: null, workdir: null });
        expect(back.projectId).toBe(PROJECT);
        expect('environmentId' in back).toBe(false);
        expect('workdir' in back).toBe(false);
    });
});
