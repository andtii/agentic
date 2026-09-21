// @vitest-environment node
/**
 * The harness store and locator (#369): install / update / remove against a local HTTP server, the locator with and
 * without `current.json`, the drivers built from it, and `agentic-daemon harness` from the terminal.
 */
import type { EnvironmentId, LocalEnvironment, ReleaseManifest, SessionId } from '@agentic/core';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowAll } from '@sigx/ai-agent';
import { builtinRuntimes, harnessMissingDriver, isDisposable } from '../src/drivers';
import { writeEnvironments } from '../src/env-store';
import { harnessCommand, harnessManifestUrl } from '../src/harness-cli';
import { bundledHarness, extractZipFile, HarnessError, HarnessMissingError, harnessStore, releaseManifestUrl, sdkVersion, treeHashOf, type HarnessLocation } from '../src/harness';
import { fakeHarnessZip, PLATFORM, serveFiles, type FileServer } from './helpers/harness';

describe('harness store', () => {
    let dir: string;
    let root: string;
    let server: FileServer;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-harness-'));
        root = join(dir, 'install', 'harnesses');
        server = await serveFiles();
    });
    afterEach(async () => {
        await server.close();
        await rm(dir, { recursive: true, force: true });
    });

    const store = (bundled?: (runtime: string) => HarnessLocation | undefined) => harnessStore({ root, allowLoopbackHttp: true, bundled: bundled ?? false, pinned: (r) => (r === 'fake' ? '2.0.0' : undefined), now: () => 1_700_000_000_000 });
    const publish = async (runtime: string, version: string, options: Parameters<typeof fakeHarnessZip>[3] = {}) => {
        const zip = await fakeHarnessZip(dir, runtime, version, options);
        const name = `harness-${runtime}-${version}.zip`;
        server.put(name, zip.bytes);
        return { ...zip, target: zip.asset(server.url(name)) };
    };

    it('without current.json: the bundled fallback, else missing; with it: the installed version, its directory and executable', async () => {
        const bundled: HarnessLocation = { runtime: 'fake', version: '0.9.0', dir: '/sdk/native', binary: '/sdk/native/run', source: 'bundled', installedAt: 0 };
        expect(store().locate('fake')).toBeUndefined();
        expect(store().state('fake')).toEqual({ status: 'missing' });
        expect(store((r) => (r === 'fake' ? bundled : undefined)).locate('fake')).toEqual(bundled);

        const v1 = await publish('fake', '1.0.0');
        const phases: string[] = [];
        const staged = await store().stage('fake', v1.target, { onPhase: (p) => phases.push(p) });
        expect(phases).toEqual(['downloading', 'verifying', 'staged']);
        expect(staged).toEqual({ version: '1.0.0', dir: join(root, 'fake', '1.0.0'), already: false });
        // Staged is not current: nothing located yet.
        expect(store().locate('fake')).toBeUndefined();
        await store().activate('fake', '1.0.0');
        const located = store((r) => (r === 'fake' ? bundled : undefined)).locate('fake');
        expect(located).toEqual({ runtime: 'fake', version: '1.0.0', dir: join(root, 'fake', '1.0.0'), binary: join(root, 'fake', '1.0.0', ...v1.binary.split('/')), source: 'store', installedAt: 1_700_000_000_000 });
        expect(await readFile(located!.binary, 'utf8')).toBe('fake 1.0.0\n');
        expect(JSON.parse(await readFile(join(root, 'fake', 'current.json'), 'utf8'))).toEqual({ version: '1.0.0', installedAt: 1_700_000_000_000 });
        // No download or staging file is left behind.
        expect((await readdir(join(root, 'fake'))).sort()).toEqual(['1.0.0', 'current.json']);
        expect(store().reports(['fake', 'other'])).toEqual([
            { runtime: 'fake', installed: { version: '1.0.0', at: 1_700_000_000_000 }, status: 'ready', current: false },
            { runtime: 'other', status: 'missing' }
        ]);
    });

    it('an update stages beside the current version; activate switches, prune removes the old one; the same version again is not downloaded', async () => {
        const v1 = await publish('fake', '1.0.0');
        const v2 = await publish('fake', '2.0.0');
        await store().stage('fake', v1.target);
        await store().activate('fake', '1.0.0');
        await store().stage('fake', v2.target);
        expect(store().locate('fake')?.version).toBe('1.0.0');
        await store().activate('fake', '2.0.0');
        expect(await store().prune('fake')).toEqual([]);
        expect((await readdir(join(root, 'fake'))).sort()).toEqual(['2.0.0', 'current.json']);
        expect(store().reports(['fake'])[0]).toMatchObject({ status: 'ready', installed: { version: '2.0.0' }, current: true });
        const requests = server.requests.length;
        expect(await store().stage('fake', v2.target)).toMatchObject({ version: '2.0.0', already: true });
        expect(server.requests.length).toBe(requests);
    });

    it('refuses a download whose sha256, size or tree does not match, a package of another runtime or version, an entry that escapes — and leaves nothing behind', async () => {
        const good = await publish('fake', '1.0.0');
        const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof HarnessError ? e.code : `unexpected ${String(e)}`));
        expect(await code(store().stage('fake', { ...good.target, sha256: '0'.repeat(64) }))).toBe('checksum');
        expect(await code(store().stage('fake', { ...good.target, bytes: good.target.bytes + 1 }))).toBe('checksum');
        expect(await code(store().stage('fake', { ...good.target, url: server.url('nope.zip') }))).toBe('download-failed');
        expect(await code(store().stage('fake', (await publish('fake', '1.1.0', { tamper: 'tree' })).target))).toBe('checksum');
        expect(await code(store().stage('fake', (await publish('fake', '1.2.0', { tamper: 'escape' })).target))).toBe('invalid-package');
        expect(existsSync(join(dir, 'escaped.txt'))).toBe(false);
        expect(await code(store().stage('other', good.target))).toBe('invalid-package');
        expect(await code(store().stage('fake', { ...good.target, version: '9.9.9' }))).toBe('invalid-package');
        expect(await code(store().stage('fake', (await publish('fake', '1.3.0', { manifest: { platform: 'plan9-mips' } })).target))).toBe('invalid-package');
        expect(await code(store().stage('../up', good.target))).toBe('invalid');
        // Outside tests a harness comes over https: only, like an update.
        expect(await code(harnessStore({ root, bundled: false }).stage('fake', good.target))).toBe('invalid');
        expect(await code(store().stage('fake', { ...good.target, version: '../1' }))).toBe('invalid');
        expect(await readdir(join(root, 'fake'))).toEqual([]);
        expect(await readdir(join(root, 'other'))).toEqual([]);
    });

    it('reports a broken install — current.json naming a missing version, or a package without its executable', async () => {
        await mkdir(join(root, 'fake'), { recursive: true });
        await writeFile(join(root, 'fake', 'current.json'), JSON.stringify({ version: '1.0.0', installedAt: 5 }));
        expect(store().state('fake')).toMatchObject({ status: 'broken', version: '1.0.0' });
        expect(store().reports(['fake'])).toEqual([{ runtime: 'fake', installed: { version: '1.0.0', at: 5 }, status: 'broken' }]);
        const v1 = await publish('fake', '1.0.0');
        await store().stage('fake', v1.target);
        expect(store().state('fake').status).toBe('ready');
        await rm(join(root, 'fake', '1.0.0', ...v1.binary.split('/')));
        expect(store().state('fake')).toMatchObject({ status: 'broken', problem: expect.stringMatching(/missing/) });
        await writeFile(join(root, 'fake', 'current.json'), 'not json');
        expect(store().state('fake')).toMatchObject({ status: 'broken', problem: 'current.json names no version' });
    });

    it('remove deletes the runtime from the store; a store without it answers false', async () => {
        const v1 = await publish('fake', '1.0.0');
        await store().stage('fake', v1.target);
        await store().activate('fake', '1.0.0');
        expect(await store().remove('fake')).toBe(true);
        expect(existsSync(join(root, 'fake'))).toBe(false);
        expect(store().state('fake')).toEqual({ status: 'missing' });
        expect(await store().remove('fake')).toBe(false);
    });

    it('extractZipFile and treeHashOf agree with the packaging script', async () => {
        const zip = await fakeHarnessZip(dir, 'fake', '1.0.0');
        const out = join(dir, 'out');
        expect(await extractZipFile(zip.file, out)).toBe(3);
        const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { sha256: string };
        expect(await treeHashOf(out)).toBe(manifest.sha256);
    });
});

describe('bundled harnesses (a workspace checkout)', () => {
    it("finds the native package beside the SDK in the daemon's node_modules, at the SDK's version", () => {
        for (const runtime of ['claude-code', 'copilot-cli', 'codex-cli']) {
            const found = bundledHarness(runtime);
            expect(found, runtime).toBeDefined();
            expect(existsSync(found!.binary), found!.binary).toBe(true);
            expect(found!.version).toBe(sdkVersion(runtime));
            expect(found!.source).toBe('bundled');
        }
        expect(bundledHarness('nope')).toBeUndefined();
        expect(bundledHarness('codex-cli', 'plan9-mips')).toBeUndefined();
    });
});

describe('drivers from the harness locator', () => {
    const env = (runtime: string): LocalEnvironment => ({ id: `env_${runtime}` as EnvironmentId, name: runtime, runtime, cwdRoots: [tmpdir()], concurrency: 1 });

    it('a runtime without a harness is registered as harness-missing: unknown sign-in, an error verdict, open refused by code', async () => {
        let installed: HarnessLocation | undefined;
        const { drivers, quotaSources, rebuild, current } = builtinRuntimes({ harnesses: { locate: () => installed } });
        expect(drivers.map((d) => d.runtime)).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
        expect(drivers.some(isDisposable)).toBe(false);
        expect(quotaSources.map((s) => s.runtime)).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
        const claude = drivers[0]!;
        expect(await claude.inspect(env('claude-code'))).toMatchObject({ authStatus: 'unknown', capabilities: { runtime: 'claude-code', supported: [] } });
        expect(await claude.doctor([env('claude-code')])).toMatchObject({ ok: false, findings: [{ level: 'error', code: 'harness-missing', environmentIds: ['env_claude-code'] }] });
        await expect(claude.open(env('claude-code'), { agentId: 'a', cwd: tmpdir(), system: 's', tools: [] }, { sessionId: 's' as SessionId, callTool: async () => null, policy: allowAll })).rejects.toBeInstanceOf(HarnessMissingError);
        expect(await quotaSources[0]!.probe!(env('claude-code'), { now: Date.now, log: () => {} } as never)).toBeNull();
        // Rebuilt once the harness is there: the real driver.
        installed = { runtime: 'claude-code', version: '1.0.0', dir: '/h', binary: '/h/claude', source: 'store', installedAt: 1 };
        expect(isDisposable(rebuild('claude-code')!)).toBe(true);
        expect(current().map((d) => isDisposable(d))).toEqual([true, false, false]);
        expect(rebuild('nope')).toBeUndefined();
    });

    it('a located harness builds the real drivers', () => {
        const at = (runtime: string): HarnessLocation => ({ runtime, version: '1.0.0', dir: '/h', binary: `/h/${runtime}`, source: 'store', installedAt: 1 });
        const { drivers } = builtinRuntimes({ harnesses: { locate: at } });
        expect(drivers.every(isDisposable)).toBe(true);
        expect(isDisposable(harnessMissingDriver('x'))).toBe(false);
    });
});

describe('release manifests', () => {
    it('by pinned version, by channel, or the stable build’s own release', () => {
        expect(releaseManifestUrl({ version: '0.2.0' })).toBe('https://github.com/andtii/agentic/releases/download/daemon-v0.2.0/manifest.json');
        expect(releaseManifestUrl({ version: 'daemon-v0.2.0', releases: 'http://x/releases/' })).toBe('http://x/releases/download/daemon-v0.2.0/manifest.json');
        expect(releaseManifestUrl({ channel: 'stable' })).toBe('https://github.com/andtii/agentic/releases/download/daemon-stable/manifest.json');
        expect(() => releaseManifestUrl({ channel: 'nightly' })).toThrow(/unknown channel/);
        const latest = { version: '0.1.0-main.abcdef0', channel: 'latest' };
        const stable = { version: '0.3.0', channel: 'stable' };
        expect(harnessManifestUrl({}, {}, latest)).toMatch(/daemon-latest\/manifest\.json$/);
        expect(harnessManifestUrl({}, {}, stable)).toMatch(/daemon-v0\.3\.0\/manifest\.json$/);
        expect(harnessManifestUrl({}, { AGENTIC_CHANNEL: 'stable', AGENTIC_RELEASES: 'http://r' }, latest)).toBe('http://r/download/daemon-stable/manifest.json');
        expect(harnessManifestUrl({ version: '0.4.0', channel: 'latest' }, {}, stable)).toMatch(/daemon-v0\.4\.0\//);
        expect(harnessManifestUrl({ manifest: 'http://m/manifest.json' }, {}, stable)).toBe('http://m/manifest.json');
    });
});

describe('agentic-daemon harness', () => {
    let dir: string;
    let server: FileServer;
    let out: string[];
    let err: string[];
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-harness-cli-'));
        server = await serveFiles();
        out = [];
        err = [];
    });
    afterEach(async () => {
        await server.close();
        await rm(dir, { recursive: true, force: true });
    });

    const release = async (version: string, harnessVersion: string) => {
        const zip = await fakeHarnessZip(dir, 'fake', harnessVersion);
        server.put(`r${version}/harness-fake.zip`, zip.bytes);
        const manifest: ReleaseManifest = {
            version,
            channel: 'stable',
            publishedAt: 0,
            commit: 'abcdef0',
            protocol: 1,
            assets: {},
            harnesses: { fake: { version: harnessVersion, assets: { [PLATFORM]: zip.asset(server.url(`r${version}/harness-fake.zip`)) } } }
        };
        server.put(`download/daemon-v${version}/manifest.json`, JSON.stringify(manifest));
    };
    const context = () => ({
        store: harnessStore({ root: join(dir, 'harnesses'), bundled: false, allowLoopbackHttp: true }),
        runtimes: ['fake', 'other'],
        paths: { environmentsFile: join(dir, 'environments.json') },
        out: (t: string) => out.push(t),
        err: (t: string) => err.push(t),
        env: { AGENTIC_RELEASES: server.url('').replace(/\/$/, '') },
        build: { version: '1.0.0', channel: 'stable' }
    });
    const run = (argv: string[], flags: Record<string, string | true> = {}) => harnessCommand(argv[0], argv.slice(1), flags, context());

    it('installs from the release this daemon came from, lists, updates only when the release moved on, and removes — never under an environment', async () => {
        await release('1.0.0', '5.0.0');
        await release('1.1.0', '5.1.0');
        expect(await run(['list'])).toBe(0);
        expect(out).toContain('fake\tnot installed\t(agentic-daemon harness install fake)');

        expect(await run(['install', 'fake'])).toBe(0);
        expect(out.some((l) => l.includes('daemon-v1.0.0/manifest.json'))).toBe(true);
        expect(out.at(-1)).toMatch(/^installed fake 5\.0\.0 .*a running daemon uses it after a restart$/);
        expect(harnessStore({ root: join(dir, 'harnesses'), bundled: false }).locate('fake')?.version).toBe('5.0.0');

        out = [];
        expect(await run(['update'])).toBe(0);
        expect(out.at(-1)).toBe('fake 5.0.0 is up to date');
        expect(await run(['update', 'fake'], { version: '1.1.0' })).toBe(0);
        expect(out.at(-1)).toMatch(/^installed fake 5\.1\.0/);
        // The CLI leaves the old version for the daemon to prune on its next start: a running one may still use it.
        expect((await readdir(join(dir, 'harnesses', 'fake'))).sort()).toEqual(['5.0.0', '5.1.0', 'current.json']);

        await writeEnvironments(join(dir, 'environments.json'), [{ id: 'env_f' as EnvironmentId, name: 'F', runtime: 'fake', cwdRoots: [dir], concurrency: 1 }], { run: async () => ({ code: 0, stderr: '' }) });
        expect(await run(['rm', 'fake'])).toBe(1);
        expect(err.at(-1)).toMatch(/env_f runs on fake; remove it first/);
        await writeEnvironments(join(dir, 'environments.json'), [], { run: async () => ({ code: 0, stderr: '' }) });
        expect(await run(['rm', 'fake'])).toBe(0);
        expect(await run(['rm', 'fake'])).toBe(1);
        expect(err.at(-1)).toMatch(/has no harness installed/);
    });

    it('names what it cannot do: an unknown runtime, a release without the harness, a missing manifest, usage', async () => {
        expect(await run(['install', 'nope'])).toBe(1);
        expect(err.at(-1)).toMatch(/no runtime nope/);
        await release('1.0.0', '5.0.0');
        expect(await run(['install', 'other'])).toBe(1);
        expect(err.at(-1)).toMatch(/ships no other harness/);
        expect(await run(['install', 'fake'], { version: '9.9.9' })).toBe(1);
        expect(err.at(-1)).toMatch(/no release manifest at .*daemon-v9\.9\.9/);
        expect(await run(['install'])).toBe(2);
        expect(await run(['install', 'fake'], { channel: true })).toBe(2);
        expect(await run(['frobnicate'])).toBe(2);
        expect(await run(['rm'])).toBe(2);
    });
});

describe('env add / env login with harnesses', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-harness-env-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('login runs the installed harness for Claude Code and Codex, the copilot CLI for Copilot; add says how to install a missing harness', async () => {
        const { envCommand } = await import('../src/env-cli');
        const paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), credentialsFile: join(dir, 'c.json'), environmentsFile: join(dir, 'config', 'environments.json'), policyFile: join(dir, 'p.json'), sessionsDir: join(dir, 's') };
        const located = (runtime: string): HarnessLocation | undefined => (runtime === 'copilot-cli' ? undefined : { runtime, version: '1.0.0', dir: '/h', binary: `/h/${runtime}/bin`, source: 'store', installedAt: 1 });
        const logins: { command: string; args: readonly string[] }[] = [];
        const out: string[] = [];
        const err: string[] = [];
        const drivers = ['claude-code', 'copilot-cli', 'codex-cli'].map((runtime) => harnessMissingDriver(runtime));
        const c = { paths, drivers, out: (t: string) => out.push(t), err: (t: string) => err.push(t), secure: { run: async () => ({ code: 0, stderr: '' }) }, env: {}, harnesses: { locate: located }, login: async (command: string, args: readonly string[]) => (logins.push({ command, args }), 0) };
        for (const [id, runtime] of [['env_c', 'claude-code'], ['env_o', 'copilot-cli'], ['env_x', 'codex-cli']] as const) {
            const argv = ['env', 'add', '--name', id, '--id', id, '--runtime', runtime, '--root', dir];
            expect(await envCommand(argv, 'add', [], { name: id, id, runtime, root: dir }, c)).toBe(0);
        }
        expect(err).toEqual(['the copilot-cli harness is not installed: sessions on this environment are refused until you run `agentic-daemon harness install copilot-cli`']);
        for (const id of ['env_c', 'env_o', 'env_x']) expect(await envCommand(['env', 'login', id], 'login', [id], {}, c)).toBe(0);
        expect(logins).toEqual([
            { command: '/h/claude-code/bin', args: ['/login'] },
            { command: 'copilot', args: ['login'] },
            { command: '/h/codex-cli/bin', args: ['login'] }
        ]);
    });
});
