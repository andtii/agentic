// @vitest-environment node
/**
 * The daemon installer (#52): `scripts/package.mjs` produces a zip that,
 * unpacked on a machine with nothing but Node, runs `agentic-daemon
 * --version` — which loads the whole dependency closure (the CLI imports the
 * drivers, the drivers import the runtimes and the Claude Code SDK).
 *
 * The zip lib is exercised on its own (always); the packaging round trip
 * needs the repo built (`pnpm build`) and is skipped without `dist/`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { extractZip, readZip, writeZip } from '../scripts/lib/zip.mjs';
import { packageDaemon, resolveClosure } from '../scripts/package.mjs';
import { DAEMON_VERSION } from '../src/version';

const DAEMON_DIR = resolve(import.meta.dirname, '..');
const built = existsSync(join(DAEMON_DIR, 'dist', 'cli.js')) && existsSync(join(DAEMON_DIR, '../../packages/runtimes/dist/index.js'));

describe('zip', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-zip-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('round-trips stored and deflated entries with modes and verifies the CRC', async () => {
        const big = Buffer.alloc(200_000, 'agentic ');
        const file = join(dir, 'a.zip');
        const result = writeZip(file, [
            { name: 'bin/run.mjs', data: Buffer.from('#!/usr/bin/env node\n'), mode: 0o755 },
            { name: 'nested/dir/text.txt', data: big },
            { name: 'raw.bin', data: Buffer.from([1, 2, 3, 4]), store: true }
        ]);
        expect(result.entries).toBe(3);
        const entries = readZip(readFileSync(file));
        expect(entries.map((e) => e.name)).toEqual(['bin/run.mjs', 'nested/dir/text.txt', 'raw.bin']);
        expect(Buffer.from(entries[1]!.data).equals(big)).toBe(true);
        expect(entries[0]!.mode).toBe(0o755);
        expect(entries[2]!.mode).toBe(0o644);
        expect(result.bytes).toBeLessThan(big.length); // the text deflated
        const written = extractZip(file, join(dir, 'out'));
        expect(written).toEqual(['bin/run.mjs', 'nested/dir/text.txt', 'raw.bin']);
        expect(readFileSync(join(dir, 'out/nested/dir/text.txt')).equals(big)).toBe(true);
    });

    it('refuses an entry that escapes the target directory and a corrupted archive', async () => {
        const file = join(dir, 'bad.zip');
        writeZip(file, [{ name: '../escape.txt', data: Buffer.from('x') }]);
        expect(() => extractZip(file, join(dir, 'out'))).toThrow(/escapes/);
        const ok = join(dir, 'ok.zip');
        writeZip(ok, [{ name: 'a.txt', data: Buffer.from('hello world, hello world'), store: true }]);
        const bytes = readFileSync(ok);
        bytes[30 + 'a.txt'.length] ^= 0xff; // first data byte of the stored entry
        await writeFile(ok, bytes);
        expect(() => readZip(readFileSync(ok))).toThrow(/CRC/);
    });
});

describe('installer', () => {
    it('resolves the production closure: workspace packages, the Claude Code SDK with this platform’s CLI, no dev dependencies', () => {
        const closure = resolveClosure(DAEMON_DIR);
        const names = new Set([...closure.values()].map((s) => s.name));
        for (const name of ['@agentic/core', '@agentic/daemon-protocol', '@agentic/runtimes', '@sigx/ai-agent-claude-code', '@anthropic-ai/claude-agent-sdk', `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, 'ws']) {
            expect(names, name).toContain(name);
        }
        for (const name of ['vite', 'typescript', 'vitest', '@sigx/vite', '@types/ws']) expect(names, name).not.toContain(name);
        expect(closure.get('node_modules/@agentic/core')?.workspace).toBe(true);
        expect(closure.get('node_modules/ws')?.workspace).toBe(false);
        // the daemon's own dependencies always win the top level, at the instance the daemon itself resolves
        const rootDeps = Object.keys((JSON.parse(readFileSync(join(DAEMON_DIR, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies);
        for (const name of rootDeps) expect(closure.get(`node_modules/${name}`)?.real, name).toBe(realpathSync(join(DAEMON_DIR, 'node_modules', name)));
        for (const target of closure.keys()) expect(target.startsWith('node_modules/'), target).toBe(true);
        // every nested placement is a second version of a name the top level already holds
        for (const target of closure.keys()) {
            const nested = target.match(/^(.+)\/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
            if (nested && nested[1]!.startsWith('node_modules/')) expect(closure.has(`node_modules/${nested[2]}`), target).toBe(true);
        }
    });

    describe.skipIf(!built)('zip (needs `pnpm build`)', () => {
        let dir: string;
        beforeEach(async () => {
            dir = await mkdtemp(join(tmpdir(), 'agentic-installer-'));
        });
        afterEach(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it('unpacks and runs `agentic-daemon --version` on plain Node', async () => {
            const lines: string[] = [];
            const result = packageDaemon({ outDir: dir, log: (l) => lines.push(l) });
            expect(basename(result.zipFile)).toBe(`agentic-daemon-${result.version}-${process.platform}-${process.arch}.zip`);
            expect(result.version).toBe(DAEMON_VERSION);
            expect(lines[0]).toMatch(/^package: .*\.zip — \d+ files/);

            const unpacked = join(dir, 'unpacked');
            const files = extractZip(result.zipFile, unpacked);
            for (const f of ['README.md', 'install.ps1', 'uninstall.ps1', 'package.json', 'bin/agentic-daemon.mjs', 'dist/cli.js', 'scripts/install-service.ps1', 'scripts/uninstall-service.ps1', 'node_modules/@agentic/core/package.json', 'node_modules/@agentic/runtimes/dist/index.js', 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs']) {
                expect(files, f).toContain(f);
            }
            // Windows PowerShell 5.1 reads a BOM-less script as ANSI: a non-ASCII byte can become a smart quote and break the parse.
            for (const f of files.filter((f) => f.endsWith('.ps1'))) expect([...readFileSync(join(unpacked, f))].every((byte) => byte < 0x80), f).toBe(true);
            expect(files.some((f) => f.startsWith('node_modules/@agentic/core/src/'))).toBe(false);
            expect(files.some((f) => f.startsWith('node_modules/vite/'))).toBe(false);
            const shipped = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string>; devDependencies?: unknown; scripts?: unknown; dependencies: Record<string, string> };
            expect(shipped.name).toBe('@agentic/daemon');
            expect(shipped.bin['agentic-daemon']).toBe('./bin/agentic-daemon.mjs');
            expect(shipped.devDependencies).toBeUndefined();
            expect(shipped.scripts).toBeUndefined();
            expect(Object.values(shipped.dependencies).some((range) => range.startsWith('workspace:') || range.startsWith('catalog:'))).toBe(false);

            // A clean environment: no PATH to the repo, no NODE_PATH — only the unpacked folder.
            const run = (args: string[]) => spawnSync(process.execPath, ['bin/agentic-daemon.mjs', ...args], { cwd: unpacked, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', AGENTIC_DAEMON_HOME: join(dir, 'home') } });
            const version = run(['--version']);
            expect(version.stderr).toBe('');
            expect(version.status).toBe(0);
            expect(version.stdout.trim()).toBe(`agentic-daemon ${DAEMON_VERSION}`);

            // `doctor` on an unpaired home: the whole closure loads (drivers, runtimes, the SDK), the verdict is "not paired".
            const doctor = run(['doctor']);
            expect(doctor.status).toBe(1);
            expect(doctor.stdout).toMatch(/not paired/);
        }, 300_000);
    });
});
