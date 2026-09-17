/**
 * AC-08 on the real `ActorHost` (issue #42): a reminder becomes due while no
 * machine is registered and no browser is connected; the entry's own Durable
 * Object alarm delivers it to the inbox. A scheduled agent task becomes a
 * queued Task. Alarms are advanced with `runDurableObjectAlarm` — the object
 * fires whatever is due, exactly as the platform's alarm would.
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import type { AgentId, EnvironmentId, ScheduleId, WorkspaceId } from '@agentic/core';
import { AgentActor, Inbox, TaskActor, agentKey, defineScheduleActor, inboxKey, scheduledTaskId, taskKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, seen, signIn } from './http';

const userId = 'gh_4242';
const workspaceId = userId as WorkspaceId;
const agentId = 'agent_digest' as AgentId;

/** Only its `type` ('Schedule') matters to `overHttp`; the host runs the app's own definition. */
const Schedule = defineScheduleActor({ trigger: { fired: () => undefined } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `check()` holds. */
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

/** Force the entry's alarm until `delivered()` holds — the alarm only fires what is already due. */
async function advanceAlarm(key: string, delivered: () => Promise<boolean>): Promise<void> {
    const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
    const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'Schedule', key })));
    for (let i = 0; i < 100; i++) {
        await sleep(100);
        await runDurableObjectAlarm(stub);
        if (await delivered()) return;
    }
    throw new Error(`the alarm of ${key} never delivered`);
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

        const at = Date.now() + 2_000; // far enough ahead that a slow `create` never sees it already due
        const created = await schedule.create({ kind: 'reminder', title: 'Tea', prompt: 'Kettle on', recurrence: { kind: 'at', at } });
        expect(created.next).toBe(at);
        expect(await inbox.list()).toEqual([]);

        await advanceAlarm(key, async () => (await inbox.list()).length > 0);

        const rows = await inbox.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'reminder', title: 'Tea', body: 'Kettle on', ref: { kind: 'schedule', scheduleId }, read: false });
        expect(await inbox.unread()).toBe(1);

        const view = await schedule.get();
        expect(view.runs).toBe(1);
        expect(view.next).toBeNull();
        expect(view.log.map((l) => l.kind)).toEqual(['fired', 'exhausted']);
        // Everything went through the actor mount; nothing else was needed.
        for (const path of seen) expect(path.startsWith('/_sigx/actor/')).toBe(true);
    });

    it('a scheduled agent task becomes a Task with origin {kind: schedule}, handed to the router (#37)', async () => {
        const cookie = await signIn(userId);
        const scheduleId = 'sch_digest' as ScheduleId;
        const key = `${workspaceId}:schedule:${scheduleId}`;
        const schedule = overHttp(Schedule, key, cookie);
        const inbox = overHttp(Inbox, inboxKey(workspaceId), cookie);
        const inboxBefore = (await inbox.list()).length; // storage is per file, not per test

        const at = Date.now() + 2_000; // far enough ahead that a slow `create` never sees it already due
        await schedule.create({ kind: 'agent-task', title: 'Digest', prompt: 'Write the digest', agentId, recurrence: { kind: 'at', at } });

        const taskId = scheduledTaskId(scheduleId, at);
        const task = overHttp(TaskActor, taskKey(workspaceId, taskId), cookie);
        const exists = () => task.get().then(() => true, () => false);
        await advanceAlarm(key, exists);

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
    });

    it('AST-05: a task that needs an environment waits environment-offline (no machine registered, policy queue)', async () => {
        const cookie = await signIn(userId);
        const scheduleId = 'sch_env' as ScheduleId;
        const key = `${workspaceId}:schedule:${scheduleId}`;
        const environmentId = 'env_laptop' as EnvironmentId;
        // A configured agent on a daemon runtime: the router (#37) adopts the parked task and, with no machine reporting the
        // environment, keeps it waiting under the `queue` policy instead of failing it.
        await overHttp(AgentActor, agentKey(workspaceId, agentId), cookie).update({ name: 'Digest', instructions: 'Build it.', execution: { runtime: 'claude-code', defaultEnvironmentId: environmentId, offlinePolicy: 'queue' } }, 'create');

        const at = Date.now() + 2_000; // far enough ahead that a slow `create` never sees it already due
        await overHttp(Schedule, key, cookie).create({
            kind: 'agent-task',
            title: 'Build',
            prompt: 'Run the build',
            agentId,
            environmentId,
            recurrence: { kind: 'at', at }
        });

        const task = overHttp(TaskActor, taskKey(workspaceId, scheduledTaskId(scheduleId, at)), cookie);
        await advanceAlarm(key, () => task.get().then(() => true, () => false));

        const view = await task.get();
        expect(view.status).toBe('waiting');
        expect(view.wait).toEqual({ kind: 'environment-offline', environmentId, policy: 'queue' });
        expect(await task.explain()).toEqual(view.wait);
    });
});
