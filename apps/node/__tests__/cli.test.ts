/** The `agentic` command line (#990): parsing, `--port`, and `agentic status`. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../../daemon/src/credentials';
import { openHomeFor, parseCli, statusLines } from '../src/cli';
import { openHome } from '../src/home';
import { localDaemonPaths } from '../src/local-machine';

describe('parseCli', () => {
    it('starts by default, with the daemon and the browser', () => {
        expect(parseCli([])).toEqual({ kind: 'start', daemon: true, open: true });
        expect(parseCli(['start'])).toEqual({ kind: 'start', daemon: true, open: true });
    });
    it('reads --no-daemon, --no-open and --port', () => {
        expect(parseCli(['start', '--no-daemon', '--no-open', '--port', '9000'])).toEqual({ kind: 'start', daemon: false, open: false, port: 9000 });
        expect(parseCli(['start', '--port=9001'])).toEqual({ kind: 'start', daemon: true, open: true, port: 9001 });
        expect(parseCli(['--no-daemon'])).toEqual({ kind: 'start', daemon: false, open: true });
    });
    it('refuses what it does not know', () => {
        expect(parseCli(['start', '--port', 'x'])).toMatchObject({ kind: 'error' });
        expect(parseCli(['start', '--port', '70000'])).toMatchObject({ kind: 'error' });
        expect(parseCli(['start', '--bogus'])).toMatchObject({ kind: 'error', message: 'unknown option: --bogus' });
        expect(parseCli(['serve'])).toMatchObject({ kind: 'error', message: 'unknown command: serve' });
        expect(parseCli(['status', 'x'])).toMatchObject({ kind: 'error' });
        expect(parseCli(['status', '--no-daemon'])).toMatchObject({ kind: 'error' });
    });
    it('knows help, status, export and import', () => {
        expect(parseCli(['--help'])).toEqual({ kind: 'help' });
        expect(parseCli(['help'])).toEqual({ kind: 'help' });
        expect(parseCli(['start', '-h'])).toEqual({ kind: 'help' });
        expect(parseCli(['status'])).toEqual({ kind: 'status' });
        expect(parseCli(['status', '--port', '9000'])).toEqual({ kind: 'status', port: 9000 });
        expect(parseCli(['export', 'd.ndjson', '--no-files'])).toEqual({ kind: 'import', argv: ['export', 'd.ndjson', '--no-files'] });
        expect(parseCli(['import', 'd.ndjson'])).toEqual({ kind: 'import', argv: ['import', 'd.ndjson'] });
    });
});

describe('openHomeFor / statusLines', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
    });
    const tmp = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-cli-'));
        dirs.push(dir);
        return dir;
    };

    it('--port wins over PORT', async () => {
        const dir = await tmp();
        const home = openHomeFor({ port: 9100 }, { dir, processEnv: { PORT: '9000' } });
        expect(home.port).toBe(9100);
        expect(home.env.APP_ORIGIN).toBe('http://localhost:9100');
        expect(openHomeFor({}, { dir, processEnv: { PORT: '9000' } }).port).toBe(9000);
    });

    it('reports a node that is down, unclaimed and unpaired', async () => {
        const dir = await tmp();
        const home = openHome({ dir, processEnv: {} });
        const lines = await statusLines({ home, fetch: () => Promise.reject(new Error('refused')) });
        expect(lines).toEqual([
            `data:     ${home.dir}`,
            'url:      http://localhost:8787',
            'owner:    not claimed (never started)',
            'server:   not running on port 8787',
            'machine:  not paired — `agentic start` pairs it'
        ]);
    });

    it('reports a claimed, running node and its machine', async () => {
        const dir = await tmp();
        const home = openHome({ dir, processEnv: {} });
        await writeFile(join(dir, 'owner.json'), JSON.stringify({ owner: { at: 1 } }));
        await saveCredentials(localDaemonPaths(dir).credentialsFile, { url: 'http://127.0.0.1:8787', workspaceId: 'local_owner', machineId: 'machine_1', token: 't', name: 'box', pairedAt: 1 }, { platform: 'linux' });
        const lines = await statusLines({ home, fetch: async () => new Response(null, { status: 401 }) });
        expect(lines.slice(2)).toEqual(['owner:    claimed', 'server:   running on port 8787 (HTTP 401)', 'machine:  machine_1 (box), paired to the local owner']);
    });
});
