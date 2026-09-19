/**
 * AC-08 on the real `ActorHost` (issue #42): a reminder becomes due while no
 * machine is registered and no browser is connected; the entry's own Durable
 * Object alarm delivers it to the inbox. A scheduled agent task becomes a
 * queued Task. Alarms are advanced with `runDurableObjectAlarm` — the object
 * fires whatever is due, exactly as the platform's alarm would.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { AgentId, EnvironmentId, ScheduleId, WorkspaceId } from '@agentic/core';
import { AgentActor, Inbox, TaskActor, agentKey, defineScheduleActor, inboxKey, scheduledTaskId, taskKey, type ScheduleSpec } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, seen, signIn } from './http';

const userId = 'gh_4242';
const workspaceId = userId as WorkspaceId;
const agentId = 'agent_digest' as AgentId;

/** Only its `type` ('Schedule') matters to `overHttp`; the host runs the app's own definition. */
const Schedule = defineScheduleActor({ trigger: { fired: () => undefined } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Budgets for the slow Windows runner, where one Durable Object turn can hold for 7–10 s (#179): every wait is on a
 * condition with a wall-clock deadline, and each test's timeout exceeds the waits inside it so the real error surfaces.
 */
const WAIT_MS = 20_000;
const ALARM_MS = 60_000;
const TEST_MS = 120_000;

/** Poll until `check()` holds. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

type ScheduleClient = ReturnType<typeof overHttp<typeof Schedule>>;

/**
 * Create a one-shot entry due in ~2 s and make sure it IS armed; returns its `at`. `at` is fixed before the round
 * trip, and on a starved runner the `create` turn can land after it (the entry's object boots cold): a past `at`
 * has no next occurrence, so the entry is created already `exhausted` with nothing armed, and no alarm can ever
 * deliver it (#179). Then re-arm it further ahead, until an occurrence sticks.
 */
async function scheduleSoon(schedule: ScheduleClient, spec: Omit<ScheduleSpec, 'recurrence'>): Promise<number> {
    let lead = 2_000;
    let at = Date.now() + lead;
    let view = await schedule.create({ ...spec, recurrence: { kind: 'at', at } });
    while (view.next !== at) {
        if (lead >= 32_000) throw new Error(`could not arm ${spec.title}: ${JSON.stringify(view)}`);
        lead *= 2;
        at = Date.now() + lead;
        view = await schedule.update({ recurrence: { kind: 'at', at } });
    }
    return at;
}

/** Force the entry's alarm until `delivered()` holds — the alarm only fires what is already due. */
async function advanceAlarm(schedule: ScheduleClient, key: string, delivered: () => Promise<boolean>): Promise<void> {
    const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
    const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'Schedule', key })));
    const deadline = Date.now() + ALARM_MS;
    while (Date.now() < deadline) {
        await sleep(100);
        await runDurableObjectAlarm(stub);
        if (await delivered()) return;
    }
    // Say why: the entry's own record (`next`, `runs`, a `retry` / `exhausted` in its log) and the object's reminder table.
    const view = await schedule.get().catch((e: unknown) => String(e));
    const table = await runInDurableObject(stub, async (_instance, state) => ({ now: Date.now(), alarm: await state.storage.getAlarm(), reminders: await state.storage.get('sigx:reminders') }));
    throw new Error(`the alarm of ${key} never delivered in ${ALARM_MS} ms\n${JSON.stringify({ view, table }, null, 1)}`);
}

afterEach(() => {
    seen.length = 0;
});

describe('worker: schedule alarm → trigger → Inbox / Task, no machine registered', () => {
    it('AC-08: a reminder due with every machine offline lands in the inbox from its own alarm', async () => {
        const cookie = await signIn(userId);
        const scheduleId = 'sch_tea' as ScheduleId;
        const key = `${workspaceId}:schedule:${scheduleId}`;
        const schedule = overHttp(Schedule, key, cookie);
        const inbox = overHttp(Inbox, inboxKey(workspaceId), cookie);

        await scheduleSoon(schedule, { kind: 'reminder', title: 'Tea', prompt: 'Kettle on' });
        expect(await inbox.list()).toEqual([]);

        await advanceAlarm(schedule, key, async () => (await inbox.list()).length > 0);

        const rows = await inbox.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'reminder', title: 'Tea', body: 'Kettle on', ref: { kind: 'schedule', scheduleId }, read: false });
        expect(await inbox.unread()).toBe(1);

        const view = await schedule.get();
        expect(view.runs).toBe(1);
        expect(view.next).toBeNull();
        // One firing, then nothing left (an `exhausted` before it is `scheduleSoon` re-arming an entry created too late).
        expect(view.log.map((l) => l.kind).slice(-2)).toEqual(['fired', 'exhausted']);
        expect(view.log.filter((l) => l.kind === 'fired')).toHaveLength(1);
        // Everything went through the actor mount; nothing else was needed.
        for (const path of seen) expect(path.startsWith('/_sigx/actor/')).toBe(true);
    }, TEST_MS);

    it('a scheduled agent task becomes a Task with origin {kind: schedule}, handed to the router (#37)', async () => {
        const cookie = await signIn(userId);
        const scheduleId = 'sch_digest' as ScheduleId;
        const key = `${workspaceId}:schedule:${scheduleId}`;
        const schedule = overHttp(Schedule, key, cookie);
        const inbox = overHttp(Inbox, inboxKey(workspaceId), cookie);
        const inboxBefore = (await inbox.list()).length; // storage is per file, not per test

        const at = await scheduleSoon(schedule, { kind: 'agent-task', title: 'Digest', prompt: 'Write the digest', agentId });

        const taskId = scheduledTaskId(scheduleId, at);
        const task = overHttp(TaskActor, taskKey(workspaceId, taskId), cookie);
        const exists = () => task.get().then(() => true, () => false);
        await advanceAlarm(schedule, key, exists);

        // The trigger hands the task to the router, which runs it asynchronously; this agent has no configuration, so the
        // route ends there with a reason — the point is that a firing's task never stays `queued` unattended.
        await until(async () => (await task.get()).status !== 'queued', 'the router to pick the task up');
        const view = await task.get();
        expect(view).toMatchObject({
            id: taskId,
            status: 'failed',
            owner: agentId,
            assignee: agentId,
            objective: 'Write the digest',
            origin: { kind: 'schedule', scheduleId },
            error: { code: 'agent-unconfigured' }
        });
        expect(view.wait).toBeUndefined();
        // A scheduled task is not a reminder: nothing new reached the inbox.
        expect((await inbox.list()).length).toBe(inboxBefore);
    }, TEST_MS);

    it('AST-05: a task that needs an environment waits environment-offline (no machine registered, policy queue)', async () => {
        const cookie = await signIn(userId);
        const scheduleId = 'sch_env' as ScheduleId;
        const key = `${workspaceId}:schedule:${scheduleId}`;
        const environmentId = 'env_laptop' as EnvironmentId;
        // A configured agent on a daemon runtime: the router (#37) adopts the parked task and, with no machine reporting the
        // environment, keeps it waiting under the `queue` policy instead of failing it.
        await overHttp(AgentActor, agentKey(workspaceId, agentId), cookie).update({ name: 'Digest', instructions: 'Build it.', execution: { runtime: 'claude-code', defaultEnvironmentId: environmentId, offlinePolicy: 'queue' } }, 'create');

        const schedule = overHttp(Schedule, key, cookie);
        const at = await scheduleSoon(schedule, { kind: 'agent-task', title: 'Build', prompt: 'Run the build', agentId, environmentId });

        const task = overHttp(TaskActor, taskKey(workspaceId, scheduledTaskId(scheduleId, at)), cookie);
        // The task exists (`queued`) a turn before the router parks it: wait for the park, not for the record (#174).
        await advanceAlarm(schedule, key, () => task.get().then((v) => v.status === 'waiting', () => false));

        const view = await task.get();
        expect(view.status).toBe('waiting');
        expect(view.wait).toEqual({ kind: 'environment-offline', environmentId, policy: 'queue' });
        expect(await task.explain()).toEqual(view.wait);
    }, TEST_MS);
});
