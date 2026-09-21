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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildManifest, readSidecar } from '../scripts/lib/manifest.mjs';
import { buildStamp, protocolVersion, releaseTagFrom, stampFor } from '../scripts/lib/stamp.mjs';
import { extractZip, readZip, writeZip } from '../scripts/lib/zip.mjs';
import { packageDaemon, resolveClosure } from '../scripts/package.mjs';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/core';

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

describe('build stamp', () => {
    it('a daemon-v tag is its semver on channel stable; anything else is <package version>-main.<sha7> on latest', () => {
        const commit = '0123456789abcdef0123456789abcdef01234567';
        expect(buildStamp({ tag: 'daemon-v0.2.0', packageVersion: '0.1.0', commit })).toEqual({ version: '0.2.0', commit: '0123456', channel: 'stable', tag: 'daemon-v0.2.0' });
        expect(buildStamp({ tag: 'daemon-v0.0.1-rc.1', packageVersion: '0.1.0', commit }).version).toBe('0.0.1-rc.1');
        expect(buildStamp({ packageVersion: '0.1.0', commit })).toEqual({ version: '0.1.0-main.0123456', commit: '0123456', channel: 'latest', tag: null });
        expect(() => buildStamp({ tag: 'v0.2.0', packageVersion: '0.1.0', commit })).toThrow(/not a release tag/);
        expect(() => buildStamp({ tag: 'daemon-v1.2', packageVersion: '0.1.0', commit })).toThrow(/not a release tag/);
    });

    it('reads the tag from AGENTIC_DAEMON_TAG, or a pushed daemon-v tag; a branch run has none', () => {
        expect(releaseTagFrom({ AGENTIC_DAEMON_TAG: 'daemon-v0.1.0', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })).toBe('daemon-v0.1.0');
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'daemon-v0.3.0' })).toBe('daemon-v0.3.0');
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0' })).toBeUndefined();
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', AGENTIC_DAEMON_TAG: '' })).toBeUndefined();
    });

    it('stamps this checkout from package.json and GITHUB_SHA, and reads the protocol from core', () => {
        const pkg = JSON.parse(readFileSync(join(DAEMON_DIR, 'package.json'), 'utf8')) as { version: string };
        expect(stampFor(DAEMON_DIR, { GITHUB_SHA: 'abcdef0123456789' })).toEqual({ version: `${pkg.version}-main.abcdef0`, commit: 'abcdef0', channel: 'latest', tag: null });
        expect(stampFor(DAEMON_DIR, { GITHUB_SHA: 'abcdef0123456789', AGENTIC_DAEMON_TAG: 'daemon-v9.9.9' }).version).toBe('9.9.9');
        expect(protocolVersion(resolve(DAEMON_DIR, '../..'))).toBe(DAEMON_PROTOCOL_VERSION);
    });
});

describe('release manifest', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-manifest-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const zip = async (name: string, body: string) => {
        await writeFile(join(dir, name), body);
        await writeFile(join(dir, `${name}.sha256`), `${createHash('sha256').update(body).digest('hex')}  ${name}\n`);
    };
    const stamp = { version: '0.0.1-rc.1', commit: '0123456', channel: 'stable' as const };

    it('keys every zip by <os>-<arch> with its release url, the sidecar sha256 and its size', async () => {
        for (const key of ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) await zip(`agentic-daemon-${key}.zip`, `zip for ${key}`);
        await writeFile(join(dir, 'notes.txt'), 'not an asset');
        const manifest = buildManifest({ dir, tag: 'daemon-v0.0.1-rc.1', repo: 'andtii/agentic', stamp, protocol: 1, publishedAt: '2026-09-21T00:00:00.000Z' });
        expect(Object.keys(manifest.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
        expect(manifest).toMatchObject({ version: '0.0.1-rc.1', channel: 'stable', publishedAt: '2026-09-21T00:00:00.000Z', commit: '0123456', protocol: 1, notesUrl: 'https://github.com/andtii/agentic/releases/tag/daemon-v0.0.1-rc.1', harnesses: {} });
        expect(manifest.assets['linux-x64']).toEqual({
            url: 'https://github.com/andtii/agentic/releases/download/daemon-v0.0.1-rc.1/agentic-daemon-linux-x64.zip',
            sha256: createHash('sha256').update('zip for linux-x64').digest('hex'),
            bytes: 'zip for linux-x64'.length,
            version: '0.0.1-rc.1'
        });
    });

    it('reads versioned zip names too, and refuses a zip without a sidecar, a bad sidecar or an empty folder', async () => {
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/no agentic-daemon/);
        await zip('agentic-daemon-0.1.0-main.0123456-win32-x64.zip', 'w');
        expect(Object.keys(buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 }).assets)).toEqual(['win32-x64']);
        await writeFile(join(dir, 'agentic-daemon-linux-x64.zip'), 'l');
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/ENOENT/);
        await writeFile(join(dir, 'agentic-daemon-linux-x64.zip.sha256'), 'not a hash\n');
        expect(() => readSidecar(join(dir, 'agentic-daemon-linux-x64.zip.sha256'))).toThrow(/no sha256/);
    });

    it('runs as a script: writes manifest.json for the release folder from this checkout\'s stamp', async () => {
        await zip('agentic-daemon-linux-arm64.zip', 'arm');
        await mkdir(join(dir, 'out'));
        const out = join(dir, 'out', 'manifest.json');
        const env = { PATH: process.env.PATH ?? '', GITHUB_SHA: 'fedcba9876543210', AGENTIC_DAEMON_TAG: 'daemon-v0.0.1-rc.1' };
        const run = spawnSync(process.execPath, [join(DAEMON_DIR, 'scripts/lib/manifest.mjs'), '--dir', dir, '--tag', 'daemon-v0.0.1-rc.1', '--repo', 'andtii/agentic', '--out', out], { encoding: 'utf8', env });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        const manifest = JSON.parse(readFileSync(out, 'utf8')) as { version: string; channel: string; commit: string; protocol: number; assets: Record<string, { sha256: string }> };
        expect(manifest).toMatchObject({ version: '0.0.1-rc.1', channel: 'stable', commit: 'fedcba9', protocol: DAEMON_PROTOCOL_VERSION });
        expect(manifest.assets['linux-arm64']?.sha256).toBe(createHash('sha256').update('arm').digest('hex'));
        expect(spawnSync(process.execPath, [join(DAEMON_DIR, 'scripts/lib/manifest.mjs'), '--dir', dir], { encoding: 'utf8' }).status).toBe(2);
    });
});

describe('installer', () => {
    it('resolves the production closure: workspace packages, the Claude Code and Copilot SDKs and the Codex CLI with this platform’s binaries, no dev dependencies', () => {
        const closure = resolveClosure(DAEMON_DIR);
        const names = new Set([...closure.values()].map((s) => s.name));
        for (const name of ['@agentic/core', '@agentic/daemon-protocol', '@agentic/runtimes', '@sigx/ai-agent-claude-code', '@anthropic-ai/claude-agent-sdk', `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, '@github/copilot-sdk', `@github/copilot-sdk-${process.platform}-${process.arch}`, '@openai/codex', 'ws']) {
            expect(names, name).toContain(name);
        }
        for (const name of ['vite', 'typescript', 'vitest', '@sigx/vite', '@types/ws']) expect(names, name).not.toContain(name);
        // The Codex binary is an npm alias of `@openai/codex` itself: placed under the alias, where its launcher looks.
        expect(closure.get(`node_modules/@openai/codex-${process.platform}-${process.arch}`)?.name).toBe('@openai/codex');
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
            // the version the build stamped (dist/build.json), not a hand-edited twin of package.json
            const stamp = JSON.parse(readFileSync(join(DAEMON_DIR, 'dist', 'build.json'), 'utf8')) as { version: string; commit: string; channel: string };
            expect(result.version).toBe(stamp.version);
            expect(stamp.version).toMatch(stamp.channel === 'stable' ? /^\d+\.\d+\.\d+/ : /^\d+\.\d+\.\d+-main\.([0-9a-f]{7}|unknown)$/);
            expect(result.sha256).toBeUndefined();
            expect(lines[0]).toMatch(/^package: .*\.zip — \d+ files/);

            const unpacked = join(dir, 'unpacked');
            const files = extractZip(result.zipFile, unpacked);
            for (const f of ['README.md', 'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh', 'package.json', 'bin/agentic-daemon.mjs', 'dist/cli.js', 'scripts/install-service.ps1', 'scripts/uninstall-service.ps1', 'scripts/install-service.sh', 'scripts/uninstall-service.sh', 'node_modules/@agentic/core/package.json', 'node_modules/@agentic/runtimes/dist/index.js', 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs']) {
                expect(files, f).toContain(f);
            }
            // Windows PowerShell 5.1 reads a BOM-less script as ANSI: a non-ASCII byte can become a smart quote and break the parse.
            for (const f of files.filter((f) => f.endsWith('.ps1'))) expect([...readFileSync(join(unpacked, f))].every((byte) => byte < 0x80), f).toBe(true);
            // The shell scripts are executable in the zip whatever the checkout's mode bits (a Windows checkout has none), and LF-only for `sh`.
            const modes = new Map(readZip(readFileSync(result.zipFile)).map((e) => [e.name, e.mode]));
            for (const f of files.filter((f) => f.endsWith('.sh'))) {
                expect(modes.get(f), f).toBe(0o755);
                expect(readFileSync(join(unpacked, f), 'utf8').includes('\r'), f).toBe(false);
            }
            expect(files.some((f) => f.startsWith('node_modules/@agentic/core/src/'))).toBe(false);
            expect(files.some((f) => f.startsWith('node_modules/vite/'))).toBe(false);
            const shipped = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8')) as { name: string; version: string; bin: Record<string, string>; devDependencies?: unknown; scripts?: unknown; dependencies: Record<string, string> };
            expect(shipped.name).toBe('@agentic/daemon');
            expect(shipped.version).toBe(stamp.version);
            expect(shipped.bin['agentic-daemon']).toBe('./bin/agentic-daemon.mjs');
            expect(shipped.devDependencies).toBeUndefined();
            expect(shipped.scripts).toBeUndefined();
            expect(Object.values(shipped.dependencies).some((range) => range.startsWith('workspace:') || range.startsWith('catalog:'))).toBe(false);

            // A clean environment: no PATH to the repo, no NODE_PATH — only the unpacked folder.
            const run = (args: string[]) => spawnSync(process.execPath, ['bin/agentic-daemon.mjs', ...args], { cwd: unpacked, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', AGENTIC_DAEMON_HOME: join(dir, 'home') } });
            const version = run(['--version']);
            expect(version.stderr).toBe('');
            expect(version.status).toBe(0);
            expect(version.stdout.trim()).toBe(`agentic-daemon ${stamp.version} (${stamp.commit}, protocol ${DAEMON_PROTOCOL_VERSION}, ${stamp.channel})`);

            // `doctor` on an unpaired home: the whole closure loads (drivers, runtimes, the SDK), the verdict is "not paired".
            const doctor = run(['doctor']);
            expect(doctor.status).toBe(1);
            expect(doctor.stdout).toMatch(/not paired/);
        }, 300_000);

        it('--unversioned names the zip like the release asset the installers fetch; --sha256 writes the sidecar the manifest reads', () => {
            const result = packageDaemon({ outDir: dir, unversioned: true, sha256: true, log: () => {} });
            expect(basename(result.zipFile)).toBe(`agentic-daemon-${process.platform}-${process.arch}.zip`);
            const hash = createHash('sha256').update(readFileSync(result.zipFile)).digest('hex');
            expect(result.sha256).toBe(hash);
            expect(readFileSync(`${result.zipFile}.sha256`, 'utf8')).toBe(`${hash}  ${basename(result.zipFile)}\n`);
            expect(readSidecar(`${result.zipFile}.sha256`)).toBe(hash);
        }, 300_000);
    });
});
