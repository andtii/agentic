/**
 * Schedules, Plugins and Settings over the real wire (#145): a reminder
 * created from the page fires from the entry's own reminder (the host's
 * reminder tick on a faked clock) into the workspace Inbox; a plugin switched off names its
 * dependents before and after (AC-13 through the page); the settings form
 * round-trips through `Workspace.updateSettings`, an export lands in a fake
 * sink with its manifest, and delete-all needs the workspace's name typed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest, ScheduleId } from '@agentic/core';
import { AgentActor, Inbox, Registry, Workspace, agentKey, defineScheduleActor, defineWorkspace, inboxKey, registryKey, scheduleTrigger, workspaceKey, type ArtifactSink, type WorkspaceStore } from '@agentic/platform';
import { topbarFor } from '../../src/components/topbar';
import { newScheduleRequest } from '../../src/pages/ops/head';
import { buttonNamed, setText } from './helpers';
import { USER, WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

const github: PluginManifest = {
    id: 'github',
    version: '1.2.0',
    kind: 'connector',
    name: 'GitHub MCP',
    description: 'MCP server at api.github.com',
    capabilities: ['tools'],
    config: { type: 'object' },
    permissions: [
        { scope: 'network:api.github.com', reason: 'reach the server' },
        { scope: 'secret:github-token', reason: 'bearer token' },
        { scope: 'tools:github', reason: 'expose tools' }
    ],
    compat: { platform: '*', core: '*' }
};

const NOW = Date.parse('2026-09-18T09:59:30Z');
const TICK = 60_000;

let h: LiveHarness;
/** The app's Schedule: firings go to the platform trigger (Inbox for a reminder). The clock is read per call — the tests fake `Date`. */
const Schedule = defineScheduleActor({ trigger: scheduleTrigger(), now: () => Date.now() });
let files: Map<string, string>;
/** The fake artifact sink an export lands in. */
const sink: ArtifactSink = {
    async put(path, body) {
        files.set(path, body);
    }
};
/** The store a delete-all purges through: deactivate, then clear the record. */
const store: WorkspaceStore = {
    async purge(ref) {
        await h.app.host.deactivate(ref);
        const record = await h.app.storage.load(ref.type, ref.key);
        if (record) await h.app.storage.clear(ref.type, ref.key, record.etag);
    }
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    files = new Map();
    h = await startLive(undefined, {
        // Reminders are checked against `Date.now()` every 20 ms: a test moves the clock, the entry's own alarm does the rest.
        defaults: { reminderTickMs: 20 },
        actors: [defineWorkspace({ sink, store }), Schedule, Registry]
    });
});
afterEach(async () => {
    await h.stop();
    vi.useRealTimers();
});

const ws = () => h.app.as(owner).actor(Workspace, workspaceKey(WS));
const registry = () => h.app.as(owner).actor(Registry, registryKey(WS));
const inbox = () => h.app.as(owner).actor(Inbox, inboxKey(WS));
const select = (dom: ParentNode, name: string): HTMLSelectElement => dom.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;
const input = (dom: ParentNode, name: string): HTMLInputElement => dom.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
/** The open dialog; the live pages keep their dialogs mounted, so closed is `data-state="closed"`, not gone. */
const popup = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');

/** `ms` of clock later; the host's reminder tick and the live pushes follow on real timers. */
function advance(ms = TICK): void {
    vi.setSystemTime(Date.now() + ms);
}

describe('/schedules (live)', () => {
    it('a reminder created on the page (on the workspace clock) fires from its own reminder into the inbox; the switch pauses and resumes it', async () => {
        await ws().updateSettings({ timeZone: 'Europe/Stockholm' });
        const dom = await mountLive('/schedules', h);
        await until(() => dom.querySelector('[data-scope="empty-state"][data-part="root"]') !== null, 'the empty state');
        expect(dom.querySelector('[data-foot-note]')!.textContent).toContain('Times are Europe/Stockholm');

        // The topbar's "New schedule" raises the dialog the live page answers.
        const actions = await mountLive('/schedules', h, <div>{topbarFor({ name: 'schedules', path: '/schedules', params: {} })!.actions!()}</div>);
        buttonNamed(actions, 'New schedule').click();
        await until(() => popup(dom) !== null, 'the dialog');
        expect(newScheduleRequest.open).toBe(true);
        buttonNamed(popup(dom)!, 'Create schedule').click();
        await tick();
        expect(popup(dom)!.textContent).toContain('A title is required.');
        setText(input(popup(dom)!, 'schedule-title'), 'Tea');
        // 12:00 Stockholm is 10:00Z — thirty seconds ahead of the harness clock.
        setText(input(popup(dom)!, 'schedule-at'), '2026-09-18 12:00');
        setText(popup(dom)!.querySelector('textarea')!, 'Kettle on');
        buttonNamed(popup(dom)!, 'Create schedule').click();
        await until(() => popup(dom) === null && dom.querySelector('[data-schedule]') !== null, 'the row');

        const row = dom.querySelector<HTMLElement>('[data-schedule]')!;
        expect(row.querySelector('[data-schedule-title]')!.textContent).toBe('Tea');
        expect(texts(row.querySelectorAll('code'))).toEqual(['once', 'today 12:00']);
        expect(row.querySelector('[data-runs-on][data-platform]')!.textContent).toContain('platform');
        const [scheduleId] = (await ws().get()).schedules;
        const schedule = () => h.app.as(owner).actor(Schedule, `${WS}:schedule:${scheduleId as ScheduleId}`);
        expect((await schedule().get()).next).toBe(Date.parse('2026-09-18T10:00:00Z'));

        // Off: paused, nothing armed. On: re-armed for the same instant.
        row.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => row.querySelector('[data-next-run]')!.textContent === 'paused', 'the paused row');
        expect((await schedule().get()).enabled).toBe(false);
        row.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => row.querySelector('[data-next-run]')!.textContent === 'today 12:00', 'the resumed row');

        // The entry's own reminder delivers it — no browser call involved — and the row reads done.
        expect(await inbox().list()).toEqual([]);
        advance();
        await until(async () => (await inbox().list()).length === 1, 'the reminder in the inbox');
        const rows = await inbox().list();
        expect(rows[0]).toMatchObject({ kind: 'reminder', title: 'Tea', body: 'Kettle on', ref: { kind: 'schedule', scheduleId } });
        await until(() => row.querySelector('[data-next-run]')!.textContent === 'done', 'the delivered row');
    }, 20_000);
});

describe('/plugins (live)', () => {
    const row = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-plugin-rows] [data-plugin-row][data-plugin="${id}"]`);
    const leftLine = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-plugin-left][data-plugin="${id}"]`);

    it('AC-13: switching a plugin off lists its dependents before the confirm, and the page states what still references it after', async () => {
        await registry().register(github, { enabled: true, grant: ['network:api.github.com', 'tools:github'] });
        await registry().putConnector({ id: 'github', pluginId: 'github', transport: 'streamable-http', url: 'https://api.github.com/mcp', secrets: ['github-token'] });
        const ada = await h.agent('Ada');
        await h.app.as(owner).actor(AgentActor, agentKey(WS, ada)).update({ connectors: [{ id: 'github' }] }, 'uses github');
        const bob = await h.agent('Bob');
        await h.app.as(owner).actor(AgentActor, agentKey(WS, bob)).update({ tools: [{ name: 'github.search' }] }, 'uses a github tool');
        const { scheduleId } = await ws().createSchedule();
        await h.app.as(owner).actor(Schedule, `${WS}:schedule:${scheduleId}`).create({ kind: 'agent-task', title: 'nightly triage', prompt: 'Triage', recurrence: { kind: 'at', at: NOW + 86_400_000 }, agentId: bob });

        const dom = await mountLive('/plugins', h);
        await until(() => row(dom, 'github')?.querySelector('[data-plugin-used] [data-plugin-dependent]') != null, 'the dependents on the row');
        const control = () => row(dom, 'github')!.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(row(dom, 'github')!.querySelector('[data-plugin-row-part="name"]')!.textContent).toBe('GitHub MCP');
        expect(control().checked).toBe(true);
        // Granted short of what it declares: the row says it needs a grant, and links to its page; so does Needs attention.
        expect(row(dom, 'github')!.getAttribute('data-readiness')).toBe('needs-grant');
        expect(row(dom, 'github')!.getAttribute('href')).toBe('/plugins/github');
        expect(dom.querySelector('[data-plugin-attention] li[data-plugin="github"] a[href="/plugins/github#granted"]')).not.toBeNull();
        expect([...row(dom, 'github')!.querySelectorAll('[data-plugin-used] [data-plugin-dependent]')].map((t) => t.getAttribute('data-name'))).toEqual(['Ada', 'Bob']);
        expect(row(dom, 'github')!.querySelector('[data-plugin-schedules]')!.textContent).toBe('1 schedule');
        // Secret names, never values; connectors live in the Connectors view now.
        expect(dom.querySelector('[data-plugin-secrets]')!.textContent).toContain('No secrets stored');
        expect(dom.querySelector('[data-connector="github"]')).toBeNull();

        control().click();
        await until(() => popup(dom) !== null, 'the dependents dialog');
        const dialog = popup(dom)!;
        expect(dialog.textContent).toContain('Disable GitHub MCP?');
        expect(dialog.textContent).toContain('Depends on it · 3');
        expect(texts(dialog.querySelectorAll('[data-confirm-dependents] li'))).toEqual(['Ada — connector', 'Bob — tool', 'nightly triage — schedule via Bob']);
        // Still on while the dialog is open; the Registry has not been asked to disable anything.
        expect(control().checked).toBe(true);
        expect(await registry().isEnabled('github')).toBe(true);

        buttonNamed(dialog, 'Disable GitHub MCP').click();
        await until(() => leftLine(dom, 'github') !== null, 'the page to state what is left');
        expect(await registry().isEnabled('github')).toBe(false);
        await until(() => !control().checked, 'the switch to follow the Registry');
        expect(leftLine(dom, 'github')!.textContent).toContain('Disabled GitHub MCP. Still referenced by Ada — connector; Bob — tool; nightly triage — schedule via Bob');
        expect(leftLine(dom, 'github')!.textContent).toContain('new use is refused, running work finishes');

        // Back on: the line goes, the Registry allows new use again.
        control().click();
        await until(() => leftLine(dom, 'github') === null && control().checked, 'the plugin re-enabled');
        expect(await registry().isEnabled('github')).toBe(true);
    }, 20_000);

    it('a plugin nobody depends on switches off without a dialog', async () => {
        await registry().register({ ...github, id: 'slack', name: 'Slack' }, { enabled: true });
        const dom = await mountLive('/plugins', h);
        await until(() => row(dom, 'slack')?.querySelector('[data-plugin-row-part="dependents"] [data-plugin-none]')?.textContent === 'No dependents', 'the row');
        row(dom, 'slack')!.querySelector<HTMLInputElement>('input[role="switch"]')!.click();
        await until(() => leftLine(dom, 'slack') !== null, 'the disabled line');
        expect(popup(dom)).toBeNull();
        expect(leftLine(dom, 'slack')!.textContent).toBe('Disabled Slack. Nothing references it.');
        expect(await registry().isEnabled('slack')).toBe(false);
    }, 20_000);
});

describe('/settings (live)', () => {
    it('round-trips the settings through Workspace.updateSettings', async () => {
        const dom = await mountLive('/settings', h);
        await until(() => select(dom, 'time-zone') !== null, 'the form');
        expect(select(dom, 'time-zone').value).toBe('UTC');
        expect(input(dom, 'retention-logs').value).toBe('90');
        expect(dom.querySelector('[data-notify-row="all"] input[role="switch"]')).not.toBeNull();

        // The time-zone list is windowed (#586): its hidden select carries only the chosen zone, so pick by typeahead as a person would.
        const zoneTrigger = select(dom, 'time-zone').closest('[data-scope="select"][data-part="root"]')!.querySelector<HTMLElement>('[data-part="trigger"]')!;
        for (const key of 'Europe/Stockholm') zoneTrigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        setText(input(dom, 'retention-logs'), '14');
        setText(input(dom, 'retention-artifacts'), 'a month');
        await tick();
        expect(dom.querySelector('[data-settings-form]')!.textContent).toContain('Whole days.');
        setText(input(dom, 'retention-artifacts'), '7');
        const pushSwitch = dom.querySelector<HTMLInputElement>('[data-notify-row="all"] td:last-child input[role="switch"]')!;
        pushSwitch.click();
        // The topbar's Save submits the form by id.
        dom.querySelector<HTMLFormElement>('form#settings-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(() => dom.querySelector('[data-settings-status]')!.textContent === 'Saved.', 'the save');
        expect((await ws().get()).settings).toEqual({
            timeZone: 'Europe/Stockholm',
            notifications: { inbox: true, push: true },
            defaults: { runtime: 'anthropic-api' },
            retention: { sessionLogDays: 14, artifactDays: 7 }
        });

        // Another tab's write reaches the clean form.
        await ws().updateSettings({ retention: { artifactDays: 3 } });
        await until(() => input(dom, 'retention-artifacts').value === '3', 'the live read to refresh the draft');
        // ...but never over an edit in progress — which also ends "Saved.".
        setText(input(dom, 'retention-logs'), '21');
        await tick();
        expect(dom.querySelector('[data-settings-status]')!.textContent).toBe('');
        await ws().updateSettings({ retention: { artifactDays: 5 } });
        await until(async () => (await ws().get()).settings.retention.artifactDays === 5, 'the other tab');
        await tick(50);
        expect(input(dom, 'retention-logs').value).toBe('21');
        expect(input(dom, 'retention-artifacts').value).toBe('3');
    }, 20_000);

    it('export writes the manifest through the sink; delete-all needs the workspace name typed', async () => {
        await h.agent('Ada');
        const dom = await mountLive('/settings', h);
        await until(() => dom.querySelector('form#settings-form') !== null, 'the form');

        buttonNamed(dom, 'Export workspace').click();
        await until(() => dom.querySelector('[data-op-status="export"]')?.getAttribute('data-state') === 'done', 'the export');
        const op = (await ws().get()).ops!.export!;
        expect(dom.querySelector('[data-op-status="export"]')!.textContent).toBe(`Exported ${op.count} files under ${op.prefix} (manifest.json lists them).`);
        const manifest = JSON.parse(files.get(`${op.prefix}/manifest.json`)!) as { workspaceId: string; files: unknown[] };
        expect(manifest.workspaceId).toBe(USER);
        expect(manifest.files.length).toBe(op.count);
        expect([...files.keys()]).toContain(`${op.prefix}/agents.ndjson`);

        buttonNamed(dom, 'Delete workspace').click();
        await until(() => popup(dom) !== null, 'the delete dialog');
        expect(popup(dom)!.textContent).toContain(`Type ${USER} to confirm`);
        // The wrong name keeps the dialog open and nothing is deleted.
        setText(input(popup(dom)!, 'confirm-workspace'), 'nope');
        buttonNamed(popup(dom)!, 'Delete everything').click();
        await tick();
        expect(popup(dom)).not.toBeNull();
        expect(popup(dom)!.textContent).toContain(`Type ${USER} exactly to delete it.`);
        expect((await ws().get()).agents).toHaveLength(1);

        setText(input(popup(dom)!, 'confirm-workspace'), USER);
        buttonNamed(popup(dom)!, 'Delete everything').click();
        await until(() => popup(dom) === null, 'the dialog to close');
        await until(async () => (await ws().get()).agents.length === 0, 'the cascade');
    }, 20_000);
});
