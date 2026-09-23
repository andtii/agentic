/**
 * `/plugins/gmail`'s trigger section over the real wire (#535): the owner picks the agent, the filter and the
 * interval, "Turn on" creates the Schedule entry that watches the connector (listed on /schedules too), the switch
 * turns it off and on, and an entry a poll paused says why.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduleId } from '@agentic/core';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { ConnectorAccounts, Workspace, defineRegistry, defineScheduleActor, generateWorkspaceKek, importWorkspaceKek, registryKey, workspaceKey, type ScheduleView } from '@agentic/platform';
import { anthropicApiPlugin } from '@agentic/runtimes';
import { buttonNamed, text } from './helpers';
import { WS, mountLive, owner, startLive, until, type LiveHarness } from './live-harness';

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [anthropicApiPlugin, { manifest: gmailConnectorPlugin, enabledByDefault: false }] });
const REVOKED = 'The sign-in for mail@example.com expired or was revoked: reconnect it at /plugins/gmail.';
/** A poll that finds the account signed out pauses its entry — what `connectorTrigger` answers; every other firing does nothing. */
const Schedule = defineScheduleActor({ trigger: { fired: (e) => (e.title === 'signed out' ? { pause: REVOKED } : undefined) } });

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive(undefined, { defaults: { reminderTickMs: 20 }, actors: [Registry, ConnectorAccounts, Schedule] });
    await h.app.as(owner).actor(Registry, registryKey(WS)).enable('gmail');
});
afterEach(async () => {
    await h.stop();
});

const ws = () => h.app.as(owner).actor(Workspace, workspaceKey(WS));
const schedule = (id: string) => h.app.as(owner).actor(Schedule, `${WS}:schedule:${id as ScheduleId}`);
const panel = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-plugin-panel="trigger"]');
const stateOf = (dom: ParentNode) => panel(dom)?.getAttribute('data-trigger') ?? null;
const setSelect = (el: HTMLSelectElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const setInput = (el: HTMLInputElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};

async function entries(): Promise<ScheduleView[]> {
    const { schedules } = await ws().get();
    return Promise.all(schedules.map((id) => schedule(id).get()));
}

describe('/plugins/gmail trigger (live)', () => {
    it('Turn on creates the entry that watches Gmail; the switch turns it off and back on', async () => {
        const agentId = await h.agent('Mail');
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => stateOf(dom) === 'none', 'the trigger panel');
        const p = panel(dom)!;
        expect(text(p.querySelector('[data-trigger-text]'))).toContain('Not set up');
        // An agent is required.
        buttonNamed(p, 'Turn on').click();
        await until(() => text(panel(dom)).includes('Pick the agent each new email wakes.'), 'the missing agent');

        await until(() => [...p.querySelectorAll<HTMLOptionElement>('select[name="trigger-agent"] option')].some((o) => o.value === agentId), 'the agent option');
        setSelect(p.querySelector<HTMLSelectElement>('select[name="trigger-agent"]')!, agentId);
        setInput(p.querySelector<HTMLInputElement>('input[name="trigger-query"]')!, 'is:unread label:inbox');
        setSelect(p.querySelector<HTMLSelectElement>('select[name="trigger-interval"]')!, '10');
        buttonNamed(panel(dom)!, 'Turn on').click();
        await until(() => stateOf(dom) === 'on', 'the trigger to be on');

        const [entry] = await entries();
        expect(entry).toMatchObject({ kind: 'agent-task', agentId, enabled: true, source: { kind: 'connector', connector: 'gmail', query: 'is:unread label:inbox' }, recurrence: { kind: 'cron', cron: '*/10 * * * *', tz: 'UTC' } });
        expect(entry!.title).toBe('New Gmail email → Mail');
        expect(text(panel(dom)!.querySelector('[data-trigger-text]'))).toContain('every 10 minutes');

        // Off: the entry stops polling (nothing armed).
        panel(dom)!.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => stateOf(dom) === 'off', 'the trigger to be off');
        expect(await schedule(entry!.id).get()).toMatchObject({ enabled: false, next: null });
        panel(dom)!.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => stateOf(dom) === 'on', 'the trigger back on');
        // Saving again edits the same entry, never a second one.
        buttonNamed(panel(dom)!, 'Save').click();
        await until(() => text(panel(dom)).includes('Saved.'), 'the save');
        expect(await entries()).toHaveLength(1);
    }, 30_000);

    it('an entry a poll paused says why', async () => {
        const agentId = await h.agent('Mail');
        const { scheduleId } = await ws().createSchedule();
        await schedule(scheduleId).create({ kind: 'agent-task', title: 'signed out', recurrence: { kind: 'at', at: Date.now() + 300 }, agentId, source: { kind: 'connector', connector: 'gmail' } });
        const dom = await mountLive('/plugins/gmail', h);
        await until(() => stateOf(dom) === 'paused', 'the poll to pause it');
        expect(text(panel(dom)!.querySelector('[data-trigger-text]'))).toBe(`Paused: ${REVOKED}`);
        expect(panel(dom)!.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
        // Turning it back on clears the reason.
        panel(dom)!.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => stateOf(dom) !== 'paused', 'the pause cleared');
        expect((await schedule(scheduleId).get()).paused).toBeUndefined();
    }, 30_000);
});
