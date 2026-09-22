// @vitest-environment node
import type { EnvironmentId } from '@agentic/core';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { EXIT_UPDATE, main, parseArgs } from '../src/cli';
import { quoteArg } from '../src/env-cli';
import type { DaemonDriver } from '../src/daemon';
import { loadEnvironments } from '../src/environments';
import { daemonPaths, installPaths } from '../src/paths';
import { loadPolicy, POLICY_OFF } from '../src/policy';
import { DAEMON_CHANNEL, DAEMON_COMMIT, DAEMON_VERSION, versionLine } from '../src/version';
import { scriptedDriver } from './helpers/drivers';
import { assetOf, releaseZip, startReleaseServer, type ReleaseServer } from './helpers/release';
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

    it('--version and `version` print the version, commit, protocol and channel', async () => {
        expect(await main(['--version'], { paths: paths(), ...io() })).toBe(0);
        expect(await main(['version'], { paths: paths(), ...io() })).toBe(0);
        // unstamped from source (vitest); a build stamps them (vite.config.ts, package.test.ts checks the zip)
        expect(out).toEqual([`agentic-daemon ${DAEMON_VERSION} (${DAEMON_COMMIT}, protocol ${DAEMON_PROTOCOL_VERSION}, ${DAEMON_CHANNEL})`, versionLine()]);
        expect(out[0]).toBe(`agentic-daemon 0.0.0-dev (unknown, protocol ${DAEMON_PROTOCOL_VERSION}, dev)`);
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
            if (decoded.frame.t !== 'heartbeat' && decoded.frame.t !== 'telemetry') throw new Error(`expected ${t}, got ${decoded.frame.t}`);
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

    // #362: the supervisor's side of `run` — the ready marker, its state read back, and a reason on every exit.
    const exits = () => out.filter((l) => l.includes('"daemon: exiting"')).map((l) => JSON.parse(l) as { reason: string; code: number; error?: { message: string }; stack?: string });
    const install = () => installPaths({ env: { AGENTIC_INSTALL_DIR: join(dir, 'install') } });

    it('run: writes state/ready after the first welcome, logs the supervisor state, exits 0 on stop and 75 on update', async () => {
        const relay = await startRelay();
        let stop!: (value?: 'update') => void;
        const until = new Promise<void | 'update'>((r) => (stop = r));
        try {
            await pairedWith(relay);
            await mkdir(install().stateDir, { recursive: true });
            await writeFile(install().supervisorFile, JSON.stringify({ restarts: 3, lastExit: { at: 1, code: 1, signal: null } }));
            await writeFile(install().updateFailedFile, JSON.stringify({ from: '0.1.0', to: '0.2.0', at: 2, reason: 'not-ready' }));
            const running = main(['run'], { paths: paths(), install: install(), drivers: [scripted()], ...io(), until, backoff: { initialMs: 5, maxMs: 20 } });
            const seat = await relay.nextSeat();
            await expectFrame(seat, 'hello');
            await expect(readFile(install().readyFile, 'utf8')).rejects.toThrow();
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
            await vi.waitFor(async () => expect(JSON.parse(await readFile(install().readyFile, 'utf8'))).toMatchObject({ version: DAEMON_VERSION, pid: process.pid }));
            const state = out.map((l) => JSON.parse(l) as { msg: string }).find((l) => l.msg === 'supervisor state');
            expect(state).toMatchObject({ restarts: 3, lastExit: { code: 1 }, lastUpdate: { to: '0.2.0', reason: 'not-ready' } });
            stop('update');
            expect(await running).toBe(EXIT_UPDATE);
            expect(exits()).toEqual([expect.objectContaining({ reason: 'update', code: 75 })]);

            out = [];
            const again = new Promise<void | 'update'>((r) => (stop = r));
            const second = main(['run'], { paths: paths(), install: install(), drivers: [scripted()], ...io(), until: again, backoff: { initialMs: 5, maxMs: 20 } });
            await expectFrame(await relay.nextSeat(), 'hello');
            stop();
            expect(await second).toBe(0);
            expect(exits()).toEqual([expect.objectContaining({ reason: 'stop', code: 0 })]);
        } finally {
            stop();
            await relay.close();
        }
    });

    it('run: an uncaught exception or unhandled rejection is logged with its reason and exits 1', async () => {
        const relay = await startRelay();
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        try {
            await pairedWith(relay);
            const host = Object.assign(new EventEmitter(), { exit: vi.fn() });
            const running = main(['run'], { paths: paths(), drivers: [scripted()], ...io(), until, host, backoff: { initialMs: 5, maxMs: 20 } });
            await expectFrame(await relay.nextSeat(), 'hello');
            host.emit('uncaughtException', new Error('boom'));
            host.emit('unhandledRejection', new Error('lost'));
            expect(host.exit.mock.calls).toEqual([[1], [1]]);
            expect(exits()).toEqual([expect.objectContaining({ reason: 'uncaught', code: 1, error: expect.objectContaining({ message: 'boom' }) }), expect.objectContaining({ reason: 'unhandled-rejection', code: 1 })]);
            expect(exits()[0]!.stack).toMatch(/boom/);
            stop();
            expect(await running).toBe(0);
            // A stopped run leaves no handler behind.
            expect(host.listenerCount('uncaughtException') + host.listenerCount('unhandledRejection')).toBe(0);
        } finally {
            stop();
            await relay.close();
        }
    });

    it('run: an exit before the daemon starts still says why', async () => {
        expect(await main(['run'], { paths: paths(), ...io() })).toBe(1);
        expect(exits()).toEqual([expect.objectContaining({ reason: 'config', code: 1 })]);
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
        // --allow-bypass (#355) sets the flag; a replace without it keeps it.
        expect(await main(['env', 'add', '--name', 'Work', '--id', 'env_work', '--replace', '--runtime', 'scripted', '--root', join(dir, 'moved'), '--allow-bypass'], ctx())).toBe(0);
        expect(await loadEnvironments(paths().environmentsFile)).toMatchObject({ environments: [{ id: 'env_work', allowBypassPermissions: true }] });
        expect(await main(['env', 'add', '--name', 'Work', '--id', 'env_work', '--replace', '--runtime', 'scripted', '--root', join(dir, 'moved')], ctx())).toBe(0);
        expect(await loadEnvironments(paths().environmentsFile)).toMatchObject({ environments: [{ id: 'env_work', allowBypassPermissions: true }] });
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
        // The command is planned for `platform: 'linux'`, so its path is posix even when the test runs on Windows.
        const file = posix.join(home, '.agentic', 'bin', 'agentic-daemon');

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
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [await realpath(work)], source: 'local' } });
        expect(await main(['policy', 'show'], ctx())).toBe(0);
        expect(out.pop()).toContain(await realpath(work));
        // The daemon's own folder, a missing one, no folder at all.
        expect(await main(['policy', 'allow-root', paths().configDir], ctx())).toBe(1);
        expect(await main(['policy', 'allow-root', join(dir, 'missing')], ctx())).toBe(1);
        expect(await main(['policy', 'allow-root'], ctx())).toBe(2);
        expect(await main(['policy', 'deny-root', work], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { ...POLICY_OFF, source: 'local' } });
        // A broken file is not silently replaced by an edit, but `off` starts over.
        await writeFile(paths().policyFile, '{nope');
        expect(await main(['policy', 'allow-root', work], ctx())).toBe(1);
        expect(out.join('\n')).toMatch(/is invalid/);
        expect(await main(['policy', 'off'], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { ...POLICY_OFF, source: 'local' } });
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
            expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [await realpath(work)], source: 'local' } });
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
            expect((await expectFrame(seat, 'env')).policy).toEqual({ webManaged: true, allowedRoots: [await realpath(work)], source: 'local' });
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

    // #355: the web sets the policy through `policy.request`; `lock` on the machine wins.
    it('policy lock | unlock, and show says who set it', async () => {
        const ctx = () => ({ paths: paths(), ...secure, ...io() });
        const work = await workDir();
        expect(await main(['policy', 'allow-root', work], ctx())).toBe(0);
        expect(await main(['policy', 'lock'], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [await realpath(work)], source: 'local', locked: true } });
        expect(out.pop()).toMatch(/set on this machine; locked/);
        // A local edit keeps the lock; `off` too.
        expect(await main(['policy', 'deny-root', work], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { ...POLICY_OFF, source: 'local', locked: true } });
        expect(await main(['policy', 'off'], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { ...POLICY_OFF, source: 'local', locked: true } });
        expect(await main(['policy', 'unlock'], ctx())).toBe(0);
        expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: { ...POLICY_OFF, source: 'local' } });
        expect(out.pop()).not.toMatch(/locked/);
        // A broken file is not locked or unlocked blindly.
        await writeFile(paths().policyFile, '{nope');
        expect(await main(['policy', 'lock'], ctx())).toBe(1);
    });

    it('run: policy.request sets the policy from the web (one env frame, the watcher quiet), browse lists folders, lock refuses', async () => {
        const relay = await startRelay();
        let stop!: () => void;
        const until = new Promise<void>((r) => (stop = r));
        try {
            await pairedWith(relay);
            const work = await workDir();
            await mkdir(join(work, 'repo'), { recursive: true });
            // The home folder lives outside the daemon's own (`dir` is its configuration folder here).
            const home = await workDir();
            await mkdir(join(home, 'src'), { recursive: true });
            const ctx = { paths: paths(), drivers: [scripted()], home, ...secure, ...io() };
            let started!: () => void;
            const ready = new Promise<void>((r) => (started = r));
            const running = main(['run'], { ...ctx, until, backoff: { initialMs: 5, maxMs: 20 }, watchDebounceMs: 20, onStarted: () => started() });
            const seat = await relay.nextSeat();
            const hello = await expectFrame(seat, 'hello');
            expect(hello.policy).toEqual(POLICY_OFF);
            expect(hello.features).toContain('policy');
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
            await ready;

            // Set from the web: `~` expands to the daemon user's home, the env frame comes first, and exactly once.
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_1', op: 'set', policy: { allowedRoots: ['~', work] } });
            const applied = { webManaged: true, allowedRoots: [await realpath(home), await realpath(work)], source: 'web', requested: ['~', work] };
            expect((await expectFrame(seat, 'env')).policy).toEqual(applied);
            expect((await expectFrame(seat, 'policy.response')).result).toEqual({ policy: applied });
            expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: applied });
            // The file watcher saw what the daemon itself wrote: no second announcement. An env.request now works under it.
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'env.request', requestId: 'env_1', op: 'put', environment: { name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'repo')], allowBypassPermissions: true } });
            expect((await expectFrame(seat, 'env')).environments.map((e) => [e.id, e.allowBypassPermissions])).toEqual([['env_web', true]]);
            expect((await expectFrame(seat, 'env.response')).result).toEqual({ environmentId: 'env_web' });

            // Browse: the roots, then the work folder.
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_2', op: 'browse' });
            const roots = (await expectFrame(seat, 'policy.response')).result?.listing;
            expect(roots?.entries[0]).toEqual({ name: '~', path: home });
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_3', op: 'browse', path: work });
            expect((await expectFrame(seat, 'policy.response')).result?.listing).toMatchObject({ path: work, entries: [{ name: 'repo', path: join(work, 'repo') }], truncated: false });
            // The daemon's own folder reads as absent.
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_4', op: 'browse', path: paths().configDir });
            expect((await expectFrame(seat, 'policy.response')).error?.code).toBe('not-found');

            // A refused set announces nothing and changes nothing.
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_5', op: 'set', policy: { allowedRoots: [join(work, 'missing')] } });
            expect((await expectFrame(seat, 'policy.response')).error?.code).toBe('not-found');
            expect(await loadPolicy(paths().policyFile)).toEqual({ ok: true, policy: applied });

            // Locked on the machine: announced with env, every set refused, the web sees the lock.
            expect(await main(['policy', 'lock'], ctx)).toBe(0);
            // The lock is orthogonal: what the web set stays visible (and converged) — it just cannot be changed from there.
            expect((await expectFrame(seat, 'env')).policy).toEqual({ ...applied, locked: true });
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_6', op: 'set', policy: { allowedRoots: [] } });
            expect((await expectFrame(seat, 'policy.response')).error?.code).toBe('policy-locked');
            expect(await main(['policy', 'unlock'], ctx)).toBe(0);
            expect((await expectFrame(seat, 'env')).policy?.locked).toBeUndefined();
            seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'policy.request', requestId: 'p_7', op: 'set', policy: { allowedRoots: [] } });
            expect((await expectFrame(seat, 'env')).policy).toEqual({ webManaged: false, allowedRoots: [], source: 'web', requested: [] });
            expect((await expectFrame(seat, 'policy.response')).result).toEqual({ policy: { webManaged: false, allowedRoots: [], source: 'web', requested: [] } });
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
        // The policy line (#355): off, then set on the machine and locked, then a broken file.
        expect(out.join('\n')).toMatch(/✓ policy: off\n/);
        out = [];
        const work = await workDir();
        expect(await main(['policy', 'allow-root', work], { paths: paths(), ...secure, ...io() })).toBe(0);
        expect(await main(['policy', 'lock'], { paths: paths(), ...secure, ...io() })).toBe(0);
        expect(await main(['doctor'], { paths: paths(), drivers: [scripted()], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/✓ policy: 1 folder, set on this machine, locked — the web cannot set it until `agentic-daemon policy unlock`/);
        await writeFile(paths().policyFile, '{nope');
        expect(await main(['doctor'], { paths: paths(), drivers: [scripted()], ...io() })).toBe(1);
        expect(out.join('\n')).toMatch(/✗ policy\.json is not JSON.* — web management is off until/);
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
    // #364: the update client in `run`, and `agentic-daemon update`.
    describe('update', () => {
        let server: ReleaseServer;
        let release: ReturnType<typeof releaseZip>;
        beforeEach(async () => {
            server = await startReleaseServer();
            release = releaseZip(dir, '0.2.0');
            server.serve('/download/daemon-v0.2.0/agentic-daemon.zip', release.bytes);
        });
        afterEach(async () => {
            await server.close();
        });
        const KEY = 'test-x64';
        const manifest = (version = '0.2.0') => JSON.stringify({ version, channel: 'stable', commit: 'abc1234', publishedAt: 1, protocol: 1, assets: { [KEY]: assetOf(`${server.origin}/download/daemon-v0.2.0/agentic-daemon.zip`, release, version) }, harnesses: {} });
        const supervise = async () => {
            await mkdir(install().stateDir, { recursive: true });
            await writeFile(install().supervisorFile, JSON.stringify({ restarts: 0, lastExit: null }));
        };
        const update = (argv: string[], extra: { pickupMs?: number; allowLoopbackHttp?: boolean } = {}) =>
            main(['update', ...argv], {
                paths: paths(),
                install: install(),
                env: { AGENTIC_RELEASES: server.origin },
                ...io(),
                update: { allowLoopbackHttp: extra.allowLoopbackHttp ?? true, platformKey: KEY, pollMs: 10, check: async () => 'agentic-daemon 0.2.0', ...(extra.pickupMs ? { pickupMs: extra.pickupMs } : {}) }
            });

        it('run: hello carries the build, features and the supervisor state; a rolled-back update is reported once', async () => {
            const relay = await startRelay();
            let stop!: () => void;
            const until = new Promise<void>((r) => (stop = r));
            try {
                await pairedWith(relay);
                await mkdir(install().stateDir, { recursive: true });
                await writeFile(install().supervisorFile, JSON.stringify({ restarts: 2, lastExit: { at: 5, code: 75, signal: null } }));
                await writeFile(install().updateFailedFile, JSON.stringify({ from: '0.1.0', to: '0.2.0', at: 6, reason: 'not-ready' }));
                const running = main(['run'], { paths: paths(), install: install(), env: { AGENTIC_INSTALL_DIR: install().root }, drivers: [scripted()], ...io(), until, backoff: { initialMs: 5, maxMs: 20 } });
                const seat = await relay.nextSeat();
                const hello = await expectFrame(seat, 'hello');
                expect(hello.build).toEqual({ version: DAEMON_VERSION, commit: DAEMON_COMMIT, protocol: DAEMON_PROTOCOL_VERSION, channel: DAEMON_CHANNEL, platform: `${process.platform}-${process.arch}` });
                expect(hello.features).toEqual(['update', 'policy']);
                expect(hello).toMatchObject({ restarts: 2, lastExit: { at: 5, reason: 'update', code: 75 }, lastUpdate: { from: '0.1.0', to: '0.2.0', outcome: 'rolled-back', at: 6, error: 'not-ready' } });
                seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
                await vi.waitFor(() => expect(existsSync(install().updateFailedFile)).toBe(false));
                stop();
                expect(await running).toBe(0);
            } finally {
                stop();
                await relay.close();
            }
        });

        it('run: without the supervisor it offers no update and refuses one unsupported', async () => {
            const relay = await startRelay();
            let stop!: () => void;
            const until = new Promise<void>((r) => (stop = r));
            try {
                await pairedWith(relay);
                const running = main(['run'], { paths: paths(), install: install(), drivers: [scripted()], ...io(), until, backoff: { initialMs: 5, maxMs: 20 } });
                const seat = await relay.nextSeat();
                expect((await expectFrame(seat, 'hello')).features).toEqual(['policy']);
                seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
                seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'update.request', requestId: 'upd_x', target: 'previous', mode: 'now', drainTimeoutMs: 1_000 });
                expect(await expectFrame(seat, 'update.status')).toMatchObject({ requestId: 'upd_x', phase: 'failed', error: { code: 'unsupported' } });
                stop();
                expect(await running).toBe(0);
            } finally {
                stop();
                await relay.close();
            }
        });

        it('run: an update.request stages the release, restarts with code update, removes state/ready and exits 75', async () => {
            const relay = await startRelay();
            try {
                await pairedWith(relay);
                await supervise();
                const target = { url: 'https://github.com/andtii/agentic/releases/download/daemon-v0.2.0/agentic-daemon-test.zip', sha256: release.sha256, bytes: release.bytes.byteLength, version: '0.2.0' };
                const fetchRelease: typeof fetch = async () => new Response(release.bytes);
                const running = main(['run'], {
                    paths: paths(),
                    install: install(),
                    env: { AGENTIC_INSTALL_DIR: install().root },
                    fetch: fetchRelease,
                    update: { check: async () => 'agentic-daemon 0.2.0', pollMs: 10 },
                    drivers: [scripted()],
                    ...io(),
                    until: new Promise(() => {}),
                    backoff: { initialMs: 5, maxMs: 20 }
                });
                const seat = await relay.nextSeat();
                await expectFrame(seat, 'hello');
                seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'welcome', serverTime: Date.now(), wanted: {} });
                await vi.waitFor(() => expect(existsSync(install().readyFile)).toBe(true));
                seat.send({ v: DAEMON_PROTOCOL_VERSION, t: 'update.request', requestId: 'upd_1', target, mode: 'drain', drainTimeoutMs: 60_000 });
                const phases: string[] = [];
                while (phases.at(-1) !== 'restarting' && phases.at(-1) !== 'failed') phases.push((await expectFrame(seat, 'update.status')).phase);
                expect(phases).toEqual(['downloading', 'verifying', 'staged', 'draining', 'restarting']);
                expect(await running).toBe(EXIT_UPDATE);
                expect(exits()).toEqual([expect.objectContaining({ reason: 'update', code: 75 })]);
                expect(existsSync(install().readyFile)).toBe(false);
                expect(JSON.parse(await readFile(join(install().root, 'daemon.staged', 'package.json'), 'utf8'))).toEqual({ version: '0.2.0' });
            } finally {
                await relay.close();
            }
        });

        it('update --check prints what is installed and what is available', async () => {
            server.serve('/download/daemon-stable/manifest.json', manifest());
            expect(await update(['--check', '--channel', 'stable'])).toBe(0);
            expect(out).toEqual([`installed: ${versionLine()}`, 'available: agentic-daemon 0.2.0 (stable, abc1234) — newer']);
            expect(server.requests).toEqual(['/download/daemon-stable/manifest.json']);

            out = [];
            server.serve('/download/daemon-v0.1.0/manifest.json', manifest(DAEMON_VERSION));
            expect(await update(['--version', 'daemon-v0.1.0'])).toBe(1);
            expect(out.join('\n')).toContain('does not run under the supervisor');
            expect(await update(['--channel', 'nightly'])).toBe(2);
            server.serve('/download/daemon-latest/manifest.json', manifest(DAEMON_VERSION));
            out = [];
            expect(await update([])).toBe(0);
            expect(out.at(-1)).toBe('already up to date');
        });

        it('update reads releases over https: only', async () => {
            server.serve('/download/daemon-stable/manifest.json', manifest());
            expect(await update(['--check', '--channel', 'stable'], { allowLoopbackHttp: false })).toBe(1);
            expect(out.join('\n')).toContain('https: only');
            expect(server.requests).toEqual([]);
        });

        it('update stages the release and waits for the daemon to come back on it', async () => {
            await supervise();
            server.serve('/download/daemon-stable/manifest.json', manifest());
            // The running daemon and the supervisor, as far as the CLI sees them: the request is taken, the new version is ready.
            const daemon = setInterval(() => {
                const request = join(install().stateDir, 'update-request.json');
                if (!existsSync(request)) return;
                clearInterval(daemon);
                const { mode } = JSON.parse(readFileSync(request, 'utf8')) as { mode: string };
                rmSync(request);
                writeFileSync(install().readyFile, JSON.stringify({ version: '0.2.0', pid: 1, at: Date.now(), mode }));
            }, 5);
            try {
                expect(await update(['--channel', 'stable', '--now'])).toBe(0);
            } finally {
                clearInterval(daemon);
            }
            expect(out.at(-1)).toBe('updated: agentic-daemon 0.2.0 is running');
            expect(JSON.parse(await readFile(install().readyFile, 'utf8'))).toMatchObject({ mode: 'now' });
            expect(JSON.parse(await readFile(join(install().root, 'daemon.staged', 'package.json'), 'utf8'))).toEqual({ version: '0.2.0' });
        });

        it('update: a tampered release, or a daemon that never takes the request, leaves nothing staged', async () => {
            await supervise();
            const tampered = new Uint8Array(release.bytes);
            tampered[0]! ^= 0xff;
            server.serve('/download/daemon-v0.2.0/agentic-daemon.zip', tampered);
            server.serve('/download/daemon-stable/manifest.json', manifest());
            expect(await update(['--channel', 'stable'])).toBe(1);
            expect(out.join('\n')).toContain('update failed (checksum)');
            expect(existsSync(join(install().root, 'daemon.staged'))).toBe(false);

            out = [];
            server.serve('/download/daemon-v0.2.0/agentic-daemon.zip', release.bytes);
            expect(await update(['--channel', 'stable'], { pickupMs: 50 })).toBe(1);
            expect(out.join('\n')).toContain('did not take the update');
            expect(existsSync(join(install().root, 'daemon.staged'))).toBe(false);
            expect(existsSync(join(install().stateDir, 'update-request.json'))).toBe(false);
        });
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
