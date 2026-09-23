/**
 * Incoming Gmail starts agent work, inside workerd (#535): a Schedule that watches the Gmail connector polls the fake
 * mailbox (`./google.ts`) from its own Durable Object alarm through the PRODUCTION trigger (`connectorTrigger`) — the
 * Registry, the workspace's `ConnectorAccounts` and the engine the sign-in routes built — and starts ONE task per new
 * message for the chosen agent. A re-poll starts no other; a revoked sign-in pauses the entry with an Inbox note;
 * an entry switched off does not poll.
 */
import { SELF, env, runDurableObjectAlarm } from 'cloudflare:test';
import type { AgentId, ScheduleId, WorkspaceId } from '@agentic/core';
import { AgentActor, Inbox, TaskActor, TaskIndex, Workspace, agentKey, defineScheduleActor, inboxKey, taskIndexKey, taskKey, workspaceKey, type ScheduleView } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { triggeredTaskId } from '../../src/connectors/trigger';
import { overHttp, registryOverHttp, setAnthropicKey, signIn } from './http';

const ORIGIN = 'https://agentic.test';
const Schedule = defineScheduleActor({ trigger: { fired: () => undefined } });
const TEST_MS = 120_000;
const WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean>, what: string, timeoutMs = WAIT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

async function googleLog(): Promise<string[]> {
    return ((await (await SELF.fetch(`${ORIGIN}/__test/google/log`)).json()) as { log: string[] }).log;
}

const deliver = (id: string, subject: string) => SELF.fetch(`${ORIGIN}/__test/google/mail`, { method: 'POST', body: JSON.stringify({ id, from: 'Ada <ada@example.com>', subject, snippet: `About ${subject}` }) });

/** Gmail on, its client saved, connected with the mailbox account; an `anthropic-api` agent to wake. */
async function setUp(userId: string) {
    const WS = userId as WorkspaceId;
    const cookie = await signIn(userId);
    const registry = registryOverHttp(WS, cookie);
    await registry.enable('gmail');
    await registry.setSecret('client-id', 'cid.apps.googleusercontent.com');
    await registry.setSecret('client-secret', 'client-shh');
    const start = await SELF.fetch(`${ORIGIN}/_agentic/connectors/gmail/start`, { redirect: 'manual', headers: { cookie } });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await SELF.fetch(`${ORIGIN}/_agentic/connectors/callback?state=${encodeURIComponent(state)}&code=code-mail`, { redirect: 'manual', headers: { cookie } });
    expect(back.headers.get('location')).toBe('/plugins/gmail?connected=1');

    await setAnthropicKey(WS, cookie);
    const ws = overHttp(Workspace, workspaceKey(WS), cookie);
    const { agentId } = await ws.createAgent({ name: 'Mail' });
    await overHttp(AgentActor, agentKey(WS, agentId as AgentId), cookie).update({ name: 'Mail', instructions: 'Triage mail.', execution: { runtime: 'anthropic-api', offlinePolicy: 'fail' } }, 'create');
    const { scheduleId } = await ws.createSchedule();
    const key = `${WS}:schedule:${scheduleId}`;
    return { WS, cookie, agentId: agentId as AgentId, scheduleId: scheduleId as ScheduleId, key, schedule: overHttp(Schedule, key, cookie) };
}

/** Arm the entry ~2 s ahead (a one-shot, so each poll is one deliberate firing) and fire it once its log grows. */
async function pollOnce(schedule: ReturnType<typeof overHttp<typeof Schedule>>, key: string): Promise<ScheduleView> {
    const before = (await schedule.get()).log.length;
    let lead = 2_000;
    let at = Date.now() + lead;
    let view = await schedule.update({ recurrence: { kind: 'at', at } });
    while (view.next !== at) {
        lead *= 2;
        if (lead > 32_000) throw new Error(`could not arm ${key}`);
        at = Date.now() + lead;
        view = await schedule.update({ recurrence: { kind: 'at', at } });
    }
    const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
    const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'Schedule', key })));
    await until(async () => {
        await runDurableObjectAlarm(stub);
        return (await schedule.get()).log.slice(before).some((l) => l.kind === 'fired' || l.kind === 'dropped');
    }, `a firing of ${key}`, 60_000);
    return schedule.get();
}

describe('worker: incoming Gmail starts agent work (#535)', () => {
    it('a new message starts exactly one task for the agent; a re-poll starts no other', async () => {
        const { WS, cookie, agentId, scheduleId, key, schedule } = await setUp('gh_5351');
        await schedule.create({ kind: 'agent-task', title: 'New Gmail → Mail', recurrence: { kind: 'at', at: Date.now() + 3_600_000 }, agentId, prompt: 'Triage this email.', source: { kind: 'connector', connector: 'gmail', query: 'in:inbox' } });
        await deliver('mail1', 'Invoice');

        const first = await pollOnce(schedule, key);
        expect(first.log.filter((l) => l.kind === 'retry' || l.kind === 'dropped')).toEqual([]);
        const task = overHttp(TaskActor, taskKey(WS, triggeredTaskId(scheduleId, 'mail1')), cookie);
        const view = await task.get();
        expect(view).toMatchObject({ assignee: agentId, owner: agentId, objective: 'Triage this email.', origin: { kind: 'trigger', triggerId: scheduleId } });
        const context = JSON.stringify(view.context);
        for (const part of ['Ada <ada@example.com>', 'Invoice', 'mail1', 'gmail__get-message']) expect(context).toContain(part);
        // The router starts it: the agent's turn runs.
        await until(async () => (await task.get()).status !== 'queued', 'the router to start the task');
        expect(JSON.parse(first.cursor!).seen).toEqual(['mail1']);

        // Nothing new: the re-poll starts nothing. A second message: exactly one more.
        const again = await pollOnce(schedule, key);
        expect(JSON.parse(again.cursor!).seen).toEqual(['mail1']);
        expect(JSON.parse(again.cursor!).since).toBeGreaterThanOrEqual(JSON.parse(first.cursor!).since);
        await deliver('mail2', 'Lunch');
        await pollOnce(schedule, key);
        const triggered = (await overHttp(TaskIndex, taskIndexKey(WS), cookie).list()).filter((r) => r.origin === 'trigger');
        expect(triggered.map((r) => r.id).sort()).toEqual([triggeredTaskId(scheduleId, 'mail1'), triggeredTaskId(scheduleId, 'mail2')].sort());
        // Each poll searched with the owner's filter and a time bound.
        expect((await googleLog()).filter((l) => l.startsWith('GET gmail.googleapis.com/gmail/v1/users/me/messages')).length).toBeGreaterThanOrEqual(3);
    }, TEST_MS);

    it('a revoked sign-in pauses the entry and says so in the Inbox; switched off, it does not poll', async () => {
        const { WS, cookie, agentId, key, schedule, scheduleId } = await setUp('gh_5352');
        await schedule.create({ kind: 'agent-task', title: 'New Gmail → Mail', recurrence: { kind: 'at', at: Date.now() + 3_600_000 }, agentId, source: { kind: 'connector', connector: 'gmail' } });
        await SELF.fetch(`${ORIGIN}/__test/google/mail/revoke`, { method: 'POST' });

        const paused = await pollOnce(schedule, key);
        expect(paused.enabled).toBe(false);
        expect(paused.next).toBeNull();
        expect(paused.paused?.reason).toMatch(/reconnect it at \/plugins\/gmail/);
        expect(paused.log.map((l) => l.kind)).toContain('paused');
        const notes = (await overHttp(Inbox, inboxKey(WS), cookie).list()).filter((n) => n.ref?.kind === 'schedule' && n.ref.scheduleId === scheduleId);
        expect(notes).toHaveLength(1);
        expect(notes[0]!.title).toContain('is paused');

        // Off (paused, or switched off by the owner): arming it does nothing, and Gmail is not asked again.
        await schedule.disable();
        const before = (await googleLog()).length;
        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await schedule.update({ recurrence: { kind: 'at', at: Date.now() + 1_000 } });
        await sleep(1_500);
        await runDurableObjectAlarm(namespace.get(namespace.idFromName(durableObjectName({ type: 'Schedule', key }))));
        const after = await schedule.get();
        expect(after.enabled).toBe(false);
        expect(after.log.filter((l) => l.kind === 'fired')).toHaveLength(1);
        expect((await googleLog()).length).toBe(before);
    }, TEST_MS);
});
