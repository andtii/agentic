/**
 * Daemon updates from the web (#367) on the live harness: a Machine with a
 * release directory and a socket that captures what the platform sends, so
 * the card's actions become `update.request` / `update.cancel` frames a test
 * answers the way a daemon does (`update.status`, then a `hello` on the new
 * build). Also the channel and policy, the Machines list's badge and
 * "Update all", the Settings defaults, the reinstall hint, and the History
 * and Inbox rows for the new kinds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EnvironmentId, MachineId, ReleaseManifest } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { AuditActor, RELEASE_DIRECTORY_KEY, RELEASE_SOURCES, Workspace, auditKey, defineMachineActor, defineReleaseDirectory, machineKey, workspaceKey, type AuditEvent, type InboxNotification } from '@agentic/platform';
import { machineHead } from '../../src/pages/machines/head';
import { HISTORY_KIND_FILTERS, kindLabel, refOf, toneOf } from '../../src/pages/history/live';
import { rowOf } from '../../src/pages/inbox/live';
import { WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; mode?: string; target?: unknown };

const SHA = 'b'.repeat(64);
const manifest = (version: string, channel: 'stable' | 'latest'): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    notesUrl: `https://example.test/notes/${version}`,
    assets: { 'win32-x64': { url: `https://example.test/${version}/agentic-daemon-win32-x64.zip`, sha256: SHA, bytes: 100, version } },
    harnesses: {}
});
const served: Record<string, ReleaseManifest> = { [RELEASE_SOURCES.stable]: manifest('0.2.0', 'stable'), [RELEASE_SOURCES.latest]: manifest('0.3.0-main.abc1234', 'latest') };
const Releases = defineReleaseDirectory({ fetch: (async (input: RequestInfo | URL) => { const m = served[String(input)]; return m ? new Response(JSON.stringify(m)) : new Response('missing', { status: 404 }); }) as typeof fetch });

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined }, releases: () => Releases });

beforeEach(async () => {
    frames = [];
    h = await startLive(undefined, { actors: [Machine, Releases] });
    await h.app.as(owner).actor(Releases, RELEASE_DIRECTORY_KEY).refresh();
});
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
const build = (version: string) => ({ version, commit: 'abc1234def', protocol: 1, channel: 'stable', platform: 'win32-x64' });

async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0' });
    return { machineId, daemon, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}
const say = (daemon: { socketMessage(text: string): Promise<unknown> }, frame: Record<string, unknown>) => daemon.socketMessage(JSON.stringify({ v: V, ...frame }));
const hello = (machineId: MachineId, extra: Record<string, unknown> = {}) =>
    ({ t: 'hello', machineId, daemonVersion: '0.1.0', os: 'windows', environments: [inMemoryEnvironment(machineId, 'env_1' as EnvironmentId)], capabilities: [], resume: {}, build: build('0.1.0'), features: ['update'], ...extra });

const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const popup = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
const change = (root: ParentNode, selector: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
};
const card = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-update-card]');
const stateOf = (dom: ParentNode) => card(dom)?.getAttribute('data-update-state');
const phaseState = (dom: ParentNode, phase: string) => card(dom)?.querySelector(`[data-update-phase="${phase}"]`)?.getAttribute('data-phase-state');

describe('/machines/:id — the update card (#367, live)', () => {
    it('updates when idle: the request goes out, the phases follow the daemon live, and the new build lands as "Updated to"', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => stateOf(dom) === 'available', 'the card with the release');
        expect(dom.querySelector('[data-machine-caption]')!.textContent).toContain('daemon 0.1.0 · stable · abc1234');
        expect(card(dom)!.querySelector('[data-update-running]')!.textContent).toBe('Running 0.1.0 (stable, built abc1234)');
        expect(card(dom)!.querySelector('[data-update-version] span')!.textContent).toBe('0.2.0 available');
        expect(card(dom)!.querySelector<HTMLAnchorElement>('[data-update-notes]')!.href).toBe('https://example.test/notes/0.2.0');

        button(card(dom)!, 'Update when idle').click();
        await until(() => frames.some((f) => f.t === 'update.request'), 'the update.request frame');
        const sent = frames.find((f) => f.t === 'update.request')!;
        expect(sent).toMatchObject({ mode: 'drain', target: { version: '0.2.0' } });
        await until(() => stateOf(dom) === 'pending', 'the pending card');

        await say(m.daemon, { t: 'update.status', requestId: sent.requestId, phase: 'downloading', progress: { bytes: 25, total: 100 } });
        await until(() => phaseState(dom, 'downloading') === 'current', 'downloading');
        await until(() => card(dom)!.querySelector('[data-update-progress]')?.getAttribute('aria-valuenow') === '25', 'the progress bar');
        await say(m.daemon, { t: 'update.status', requestId: sent.requestId, phase: 'restarting' });
        await until(() => phaseState(dom, 'restarting') === 'current', 'restarting');
        expect(phaseState(dom, 'verifying')).toBe('done');

        // The daemon comes back on the new build: the update is judged, the card says so and offers the way back.
        await say(m.daemon, hello(m.machineId, { daemonVersion: '0.2.0', build: build('0.2.0'), lastUpdate: { from: '0.1.0', to: '0.2.0', outcome: 'applied', at: Date.now() } }));
        await until(() => stateOf(dom) === 'current', 'the updated card');
        expect(card(dom)!.querySelector('[data-update-last]')!.textContent).toMatch(/^Updated to 0\.2\.0 at /);
        button(card(dom)!, 'Roll back to 0.1.0').click();
        await until(() => frames.filter((f) => f.t === 'update.request').length === 2, 'the roll back request');
        expect(frames.filter((f) => f.t === 'update.request')[1]).toMatchObject({ target: 'previous', mode: 'drain' });
        const audit = await h.app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['machine.update-requested', 'machine.updated'] });
        expect(audit.events.map((e) => e.kind).sort()).toEqual(['machine.update-requested', 'machine.update-requested', 'machine.updated']);
    });

    it('update now confirms first, then cancel takes it back', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => stateOf(dom) === 'available', 'the card');
        button(card(dom)!, 'Update now').click();
        await tick();
        expect(popup().querySelector('[data-scope="dialog"][data-part="description"]')!.textContent).toBe('No turn is running, so nothing is interrupted.');
        expect(frames.some((f) => f.t === 'update.request')).toBe(false);
        button(popup(), 'Update now').click();
        await until(() => frames.some((f) => f.t === 'update.request'), 'the request');
        expect(frames.find((f) => f.t === 'update.request')).toMatchObject({ mode: 'now' });
        await until(() => stateOf(dom) === 'pending', 'pending');
        button(card(dom)!, 'Cancel update').click();
        await until(() => frames.some((f) => f.t === 'update.cancel'), 'the cancel');
        await until(() => stateOf(dom) === 'available', 'back to available');
        expect(card(dom)!.querySelector('[data-update-last]')!.textContent).toMatch(/was cancelled/);
    });

    it('saves the machine’s channel and policy through setChannel / setUpdatePolicy', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => stateOf(dom) === 'available', 'the card');
        change(card(dom)!, 'select[name="machine-update-channel"]', 'latest');
        change(card(dom)!, 'select[name="machine-update-policy"]', 'auto-when-idle');
        await tick();
        button(card(dom)!, 'Save update settings').click();
        await until(async () => { const u = await m.user.updateState(); return u.channel === 'latest' && u.policy.kind === 'auto-when-idle'; }, 'the stored choice');
        const u = await m.user.updateState();
        expect(u.inherited).toEqual({ channel: false, policy: false });
        // The latest channel has a newer release: the card follows the live read.
        await until(() => card(dom)!.querySelector('[data-update-follows]')!.textContent === 'Channel latest; takes updates as soon as no turn runs.', 'the follows line');
    });

    it('a daemon that predates updates shows the reinstall line; a request refused with "reinstall once" shows it too', { timeout: 15_000 }, async () => {
        const m = await pairMachine('old');
        await say(m.daemon, { t: 'hello', machineId: m.machineId, daemonVersion: '0.0.9', os: 'windows', environments: [], capabilities: [], resume: {} });
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => stateOf(dom) === 'no-feature', 'the reinstall card');
        expect(card(dom)!.querySelector('[data-update-reinstall] [data-command-well] code')!.textContent).toBe(`irm '${location.origin}/install.ps1' | iex`);
        expect(dom.querySelector('[data-machine-caption]')!.textContent).toContain('daemon 0.0.9');
    });
});

describe('/machines — badges and Update all (#367, live)', () => {
    it('badges the machine with a release, and Update all asks it after naming it', { timeout: 15_000 }, async () => {
        const a = await pairMachine('alien01');
        const b = await pairMachine('nuc-lab');
        await say(a.daemon, hello(a.machineId));
        await say(b.daemon, hello(b.machineId, { features: [] }));
        const dom = await mountLive('/machines', h);
        const badge = (id: string) => dom.querySelector(`[data-machine-group][data-machine="${id}"] .ag-update-badge`)?.textContent?.trim();
        await until(() => badge(a.machineId) === 'UPDATE AVAILABLE', 'the badge');
        await until(() => dom.querySelector('[data-update-all-text]')?.textContent === '1 machine has a daemon update waiting.', 'the Update all line');
        button(dom, 'Update all machines').click();
        await tick();
        expect(texts(popup().querySelectorAll('[data-confirm-dependents] li'))).toEqual(['alien01 · 0.1.0 → 0.2.0']);
        button(popup(), 'Update 1 when idle').click();
        await until(() => frames.some((f) => f.t === 'update.request'), 'the request');
        await until(() => dom.querySelector(`[data-update-result="${a.machineId}"]`)?.textContent === 'alien01 asked to update to 0.2.0 when idle', 'the result');
        await until(() => badge(a.machineId) === 'DRAINING', 'the draining pill');
        // nuc-lab has the release too, but cannot update itself: badged, never asked (its page offers the reinstall).
        expect(badge(b.machineId)).toBe('UPDATE AVAILABLE');
        expect(frames.filter((f) => f.t === 'update.request')).toHaveLength(1);
    });
});

describe('/settings — machine update defaults (#367, live)', () => {
    it('round-trips the default channel and policy through Workspace.updateSettings', { timeout: 15_000 }, async () => {
        const dom = await mountLive('/settings', h);
        await until(() => dom.querySelector('[data-settings-section][aria-label="Machine updates"]') !== null, 'the section');
        const section = dom.querySelector<HTMLElement>('[data-settings-section][aria-label="Machine updates"]')!;
        change(section, 'select[name="workspace-update-channel"]', 'latest');
        change(section, 'select[name="workspace-update-policy"]', 'window');
        await tick();
        change(section, 'input[name="workspace-update-cron"]', '0 2 * * 0');
        change(section, 'input[name="workspace-update-hours"]', '4');
        await tick();
        button(section, 'Save update settings').click();
        await until(() => section.querySelector('[data-update-defaults-status]')?.textContent === 'Saved.', 'saved');
        const settings = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).get()).settings;
        expect(settings.updates).toEqual({ defaultChannel: 'latest', defaultPolicy: { kind: 'window', cron: '0 2 * * 0', tz: settings.timeZone, durationMs: 4 * 3_600_000 } });
    });
});

describe('History and Inbox rows for daemon updates (#367)', () => {
    it('files every update kind under Machines, labelled, toned and linked to its machine', () => {
        const machines = HISTORY_KIND_FILTERS.find((f) => f.id === 'machines')!.kinds;
        const event = (kind: string, data: Record<string, unknown>) => ({ key: kind, seq: 1, at: 0, by: 'system:updates', summary: '', kind, data: { machineId: 'm1', ...data } }) as unknown as AuditEvent;
        const cases = [
            ['machine.update-requested', { from: '0.1.0', to: '0.2.0', mode: 'drain', by: 'user:u' }, 'update requested', 'working'],
            ['machine.updated', { from: '0.1.0', to: '0.2.0' }, 'updated', 'live'],
            ['machine.update-failed', { from: '0.1.0', to: '0.2.0', error: 'x' }, 'update failed', 'failed'],
            ['machine.channel-set', { channel: 'latest' }, 'channel set', undefined],
            ['machine.update-policy-set', { policy: null }, 'update policy set', undefined]
        ] as const;
        for (const [kind, data, label, tone] of cases) {
            const e = event(kind, data);
            expect(machines).toContain(kind);
            expect(kindLabel(e)).toBe(label);
            expect(toneOf(e)).toBe(tone);
            expect(refOf(e)).toEqual({ label: 'm1', href: '/machines/m1' });
        }
    });

    it('turns the machine notices into "Needs you" rows that link to the machine; an unrelated or read one stays out', () => {
        const n = (kind: string, extra: Partial<InboxNotification> = {}) => ({ id: `n_${kind}`, kind, title: `t ${kind}`, body: 'b', at: 1, read: false, deliveries: [], ref: { kind: 'machine', machineId: 'm1' }, ...extra }) as unknown as InboxNotification;
        for (const kind of ['update-available', 'update-applied', 'update-failed', 'daemon-crash-loop', 'harness-update-available']) {
            expect(rowOf(n(kind))).toEqual({ id: `n_${kind}`, kind: 'machine', title: `t ${kind}`, at: 1, notice: { kind, machineId: 'm1', body: 'b' }, href: '/machines/m1', hrefLabel: 'Open machine' });
        }
        expect(rowOf(n('update-available', { read: true }))).toBeNull();
        expect(rowOf(n('task-done'))).toBeNull();
        // A prototype name is not a notice kind.
        expect(rowOf(n('toString'))).toBeNull();
    });
});
