/**
 * AC-08 — A reminder becomes due while all user machines are offline. The
 * central scheduling and notification path delivers the reminder.
 *
 * Inside workerd: the user's one machine was online and went away (no
 * daemon, no browser connected); a reminder is created through the Schedule
 * object and its own Durable Object alarm — advanced with
 * `runDurableObjectAlarm`, which fires only what is already due — delivers
 * it to the Inbox. Nothing but the actor mount was involved. Push delivery
 * to a device is the manual half (docs/acceptance.md). Deeper:
 * `packages/platform/__tests__/schedule/trigger.test.ts` (the trigger with
 * a push channel, in process) and `../workers/schedule.test.ts` (scheduled
 * agent tasks, the environment-offline parking).
 */
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import type { EnvironmentId, ScheduleId } from '@agentic/core';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Inbox, inboxKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { seen } from '../workers/http';
import { Schedule, connectDaemon, daemonFor, overHttp, signInAs, sleep, until } from './workers';

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

describe('AC-08: a reminder due while every machine is offline', () => {
    it('lands in the inbox from the entry’s own alarm, through the actor mount alone', async () => {
        const me = await signInAs('ac08_user');
        // The user's machine was here, and is gone: nothing of the user's is online when the reminder falls due.
        const { machineId, token } = await me.pairMachine('laptop');
        const link = await connectDaemon(machineId, token, daemonFor(machineId, [inMemoryEnvironment(machineId, 'env_laptop' as EnvironmentId)]));
        await link.welcomed();
        await until(async () => (await me.machine(machineId).get()).online, 'the laptop online');
        link.close();
        await until(async () => !(await me.machine(machineId).get()).online, 'the laptop offline');
        expect((await me.workspace().listMachines()).map((m) => m.name)).toEqual(['laptop']);

        const scheduleId = 'sch_tea' as ScheduleId;
        const key = `${me.ws}:schedule:${scheduleId}`;
        const schedule = overHttp(Schedule, key, me.cookie);
        const inbox = overHttp(Inbox, inboxKey(me.ws), me.cookie);
        seen.length = 0;

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
        // Still offline; the reminder never needed a machine or a browser.
        expect((await me.machine(machineId).get()).online).toBe(false);
        for (const path of seen) expect(path.startsWith('/_sigx/actor/')).toBe(true);
    });
});
