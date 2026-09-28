/**
 * `ensureLocalMachine` (#990): the local owner pairs this machine through the
 * `PairingDirectory` and `Machine.pair`, keeps a pairing whose token still
 * works (moving its URL when the port changed) and replaces one the Machine
 * actor refuses.
 *
 * Gated on `node:sqlite` (Node >= 22.13; CI's compat leg runs Node 20).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asPrincipal, LOCAL_OWNER_ID, userPrincipal, type WorkspaceActor } from '@agentic/platform';
import type { WorkspaceId } from '@agentic/core';
import { resetServerAppStamp } from '../../web/src/platform.app';
import { runWithHost } from '../../web/src/host-scope';
import { fsBucket } from '../src/fs-bucket';
import { ensureLocalMachine, localDaemonPaths, machineOsOf } from '../src/local-machine';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const sqlite = nodeSqlite ? await import('@sigx/actors-sqlite') : null;
const { createNodeHost } = nodeSqlite ? await import('../src/host') : ({} as typeof import('../src/host'));

const SECRET = 's'.repeat(40);
const secure = { platform: 'linux' as const };

describe('localDaemonPaths / machineOsOf', () => {
    it('puts the daemon under <home>/daemon', () => {
        const paths = localDaemonPaths(join('h'));
        expect(paths.credentialsFile).toBe(join('h', 'daemon', 'credentials.json'));
        expect(paths.environmentsFile).toBe(join('h', 'daemon', 'environments.json'));
        expect(paths.sessionsDir).toBe(join('h', 'daemon', 'sessions'));
    });
    it('maps the platform to a machine OS', () => {
        expect(machineOsOf('win32')).toBe('windows');
        expect(machineOsOf('darwin')).toBe('darwin');
        expect(machineOsOf('linux')).toBe('linux');
        expect(machineOsOf('aix')).toBeUndefined();
    });
});

describe.skipIf(!nodeSqlite)('ensureLocalMachine', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
        resetServerAppStamp();
    });

    const start = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-local-machine-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const storage = sqlite!.sqliteStorage({ path: join(dir, 'agentic.db') });
        const node = await createNodeHost({ storage, bucket: fsBucket(join(dir, 'files')), env: { SESSION_SECRET: SECRET, APP_ORIGIN: 'http://localhost:8787' } });
        cleanup.push(async () => {
            await node.stop({ timeoutMs: 2_000 });
            storage.close();
        });
        return { node, file: localDaemonPaths(dir).credentialsFile };
    };

    const machinesOf = async (node: Awaited<ReturnType<typeof start>>['node']) => {
        const Workspace = node.actors.find((d) => (d as { type: string }).type === 'Workspace') as WorkspaceActor;
        return runWithHost(node.host, () =>
            node.host
                .actor(Workspace, `ws:${LOCAL_OWNER_ID}`)
                .with({ context: asPrincipal(userPrincipal(LOCAL_OWNER_ID, LOCAL_OWNER_ID as WorkspaceId)) })
                .listMachines()
        );
    };

    it('pairs through the directory with no code typed, and saves the credentials', async () => {
        const { node, file } = await start();
        const { credentials, paired } = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9000', name: 'box', platform: 'linux', daemonVersion: '1.2.3', secure });
        expect(paired).toBe(true);
        expect(credentials).toMatchObject({ url: 'http://127.0.0.1:9000', workspaceId: LOCAL_OWNER_ID, name: 'box' });
        expect(credentials.token).toMatch(new RegExp(`^amt\\.${LOCAL_OWNER_ID}\\.${credentials.machineId}\\.`));
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ machineId: credentials.machineId, token: credentials.token });
        expect(await machinesOf(node)).toEqual([expect.objectContaining({ id: credentials.machineId, name: 'box', status: 'paired' })]);
    });

    it('keeps a working pairing and moves its URL to the new port', async () => {
        const { node, file } = await start();
        const first = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9000', name: 'box', secure });
        const again = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9001', name: 'box', secure });
        expect(again.paired).toBe(false);
        expect(again.credentials).toMatchObject({ machineId: first.credentials.machineId, token: first.credentials.token, url: 'http://127.0.0.1:9001' });
        expect(JSON.parse(await readFile(file, 'utf8')).url).toBe('http://127.0.0.1:9001');
        expect(await machinesOf(node)).toHaveLength(1);
    });

    it('pairs again when the stored token is refused', async () => {
        const { node, file } = await start();
        const first = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9000', name: 'box', secure });
        const forged = { ...first.credentials, token: `${first.credentials.token.slice(0, -4)}AAAA` };
        await writeFile(file, JSON.stringify(forged));
        const again = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9000', name: 'box', secure });
        expect(again.paired).toBe(true);
        expect(again.credentials.machineId).not.toBe(first.credentials.machineId);
    });

    it('pairs its own machine beside a daemon paired elsewhere', async () => {
        const { node, file } = await start();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'gh_1', machineId: 'machine_x', token: 'amt.gh_1.machine_x.' + 'a'.repeat(43), name: 'box', pairedAt: 1 }));
        const { paired, credentials } = await ensureLocalMachine({ node, credentialsFile: file, url: 'http://127.0.0.1:9000', secure });
        expect(paired).toBe(true);
        expect(credentials.workspaceId).toBe(LOCAL_OWNER_ID);
    });
});
