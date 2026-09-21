// @vitest-environment node
/**
 * The update client (#364) against a local HTTP server: the whole phase sequence, the https-only rule, a tampered
 * download, cancel at each phase, the drain, `previous`, the local request `agentic-daemon update` leaves, and the
 * clean-up after a crash mid-update.
 */
import type { ReleaseAsset, UpdatePhase } from '@agentic/core';
import type { DaemonFrameOf } from '@agentic/daemon-protocol';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanLeftovers, createUpdateClient, fetchableAsset, updateLayout, type UpdateClient, type UpdateClientOptions } from '../src/update';
import { assetOf, releaseZip, startReleaseServer, type ReleaseServer } from './helpers/release';

type Status = DaemonFrameOf<'update.status'>;
const V = 1 as const;

describe('update client', () => {
    let root: string;
    let staged: string;
    let server: ReleaseServer;
    let asset: ReleaseAsset;
    let sent: Status[];
    let running: number;
    let restarts: number;
    const clients: UpdateClient[] = [];

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'agentic-update-'));
        staged = join(root, 'daemon.staged');
        server = await startReleaseServer();
        const zip = releaseZip(root, '0.2.0');
        server.serve('/agentic-daemon.zip', zip.bytes);
        asset = assetOf(`${server.origin}/agentic-daemon.zip`, zip, '0.2.0');
        await rm(zip.file);
        // The running install: what an update must never touch.
        await mkdir(join(root, 'daemon', 'bin'), { recursive: true });
        await writeFile(join(root, 'daemon', 'bin', 'agentic-daemon.mjs'), '// 0.1.0\n');
        sent = [];
        running = 0;
        restarts = 0;
    });
    afterEach(async () => {
        for (const c of clients.splice(0)) c.stop();
        await server.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const client = (options: Partial<UpdateClientOptions> = {}): UpdateClient => {
        const c = createUpdateClient(
            { send: (frame) => sent.push(frame), runningTurns: () => running },
            { root, restart: () => void restarts++, allowLoopbackHttp: true, pollMs: 10, check: async () => 'agentic-daemon 0.2.0 (abc1234, protocol 1, stable)', ...options }
        );
        clients.push(c);
        return c;
    };
    const phases = (requestId = 'upd_1'): UpdatePhase[] => sent.filter((f) => f.requestId === requestId && !f.progress).map((f) => f.phase);
    const last = (requestId = 'upd_1'): Status | undefined => sent.filter((f) => f.requestId === requestId).at(-1);
    const request = (c: UpdateClient, target: ReleaseAsset | 'previous', mode: 'drain' | 'now' = 'drain', requestId = 'upd_1', drainTimeoutMs = 60_000) =>
        c.request({ v: V, t: 'update.request', requestId, target, mode, drainTimeoutMs });
    const ended = (requestId = 'upd_1') => vi.waitFor(() => expect(['restarting', 'failed']).toContain(last(requestId)?.phase), { timeout: 5_000 });

    it('fetches https: only; http: on the loopback only when a test allows it', () => {
        const a = { url: 'https://github.com/andtii/agentic/releases/download/daemon-v0.2.0/x.zip', sha256: 'a'.repeat(64), bytes: 10, version: '0.2.0' };
        expect(fetchableAsset(a)).toBe(true);
        expect(fetchableAsset({ ...a, url: 'http://127.0.0.1:9/x.zip' })).toBe(false);
        expect(fetchableAsset({ ...a, url: 'http://127.0.0.1:9/x.zip' }, true)).toBe(true);
        expect(fetchableAsset({ ...a, url: 'http://[::1]:9/x.zip' }, true)).toBe(true);
        expect(fetchableAsset({ ...a, url: 'http://example.com/x.zip' }, true)).toBe(false);
        expect(fetchableAsset({ ...a, url: 'file:///etc/passwd' }, true)).toBe(false);
        expect(fetchableAsset({ ...a, sha256: 'nope' })).toBe(false);
    });

    it('runs the whole sequence: download, verify, stage (running the staged daemon once), drain, restart', async () => {
        // The real `node daemon.staged/bin/agentic-daemon.mjs --version`.
        const c = client({ check: undefined, progressMs: 0 });
        await c.start();
        request(c, asset);
        await ended();
        expect(phases()).toEqual(['downloading', 'verifying', 'staged', 'draining', 'restarting']);
        expect(sent.some((f) => f.phase === 'downloading' && f.progress?.total === asset.bytes)).toBe(true);
        expect(restarts).toBe(1);
        expect(JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'))).toEqual({ version: '0.2.0' });
        expect(existsSync(join(staged, 'install.ps1'))).toBe(true);
        // The download is gone once staged; the running install is untouched.
        expect(await readdir(join(root, 'downloads'))).toEqual([]);
        expect(await readFile(join(root, 'daemon', 'bin', 'agentic-daemon.mjs'), 'utf8')).toBe('// 0.1.0\n');
        expect(c.draining).toBe(true);
    });

    it('refuses an http: download in production: failed insecure-url, nothing fetched', async () => {
        const c = client({ allowLoopbackHttp: false });
        request(c, asset);
        await ended();
        expect(last()).toMatchObject({ phase: 'failed', error: { code: 'insecure-url' } });
        expect(server.requests).toEqual([]);
    });

    it('a tampered download fails checksum: the file is deleted, nothing is staged, the old daemon untouched', async () => {
        const tampered = new Uint8Array(releaseZip(root, '0.2.0', { name: 'other.zip' }).bytes);
        tampered[tampered.length - 1]! ^= 0xff;
        server.serve('/agentic-daemon.zip', tampered);
        const c = client();
        request(c, asset);
        await ended();
        expect(phases()).toEqual(['downloading', 'verifying', 'failed']);
        expect(last()?.error?.code).toBe('checksum');
        expect(existsSync(staged)).toBe(false);
        expect((await readdir(join(root, 'downloads'))).filter((n) => n.endsWith('.zip') || n.endsWith('.part'))).toEqual([]);
        expect(await readFile(join(root, 'daemon', 'bin', 'agentic-daemon.mjs'), 'utf8')).toBe('// 0.1.0\n');
        expect(restarts).toBe(0);
    });

    it('a zip that is not a daemon package, or a daemon that does not run, is not staged', async () => {
        const bare = releaseZip(root, '0.2.0', { name: 'bare.zip', withInstall: false });
        server.serve('/bare.zip', bare.bytes);
        const c = client();
        request(c, assetOf(`${server.origin}/bare.zip`, bare, '0.2.0'), 'now', 'upd_bare');
        await ended('upd_bare');
        expect(last('upd_bare')?.error?.code).toBe('bad-package');

        const broken = client({ check: async () => Promise.reject(new Error('exit 1')) });
        request(broken, asset, 'now', 'upd_broken');
        await ended('upd_broken');
        expect(last('upd_broken')?.error?.code).toBe('unrunnable');
        expect(existsSync(staged)).toBe(false);
        expect(existsSync(`${staged}.part`)).toBe(false);
    });

    it('drain waits for running turns; now does not; a drain that times out restarts anyway', async () => {
        running = 1;
        const c = client();
        request(c, asset);
        await vi.waitFor(() => expect(last()?.phase).toBe('draining'));
        expect(c.draining).toBe(true);
        await new Promise((r) => setTimeout(r, 50));
        expect(last()?.phase).toBe('draining');
        running = 0;
        await ended();
        expect(last()?.phase).toBe('restarting');

        await rm(staged, { recursive: true });
        running = 1;
        const now = client();
        request(now, asset, 'now', 'upd_now');
        await ended('upd_now');
        expect(phases('upd_now')).toEqual(['downloading', 'verifying', 'staged', 'draining', 'restarting']);

        await rm(staged, { recursive: true });
        const timed = client();
        request(timed, asset, 'drain', 'upd_timeout', 30);
        await ended('upd_timeout');
        expect(last('upd_timeout')?.phase).toBe('restarting');
        expect(restarts).toBe(3);
    });

    it('one update at a time: another request while one runs is failed busy', async () => {
        running = 1;
        const c = client();
        request(c, asset);
        await vi.waitFor(() => expect(last()?.phase).toBe('draining'));
        request(c, asset, 'now', 'upd_2');
        expect(last('upd_2')).toMatchObject({ phase: 'failed', error: { code: 'busy' } });
        expect(last()?.phase).toBe('draining');
    });

    it('cancel while downloading, and while draining: failed cancelled, no staged folder, turns start again', async () => {
        server.serve('/agentic-daemon.zip', releaseZip(root, '0.2.0', { name: 'slow.zip' }).bytes, { delayMs: 2_000 });
        const c = client();
        request(c, asset, 'drain', 'upd_dl');
        await vi.waitFor(() => expect(last('upd_dl')?.phase).toBe('downloading'));
        c.cancel('upd_dl');
        await ended('upd_dl');
        expect(last('upd_dl')?.error?.code).toBe('cancelled');
        expect((await readdir(join(root, 'downloads'))).filter((n) => n.endsWith('.part') || n.endsWith('.zip'))).toEqual([]);

        server.serve('/agentic-daemon.zip', releaseZip(root, '0.2.0', { name: 'fast.zip' }).bytes);
        const zip = releaseZip(root, '0.2.0', { name: 'fast.zip' });
        running = 1;
        request(c, assetOf(asset.url, zip, '0.2.0'), 'drain', 'upd_drain');
        await vi.waitFor(() => expect(last('upd_drain')?.phase).toBe('draining'));
        expect(existsSync(staged)).toBe(true);
        c.cancel('upd_other');
        expect(last('upd_drain')?.phase).toBe('draining');
        c.cancel('upd_drain');
        await ended('upd_drain');
        expect(last('upd_drain')).toMatchObject({ phase: 'failed', error: { code: 'cancelled' } });
        expect(existsSync(staged)).toBe(false);
        expect(c.draining).toBe(false);
        expect(restarts).toBe(0);
    });

    it('cancel once restarting is ignored', async () => {
        const c = client({ restart: () => new Promise(() => {}) });
        request(c, asset, 'now');
        await vi.waitFor(() => expect(last()?.phase).toBe('restarting'));
        c.cancel('upd_1');
        await new Promise((r) => setTimeout(r, 30));
        expect(last()?.phase).toBe('restarting');
        expect(existsSync(staged)).toBe(true);
    });

    it("target 'previous' stages daemon.prev (and a cancel puts it back); without one it fails no-previous", async () => {
        const c = client();
        request(c, 'previous', 'now', 'prev_none');
        await ended('prev_none');
        expect(last('prev_none')).toMatchObject({ phase: 'failed', error: { code: 'no-previous' } });

        await mkdir(join(root, 'daemon.prev', 'bin'), { recursive: true });
        await writeFile(join(root, 'daemon.prev', 'bin', 'agentic-daemon.mjs'), '// 0.0.9\n');
        running = 1;
        request(c, 'previous', 'drain', 'prev_cancel');
        await vi.waitFor(() => expect(last('prev_cancel')?.phase).toBe('draining'));
        expect(existsSync(join(root, 'daemon.prev'))).toBe(false);
        c.cancel('prev_cancel');
        await ended('prev_cancel');
        expect(await readFile(join(root, 'daemon.prev', 'bin', 'agentic-daemon.mjs'), 'utf8')).toBe('// 0.0.9\n');
        expect(existsSync(staged)).toBe(false);

        running = 0;
        request(c, 'previous', 'drain', 'prev_ok');
        await ended('prev_ok');
        expect(phases('prev_ok')).toEqual(['staged', 'draining', 'restarting']);
        expect(await readFile(join(staged, 'bin', 'agentic-daemon.mjs'), 'utf8')).toBe('// 0.0.9\n');
        expect(server.requests).toEqual([]);
    });

    it('start removes what a crash mid-download or mid-unpack left, and puts a staged previous build back', async () => {
        const layout = updateLayout(root);
        await mkdir(join(layout.staged, 'bin'), { recursive: true });
        await mkdir(layout.stagedPart, { recursive: true });
        await mkdir(layout.downloads, { recursive: true });
        await writeFile(join(layout.downloads, '0.2.0.zip.part'), 'half');
        const c = client();
        await c.start();
        expect(existsSync(layout.staged)).toBe(false);
        expect(existsSync(layout.stagedPart)).toBe(false);
        expect(await readdir(layout.downloads)).toEqual([]);

        await mkdir(join(layout.staged, 'bin'), { recursive: true });
        await writeFile(join(layout.staged, 'bin', 'agentic-daemon.mjs'), '// prev\n');
        await writeFile(layout.stagedFromPrevious, '');
        await cleanLeftovers(layout);
        expect(await readFile(join(layout.prev, 'bin', 'agentic-daemon.mjs'), 'utf8')).toBe('// prev\n');
        expect(existsSync(layout.stagedFromPrevious)).toBe(false);
    });

    it('a staged build left by `agentic-daemon update` makes a new request busy', async () => {
        await mkdir(join(staged, 'bin'), { recursive: true });
        const c = client();
        request(c, asset, 'now');
        await ended();
        expect(last()).toMatchObject({ phase: 'failed', error: { code: 'busy' } });
        expect(existsSync(staged)).toBe(true);
    });

    it('picks up state/update-request.json: drains and restarts onto the staged build, telling the platform nothing', async () => {
        const c = client();
        await c.start();
        await mkdir(join(staged, 'bin'), { recursive: true });
        await writeFile(join(staged, 'bin', 'agentic-daemon.mjs'), '// 0.2.0\n');
        running = 1;
        await mkdir(join(root, 'state'), { recursive: true });
        // Half a request is left for the next poll, not dropped.
        await writeFile(updateLayout(root).requestFile, '{"mode": "dr');
        await new Promise((r) => setTimeout(r, 50));
        expect(existsSync(updateLayout(root).requestFile)).toBe(true);
        expect(c.draining).toBe(false);
        await writeFile(updateLayout(root).requestFile, JSON.stringify({ mode: 'drain', drainTimeoutMs: 60_000, version: '0.2.0', at: Date.now() }));
        await vi.waitFor(() => expect(c.draining).toBe(true));
        expect(existsSync(updateLayout(root).requestFile)).toBe(false);
        expect(restarts).toBe(0);
        running = 0;
        await vi.waitFor(() => expect(restarts).toBe(1));
        expect(sent).toEqual([]);
    });
});
