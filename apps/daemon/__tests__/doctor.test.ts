// @vitest-environment node
/** `runDoctor` with the harness store (#369): a row per runtime, the PATH hint for a missing one, and the environments' own `harness-missing`. */
import type { EnvironmentId } from '@agentic/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDoctorReport, runDoctor, whichOnPath } from '../src/doctor';
import { harnessMissingDriver } from '../src/drivers';
import { writeEnvironments } from '../src/env-store';
import { extractZipFile, harnessStore } from '../src/harness';
import { scriptedDriver } from './helpers/drivers';
import { fakeHarnessZip } from './helpers/harness';

describe('doctor: harnesses (#369)', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-doctor-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('names the installed harness, a broken one, and a missing one — with a hint for its CLI on PATH, which is never used', async () => {
        const root = join(dir, 'harnesses');
        // fake: installed by hand as the store lays it out.
        const zip = await fakeHarnessZip(dir, 'fake', '1.0.0');
        await extractZipFile(zip.file, join(root, 'fake', '1.0.0'));
        await writeFile(join(root, 'fake', 'current.json'), JSON.stringify({ version: '1.0.0', installedAt: 1 }));
        // codex-cli: current.json names a version that is not there.
        await mkdir(join(root, 'codex-cli'), { recursive: true });
        await writeFile(join(root, 'codex-cli', 'current.json'), JSON.stringify({ version: '9.0.0', installedAt: 1 }));
        const store = harnessStore({ root, bundled: false });
        // What the daemon's install on start last hit.
        await store.setFailure('claude-code', 'no release manifest at https://releases.test/manifest.json (404)');

        const paths = { configDir: dir, stateDir: dir, credentialsFile: join(dir, 'credentials.json'), environmentsFile: join(dir, 'environments.json'), policyFile: join(dir, 'policy.json'), sessionsDir: join(dir, 'sessions'), logFile: join(dir, 'logs', 'daemon.log') };
        await writeEnvironments(paths.environmentsFile, [{ id: 'env_claude' as EnvironmentId, name: 'Claude', runtime: 'claude-code', cwdRoots: [dir], concurrency: 1 }], { run: async () => ({ code: 0, stderr: '' }) });
        const fake = { ...scriptedDriver({ events: 1, heartbeatMs: 1_000 }), runtime: 'fake' };
        const which = async (command: string) => (command === 'claude' ? '/usr/local/bin/claude' : undefined);
        const report = await runDoctor({ paths, drivers: [fake, harnessMissingDriver('claude-code'), harnessMissingDriver('codex-cli')], harnesses: store, which });

        const rows = report.findings.map((f) => [f.level, f.code]);
        expect(rows).toEqual(
            expect.arrayContaining([
                ['info', 'harness'],
                ['warn', 'harness-missing'],
                ['info', 'harness-on-path'],
                ['warn', 'harness-install-failed'],
                ['error', 'harness-broken'],
                ['error', 'harness-missing']
            ])
        );
        expect(report.findings.find((f) => f.code === 'harness')?.message).toMatch(/^harness fake 1\.0\.0: .*run/);
        expect(report.findings.find((f) => f.level === 'warn' && f.code === 'harness-missing')?.message).toMatch(/no claude-code harness in .* — install it with `agentic-daemon harness install claude-code`/);
        expect(report.findings.find((f) => f.code === 'harness-on-path')?.message).toBe('/usr/local/bin/claude is on PATH, but the daemon runs only an installed harness — `agentic-daemon harness install claude-code`');
        expect(report.findings.find((f) => f.code === 'harness-broken')?.message).toMatch(/harness codex-cli is broken: .*manifest\.json is missing/);
        expect(report.findings.find((f) => f.code === 'harness-install-failed')?.message).toMatch(/^installing the claude-code harness failed at .*: no release manifest .* — the daemon tries again when it starts/);
        // The environment on the missing runtime carries the driver's own error.
        expect(report.findings.find((f) => f.level === 'error' && f.code === 'harness-missing')).toMatchObject({ environmentIds: ['env_claude'] });
        expect(report.ok).toBe(false);
        expect(formatDoctorReport(report)).toMatch(/doctor: problems found$/);
    });

    it('whichOnPath finds a command the way a shell does', async () => {
        const bin = join(dir, 'bin');
        await mkdir(bin);
        const windows = process.platform === 'win32';
        await writeFile(join(bin, windows ? 'tool.cmd' : 'tool'), '');
        const env = windows ? { Path: `${join(dir, 'nope')};${bin}`, PATHEXT: '.EXE;.CMD' } : { PATH: `${join(dir, 'nope')}:${bin}` };
        expect(await whichOnPath('tool', env)).toBe(join(bin, windows ? 'tool.cmd' : 'tool'));
        expect(await whichOnPath('missing', env)).toBeUndefined();
    });
});
