import type { AuthStatus, EnvironmentId, MachineId } from '../src/index';
import { accountDirectory, accountKeyFor, accountKeyOf, accountRefOf, environmentsForAccount, parseAccountKey, sameAccount } from '../src/index';

const env = (id: string, label: string, identity?: string, authStatus: AuthStatus = 'ok', runtime = 'claude-code') => ({
    id: id as EnvironmentId,
    name: id,
    runtime,
    account: { label, authStatus, ...(identity !== undefined ? { identity } : {}) }
});
const machine = (machineId: string, environments: ReturnType<typeof env>[]) => ({ machineId: machineId as MachineId, environments });

describe('accountRefOf / accountKeyOf', () => {
    it('prefers the identity over the label, lower-cased in the key', () => {
        expect(accountRefOf(env('env_work', 'work', 'Me@Work.example'))).toEqual({ identity: 'Me@Work.example' });
        expect(accountKeyOf(env('env_work', 'work', 'Me@Work.example'))).toBe('claude-code|id:me@work.example');
    });
    it('falls back to the label, kept exact, when no identity is reported', () => {
        expect(accountRefOf(env('env_work', 'Work'))).toEqual({ label: 'Work' });
        expect(accountKeyOf(env('env_work', 'Work'))).toBe('claude-code|label:Work');
        expect(accountKeyOf(env('env_work', 'Work', '   '))).toBe('claude-code|label:Work');
    });
    it('keys carry the runtime, so the same email on two runtimes is two accounts', () => {
        expect(accountKeyOf(env('a', 'x', 'me@x', 'ok', 'claude-code'))).not.toBe(accountKeyOf(env('a', 'x', 'me@x', 'ok', 'codex-cli')));
    });
    it('accountKeyFor refuses an empty ref', () => {
        expect(() => accountKeyFor('claude-code', {})).toThrow(/identity or a label/);
        expect(() => accountKeyFor('claude-code', { label: '' })).toThrow();
    });
});

describe('parseAccountKey', () => {
    it('round-trips both kinds of key', () => {
        expect(parseAccountKey('claude-code|id:me@work')).toEqual({ runtime: 'claude-code', ref: { identity: 'me@work' } });
        expect(parseAccountKey('claude-code|label:Work')).toEqual({ runtime: 'claude-code', ref: { label: 'Work' } });
        expect(parseAccountKey(accountKeyFor('codex-cli', { identity: 'A@B' }))).toEqual({ runtime: 'codex-cli', ref: { identity: 'a@b' } });
    });
    it('is null for anything else', () => {
        for (const bad of ['', 'claude-code', '|id:x', 'claude-code|', 'claude-code|id:', 'claude-code|label:', 'claude-code|name:x']) expect(parseAccountKey(bad)).toBeNull();
    });
});

describe('sameAccount', () => {
    it('matches identities case-insensitively and labels exactly', () => {
        expect(sameAccount({ identity: 'Me@Work' }, { identity: 'me@work' })).toBe(true);
        expect(sameAccount({ label: 'Work' }, { label: 'Work' })).toBe(true);
        expect(sameAccount({ label: 'Work' }, { label: 'work' })).toBe(false);
    });
    it('never matches an identity against a label, nor empty refs', () => {
        expect(sameAccount({ identity: 'work' }, { label: 'work' })).toBe(false);
        expect(sameAccount({ label: 'work' }, { identity: 'work' })).toBe(false);
        expect(sameAccount({}, {})).toBe(false);
        expect(sameAccount({ label: '' }, { label: '' })).toBe(false);
    });
    it('an identity on one side wins over a label on both', () => {
        expect(sameAccount({ identity: 'me@work', label: 'work' }, { label: 'work' })).toBe(false);
        expect(sameAccount({ identity: 'me@work', label: 'work' }, { identity: 'ME@WORK', label: 'other' })).toBe(true);
    });
});

describe('environmentsForAccount', () => {
    const envs = [env('env_b', 'work', 'me@work', 'missing'), env('env_a', 'work', 'me@work'), env('env_home', 'home', 'me@home'), env('env_x', 'work', 'me@work', 'ok', 'codex-cli')];
    it('keeps the runtime and the account, signed-in first then by name', () => {
        expect(environmentsForAccount(envs, 'claude-code', { identity: 'ME@work' }).map((e) => e.id)).toEqual(['env_a', 'env_b']);
        expect(environmentsForAccount(envs, 'claude-code', { identity: 'me@home' }).map((e) => e.id)).toEqual(['env_home']);
        expect(environmentsForAccount(envs, 'codex-cli', { identity: 'me@work' }).map((e) => e.id)).toEqual(['env_x']);
    });
    it('a label-bound ref matches only environments that report no identity', () => {
        expect(environmentsForAccount(envs, 'claude-code', { label: 'work' })).toEqual([]);
        expect(environmentsForAccount([env('env_l', 'work')], 'claude-code', { label: 'work' }).map((e) => e.id)).toEqual(['env_l']);
    });
});

describe('accountDirectory', () => {
    it('groups the same identity on two machines into one account with two environments, colliding ids and all', () => {
        const dir = accountDirectory([machine('mac', [env('env_work', 'work', 'me@work'), env('env_home', 'home', 'me@home')]), machine('pc', [env('env_work', 'work', 'me@work', 'expired')])]);
        expect(dir.map((a) => a.key)).toEqual(['claude-code|id:me@work', 'claude-code|id:me@home']);
        expect(dir[0]).toEqual({
            key: 'claude-code|id:me@work',
            runtime: 'claude-code',
            ref: { identity: 'me@work' },
            label: 'work',
            identity: 'me@work',
            environments: [
                { machineId: 'mac', environmentId: 'env_work', authStatus: 'ok' },
                { machineId: 'pc', environmentId: 'env_work', authStatus: 'expired' }
            ]
        });
        expect(dir[1]!.environments).toEqual([{ machineId: 'mac', environmentId: 'env_home', authStatus: 'ok' }]);
    });
    it('tells two logins apart although both machines report the same environment id', () => {
        const dir = accountDirectory([machine('mac', [env('env_work', 'work', 'me@a')]), machine('pc', [env('env_work', 'work', 'me@b')])]);
        expect(dir.map((a) => [a.key, a.environments.map((e) => e.machineId)])).toEqual([
            ['claude-code|id:me@a', ['mac']],
            ['claude-code|id:me@b', ['pc']]
        ]);
    });
    it('an environment without an identity is its own label-keyed account, without an identity field', () => {
        const [only] = accountDirectory([machine('mac', [env('env_new', 'fresh', undefined, 'missing')])]);
        expect(only).toEqual({ key: 'claude-code|label:fresh', runtime: 'claude-code', ref: { label: 'fresh' }, label: 'fresh', environments: [{ machineId: 'mac', environmentId: 'env_new', authStatus: 'missing' }] });
        expect(accountDirectory([])).toEqual([]);
    });
});
