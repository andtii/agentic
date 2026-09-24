/**
 * Sign-in from the Machine page (#484) on the live harness: a runtime whose capability says `login: 'relay'` gets
 * **Sign in…** instead of the command well; the dialog follows the daemon's `login.status` — a link with a paste field
 * (the code goes out as `login.answer` and is kept nowhere), a device code — and closes on `done` as the row flips to
 * the account; a failure offers Try again; Cancel sends `login.cancel`; the checklist's "Signed in" step opens it. Plus
 * the pure half: which rows relay, how the phases and failures read.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { CapabilityReport, EnvironmentDescriptor, EnvironmentId, MachineId, MachinePolicy } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { machineHead } from '../../src/pages/machines/head';
import { loginCallFailure, loginErrorText, loginPhaseText, loginRelayable } from '../../src/pages/machines/login';
import { WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

type Frame = { t: string; requestId?: string; environmentId?: string; text?: string };

let h: LiveHarness;
let frames: Frame[] = [];
const Machine = defineMachineActor({ socket: { send: (_key, text) => { frames.push(JSON.parse(text) as Frame); return true; }, close: () => undefined } });

const start = async (): Promise<void> => {
    frames = [];
    h = await startLive(undefined, { actors: [Machine] });
};
afterEach(async () => {
    machineHead.value = null;
    await h.stop();
});

const V = DAEMON_PROTOCOL_VERSION;
const CLAUDE: CapabilityReport = { ...IN_MEMORY_CAPABILITIES, runtime: 'claude-code', login: 'relay' };
const CODEX: CapabilityReport = { ...IN_MEMORY_CAPABILITIES, runtime: 'codex-cli', login: 'relay' };
const OTHER: CapabilityReport = { ...IN_MEMORY_CAPABILITIES, runtime: 'other', login: 'terminal' };
const ON: MachinePolicy = { webManaged: true, allowedRoots: ['C:\\Dev'] };
const CODE = 'pasted-code-4f2a';

const env = (machineId: MachineId, id: string, name: string, runtime: string, authStatus: EnvironmentDescriptor['account']['authStatus']): EnvironmentDescriptor =>
    ({ ...inMemoryEnvironment(machineId, id as EnvironmentId), name, runtime, account: { label: name, authStatus }, cwdRoots: ['C:\\Dev'], isolation: 'config-dir' });

async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    return { machineId, daemon, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}
const say = (daemon: { socketMessage(text: string): Promise<unknown> }, frame: Record<string, unknown>) => daemon.socketMessage(JSON.stringify({ v: V, ...frame }));
const hello = (machineId: MachineId, environments: readonly EnvironmentDescriptor[], features: string[] = ['login']) =>
    ({ t: 'hello', machineId, daemonVersion: '0.1.0', os: 'windows', environments, capabilities: [CLAUDE, CODEX, OTHER], resume: {}, features, policy: ON });
const status = (daemon: { socketMessage(text: string): Promise<unknown> }, requestId: string, environmentId: string, phase: string, extra: Record<string, unknown> = {}) =>
    say(daemon, { t: 'login.status', requestId, environmentId, phase, ...extra });

const popup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const cell = (dom: ParentNode, id: string): HTMLElement => dom.querySelector<HTMLElement>(`[data-env-cell][data-environment="${id}"]`)!;
const last = (t: string): Frame => { const f = frames.filter((x) => x.t === t).at(-1); if (!f) throw new Error(`no ${t} frame`); return f; };

describe('/machines/:id — Sign in… (#484)', () => {
    it('a relayed runtime gets the button, a terminal one keeps the command; the link, the pasted code, done and the row flipping', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('alien01');
        const work = env(m.machineId, 'env_work', 'work', 'claude-code', 'missing');
        const gh = env(m.machineId, 'env_gh', 'gh', 'other', 'expired');
        await say(m.daemon, hello(m.machineId, [work, gh]));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-env-login-relay]') !== null, 'the relay row');
        expect(cell(dom, 'env_work').querySelector('[data-env-login] code')).toBeNull();
        expect(cell(dom, 'env_gh').querySelector('[data-env-login] code')!.textContent).toBe('agentic-daemon env login env_gh');
        expect(dom.querySelector('[data-setup-checklist]')!.getAttribute('data-setup-current')).toBe('signed-in');

        button(cell(dom, 'env_work'), 'Sign in…').click();
        await until(() => frames.some((f) => f.t === 'login.request'), 'the request');
        const requestId = last('login.request').requestId!;
        expect(last('login.request').environmentId).toBe('env_work');
        await until(() => popup()?.textContent?.includes('Sign work in on alien01') === true, 'the dialog');
        expect(popup()!.querySelector('[data-login-body]')!.getAttribute('data-login-phase')).toBe('started');

        await status(m.daemon, requestId, 'env_work', 'action', { action: { kind: 'open-url', url: 'https://claude.example.test/oauth?state=1', expectsPaste: true } });
        await until(() => popup()?.querySelector('[data-login-url]') !== null, 'the link');
        expect(popup()!.querySelector<HTMLAnchorElement>('[data-login-url]')!.href).toBe('https://claude.example.test/oauth?state=1');
        expect(popup()!.querySelector<HTMLAnchorElement>('[data-login-url]')!.target).toBe('_blank');
        expect(popup()!.textContent).toContain('paste the code it shows you back here');
        await status(m.daemon, requestId, 'env_work', 'waiting');
        const field = popup()!.querySelector<HTMLInputElement>('input[name="login-code"]')!;
        // Empty is refused before anything is sent: the form's `required` first, then blank space by the dialog itself.
        expect(popup()!.getAttribute('role')).not.toBe('alertdialog');
        expect(popup()!.querySelector('form[data-form-dialog]')).not.toBeNull();
        button(popup()!, 'Send code').click();
        await tick();
        expect(field.validity.valueMissing).toBe(true);
        field.value = '   ';
        field.dispatchEvent(new Event('input', { bubbles: true }));
        button(popup()!, 'Send code').click();
        await tick();
        expect(frames.filter((f) => f.t === 'login.answer')).toEqual([]);
        expect(popup()!.textContent).toContain('Paste the code the page showed you.');
        field.value = CODE;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        button(popup()!, 'Send code').click();
        await until(() => frames.some((f) => f.t === 'login.answer'), 'the answer');
        expect(last('login.answer')).toEqual({ v: 1, t: 'login.answer', requestId, text: CODE });
        expect(popup()!.textContent).toContain('Code sent');
        // The code is kept nowhere the page can read back.
        expect(JSON.stringify(await m.user.loginState('env_work' as EnvironmentId))).not.toContain(CODE);

        await status(m.daemon, requestId, 'env_work', 'done');
        await say(m.daemon, { t: 'env', environments: [env(m.machineId, 'env_work', 'work', 'claude-code', 'ok'), gh], policy: ON });
        await until(() => popup()?.textContent?.includes('Signed in.') === true, 'done');
        button(popup()!, 'Close').click();
        await until(() => popup() === null, 'closed');
        await until(() => cell(dom, 'env_work').querySelector('[data-env-login]') === null, 'the row flipped');
        expect(frames.filter((f) => f.t === 'login.cancel')).toEqual([]);
        expect(dom.querySelector('[data-setup-checklist]')!.getAttribute('data-setup-current')).not.toBe('signed-in');
    });

    it('a device code is shown large with its page; Cancel sends login.cancel; a failure offers Try again, which starts anew', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('alien02');
        const codex = env(m.machineId, 'env_codex', 'codex', 'codex-cli', 'missing');
        await say(m.daemon, hello(m.machineId, [codex]));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-env-login-relay]') !== null, 'the relay row');
        // The checklist's step opens the same dialog.
        button(dom.querySelector('[data-setup-checklist]')!, 'Show the command').click();
        await until(() => frames.some((f) => f.t === 'login.request'), 'the request');
        const first = last('login.request').requestId!;
        await status(m.daemon, first, 'env_codex', 'action', { action: { kind: 'device-code', url: 'https://auth.openai.example.test/codex/device', code: 'RGM1-ZUVN0', expectsPaste: false } });
        await status(m.daemon, first, 'env_codex', 'waiting');
        await until(() => popup()?.querySelector('[data-login-code]') !== null, 'the code');
        expect(popup()!.querySelector('[data-login-code]')!.textContent).toBe('RGM1-ZUVN0');
        expect(popup()!.querySelector<HTMLAnchorElement>('[data-login-url]')!.href).toBe('https://auth.openai.example.test/codex/device');
        expect(popup()!.querySelector('input[name="login-code"]')).toBeNull();
        expect(popup()!.textContent).toContain('Waiting for the runtime');
        button(popup()!, 'Cancel').click();
        await until(() => frames.some((f) => f.t === 'login.cancel'), 'the cancel');
        expect(last('login.cancel').requestId).toBe(first);
        await until(() => popup() === null, 'closed');
        await status(m.daemon, first, 'env_codex', 'failed', { error: { code: 'cancelled', message: 'the sign-in was cancelled' } });

        // A failed one: the reason, and Try again is a new request.
        button(cell(dom, 'env_codex'), 'Sign in…').click();
        await until(() => frames.filter((f) => f.t === 'login.request').length === 2, 'the second request');
        const second = last('login.request').requestId!;
        expect(second).not.toBe(first);
        await status(m.daemon, second, 'env_codex', 'failed', { error: { code: 'failed', message: 'the device code expired' } });
        await until(() => popup()?.querySelector('[data-env-failure]') !== null, 'the failure');
        expect(popup()!.querySelector('[data-env-failure]')!.textContent).toBe('The runtime refused the sign-in. the device code expired');
        button(popup()!, 'Try again').click();
        await until(() => frames.filter((f) => f.t === 'login.request').length === 3, 'the third request');
        expect(last('login.request').requestId).not.toBe(second);
        await until(() => popup()?.querySelector('[data-login-body]')?.getAttribute('data-login-phase') === 'started', 'started anew');
        expect(popup()!.querySelector('[data-env-failure]')).toBeNull();
    });

    it('a daemon without the feature keeps the command well for every row; a refusal before the request reads as a sentence', { timeout: 15_000 }, async () => {
        await start();
        const m = await pairMachine('alien03');
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'claude-code', 'missing')], []));
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => cell(dom, 'env_work')?.querySelector('[data-env-login] code') !== null, 'the well');
        expect(dom.querySelector('[data-env-login-relay]')).toBeNull();
        // The feature arrives with a new hello; the row offers the button — and, the daemon gone, the dialog says so.
        await say(m.daemon, hello(m.machineId, [env(m.machineId, 'env_work', 'work', 'claude-code', 'missing')]));
        await until(() => dom.querySelector('[data-env-login-relay]') !== null, 'the relay row');
        await m.daemon.socketClosed();
        await until(() => dom.querySelector('[data-machine-hero] [data-scope="badge"][data-part="root"]')?.textContent?.includes('OFFLINE') === true, 'offline');
        expect(button(cell(dom, 'env_work'), 'Sign in…').disabled).toBe(true);
    });
});

describe('the sign-in model', () => {
    it('relays only with the feature and a relay capability; reads each phase and failure', () => {
        expect(loginRelayable({ runtime: 'claude-code' }, [CLAUDE], ['login'])).toBe(true);
        expect(loginRelayable({ runtime: 'claude-code' }, [CLAUDE], ['update'])).toBe(false);
        expect(loginRelayable({ runtime: 'other' }, [OTHER], ['login'])).toBe(false);
        expect(loginRelayable({ runtime: 'claude-code' }, [{ ...CLAUDE, login: undefined }], ['login'])).toBe(false);
        expect(loginRelayable({ runtime: 'claude-code' }, undefined, ['login'])).toBe(false);
        expect(loginPhaseText(null, 'box')).toBe('Starting the sign-in on box…');
        expect(loginPhaseText({ phase: 'started' }, 'box')).toContain('starting on box');
        expect(loginPhaseText({ phase: 'action', action: { kind: 'device-code', url: 'u', code: 'C', expectsPaste: false } }, 'box')).toContain('enter this code');
        expect(loginPhaseText({ phase: 'waiting', action: { kind: 'open-url', url: 'u', expectsPaste: true } }, 'box')).toContain('paste the code');
        expect(loginPhaseText({ phase: 'waiting', action: { kind: 'open-url', url: 'u', expectsPaste: false } }, 'box')).toContain('notices on its own');
        expect(loginPhaseText({ phase: 'done' }, 'box')).toContain('Signed in');
        expect(loginPhaseText({ phase: 'failed' }, 'box')).toContain('did not complete');
        expect(loginErrorText({ code: 'busy', message: '' })).toContain('already running');
        expect(loginErrorText({ code: 'unknown-environment', message: '' })).toContain('no longer has');
        expect(loginErrorText({ code: 'unsupported', message: 'x' })).toBe('This runtime cannot be signed in from here; sign it in on the machine itself. x');
        expect(loginErrorText({ code: 'cancelled', message: '' })).toBe('The sign-in was cancelled.');
        expect(loginErrorText({ code: 'timeout', message: '' })).toContain('not completed in time');
        expect(loginErrorText({ code: 'machine-offline', message: '' })).toContain('offline');
        expect(loginErrorText({ code: 'failed', message: 'Login failed: 400' })).toBe('The runtime refused the sign-in. Login failed: 400');
        expect(loginErrorText({ code: 'internal', message: 'boom' })).toBe('boom');
        expect(loginCallFailure({ status: 503, message: 'x' })).toMatchObject({ code: 'machine-offline' });
        expect(loginCallFailure(Object.assign(new Error('a sign-in is already running for "work"'), { status: 409 }))).toMatchObject({ code: 'busy' });
        expect(loginCallFailure(Object.assign(new Error('claude-code cannot be signed in from the web on this machine'), { status: 409 }))).toMatchObject({ code: 'unsupported' });
        expect(loginCallFailure({ status: 404, message: 'x' })).toMatchObject({ code: 'unknown-environment' });
        expect(loginCallFailure(new Error('boom'))).toEqual({ code: 'internal', message: 'boom' });
    });
});
