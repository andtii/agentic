#!/usr/bin/env node
/**
 * The daemon supervisor (#362): what the background service runs. It outlives
 * the daemon and keeps it running:
 *
 *   node <root>/supervisor/supervise.mjs --root <root> [--log <daemon.log>] [--daemon <dir>]
 *
 * It spawns `node <root>/daemon/bin/agentic-daemon.mjs run` and on its exit:
 *   0   → stops (the daemon was asked to stop; the service ends);
 *   75  → applies a staged update: `daemon.staged` becomes `daemon`, the old one `daemon.prev`
 *         (without a staged folder, a plain restart);
 *   any other exit → restarts after a backoff (1 s doubling to 60 s, reset after 5 min up).
 *
 * A swapped-in version must write `<root>/state/ready` (after its first `welcome`) within 90 s and
 * must not exit twice within 2 minutes; otherwise the swap is rolled back (`daemon` → `daemon.failed`,
 * `daemon.prev` → `daemon`), `state/update-failed.json` says why and the previous version starts.
 * Every exit lands in `state/supervisor.json` (`restarts`, `lastExit`) and a line in `state/supervisor.log`.
 * SIGTERM / SIGINT are forwarded to the daemon, which gets 30 s to stop.
 *
 * It lives outside `<root>/daemon/` so a swap never replaces the process doing the swap, and imports
 * node builtins only: it runs from a folder with no `node_modules`. The daemon's own side (the `ready`
 * marker, the exit reasons) is `apps/daemon/src/cli.ts`; the install layout is `installPaths` in
 * `apps/daemon/src/paths.ts`. The timings take flags so the tests run the loop in milliseconds.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPERVISOR_VERSION = '1';
/** The daemon's exit code for "apply the staged update" (EX_TEMPFAIL). */
export const EXIT_UPDATE = 75;

const USAGE = `Usage: node supervise.mjs --root <install root> [--log <file>] [--daemon <dir>]
  --root <dir>    the install root: <root>/daemon is the daemon, <root>/state the supervisor's state
  --log <file>    append the daemon's output here (default: this process's own stdout/stderr)
  --daemon <dir>  the daemon folder (default <root>/daemon); its .staged / .prev / .failed siblings are the swap
  --version`;

/** Defaults; each has a `--<kebab-name> <ms>` flag. */
const TIMINGS = {
    backoffInitialMs: 1_000,
    backoffMaxMs: 60_000,
    /** Up this long and the next crash restarts after `backoffInitialMs` again. */
    backoffResetMs: 5 * 60_000,
    /** A swapped-in version that has not written `state/ready` by then is rolled back. */
    readyTimeoutMs: 90_000,
    /** A swapped-in version that exits twice within this window is rolled back. */
    crashWindowMs: 2 * 60_000,
    /** How long a forwarded SIGTERM may take before the daemon is killed. */
    stopTimeoutMs: 30_000,
    /** Windows keeps a folder locked a moment after the process in it exits: renames retry this long. */
    renameRetryMs: 10_000,
    /** How often `state/ready` is looked for during a swap. */
    readyPollMs: 500
};

/** @param {readonly string[]} argv */
export function parseSupervisorArgs(argv) {
    /** @type {{ root?: string; log?: string; daemon?: string; version?: boolean; help?: boolean; timings: typeof TIMINGS; error?: string }} */
    const out = { timings: { ...TIMINGS } };
    const kebab = (/** @type {string} */ key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const flags = new Map(Object.keys(TIMINGS).map((key) => [`--${kebab(key)}`, key]));
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = argv[i + 1];
        if (arg === '--version') out.version = true;
        else if (arg === '--help' || arg === '-h') out.help = true;
        else if ((arg === '--root' || arg === '--log' || arg === '--daemon') && value !== undefined) {
            out[/** @type {'root' | 'log' | 'daemon'} */ (arg.slice(2))] = resolve(value);
            i++;
        } else if (flags.has(arg) && value !== undefined && /^\d+$/.test(value)) {
            out.timings[/** @type {keyof typeof TIMINGS} */ (flags.get(arg))] = Number(value);
            i++;
        } else {
            out.error = `unknown or incomplete argument ${arg}`;
            return out;
        }
    }
    if (!out.version && !out.help && !out.root) out.error = '--root is required';
    return out;
}

/** The files the supervisor and the daemon share under `<root>` (the same names as `installPaths` in src/paths.ts). */
export function supervisorLayout(/** @type {string} */ root, /** @type {string | undefined} */ daemon) {
    const daemonDir = daemon ?? join(root, 'daemon');
    const state = join(root, 'state');
    return {
        root,
        daemonDir,
        staged: `${daemonDir}.staged`,
        prev: `${daemonDir}.prev`,
        failed: `${daemonDir}.failed`,
        entry: (/** @type {string} */ dir) => join(dir, 'bin', 'agentic-daemon.mjs'),
        state,
        ready: join(state, 'ready'),
        status: join(state, 'supervisor.json'),
        updateFailed: join(state, 'update-failed.json'),
        log: join(state, 'supervisor.log')
    };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** The version in `<dir>/package.json` (the zip ships one), or null. */
function versionOf(/** @type {string} */ dir) {
    try {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null;
    } catch {
        return null;
    }
}

/**
 * Run the loop until the daemon exits 0 or the supervisor is signalled. Resolves to the supervisor's exit code.
 * @param {{ root: string; log?: string; daemon?: string; timings?: Partial<typeof TIMINGS>; signals?: boolean }} options
 */
export async function supervise(options) {
    const t = { ...TIMINGS, ...options.timings };
    const at = supervisorLayout(options.root, options.daemon);
    mkdirSync(at.state, { recursive: true });
    // Kept small: a crash loop at the backoff ceiling writes a line a minute.
    try {
        if (statSync(at.log).size > 1024 * 1024) renameSync(at.log, `${at.log}.1`);
    } catch {}

    /** @param {string} message @param {Record<string, unknown>} [fields] */
    const say = (message, fields = {}) => {
        const line = JSON.stringify({ at: new Date().toISOString(), level: 'info', msg: `supervisor: ${message}`, pid: process.pid, ...fields });
        try {
            appendFileSync(at.log, `${line}\n`);
        } catch {}
        // Also on stderr on purpose: under launchd / systemd that is daemon.log, so a restart sits next to the
        // daemon's own `daemon: exiting` line. state/supervisor.log is the durable copy (a Windows task has no stderr).
        process.stderr.write(`${line}\n`);
    };

    let restarts = 0;
    /** @type {{ at: number; code: number | null; signal: string | null } | null} */
    let lastExit = null;
    const writeStatus = () => {
        try {
            writeFileSync(at.status, `${JSON.stringify({ version: SUPERVISOR_VERSION, pid: process.pid, restarts, lastExit }, null, 2)}\n`);
        } catch (e) {
            say('cannot write supervisor.json', { error: /** @type {Error} */ (e).message });
        }
    };

    /** Rename with retries: on Windows a folder stays locked briefly after the process running from it exits. */
    const move = async (/** @type {string} */ from, /** @type {string} */ to) => {
        const deadline = Date.now() + t.renameRetryMs;
        for (;;) {
            try {
                renameSync(from, to);
                return;
            } catch (e) {
                if (Date.now() >= deadline) throw e;
                await sleep(Math.min(250, t.renameRetryMs));
            }
        }
    };
    const remove = (/** @type {string} */ dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

    /** @param {string} reason @param {string | null} from @param {string | null} to */
    const updateFailed = (reason, from, to) => {
        try {
            writeFileSync(at.updateFailed, `${JSON.stringify({ from, to, at: Date.now(), reason }, null, 2)}\n`);
        } catch {}
        say('update failed', { reason, from, to });
    };

    // A swap cut short (the machine went down between the two renames) leaves no daemon but a previous one.
    if (!existsSync(at.entry(at.daemonDir)) && existsSync(at.entry(at.prev))) {
        say('no daemon folder but a previous one: restoring it');
        await move(at.prev, at.daemonDir);
    }

    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child;
    let stopping = false;
    /** @type {(() => void) | undefined} */
    let wake;
    /** The swap in progress: rolled back unless the new version comes up. */
    /** @type {{ from: string | null; to: string | null; startedAt: number; exits: number; ready: boolean } | undefined} */
    let swap;

    const stop = (/** @type {NodeJS.Signals} */ signal) => {
        if (stopping) return;
        stopping = true;
        say('stopping', { signal });
        wake?.();
        if (child && child.exitCode === null && child.signalCode === null) {
            // The daemon stops the same way on either; SIGBREAK (Windows only) has no meaning to it.
            child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
            const kill = setTimeout(() => {
                say('the daemon did not stop in time: killing it', { timeoutMs: t.stopTimeoutMs });
                child?.kill('SIGKILL');
            }, t.stopTimeoutMs);
            kill.unref();
        }
    };
    const signals = /** @type {const} */ (['SIGTERM', 'SIGINT', ...(process.platform === 'win32' ? /** @type {const} */ (['SIGBREAK']) : [])]);
    if (options.signals !== false) for (const s of signals) process.on(s, stop);

    const applyStaged = async () => {
        const from = versionOf(at.daemonDir);
        const to = versionOf(at.staged);
        say('applying the staged update', { from, to });
        try {
            remove(at.prev);
            await move(at.daemonDir, at.prev);
        } catch (e) {
            updateFailed(`swap-failed: ${/** @type {Error} */ (e).message}`, from, to);
            return;
        }
        try {
            await move(at.staged, at.daemonDir);
        } catch (e) {
            await move(at.prev, at.daemonDir).catch(() => {});
            updateFailed(`swap-failed: ${/** @type {Error} */ (e).message}`, from, to);
            return;
        }
        rmSync(at.ready, { force: true });
        swap = { from, to, startedAt: Date.now(), exits: 0, ready: false };
    };

    const rollback = async (/** @type {string} */ reason) => {
        const failed = swap;
        swap = undefined;
        if (!failed) return;
        if (!existsSync(at.entry(at.prev))) {
            updateFailed(`${reason}; no previous version to roll back to`, failed.from, failed.to);
            return;
        }
        say('rolling back', { reason, from: failed.to, to: failed.from });
        try {
            remove(at.failed);
            await move(at.daemonDir, at.failed);
            await move(at.prev, at.daemonDir);
            remove(at.failed);
        } catch (e) {
            say('rollback failed', { error: /** @type {Error} */ (e).message });
        }
        updateFailed(reason, failed.from, failed.to);
    };

    const start = () => {
        const entry = at.entry(at.daemonDir);
        /** @type {number | undefined} */
        let fd;
        if (options.log) {
            mkdirSync(dirname(options.log), { recursive: true });
            fd = openSync(options.log, 'a');
        }
        const spawned = spawn(process.execPath, [entry, 'run'], {
            cwd: at.daemonDir,
            // The daemon finds `state/` through this, whatever root the service was registered with.
            env: { ...process.env, AGENTIC_INSTALL_DIR: at.root },
            stdio: fd === undefined ? ['ignore', 'inherit', 'inherit'] : ['ignore', fd, fd],
            windowsHide: true
        });
        if (fd !== undefined) closeSync(fd);
        say('daemon started', { daemonPid: spawned.pid, version: versionOf(at.daemonDir) });
        return spawned;
    };

    let attempt = 0;
    say('started', { version: SUPERVISOR_VERSION, root: at.root, daemon: at.daemonDir });
    writeStatus();
    try {
        for (;;) {
            if (stopping) return 0;
            if (!existsSync(at.entry(at.daemonDir))) {
                say('no daemon to run', { entry: at.entry(at.daemonDir) });
                return 1;
            }
            const startedAt = Date.now();
            child = start();
            const running = child;
            /** @type {Promise<{ code: number | null; signal: NodeJS.Signals | null }>} */
            const exited = new Promise((resolveExit) => {
                running.once('exit', (code, signal) => resolveExit({ code, signal }));
                running.once('error', (e) => {
                    say('cannot start the daemon', { error: e.message });
                    resolveExit({ code: null, signal: null });
                });
            });
            // During a swap: roll back when the new version is not ready in time.
            let notReady = false;
            /** @type {ReturnType<typeof setInterval> | undefined} */
            let poll;
            if (swap && !swap.ready) {
                const current = swap;
                poll = setInterval(() => {
                    if (existsSync(at.ready)) {
                        current.ready = true;
                        clearInterval(poll);
                        say('the updated daemon is ready', { version: current.to });
                    } else if (Date.now() - current.startedAt >= t.readyTimeoutMs) {
                        clearInterval(poll);
                        notReady = true;
                        say('the updated daemon is not ready in time', { timeoutMs: t.readyTimeoutMs });
                        running.kill('SIGTERM');
                        setTimeout(() => running.kill('SIGKILL'), t.stopTimeoutMs).unref();
                    }
                }, t.readyPollMs);
            }
            const { code, signal } = await exited;
            clearInterval(poll);
            child = undefined;
            lastExit = { at: Date.now(), code, signal };
            const upMs = Date.now() - startedAt;
            say('daemon exited', { code, signal, upMs });
            writeStatus();
            if (stopping) return 0;

            if (notReady) {
                await rollback('not-ready');
            } else if (swap && Date.now() - swap.startedAt < t.crashWindowMs && code !== 0) {
                swap.exits++;
                if (swap.exits >= 2) await rollback('crashed');
            } else if (swap && Date.now() - swap.startedAt >= t.crashWindowMs) {
                swap = undefined;
            }

            if (code === 0) {
                say('the daemon stopped; the supervisor stops too');
                return 0;
            }
            restarts++;
            if (code === EXIT_UPDATE) {
                if (existsSync(at.entry(at.staged))) await applyStaged();
                else say('exit 75 without a staged update: restarting');
                attempt = 0;
            } else {
                if (upMs >= t.backoffResetMs) attempt = 0;
                const delay = Math.min(t.backoffMaxMs, t.backoffInitialMs * 2 ** attempt++);
                say('restarting after a backoff', { delayMs: delay });
                await new Promise((r) => {
                    const timer = setTimeout(r, delay);
                    wake = () => {
                        clearTimeout(timer);
                        r(undefined);
                    };
                });
                wake = undefined;
            }
            writeStatus();
        }
    } finally {
        writeStatus();
        if (options.signals !== false) for (const s of signals) process.off(s, stop);
    }
}

/** @param {readonly string[]} argv */
async function main(argv) {
    const args = parseSupervisorArgs(argv);
    if (args.version) {
        process.stdout.write(`agentic-supervisor ${SUPERVISOR_VERSION}\n`);
        return 0;
    }
    if (args.help) {
        process.stdout.write(`${USAGE}\n`);
        return 0;
    }
    if (args.error || !args.root) {
        process.stderr.write(`supervise: ${args.error}\n${USAGE}\n`);
        return 2;
    }
    return await supervise({ root: args.root, ...(args.log ? { log: args.log } : {}), ...(args.daemon ? { daemon: args.daemon } : {}), timings: args.timings });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (e) => {
            process.stderr.write(`supervise: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
            process.exit(1);
        }
    );
}
