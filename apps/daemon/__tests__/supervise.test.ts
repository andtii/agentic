// @vitest-environment node
/**
 * The supervisor (#362): `scripts/supervise.mjs` run as the service runs it — a real `node` process on a
 * temp install root — over a fake daemon whose exits a plan file scripts. Timings are flags, so the
 * backoff, the ready timeout and the crash window take milliseconds. No service is registered.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSupervisorArgs, supervisorLayout, SUPERVISOR_VERSION } from '../scripts/supervise.mjs';
import { installPaths } from '../src/paths';

const SUPERVISE = resolve(import.meta.dirname, '..', 'scripts', 'supervise.mjs');

/** One run of the fake daemon: exit with `exit` after `delayMs`, `ready` first writes state/ready, `hang` never exits on its own. */
type Step = { exit?: number; ready?: boolean; delayMs?: number; hang?: boolean };

/**
 * A fake `bin/agentic-daemon.mjs` for version `version`: each run appends `<version>` to `runs.log` and follows
 * the next step of `plan.json[version]` (the last step repeats).
 */
const fakeDaemon = (version: string) => `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.AGENTIC_INSTALL_DIR;
const log = join(root, 'runs.log');
const n = existsSync(log) ? readFileSync(log, 'utf8').split('\\n').filter((l) => l === ${JSON.stringify(version)}).length : 0;
appendFileSync(log, ${JSON.stringify(version)} + '\\n');
const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8'))[${JSON.stringify(version)}];
const step = plan[Math.min(n, plan.length - 1)];
if (step.ready) { mkdirSync(join(root, 'state'), { recursive: true }); writeFileSync(join(root, 'state', 'ready'), '{}'); }
if (step.hang) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(step.exit ?? 0), step.delayMs ?? 0);
`;

describe('supervise.mjs', () => {
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'agentic-supervise-'));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    const install = async (folder: string, version: string) => {
        await mkdir(join(root, folder, 'bin'), { recursive: true });
        await writeFile(join(root, folder, 'bin', 'agentic-daemon.mjs'), fakeDaemon(version));
        await writeFile(join(root, folder, 'package.json'), JSON.stringify({ version }));
    };
    const plan = (steps: Record<string, Step[]>) => writeFile(join(root, 'plan.json'), JSON.stringify(steps));
    const runs = () => readFileSync(join(root, 'runs.log'), 'utf8').split('\n').filter(Boolean);
    const state = <T>(file: string): T => JSON.parse(readFileSync(join(root, 'state', file), 'utf8')) as T;
    const versionIn = (folder: string) => (JSON.parse(readFileSync(join(root, folder, 'package.json'), 'utf8')) as { version: string }).version;

    /** Run the supervisor to its own exit with fast timings; `extra` overrides them. */
    const supervise = (extra: string[] = []) =>
        new Promise<{ code: number | null; stderr: string }>((done) => {
            const timings = ['--backoff-initial-ms', '10', '--backoff-max-ms', '40', '--ready-timeout-ms', '5000', '--crash-window-ms', '20000', '--stop-timeout-ms', '2000', '--rename-retry-ms', '2000', '--ready-poll-ms', '20'];
            const child = spawn(process.execPath, [SUPERVISE, '--root', root, '--log', join(root, 'logs', 'daemon.log'), ...timings, ...extra], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
            child.on('exit', (code) => done({ code, stderr }));
        });

    it('--version, and the layout matches installPaths', () => {
        const result = spawnSync(process.execPath, [SUPERVISE, '--version'], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(`agentic-supervisor ${SUPERVISOR_VERSION}`);
        expect(spawnSync(process.execPath, [SUPERVISE], { encoding: 'utf8' }).status).toBe(2);
        expect(parseSupervisorArgs(['--root', root, '--ready-timeout-ms', '5']).timings.readyTimeoutMs).toBe(5);
        expect(parseSupervisorArgs(['--root', root, '--bogus']).error).toMatch(/--bogus/);
        const layout = supervisorLayout(root);
        const paths = installPaths({ env: { AGENTIC_INSTALL_DIR: root } });
        expect({ daemon: layout.daemonDir, ready: layout.ready, status: layout.status, failed: layout.updateFailed, log: layout.log }).toEqual({
            daemon: paths.daemonDir,
            ready: paths.readyFile,
            status: paths.supervisorFile,
            failed: paths.updateFailedFile,
            log: paths.supervisorLog
        });
    });

    it('exit 0 stops the supervisor', async () => {
        await install('daemon', '1.0.0');
        await plan({ '1.0.0': [{ exit: 0 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0']);
        expect(state<{ restarts: number; lastExit: { code: number } }>('supervisor.json')).toMatchObject({ restarts: 0, lastExit: { code: 0, signal: null } });
    });

    it('any other exit restarts after a doubling backoff and is recorded', async () => {
        await install('daemon', '1.0.0');
        await plan({ '1.0.0': [{ exit: 3 }, { exit: 3 }, { exit: 3 }, { exit: 0 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0', '1.0.0', '1.0.0', '1.0.0']);
        expect(state<{ restarts: number }>('supervisor.json').restarts).toBe(3);
        const delays = readFileSync(join(root, 'state', 'supervisor.log'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { msg: string; delayMs?: number; code?: number })
            .filter((l) => l.msg === 'supervisor: restarting after a backoff')
            .map((l) => l.delayMs);
        expect(delays).toEqual([10, 20, 40]);
        // The daemon's output goes to --log; the supervisor's own lines to state/supervisor.log.
        expect(existsSync(join(root, 'logs', 'daemon.log'))).toBe(true);
    });

    it('exit 75 without a staged folder is a plain restart', async () => {
        await install('daemon', '1.0.0');
        await plan({ '1.0.0': [{ exit: 75 }, { exit: 0 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0', '1.0.0']);
        expect(existsSync(join(root, 'daemon.prev'))).toBe(false);
    });

    it('exit 75 with a staged folder swaps it in and keeps the previous version', async () => {
        await install('daemon', '1.0.0');
        await install('daemon.staged', '2.0.0');
        await mkdir(join(root, 'state'), { recursive: true });
        await writeFile(join(root, 'state', 'ready'), 'stale');
        await plan({ '1.0.0': [{ exit: 75 }], '2.0.0': [{ ready: true, exit: 0, delayMs: 200 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0', '2.0.0']);
        expect(versionIn('daemon')).toBe('2.0.0');
        expect(versionIn('daemon.prev')).toBe('1.0.0');
        expect(existsSync(join(root, 'daemon.staged'))).toBe(false);
        expect(existsSync(join(root, 'state', 'update-failed.json'))).toBe(false);
    });

    it('a staged version that never becomes ready is rolled back', async () => {
        await install('daemon', '1.0.0');
        await install('daemon.staged', '2.0.0');
        await plan({ '1.0.0': [{ exit: 75 }, { exit: 0 }], '2.0.0': [{ hang: true }] });
        expect((await supervise(['--ready-timeout-ms', '300'])).code).toBe(0);
        expect(runs()).toEqual(['1.0.0', '2.0.0', '1.0.0']);
        expect(versionIn('daemon')).toBe('1.0.0');
        expect(existsSync(join(root, 'daemon.prev'))).toBe(false);
        expect(existsSync(join(root, 'daemon.failed'))).toBe(false);
        expect(state<Record<string, unknown>>('update-failed.json')).toMatchObject({ from: '1.0.0', to: '2.0.0', reason: 'not-ready', at: expect.any(Number) });
    });

    it('a staged version that exits twice within the window is rolled back', async () => {
        await install('daemon', '1.0.0');
        await install('daemon.staged', '2.0.0');
        await plan({ '1.0.0': [{ exit: 75 }, { exit: 0 }], '2.0.0': [{ exit: 3 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0', '2.0.0', '2.0.0', '1.0.0']);
        expect(versionIn('daemon')).toBe('1.0.0');
        expect(state<Record<string, unknown>>('update-failed.json')).toMatchObject({ from: '1.0.0', to: '2.0.0', reason: 'crashed' });
    });

    it('an interrupted swap (no daemon, a previous one) is restored at start', async () => {
        await install('daemon.prev', '1.0.0');
        await plan({ '1.0.0': [{ exit: 0 }] });
        expect((await supervise()).code).toBe(0);
        expect(runs()).toEqual(['1.0.0']);
        expect(versionIn('daemon')).toBe('1.0.0');
    });

    // Windows has no catchable SIGTERM between processes (kill is TerminateProcess).
    it.skipIf(process.platform === 'win32')('SIGTERM is forwarded to the daemon and the supervisor exits 0', async () => {
        await install('daemon', '1.0.0');
        await plan({ '1.0.0': [{ hang: true }] });
        const child = spawn(process.execPath, [SUPERVISE, '--root', root, '--stop-timeout-ms', '5000'], { stdio: 'ignore' });
        await vi.waitFor(() => expect(existsSync(join(root, 'runs.log'))).toBe(true), { timeout: 5000 });
        const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
        child.kill('SIGTERM');
        expect(await exited).toBe(0);
        expect(state<{ lastExit: { signal: string } }>('supervisor.json').lastExit.signal).toBe('SIGTERM');
        expect(await readFile(join(root, 'state', 'supervisor.log'), 'utf8')).toMatch(/supervisor: stopping/);
    });
});
