// @vitest-environment node
import type { EnvironmentId } from '@agentic/core';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, parseArgs } from '../src/cli';
import type { DaemonDriver } from '../src/daemon';
import { loadEnvironments } from '../src/environments';
import { daemonPaths } from '../src/paths';
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
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const paths = () => daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });

    it('parses commands, positionals and flags', () => {
        expect(parseArgs(['pair', 'ABC234', '--url', 'https://x', '--name=box', '--verbose'])).toEqual({ command: 'pair', positional: ['ABC234'], flags: { url: 'https://x', name: 'box', verbose: true } });
    });

    it('usage errors exit 2; help exits 0', async () => {
        expect(await main([], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['pair', 'ABC234'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['launch'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['help'], { paths: paths(), ...io() })).toBe(0);
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

    it('doctor: no environments is a warning with the command to add one', async () => {
        await writeFile(paths().credentialsFile, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token: `amt.ws_1.machine_1.${'t'.repeat(43)}` }));
        expect(await main(['doctor'], { paths: paths(), drivers: [scripted()], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/! no environments in .* — add one with `agentic-daemon env add/);
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
