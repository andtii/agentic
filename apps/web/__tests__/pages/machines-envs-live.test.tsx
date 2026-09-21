/**
 * Setting a machine up from its page (#239) on the live harness: a Machine
 * whose socket captures what the platform sends, so the page's
 * `putEnvironment` / `removeEnvironment` become `env.request` frames a test
 * answers the way a daemon does (`env` with the new descriptors, then
 * `env.response`). Also: the policy-off state, the sign-in command, rename,
 * remove (revoked first, #259) and `/pair`'s `--allow-root`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EnvironmentDescriptor, EnvironmentId, MachineId, MachinePolicy } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { machineHead } from '../../src/pages/machines/head';
import { allowRootCommand, callFailure, draftOf, fallbackCommand, failureField, failureText, inputOf, isAbsoluteRoot, isWithin, loginCommand, policyState, rootsOf, runtimesOf, shellArg, validateDraft, withRoot } from '../../src/pages/machines/manage';
import { pairCommands } from '../../src/pages/machines/live';
import { HISTORY_KIND_FILTERS, refOf, toneOf } from '../../src/pages/history/live';
import { WS, mountLive, owner, startLive, texts, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; op?: string; environment?: Record<string, unknown>; environmentId?: string };

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined } });

beforeEach(async () => {
    frames = [];
    h = await startLive(undefined, { actors: [Machine] });
});
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
/** What a daemon with the claude-code driver reports. */
const CLAUDE = { ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code' };
const ON: MachinePolicy = { webManaged: true, allowedRoots: ['C:\\Dev'] };

const env = (machineId: MachineId, id: string, name: string, authStatus: EnvironmentDescriptor['account']['authStatus'], cwdRoots: readonly string[] = ['C:\\Dev']): EnvironmentDescriptor => ({
    ...inMemoryEnvironment(machineId, id as EnvironmentId),
    name,
    runtime: 'claude-code',
    account: { label: name, authStatus },
    cwdRoots,
    isolation: 'config-dir'
});

async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    return { machineId, daemon, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}

const say = (daemon: { socketMessage(text: string): Promise<unknown> }, frame: Record<string, unknown>) => daemon.socketMessage(JSON.stringify({ v: V, ...frame }));
const hello = (machineId: MachineId, environments: readonly EnvironmentDescriptor[], policy?: MachinePolicy) =>
    ({ t: 'hello', machineId, daemonVersion: '0.1.0-test', os: 'windows', environments, capabilities: [CLAUDE], resume: {}, ...(policy ? { policy } : {}) });

const button = (root: ParentNode, label: string): HTMLButtonElement => {
    // Outside a dialog unless `root` is one: a closed dialog's buttons are still in the DOM.
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
/** The open dialog — closed ones stay in the DOM as `data-state=closed`. */
const popup = (): HTMLElement => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]')!;
const anyOpen = (): boolean => document.querySelector('[data-scope="dialog"][data-part="popup"][data-state="open"]') !== null;
const type = (root: ParentNode, selector: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
};
const cards = (dom: ParentNode) => [...dom.querySelectorAll<HTMLElement>('[data-scope="ag-env-card"][data-part="root"]')];
const cell = (dom: ParentNode, id: string) => dom.querySelector<HTMLElement>(`[data-env-cell][data-environment="${id}"]`);
const errorsIn = (root: ParentNode): string[] => texts(root.querySelectorAll('[data-scope="field"][data-part="error"], [role="alert"]'));

describe('/machines/:id — environments from the page (#239)', () => {
    it('adds an environment: the request goes to the daemon, the dialog waits, and the row lands signed-out with its sign-in command', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], ON));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => cards(dom).length === 1, 'the machine page');
        // Web management is on: no policy card, the Add button, and Edit / Remove on the signed-in card (no sign-in command).
        expect(dom.querySelector('[data-env-policy]')).toBeNull();
        expect(cell(dom, 'env_work')!.querySelector('[data-env-login]')).toBeNull();
        expect(texts(cell(dom, 'env_work')!.querySelectorAll('[data-env-actions] button'))).toEqual(['Edit', 'Remove']);

        button(dom, 'Add environment').click();
        await tick();
        // The allowed folder is one click away; the runtime is what the daemon reports.
        expect(texts(popup().querySelectorAll('[data-env-allowed] button'))).toEqual(['C:\\Dev']);
        expect([...popup().querySelectorAll<HTMLOptionElement>('select[name="env-runtime"] option')].map((o) => o.value).filter(Boolean)).toEqual(['claude-code']);
        type(popup(), 'input[name="env-name"]', 'client-b');
        type(popup(), 'textarea[name="env-roots"]', 'C:\\Dev\\client-b');
        button(popup(), 'Add environment').click();
        await until(() => frames.some((f) => f.t === 'env.request'), 'the env.request frame');
        const sent = frames.find((f) => f.t === 'env.request')!;
        expect(sent).toMatchObject({ op: 'put', environment: { name: 'client-b', runtime: 'claude-code', cwdRoots: ['C:\\Dev\\client-b'] } });
        // Never a profile directory, and no id: the daemon mints one.
        expect(sent.environment).not.toHaveProperty('profileDir');
        expect(sent.environment).not.toHaveProperty('id');
        await until(async () => (await m.user.envResult(sent.requestId!)).status === 'pending', 'the request stored');
        expect(popup().querySelector('button[data-loading], button[aria-busy="true"]') ?? popup().querySelector('button[disabled]')).not.toBeNull();

        // The daemon writes it and answers: the environment first (as `env`), then the result.
        const added = env(m.machineId, 'env_client_b', 'client-b', 'missing', ['C:\\Dev\\client-b']);
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'ok'), added], policy: ON });
        await say(m.daemon, { t: 'env.response', requestId: sent.requestId, result: { environmentId: 'env_client_b' } });
        await until(() => !anyOpen(), 'the dialog closed');
        await until(() => cards(dom).length === 2, 'the new row');
        expect(cards(dom).map((c) => [c.getAttribute('aria-label'), c.getAttribute('data-env-state')])).toEqual([['work', 'ready'], ['client-b', 'auth-missing']]);
        expect(cell(dom, 'env_client_b')!.querySelector('[data-env-login] code')!.textContent).toBe('agentic-daemon env login env_client_b');

        // The daemon re-inspects after the login on the machine: the row flips without a reload.
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'ok'), { ...added, account: { label: 'client-b', authStatus: 'ok' } }] });
        await until(() => cell(dom, 'env_client_b')!.querySelector('[data-env-login]') === null, 'the sign-in command gone');
        expect(cards(dom)[1]!.getAttribute('data-env-state')).toBe('ready');
    });

    it('a folder the daemon refuses shows under Working folders; one plainly outside is refused before any request', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], ON));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => cards(dom).length === 1, 'the machine page');
        button(dom, 'Add environment').click();
        await tick();
        type(popup(), 'input[name="env-name"]', 'escape');

        // Plainly outside: the page says so and sends nothing.
        type(popup(), 'textarea[name="env-roots"]', 'C:\\Windows');
        button(popup(), 'Add environment').click();
        await tick();
        expect(errorsIn(popup()).join(' ')).toContain('C:\\Windows is outside the folders this machine allows (C:\\Dev)');
        expect(frames.filter((f) => f.t === 'env.request')).toHaveLength(0);

        // Inside by spelling, outside once the daemon resolves the link: the daemon's refusal lands under the field.
        type(popup(), 'textarea[name="env-roots"]', 'C:\\Dev\\link-out');
        button(popup(), 'Add environment').click();
        await until(() => frames.some((f) => f.t === 'env.request'), 'the env.request frame');
        const sent = frames.find((f) => f.t === 'env.request')!;
        await say(m.daemon, { t: 'env.response', requestId: sent.requestId, error: { code: 'outside-allowed-roots', message: 'C:\\Dev\\link-out resolves to C:\\Windows' } });
        await until(() => errorsIn(popup()).some((e) => e.includes('outside what this machine allows')), 'the field error');
        const rootsField = popup().querySelector('textarea[name="env-roots"]')!.closest('[data-scope="field"][data-part="root"]')!;
        expect(rootsField.textContent).toContain('C:\\Dev\\link-out resolves to C:\\Windows');
        // The dialog stays open for a fix; nothing was added.
        expect(popup()).not.toBeNull();
        expect(cards(dom)).toHaveLength(1);
    });

    it('with web management off, shows the local command and no way to change environments', { timeout: 15_000 }, async () => {
        const m = await pairMachine('nuc');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'missing', ['C:\\work'])], { webManaged: false, allowedRoots: [] }));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => cards(dom).length === 1, 'the machine page');
        expect(dom.querySelector('[data-env-policy]')!.getAttribute('data-env-policy')).toBe('off');
        expect(dom.querySelector('[data-env-policy] [data-command-well] code')!.textContent).toBe('agentic-daemon policy allow-root C:\\work');
        expect([...dom.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Add environment' && !b.closest('[data-part="popup"]'))).toBe(false);
        expect(dom.querySelector('[data-env-actions]')).toBeNull();
        // Signing in is local either way: the command still shows.
        expect(cell(dom, 'env_work')!.querySelector('[data-env-login] code')!.textContent).toBe('agentic-daemon env login env_work');

        // The owner allows a folder on the machine: the daemon reports it, the page opens up without a reload.
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'missing', ['C:\\work'])], policy: { webManaged: true, allowedRoots: ['C:\\work'] } });
        await until(() => dom.querySelector('[data-env-policy]') === null, 'the policy card gone');
        expect(button(dom, 'Add environment')).toBeTruthy();
    });

    it('a daemon that reports no policy gets the "update, then allow" card', async () => {
        const m = await pairMachine('old');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')]));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-env-policy]') !== null, 'the policy card');
        expect(dom.querySelector('[data-env-policy]')!.getAttribute('data-env-policy')).toBe('unknown');
        expect(dom.querySelector('[data-env-policy]')!.textContent).toContain('Update agentic-daemon');
    });

    it('edits in place with the id, and explains a remove the daemon refuses while work runs', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'ok')], ON));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => cards(dom).length === 1, 'the machine page');

        button(cell(dom, 'env_work')!, 'Edit').click();
        await tick();
        expect(popup().querySelector<HTMLInputElement>('input[name="env-name"]')!.value).toBe('work');
        expect(popup().querySelector<HTMLTextAreaElement>('textarea[name="env-roots"]')!.value).toBe('C:\\Dev');
        type(popup(), 'textarea[name="env-roots"]', 'C:\\Dev\nC:\\Dev\\more');
        button(popup(), 'Save environment').click();
        await until(() => frames.some((f) => f.t === 'env.request'), 'the edit request');
        const edit = frames.find((f) => f.t === 'env.request')!;
        expect(edit.environment).toMatchObject({ id: 'env_work', name: 'work', cwdRoots: ['C:\\Dev', 'C:\\Dev\\more'], concurrency: 4 });
        await say(m.daemon, { t: 'env.response', requestId: edit.requestId, result: { environmentId: 'env_work' } });
        await until(() => !anyOpen(), 'the edit dialog closed');

        button(cell(dom, 'env_work')!, 'Remove').click();
        await tick();
        expect(popup().textContent).toContain('Its profile directory and sign-in stay on the machine');
        button(popup(), 'Remove work').click();
        await until(() => frames.filter((f) => f.t === 'env.request').length === 2, 'the remove request');
        const remove = frames.filter((f) => f.t === 'env.request')[1]!;
        expect(remove).toMatchObject({ op: 'remove', environmentId: 'env_work' });
        await say(m.daemon, { t: 'env.response', requestId: remove.requestId, error: { code: 'in-use', message: 'env_work has a running session' } });
        await until(() => popup()?.querySelector('[data-env-failure]') != null, 'the refusal');
        expect(popup().querySelector('[data-env-failure]')!.textContent).toBe('Work is running or queued in this environment. Let it finish or cancel it, then remove the environment.');
        expect(cards(dom)).toHaveLength(1);
    });
});

describe('/machines/:id — this machine (#239)', () => {
    it('renames the machine', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [], ON));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the machine page');
        button(dom, 'Rename').click();
        await tick();
        type(popup(), 'input[name="machine-name"]', 'workstation');
        button(popup(), 'Rename').click();
        await until(async () => (await m.user.get()).name === 'workstation', 'the record renamed');
        await until(() => dom.querySelector('[data-machine-hero] [data-machine-name]')!.textContent === 'workstation', 'the hero renamed');
    });

    it('removes the machine from the workspace — revoked first, so its token cannot reconnect (#259)', { timeout: 15_000 }, async () => {
        const m = await pairMachine('alien01');
        await say(m.daemon, hello(m.machineId, [], ON));
        const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the machine page');
        button(dom, 'Remove from workspace').click();
        await tick();
        expect(popup().textContent).toContain('Its daemon token is revoked first');
        button(popup(), 'Remove alien01').click();
        await until(async () => (await ws.listMachines()).length === 0, 'the index entry gone');
        expect((await m.user.get()).revoked).toBe(true);
        expect(await m.daemon.socketMessage(JSON.stringify(hello(m.machineId, [])))).toMatchObject({ ok: false, code: 'revoked' });
        await until(() => dom.querySelector('[data-machine-hero]') === null, 'left the machine page');
    });
});

describe('/pair — --allow-root (#239)', () => {
    it('adds the allowed folder to the pair command without minting a new code', { timeout: 15_000 }, async () => {
        const dom = await mountLive('/pair', h);
        await until(() => dom.querySelector('[data-code-cell]') !== null, 'the code');
        const code = texts(dom.querySelectorAll('[data-code-cell]')).join('');
        const pairLine = () => texts(dom.querySelectorAll('[data-command-well] code'))[2]!; // after the two install lines
        expect(pairLine()).not.toContain('--allow-root');
        type(dom, '[data-pair-allow-root] input', 'C:\\My Code');
        await until(() => pairLine().includes('--allow-root'), 'the flag');
        expect(pairLine()).toBe(`agentic-daemon pair ${code} --url ${location.origin} --name machine-1 --allow-root "C:\\My Code"`);
        await tick(20);
        expect(texts(dom.querySelectorAll('[data-code-cell]')).join('')).toBe(code);
        expect(await h.app.as(owner).actor(Workspace, workspaceKey(WS)).listMachines()).toHaveLength(1);
    });
});

describe('the machine setup model', () => {
    it('spells the local commands, quoting what needs it', () => {
        expect(loginCommand('env_work')).toBe('agentic-daemon env login env_work');
        expect(allowRootCommand('C:\\Dev')).toBe('agentic-daemon policy allow-root C:\\Dev');
        expect(allowRootCommand()).toBe('agentic-daemon policy allow-root <folder>');
        // Without the launcher (#354): the daemon is where the one-line installer put it, run through node.
        expect(fallbackCommand(allowRootCommand('/home/me/src'), 'linux')).toBe('node ~/.agentic/daemon/bin/agentic-daemon.mjs policy allow-root /home/me/src');
        expect(fallbackCommand(loginCommand('env_work'), 'darwin')).toBe('node ~/.agentic/daemon/bin/agentic-daemon.mjs env login env_work');
        // The Windows line is pasted into PowerShell (the OS whose install line the page prints is PowerShell), where %LOCALAPPDATA% does not expand.
        expect(fallbackCommand(allowRootCommand('C:\\My Code'), 'windows')).toBe('node "$env:LOCALAPPDATA\\agentic\\daemon\\bin\\agentic-daemon.mjs" policy allow-root "C:\\My Code"');
        expect(shellArg('C:\\My Code')).toBe('"C:\\My Code"');
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop', ' /home/me/src ').pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop --allow-root /home/me/src');
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop').pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop');
        // A name with a space, and the placeholder URL before the page knows its origin, stay one argument each.
        expect(pairCommands('', 'K7Q2MX', 'my laptop')).toEqual({
            install: [
                { os: 'Windows', command: "$env:AGENTIC_URL='<platform url>'; $env:AGENTIC_CODE='K7Q2MX'; $env:AGENTIC_NAME='my laptop'; irm '<platform url>/install.ps1' | iex" },
                { os: 'macOS / Linux', command: "curl -fsSL '<platform url>/install.sh' | AGENTIC_URL='<platform url>' AGENTIC_CODE='K7Q2MX' AGENTIC_NAME='my laptop' sh" }
            ],
            pair: 'agentic-daemon pair K7Q2MX --url "<platform url>" --name "my laptop"'
        });
        // A quote in a name cannot break out of either literal.
        const quoted = pairCommands('https://a.example', 'K7Q2MX', "Andy's Mac").install;
        expect(quoted[0]!.command).toContain("$env:AGENTIC_NAME='Andy''s Mac'");
        expect(quoted[1]!.command).toContain("AGENTIC_NAME='Andy'\\''s Mac'");
    });

    it('reads the policy and the runtimes a machine can host', () => {
        expect(policyState(undefined)).toBe('unknown');
        expect(policyState({ webManaged: false, allowedRoots: [] })).toBe('off');
        expect(policyState(ON)).toBe('on');
        expect(runtimesOf([{ runtime: 'claude-code' }], [])).toEqual(['claude-code']);
        expect(runtimesOf([], [env('m' as MachineId, 'e', 'e', 'ok')])).toEqual(['claude-code']);
    });

    it('checks folders segment-wise, case-folded on Windows only', () => {
        expect(isWithin('C:\\Dev\\x', 'C:\\Dev', 'windows')).toBe(true);
        expect(isWithin('c:/dev/x', 'C:\\Dev\\', 'windows')).toBe(true);
        expect(isWithin('C:\\Devtools', 'C:\\Dev', 'windows')).toBe(false);
        expect(isWithin('C:\\anything', 'C:\\', 'windows')).toBe(true);
        expect(isWithin('/home/me/src', '/home/me', 'linux')).toBe(true);
        expect(isWithin('/home/Me/src', '/home/me', 'linux')).toBe(false);
        expect(isAbsoluteRoot('\\\\server\\share', 'windows')).toBe(false);
        expect(isAbsoluteRoot('src', 'linux')).toBe(false);
        expect(rootsOf(' C:\\a \n\nC:\\a\r\nC:\\b')).toEqual(['C:\\a', 'C:\\b']);
        expect(withRoot('C:\\a', 'C:\\a')).toBe('C:\\a');
        expect(withRoot('', 'C:\\a')).toBe('C:\\a');
    });

    it('validates a draft the way the daemon will, and builds the request without a profile directory', () => {
        const base = { id: '', name: 'b', runtime: 'claude-code', roots: 'C:\\Dev\\b', concurrency: null, accountLabel: '' };
        const context = { policy: ON, os: 'windows' as const, runtimes: ['claude-code'], takenNames: ['work'] };
        expect(validateDraft(base, context)).toEqual({});
        expect(validateDraft({ ...base, name: 'Work' }, context).name).toContain('already has an environment named Work');
        expect(validateDraft({ ...base, runtime: 'codex' }, context).runtime).toContain('no codex driver');
        // An existing environment keeps its runtime: the daemon, not the page, decides about it.
        expect(validateDraft({ ...base, id: 'env_b', runtime: 'codex' }, context).runtime).toBeUndefined();
        expect(validateDraft({ ...base, roots: 'src' }, context).roots).toContain('not a full path');
        expect(validateDraft({ ...base, roots: '' }, context).roots).toContain('at least one folder');
        expect(validateDraft({ ...base, concurrency: 0 }, context).concurrency).toBeDefined();
        expect(inputOf(base)).toEqual({ name: 'b', runtime: 'claude-code', cwdRoots: ['C:\\Dev\\b'] });
        const edited = draftOf(env('m' as MachineId, 'env_w', 'work', 'ok'));
        expect(inputOf({ ...edited, accountLabel: 'Work account' })).toEqual({ id: 'env_w', name: 'work', runtime: 'claude-code', cwdRoots: ['C:\\Dev'], concurrency: 4, accountLabel: 'Work account' });
    });

    it('files the environment audit kinds under Machines, linked to the machine and toned by outcome', () => {
        expect(HISTORY_KIND_FILTERS.find((f) => f.id === 'machines')!.kinds).toEqual(['machine.paired', 'machine.revoked', 'environment.put', 'environment.removed', 'machine.update-requested', 'machine.updated', 'machine.update-failed', 'machine.channel-set', 'machine.update-policy-set']);
        const put = { key: 'k', seq: 1, at: 0, by: 'user:u', summary: '', kind: 'environment.put', data: { machineId: 'm1', environmentId: 'env_b', name: 'client-b', runtime: 'claude-code', cwdRoots: ['C:\\Dev\\b'], outcome: 'ok' } } as never;
        const refused = { key: 'k2', seq: 2, at: 0, by: 'user:u', summary: '', kind: 'environment.removed', data: { machineId: 'm1', environmentId: 'env_b', outcome: 'in-use' } } as never;
        expect(refOf(put)).toEqual({ label: 'client-b', href: '/machines/m1' });
        expect(toneOf(put)).toBe('live');
        expect(refOf(refused)).toEqual({ label: 'env_b', href: '/machines/m1' });
        expect(toneOf(refused)).toBe('failed');
    });

    it('places each refusal and says it plainly', () => {
        expect(failureField({ code: 'outside-allowed-roots', message: '' })).toBe('roots');
        expect(failureField({ code: 'unknown-runtime', message: '' })).toBe('runtime');
        expect(failureField({ code: 'in-use', message: '' })).toBeNull();
        expect(failureText({ code: 'policy-disabled', message: '' })).toContain('Turn it on there first');
        const err = (status: number, message: string) => Object.assign(new Error(message), { status });
        expect(callFailure(err(503, 'machine-offline: machine "m" is offline')).code).toBe('machine-offline');
        expect(callFailure(err(409, 'in-use: …')).code).toBe('in-use');
        expect(callFailure(err(403, 'machine "m" is revoked')).code).toBe('revoked');
        expect(callFailure(err(403, 'not the owner')).code).toBe('forbidden');
        expect(callFailure(err(400, 'machine: invalid environment: too long'))).toEqual({ code: 'invalid', message: 'too long' });
    });
});
