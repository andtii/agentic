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
import { CODEX_TRIPLES, HARNESS_ZIP, HARNESSES, harnessZipName, isNativeHarnessPackage } from '../scripts/lib/harness.mjs';
import { buildManifest, planHarnesses, readSidecar, staleHarnessAssets } from '../scripts/lib/manifest.mjs';
import { buildStamp, commitTime, protocolVersion, releaseTagFrom, stampFor } from '../scripts/lib/stamp.mjs';
import { extractZip, readZip, writeZip } from '../scripts/lib/zip.mjs';
import { packageDaemon, packageHarness, resolveClosure } from '../scripts/package.mjs';
import { DAEMON_PROTOCOL_VERSION, type ReleaseManifest } from '@agentic/core';
import { compareVersions, isVersion } from '@agentic/daemon-protocol';
import { SUPERVISOR_VERSION } from '../scripts/supervise.mjs';
import { BUILTIN_HARNESSES, extractZipFile, harnessStore, sdkVersion, treeHashOf } from '../src/harness';
import { serveFiles } from './helpers/harness';

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
    it('a daemon-v tag is its semver on channel stable; anything else is <package version>-main.<commit time>.<sha7> on latest', () => {
        const commit = 'abcdef0123456789abcdef0123456789abcdef01';
        expect(buildStamp({ tag: 'daemon-v0.2.0', packageVersion: '0.1.0', commit })).toEqual({ version: '0.2.0', commit: 'abcdef0', channel: 'stable', tag: 'daemon-v0.2.0' });
        expect(buildStamp({ tag: 'daemon-v0.0.1-rc.1', packageVersion: '0.1.0', commit }).version).toBe('0.0.1-rc.1');
        expect(buildStamp({ packageVersion: '0.1.0', commit, committedAt: 1_790_000_000 })).toEqual({ version: '0.1.0-main.1790000000.abcdef0', commit: 'abcdef0', channel: 'latest', tag: null });
        // No commit time (no git): 0, still a valid version below every timed build.
        expect(buildStamp({ packageVersion: '0.1.0', commit }).version).toBe('0.1.0-main.0.abcdef0');
        expect(() => buildStamp({ tag: 'v0.2.0', packageVersion: '0.1.0', commit })).toThrow(/not a release tag/);
        expect(() => buildStamp({ tag: 'daemon-v1.2', packageVersion: '0.1.0', commit })).toThrow(/not a release tag/);
    });

    // #437: `-main.<sha7>` ordered by the sha's text; the commit time orders them by when they were made.
    it('main builds order by commit time, below their release; every stamp is a valid semver version', () => {
        const older = buildStamp({ packageVersion: '0.2.0', commit: 'ffffff0aaaa', committedAt: 1_790_000_000 }).version;
        const newer = buildStamp({ packageVersion: '0.2.0', commit: '0000001bbbb', committedAt: 1_790_000_060 }).version;
        expect(compareVersions(newer, older)).toBeGreaterThan(0);
        expect(compareVersions('0.2.0', newer)).toBeGreaterThan(0);
        expect(compareVersions(older, '0.1.9')).toBeGreaterThan(0);
        // A sha7 of digits with a leading zero is no semver identifier: it is written g0123456.
        expect(buildStamp({ packageVersion: '0.2.0', commit: '0123456789', committedAt: 1 }).version).toBe('0.2.0-main.1.g0123456');
        for (const commit of ['0123456789', '1234567abc', 'abcdef0123', 'unknown']) for (const committedAt of [undefined, 0, 1_790_000_000]) expect(isVersion(buildStamp({ packageVersion: '0.2.0', commit, committedAt }).version), `${commit} ${committedAt}`).toBe(true);
    });

    it('reads the tag from AGENTIC_DAEMON_TAG, or a pushed daemon-v tag; a branch run has none', () => {
        expect(releaseTagFrom({ AGENTIC_DAEMON_TAG: 'daemon-v0.1.0', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })).toBe('daemon-v0.1.0');
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'daemon-v0.3.0' })).toBe('daemon-v0.3.0');
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0' })).toBeUndefined();
        expect(releaseTagFrom({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', AGENTIC_DAEMON_TAG: '' })).toBeUndefined();
    });

    it('stamps this checkout from package.json and GITHUB_SHA, and reads the protocol from core', () => {
        const pkg = JSON.parse(readFileSync(join(DAEMON_DIR, 'package.json'), 'utf8')) as { version: string };
        // A commit this checkout does not have has no time.
        expect(stampFor(DAEMON_DIR, { GITHUB_SHA: 'abcdef0123456789' })).toEqual({ version: `${pkg.version}-main.0.abcdef0`, commit: 'abcdef0', channel: 'latest', tag: null });
        const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: DAEMON_DIR, encoding: 'utf8' }).stdout.trim();
        const time = commitTime(DAEMON_DIR, head);
        expect(time).toBeGreaterThan(1_700_000_000);
        expect(stampFor(DAEMON_DIR, { GITHUB_SHA: head }).version).toBe(buildStamp({ packageVersion: pkg.version, commit: head, committedAt: time }).version);
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
        const manifest = buildManifest({ dir, tag: 'daemon-v0.0.1-rc.1', repo: 'andtii/agentic', stamp, protocol: 1, publishedAt: 1_790_000_000_000 });
        // the core contract's shape, checked by the compiler
        const contract: ReleaseManifest = manifest;
        expect(contract.assets['win32-x64']?.version).toBe('0.0.1-rc.1');
        expect(Object.keys(manifest.assets).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
        expect(manifest).toMatchObject({ version: '0.0.1-rc.1', channel: 'stable', publishedAt: 1_790_000_000_000, commit: '0123456', protocol: 1, notesUrl: 'https://github.com/andtii/agentic/releases/tag/daemon-v0.0.1-rc.1', harnesses: {} });
        expect(manifest.assets['linux-x64']).toEqual({
            url: 'https://github.com/andtii/agentic/releases/download/daemon-v0.0.1-rc.1/agentic-daemon-linux-x64.zip',
            sha256: createHash('sha256').update('zip for linux-x64').digest('hex'),
            bytes: 'zip for linux-x64'.length,
            version: '0.0.1-rc.1'
        });
    });

    it('lists each harness zip under harnesses[runtime] with the version its .json sidecar names, one version per runtime (#369)', async () => {
        await zip('agentic-daemon-win32-x64.zip', 'daemon');
        const harness = async (runtime: string, key: string, version: string) => {
            const name = `harness-${runtime}-${version}-${key}.zip`;
            await zip(name, `${runtime} ${key}`);
            await writeFile(join(dir, `${name}.json`), JSON.stringify({ runtime, version, platform: key, binary: 'x', packages: [], sha256: '0'.repeat(64) }));
        };
        await harness('claude-code', 'win32-x64', '0.3.274');
        await harness('claude-code', 'linux-x64', '0.3.274');
        await harness('codex-cli', 'win32-x64', '0.155.1');
        const manifest = buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 });
        const contract: ReleaseManifest = manifest;
        expect(Object.keys(contract.harnesses).sort()).toEqual(['claude-code', 'codex-cli']);
        expect(manifest.harnesses['claude-code']).toEqual({
            version: '0.3.274',
            assets: {
                'linux-x64': { url: 'https://github.com/andtii/agentic/releases/download/daemon-latest/harness-claude-code-0.3.274-linux-x64.zip', sha256: createHash('sha256').update('claude-code linux-x64').digest('hex'), bytes: 'claude-code linux-x64'.length, version: '0.3.274' },
                'win32-x64': { url: 'https://github.com/andtii/agentic/releases/download/daemon-latest/harness-claude-code-0.3.274-win32-x64.zip', sha256: createHash('sha256').update('claude-code win32-x64').digest('hex'), bytes: 'claude-code win32-x64'.length, version: '0.3.274' }
            }
        });
        expect(Object.keys(manifest.assets)).toEqual(['win32-x64']);
        await harness('codex-cli', 'linux-x64', '0.156.0');
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/codex-cli is 0\.155\.1 on one platform and 0\.156\.0 on linux-x64/);
        await writeFile(join(dir, 'harness-codex-cli-0.156.0-linux-x64.zip.json'), JSON.stringify({ runtime: 'claude-code', version: '0.156.0', platform: 'linux-x64' }));
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/does not describe codex-cli 0\.156\.0/);
        await rm(join(dir, 'harness-codex-cli-0.156.0-linux-x64.zip'));
        // The .json names another version than the zip's name.
        await harness('codex-cli', 'linux-x64', '0.155.1');
        await writeFile(join(dir, 'harness-codex-cli-0.155.1-linux-x64.zip.json'), JSON.stringify({ runtime: 'codex-cli', version: '0.155.2', platform: 'linux-x64' }));
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/does not describe codex-cli 0\.155\.1/);
    });

    it('reads versioned zip names too, and refuses a zip without a sidecar, a bad sidecar or an empty folder', async () => {
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/no agentic-daemon/);
        await zip('agentic-daemon-0.1.0-main.1790000000.abc1234-win32-x64.zip', 'w');
        expect(Object.keys(buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 }).assets)).toEqual(['win32-x64']);
        await writeFile(join(dir, 'agentic-daemon-linux-x64.zip'), 'l');
        expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1 })).toThrow(/ENOENT/);
        await writeFile(join(dir, 'agentic-daemon-linux-x64.zip.sha256'), 'not a hash\n');
        expect(() => readSidecar(join(dir, 'agentic-daemon-linux-x64.zip.sha256'))).toThrow(/no sha256/);
    });

    // #441: a harness zip is uploaded once per version; a run that packages none still lists them all.
    describe('harness assets uploaded once', () => {
        const VERSIONS = { 'claude-code': '0.3.274', 'copilot-cli': '1.0.14', 'codex-cli': '0.155.1' };
        const KEYS = ['linux-x64', 'win32-x64'];
        const LATEST = 'https://github.com/andtii/agentic/releases/download/daemon-latest';
        const onRelease = (versions: Record<string, string>, keys = KEYS) => Object.entries(versions).flatMap(([runtime, version]) => keys.flatMap((key) => [`harness-${runtime}-${version}-${key}.zip`, `harness-${runtime}-${version}-${key}.zip.sha256`]));
        const harness = async (runtime: string, key: string, version: string) => {
            const name = harnessZipName(runtime, version, key);
            await zip(name, `${runtime} ${version} ${key}`);
            await writeFile(join(dir, `${name}.json`), JSON.stringify({ runtime, version, platform: key, binary: 'x', packages: [], sha256: '0'.repeat(64) }));
        };
        const daemons = async () => {
            for (const key of KEYS) await zip(`agentic-daemon-${key}.zip`, `daemon ${key}`);
        };
        /** A previous manifest, as the last run uploaded it: every runtime at `versions` on both platforms. */
        const previousOf = (versions: Record<string, string>) => ({
            harnesses: Object.fromEntries(
                Object.entries(versions).map(([runtime, version]) => [
                    runtime,
                    { version, assets: Object.fromEntries(KEYS.map((key) => [key, { url: `${LATEST}/${harnessZipName(runtime, version, key)}`, sha256: createHash('sha256').update(`${runtime} ${version} ${key}`).digest('hex'), bytes: `${runtime} ${version} ${key}`.length, version }])) }
                ])
            )
        });

        it('names a harness zip by its version', () => {
            expect(harnessZipName('claude-code', '0.3.274', 'win32-x64')).toBe('harness-claude-code-0.3.274-win32-x64.zip');
            expect(HARNESS_ZIP.exec('harness-codex-cli-0.155.1-rc.2-linux-arm64.zip')?.slice(1)).toEqual(['codex-cli', '0.155.1-rc.2', 'linux-arm64']);
            expect(HARNESS_ZIP.test('harness-codex-cli-linux-arm64.zip')).toBe(false);
        });

        it('plan: packages only the runtimes whose zip for this version is not on the release', () => {
            expect(planHarnesses({ versions: VERSIONS, existing: [], platform: 'win32-x64' })).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
            expect(planHarnesses({ versions: VERSIONS, existing: onRelease(VERSIONS), platform: 'win32-x64' })).toEqual([]);
            // A version bump: only that runtime.
            expect(planHarnesses({ versions: { ...VERSIONS, 'codex-cli': '0.156.0' }, existing: onRelease(VERSIONS), platform: 'win32-x64' })).toEqual(['codex-cli']);
            // A zip without its sidecar is packaged again; another platform's zip does not count.
            expect(planHarnesses({ versions: VERSIONS, existing: onRelease(VERSIONS).filter((n) => n !== 'harness-copilot-cli-1.0.14-win32-x64.zip.sha256'), platform: 'win32-x64' })).toEqual(['copilot-cli']);
            expect(planHarnesses({ versions: VERSIONS, existing: onRelease(VERSIONS), platform: 'darwin-arm64' })).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
        });

        it('a run that packages no harness lists every one from the previous manifest, with its hashes', async () => {
            await daemons();
            const previous = previousOf(VERSIONS);
            const manifest = buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous, existing: onRelease(VERSIONS) });
            expect(manifest.harnesses).toEqual(previous.harnesses);
            expect(staleHarnessAssets({ existing: [...onRelease(VERSIONS), 'agentic-daemon-win32-x64.zip', 'manifest.json'], manifest })).toEqual([]);
        });

        it('a version bump packages that runtime only: the others are carried, its old zips are stale', async () => {
            await daemons();
            for (const key of KEYS) await harness('codex-cli', key, '0.156.0');
            const versions = { ...VERSIONS, 'codex-cli': '0.156.0' };
            const existing = [...onRelease(VERSIONS), 'harness-claude-code-linux-x64.zip', 'harness-claude-code-linux-x64.zip.sha256', 'agentic-daemon-linux-x64.zip'];
            const manifest = buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: versions, previous: previousOf(VERSIONS), existing });
            expect(manifest.harnesses['claude-code']).toEqual(previousOf(VERSIONS).harnesses['claude-code']);
            expect(manifest.harnesses['codex-cli']).toEqual({
                version: '0.156.0',
                assets: Object.fromEntries(KEYS.map((key) => [key, { url: `${LATEST}/harness-codex-cli-0.156.0-${key}.zip`, sha256: createHash('sha256').update(`codex-cli 0.156.0 ${key}`).digest('hex'), bytes: `codex-cli 0.156.0 ${key}`.length, version: '0.156.0' }]))
            });
            // The uploaded zips are on the release by then: only the old codex ones and the pre-#441 names go.
            expect(staleHarnessAssets({ existing: [...existing, ...onRelease({ 'codex-cli': '0.156.0' })], manifest })).toEqual([
                ...onRelease({ 'codex-cli': '0.155.1' }),
                'harness-claude-code-linux-x64.zip',
                'harness-claude-code-linux-x64.zip.sha256'
            ]);
        });

        it('refuses a harness neither packaged nor on the release, and a packaged one at another version', async () => {
            await daemons();
            // No previous manifest (the first run after #441), nothing packaged.
            expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous: {}, existing: [] })).toThrow(/harness-claude-code-0\.3\.274-linux-x64\.zip was neither packaged/);
            // The previous manifest names it, but the zip is gone from the release.
            expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous: previousOf(VERSIONS), existing: onRelease(VERSIONS).filter((n) => !n.startsWith('harness-copilot-cli-1.0.14-win32-x64.zip')) })).toThrow(/copilot-cli-1\.0\.14-win32-x64\.zip was neither/);
            // The zip is there but not its .sha256 (plan would package it again).
            expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous: previousOf(VERSIONS), existing: onRelease(VERSIONS).filter((n) => n !== 'harness-codex-cli-0.155.1-linux-x64.zip.sha256') })).toThrow(/codex-cli-0\.155\.1-linux-x64\.zip was neither/);
            // The previous manifest is of another version.
            expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: { ...VERSIONS, 'claude-code': '0.3.275' }, previous: previousOf(VERSIONS), existing: onRelease(VERSIONS) })).toThrow(/claude-code-0\.3\.275-linux-x64\.zip was neither/);
            // A tag release carries nothing from daemon-latest: its own url base never matches.
            expect(() => buildManifest({ dir, tag: 'daemon-v0.2.0', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous: previousOf(VERSIONS), existing: onRelease(VERSIONS) })).toThrow(/was neither packaged/);
            await harness('claude-code', 'linux-x64', '0.3.273');
            expect(() => buildManifest({ dir, tag: 'daemon-latest', repo: 'andtii/agentic', stamp, protocol: 1, harnessVersions: VERSIONS, previous: previousOf(VERSIONS), existing: onRelease(VERSIONS) })).toThrow(/claude-code was packaged at 0\.3\.273, but this build pins 0\.3\.274/);
        });

        it('runs plan and stale as scripts, and the manifest with the carry-over flags', async () => {
            const script = join(DAEMON_DIR, 'scripts/lib/manifest.mjs');
            await writeFile(join(dir, 'versions.json'), JSON.stringify({ ...VERSIONS, 'codex-cli': '0.156.0' }));
            await writeFile(join(dir, 'existing.json'), JSON.stringify(onRelease(VERSIONS)));
            const plan = spawnSync(process.execPath, [script, 'plan', '--versions', join(dir, 'versions.json'), '--existing', join(dir, 'existing.json'), '--platform', 'win32-x64'], { encoding: 'utf8' });
            expect([plan.status, plan.stdout]).toEqual([0, 'codex-cli\n']);
            // No release yet: the existing file is missing, everything is packaged.
            const first = spawnSync(process.execPath, [script, 'plan', '--versions', join(dir, 'versions.json'), '--existing', join(dir, 'nope.json'), '--platform', 'win32-x64'], { encoding: 'utf8' });
            expect(first.stdout).toBe('claude-code copilot-cli codex-cli\n');

            await daemons();
            await writeFile(join(dir, 'versions.json'), JSON.stringify(VERSIONS));
            await writeFile(join(dir, 'previous.json'), JSON.stringify(previousOf(VERSIONS)));
            const out = join(dir, 'manifest.out.json');
            const env = { PATH: process.env.PATH ?? '', GITHUB_SHA: 'fedcba9876543210' };
            const built = spawnSync(process.execPath, [script, '--dir', dir, '--tag', 'daemon-latest', '--repo', 'andtii/agentic', '--out', out, '--harness-versions', join(dir, 'versions.json'), '--previous', join(dir, 'previous.json'), '--existing', join(dir, 'existing.json')], { encoding: 'utf8', env });
            expect(built.stderr).toBe('');
            expect((JSON.parse(readFileSync(out, 'utf8')) as ReleaseManifest).harnesses).toEqual(previousOf(VERSIONS).harnesses);

            await writeFile(join(dir, 'existing.json'), JSON.stringify([...onRelease(VERSIONS), 'harness-codex-cli-0.1.0-linux-x64.zip']));
            const stale = spawnSync(process.execPath, [script, 'stale', '--existing', join(dir, 'existing.json'), '--manifest', out], { encoding: 'utf8' });
            expect([stale.status, stale.stdout]).toEqual([0, 'harness-codex-cli-0.1.0-linux-x64.zip\n']);
            expect(spawnSync(process.execPath, [script, 'plan', '--existing', join(dir, 'existing.json')], { encoding: 'utf8' }).status).toBe(2);
        });
    });

    it('runs as a script: writes manifest.json for the release folder from this checkout\'s stamp', async () => {
        await zip('agentic-daemon-linux-arm64.zip', 'arm');
        await mkdir(join(dir, 'out'));
        const out = join(dir, 'out', 'manifest.json');
        const env = { PATH: process.env.PATH ?? '', GITHUB_SHA: 'fedcba9876543210', AGENTIC_DAEMON_TAG: 'daemon-v0.0.1-rc.1' };
        const run = spawnSync(process.execPath, [join(DAEMON_DIR, 'scripts/lib/manifest.mjs'), '--dir', dir, '--tag', 'daemon-v0.0.1-rc.1', '--repo', 'andtii/agentic', '--out', out], { encoding: 'utf8', env });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        const manifest = JSON.parse(readFileSync(out, 'utf8')) as ReleaseManifest;
        expect(typeof manifest.publishedAt).toBe('number');
        expect(manifest).toMatchObject({ version: '0.0.1-rc.1', channel: 'stable', commit: 'fedcba9', protocol: DAEMON_PROTOCOL_VERSION });
        expect(manifest.assets['linux-arm64']?.sha256).toBe(createHash('sha256').update('arm').digest('hex'));
        expect(spawnSync(process.execPath, [join(DAEMON_DIR, 'scripts/lib/manifest.mjs'), '--dir', dir], { encoding: 'utf8' }).status).toBe(2);
    });
});

describe('harness packages (#369)', () => {
    const key = `${process.platform}-${process.arch}`;

    it('the daemon locates harnesses by the same table the packaging script builds them with', () => {
        expect(Object.keys(BUILTIN_HARNESSES)).toEqual(Object.keys(HARNESSES));
        for (const [runtime, spec] of Object.entries(HARNESSES)) {
            const ours = BUILTIN_HARNESSES[runtime]!;
            expect(ours.sdk, runtime).toBe(spec.sdk);
            for (const platform of Object.keys(CODEX_TRIPLES)) {
                expect(ours.native(platform), `${runtime} ${platform}`).toBe(spec.native(platform));
                expect(ours.binary(platform), `${runtime} ${platform}`).toBe(spec.binary(platform));
                // Every native package is one the daemon zip leaves out.
                expect(isNativeHarnessPackage(spec.native(platform)), spec.native(platform)).toBe(true);
            }
        }
        for (const name of ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@openai/codex', 'koffi']) expect(isNativeHarnessPackage(name), name).toBe(false);
    });

    describe('a harness zip built from the workspace', () => {
        let dir: string;
        beforeEach(async () => {
            dir = await mkdtemp(join(tmpdir(), 'agentic-harness-pkg-'));
        });
        afterEach(async () => {
            await rm(dir, { recursive: true, force: true });
        });

        it('holds the native package, a manifest the unpacked tree matches, and installs through the store', async () => {
            const lines: string[] = [];
            const result = packageHarness({ runtime: 'copilot-cli', outDir: dir, sha256: true, log: (l) => lines.push(l) });
            expect(basename(result.zipFile)).toBe(`harness-copilot-cli-${result.version}-${key}.zip`);
            expect(result.version).toBe(sdkVersion('copilot-cli'));
            expect(result.binary).toBe(`node_modules/@github/copilot-sdk-${key}/${HARNESSES['copilot-cli']!.binary(key)}`);
            expect(lines[0]).toMatch(new RegExp(`copilot-cli ${result.version.replace(/\./g, '\\.')}, \\d+ files`));
            const described = JSON.parse(readFileSync(`${result.zipFile}.json`, 'utf8')) as Record<string, unknown>;
            expect(described).toEqual({ runtime: 'copilot-cli', version: result.version, platform: key, binary: result.binary, packages: [`@github/copilot-sdk-${key}`], sha256: result.tree });
            expect(readSidecar(`${result.zipFile}.sha256`)).toBe(result.sha256);

            const unpacked = join(dir, 'unpacked');
            await extractZipFile(result.zipFile, unpacked);
            expect(JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'))).toEqual(described);
            expect(await treeHashOf(unpacked)).toBe(result.tree);
            expect(existsSync(join(unpacked, ...result.binary.split('/')))).toBe(true);
            // Only the native package: no JavaScript SDK, nothing of another platform.
            expect(readZip(readFileSync(result.zipFile)).every((e) => e.name === 'manifest.json' || e.name.startsWith(`node_modules/@github/copilot-sdk-${key}/`))).toBe(true);

            // The store downloads, verifies and installs it.
            const server = await serveFiles();
            try {
                server.put('h.zip', readFileSync(result.zipFile));
                const store = harnessStore({ root: join(dir, 'harnesses'), bundled: false, allowLoopbackHttp: true });
                await store.stage('copilot-cli', { url: server.url('h.zip'), sha256: result.sha256!, bytes: result.bytes, version: result.version });
                await store.activate('copilot-cli', result.version);
                expect(store.locate('copilot-cli')).toMatchObject({ version: result.version, source: 'store', binary: join(dir, 'harnesses', 'copilot-cli', result.version, ...result.binary.split('/')) });
                expect(existsSync(store.locate('copilot-cli')!.binary)).toBe(true);
            } finally {
                await server.close();
            }
        }, 300_000);

        it('refuses a runtime it does not know', () => {
            expect(() => packageHarness({ runtime: 'nope', outDir: dir, log: () => {} })).toThrow(/no harness "nope"/);
        });
    });
});

describe('installer', () => {
    it('resolves the production closure: workspace packages and the runtime SDKs’ JavaScript — never a native runtime (#369), no dev dependencies', () => {
        const closure = resolveClosure(DAEMON_DIR);
        const names = new Set([...closure.values()].map((s) => s.name));
        for (const name of ['@agentic/core', '@agentic/daemon-protocol', '@agentic/runtimes', '@sigx/ai-agent-claude-code', '@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk', '@openai/codex', 'ws']) {
            expect(names, name).toContain(name);
        }
        for (const name of ['vite', 'typescript', 'vitest', '@sigx/vite', '@types/ws']) expect(names, name).not.toContain(name);
        // The native runtimes are harness packages: no platform's is placed, not even under the Codex alias.
        for (const target of closure.keys()) expect(isNativeHarnessPackage(target.replace(/^.*node_modules\//, '')), target).toBe(false);
        expect(closure.has(`node_modules/@openai/codex-${process.platform}-${process.arch}`)).toBe(false);
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
            // Without the native runtimes (#369): tens of MB, not hundreds.
            expect(result.bytes).toBeLessThan(50 * 1024 * 1024);
            // the version the build stamped (dist/build.json), not a hand-edited twin of package.json
            const stamp = JSON.parse(readFileSync(join(DAEMON_DIR, 'dist', 'build.json'), 'utf8')) as { version: string; commit: string; channel: string };
            expect(result.version).toBe(stamp.version);
            expect(stamp.version).toMatch(stamp.channel === 'stable' ? /^\d+\.\d+\.\d+/ : /^\d+\.\d+\.\d+-main\.\d+\.(g?[0-9a-f]{7}|unknown)$/);
            expect(result.sha256).toBeUndefined();
            expect(lines[0]).toMatch(/^package: .*\.zip — \d+ files/);

            const unpacked = join(dir, 'unpacked');
            const files = extractZip(result.zipFile, unpacked);
            for (const f of ['README.md', 'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh', 'package.json', 'bin/agentic-daemon.mjs', 'dist/cli.js', 'scripts/install-service.ps1', 'scripts/uninstall-service.ps1', 'scripts/install-service.sh', 'scripts/uninstall-service.sh', 'scripts/supervise.mjs', 'node_modules/@agentic/core/package.json', 'node_modules/@agentic/runtimes/dist/index.js', 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs']) {
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
            expect(files.some((f) => isNativeHarnessPackage(f.replace(/^node_modules\//, '')))).toBe(false);
            const run = (args: string[]) =>
                spawnSync(process.execPath, ['bin/agentic-daemon.mjs', ...args], { cwd: unpacked, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', AGENTIC_DAEMON_HOME: join(dir, 'home'), AGENTIC_INSTALL_DIR: join(dir, 'install') } });
            const version = run(['--version']);
            expect(version.stderr).toBe('');
            expect(version.status).toBe(0);
            expect(version.stdout.trim()).toBe(`agentic-daemon ${stamp.version} (${stamp.commit}, protocol ${DAEMON_PROTOCOL_VERSION}, ${stamp.channel})`);

            // The supervisor (#362) runs on its own: node builtins only, from a folder with no node_modules.
            const supervisor = spawnSync(process.execPath, [join(unpacked, 'scripts', 'supervise.mjs'), '--version'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
            expect(supervisor.status, supervisor.stderr).toBe(0);
            expect(supervisor.stdout.trim()).toBe(`agentic-supervisor ${SUPERVISOR_VERSION}`);

            // `doctor` on an unpaired home: the whole closure loads (drivers, runtimes, the SDK), the verdict is "not paired".
            const doctor = run(['doctor']);
            expect(doctor.status).toBe(1);
            expect(doctor.stdout).toMatch(/not paired/);
            // No harness is installed and none ships in the zip: each runtime says how to install one.
            for (const runtime of ['claude-code', 'copilot-cli', 'codex-cli']) expect(doctor.stdout).toContain(`no ${runtime} harness in ${join(dir, 'install', 'harnesses')} — install it with \`agentic-daemon harness install ${runtime}\``);
            const list = run(['harness', 'list']);
            expect(list.status, list.stderr).toBe(0);
            expect(list.stdout).toContain('claude-code\tnot installed');
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
