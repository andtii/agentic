/**
 * Runtimes from the web (#370) on the live harness: a Machine with a release
 * directory, an Inbox and a socket that captures what the platform sends, so
 * the card's actions become `harness.request` frames a test answers the way
 * a daemon does (`harness.status`, then a `harnesses` frame). The card shows
 * the three runtimes from `hello`, an update drains its runtime only and
 * follows the phases to the new version, Remove is refused with the reason
 * while an environment runs on the runtime, and the runtime plugin page
 * lists the machine. History and the Inbox get their rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, HarnessReport, MachineId, ReleaseManifest } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { AuditActor, RELEASE_DIRECTORY_KEY, RELEASE_SOURCES, Workspace, auditKey, defineInbox, defineMachineActor, defineReleaseDirectory, defineRegistry, freeSlots, inboxKey, machineKey, workspaceKey } from '@agentic/platform';
import { RUNTIME_PLUGINS } from '@agentic/runtimes';
import { machineHead } from '../../src/pages/machines/head';
import { kindLabel, refOf } from '../../src/pages/history/live';
import { WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; op?: string; runtime?: string; mode?: string; target?: { version: string } };

const SHA = 'c'.repeat(64);
const shipped = (versions: Record<string, string>): ReleaseManifest['harnesses'] =>
    Object.fromEntries(Object.entries(versions).map(([runtime, version]) => [runtime, { version, assets: { 'win32-x64': { url: `https://example.test/harness-${runtime}-${version}.zip`, sha256: SHA, bytes: 1000, version } } }]));
const manifest = (version: string, channel: 'stable' | 'latest'): ReleaseManifest => ({
    version,
    channel,
    publishedAt: 1_700_000_000_000,
    commit: 'abc1234',
    protocol: 1,
    assets: { 'win32-x64': { url: `https://example.test/${version}/agentic-daemon-win32-x64.zip`, sha256: SHA, bytes: 100, version } },
    harnesses: shipped({ 'claude-code': '2.1.0', 'codex-cli': '0.46.0', 'copilot-cli': '1.0.14' })
});
const served: Record<string, ReleaseManifest> = { [RELEASE_SOURCES.stable]: manifest('0.2.0', 'stable'), [RELEASE_SOURCES.latest]: manifest('0.3.0-main.abc1234', 'latest') };
const Releases = defineReleaseDirectory({ fetch: (async (input: RequestInfo | URL) => { const m = served[String(input)]; return m ? new Response(JSON.stringify(m)) : new Response('missing', { status: 404 }); }) as typeof fetch });
const Inbox = defineInbox({ channels: [] });
const Registry = defineRegistry({ catalogue: [...RUNTIME_PLUGINS] });

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined }, releases: () => Releases, inbox: () => Inbox });

beforeEach(async () => {
    frames = [];
    h = await startLive(undefined, { actors: [Machine, Releases, Inbox, Registry] });
    await h.app.as(owner).actor(Releases, RELEASE_DIRECTORY_KEY).refresh();
});
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
const CC = 'env_cc' as EnvironmentId;
const CX = 'env_codex' as EnvironmentId;
const installed: HarnessReport[] = [
    { runtime: 'claude-code', installed: { version: '2.0.0', at: 1 }, status: 'ready', current: false },
    { runtime: 'codex-cli', installed: { version: '0.46.0', at: 1 }, status: 'ready', current: true },
    { runtime: 'copilot-cli', status: 'missing' }
];

async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.2.0' });
    return { machineId, daemon, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}
const say = (daemon: { socketMessage(text: string): Promise<unknown> }, frame: Record<string, unknown>) => daemon.socketMessage(JSON.stringify({ v: V, ...frame }));
const environment = (machineId: MachineId, id: EnvironmentId, name: string, runtime: string): EnvironmentDescriptor => ({ id, machineId, name, runtime, account: { label: name, authStatus: 'ok' }, cwdRoots: ['C:\\Dev'], concurrency: { max: 2, active: 0 }, isolation: 'config-dir' });
const hello = (machineId: MachineId, extra: Record<string, unknown> = {}) => ({
    t: 'hello',
    machineId,
    daemonVersion: '0.2.0',
    os: 'windows',
    environments: [environment(machineId, CC, 'work', 'claude-code'), environment(machineId, CX, 'codex', 'codex-cli')],
    capabilities: [],
    resume: {},
    build: { version: '0.2.0', commit: 'abc1234def', protocol: 1, channel: 'stable', platform: 'win32-x64' },
    features: ['update', 'harness'],
    harnesses: installed,
    ...extra
});

const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const popup = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
const card = (dom: ParentNode) => dom.querySelector<HTMLElement>('[data-harness-card]');
const row = (dom: ParentNode, runtime: string) => card(dom)?.querySelector<HTMLElement>(`[data-harness-row="${runtime}"]`) ?? null;
const textOf = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const phaseState = (dom: ParentNode, runtime: string, phase: string) => row(dom, runtime)?.querySelector(`[data-update-phase="${phase}"]`)?.getAttribute('data-state');

describe('/machines/:id — runtimes on this machine (#370, live)', () => {
    it('shows the three runtimes from a live daemon; Update drains claude-code only, follows the phases and lands on the new version', { timeout: 20_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => card(dom)?.querySelectorAll('[data-harness-row]').length === 3, 'the three runtimes');
        expect(textOf(row(dom, 'claude-code')!.querySelector('[data-harness-version]'))).toBe('2.0.0 · 2.1.0 available');
        expect(textOf(row(dom, 'codex-cli')!.querySelector('[data-harness-version]'))).toBe('0.46.0');
        expect(textOf(row(dom, 'copilot-cli')!.querySelector('[data-harness-version]'))).toBe('not installed · 1.0.14 available');
        expect(textOf(row(dom, 'claude-code')!.querySelector('[data-harness-envs]'))).toBe('Used by work');

        button(row(dom, 'claude-code')!, 'Update…').click();
        await tick();
        expect(textOf(popup().querySelector('[data-scope="dialog"][data-part="description"]'))).toBe('No turn is running on Claude Code, so nothing is interrupted. Other runtimes keep running.');
        button(popup(), 'Update').click();
        await until(() => frames.some((f) => f.t === 'harness.request'), 'the harness.request frame');
        const sent = frames.find((f) => f.t === 'harness.request')!;
        expect(sent).toMatchObject({ op: 'update', runtime: 'claude-code', mode: 'drain', target: { version: '2.1.0' } });
        // Only claude-code drains: a codex environment still takes turns.
        const drained = await m.user.get();
        expect(freeSlots(drained, CC)).toBe(0);
        expect(freeSlots(drained, CX)).toBe(2);
        await until(() => row(dom, 'claude-code')!.querySelector('[data-harness-pending]') !== null, 'the pending row');
        expect(button(row(dom, 'copilot-cli')!, 'Install').disabled).toBe(true);

        await say(m.daemon, { t: 'harness.status', requestId: sent.requestId, phase: 'downloading' });
        await until(() => phaseState(dom, 'claude-code', 'downloading') === 'current', 'downloading');
        await say(m.daemon, { t: 'harness.status', requestId: sent.requestId, phase: 'applying' });
        await until(() => phaseState(dom, 'claude-code', 'applying') === 'current', 'applying');
        expect(phaseState(dom, 'claude-code', 'verifying')).toBe('done');

        await say(m.daemon, { t: 'harness.status', requestId: sent.requestId, phase: 'done' });
        await say(m.daemon, { t: 'harnesses', harnesses: [{ ...installed[0]!, installed: { version: '2.1.0', at: 2 }, current: true }, installed[1]!, installed[2]!] });
        await until(() => textOf(row(dom, 'claude-code')!.querySelector('[data-harness-outcome]')) === 'Claude Code was updated to 2.1.0.', 'the outcome');
        await until(() => textOf(row(dom, 'claude-code')!.querySelector('[data-harness-version]')) === '2.1.0', 'the new version');
        expect(button(row(dom, 'copilot-cli')!, 'Install').disabled).toBe(false);
        expect(freeSlots(await m.user.get(), CC)).toBe(2);

        // History: `harness.changed`, labelled and linked to the machine's runtimes card.
        await until(async () => (await h.app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['harness.changed'] })).events.length === 1, 'harness.changed');
        const [event] = (await h.app.as(owner).actor(AuditActor, auditKey(WS)).list({ kinds: ['harness.changed'] })).events;
        expect(kindLabel(event!)).toBe('harness updated');
        expect(refOf(event!)).toEqual({ label: 'claude-code', href: `/machines/${m.machineId}#runtimes` });
        // The Inbox heard of 2.1.0 once, when the daemon said hello on 2.0.0.
        const rows = (await h.app.as(owner).actor(Inbox, inboxKey(WS)).list()).filter((n) => n.kind === 'harness-update-available');
        expect(rows.map((n) => n.title)).toEqual(['claude-code 2.1.0 is available for alien01']);
    });

    it('Remove is off with the reason while an environment runs on the runtime; a refusal from the daemon shows on its row', { timeout: 20_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, { harnesses: [...installed.slice(0, 2), { runtime: 'copilot-cli', installed: { version: '1.0.14', at: 1 }, status: 'ready' }] }));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => row(dom, 'codex-cli') !== null, 'the codex row');
        expect(button(row(dom, 'codex-cli')!, 'Remove…').disabled).toBe(true);
        expect(textOf(row(dom, 'codex-cli')!.querySelector('[data-harness-remove-reason]'))).toBe('Used by codex. Remove that environment first.');

        // copilot has no environment here: Remove asks, and the daemon refuses it (an environment it knows of that the page did not).
        button(row(dom, 'copilot-cli')!, 'Remove…').click();
        await tick();
        button(popup(), 'Remove Copilot CLI').click();
        await until(() => frames.some((f) => f.t === 'harness.request'), 'the remove request');
        const sent = frames.find((f) => f.t === 'harness.request')!;
        expect(sent).toMatchObject({ op: 'remove', runtime: 'copilot-cli' });
        expect(sent.target).toBeUndefined();
        await say(m.daemon, { t: 'harness.status', requestId: sent.requestId, phase: 'failed', error: { code: 'in-use', message: 'environment spare runs on copilot-cli; remove it first' } });
        await until(() => textOf(row(dom, 'copilot-cli')!.querySelector('[data-harness-outcome]')) === 'Removing Copilot CLI did not go through: environment spare runs on copilot-cli; remove it first', 'the refusal');
        expect(row(dom, 'copilot-cli')!.querySelector('[data-harness-outcome]')!.getAttribute('role')).toBe('alert');
    });

    it('a daemon without the harness feature shows the reinstall line', { timeout: 15_000 }, async () => {
        const m = await pairMachine('old');
        await say(m.daemon, hello(m.machineId, { features: ['update'], harnesses: undefined }));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => card(dom)?.querySelector('[data-update-reinstall]') !== null && card(dom) !== null, 'the reinstall line');
        expect(card(dom)!.querySelector('[data-harness-list]')).toBeNull();
    });
});

describe('/plugins/:runtime — the machines that have it (#370, live)', () => {
    it('lists each paired machine: has it at a version, lacks it', { timeout: 15_000 }, async () => {
        const a = await pairMachine('alien01');
        await say(a.daemon, hello(a.machineId));
        const dom = await mountLive('/plugins/claude-code', h);
        await until(() => dom.querySelector(`[data-runtime-machine="${a.machineId}"]`) !== null, 'the machine row');
        const li = dom.querySelector(`[data-runtime-machine="${a.machineId}"]`)!;
        expect(li.getAttribute('data-state')).toBe('has');
        expect(textOf(li.querySelector('[data-runtime-machine-version]'))).toBe('2.0.0 · 2.1.0 available');
        expect(li.querySelector('a')!.getAttribute('href')).toBe(`/machines/${a.machineId}#runtimes`);
        const copilot = await mountLive('/plugins/copilot-cli', h);
        await until(() => copilot.querySelector(`[data-runtime-machine="${a.machineId}"]`)?.getAttribute('data-state') === 'lacks', 'copilot lacking');
    });
});
