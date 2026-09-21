/**
 * The daemon's update client (#364; architecture §5b, OPS-05): what an `update.request` from the platform, or
 * `agentic-daemon update` on the machine, runs.
 *
 *   downloading → verifying → staged → draining → restarting   (`failed` ends one early)
 *
 * - `downloading`: the asset is fetched over `https:` only (a test injects `allowLoopbackHttp` for `http://127.0.0.1`)
 *   to `<root>/downloads/<version>.zip`, hashed as it arrives, with `progress` at most every 2 s and a 10-minute timeout.
 * - `verifying`: sha256 and byte count against the target; a mismatch deletes the file and fails `checksum`.
 * - `staged`: unpacked to `<root>/daemon.staged` (through `daemon.staged.part`, so a half-unpacked folder is never taken
 *   for a staged one), checked for `install.*` and `bin/agentic-daemon.mjs` at its root, and run once with `--version`.
 *   `target: 'previous'` skips all three: `daemon.prev` is renamed to `daemon.staged`.
 * - `draining`: no new turns — the daemon answers a turn-starting prompt with `drainingReply` — while a `session.open`
 *   is still accepted. It ends when no turn runs on any environment, when `drainTimeoutMs` passes, or at once for `now`.
 * - `restarting`: the host stops the daemon with reason `update` (every live session closed with code `update`),
 *   deletes `state/ready` and exits 75; the supervisor swaps `daemon.staged` in.
 *
 * `update.cancel` before `restarting` stops the drain, removes the staged folder (a `previous` one goes back to
 * `daemon.prev`) and answers `failed { code: 'cancelled' }`; later it is ignored. One update runs at a time: another
 * request — or a staged folder someone else left (the CLI's) — is answered `failed { code: 'busy' }`.
 *
 * `agentic-daemon update` (`./update-cli.ts`) runs the first three phases in its own process with the same functions,
 * then asks the running daemon to drain and restart through `state/update-request.json`, which this client polls.
 * On start the client removes what a crash mid-download or mid-unpack left behind.
 */

import { DAEMON_PROTOCOL_VERSION, type ReleaseAsset, type UpdatePhase } from '@agentic/core';
import { isHttpsAsset, type DaemonFrameOf, type PlatformFrameOf } from '@agentic/daemon-protocol';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractZip } from '../scripts/lib/zip.mjs';
import { silentLogger, type Logger } from './logger.js';

type UpdateRequest = PlatformFrameOf<'update.request'>;
type UpdateStatus = DaemonFrameOf<'update.status'>;

/** A download may take this long (#364). */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** `downloading` progress goes out at most this often. */
export const PROGRESS_MS = 2_000;
/** How long `agentic-daemon update` lets the running daemon drain before it restarts anyway. */
export const CLI_DRAIN_TIMEOUT_MS = 10 * 60_000;

/** The named failures of an update, the `error.code` of `update.status { phase: 'failed' }`. */
export type UpdateErrorCode = 'busy' | 'insecure-url' | 'download' | 'checksum' | 'bad-package' | 'unrunnable' | 'no-previous' | 'cancelled' | 'io' | 'unsupported';

export class UpdateError extends Error {
    override readonly name = 'UpdateError';
    constructor(
        readonly code: UpdateErrorCode,
        message: string
    ) {
        super(message);
    }
}

/** The folders an update moves between, beside `<root>/daemon` (the supervisor's names: `scripts/supervise.mjs`). */
export interface UpdateLayout {
    readonly root: string;
    readonly daemonDir: string;
    readonly staged: string;
    /** Where the zip is unpacked before it becomes `staged`. */
    readonly stagedPart: string;
    /** Present while `staged` is the previous build (`target: 'previous'`): a cancel or a crash puts it back. */
    readonly stagedFromPrevious: string;
    readonly prev: string;
    readonly downloads: string;
    /** What `agentic-daemon update` leaves for the running daemon: drain and restart onto the staged folder. */
    readonly requestFile: string;
}

export function updateLayout(root: string): UpdateLayout {
    const daemonDir = join(root, 'daemon');
    return {
        root,
        daemonDir,
        staged: `${daemonDir}.staged`,
        stagedPart: `${daemonDir}.staged.part`,
        stagedFromPrevious: `${daemonDir}.staged.previous`,
        prev: `${daemonDir}.prev`,
        downloads: join(root, 'downloads'),
        requestFile: join(root, 'state', 'update-request.json')
    };
}

/** `state/update-request.json`: written by `agentic-daemon update` once it staged a build. */
export interface LocalUpdateRequest {
    readonly mode: 'drain' | 'now';
    readonly drainTimeoutMs: number;
    readonly version: string;
    readonly at: number;
}

const entryOf = (dir: string): string => join(dir, 'bin', 'agentic-daemon.mjs');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether the client may fetch `asset`: `https:` always; `http:` on the loopback only when a test allows it. */
export function fetchableAsset(asset: ReleaseAsset, allowLoopbackHttp = false): boolean {
    if (isHttpsAsset(asset as unknown)) return true;
    if (!allowLoopbackHttp) return false;
    try {
        const parsed = new URL(asset.url);
        return parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname) && isHttpsAsset({ ...asset, url: `https://${parsed.host}${parsed.pathname}` });
    } catch {
        return false;
    }
}

/** A download's file name: the version when it is a plain one, never a path. */
export function downloadFile(layout: Pick<UpdateLayout, 'downloads'>, version: string): string {
    return join(layout.downloads, `${/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : 'update'}.zip`);
}

export interface DownloadOptions {
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly progressMs?: number;
    readonly onProgress?: (progress: { readonly bytes: number; readonly total: number }) => void;
    /** Tests only: allow `http:` on the loopback. */
    readonly allowLoopbackHttp?: boolean;
}

/**
 * Fetch `asset` to `file` (through `<file>.part`), hashing as it arrives. Resolves to what arrived; a body longer than
 * `asset.bytes` stops early. `verifyDownload` compares it.
 */
export async function downloadAsset(asset: ReleaseAsset, file: string, options: DownloadOptions = {}): Promise<{ readonly sha256: string; readonly bytes: number }> {
    if (!fetchableAsset(asset, options.allowLoopbackHttp)) throw new UpdateError('insecure-url', `refusing to download ${asset.url}: an update is fetched over https: only`);
    const progressMs = options.progressMs ?? PROGRESS_MS;
    const signals = [AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])];
    const signal = AbortSignal.any(signals);
    const part = `${file}.part`;
    await mkdir(join(file, '..'), { recursive: true });
    const hash = createHash('sha256');
    let bytes = 0;
    try {
        const response = await (options.fetch ?? fetch)(asset.url, { signal, redirect: 'follow' });
        if (!response.ok || !response.body) throw new UpdateError('download', `downloading ${asset.url} failed: HTTP ${response.status}`);
        const out = await open(part, 'w');
        try {
            let reported = Date.now();
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                hash.update(value);
                bytes += value.byteLength;
                await out.write(value);
                if (bytes > asset.bytes) {
                    await reader.cancel().catch(() => {});
                    break;
                }
                if (options.onProgress && Date.now() - reported >= progressMs) {
                    reported = Date.now();
                    options.onProgress({ bytes, total: asset.bytes });
                }
            }
        } finally {
            await out.close();
        }
        await rename(part, file);
        return { sha256: hash.digest('hex'), bytes };
    } catch (e) {
        await rm(part, { force: true });
        if (e instanceof UpdateError) throw e;
        if (options.signal?.aborted) throw new UpdateError('cancelled', 'the update was cancelled');
        if (signal.aborted) throw new UpdateError('download', `downloading ${asset.url} took longer than ${Math.round((options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS) / 1000)} s`);
        throw new UpdateError('download', `downloading ${asset.url} failed: ${(e as Error).message}`);
    }
}

/** The download is the asset: its sha256 and byte count. A mismatch deletes the file. */
export async function verifyDownload(file: string, got: { readonly sha256: string; readonly bytes: number }, asset: ReleaseAsset): Promise<void> {
    if (got.bytes === asset.bytes && got.sha256 === asset.sha256.toLowerCase()) return;
    await rm(file, { force: true });
    throw new UpdateError('checksum', `the download does not match the release: expected ${asset.bytes} bytes with sha256 ${asset.sha256.toLowerCase()}, got ${got.bytes} bytes with sha256 ${got.sha256}`);
}

/** Runs the staged daemon once with `--version`: resolves to what it printed, rejects when it does not run. */
export type StagedCheck = (dir: string) => Promise<string>;

/** `node <dir>/bin/agentic-daemon.mjs --version`, with the Node running this daemon. */
export const runStagedVersion: StagedCheck = (dir) =>
    new Promise((resolve, reject) => {
        execFile(process.execPath, [entryOf(dir), '--version'], { cwd: dir, timeout: 60_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())));
    });

/**
 * Unpack `zip` into `layout.staged`: through `stagedPart`, checked for `install.*` and `bin/agentic-daemon.mjs` at its
 * root, then run once with `--version` (which must name `version` when it is given). Anything wrong leaves no staged folder.
 */
export async function stageZip(zip: string, layout: UpdateLayout, options: { readonly version?: string; readonly check?: StagedCheck } = {}): Promise<void> {
    await rm(layout.stagedPart, { recursive: true, force: true });
    try {
        await mkdir(layout.stagedPart, { recursive: true });
        try {
            extractZip(zip, layout.stagedPart);
        } catch (e) {
            throw new UpdateError('bad-package', `the download is not a daemon package: ${(e as Error).message}`);
        }
        const names = await readdir(layout.stagedPart);
        if (!names.some((n) => /^install\.(ps1|sh)$/.test(n)) || !existsSync(entryOf(layout.stagedPart))) throw new UpdateError('bad-package', 'the download is not a daemon package: no install script or bin/agentic-daemon.mjs at its root');
        let printed: string;
        try {
            printed = await (options.check ?? runStagedVersion)(layout.stagedPart);
        } catch (e) {
            throw new UpdateError('unrunnable', `the downloaded daemon does not run: ${(e as Error).message}`);
        }
        if (options.version && !printed.includes(options.version)) throw new UpdateError('unrunnable', `the downloaded daemon reports "${printed}", not version ${options.version}`);
        await rm(layout.staged, { recursive: true, force: true });
        await rename(layout.stagedPart, layout.staged);
    } finally {
        await rm(layout.stagedPart, { recursive: true, force: true });
    }
}

/** `target: 'previous'`: `daemon.prev` becomes `daemon.staged`, marked so a cancel or a crash puts it back. */
export async function stagePrevious(layout: UpdateLayout): Promise<void> {
    if (!existsSync(entryOf(layout.prev))) throw new UpdateError('no-previous', 'there is no previous daemon build to go back to');
    await writeFile(layout.stagedFromPrevious, '');
    await rename(layout.prev, layout.staged);
}

/** Take a staged folder away: a previous build goes back to `daemon.prev`, anything else is deleted. */
export async function unstage(layout: UpdateLayout): Promise<void> {
    if (existsSync(layout.stagedFromPrevious) && existsSync(layout.staged) && !existsSync(layout.prev)) await rename(layout.staged, layout.prev);
    await rm(layout.staged, { recursive: true, force: true });
    await rm(layout.stagedFromPrevious, { force: true });
}

/**
 * What a daemon that restarted mid-update left: a staged or half-unpacked folder and partial downloads. A staged folder
 * the supervisor did not swap in is stale once the daemon runs again. A swap applied leaves only the marker.
 */
export async function cleanLeftovers(layout: UpdateLayout): Promise<string[]> {
    const removed: string[] = [];
    for (const dir of [layout.staged, layout.stagedPart]) if (existsSync(dir)) removed.push(dir);
    await unstage(layout);
    await rm(layout.stagedPart, { recursive: true, force: true });
    const names = await readdir(layout.downloads).catch(() => [] as string[]);
    for (const name of names) {
        if (!name.endsWith('.part')) continue;
        await rm(join(layout.downloads, name), { force: true });
        removed.push(join(layout.downloads, name));
    }
    return removed;
}

export interface UpdateClientOptions {
    /** The install root (`installPaths().root`). */
    readonly root: string;
    /** Stop the daemon with reason `update`, delete `state/ready` and exit 75: the CLI resolves `run`'s `until` with `'update'`. */
    readonly restart: () => void | Promise<void>;
    readonly fetch?: typeof fetch;
    /** Tests only: allow `http:` on the loopback. Never set in production. */
    readonly allowLoopbackHttp?: boolean;
    readonly downloadTimeoutMs?: number;
    readonly progressMs?: number;
    /** How often a drain looks for running turns and `state/update-request.json` is looked for. Default 1 s. */
    readonly pollMs?: number;
    /** The staged daemon's `--version` run (tests). */
    readonly check?: StagedCheck;
}

export interface UpdateHost {
    send(frame: UpdateStatus): void;
    /** Turns running across every environment. */
    runningTurns(): number;
    readonly logger?: Logger;
}

export interface UpdateClient {
    /** Clean up what a crash left and start looking for `state/update-request.json`. */
    start(): Promise<void>;
    /** Stop looking for local requests; an update not yet restarting is dropped. */
    stop(): void;
    request(frame: UpdateRequest): void;
    cancel(requestId: string): void;
    /** An update waits for running turns (or is restarting): no new turn may start. */
    readonly draining: boolean;
}

interface Job {
    readonly requestId: string;
    /** From `state/update-request.json`: nothing goes to the platform, which did not ask. */
    readonly local: boolean;
    phase: UpdatePhase | undefined;
    readonly abort: AbortController;
    wake: (() => void) | undefined;
    /** The staged folder is this job's: a failure or a cancel takes it away. */
    staged: boolean;
}

export function createUpdateClient(host: UpdateHost, options: UpdateClientOptions): UpdateClient {
    const layout = updateLayout(options.root);
    const logger = host.logger ?? silentLogger;
    const pollMs = options.pollMs ?? 1_000;
    let job: Job | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let polling = false;

    const status = (j: Job, phase: UpdatePhase, extra: Partial<Pick<UpdateStatus, 'progress' | 'error'>> = {}): void => {
        if (phase !== 'downloading' || !extra.progress) logger.info('update: phase', { requestId: j.requestId, phase, ...(extra.error ? { error: extra.error } : {}) });
        if (!j.local) host.send({ v: DAEMON_PROTOCOL_VERSION, t: 'update.status', requestId: j.requestId, phase, ...extra });
    };
    const refuse = (requestId: string, code: UpdateErrorCode, message: string): void => {
        logger.warn('update: refused', { requestId, code, message });
        host.send({ v: DAEMON_PROTOCOL_VERSION, t: 'update.status', requestId, phase: 'failed', error: { code, message } });
    };
    const cancelled = (j: Job): void => {
        if (j.abort.signal.aborted) throw new UpdateError('cancelled', 'the update was cancelled');
    };

    /** Until no turn runs, `timeoutMs` passes or the job is cancelled. */
    async function drain(j: Job, mode: 'drain' | 'now', timeoutMs: number): Promise<void> {
        if (mode === 'now') return;
        const deadline = Date.now() + timeoutMs;
        while (!j.abort.signal.aborted && host.runningTurns() > 0 && Date.now() < deadline) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now())));
                function done(): void {
                    clearTimeout(timer);
                    j.wake = undefined;
                    resolve();
                }
                j.wake = done;
            });
        }
        if (!j.abort.signal.aborted && host.runningTurns() > 0) logger.warn('update: drain timed out; running turns are interrupted', { requestId: j.requestId, running: host.runningTurns(), timeoutMs });
    }

    async function run(j: Job, target: ReleaseAsset | 'previous' | 'staged', mode: 'drain' | 'now', drainTimeoutMs: number): Promise<void> {
        try {
            if (target !== 'staged') {
                if (existsSync(layout.staged)) throw new UpdateError('busy', 'an update is already staged on this machine');
                if (target === 'previous') {
                    await stagePrevious(layout);
                    j.staged = true;
                } else {
                    if (!fetchableAsset(target, options.allowLoopbackHttp)) throw new UpdateError('insecure-url', `refusing to download ${target.url}: an update is fetched over https: only`);
                    status(j, 'downloading');
                    const file = downloadFile(layout, target.version);
                    const got = await downloadAsset(target, file, {
                        signal: j.abort.signal,
                        onProgress: (progress) => status(j, 'downloading', { progress }),
                        ...(options.fetch ? { fetch: options.fetch } : {}),
                        ...(options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
                        ...(options.downloadTimeoutMs !== undefined ? { timeoutMs: options.downloadTimeoutMs } : {}),
                        ...(options.progressMs !== undefined ? { progressMs: options.progressMs } : {})
                    });
                    cancelled(j);
                    status(j, 'verifying');
                    await verifyDownload(file, got, target);
                    cancelled(j);
                    j.staged = true;
                    try {
                        await stageZip(file, layout, { version: target.version, ...(options.check ? { check: options.check } : {}) });
                    } finally {
                        await rm(file, { force: true });
                    }
                }
                cancelled(j);
                status(j, 'staged');
            } else j.staged = true;
            j.phase = 'draining';
            status(j, 'draining');
            await drain(j, mode, drainTimeoutMs);
            cancelled(j);
            j.phase = 'restarting';
            status(j, 'restarting');
            await options.restart();
        } catch (e) {
            const error = e instanceof UpdateError ? e : new UpdateError('io', (e as Error).message);
            if (j.staged) await unstage(layout).catch((u: unknown) => logger.warn('update: cannot remove the staged folder', { error: u }));
            j.phase = 'failed';
            status(j, 'failed', { error: { code: error.code, message: error.message } });
        } finally {
            if (j.phase !== 'restarting' && job === j) job = undefined;
        }
    }

    /** `agentic-daemon update` staged a build and asks this daemon to drain and restart onto it. */
    async function pickUpLocalRequest(): Promise<void> {
        if (polling || job || !existsSync(layout.requestFile)) return;
        polling = true;
        try {
            let request: LocalUpdateRequest;
            try {
                request = JSON.parse(await readFile(layout.requestFile, 'utf8')) as LocalUpdateRequest;
            } finally {
                await unlink(layout.requestFile).catch(() => {});
            }
            if (job) return;
            if (!existsSync(entryOf(layout.staged))) {
                logger.warn('update: a local update request without a staged build; ignored', { file: layout.requestFile });
                return;
            }
            const j: Job = { requestId: `local_${request.at ?? Date.now()}`, local: true, phase: 'staged', abort: new AbortController(), wake: undefined, staged: true };
            job = j;
            logger.info('update: agentic-daemon update asks for a restart onto the staged build', { version: request.version, mode: request.mode });
            const timeout = typeof request.drainTimeoutMs === 'number' && request.drainTimeoutMs >= 0 ? request.drainTimeoutMs : CLI_DRAIN_TIMEOUT_MS;
            await run(j, 'staged', request.mode === 'now' ? 'now' : 'drain', timeout);
        } catch (e) {
            logger.warn('update: cannot read the local update request', { file: layout.requestFile, error: e });
        } finally {
            polling = false;
        }
    }

    return {
        async start() {
            const removed = await cleanLeftovers(layout).catch((e: unknown) => {
                logger.warn('update: cannot clean up a previous update', { error: e });
                return [];
            });
            if (removed.length > 0) logger.info('update: removed what an interrupted update left', { removed });
            // A request left from before this daemon started is stale: its staged folder is gone.
            await rm(layout.requestFile, { force: true }).catch(() => {});
            poll = setInterval(() => void pickUpLocalRequest(), pollMs);
            poll.unref?.();
        },
        stop() {
            if (poll !== undefined) clearInterval(poll);
            poll = undefined;
            // A daemon stopping for anything but this update's restart drops the update; the next start cleans up.
            if (job && job.phase !== 'restarting') {
                job.abort.abort();
                job.wake?.();
            }
        },
        request(frame) {
            if (job) return refuse(frame.requestId, 'busy', `an update is already running (${job.requestId}, ${job.phase ?? 'starting'})`);
            const j: Job = { requestId: frame.requestId, local: false, phase: undefined, abort: new AbortController(), wake: undefined, staged: false };
            job = j;
            logger.info('update: requested', { requestId: frame.requestId, target: frame.target === 'previous' ? 'previous' : frame.target.version, mode: frame.mode });
            void run(j, frame.target, frame.mode, frame.drainTimeoutMs);
        },
        cancel(requestId) {
            const j = job;
            if (!j || j.requestId !== requestId || j.phase === 'restarting') return;
            logger.info('update: cancelled', { requestId, phase: j.phase });
            j.abort.abort();
            j.wake?.();
        },
        get draining() {
            return job?.phase === 'draining' || job?.phase === 'restarting';
        }
    };
}

