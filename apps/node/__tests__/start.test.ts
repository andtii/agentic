/**
 * `agentic start` (#990): the hub, and this machine's daemon in the same
 * process, paired to the local owner without a code — over the real daemon
 * `run` (`apps/daemon/src/cli.ts`) dialling the node's own socket.
 *
 * Gated on `node:sqlite` (Node >= 22.13; CI's compat leg runs Node 20).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_OWNER_ID, machineKey } from '@agentic/platform';
import { main as daemonMain } from '../../daemon/src/cli';
import { loadCredentials } from '../../daemon/src/credentials';
import { resetServerAppStamp } from '../../web/src/platform.app';
import { openHome } from '../src/home';
import { localDaemonPaths } from '../src/local-machine';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const { startNode } = nodeSqlite ? await import('../src/start') : ({} as typeof import('../src/start'));

describe.skipIf(!nodeSqlite)('agentic start', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
        resetServerAppStamp();
    });

    const tmp = async (): Promise<string> => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-start-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        return dir;
    };

    const start = async (dir: string, options: { daemon?: boolean } = {}) => {
        const lines: string[] = [];
        const opened: string[] = [];
        const clientDir = join(dir, 'client');
        const running = await startNode({
            home: { ...openHome({ dir, processEnv: {} }), port: 0 },
            clientDir,
            ...(options.daemon === undefined ? {} : { daemon: options.daemon }),
            log: (l) => lines.push(l),
            opener: (url) => opened.push(url),
            daemonMain: async () => daemonMain,
            daemonContext: { drivers: [], out: () => undefined, err: () => undefined, log: () => undefined, backoff: { initialMs: 5, maxMs: 20 }, hostname: 'box' }
        });
        let stopped = false;
        const stop = async () => {
            if (stopped) return;
            stopped = true;
            await running.stop();
        };
        cleanup.push(stop);
        return { running, lines, opened, stop };
    };

    it('pairs this machine to the local owner and connects its daemon, with no code', async () => {
        const dir = await tmp();
        const { running, lines, opened, stop } = await start(dir);
        expect(running.claimLink).toMatch(/\/auth\/claim\?t=/);
        expect(opened).toEqual([running.claimLink]);
        expect(running.machineId).toMatch(/^machine_/);
        expect(lines.some((l) => l.includes(`paired this machine as ${running.machineId} (`))).toBe(true);

        const credentials = (await loadCredentials(localDaemonPaths(dir).credentialsFile))!;
        const address = running.server.address();
        expect(credentials).toMatchObject({ workspaceId: LOCAL_OWNER_ID, machineId: running.machineId, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}` });
        // The daemon dialled the node's own socket: the Machine actor holds it.
        const key = machineKey(LOCAL_OWNER_ID, running.machineId!);
        await vi.waitFor(() => expect(running.node.daemonSockets.count(key)).toBe(1), { timeout: 10_000 });

        await stop();
        expect(await running.daemonExited).toBe(0);
    });

    it('keeps the pairing across restarts', async () => {
        const dir = await tmp();
        const first = await start(dir);
        const machineId = first.running.machineId;
        await first.stop();
        resetServerAppStamp();

        const second = await start(dir);
        expect(second.running.machineId).toBe(machineId);
        expect(second.lines.some((l) => l.includes(`this machine: ${machineId}`))).toBe(true);
        await vi.waitFor(() => expect(second.running.node.daemonSockets.count(machineKey(LOCAL_OWNER_ID, machineId!))).toBe(1), { timeout: 10_000 });
    });

    it('--no-daemon runs the hub only', async () => {
        const dir = await tmp();
        const { running } = await start(dir, { daemon: false });
        expect(running.machineId).toBeNull();
        expect(await running.daemonExited).toBeNull();
        expect(existsSync(localDaemonPaths(dir).credentialsFile)).toBe(false);
        // The hub still serves.
        const address = running.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        expect((await fetch(`http://127.0.0.1:${port}/auth/me`)).status).toBe(401);
    });

    it('keeps serving when the daemon cannot start', async () => {
        const dir = await tmp();
        const lines: string[] = [];
        const running = await startNode({
            home: { ...openHome({ dir, processEnv: {} }), port: 0 },
            clientDir: join(dir, 'client'),
            log: (l) => lines.push(l),
            opener: () => undefined,
            daemonMain: () => Promise.reject(new Error('no daemon build'))
        });
        cleanup.push(() => running.stop());
        expect(running.machineId).toBeNull();
        expect(lines.some((l) => l.includes('the local daemon did not start: no daemon build'))).toBe(true);
    });

    it('opens the app, not a claim link, once the node is claimed', async () => {
        const dir = await tmp();
        await writeFile(join(dir, 'owner.json'), JSON.stringify({ owner: { hash: 'x', salt: 'y', iterations: 1, at: 1 } }));
        const { running, opened } = await start(dir, { daemon: false });
        expect(running.claimLink).toBeNull();
        expect(opened).toEqual([running.origin]);
    });
});
