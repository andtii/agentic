// @vitest-environment node
import type { EnvironmentId } from '@agentic/core';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main, parseArgs } from '../src/cli';
import type { DaemonDriver } from '../src/daemon';
import { daemonPaths } from '../src/paths';
import { scriptedDriver } from './helpers/drivers';
import { startRelay } from './helpers/relay';

describe('cli', () => {
    let dir: string;
    let out: string[];
    const io = () => ({ out: (t: string) => out.push(t), err: (t: string) => out.push(t), log: (t: string) => out.push(t) });
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-cli-'));
        out = [];
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const paths = () => daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });

    it('parses commands, positionals and flags', () => {
        expect(parseArgs(['pair', 'ABC234', '--url', 'https://x', '--name=box', '--verbose'])).toEqual({ command: 'pair', positional: ['ABC234'], flags: { url: 'https://x', name: 'box', verbose: true } });
    });

    it('usage errors exit 2; help exits 0', async () => {
        expect(await main([], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['pair', 'ABC234'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['launch'], { paths: paths(), ...io() })).toBe(2);
        expect(await main(['help'], { paths: paths(), ...io() })).toBe(0);
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
    });

    it('doctor: ok when everything checks out', async () => {
        await writeFile(paths().credentialsFile, JSON.stringify({ url: 'https://agentic.example', workspaceId: 'ws_1', machineId: 'machine_1', token: `amt.ws_1.machine_1.${'t'.repeat(43)}` }));
        await writeFile(paths().environmentsFile, JSON.stringify([{ id: 'env_a', name: 'A', runtime: 'scripted', cwdRoots: [dir] }]));
        expect(await main(['doctor'], { paths: paths(), drivers: [scriptedDriver({ events: 1, heartbeatMs: 1_000 })], ...io() })).toBe(0);
        expect(out.join('\n')).toMatch(/doctor: ok/);
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
