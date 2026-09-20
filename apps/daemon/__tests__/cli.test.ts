// @vitest-environment node
import type { EnvironmentId } from '@agentic/core';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, parseArgs } from '../src/cli';
import { quoteArg } from '../src/env-cli';
import type { DaemonDriver } from '../src/daemon';
import { loadEnvironments } from '../src/environments';
import { daemonPaths } from '../src/paths';
import { loadPolicy, POLICY_OFF } from '../src/policy';
import { scriptedDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';
import { DAEMON_PROTOCOL_VERSION, decodeDaemonFrame, type DaemonFrameOf, type DaemonFrameType } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';

describe('cli', () => {
    let dir: string;
    let out: string[];
    const io = () => ({ out: (t: string) => out.push(t), err: (t: string) => out.push(t), log: (t: string) => out.push(t) });
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-cli-'));
        out = [];
    });
    const works: string[] = [];
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
        for (const w of works.splice(0)) await rm(w, { recursive: true, force: true });
    });
    const paths = () => daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });
    /** A folder to allow: outside the daemon's home, which is its configuration folder and never allowed (#238). */
    const workDir = async () => {
        const w = await mkdtemp(join(tmpdir(), 'agentic-work-'));
        works.push(w);
        return w;
    };

    it('parses commands, positionals and flags', () => {
        expect(parseArgs(['pair', 'ABC234', '--url', 'https://x', '--name=box', '--verbose'])).toEqual({ command: 'pair', positional: ['ABC234'], flags: { url: 'https://x', name: 'box', verbose: true } });
    });

    it('usage errors exit 2; help exits 0', async () => {
        expect(await main([], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['pair', 'ABC234'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['launch'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['help'], { paths: paths(), ...io() })).toBe(0);
        expect(out.at(-1)).toContain('agentic-daemon open [path] [--env <id>] [--no-browser]');
    });

    it('a failed pairing says why and saves nothing', async () => {
        const relay = await startRelay();
        try {
            expect(await main(['pair', 'WRONG1', '--url', relay.url], { paths: paths(), ...io() })).toBe(1);
            expect(out.join('\n')).toMatch(/pairing failed: the code is not valid/);
            expect(await main(['run'], { paths: paths(), ...io() })).toBe(1);
            expect(out.join('\n')).toMatch(/not paired/);
        } finally {
            await relay.close();
        }
    });

    const pairedWith = async (relay: Relay) => {
        await writeFile(paths().credentialsFile, JSON.stringify({ url: relay.url, workspaceId: 'ws_test', machineId: TEST_MACHINE, token: relay.token, name: 'box', pairedAt: 1 }));
    };
    async function expectFrame<T extends DaemonFrameType>(seat: PlatformSeat, t: T): Promise<DaemonFrameOf<T>> {
        for (;;) {
            const decoded = decodeDaemonFrame((await seat.next()) as string);
            if (!decoded.ok) throw new Error(decoded.error.message);
            if (decoded.frame.t === t) return decoded.frame as DaemonFrameOf<T>;
            if (decoded.frame.t !== 'heartbeat') throw new Error(`expected ${t}, got ${decoded.frame.t}`);
        }
    }

    // #235: a freshly paired machine has no environments.json yet.
    it('run: no environments file is zero environments, not exit 1', async () => {
        const relay = await startRelay();
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        try {
            await pairedWith(relay);
            const running = main(['run'], { paths: paths(), drivers: [scriptedDriver({ events: 1, heartbeatMs: 1_000 })], ...io(), until, backoff: { initialMs: 5, maxMs: 20 } });
            const seat = await relay.nextSeat();
            expect((await expectFrame(seat, 'hello')).environments).toEqual([]);
            stop();
            expect(await running).toBe(0);
        } finally {
            stop();
            await relay.close();
        }
    });

    const secure = { run: async () => ({ code: 0, stderr: '' }) };
    const scripted = () => scriptedDriver({ events: 1, heartbeatMs: 1_000 });

    it('env add | list | rm: no JSON by hand, one profile per environment', async () => {
        const ctx = () => ({ paths: paths(), drivers: [scripted()], ...secure, ...io() });
        expect(await main(['env', 'list'], ctx())).toBe(0);
        expect(out.join('\n')).toMatch(/no environments/);
        expect(await main(['env', 'add', '--name', 'Work', '--runtime', 'scripted', '--root', dir, `--root=${join(dir, 'later')}`, '--concurrency', '2', '--account', 'me@work'], ctx())).toBe(0);
        expect(out.join('\n')).toMatch(/added environment env_work/);
        expect(out.join('\n')).toMatch(/warning: working root .*later is not a directory/);
        expect(await loadEnvironments(paths().environmentsFile)).toEqual({
            ok: true,
            environments: [{ id: 'env_work', name: 'Work', runtime: 'scripted', profileDir: join(dir, 'profiles', 'env_work'), cwdRoots: [dir, join(dir, 'later')], concurrency: 2, accountLabel: 'me@work' }]
        });
        // The same profile for a second environment would be one account behind two names.
        expect(await main(['env', 'add', '--name', 'Home', '--runtime', 'scripted', '--root', dir, '--profile-dir', join(dir, 'profiles', 'env_work')], ctx())).toBe(1);
        expect(out.join('\n')).toMatch(/already used by environment "env_work"/);
        expect(await main(['env', 'add', '--name', 'Work', '--id', 'env_work', '--runtime', 'scripted', '--root', dir], ctx())).toBe(1);
        // --replace changes an environment in place and keeps its profile (the sign-in).
        expect(await main(['env', 'add', '--name', 'Work', '--id', 'env_work', '--replace', '--runtime', 'scripted', '--root', join(dir, 'moved')], ctx())).toBe(0);
        expect(await loadEnvironments(paths().environmentsFile)).toMatchObject({ environments: [{ id: 'env_work', profileDir: join(dir, 'profiles', 'env_work'), cwdRoots: [join(dir, 'moved')], concurrency: 1 }] });
        expect(await main(['env', 'add', '--name', 'Other', '--runtime', 'nope', '--root', dir], ctx())).toBe(1);
        expect(out.join('\n')).toMatch(/no driver for runtime "nope" \(it has: scripted\)/);
        expect(await main(['env', 'add', '--name', 'NoRoot', '--runtime', 'scripted'], ctx())).toBe(2);
        // A flag without its value is a usage error, not `Number(true)` = 1.
        expect(await main(['env', 'add', '--name', 'NoValue', '--runtime', 'scripted', '--root', dir, '--concurrency'], ctx())).toBe(2);
        expect(out.join('\n')).toMatch(/--concurrency needs a value/);
        expect(await main(['env'], ctx())).toBe(2);
        out = [];
        expect(await main(['env', 'list'], ctx())).toBe(0);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatch(/^env_work\tWork\tscripted\tconcurrency 1/);
        expect(await main(['env', 'rm', 'env_nope'], ctx())).toBe(1);
        expect(await main(['env', 'rm', 'env_work'], ctx())).toBe(0);
        expect(await loadEnvironments(paths().environmentsFile)).toEqual({ ok: true, environments: [] });
    });

    it('env login: the runtime’s sign-in under that profile, with nothing that could pick another account', async () => {
        const calls: { command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
        let exit = 0;
        const ctx = () => ({
            paths: paths(),
            drivers: [scripted(), { ...scripted(), runtime: 'claude-code' }],
            ...secure,
            ...io(),
            env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-leak', CLAUDE_CONFIG_DIR: '/elsewhere' },
            login: async (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => (calls.push({ command, args, env }), exit)
        });
        expect(await main(['env', 'add', '--name', 'Work', '--root', dir], ctx())).toBe(0);
        expect(out.join('\n')).toMatch(/sign it in with: agentic-daemon env login env_work/);
        expect(await main(['env', 'add', '--name', 'Script', '--runtime', 'scripted', '--root', dir], ctx())).toBe(0);
        expect(await main(['env', 'login', 'env_work', '--claude', '/opt/claude'], ctx())).toBe(0);
        expect(calls).toEqual([{ command: '/opt/claude', args: ['/login'], env: { PATH: '/bin', CLAUDE_CONFIG_DIR: join(dir, 'profiles', 'env_work') } }]);
        exit = 3;
        expect(await main(['env', 'login', 'env_work'], ctx())).toBe(1);
        expect(calls[1]!.command).toBe('claude');
        expect(await main(['env', 'login', 'env_script'], ctx())).toBe(1);
        expect(await main(['env', 'login', 'env_nope'], ctx())).toBe(1);
        expect(await main(['env', 'login'], ctx())).toBe(2);
        expect(calls).toHaveLength(2);
    });

    it('env login: Copilot CLI signs in with `copilot login` under its own COPILOT_HOME, without the parent\'s tokens', async () => {
        const calls: { command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
        const ctx = () => ({
            paths: paths(),
            drivers: [{ ...scripted(), runtime: 'copilot-cli' }],
            ...secure,
            ...io(),
            env: { PATH: '/bin', GH_TOKEN: 'ghp_leak', GITHUB_TOKEN: 'ghs_leak', COPILOT_HOME: '/elsewhere' },
            login: async (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => (calls.push({ command, args, env }), 0)
        });
        expect(await main(['env', 'add', '--name', 'Octo', '--runtime', 'copilot-cli', '--root', dir], ctx())).toBe(0);
        expect(out.join('\n')).toMatch(/sign it in with: agentic-daemon env login env_octo/);
        expect(await main(['env', 'login', 'env_octo'], ctx())).toBe(0);
        expect(await main(['env', 'login', 'env_octo', '--cli', '/opt/copilot'], ctx())).toBe(0);
        expect(calls).toEqual([
            { command: 'copilot', args: ['login'], env: { PATH: '/bin', COPILOT_HOME: join(dir, 'profiles', 'env_octo') } },
            { command: '/opt/copilot', args: ['login'], env: { PATH: '/bin', COPILOT_HOME: join(dir, 'profiles', 'env_octo') } }
        ]);
    });

    it('env login on Windows: an argument with spaces or quotes stays one argument on the cmd line', () => {
        expect(quoteArg('login')).toBe('login');
        expect(quoteArg('C:/Program Files/agentic/node_modules/@openai/codex/bin/codex.js')).toBe('"C:/Program Files/agentic/node_modules/@openai/codex/bin/codex.js"');
        expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    });

    it('env login: Codex signs in with `codex login` under its own CODEX_HOME, without the parent\'s OpenAI variables', async () => {
        const calls: { command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
        const ctx = () => ({
            paths: paths(),
            drivers: [{ ...scripted(), runtime: 'codex-cli' }],
            ...secure,
            ...io(),
            env: { PATH: '/bin', OPENAI_API_KEY: 'sk-leak', CODEX_HOME: '/elsewhere' },
            login: async (command: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>) => (calls.push({ command, args, env }), 0)
        });
        expect(await main(['env', 'add', '--name', 'Codex', '--runtime', 'codex-cli', '--root', dir], ctx())).toBe(0);
        expect(await main(['env', 'login', 'env_codex'], ctx())).toBe(0);
        expect(await main(['env', 'login', 'env_codex', '--cli', '/opt/codex'], ctx())).toBe(0);
        const home = { PATH: '/bin', CODEX_HOME: join(dir, 'profiles', 'env_codex') };
        // The daemon ships `@openai/codex`: its launcher, run with this Node.
        expect(calls[0]).toEqual({ command: process.execPath, args: [expect.stringMatching(/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/), 'login'], env: home });
        expect(calls[1]).toEqual({ command: '/opt/codex', args: ['login'], env: home });
    });

    it('run: env add reaches the platform without a restart; an invalid edit keeps the running set', async () => {
        const relay = await startRelay();
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        try {
            await pairedWith(relay);
            const ctx = { paths: paths(), drivers: [scripted()], ...secure, ...io() };
            let started!: () => void;
            const ready = new Promise<void>((r) => (started = r));
            const running = main(['run'], { ...ctx, until, backoff: { initialMs: 5, maxMs: 20 }, watchDebounceMs: 20, onStarted: () => started() });
            const seat = await relay.nextSeat();
            expect((await expectFrame(seat, 'hello')).environments).toEqual([]);
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
            await ready;

            expect(await main(['env', 'add', '--name', 'Work', '--runtime', 'scripted', '--root', dir], ctx)).toBe(0);
            expect((await expectFrame(seat, 'env')).environments.map((e) => e.id)).toEqual(['env_work']);

            await writeFile(paths().environmentsFile, '{nope');
            await vi.waitFor(() => expect(out.join('\n')).toMatch(/keeping the running environments/), { timeout: 4_000 });

            // Fixed by hand, with a second environment: the first was never dropped in between.
            const work = { id: 'env_work', name: 'Work', runtime: 'scripted', profileDir: join(dir, 'profiles', 'env_work'), cwdRoots: [dir] };
            await writeFile(paths().environmentsFile, JSON.stringify([work, { ...work, id: 'env_home', name: 'Home', profileDir: join(dir, 'profiles', 'env_home') }]));
            expect((await expectFrame(seat, 'env')).environments.map((e) => e.id)).toEqual(['env_work', 'env_home']);
            stop();
            expect(await running).toBe(0);
        } finally {
            stop();
            await relay.close();
        }
    });

    // #354: the `agentic-daemon` command itself, written by the installer.
    it('launcher install | show | remove', async () => {
        const home = join(dir, 'home');
        await mkdir(home, { recursive: true });
        // HOME decides the folders `launcher` touches: the real home is never reached from a test.
        const ctx = () => ({ paths: paths(), platform: 'linux' as const, env: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: home }, ...io() });
        const file = join(home, '.agentic', 'bin', 'agentic-daemon');

        expect(await main(['launcher', 'install', '--node', '/opt/node', '--entry', '/opt/daemon/bin/agentic-daemon.mjs', '--no-profile'], ctx())).toBe(0);
        expect(await readFile(file, 'utf8')).toContain('exec "/opt/node" "/opt/daemon/bin/agentic-daemon.mjs" "$@"');
        expect(out.join('\n')).toContain(file);

        out = [];
        expect(await main(['launcher', 'show', '--node', '/opt/node', '--entry', '/opt/daemon/bin/agentic-daemon.mjs'], ctx())).toBe(0);
        expect(out.join('\n')).toContain('runs: /opt/node /opt/daemon/bin/agentic-daemon.mjs');

        expect(await main(['launcher', 'remove'], ctx())).toBe(0);
        await expect(readFile(file, 'utf8')).rejects.toThrow();
        expect(await main(['launcher'], ctx())).toBe(2);
        expect(await main(['launcher', 'nope'], ctx())).toBe(2);
    });

    // #238: the policy is edited on the machine and nowhere else.
    it('policy show | allow-root | deny-root | off', async () => {
        const ctx = () => ({ paths: paths(), ...secure, ...io() });
        const work = await workDir();
        expect(await main(['policy', 'show'], ctx())).toBe(0);
        expect(out.pop()).toMatch(/web management: off/);
        expect(await main(['policy', 'allow-root', work], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [await realpath(work)] } });
        expect(await main(['policy', 'show'], ctx())).toBe(0);
        expect(out.pop()).toContain(await realpath(work));
        // The daemon's own folder, a missing one, no folder at all.
        expect(await main(['policy', 'allow-root', paths().configDir], ctx())).toBe(1);
        expect(await main(['policy', 'allow-root', join(dir, 'missing')], ctx())).toBe(1);
        expect(await main(['policy', 'allow-root'], ctx())).toBe(2);
        expect(await main(['policy', 'deny-root', work], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: POLICY_OFF });
        // A broken file is not silently replaced by an edit, but `off` starts over.
        await writeFile(paths().policyFile, '{nope');
        expect(await main(['policy', 'allow-root', work], ctx())).toBe(1);
        expect(out.join('\n')).toMatch(/is invalid/);
        expect(await main(['policy', 'off'], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: POLICY_OFF });
        expect(await main(['policy', 'on'], ctx())).toBe(2);
    });

    it('pair --allow-root: every folder is checked before the code is spent', async () => {
        const relay = await startRelay();
        try {
            const work = await workDir();
            const ctx = { paths: paths(), ...secure, ...io() };
            expect(await main(['pair', 'ABC234', '--url', relay.url, '--allow-root', join(dir, 'missing')], ctx)).toBe(1);
            expect(relay.paired).toEqual([]);
            expect(await main(['pair', 'ABC234', '--url', relay.url, '--name', 'box', '--allow-root', work], ctx)).toBe(0);
            expect(relay.paired).toEqual(['box']);
            expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [await realpath(work)] } });
        } finally {
            await relay.close();
        }
    });

    it('run: env.request is answered under the policy; a policy edit is announced without a restart', async () => {
        const relay = await startRelay();
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        try {
            await pairedWith(relay);
            const work = await workDir();
            await mkdir(join(work, 'repo'), { recursive: true });
            const ctx = { paths: paths(), drivers: [scripted()], ...secure, ...io() };
            let started!: () => void;
            const ready = new Promise<void>((r) => (started = r));
            const running = main(['run'], { ...ctx, until, backoff: { initialMs: 5, maxMs: 20 }, watchDebounceMs: 20, onStarted: () => started() });
            const seat = await relay.nextSeat();
            expect((await expectFrame(seat, 'hello')).policy).toEqual(POLICY_OFF);
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
            await ready;

            const request = (requestId: string) => seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'env.request', requestId, op: 'put', environment: { name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'repo')] } });
            request('env_1');
            expect((await expectFrame(seat, 'env.response')).error?.code).toBe('policy-disabled');

            expect(await main(['policy', 'allow-root', work], ctx)).toBe(0);
            expect((await expectFrame(seat, 'env')).policy).toEqual({ webManaged: true, allowedRoots: [await realpath(work)] });
            const policyOnDisk = await readFile(paths().policyFile, 'utf8');

            request('env_2');
            expect((await expectFrame(seat, 'env')).environments.map((e) => e.id)).toEqual(['env_web']);
            expect((await expectFrame(seat, 'env.response')).result).toEqual({ environmentId: 'env_web' });
            expect((await loadEnvironments(paths().environmentsFile)).ok).toBe(true);
            expect(await readFile(paths().policyFile, 'utf8')).toBe(policyOnDisk);
            stop();
            expect(await running).toBe(0);
        } finally {
            stop();
            await relay.close();
        }
    });

    it('doctor: no environments is a warning with the command to add one', async () => {
        await writeFile(paths().credentialsFile, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token: `amt.ws_1.machine_1.${'t'.repeat(43)}` }));
        expect(await main(['doctor'], { paths: paths(), drivers: [scripted()], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/! no environments yet \(.*environments\.json does not exist\) — add one with `agentic-daemon env add/);
        // The file is there but empty: say that instead.
        out = [];
        await writeFile(paths().environmentsFile, '[]');
        expect(await main(['doctor'], { paths: paths(), drivers: [scripted()], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/! no environments in .*environments\.json — add one/);
    });

    it('doctor: not paired, invalid environments', async () => {
        await writeFile(paths().environmentsFile, JSON.stringify([{ id: 'env_a', name: 'A', runtime: 'scripted', cwdRoots: [] }]));
        expect(await main(['doctor'], { paths: paths(), drivers: [], ...io() })).toBe(1);
        const text = out.join('\n');
        expect(text).toMatch(/✗ not paired/);
        expect(text).toMatch(/✗ environments\[0\]\.cwdRoots/);
        expect(text).toMatch(/doctor: problems found/);
    });

    it('doctor: a missing driver, a missing root and the driver’s own findings; never the token', async () => {
        const token = `amt.ws_1.machine_1.${'t'.repeat(43)}`;
        await writeFile(paths().credentialsFile, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token, name: 'box', pairedAt: 1 }));
        await mkdir(join(dir, 'src'));
        await writeFile(
            paths().environmentsFile,
            JSON.stringify([
                { id: 'env_a', name: 'A', runtime: 'scripted', profileDir: join(dir, 'p'), cwdRoots: [join(dir, 'src')] },
                { id: 'env_b', name: 'B', runtime: 'scripted', profileDir: join(dir, 'p'), cwdRoots: [join(dir, 'missing')] },
                { id: 'env_c', name: 'C', runtime: 'claude-code', cwdRoots: [join(dir, 'src')] }
            ])
        );
        const driver: DaemonDriver = {
            ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }),
            doctor: async (envs) => ({ ok: false, findings: [{ level: 'error', code: 'shared-config-dir', message: `${envs.map((e) => e.name).join(' and ')} share a profile dir`, environmentIds: envs.map((e) => e.id as EnvironmentId) }] })
        };
        expect(await main(['doctor'], { paths: paths(), drivers: [driver], ...io() })).toBe(1);
        const text = out.join('\n');
        expect(text).toMatch(/✓ paired as machine machine_1 of workspace ws_1/);
        expect(text).toMatch(/✗ environment C uses runtime "claude-code", which this daemon has no driver for/);
        expect(text).toMatch(/! environment B: working root .* is not a directory/);
        expect(text).toMatch(/✗ A and B share a profile dir/);
        expect(text).not.toContain(token);
        // The verdict the platform gets names no path (#274); the operator at the machine still sees each profile.
        expect(text).toContain(`✓ environment A (env_a): profile ${join(dir, 'p')}`);
        expect(text).toContain('✓ environment C (env_c): no profile of its own — the runtime’s default');
    });

    it('doctor: ok when everything checks out', async () => {
        await writeFile(paths().credentialsFile, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token: `amt.ws_1.machine_1.${'t'.repeat(43)}` }));
        await writeFile(paths().environmentsFile, JSON.stringify([{ id: 'env_a', name: 'A', runtime: 'scripted', cwdRoots: [dir] }]));
        expect(await main(['doctor'], { paths: paths(), drivers: [scriptedDriver({ events: 1, heartbeatMs: 1_000 })], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/doctor: ok/);
    });
});

describe('Windows service scripts', () => {
    const scripts = resolve(import.meta.dirname, '..', 'scripts');
    // One PowerShell process for both scripts; a cold windows runner takes >10 s to start it.
    it.runIf(process.platform === 'win32')('install and uninstall parse as PowerShell', { timeout: 60_000 }, () => {
        const checks = ['install-service.ps1', 'uninstall-service.ps1'].map((name) => {
            const file = join(scripts, name).replace(/'/g, "''");
            return `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e.Count) { '${name}:'; $e | ForEach-Object { $_.Message }; $bad = $true }`;
        });
        const script = `$bad = $false; ${checks.join('; ')}; if ($bad) { exit 1 }`;
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    });
});
