/**
 * The harness store (#369; EXE-08, PLG-02, PLG-09): each harness runtime's native build lives apart from the daemon,
 * installed from a `harness-<runtime>-<os>-<arch>.zip` (`scripts/package.mjs --harness`) into
 *
 *     <install root>/harnesses/<runtime>/<version>/   the unpacked zip: node_modules/<native package>/…, manifest.json
 *     <install root>/harnesses/<runtime>/current.json { version, installedAt }
 *
 * `locate(runtime)` is what the drivers are built with (`builtinRuntimes({ harnesses })`): the version `current.json`
 * names, its directory and its executable. Without one it falls back to the native package installed beside the SDK in
 * the daemon's own `node_modules` — a workspace checkout, or a zip from before #369; the release zip has none — and
 * otherwise the runtime is missing: its environments report `harness-missing` and `session.open` on them is refused so.
 * An executable on `PATH` is never used; `doctor` only mentions it.
 *
 * `stage` downloads a release asset, checks its sha256, unpacks it and checks the tree against the package's
 * `manifest.json` into `<version>/` beside the current one; `activate` switches `current.json`; `prune` removes the
 * others. The daemon drains the runtime between the two (`daemon.ts`, `harness.request`), the CLI does not
 * (`harness-cli.ts`): a running daemon takes a version installed from the terminal on its next start.
 */

import type { HarnessPhase, HarnessReport, ReleaseAsset, ReleaseManifest } from '@agentic/core';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { downloadAsset, UpdateError } from './update.js';

/** Rust target triples of the Codex builds, by release asset key. */
const CODEX_TRIPLES: Readonly<Record<string, string>> = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc'
};

const exe = (key: string): string => (key.startsWith('win32-') ? '.exe' : '');

export interface HarnessSpec {
    /** The SDK package the daemon depends on; it pins its native package to its own version. */
    readonly sdk: string;
    /** The native package for a release asset key (`<os>-<arch>`). */
    readonly native: (key: string) => string;
    /** The executable inside the native package. */
    readonly binary: (key: string) => string;
    /** The upstream CLI's command, which `doctor` names when it is on `PATH` (the daemon never runs it). */
    readonly command: string;
}

/**
 * The runtimes this build ships drivers for, and where each SDK's native build is (the table `scripts/lib/harness.mjs`
 * packages with; `package.test.ts` keeps the two equal). How each SDK is pointed at the executable is `drivers.ts`.
 */
export const BUILTIN_HARNESSES: Readonly<Record<string, HarnessSpec>> = {
    'claude-code': { sdk: '@anthropic-ai/claude-agent-sdk', native: (key) => `@anthropic-ai/claude-agent-sdk-${key}`, binary: (key) => `claude${exe(key)}`, command: 'claude' },
    'copilot-cli': { sdk: '@github/copilot-sdk', native: (key) => `@github/copilot-sdk-${key}`, binary: (key) => `prebuilds/${key}/copilot-runtime${exe(key)}`, command: 'copilot' },
    'codex-cli': {
        sdk: '@openai/codex',
        command: 'codex',
        native: (key) => `@openai/codex-${key}`,
        binary: (key) => {
            const triple = CODEX_TRIPLES[key];
            if (!triple) throw new Error(`harness: Codex has no build for ${key}`);
            return `vendor/${triple}/bin/codex${exe(key)}`;
        }
    }
};

/** What an unpacked harness package says about itself (`manifest.json` at its root). */
export interface HarnessPackageManifest {
    readonly runtime: string;
    /** The upstream version. */
    readonly version: string;
    /** The release asset key it was built for, `<os>-<arch>`. */
    readonly platform: string;
    /** The executable, relative to the package root, `/`-separated. */
    readonly binary: string;
    readonly packages: readonly string[];
    /** `treeHash` of every other file. */
    readonly sha256: string;
}

/** Where a runtime's harness is. */
export interface HarnessLocation {
    readonly runtime: string;
    readonly version: string;
    /** The version directory in the store, or the native package beside the SDK. */
    readonly dir: string;
    /** The runtime's executable, absolute. */
    readonly binary: string;
    /** `store`: installed under the install root; `bundled`: the native package in the daemon's own `node_modules`. */
    readonly source: 'store' | 'bundled';
    /** Epoch ms; 0 for a bundled one. */
    readonly installedAt: number;
}

export interface HarnessLocator {
    locate(runtime: string): HarnessLocation | undefined;
}

export type HarnessState =
    | { readonly status: 'ready'; readonly location: HarnessLocation }
    | { readonly status: 'missing' }
    | { readonly status: 'broken'; readonly problem: string; readonly version?: string; readonly installedAt?: number };

/** A named failure of a harness change — the `code` goes out as `harness.status.error.code`. */
export class HarnessError extends Error {
    override readonly name = 'HarnessError';
    constructor(
        readonly code: 'invalid' | 'download-failed' | 'checksum' | 'invalid-package' | 'in-use' | 'not-installed' | 'io',
        message: string
    ) {
        super(message);
    }
}

/** What a driver whose runtime has no harness throws from `open`: the daemon refuses the session with code `harness-missing`. */
export class HarnessMissingError extends Error {
    override readonly name = 'HarnessMissingError';
    readonly code = 'harness-missing';
    constructor(readonly runtime: string) {
        super(`the ${runtime} harness is not installed on this machine — run \`agentic-daemon harness install ${runtime}\``);
    }
}

export interface StageOptions {
    readonly onPhase?: (phase: Extract<HarnessPhase, 'downloading' | 'verifying' | 'staged'>) => void;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
    /** Tests only: allow `http:` on the loopback. A harness is otherwise fetched over `https:` only, like an update. */
    readonly allowLoopbackHttp?: boolean;
}

export interface StagedHarness {
    readonly version: string;
    readonly dir: string;
    /** The version was already installed and current: nothing was downloaded. */
    readonly already: boolean;
}

export interface HarnessStore extends HarnessLocator {
    /** `<install root>/harnesses`. */
    readonly root: string;
    state(runtime: string): HarnessState;
    /** One report per runtime, in order. */
    reports(runtimes: Iterable<string>): HarnessReport[];
    /** The version this daemon was built with (its SDK's), when the runtime is a built-in one. */
    pinned(runtime: string): string | undefined;
    /** Download, verify and unpack `asset` into `<runtime>/<version>/`; `current.json` is not touched. */
    stage(runtime: string, asset: ReleaseAsset, options?: StageOptions): Promise<StagedHarness>;
    /** Make `version` the one `locate` finds. */
    activate(runtime: string, version: string): Promise<void>;
    /** Remove every version but the current one; resolves to the ones that could not be removed. */
    prune(runtime: string): Promise<string[]>;
    /** Remove the runtime's harness from the store; `false` when the store has none. */
    remove(runtime: string): Promise<boolean>;
}

export interface HarnessStoreOptions {
    /** `<install root>/harnesses` (`harnessRoot(installPaths())`). */
    readonly root: string;
    /** The fallback when the store has no version: `false` for none. Default: the native package beside the daemon's SDK. */
    readonly bundled?: false | ((runtime: string) => HarnessLocation | undefined);
    /** Default: the daemon's SDK version for a built-in runtime. */
    readonly pinned?: (runtime: string) => string | undefined;
    /** The release asset key; default this process's `<platform>-<arch>`. */
    readonly platform?: string;
    readonly now?: () => number;
    /** Tests only: every `stage` may fetch `http:` on the loopback. */
    readonly allowLoopbackHttp?: boolean;
}

/** `<install root>/harnesses`. */
export const harnessRoot = (install: { readonly root: string }): string => join(install.root, 'harnesses');

const RUNTIME_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;
export const isRuntimeId = (runtime: string): boolean => RUNTIME_ID.test(runtime) && !runtime.includes('..');
export const isHarnessVersion = (version: string): boolean => VERSION.test(version) && !version.includes('..');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Node's resolution of a bare package name from `fromDir` — the nearest `node_modules/<name>` up the tree — followed to its real directory. */
function findPackage(fromDir: string, name: string): string | undefined {
    let dir = fromDir;
    for (;;) {
        const candidate = join(dir, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const packageVersion = (dir: string): string | undefined => {
    try {
        const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version;
        return typeof version === 'string' ? version : undefined;
    } catch {
        return undefined;
    }
};

/** The version of a built-in runtime's SDK this daemon resolves from `fromDir`. */
export function sdkVersion(runtime: string, fromDir = MODULE_DIR): string | undefined {
    const spec = BUILTIN_HARNESSES[runtime];
    const dir = spec && findPackage(fromDir, spec.sdk);
    return dir ? packageVersion(dir) : undefined;
}

/** The native package installed beside the SDK in the daemon's own `node_modules` (a workspace checkout; never in the release zip). */
export function bundledHarness(runtime: string, platform = `${process.platform}-${process.arch}`, fromDir = MODULE_DIR): HarnessLocation | undefined {
    const spec = BUILTIN_HARNESSES[runtime];
    if (!spec) return undefined;
    const sdkDir = findPackage(fromDir, spec.sdk);
    if (!sdkDir) return undefined;
    let binaryRel: string;
    try {
        binaryRel = spec.binary(platform);
    } catch {
        return undefined;
    }
    const nativeDir = findPackage(sdkDir, spec.native(platform));
    if (!nativeDir) return undefined;
    const binary = join(nativeDir, ...binaryRel.split('/'));
    if (!existsSync(binary)) return undefined;
    return { runtime, version: packageVersion(sdkDir) ?? 'unknown', dir: nativeDir, binary, source: 'bundled', installedAt: 0 };
}

/** Parse a harness package's `manifest.json`; the reason when it is not one. */
export function parseHarnessManifest(value: unknown): HarnessPackageManifest | string {
    if (!isRecord(value)) return 'manifest.json is not an object';
    const { runtime, version, platform, binary, packages, sha256 } = value;
    if (typeof runtime !== 'string' || !isRuntimeId(runtime)) return 'manifest.json names no runtime';
    if (typeof version !== 'string' || !isHarnessVersion(version)) return 'manifest.json names no version';
    if (typeof platform !== 'string') return 'manifest.json names no platform';
    if (typeof binary !== 'string' || binary.startsWith('/') || binary.split('/').some((p) => p === '..' || p === '')) return 'manifest.json names no executable inside the package';
    if (!Array.isArray(packages) || !packages.every((p) => typeof p === 'string')) return 'manifest.json lists no packages';
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'manifest.json has no tree digest';
    return { runtime, version, platform, binary, packages: packages as string[], sha256 };
}

function readManifestSync(dir: string): HarnessPackageManifest | string {
    let text: string;
    try {
        text = readFileSync(join(dir, 'manifest.json'), 'utf8');
    } catch {
        return `${join(dir, 'manifest.json')} is missing`;
    }
    try {
        return parseHarnessManifest(JSON.parse(text));
    } catch {
        return 'manifest.json is not JSON';
    }
}

/**
 * `scripts/lib/harness.mjs`'s `treeHash` over an unpacked package: SHA-256 over `<relative posix path>\0<file sha256>\n`
 * per file in code-unit order of the paths, `manifest.json` at the root left out.
 */
export async function treeHashOf(dir: string): Promise<string> {
    const files: [string, string][] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
        for (const entry of await readdir(abs, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const childAbs = join(abs, entry.name);
            if (entry.isDirectory()) await walk(childAbs, childRel);
            else if (entry.isFile() && childRel !== 'manifest.json') files.push([childRel, childAbs]);
        }
    };
    await walk(dir, '');
    files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tree = createHash('sha256');
    for (const [rel, abs] of files) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(abs)) hash.update(chunk as Buffer);
        tree.update(`${rel}\0${hash.digest('hex')}\n`);
    }
    return tree.digest('hex');
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Unpack `file` under `dir`, one entry at a time (a harness holds executables of hundreds of MB). Methods 0 and 8, the
 * unix mode from the external attributes; an entry that would land outside `dir` is refused. The zips are
 * `scripts/lib/zip.mjs`'s — no ZIP64 — and their content is checked afterwards against the package's tree digest.
 */
export async function extractZipFile(file: string, dir: string): Promise<number> {
    const buf = await readFile(file);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
        if (buf.readUInt32LE(i) === EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new HarnessError('invalid-package', 'the download is not a zip');
    const root = resolve(dir);
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(pos) !== CENTRAL) throw new HarnessError('invalid-package', 'the zip has a broken central directory');
        const method = buf.readUInt16LE(pos + 10);
        const compressed = buf.readUInt32LE(pos + 20);
        const size = buf.readUInt32LE(pos + 24);
        const nameLength = buf.readUInt16LE(pos + 28);
        const extraLength = buf.readUInt16LE(pos + 30);
        const commentLength = buf.readUInt16LE(pos + 32);
        const mode = (buf.readUInt32LE(pos + 38) >>> 16) & 0o7777;
        const local = buf.readUInt32LE(pos + 42);
        const name = buf.toString('utf8', pos + 46, pos + 46 + nameLength);
        pos += 46 + nameLength + extraLength + commentLength;
        const target = resolve(root, name);
        if (target !== root && !target.startsWith(root + sep)) throw new HarnessError('invalid-package', `the zip entry ${name} escapes the package`);
        if (name.endsWith('/')) {
            await mkdir(target, { recursive: true });
            continue;
        }
        if (buf.readUInt32LE(local) !== LOCAL) throw new HarnessError('invalid-package', `the zip entry ${name} has no local header`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + compressed);
        const raw = method === 0 ? data : method === 8 ? inflateRawSync(data) : undefined;
        if (!raw) throw new HarnessError('invalid-package', `the zip entry ${name} uses method ${method}`);
        if (raw.length !== size) throw new HarnessError('invalid-package', `the zip entry ${name} is truncated`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, raw, { mode: mode || 0o644 });
    }
    return count;
}

/** The update client's download (`./update.ts`: `https:` only, hashed as it arrives, bounded in time and size), its failures named as a harness's. */
async function download(asset: ReleaseAsset, file: string, options: StageOptions): Promise<{ sha256: string; bytes: number }> {
    try {
        return await downloadAsset(asset, file, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
    } catch (e) {
        if (e instanceof UpdateError) throw new HarnessError(e.code === 'insecure-url' ? 'invalid' : 'download-failed', e.message);
        throw e;
    }
}

export function harnessStore(options: HarnessStoreOptions): HarnessStore {
    const { root } = options;
    const platform = options.platform ?? `${process.platform}-${process.arch}`;
    const now = options.now ?? Date.now;
    const bundled = options.bundled === false ? () => undefined : (options.bundled ?? ((runtime: string) => bundledHarness(runtime, platform)));
    const pinned = options.pinned ?? ((runtime: string) => sdkVersion(runtime));
    const runtimeDir = (runtime: string): string => {
        if (!isRuntimeId(runtime)) throw new HarnessError('invalid', `"${runtime}" is not a runtime id`);
        return join(root, runtime);
    };

    const readCurrent = (runtime: string): { version: string; installedAt: number } | 'none' | string => {
        let text: string;
        try {
            text = readFileSync(join(runtimeDir(runtime), 'current.json'), 'utf8');
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : `current.json is unreadable: ${(e as Error).message}`;
        }
        try {
            const value: unknown = JSON.parse(text);
            if (isRecord(value) && typeof value.version === 'string' && isHarnessVersion(value.version)) return { version: value.version, installedAt: typeof value.installedAt === 'number' ? value.installedAt : 0 };
        } catch {
            // below
        }
        return 'current.json names no version';
    };

    const state = (runtime: string): HarnessState => {
        if (!isRuntimeId(runtime)) return { status: 'missing' };
        const current = readCurrent(runtime);
        if (current === 'none') {
            const location = bundled(runtime);
            return location ? { status: 'ready', location } : { status: 'missing' };
        }
        if (typeof current === 'string') return { status: 'broken', problem: current };
        const dir = join(runtimeDir(runtime), current.version);
        const broken = (problem: string): HarnessState => ({ status: 'broken', problem, version: current.version, installedAt: current.installedAt });
        const manifest = readManifestSync(dir);
        if (typeof manifest === 'string') return broken(manifest);
        if (manifest.runtime !== runtime || manifest.version !== current.version) return broken(`${dir} holds ${manifest.runtime} ${manifest.version}`);
        const binary = join(dir, ...manifest.binary.split('/'));
        if (!existsSync(binary)) return broken(`${binary} is missing`);
        return { status: 'ready', location: { runtime, version: current.version, dir, binary, source: 'store', installedAt: current.installedAt } };
    };

    return {
        root,
        state,
        locate(runtime) {
            const s = state(runtime);
            return s.status === 'ready' ? s.location : undefined;
        },
        pinned,
        reports(runtimes) {
            return [...runtimes].map((runtime): HarnessReport => {
                const s = state(runtime);
                const pin = pinned(runtime);
                if (s.status === 'ready') return { runtime, installed: { version: s.location.version, at: s.location.installedAt }, status: 'ready', ...(pin !== undefined ? { current: s.location.version === pin } : {}) };
                if (s.status === 'broken') return { runtime, ...(s.version !== undefined ? { installed: { version: s.version, at: s.installedAt ?? 0 } } : {}), status: 'broken' };
                return { runtime, status: 'missing' };
            });
        },
        async stage(runtime, asset, stageOptions = {}) {
            const base = runtimeDir(runtime);
            if (!isHarnessVersion(asset.version)) throw new HarnessError('invalid', `"${asset.version}" is not a version`);
            if (!/^[0-9a-f]{64}$/i.test(asset.sha256)) throw new HarnessError('invalid', 'the target names no sha256');
            const current = state(runtime);
            const dir = join(base, asset.version);
            if (current.status === 'ready' && current.location.source === 'store' && current.location.version === asset.version) return { version: asset.version, dir, already: true };
            await mkdir(base, { recursive: true });
            const id = randomBytes(6).toString('hex');
            const zip = join(base, `.download-${id}.zip`);
            const staging = join(base, `.staging-${id}`);
            try {
                stageOptions.onPhase?.('downloading');
                const got = await download(asset, zip, { ...stageOptions, ...(options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}) });
                stageOptions.onPhase?.('verifying');
                if (got.sha256 !== asset.sha256.toLowerCase()) throw new HarnessError('checksum', `the download's sha256 is ${got.sha256}, the release names ${asset.sha256}`);
                if (asset.bytes > 0 && got.bytes !== asset.bytes) throw new HarnessError('checksum', `the download is ${got.bytes} bytes, the release names ${asset.bytes}`);
                await extractZipFile(zip, staging);
                const manifest = readManifestSync(staging);
                if (typeof manifest === 'string') throw new HarnessError('invalid-package', manifest);
                if (manifest.runtime !== runtime) throw new HarnessError('invalid-package', `the package is ${manifest.runtime}, not ${runtime}`);
                if (manifest.version !== asset.version) throw new HarnessError('invalid-package', `the package is ${manifest.version}, the release names ${asset.version}`);
                if (manifest.platform !== platform) throw new HarnessError('invalid-package', `the package is for ${manifest.platform}, this machine is ${platform}`);
                if ((await treeHashOf(staging)) !== manifest.sha256) throw new HarnessError('checksum', 'the unpacked files do not match the package manifest');
                if (!existsSync(join(staging, ...manifest.binary.split('/')))) throw new HarnessError('invalid-package', `the package has no ${manifest.binary}`);
                // A leftover of the same version (never the current one: that returned above, or it is broken).
                await rm(dir, { recursive: true, force: true });
                await rename(staging, dir);
                stageOptions.onPhase?.('staged');
                return { version: asset.version, dir, already: false };
            } catch (e) {
                if (e instanceof HarnessError) throw e;
                throw new HarnessError('io', (e as Error).message);
            } finally {
                await rm(zip, { force: true }).catch(() => undefined);
                await rm(staging, { recursive: true, force: true }).catch(() => undefined);
            }
        },
        async activate(runtime, version) {
            const base = runtimeDir(runtime);
            if (!isHarnessVersion(version) || !existsSync(join(base, version))) throw new HarnessError('not-installed', `${runtime} ${version} is not in the store`);
            const tmp = join(base, `.current-${randomBytes(6).toString('hex')}.json`);
            await writeFile(tmp, `${JSON.stringify({ version, installedAt: now() })}\n`);
            await rename(tmp, join(base, 'current.json'));
        },
        async prune(runtime) {
            const base = runtimeDir(runtime);
            const current = readCurrent(runtime);
            const keep = typeof current === 'object' ? current.version : undefined;
            const failed: string[] = [];
            let names: string[];
            try {
                names = readdirSync(base);
            } catch {
                return failed;
            }
            for (const name of names) {
                if (name === keep || name === 'current.json' || name.startsWith('.')) continue;
                const path = join(base, name);
                try {
                    if (!statSync(path).isDirectory()) continue;
                    await rm(path, { recursive: true, force: true });
                } catch {
                    failed.push(path);
                }
            }
            return failed;
        },
        async remove(runtime) {
            const base = runtimeDir(runtime);
            if (!(await stat(base).then((s) => s.isDirectory(), () => false))) return false;
            try {
                await rm(base, { recursive: true, force: true });
            } catch (e) {
                throw new HarnessError('io', `cannot remove ${base}: ${(e as Error).message}`);
            }
            return true;
        }
    };
}

// ------------------------------------------------------------------ releases

/** Where the one-line installers and `agentic-daemon harness` read releases from; `AGENTIC_RELEASES` overrides it. */
export const DEFAULT_RELEASES = 'https://github.com/andtii/agentic/releases';

/**
 * The release manifest a harness comes from — the installers' channel logic: `version` pins `daemon-v<semver>`, else the
 * channel's rolling release (`daemon-latest`, `daemon-stable`).
 */
export function releaseManifestUrl(options: { readonly releases?: string; readonly channel?: string; readonly version?: string }): string {
    const releases = (options.releases ?? DEFAULT_RELEASES).replace(/\/+$/, '');
    if (options.version) return `${releases}/download/daemon-v${options.version.replace(/^daemon-v/, '')}/manifest.json`;
    const channel = options.channel ?? 'latest';
    if (channel !== 'latest' && channel !== 'stable') throw new HarnessError('invalid', `unknown channel ${channel} (latest or stable)`);
    return `${releases}/download/daemon-${channel}/manifest.json`;
}

export async function fetchReleaseManifest(url: string, fetchImpl: typeof fetch = fetch): Promise<ReleaseManifest> {
    let response: Response;
    try {
        response = await fetchImpl(url, { redirect: 'follow' });
    } catch (e) {
        throw new HarnessError('download-failed', `GET ${url} failed: ${(e as Error).message}`);
    }
    if (!response.ok) throw new HarnessError('download-failed', `no release manifest at ${url} (${response.status})`);
    const manifest = (await response.json().catch(() => undefined)) as ReleaseManifest | undefined;
    if (!isRecord(manifest) || !isRecord(manifest.assets)) throw new HarnessError('download-failed', `${url} is not a release manifest`);
    return { ...manifest, harnesses: isRecord(manifest.harnesses) ? manifest.harnesses : {} };
}

/** The harness build a release ships for `runtime` on this platform. */
export function harnessAsset(manifest: ReleaseManifest, runtime: string, platform = `${process.platform}-${process.arch}`): ReleaseAsset | undefined {
    return manifest.harnesses[runtime]?.assets[platform];
}
