/** `daemonConformance` against the real daemon: real WebSockets, NDJSON logs on disk, a scripted runtime. */
// @vitest-environment node
import type { EnvironmentDescriptor, EnvironmentId, LocalEnvironment, MachinePolicy, ReleaseAsset, RuntimeId, SessionId } from '@agentic/core';
import { daemonConformance, type ConformanceDaemon, type ConformanceFiles, type DaemonConformanceHarness } from '@agentic/daemon-protocol/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon, type Daemon } from '../src/daemon';
import { writeEnvironments } from '../src/env-store';
import { ndjsonEventLog, type NdjsonEventLog } from '../src/event-log';
import { harnessStore } from '../src/harness';
import { loadPolicy, localEdit, withLock, writePolicy } from '../src/policy';
import { applyWebPolicy, browseMachine } from '../src/policy-web';
import { tailLog } from '../src/log-tail';
import { parseClaudeLogin, spawnLoginRelay, type LoginRelayEvent } from '../src/login-relay';
import { namingDriver } from './helpers/drivers';
import { releaseZip } from './helpers/release';
import { fakeHarnessZip, fakeReleases } from './helpers/harness';
import { startRelay, TEST_MACHINE } from './helpers/relay';

const toLocal = (d: EnvironmentDescriptor): LocalEnvironment => ({
    id: d.id,
    name: d.name,
    runtime: d.runtime,
    cwdRoots: d.cwdRoots,
    concurrency: d.concurrency.max,
    accountLabel: d.account.label
});

/** One hand-written checkout of this origin under the work root, so `fs-locate` proves a match (#331). */
const KNOWN_ORIGIN = 'https://github.com/andtii/agentic.git';

/**
 * The release `update-drain` / `update-cancel` update to (#364): a real zip (its `bin/agentic-daemon.mjs` is run once with
 * `--version`), named by an `https:` URL as the platform's frames require and served by an injected `fetch`.
 */
const releaseDir = mkdtempSync(join(tmpdir(), 'agentic-daemon-conf-release-'));
const release = releaseZip(releaseDir, '0.2.0');
const UPDATE_TARGET = { url: 'https://github.com/andtii/agentic/releases/download/daemon-v0.2.0/agentic-daemon-conformance.zip', sha256: release.sha256, bytes: release.bytes.byteLength, version: '0.2.0' };
const serveRelease: typeof fetch = async (input) => (String(input) === UPDATE_TARGET.url ? new Response(release.bytes) : new Response(null, { status: 404 }));
afterAll(() => rm(releaseDir, { recursive: true, force: true }));
/** The harness build `harness-install` installs (#369): a package for the scripted runtime, served at an `https:` URL through the daemon's `fetch`. */
const releases = fakeReleases();
let harnessTarget: { readonly runtime: RuntimeId; readonly asset: ReleaseAsset } | undefined;
/** The daemon's configuration folder of the daemon under test (#355): a policy must refuse it, a listing never show it. */
let protectedFolder: string | undefined;
/** The session folders the `files` cases read (#561): a real git repo with one committed-then-changed file, and a plain folder. */
let filesFolders: ConformanceFiles | undefined;
const FILES_TEXT = 'changed by the session\n';
/** A real git repo at `dir` whose `src/app.txt` was committed, then changed on disk. */
async function seedRepo(dir: string): Promise<void> {
    await mkdir(join(dir, 'src'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'conformance@example.test');
    git('config', 'user.name', 'conformance');
    git('config', 'core.autocrlf', 'false');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(dir, 'src', 'app.txt'), 'committed\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    await writeFile(join(dir, 'src', 'app.txt'), FILES_TEXT);
}
/** How many lines the daemon under test's log holds (#481). */
const LOG_LINES = 12;
/** The sign-in `login-relay` relays (#484): a fake Claude Code CLI that prints this URL and takes this code on stdin. */
const FAKE_LOGIN = fileURLToPath(new URL('./helpers/fake-login.mjs', import.meta.url));
const LOGIN_URL = 'https://claude.example.test/oauth/authorize?code=true&client_id=conformance';
const LOGIN_ANSWER = 'conformance-code-1';
let zips: string;
beforeAll(async () => {
    zips = await mkdtemp(join(tmpdir(), 'agentic-daemon-conf-zips-'));
    const zip = await fakeHarnessZip(zips, 'scripted', '1.1.0');
    releases.put('harness-scripted.zip', zip.bytes);
    harnessTarget = { runtime: 'scripted', asset: zip.asset(releases.url('harness-scripted.zip')) };
});
afterAll(async () => {
    await rm(zips, { recursive: true, force: true });
});

const harness: DaemonConformanceHarness = {
    // `session-ref` (#389): the scripted runtime names its session on the first prompt, so the daemon's `session.ref` is proven here too.
    // `history` (#397): answered from the NDJSON log on disk; `truncateLog` is the log's own `truncate`, so the gap case is real.
    // `resume` (#363): `restart` stops the daemon the way SIGTERM does and starts a new one over the same state dir, so the
    // wanted session is answered from the NDJSON log with code `restart` and re-opened from `spec.resume` on the next epoch.
    // `build` / `update` (#364): `hello` carries the build and `features: ['update']`; the update client downloads `updateTarget`
    // into a temp install root, and its restart is `stop({ reason: 'update' })` — what `run` does before it exits 75.
    // `harness` (#369): a real harness store under the daemon's dir; the install downloads through the injected `fetch`.
    // `policy` (#355): a real `policy.json`, the web port over `policy-web.ts` with `~` expanding to a folder under the temp dir,
    // the configuration folder as the one a policy must refuse and a listing must never show, and `lock` writing the file.
    // `restart` / `log` (#481): `update.request { target: 'restart' }` stops the daemon with reason `restart` (what `run` does before it
    // exits 75 with nothing staged); the log is a real file of `LOG_LINES` lines under the state dir, tailed through `tailLog`.
    // `login` (#484): the real relay (`spawnLoginRelay`, the Claude parser) over a fake CLI with piped stdio; `done` flips the
    // scripted driver's account to `ok` before the daemon re-inspects, so the `env` after `done` is the real re-inspect.
    features: ['env', 'gap', 'raw', 'fs', 'files', 'env-manage', 'session-ref', 'history', 'resume', 'build', 'update', 'harness', 'policy', 'restart', 'log', 'login'],
    logLines: LOG_LINES,
    loginAction: { kind: 'open-url', url: LOGIN_URL, expectsPaste: true },
    loginAnswer: LOGIN_ANSWER,
    updateTarget: UPDATE_TARGET,
    knownOrigin: KNOWN_ORIGIN,
    get harnessTarget() {
        return harnessTarget;
    },
    get protectedFolder() {
        return protectedFolder;
    },
    // `files` (#561): a real git repo under the work root, changed after its commit, beside a folder under no version control.
    get files() {
        return filesFolders;
    },
    async start(script): Promise<ConformanceDaemon> {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-conf-'));
        // The machine's own folders beside the one its owner allowed (#238): configuration, state, and the work.
        const paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), environmentsFile: join(dir, 'config', 'environments.json'), policyFile: join(dir, 'config', 'policy.json') };
        protectedFolder = paths.configDir;
        const home = join(dir, 'home');
        await mkdir(join(home, 'src'), { recursive: true });
        await mkdir(paths.stateDir, { recursive: true });
        await mkdir(join(dir, 'work', 'agentic', '.git'), { recursive: true });
        await writeFile(join(dir, 'work', 'agentic', '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(dir, 'work', 'agentic', '.git', 'config'), `[remote "origin"]\n\turl = ${KNOWN_ORIGIN}\n`);
        const work = await realpath(join(dir, 'work'));
        // `files` (#561): the session folder is a real repo; `plain` is under no version control.
        await seedRepo(join(work, 'project'));
        await mkdir(join(work, 'plain'), { recursive: true });
        filesFolders = { root: join(work, 'project'), file: { path: 'src/app.txt', text: FILES_TEXT }, changed: true, plain: join(work, 'plain') };
        let relay = await startRelay();
        const driver = namingDriver(script);
        let log: NdjsonEventLog;
        const environments: LocalEnvironment[] = [{ id: 'env_scripted' as EnvironmentId, name: 'scripted', runtime: 'scripted', cwdRoots: [work], concurrency: 4 }];
        const secure = { run: async () => ({ code: 0, stderr: '' }) };
        const store = harnessStore({ root: join(dir, 'install', 'harnesses'), bundled: false });
        await writeEnvironments(paths.environmentsFile, environments, secure);
        const policy: MachinePolicy = { webManaged: true, allowedRoots: [work] };
        await writePolicy(paths.policyFile, policy, secure);
        const web = { paths, profileDirs: [join(paths.configDir, 'profiles')], home, secure };
        const logFile = join(paths.stateDir, 'logs', 'daemon.log');
        await mkdir(join(paths.stateDir, 'logs'), { recursive: true });
        await writeFile(logFile, Array.from({ length: LOG_LINES }, (_, i) => JSON.stringify({ level: 'info', msg: `line ${i + 1}` })).join('\n') + '\n');
        // A new process each time: a fresh log handle over the same files.
        const create = (): Daemon =>
            createDaemon({
                credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
                environments,
                policy,
                manage: { paths, secure },
                webPolicy: { apply: (input) => applyWebPolicy(input, web), browse: (path) => browseMachine(path, web) },
                logTail: (lines) => tailLog(logFile, lines),
                login: {
                    relays: (runtime) => runtime === 'scripted',
                    start: (environment) => {
                        const relay = spawnLoginRelay({ command: process.execPath, args: [FAKE_LOGIN, '--kind', 'claude', '--url', LOGIN_URL, '--accept', LOGIN_ANSWER], env: process.env, parse: parseClaudeLogin });
                        const events: AsyncIterable<LoginRelayEvent> = {
                            async *[Symbol.asyncIterator]() {
                                for await (const e of relay.events) {
                                    if (e.phase === 'done') driver.auth.set(environment.id, 'ok');
                                    yield e;
                                }
                            }
                        };
                        return { events, answer: (text) => relay.answer(text), cancel: () => relay.cancel() };
                    }
                },
                drivers: [driver],
                eventLog: (log = ndjsonEventLog(join(paths.stateDir, 'sessions'))),
                heartbeatMs: script.heartbeatMs,
                backoff: { initialMs: 5, maxMs: 20 },
                update: { root: join(dir, 'install'), fetch: serveRelease, pollMs: 20, restart: (why): Promise<void> => daemon.stop({ reason: why }) },
                harnesses: { store, fetch: releases.fetch, rebuild: () => driver }
            });
        let daemon = create();
        let started = false;
        return {
            machineId: TEST_MACHINE as ConformanceDaemon['machineId'],
            environmentId: environments[0]!.id,
            async dial() {
                if (!started) {
                    started = true;
                    await daemon.start();
                }
                return relay.nextSeat();
            },
            async setEnvironments(next) {
                for (const d of next) driver.auth.set(d.id, d.account.authStatus);
                await daemon.setEnvironments(next.map(toLocal));
            },
            async setPolicy(next) {
                await writePolicy(paths.policyFile, localEdit(next), secure);
                await daemon.setPolicy(localEdit(next));
            },
            async lock(locked) {
                const loaded = await loadPolicy(paths.policyFile);
                const next = withLock(loaded.ok ? loaded.policy : policy, locked);
                await writePolicy(paths.policyFile, next, secure);
                await daemon.setPolicy(next);
            },
            async truncateLog(sessionId: SessionId, keepFrom) {
                await log.truncate(sessionId, keepFrom);
            },
            async restart() {
                // The old process goes (closing its sessions with code `restart`) and a new one starts over the same dirs. A fresh
                // relay, so the suite's next dial is the new daemon's connection and never the old one's last redial.
                await daemon.stop({ reason: 'restart' });
                await relay.close();
                relay = await startRelay();
                daemon = create();
                started = false;
            },
            async stop() {
                await daemon.stop();
                await relay.close();
                await rm(dir, { recursive: true, force: true });
            }
        };
    }
};

describe('daemonConformance (agentic-daemon over WebSockets)', () => {
    for (const c of daemonConformance(harness, { reconnectDelayMs: 100 })) {
        it.skipIf(!!c.skip)(c.name, c.run, 20_000);
    }
});
