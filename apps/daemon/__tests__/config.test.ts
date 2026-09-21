// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { credentialSecrets, loadCredentials, ownerOnlyAclArgs, saveCredentials, type CommandRunner, type Credentials } from '../src/credentials';
import { loadEnvironments, parseEnvironments } from '../src/environments';
import { createLogger, redact } from '../src/logger';
import { daemonPaths } from '../src/paths';

const TOKEN = `amt.ws_1.machine_1.${'k'.repeat(43)}`;

describe('paths', () => {
    it('Windows: token and environments under %APPDATA%/agentic, session logs under %LOCALAPPDATA%/agentic/sessions', () => {
        const p = daemonPaths({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, home: 'C:\\Users\\me' });
        expect(p.credentialsFile).toBe(win32.join('C:\\Users\\me\\AppData\\Roaming', 'agentic', 'credentials.json'));
        expect(p.environmentsFile).toBe(win32.join('C:\\Users\\me\\AppData\\Roaming', 'agentic', 'environments.json'));
        expect(p.sessionsDir).toBe(win32.join('C:\\Users\\me\\AppData\\Local', 'agentic', 'sessions'));
    });
    it('Linux follows XDG; AGENTIC_DAEMON_HOME puts everything in one place', () => {
        expect(daemonPaths({ platform: 'linux', env: {}, home: '/home/me' }).sessionsDir).toBe(posix.join('/home/me', '.local', 'state', 'agentic', 'sessions'));
        const one = daemonPaths({ platform: 'win32', env: { AGENTIC_DAEMON_HOME: 'D:\\agentic' }, home: 'C:\\Users\\me' });
        expect(one.credentialsFile).toBe(win32.join('D:\\agentic', 'credentials.json'));
        expect(one.sessionsDir).toBe(win32.join('D:\\agentic', 'sessions'));
    });
});

describe('environments.json', () => {
    const row = { id: 'env_a', name: 'A', runtime: 'claude-code', profileDir: 'C:/p/a', cwdRoots: ['C:/src'], concurrency: 2 };

    it('accepts an array or { environments } and defaults concurrency to 1', () => {
        const { concurrency: _omit, ...noConcurrency } = row;
        expect(parseEnvironments([row])).toEqual({ ok: true, environments: [row] });
        expect(parseEnvironments({ environments: [noConcurrency] })).toEqual({ ok: true, environments: [{ ...noConcurrency, concurrency: 1 }] });
    });
    it('reads allowBypassPermissions (#453): only true is kept, anything but a boolean is an error', () => {
        expect(parseEnvironments([{ ...row, allowBypassPermissions: true }])).toEqual({ ok: true, environments: [{ ...row, allowBypassPermissions: true }] });
        expect(parseEnvironments([{ ...row, allowBypassPermissions: false }])).toEqual({ ok: true, environments: [row] });
        expect(parseEnvironments([{ ...row, allowBypassPermissions: 'yes' }])).toEqual({ ok: false, errors: ['environments[0].allowBypassPermissions must be true or false'] });
    });
    it('reports every problem at once', () => {
        const result = parseEnvironments([row, { ...row }, { id: '../x', name: '', runtime: 'x', cwdRoots: [], concurrency: 0 }, 'nope']);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors).toEqual([
            'environments[1].id "env_a" is used twice',
            'environments[2].id must be 1-256 characters of A-Z a-z 0-9 _ -',
            'environments[2].name is required',
            'environments[2].cwdRoots must be a non-empty list of paths',
            'environments[2].concurrency must be a whole number ≥ 1',
            'environments[3] must be an object'
        ]);
    });
    it('a missing file is zero environments (#235); a non-JSON file is a named problem, not a crash', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-env-'));
        try {
            expect(await loadEnvironments(join(dir, 'environments.json'))).toEqual({ ok: true, environments: [], missing: true });
            await writeFile(join(dir, 'environments.json'), '{nope');
            const bad = await loadEnvironments(join(dir, 'environments.json'));
            expect(bad.ok).toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('credentials', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-cred-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const creds: Credentials = { url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token: TOKEN, name: 'box', pairedAt: 1 };

    it('round-trips; a missing file means "not paired"', async () => {
        const file = join(dir, 'nested', 'credentials.json');
        expect(await loadCredentials(file)).toBeNull();
        await saveCredentials(file, creds, process.platform === 'win32' ? {} : { platform: 'linux' });
        expect(await loadCredentials(file)).toEqual(creds);
    });

    it.runIf(process.platform !== 'win32')('POSIX: the file is 0600', async () => {
        const file = join(dir, 'credentials.json');
        await saveCredentials(file, creds);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    it('Windows: inheritance is removed and only the user is granted, BEFORE the token is written', async () => {
        const file = join(dir, 'credentials.json');
        const calls: { command: string; args: readonly string[]; contents: string }[] = [];
        const run: CommandRunner = async (command, args) => {
            calls.push({ command, args, contents: await readFile(args[0]!, 'utf8') });
            return { code: 0, stderr: '' };
        };
        await saveCredentials(file, creds, { platform: 'win32', run, env: { USERNAME: 'me', USERDOMAIN: 'BOX' } });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.command).toBe('icacls');
        expect(calls[0]!.args.slice(1)).toEqual(['/inheritance:r', '/grant:r', 'BOX\\me:F']);
        expect(calls[0]!.contents).toBe('');
        expect(await loadCredentials(file)).toEqual(creds);
    });

    it('Windows: when the ACL cannot be set nothing is written', async () => {
        const file = join(dir, 'credentials.json');
        const run: CommandRunner = async () => ({ code: 5, stderr: 'Access is denied.' });
        await expect(saveCredentials(file, creds, { platform: 'win32', run, env: { USERNAME: 'me' } })).rejects.toThrow(/icacls could not restrict/);
        expect(await loadCredentials(file)).toBeNull();
    });

    it.runIf(process.platform === 'win32')('Windows: the real icacls leaves the file readable by its owner', async () => {
        const file = join(dir, 'credentials.json');
        await saveCredentials(file, creds);
        expect(await loadCredentials(file)).toEqual(creds);
        expect(ownerOnlyAclArgs(file, 'me')).toEqual([file, '/inheritance:r', '/grant:r', 'me:F']);
    });

    it('a corrupt file asks to pair again', async () => {
        const file = join(dir, 'credentials.json');
        await writeFile(file, JSON.stringify({ url: 'x' }));
        await expect(loadCredentials(file)).rejects.toThrow(/pair again/);
    });
});

describe('logger', () => {
    it('never writes the token, its secret, or anything token-shaped', () => {
        const lines: string[] = [];
        const log = createLogger({ write: (l) => lines.push(l), level: 'debug', secrets: () => credentialSecrets({ token: TOKEN }) });
        log.info('connecting', { authorization: `Bearer ${TOKEN}` });
        log.warn('secret alone', { s: 'k'.repeat(43) });
        log.error('failed', { error: new Error(`bad token agt.ws_1.agent_1.${'z'.repeat(40)}`) });
        const all = lines.join('\n');
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain('k'.repeat(43));
        expect(all).not.toContain('z'.repeat(40));
        expect(all).toContain('[redacted]');
        expect(JSON.parse(lines[2]!)).toMatchObject({ level: 'error', msg: 'failed', error: { name: 'Error' } });
    });
    it('filters by level', () => {
        const lines: string[] = [];
        const log = createLogger({ write: (l) => lines.push(l) });
        log.debug('hidden');
        log.info('shown');
        expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['shown']);
    });
    it('redact leaves short strings alone', () => {
        expect(redact('abc abc', ['abc'])).toBe('abc abc');
    });
});
