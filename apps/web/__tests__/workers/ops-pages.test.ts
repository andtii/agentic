/**
 * The operations pages' actor path on the real `ActorHost` (#145): the
 * browser's own `clientDefs()` stubs for the Schedule and the Registry
 * reach their Durable Objects through the actor mount; a reminder the
 * page builds at a wall time on the workspace zone (`newScheduleSpec`)
 * arms the object's alarm for that instant and an alarm run before it is
 * due re-arms instead of firing; the Registry answers the page's reads by
 * secret NAME only, sealed under `WORKSPACE_KEK`.
 */
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import type { WorkspaceId } from '@agentic/core';
import { Inbox, inboxKey } from '@agentic/platform';
import { actor } from '@sigx/actors';
import { configureActors, fetchTransport } from '@sigx/actors/client';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { clientDefs } from '../../src/actors/client';
import { registryKeyOf, scheduleKeyOf, workspaceKeyOf } from '../../src/actors/keys';
import { newScheduleSpec, scheduleRow, wallToInstant } from '../../src/pages/ops/live';
import { overHttp, signIn } from './http';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_5145';
const workspaceId = userId as WorkspaceId;
const TZ = 'Europe/Stockholm';

/** `YYYY-MM-DD HH:mm` of `instant` on the `TZ` clock — what a person types in the dialog. */
function wallLabel(instant: number): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(instant));
    const p = (type: string): string => parts.find((x) => x.type === type)!.value;
    return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
}

afterEach(() => {
    configureActors(null);
});

describe('worker: the ops pages over the browser stubs', () => {
    it('a reminder at a wall time on the workspace zone arms the Schedule object for that instant; the Registry lists secrets by name', async () => {
        const cookie = await signIn(userId);
        configureActors(
            fetchTransport({
                endpoint: `${ORIGIN}/_sigx/actor`,
                headers: { cookie, origin: ORIGIN },
                fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
            })
        );
        const defs = clientDefs();
        const workspace = actor(defs.Workspace, workspaceKeyOf(workspaceId));
        await workspace.updateSettings({ timeZone: TZ });

        // The next whole minute at least a minute away, as the page reads it back from the settings' zone.
        const wanted = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
        const wall = wallLabel(wanted);
        expect(wallToInstant(wall, TZ)).toBe(wanted);
        const spec = newScheduleSpec({ kind: 'reminder', title: 'Tea', at: wall, cron: '', agentId: '', environmentId: '', prompt: 'Kettle on' }, TZ);
        expect(spec).not.toBeNull();

        const { scheduleId } = await workspace.createSchedule();
        const key = scheduleKeyOf(workspaceId, scheduleId);
        const schedule = actor(defs.Schedule, key);
        const created = await schedule.create(spec!);
        expect(created.next).toBe(wanted);
        expect(scheduleRow(created, TZ, Date.now()).nextRun).toMatch(/^(today|tomorrow) \d\d:\d\d$/);
        expect((await workspace.get()).schedules).toContain(scheduleId);

        // The object's alarm is armed for the instant; run early it re-arms and delivers nothing.
        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'Schedule', key })));
        await runDurableObjectAlarm(stub);
        expect((await schedule.get()).next).toBe(wanted);
        expect((await schedule.get()).runs).toBe(0);
        expect(await overHttp(Inbox, inboxKey(workspaceId), cookie).list()).toEqual([]);

        // Off and on through the same stub the page's switch uses.
        expect((await schedule.disable()).next).toBeNull();
        expect((await schedule.enable()).next).toBe(wanted);

        const registry = actor(defs.Registry, registryKeyOf(workspaceId));
        // The build's plugins (#231): listed for a workspace that never touched the Registry.
        expect((await registry.list()).map((p) => p.manifest.id)).toEqual(['agentic.a2a.server', 'agentic.feature.git', 'agentic.feature.plan', 'agentic.learning.default', 'agentic.memory.default', 'agentic.memory.flat', 'agentic.notify.web-push', 'anthropic-api', 'claude-code', 'codex-cli', 'copilot-cli', 'gmail']);
        await registry.setSecret('anthropic-api-key', 'sk-ant-never-shown');
        const secrets = await registry.secrets();
        expect(secrets.map((s) => s.name)).toEqual(['anthropic-api-key']);
        expect(JSON.stringify(secrets)).not.toContain('sk-ant');
        expect(await registry.connectors()).toEqual([]);
    });
});
