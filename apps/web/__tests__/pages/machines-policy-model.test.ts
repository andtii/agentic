/**
 * The pure half of the folders card, the setup checklist, the browser's
 * crumbs, the restart line and the pair command's folders (#482).
 */
import { describe, it, expect } from 'vitest';
import type { EnvironmentDescriptor, MachinePolicy } from '@agentic/core';
import { browseCrumbs } from '../../src/pages/machines/BrowseDialog';
import { pairCommands } from '../../src/pages/machines/live';
import { draftOf, inputOf, policyState, turnsBypassOn } from '../../src/pages/machines/manage';
import { isHomeRoot, listingOf, logErrorText, policyCallFailure, policyCardState, policyFailureText, policyRootError, policyRootsOf, policyRows, sameRoots } from '../../src/pages/machines/policy';
import { currentStep, setupSteps, type SetupFacts } from '../../src/pages/machines/setup';
import { lastLine } from '../../src/pages/machines/update';

const HOME = 'C:\\Users\\andy';
const WEB: MachinePolicy = { webManaged: true, allowedRoots: [HOME, 'C:\\Dev'], source: 'web', requested: ['~', 'C:\\Dev'] };
const env = (authStatus: EnvironmentDescriptor['account']['authStatus'], extra: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor =>
    ({ id: 'env_1', machineId: 'm1', name: 'work', runtime: 'claude-code', account: { label: 'work', authStatus }, cwdRoots: ['C:\\Dev'], concurrency: { max: 1, active: 0 }, isolation: 'config-dir', ...extra }) as EnvironmentDescriptor;

describe('the folders card model', () => {
    it('reads the card state from the policy and the features', () => {
        expect(policyCardState(WEB, undefined)).toBe('no-feature');
        expect(policyCardState(WEB, ['update'])).toBe('no-feature');
        expect(policyCardState(WEB, ['policy'])).toBe('web');
        expect(policyCardState({ webManaged: true, allowedRoots: ['C:\\Dev'], source: 'local' }, ['policy'])).toBe('local');
        expect(policyCardState({ webManaged: true, allowedRoots: ['C:\\Dev'] }, ['policy'])).toBe('local');
        expect(policyCardState({ ...WEB, locked: true }, ['policy'])).toBe('locked');
        expect(policyCardState({ webManaged: false, allowedRoots: [] }, ['policy'])).toBe('off');
        expect(policyCardState(undefined, ['policy'])).toBe('off');
        // `policyState` (the environments' gate): locked and off is `locked`; locked and on is still `on`.
        expect(policyState({ webManaged: false, allowedRoots: [], locked: true })).toBe('locked');
        expect(policyState({ ...WEB, locked: true })).toBe('on');
    });

    it('accepts ~ forms and full paths for the machine’s OS, never a network share', () => {
        expect(isHomeRoot('~')).toBe(true);
        expect(isHomeRoot('~/src')).toBe(true);
        expect(isHomeRoot('~\\src')).toBe(true);
        expect(isHomeRoot('~src')).toBe(false);
        expect(policyRootError('~', 'windows')).toBeNull();
        expect(policyRootError(' C:\\Dev ', 'windows')).toBeNull();
        expect(policyRootError('/home/me', 'linux')).toBeNull();
        expect(policyRootError('', 'windows')).toBe('Enter a folder.');
        expect(policyRootError('\\\\nas\\share', 'windows')).toContain('network share');
        expect(policyRootError('//nas/share', 'linux')).toContain('network share');
        expect(policyRootError('src', 'windows')).toContain('src is not a full path on this machine');
        expect(policyRootError('/home/me', 'windows')).toContain('C:\\Dev');
        expect(policyRootError('C:\\Dev', 'linux')).toContain('/home/me/src');
    });

    it('starts the list from what the owner asked, else what the daemon reports; pairs each root with what it became', () => {
        expect(policyRootsOf(WEB, undefined)).toEqual(['~', 'C:\\Dev']);
        expect(policyRootsOf({ webManaged: true, allowedRoots: ['C:\\Dev'] }, undefined)).toEqual(['C:\\Dev']);
        expect(policyRootsOf(WEB, { allowedRoots: ['~'], setAt: 1, by: 'user:u1', converged: false })).toEqual(['~']);
        expect(policyRootsOf(undefined, undefined)).toEqual([]);
        expect(policyRows(['~', 'C:\\Dev', 'D:\\new'], WEB)).toEqual([{ requested: '~', resolved: HOME }, { requested: 'C:\\Dev', resolved: 'C:\\Dev' }, { requested: 'D:\\new' }]);
        // A local policy has no `requested`: a root the daemon lists is applied as itself.
        expect(policyRows(['C:\\Dev', '~'], { webManaged: true, allowedRoots: ['C:\\Dev'], source: 'local' })).toEqual([{ requested: 'C:\\Dev', resolved: 'C:\\Dev' }, { requested: '~' }]);
        expect(sameRoots(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(sameRoots(['a', 'b'], ['b', 'a'])).toBe(false);
    });

    it('says each refusal plainly', () => {
        expect(policyFailureText({ code: 'policy-locked', message: '' })).toContain('agentic-daemon policy unlock');
        expect(policyFailureText({ code: 'protected', message: 'C:\\x is the daemon\'s own' })).toBe("A folder is inside the daemon's own folders (its configuration, state or an account profile) and cannot be allowed. C:\\x is the daemon's own");
        expect(policyFailureText({ code: 'not-found', message: 'D:\\gone does not exist' })).toBe('A folder does not exist on the machine. D:\\gone does not exist');
        expect(policyFailureText({ code: 'remote-path', message: '' })).toContain('network share');
        expect(policyFailureText({ code: 'timeout', message: '' })).toContain("didn't answer in time");
        expect(policyFailureText({ code: 'machine-offline', message: '' })).toContain('offline');
        expect(policyFailureText({ code: 'unsupported', message: '' })).toContain('Update agentic-daemon');
        expect(policyFailureText({ code: 'internal', message: 'boom' })).toBe('boom');
        expect(policyCallFailure({ status: 503, message: 'x' })).toMatchObject({ code: 'machine-offline' });
        expect(policyCallFailure({ status: 409, message: 'x' })).toMatchObject({ code: 'unsupported' });
        expect(policyCallFailure(Object.assign(new Error('machine "m" is revoked'), { status: 403 }))).toMatchObject({ code: 'revoked' });
        expect(policyCallFailure(Object.assign(new Error('only the owner'), { status: 403 }))).toMatchObject({ code: 'forbidden' });
        expect(policyCallFailure(Object.assign(new Error('machine: a root is not absolute'), { status: 400 }))).toEqual({ code: 'invalid', message: 'a root is not absolute' });
        expect(logErrorText({ code: 'no-log', message: '' })).toContain('running in a terminal');
        expect(logErrorText({ code: 'io', message: 'EBUSY' })).toBe('The daemon could not read its log. EBUSY');
        expect(logErrorText({ code: 'timeout', message: '' })).toContain("didn't answer");
        expect(logErrorText({ code: 'unsupported', message: '' })).toContain('Update agentic-daemon');
        expect(logErrorText({ code: 'machine-offline', message: '' })).toContain('offline');
    });

    it('turns a machine listing into the picker’s, and a path into crumbs per OS', () => {
        expect(listingOf({ path: 'C:\\Dev', parent: 'C:\\', entries: [{ name: 'a', path: 'C:\\Dev\\a' }], truncated: true })).toEqual({ kind: 'list', path: 'C:\\Dev', parent: 'C:\\', entries: [{ name: 'a', path: 'C:\\Dev\\a' }], truncated: true });
        expect(listingOf({ path: '', entries: [], truncated: false })).toEqual({ kind: 'list', path: '', entries: [], truncated: false });
        expect(browseCrumbs('C:\\Users\\andy', 'windows')).toEqual([{ label: 'C:\\', path: 'C:\\' }, { label: 'Users', path: 'C:\\Users' }, { label: 'andy', path: 'C:\\Users\\andy' }]);
        expect(browseCrumbs('C:\\', 'windows')).toEqual([{ label: 'C:\\', path: 'C:\\' }]);
        expect(browseCrumbs('D:/scratch/x', 'windows')).toEqual([{ label: 'D:\\', path: 'D:\\' }, { label: 'scratch', path: 'D:\\scratch' }, { label: 'x', path: 'D:\\scratch\\x' }]);
        expect(browseCrumbs('/home/me', 'linux')).toEqual([{ label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'me', path: '/home/me' }]);
        expect(browseCrumbs('/', 'darwin')).toEqual([{ label: '/', path: '/' }]);
    });
});

describe('the bypass switch', () => {
    it('round-trips through the draft: on is sent, off is sent only where it was on', () => {
        const on = draftOf(env('ok', { allowBypassPermissions: true }));
        expect(on.allowBypass).toBe(true);
        expect(inputOf(on).allowBypassPermissions).toBe(true);
        expect(inputOf({ ...on, allowBypass: false }).allowBypassPermissions).toBe(false);
        const off = draftOf(env('ok'));
        expect(off.allowBypass).toBe(false);
        expect('allowBypassPermissions' in inputOf(off)).toBe(false);
        expect(inputOf({ ...off, allowBypass: true }).allowBypassPermissions).toBe(true);
        expect(turnsBypassOn({ id: 'env_1', name: 'work', runtime: 'claude-code', cwdRoots: [], allowBypassPermissions: true } as never, [env('ok')])).toBe(true);
        expect(turnsBypassOn({ id: 'env_1', name: 'work', runtime: 'claude-code', cwdRoots: [], allowBypassPermissions: true } as never, [env('ok', { allowBypassPermissions: true })])).toBe(false);
        expect(turnsBypassOn({ name: 'new', runtime: 'claude-code', cwdRoots: [] }, [])).toBe(false);
    });
});

describe('the setup checklist', () => {
    const facts = (over: Partial<SetupFacts> = {}): SetupFacts => ({ name: 'box', online: true, revoked: false, policy: 'web', webManaged: true, environments: [env('ok')], doctor: [{ ok: true }], ...over });

    it('marks the first step not done as current: pending, folders, environment, signed in, doctor, ready', () => {
        expect(currentStep(setupSteps(facts({ online: false })))).toBe('paired');
        expect(setupSteps(facts({ online: false }))[0]!.note).toContain('Waiting for the daemon');
        expect(currentStep(setupSteps(facts({ policy: 'off', webManaged: false })))).toBe('folders');
        expect(currentStep(setupSteps(facts({ policy: 'no-feature', webManaged: false })))).toBe('folders');
        expect(setupSteps(facts({ policy: 'no-feature', webManaged: false }))[1]!.note).toContain('reinstall');
        expect(setupSteps(facts({ policy: 'locked', webManaged: false }))[1]!.note).toContain('locked');
        expect(currentStep(setupSteps(facts({ environments: [] })))).toBe('environment');
        expect(currentStep(setupSteps(facts({ environments: [env('missing')] })))).toBe('signed-in');
        expect(currentStep(setupSteps(facts({ doctor: [{ ok: true }, { ok: false }] })))).toBe('ready');
        expect(setupSteps(facts({ doctor: [{ ok: true }, { ok: false }] }))[4]!.note).toBe('1 doctor check failing.');
        expect(currentStep(setupSteps(facts({ doctor: [] })))).toBe('ready');
        expect(currentStep(setupSteps(facts()))).toBeNull();
        expect(setupSteps(facts()).map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
        // Later steps are `todo`, done ones stay done whatever comes before.
        expect(setupSteps(facts({ online: false, environments: [] })).map((s) => s.state)).toEqual(['current', 'done', 'todo', 'todo', 'done']);
    });
});

describe('the restart line and the pair command', () => {
    it('reads a restart’s end as "Restarted", a failed one as a failed restart', () => {
        expect(lastLine({ requestId: 'r', from: '0.1.0', to: 'restart', outcome: 'restarted', at: Date.UTC(2026, 8, 22, 10, 0) }, 'UTC')).toBe('Restarted at 22 Sep 10:00.');
        expect(lastLine({ requestId: 'r', from: '0.1.0', to: 'restart', outcome: 'failed', at: Date.UTC(2026, 8, 22, 10, 0), error: 'busy' }, 'UTC')).toBe('The restart failed at 22 Sep 10:00: busy.');
        expect(lastLine({ requestId: 'r', from: '0.1.0', to: 'restart', outcome: 'cancelled', at: Date.UTC(2026, 8, 22, 10, 0) }, 'UTC')).toBe('The restart was cancelled at 22 Sep 10:00.');
        expect(lastLine({ requestId: 'r', from: '0.1.0', to: '0.2.0', outcome: 'applied', at: Date.UTC(2026, 8, 22, 10, 0) }, 'UTC')).toBe('Updated to 0.2.0 at 22 Sep 10:00.');
    });

    it('puts full paths on the by-hand pair command, never a ~ form', () => {
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop', ['~', 'C:\\My Code', ' ']).pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop --allow-root "C:\\My Code"');
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop', ['~']).pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop');
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop', ['/home/me/src', '/srv']).pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop --allow-root /home/me/src --allow-root /srv');
        expect(pairCommands('https://a.example', 'K7Q2MX', 'laptop').pair).toBe('agentic-daemon pair K7Q2MX --url https://a.example --name laptop');
    });
});
