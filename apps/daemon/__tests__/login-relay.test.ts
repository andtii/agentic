/**
 * A sign-in relayed to the web (#484): the parsers over what the real CLIs print (the #483 spike's captures), and
 * `spawnLoginRelay` over a fake CLI — the action, the paste to stdin, `done` on exit 0, `failed` with the last stderr
 * line on a non-zero exit (the pasted code redacted), `cancelled`, `timeout` — plus the daemon's `login` port: which
 * runtimes relay on a machine, and the CLI it resolves.
 */
// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { decodeDaemonFrame, DAEMON_PROTOCOL_VERSION as V, type DaemonFrame, type DaemonFrameOf, type DaemonFrameType } from '@agentic/daemon-protocol';
import type { PlatformSeat } from '@agentic/daemon-protocol/testing';
import { createDaemon, type Daemon } from '../src/daemon';
import { ndjsonEventLog } from '../src/event-log';
import { createLogger } from '../src/logger';
import { scriptedDriver } from './helpers/drivers';
import { startRelay, TEST_MACHINE, type Relay } from './helpers/relay';
import { loginPort, onPath, SIGN_INS } from '../src/env-cli';
import type { HarnessLocator } from '../src/harness';
import { parseClaudeLogin, parseCodexLogin, parseCopilotLogin, spawnLoginRelay, stripAnsi, type LoginRelayEvent } from '../src/login-relay';

const FAKE = fileURLToPath(new URL('./helpers/fake-login.mjs', import.meta.url));

const CLAUDE_OUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Aprofile&code_challenge=6B4M&code_challenge_method=S256&state=xa00f
Paste code here if prompted > `;
const CODEX_OUT = `
Welcome to Codex [v\x1b[90m0.154.0\x1b[0m]
\x1b[90mOpenAI's command-line coding agent\x1b[0m

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m
   \x1b[94mRGM1-ZUVN0\x1b[0m

\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m
`;
const COPILOT_OUT = 'To authenticate, visit https://github.com/login/device and enter code 024D-01A7\nWaiting for authorization...\n';

const collect = async (events: AsyncIterable<LoginRelayEvent>, on?: (e: LoginRelayEvent) => void): Promise<LoginRelayEvent[]> => {
    const out: LoginRelayEvent[] = [];
    for await (const e of events) {
        out.push(e);
        on?.(e);
    }
    return out;
};
/** Whether `pid` has exited within `ms`: signal 0 probes it without touching it. */
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
};
const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (alive(pid)) {
        if (Date.now() > until) {
            process.kill(pid);
            return false;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    return true;
};
const relay = (kind: string, extra: string[] = [], timeoutMs?: number) =>
    spawnLoginRelay({ command: process.execPath, args: [FAKE, '--kind', kind, ...extra], env: process.env, parse: kind === 'claude' ? parseClaudeLogin : kind === 'codex' ? parseCodexLogin : parseCopilotLogin, ...(timeoutMs ? { timeoutMs } : {}) });

describe('the login parsers (#483 captures)', () => {
    it('Claude Code: the authorize URL, and a code is expected back', () => {
        expect(parseClaudeLogin(CLAUDE_OUT)).toEqual({ kind: 'open-url', url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&scope=user%3Aprofile&code_challenge=6B4M&code_challenge_method=S256&state=xa00f', expectsPaste: true });
        expect(parseClaudeLogin('Opening browser to sign in…\n')).toBeNull();
    });

    it('Codex: the device URL and the one-time code, colours stripped; nothing until both are there', () => {
        expect(parseCodexLogin(stripAnsi(CODEX_OUT))).toEqual({ kind: 'device-code', url: 'https://auth.openai.com/codex/device', code: 'RGM1-ZUVN0', expectsPaste: false });
        expect(parseCodexLogin(stripAnsi(CODEX_OUT).split('2. Enter')[0]!)).toBeNull();
        expect(stripAnsi('\x1b[94mRGM1-ZUVN0\x1b[0m')).toBe('RGM1-ZUVN0');
    });

    it('Copilot: the device URL and code; the web flow as a URL to open', () => {
        expect(parseCopilotLogin(COPILOT_OUT)).toEqual({ kind: 'device-code', url: 'https://github.com/login/device', code: '024D-01A7', expectsPaste: false });
        expect(parseCopilotLogin("Opening your browser to authenticate...\nIf it doesn't open automatically, visit:\nhttps://github.com/login/oauth/authorize?client_id=x\nWaiting for authorization...\n")).toEqual({ kind: 'open-url', url: 'https://github.com/login/oauth/authorize?client_id=x', expectsPaste: false });
        expect(parseCopilotLogin('Waiting for authorization...\n')).toBeNull();
    });
});

describe('spawnLoginRelay over a fake CLI', () => {
    it('Claude: the action, waiting, the pasted code to stdin, done on exit 0', { timeout: 15_000 }, async () => {
        const r = relay('claude', ['--accept', 'code-1']);
        const events = await collect(r.events, (e) => { if (e.phase === 'waiting') r.answer('code-1'); });
        expect(events.map((e) => e.phase)).toEqual(['action', 'waiting', 'done']);
        expect(events[0]).toMatchObject({ action: { kind: 'open-url', expectsPaste: true } });
        expect((events[0] as { action: { url: string } }).action.url).toMatch(/^https:\/\/claude\.example\.test\/oauth\/authorize\?code=true/);
    });

    it('a wrong code fails with the CLI’s last stderr line, and the code itself is never in it', { timeout: 15_000 }, async () => {
        const r = relay('claude', ['--accept', 'code-1']);
        const events = await collect(r.events, (e) => { if (e.phase === 'waiting') r.answer('wrong-9'); });
        expect(events.at(-1)).toEqual({ phase: 'failed', error: { code: 'failed', message: 'Login failed: Request failed with status code 400' } });
    });

    it('a CLI that exits at once with an error fails with its reason; answer() with nothing expected is ignored', { timeout: 15_000 }, async () => {
        const r = relay('codex', ['--bad']);
        r.answer('nothing');
        const events = await collect(r.events);
        expect(events).toEqual([{ phase: 'failed', error: { code: 'failed', message: 'Error: the browser could not be opened and no code was given' } }]);
    });

    it('Codex and Copilot: a device code, then done on their own', { timeout: 15_000 }, async () => {
        const codex = await collect(relay('codex').events);
        expect(codex).toEqual([{ phase: 'action', action: { kind: 'device-code', url: 'https://auth.openai.example.test/codex/device', code: 'RGM1-ZUVN0', expectsPaste: false } }, { phase: 'waiting' }, { phase: 'done' }]);
        const copilot = await collect(relay('copilot').events);
        expect(copilot).toEqual([{ phase: 'action', action: { kind: 'device-code', url: 'https://github.example.test/login/device', code: '024D-01A7', expectsPaste: false } }, { phase: 'waiting' }, { phase: 'done' }]);
    });

    it('cancel kills the child and ends cancelled; the timeout ends it timeout — and the CLI itself is gone either way (#520)', { timeout: 20_000 }, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'login-relay-'));
        try {
            const cancelledPid = join(dir, 'cancelled.pid');
            const r = relay('copilot', ['--hang', '--pid-file', cancelledPid]);
            const events = await collect(r.events, (e) => { if (e.phase === 'waiting') r.cancel(); });
            expect(events.map((e) => e.phase)).toEqual(['action', 'waiting', 'failed']);
            expect(events.at(-1)).toMatchObject({ error: { code: 'cancelled' } });
            const timedPid = join(dir, 'timed.pid');
            const slow = relay('claude', ['--hang', '--pid-file', timedPid], 300);
            const timed = await collect(slow.events);
            expect(timed.at(-1)).toEqual({ phase: 'failed', error: { code: 'timeout', message: 'the sign-in was not completed in time' } });
            // On Windows the CLI runs under `cmd.exe`: killing only the wrapper left it running (#520).
            // Both are probed (and killed if still there) before either is asserted, so a failing run leaks nothing.
            const gone = await Promise.all([cancelledPid, timedPid].map(async (file) => goneWithin(Number(await readFile(file, 'utf8')), 5_000)));
            expect(gone).toEqual([true, true]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('a command that cannot start fails at once', { timeout: 15_000 }, async () => {
        const r = spawnLoginRelay({ command: join(tmpdir(), 'no-such-cli-484'), args: [], env: process.env, parse: parseClaudeLogin, platform: 'linux' });
        const events = await collect(r.events);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ phase: 'failed', error: { code: 'failed' } });
    });
});

describe('the daemon’s login port', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-login-port-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // Both spellings on whichever OS the suite runs: a fake `exists` over a fixed set, so a Windows temp path is never
    // parsed as a POSIX `PATH` (its drive colon would split it) and a `.cmd` never has to exist on Linux.
    it('finds a command on PATH per platform: PATHEXT and ; on Windows, the bare name and : on POSIX', () => {
        const files = new Set(['C:\\tools\\copilot.cmd', 'C:\\tools\\node.exe', '/usr/local/bin/copilot', '/usr/local/bin/gh']);
        const has = (p: string): boolean => files.has(p);
        const WIN = { PATH: 'C:\\windows;C:\\tools\\', PATHEXT: '.EXE;.CMD' };
        const POSIX = { PATH: '/usr/bin:/usr/local/bin' };
        expect(onPath('copilot', WIN, 'win32', has)).toBe(true);
        expect(onPath('node', WIN, 'win32', has)).toBe(true);
        expect(onPath('gh', WIN, 'win32', has)).toBe(false);
        // A PATHEXT that does not name the extension the file has: not found, like `cmd.exe`.
        expect(onPath('copilot', { ...WIN, PATHEXT: '.EXE' }, 'win32', has)).toBe(false);
        expect(onPath('copilot', { Path: 'C:\\tools' }, 'win32', has)).toBe(true); // `Path` as Windows spells it
        expect(onPath('copilot', POSIX, 'linux', has)).toBe(true);
        expect(onPath('gh', POSIX, 'linux', has)).toBe(true);
        expect(onPath('copilot.cmd', POSIX, 'linux', has)).toBe(false);
        expect(onPath('copilot', {}, 'linux', has)).toBe(false);
        // An absolute command is checked as it stands, in the target platform's spelling.
        expect(onPath('C:\\tools\\copilot.cmd', {}, 'win32', has)).toBe(true);
        expect(onPath('C:\\tools\\copilot', {}, 'win32', has)).toBe(true); // PATHEXT applies to it too
        expect(onPath('/usr/local/bin/gh', {}, 'linux', has)).toBe(true);
        expect(onPath('/usr/local/bin/nope', {}, 'linux', has)).toBe(false);
        // And against the real filesystem, on whichever OS this runs: this Node exists, a sibling nonsense name does not.
        expect(onPath(process.execPath, {})).toBe(true);
        expect(onPath(join(dir, 'no-such-cli'), {})).toBe(false);
    });

    // A Windows machine as the daemon would see it, on whichever OS this runs: a fake `PATH` probe and a fake spawn.
    it('relays the runtimes whose CLI is here — the harness executable first, the shipped launcher, else PATH — and starts a relay under the profile', () => {
        const TOOLS = 'C:\\tools';
        const HARNESS = 'C:\\harnesses\\claude-code\\2.1.0\\claude.exe';
        const files = new Set([HARNESS]);
        const env = (runtime: string, profileDir?: string): LocalEnvironment => ({ id: `env_${runtime}` as EnvironmentId, name: runtime, runtime, cwdRoots: ['C:\\Dev'], concurrency: 1, ...(profileDir ? { profileDir } : {}) });
        const started: { command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }[] = [];
        const spawn = ((spec: { command: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> }) => {
            started.push(spec);
            return { events: (async function* () { yield { phase: 'done' as const }; })(), answer: () => undefined, cancel: () => undefined };
        }) as unknown as typeof spawnLoginRelay;
        const harnesses: HarnessLocator = { locate: (runtime) => (runtime === 'claude-code' ? { runtime, version: '2.1.0', dir: 'C:\\harnesses\\claude-code\\2.1.0', binary: HARNESS, source: 'store', installedAt: 1 } : undefined) };
        const port = loginPort({ env: { PATH: TOOLS, PATHEXT: '.EXE;.CMD', CLAUDE_CONFIG_DIR: 'C:\\elsewhere', ANTHROPIC_API_KEY: 'sk-x' }, harnesses, platform: 'win32', spawn, exists: (p) => files.has(p) });
        expect(port.relays('claude-code')).toBe(true); // its harness is installed
        expect(port.relays('codex-cli')).toBe(SIGN_INS['codex-cli']!.prefix !== undefined); // the shipped launcher, when this daemon has it
        expect(port.relays('copilot-cli')).toBe(false); // not on this PATH
        expect(port.relays('in-memory')).toBe(false); // no sign-in at all
        expect(port.start(env('copilot-cli'))).toBeNull();
        expect(port.start(env('claude-code', 'C:\\profiles\\work'))).not.toBeNull();
        expect(started[0]).toMatchObject({ command: HARNESS, args: ['auth', 'login', '--claudeai'] });
        // The profile's own environment: the daemon's config dir and every ANTHROPIC_* removed, the profile in.
        expect(started[0]!.env.CLAUDE_CONFIG_DIR).toBe('C:\\profiles\\work');
        expect(started[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
        // `copilot` appears on PATH: the row relays from then on, from PATH and not from a harness.
        files.add('C:\\tools\\copilot.cmd');
        expect(port.relays('copilot-cli')).toBe(true);
        port.start(env('copilot-cli', 'C:\\profiles\\oc'));
        expect(started[1]).toMatchObject({ command: 'copilot', args: ['login', '--device-code'] });
        expect(started[1]!.env.COPILOT_HOME).toBe('C:\\profiles\\oc');
    });
});

describe('the daemon over the login port', () => {
    let dir: string;
    let relay: Relay;
    const daemons: Daemon[] = [];
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-daemon-login-'));
        relay = await startRelay();
    });
    afterEach(async () => {
        for (const d of daemons.splice(0)) await d.stop();
        await relay.close();
        await rm(dir, { recursive: true, force: true });
    });
    const next = async (seat: PlatformSeat): Promise<DaemonFrame> => {
        const decoded = decodeDaemonFrame((await seat.next()) as string);
        if (!decoded.ok) throw new Error(decoded.error.message);
        return decoded.frame;
    };
    const expectFrame = async <T extends DaemonFrameType>(seat: PlatformSeat, t: T): Promise<DaemonFrameOf<T>> => {
        for (;;) {
            const frame = await next(seat);
            if (frame.t === t) return frame as DaemonFrameOf<T>;
            if (frame.t !== 'heartbeat' && frame.t !== 'telemetry') throw new Error(`expected ${t}, got ${frame.t}`);
        }
    };

    it('relays a sign-in end to end: the phases, the paste to the child and nowhere else, one per environment, unknown and unsupported refused, an env after done', { timeout: 20_000 }, async () => {
        const lines: string[] = [];
        const driver = scriptedDriver({ events: 1, heartbeatMs: 1_000 });
        driver.auth.set('env_a', 'missing');
        const CODE = 'paste-me-7f3a';
        const daemon = createDaemon({
            credentials: { url: relay.url, machineId: TEST_MACHINE, token: relay.token },
            environments: [{ id: 'env_a' as EnvironmentId, name: 'a', runtime: 'scripted', cwdRoots: [dir], concurrency: 1 }, { id: 'env_b' as EnvironmentId, name: 'b', runtime: 'scripted', cwdRoots: [dir], concurrency: 1 }],
            drivers: [driver],
            eventLog: ndjsonEventLog(join(dir, 'sessions')),
            logger: createLogger({ write: (l) => lines.push(l), level: 'debug' }),
            backoff: { initialMs: 5, maxMs: 20 },
            heartbeatMs: 1_000,
            login: {
                relays: (runtime) => runtime === 'scripted',
                start: (environment) => {
                    // The port may still decline one environment (a profile it cannot start under): `unsupported`.
                    if (environment.id === 'env_b') return null;
                    const r = spawnLoginRelay({ command: process.execPath, args: [FAKE, '--kind', 'claude', '--url', 'https://claude.example.test/auth', '--accept', CODE], env: process.env, parse: parseClaudeLogin });
                    const events: AsyncIterable<LoginRelayEvent> = {
                        async *[Symbol.asyncIterator]() {
                            for await (const e of r.events) {
                                if (e.phase === 'done') driver.auth.set(environment.id, 'ok');
                                yield e;
                            }
                        }
                    };
                    return { events, answer: (t) => r.answer(t), cancel: () => r.cancel() };
                }
            }
        });
        daemons.push(daemon);
        await daemon.start();
        const seat = await relay.nextSeat();
        const hello = await expectFrame(seat, 'hello');
        expect(hello.features).toContain('login');
        expect(hello.capabilities.map((c) => [c.runtime, c.login])).toEqual([['scripted', 'relay']]);
        seat.send({ v: V, t: 'welcome', serverTime: Date.now(), wanted: {} });

        seat.send({ v: V, t: 'login.request', requestId: 'login_1', environmentId: 'env_a' as EnvironmentId });
        const phases: string[] = [];
        let action: DaemonFrameOf<'login.status'>['action'];
        for (;;) {
            const frame = await expectFrame(seat, 'login.status');
            expect(frame.requestId).toBe('login_1');
            phases.push(frame.phase);
            if (frame.phase === 'action') action = frame.action;
            if (frame.phase === 'waiting') seat.send({ v: V, t: 'login.answer', requestId: 'login_1', text: CODE });
            if (frame.phase === 'done' || frame.phase === 'failed') break;
        }
        expect(phases).toEqual(['started', 'action', 'waiting', 'done']);
        expect(action).toEqual({ kind: 'open-url', url: 'https://claude.example.test/auth', expectsPaste: true });
        const env = await expectFrame(seat, 'env');
        expect(env.environments.find((e) => e.id === 'env_a')?.account.authStatus).toBe('ok');
        // The code reached the child (it exited 0) and nothing else: not the log, not a file under the daemon's folders.
        expect(lines.join('\n')).not.toContain(CODE);
        expect(lines.some((l) => l.includes('login: done'))).toBe(true);
        for (const f of await readdir(dir, { recursive: true })) {
            const full = join(dir, f);
            if ((await stat(full)).isFile()) expect(await readFile(full, 'utf8')).not.toContain(CODE);
        }

        // Refusals: an environment the machine lacks, one the port declines, a second sign-in while one runs.
        seat.send({ v: V, t: 'login.request', requestId: 'login_2', environmentId: 'env_nope' as EnvironmentId });
        expect(await expectFrame(seat, 'login.status')).toMatchObject({ requestId: 'login_2', phase: 'failed', error: { code: 'unknown-environment' } });
        seat.send({ v: V, t: 'login.request', requestId: 'login_3', environmentId: 'env_b' as EnvironmentId });
        expect(await expectFrame(seat, 'login.status')).toMatchObject({ requestId: 'login_3', phase: 'failed', error: { code: 'unsupported' } });
        seat.send({ v: V, t: 'login.request', requestId: 'login_4', environmentId: 'env_a' as EnvironmentId });
        expect((await expectFrame(seat, 'login.status')).phase).toBe('started');
        seat.send({ v: V, t: 'login.request', requestId: 'login_5', environmentId: 'env_a' as EnvironmentId });
        expect(await expectFrame(seat, 'login.status')).toMatchObject({ requestId: 'login_5', phase: 'failed', error: { code: 'busy' } });
        // Cancelled from the web: failed { cancelled }, then the re-inspect's env.
        seat.send({ v: V, t: 'login.cancel', requestId: 'login_4' });
        for (;;) {
            const frame = await expectFrame(seat, 'login.status');
            if (frame.phase === 'failed' || frame.phase === 'done') {
                expect(frame).toMatchObject({ requestId: 'login_4', phase: 'failed', error: { code: 'cancelled' } });
                break;
            }
        }
        await expectFrame(seat, 'env');
    });
});
