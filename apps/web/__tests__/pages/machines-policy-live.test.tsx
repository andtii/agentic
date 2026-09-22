/**
 * Controlling a machine from its page on the live harness (#482): the
 * folders card over `Machine.setPolicy` / `browseMachine` / `policyResult`
 * (#480) — its states, add by path, Browse…, Save through "Confirm with
 * GitHub", the daemon's refusals as sentences — the bypass switch on the
 * environment dialog (elevated when turned on), the setup checklist, Restart…
 * (`requestRestart`, #481) and the daemon log (`logTail` / `logResult`),
 * and `/pair`'s folders preset. A Machine whose socket captures what the
 * platform sends; a test answers the way a daemon does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, MachineId, MachinePolicy } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { machineHead } from '../../src/pages/machines/head';
import { pendingKey, savePending } from '../../src/pages/machines/elevate';
import { WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; op?: string; path?: string; policy?: { allowedRoots: string[] }; lines?: number; target?: string; mode?: string; environment?: Record<string, unknown> };

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined } });

const start = async (elevated = false): Promise<void> => {
    frames = [];
    sessionStorage.clear();
    h = await startLive(undefined, { actors: [Machine], elevated });
};
afterEach(async () => {
    machineHead.value = null;
    sessionStorage.clear();
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
const HOME = 'C:\\Users\\andy';
const WEB: MachinePolicy = { webManaged: true, allowedRoots: [HOME, 'C:\\Dev'], source: 'web', requested: ['~', 'C:\\Dev'] };
const build = { version: '0.1.0', commit: 'abc1234def', protocol: 1, channel: 'stable', platform: 'win32-x64' };

const env = (machineId: MachineId, id: string, name: string, authStatus: EnvironmentDescriptor['account']['authStatus'], extra: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
    ...inMemoryEnvironment(machineId, id as EnvironmentId),
    name,
    runtime: 'claude-code',
    account: { label: name, authStatus },
    cwdRoots: ['C:\\Dev'],
    isolation: 'config-dir',
    ...extra
});

async function pairMachine(name: string, allowedRoots?: string[]) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name, ...(allowedRoots ? { allowedRoots } : {}) });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    return { machineId, daemon, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}

const say = (daemon: { socketMessage(text: string): Promise<unknown> }, frame: Record<string, unknown>) => daemon.socketMessage(JSON.stringify({ v: V, ...frame }));
const hello = (machineId: MachineId, environments: readonly EnvironmentDescriptor[], policy: MachinePolicy | undefined, features: string[] = ['update', 'policy', 'log']) =>
    ({ t: 'hello', machineId, daemonVersion: '0.1.0', os: 'windows', environments, capabilities: [], resume: {}, build, features, ...(policy ? { policy } : {}) });

const popup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const type = (root: ParentNode, selector: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
};
const card = (dom: ParentNode): HTMLElement => dom.querySelector<HTMLElement>('[data-policy-card]')!;
const rows = (dom: ParentNode): string[] => [...card(dom).querySelectorAll('[data-policy-root]')].map((r) => r.getAttribute('data-policy-root')!);
/** A row by its root (an attribute selector would take the backslashes for CSS escapes). */
const row = (dom: ParentNode, root: string): HTMLElement => { const r = [...card(dom).querySelectorAll<HTMLElement>('[data-policy-root]')].find((x) => x.getAttribute('data-policy-root') === root); if (!r) throw new Error(`no row ${root}`); return r; };
const remove = (dom: ParentNode, root: string): void => { row(dom, root).querySelector('button')!.click(); };
const current = (dom: ParentNode): string | null => dom.querySelector('[data-setup-checklist]')?.getAttribute('aria-current') ?? null;
const last = (t: string): Frame => { const f = frames.filter((x) => x.t === t).at(-1); if (!f) throw new Error(`no ${t} frame`); return f; };

describe('/machines/:id — the folders the web may use (#482)', () => {
    it('lists the roots as asked beside what the daemon made of them; add validates the path; Save is refused without elevation and the dialog keeps the draft', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], WEB));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-policy-card]') !== null, 'the folders card');
        expect(card(dom).getAttribute('data-policy-state')).toBe('web');
        expect(rows(dom)).toEqual(['~', 'C:\\Dev']);
        expect(row(dom, '~').querySelector('[data-policy-resolved]')!.textContent).toBe(`→ ${HOME}`);
        expect(row(dom, 'C:\\Dev').querySelector('[data-policy-resolved]')).toBeNull();
        expect(dom.querySelector('[data-env-policy]')).toBeNull();
        expect(button(card(dom), 'Save folders').disabled).toBe(true);

        // A relative path is refused before anything is sent; a full one joins the list and makes it dirty.
        type(card(dom), 'input[name="policy-root"]', 'src');
        button(card(dom), 'Add').click();
        await tick();
        expect(card(dom).textContent).toContain('src is not a full path on this machine');
        expect(rows(dom)).toEqual(['~', 'C:\\Dev']);
        type(card(dom), 'input[name="policy-root"]', 'D:\\scratch');
        button(card(dom), 'Add').click();
        await tick();
        expect(rows(dom)).toEqual(['~', 'C:\\Dev', 'D:\\scratch']);
        expect(row(dom, 'D:\\scratch').querySelector('[data-policy-pending]')!.textContent).toBe('not applied yet');
        expect(card(dom).hasAttribute('data-dirty')).toBe(true);
        remove(dom, 'C:\\Dev');
        await tick();
        expect(rows(dom)).toEqual(['~', 'D:\\scratch']);

        // Save: the platform wants elevation; nothing was sent, the dialog names the change, Continue keeps the list.
        button(card(dom), 'Save folders').click();
        await until(() => popup()?.textContent?.includes('Confirm with GitHub to continue') === true, 'the elevate dialog');
        expect(popup()!.textContent).toContain('To change the folders the web may use on alien01');
        expect(frames.filter((f) => f.t === 'policy.request')).toEqual([]);
        button(popup()!, 'Continue to GitHub').click();
        await tick();
        expect(JSON.parse(sessionStorage.getItem(pendingKey(m.machineId))!)).toMatchObject({ kind: 'policy', draft: { allowedRoots: ['~', 'D:\\scratch'] } });
    });

    it('back from GitHub: Confirm sends setPolicy; the daemon’s refusal reads as a sentence, its answer as applied', { timeout: 15_000 }, async () => {
        await start(true);
        const m = await pairMachine('alien02');
        await say(m.daemon, hello(m.machineId, [], WEB));
        savePending(sessionStorage, m.machineId, { kind: 'policy', draft: { allowedRoots: ['~', 'C:\\agentic\\daemon'] } });
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => popup()?.textContent?.includes('Confirmed — apply the change?') === true, 'the resume dialog');
        expect(popup()!.textContent).toContain('Confirm to change the folders the web may use on alien02 now');
        expect(rows(dom)).toEqual(['~', 'C:\\Dev']);
        button(popup()!, 'Confirm').click();
        await until(() => frames.some((f) => f.t === 'policy.request'), 'the request');
        expect(rows(dom)).toEqual(['~', 'C:\\agentic\\daemon']);
        const sent = last('policy.request');
        expect(sent).toMatchObject({ op: 'set', policy: { allowedRoots: ['~', 'C:\\agentic\\daemon'] } });
        expect((await m.user.get()).policyDesired).toMatchObject({ allowedRoots: ['~', 'C:\\agentic\\daemon'], converged: false });
        await say(m.daemon, { t: 'policy.response', requestId: sent.requestId, error: { code: 'protected', message: 'C:\\agentic\\daemon is inside the daemon\'s own folder' } });
        await until(() => card(dom).querySelector('[data-policy-failure]') !== null, 'the refusal');
        expect(card(dom).querySelector('[data-policy-failure]')!.textContent).toBe("A folder is inside the daemon's own folders (its configuration, state or an account profile) and cannot be allowed. C:\\agentic\\daemon is inside the daemon's own folder");
        expect(card(dom).querySelector('[data-policy-waiting]')!.textContent).toContain('Waiting for the machine');

        // Fixed and saved again (the tab is elevated: no dialog): the daemon applies it and reports the new policy.
        remove(dom, 'C:\\agentic\\daemon');
        await tick();
        button(card(dom), 'Save folders').click();
        await until(() => frames.filter((f) => f.t === 'policy.request').length === 2, 'the second request');
        const again = last('policy.request');
        expect(again.policy).toEqual({ allowedRoots: ['~'] });
        const applied: MachinePolicy = { webManaged: true, allowedRoots: [HOME], source: 'web', requested: ['~'] };
        await say(m.daemon, { t: 'env', environments: [], policy: applied });
        await say(m.daemon, { t: 'policy.response', requestId: again.requestId, result: { policy: applied } });
        await until(() => card(dom).querySelector('[data-policy-notice]') !== null, 'applied');
        expect(card(dom).querySelector('[data-policy-notice]')!.textContent).toBe('Applied on the machine.');
        expect(card(dom).querySelector('[data-policy-failure]')).toBeNull();
        expect(card(dom).querySelector('[data-policy-waiting]')).toBeNull();
        expect(rows(dom)).toEqual(['~']);
        expect(card(dom).hasAttribute('data-dirty')).toBe(false);
    });

    it('locked is read-only with the unlock command; off says nothing is allowed; a daemon without the feature keeps the local well', { timeout: 15_000 }, async () => {
        await start(true);
        const m = await pairMachine('alien03');
        await say(m.daemon, hello(m.machineId, [], { ...WEB, locked: true }));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-policy-card]') !== null, 'the folders card');
        expect(card(dom).getAttribute('data-policy-state')).toBe('locked');
        expect(card(dom).textContent).toContain('Locked on alien03');
        expect(card(dom).querySelector('[data-command-well] code')!.textContent).toBe('agentic-daemon policy unlock');
        expect(card(dom).querySelector('input[name="policy-root"]')).toBeNull();
        expect([...card(dom).querySelectorAll('button')].map((b) => b.textContent?.trim())).not.toContain('Save folders');
        // Locked but on: environments are still managed from here.
        expect(button(dom, 'Add environment')).toBeTruthy();

        await say(m.daemon, { t: 'env', environments: [], policy: { webManaged: false, allowedRoots: [], source: 'local' } });
        await until(() => card(dom).getAttribute('data-policy-state') === 'off', 'off');
        expect(card(dom).textContent).toContain('Nothing allowed yet');
        expect(rows(dom)).toEqual([]);
        expect(current(dom)).toBe('folders');

        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok', { cwdRoots: ['C:\\work'] })], { webManaged: false, allowedRoots: [] }, ['update']));
        await until(() => card(dom).getAttribute('data-policy-state') === 'no-feature', 'no feature');
        expect(dom.querySelector('[data-env-policy]')!.getAttribute('data-env-policy')).toBe('off');
        expect(dom.querySelector('[data-env-policy] [data-command-well] code')!.textContent).toBe('agentic-daemon policy allow-root C:\\work');
    });

    it('Browse… lists the machine’s roots, then a folder, and "Allow this folder" adds it to the list', { timeout: 15_000 }, async () => {
        await start(true);
        const m = await pairMachine('alien04');
        await say(m.daemon, hello(m.machineId, [], WEB));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-policy-card]') !== null, 'the folders card');
        button(card(dom), 'Browse…').click();
        await until(() => frames.some((f) => f.t === 'policy.request' && f.op === 'browse'), 'the roots request');
        expect(last('policy.request').path).toBeUndefined();
        expect(popup()?.textContent).toContain('Choose a folder on alien04');
        await say(m.daemon, { t: 'policy.response', requestId: last('policy.request').requestId, result: { listing: { path: '', entries: [{ name: 'C:\\', path: 'C:\\' }, { name: 'Home', path: HOME }], truncated: false } } });
        await until(() => popup()?.querySelector('[data-part="shortcut"]') !== null, 'the roots');
        expect(texts(popup()!.querySelectorAll('[data-part="shortcut"]'))).toEqual(['C:\\', `Home — ${HOME}`]);
        expect(button(popup()!, 'Allow this folder').disabled).toBe(true);

        popup()!.querySelectorAll<HTMLButtonElement>('[data-part="shortcut"]')[1]!.click();
        await until(() => frames.filter((f) => f.t === 'policy.request').length === 2, 'the folder request');
        expect(last('policy.request')).toMatchObject({ op: 'browse', path: HOME });
        await say(m.daemon, { t: 'policy.response', requestId: last('policy.request').requestId, result: { listing: { path: HOME, parent: 'C:\\Users', entries: [{ name: 'src', path: `${HOME}\\src` }], truncated: false } } });
        await until(() => popup()?.querySelector('[data-part="item"]') !== null, 'the listing');
        expect(texts(popup()!.querySelectorAll('[data-part="crumb"]'))).toEqual(['alien04', 'C:\\', 'Users', 'andy']);
        expect(button(popup()!, 'Allow this folder').disabled).toBe(false);
        button(popup()!, 'Allow this folder').click();
        await until(() => popup() === null, 'closed');
        expect(rows(dom)).toEqual(['~', 'C:\\Dev', HOME]);
        expect(card(dom).hasAttribute('data-dirty')).toBe(true);
        expect(frames.filter((f) => f.op === 'set')).toEqual([]);
    });

    it('the bypass switch: turning it on asks for elevation, and the request carries the flag once confirmed', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('alien05');
        const work = env(m.machineId, 'env_work', 'work', 'ok');
        await say(m.daemon, hello(m.machineId, [work], WEB));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-env-actions]') !== null, 'the actions');
        button(dom.querySelector('[data-env-cell][data-environment="env_work"]')!, 'Edit').click();
        await until(() => popup() !== null, 'the dialog');
        const sw = popup()!.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(sw.checked).toBe(false);
        sw.click();
        await tick();
        button(popup()!, 'Save environment').click();
        await until(() => popup()?.textContent?.includes('Confirm with GitHub to continue') === true, 'the elevate dialog');
        expect(popup()!.textContent).toContain('To change an environment on alien05');
        expect(document.querySelectorAll('[data-scope="dialog"][data-part="popup"][data-state="open"]')).toHaveLength(1);
        expect(frames.filter((f) => f.t === 'env.request')).toEqual([]);
        button(popup()!, 'Continue to GitHub').click();
        await tick();
        expect(JSON.parse(sessionStorage.getItem(pendingKey(m.machineId))!)).toMatchObject({ kind: 'environment', draft: { id: 'env_work', name: 'work', allowBypassPermissions: true } });
    });

    it('back from GitHub, Confirm sends the environment with bypass on; turning it off never needs elevation', { timeout: 15_000 }, async () => {
        await start(true);
        const m2 = await pairMachine('alien06');
        await say(m2.daemon, hello(m2.machineId, [env(m2.machineId, 'env_work', 'work', 'ok')], WEB));
        savePending(sessionStorage, m2.machineId, { kind: 'environment', draft: { id: 'env_work', name: 'work', runtime: 'claude-code', cwdRoots: ['C:\\Dev'], allowBypassPermissions: true } });
        const dom = await mountLive(`/machines/${m2.machineId}`, h);
        await until(() => popup()?.textContent?.includes('Confirmed — apply the change?') === true, 'the resume dialog');
        button(popup()!, 'Confirm').click();
        await until(() => frames.some((f) => f.t === 'env.request'), 'the request');
        expect(last('env.request').environment).toMatchObject({ id: 'env_work', allowBypassPermissions: true });

        // Off: a plain owner (the harness is elevated here, but the platform would not ask either) — the flag goes as an explicit false.
        await say(m2.daemon, { t: 'env.response', requestId: last('env.request').requestId, result: { environmentId: 'env_work' } });
        await say(m2.daemon, { t: 'env', environments: [env(m2.machineId, 'env_work', 'work', 'ok', { allowBypassPermissions: true })], policy: WEB });
        await until(() => popup() === null, 'closed');
        await until(async () => (await m2.user.get()).environments[0]?.allowBypassPermissions === true, 'the flag on the record');
        await tick(50);
        button(dom.querySelector('[data-env-cell][data-environment="env_work"]')!, 'Edit').click();
        await until(() => popup() !== null, 'the dialog');
        const sw = popup()!.querySelector<HTMLInputElement>('input[role="switch"]')!;
        expect(sw.checked).toBe(true);
        sw.click();
        await tick();
        button(popup()!, 'Save environment').click();
        await until(() => frames.filter((f) => f.t === 'env.request').length === 2, 'the second request');
        expect(last('env.request').environment).toMatchObject({ id: 'env_work', allowBypassPermissions: false });
    });
});

describe('/machines/:id — the setup checklist, Restart… and the daemon log (#482)', () => {
    it('marks the current step: pending, folders, environment, signed in, doctor, ready', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('box');
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-setup-checklist]') !== null, 'the checklist');
        expect(current(dom)).toBe('paired');
        expect(dom.querySelector('[data-setup-step="paired"]')!.textContent).toContain('Waiting for the daemon to connect');
        await say(m.daemon, hello(m.machineId, [], { webManaged: false, allowedRoots: [] }));
        await until(() => current(dom) === 'folders', 'folders');
        await say(m.daemon, { t: 'env', environments: [], policy: WEB });
        await until(() => current(dom) === 'environment', 'environment');
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'missing')], policy: WEB });
        await until(() => current(dom) === 'signed-in', 'signed in');
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'ok')], policy: WEB });
        await until(() => current(dom) === 'ready', 'ready');
        expect(dom.querySelector('[data-setup-step="ready"]')!.textContent).toContain('doctor');
        expect(dom.querySelector('[data-setup-complete]')).toBeNull();
        // The current step's action: "Add environment" opens the dialog once an environment is the step.
        await say(m.daemon, { t: 'env', environments: [], policy: WEB });
        await until(() => current(dom) === 'environment', 'environment again');
        button(dom.querySelector('[data-setup-checklist]')!, 'Add environment').click();
        await until(() => popup()?.textContent?.includes('Add environment') === true, 'the dialog');
    });

    it('Restart… confirms with the impact, sends update.request target restart, and the next hello reads "Restarted"', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('box2');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], WEB));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => [...dom.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Restart…'), 'the button');
        button(dom, 'Restart…').click();
        await until(() => popup()?.textContent?.includes('Restart the daemon on box2?') === true, 'the confirm');
        expect(popup()!.textContent).toContain('No turn is running, so nothing is interrupted.');
        const mode = popup()!.querySelector<HTMLSelectElement>('select[name="restart-mode"]')!;
        mode.value = 'now';
        mode.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        button(popup()!, 'Restart').click();
        await until(() => frames.some((f) => f.t === 'update.request'), 'the request');
        expect(last('update.request')).toMatchObject({ target: 'restart', mode: 'now' });
        await until(() => dom.querySelector('[data-machine-restart]') !== null, 'the pending line');
        expect(dom.querySelector('[data-machine-restart]')!.textContent).toContain('Restarting now');
        expect(button(dom, 'Restart…').disabled).toBe(true);
        expect(dom.querySelector('[data-update-pending]')!.textContent).toContain('Restarting (now)');

        await say(m.daemon, { t: 'update.status', requestId: last('update.request').requestId, phase: 'restarting' });
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], WEB));
        await until(() => dom.querySelector('[data-update-last]') !== null, 'the last line');
        expect(dom.querySelector('[data-update-last]')!.textContent).toMatch(/^Restarted at /);
        expect(dom.querySelector('[data-update-last]')!.getAttribute('data-tone')).toBeNull();
        expect(dom.querySelector('[data-machine-restart]')).toBeNull();
    });

    it('the daemon log: opening the disclosure asks for the tail, Refresh asks again, no-log is explained', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('box3');
        await say(m.daemon, hello(m.machineId, [], WEB));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-daemon-log]') !== null, 'the disclosure');
        const details = dom.querySelector<HTMLDetailsElement>('[data-daemon-log]')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        await until(() => frames.some((f) => f.t === 'log.request'), 'the request');
        expect(last('log.request').lines).toBe(200);
        await say(m.daemon, { t: 'log.response', requestId: last('log.request').requestId, result: { lines: ['{"msg":"daemon: started"}', '{"msg":"welcome"}'], truncated: true } });
        await until(() => dom.querySelector('[data-daemon-log-lines]') !== null, 'the lines');
        expect(dom.querySelector('[data-daemon-log-lines]')!.textContent).toBe('{"msg":"daemon: started"}\n{"msg":"welcome"}');
        expect(details.textContent).toContain('The last 2 lines — the file holds more');

        button(details, 'Refresh').click();
        await until(() => frames.filter((f) => f.t === 'log.request').length === 2, 'the second request');
        await say(m.daemon, { t: 'log.response', requestId: last('log.request').requestId, error: { code: 'no-log', message: 'foreground run' } });
        await until(() => details.querySelector('[data-env-failure]') !== null, 'the explanation');
        expect(details.querySelector('[data-env-failure]')!.textContent).toContain('running in a terminal');
        expect(dom.querySelector('[data-daemon-log-lines]')).toBeNull();
    });
});

describe('/pair — the folders the web may use (#482)', () => {
    it('sends ~ by default, re-mints when the folders change, and keeps --allow-root for a full path', { timeout: 15_000 }, async () => {
        await start();
        const dom = await mountLive('/pair', h);
        await until(() => dom.querySelector('[data-code-cell]') !== null, 'the code');
        const code = () => texts(dom.querySelectorAll('[data-code-cell]')).join('');
        const pairLine = () => texts(dom.querySelectorAll('[data-command-well] code'))[2]!; // after the two install lines
        const first = code();
        expect(dom.querySelector<HTMLTextAreaElement>('[data-pair-folders] textarea')!.value).toBe('~');
        expect(pairLine()).not.toContain('--allow-root');

        type(dom, '[data-pair-folders] textarea', '~\nC:\\My Code');
        await until(() => code() !== first, 'a fresh code');
        expect(pairLine()).toBe(`agentic-daemon pair ${code()} --url ${location.origin} --name machine-1 --allow-root "C:\\My Code"`);
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        expect(await ws.listMachines()).toHaveLength(2);

        // The daemon redeems the latest code: the preset is the machine's desired policy, reconciled on its first hello.
        const { id: machineId } = (await ws.listMachines()).at(-1)!;
        const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
        await daemon.pair(code(), { name: 'machine-1', os: 'windows', daemonVersion: '0.1.0-test' });
        expect((await h.app.as(owner).actor(Machine, machineKey(WS, machineId)).get()).policyDesired).toMatchObject({ allowedRoots: ['~', 'C:\\My Code'], by: 'user:u_live' });
        await say(daemon, hello(machineId, [], { webManaged: false, allowedRoots: [] }));
        expect(last('policy.request')).toMatchObject({ op: 'set', policy: { allowedRoots: ['~', 'C:\\My Code'] } });
    });
});
