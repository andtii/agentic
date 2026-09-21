#!/usr/bin/env node
/**
 * The release manifest (`manifest.json`, the `ReleaseManifest` shape): one per
 * GitHub release, uploaded beside the zips by `.github/workflows/daemon-release.yml`.
 * The one-line installers read it to find this machine's zip and its sha256.
 * The shape is `ReleaseManifest` (`packages/core/src/release.ts`; `package.test.ts` holds the two together).
 *
 * Each `agentic-daemon-<os>-<arch>.zip` in the release folder needs the
 * `<zip>.sha256` sidecar `package.mjs --sha256` wrote beside it, so nothing is
 * re-hashed here; a missing or malformed sidecar is an error.
 *
 * Each `harness-<runtime>-<version>-<os>-<arch>.zip` (#369, `package.mjs --harness`) goes under
 * `harnesses[runtime]`: its `.sha256` sidecar, and the version from its `<zip>.json`
 * sidecar (the zip's own `manifest.json`), which is never uploaded. One runtime has
 * one version across the platforms of a release.
 *
 * Upload once (#441): a harness only changes when its pinned version does, so a main
 * run packages only the harnesses whose zip for that version is not on `daemon-latest`
 * yet (`plan`). The manifest then takes the others from the release's previous
 * manifest — the entry for the same version, whose zip is still on the release — and
 * after it is uploaded, `stale` names the harness assets no manifest points at any more.
 * A tag release packages every harness and uploads its own copies.
 *
 * Usage:
 *   node scripts/lib/manifest.mjs --dir <release folder> --tag <release tag> --repo <owner/name> [--out <file>]
 *        [--harness-versions <file> --previous <manifest.json> --existing <asset names .json>]
 *     (version, commit and channel from the build stamp of this checkout: scripts/lib/stamp.mjs)
 *   node scripts/lib/manifest.mjs plan --versions <file> --existing <file> [--platform <os>-<arch>]
 *     prints the runtimes to package, space-separated (none: an empty line)
 *   node scripts/lib/manifest.mjs stale --existing <file> --manifest <manifest.json>
 *     prints the harness assets on the release the manifest does not use, one per line
 * `--harness-versions` is `package.mjs --harness-versions` (runtime → version); `--existing`
 * a JSON array of the release's asset names (`gh release view --json assets --jq '[.assets[].name]'`).
 */

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ZIP, harnessZipName } from './harness.mjs';
import { protocolVersion, stampFor } from './stamp.mjs';

const ZIP = /^agentic-daemon-(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-)?((?:win32|darwin|linux)-(?:x64|arm64))\.zip$/;

/**
 * Read a `<zip>.sha256` sidecar (`<hex>  <name>`, or the bare hex).
 * @param {string} file
 */
export function readSidecar(file) {
    const hex = readFileSync(file, 'utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`manifest: ${file} holds no sha256`);
    return hex;
}

/** @typedef {{ url: string; sha256: string; bytes: number; version: string }} Asset */
/** @typedef {{ harnesses?: Record<string, { version?: unknown; assets?: Record<string, Asset> }> }} PreviousManifest */

/**
 * The runtimes to package on `platform` (#441): those whose zip (or its `.sha256`) for the version they would be
 * packaged at is not among the release's `existing` assets.
 * @param {{ versions: Record<string, string>; existing: readonly string[]; platform: string }} input
 * @returns {string[]}
 */
export function planHarnesses({ versions, existing, platform }) {
    const have = new Set(existing);
    return Object.entries(versions)
        .filter(([runtime, version]) => {
            const name = harnessZipName(runtime, version, platform);
            return !have.has(name) || !have.has(`${name}.sha256`);
        })
        .map(([runtime]) => runtime);
}

/**
 * The harness assets on a release that `manifest` does not point at — older versions, and the unversioned names
 * from before #441 — with their `.sha256`: what a main run deletes once the new manifest is up.
 * @param {{ existing: readonly string[]; manifest: { harnesses?: Record<string, { assets?: Record<string, { url: string }> }> } }} input
 * @returns {string[]}
 */
export function staleHarnessAssets({ existing, manifest }) {
    const used = new Set();
    for (const entry of Object.values(manifest.harnesses ?? {})) {
        for (const asset of Object.values(entry.assets ?? {})) {
            const name = asset.url.slice(asset.url.lastIndexOf('/') + 1);
            used.add(name);
            used.add(`${name}.sha256`);
        }
    }
    return existing.filter((name) => /^harness-.*\.zip(\.sha256)?$/.test(name) && !used.has(name));
}

/**
 * @param {{
 *   dir: string; tag: string; repo: string;
 *   stamp: { version: string; commit: string; channel: 'stable' | 'latest' };
 *   protocol: number; publishedAt?: number;
 *   harnessVersions?: Record<string, string>; previous?: PreviousManifest; existing?: readonly string[];
 * }} input
 *   With `harnessVersions`, every runtime is listed for every platform of the daemon zips at that version: from the
 *   folder when it was packaged this run, else carried over from `previous` when that names the same version and the
 *   zip is among the release's `existing` assets; anything else is an error.
 */
export function buildManifest({ dir, tag, repo, stamp, protocol, publishedAt, harnessVersions, previous, existing }) {
    const download = `https://github.com/${repo}/releases/download/${tag}`;
    /** @type {Record<string, { url: string; sha256: string; bytes: number; version: string }>} */
    const assets = {};
    for (const name of readdirSync(dir).sort()) {
        const m = ZIP.exec(name);
        if (!m) continue;
        const key = /** @type {string} */ (m[1]);
        if (assets[key]) throw new Error(`manifest: two zips for ${key} in ${dir}`);
        assets[key] = { url: `${download}/${name}`, sha256: readSidecar(join(dir, `${name}.sha256`)), bytes: statSync(join(dir, name)).size, version: stamp.version };
    }
    if (!Object.keys(assets).length) throw new Error(`manifest: no agentic-daemon-<os>-<arch>.zip in ${dir}`);
    /** @type {Record<string, { version: string; assets: Record<string, { url: string; sha256: string; bytes: number; version: string }> }>} */
    const harnesses = {};
    for (const name of readdirSync(dir).sort()) {
        const m = HARNESS_ZIP.exec(name);
        if (!m) continue;
        const runtime = /** @type {string} */ (m[1]);
        const key = /** @type {string} */ (m[3]);
        const described = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
        if (described.runtime !== runtime || described.platform !== key || described.version !== m[2]) throw new Error(`manifest: ${name}.json does not describe ${runtime} ${m[2]} for ${key}`);
        const entry = (harnesses[runtime] ??= { version: described.version, assets: {} });
        if (entry.version !== described.version) throw new Error(`manifest: ${runtime} is ${entry.version} on one platform and ${described.version} on ${key}`);
        entry.assets[key] = { url: `${download}/${name}`, sha256: readSidecar(join(dir, `${name}.sha256`)), bytes: statSync(join(dir, name)).size, version: described.version };
    }
    if (harnessVersions) {
        const have = new Set(existing ?? []);
        for (const [runtime, version] of Object.entries(harnessVersions)) {
            const built = harnesses[runtime];
            if (built && built.version !== version) throw new Error(`manifest: ${runtime} was packaged at ${built.version}, but this build pins ${version}`);
            const entry = (harnesses[runtime] ??= { version, assets: {} });
            const before = previous?.harnesses?.[runtime];
            for (const key of Object.keys(assets)) {
                if (entry.assets[key]) continue;
                const name = harnessZipName(runtime, version, key);
                const carried = before?.version === version ? before.assets?.[key] : undefined;
                if (!carried || carried.url !== `${download}/${name}` || carried.version !== version || !have.has(name)) {
                    throw new Error(`manifest: ${name} was neither packaged in this run nor is it on ${tag} with a previous manifest entry`);
                }
                entry.assets[key] = { url: carried.url, sha256: carried.sha256, bytes: carried.bytes, version };
            }
            entry.assets = Object.fromEntries(Object.entries(entry.assets).sort(([a], [b]) => (a < b ? -1 : 1)));
        }
    }
    return {
        version: stamp.version,
        channel: stamp.channel,
        publishedAt: publishedAt ?? Date.now(),
        commit: stamp.commit,
        protocol,
        notesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
        assets,
        harnesses
    };
}

/**
 * A JSON file, or `fallback` when it is missing, empty or not JSON (no previous manifest on a new release).
 * @param {string | undefined} file @param {unknown} fallback
 */
function readJson(file, fallback) {
    if (!file) return fallback;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/** @param {readonly string[]} argv */
function main(argv) {
    const command = argv[0] === 'plan' || argv[0] === 'stale' ? argv[0] : undefined;
    if (command) argv = argv.slice(1);
    /** @type {Record<string, string>} */
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i]?.startsWith('--') ? argv[i]?.slice(2) : undefined;
        if (!name || argv[i + 1] === undefined) {
            process.stderr.write(`manifest: unexpected argument ${argv[i]}\n`);
            return 2;
        }
        flags[name] = /** @type {string} */ (argv[++i]);
    }
    const existing = /** @type {string[]} */ (readJson(flags.existing, []));
    if (!Array.isArray(existing) || !existing.every((n) => typeof n === 'string')) {
        process.stderr.write(`manifest: ${flags.existing} is not a JSON array of asset names\n`);
        return 1;
    }
    if (command === 'plan') {
        const versions = readJson(flags.versions, undefined);
        if (!versions || typeof versions !== 'object') {
            process.stderr.write('Usage: node scripts/lib/manifest.mjs plan --versions <file> --existing <file> [--platform <os>-<arch>]\n');
            return 2;
        }
        process.stdout.write(`${planHarnesses({ versions, existing, platform: flags.platform ?? `${process.platform}-${process.arch}` }).join(' ')}\n`);
        return 0;
    }
    if (command === 'stale') {
        const manifest = readJson(flags.manifest, undefined);
        if (!manifest || typeof manifest !== 'object') {
            process.stderr.write('Usage: node scripts/lib/manifest.mjs stale --existing <file> --manifest <manifest.json>\n');
            return 2;
        }
        for (const name of staleHarnessAssets({ existing, manifest })) process.stdout.write(`${name}\n`);
        return 0;
    }
    if (!flags.dir || !flags.tag || !flags.repo) {
        process.stderr.write('Usage: node scripts/lib/manifest.mjs --dir <release folder> --tag <release tag> --repo <owner/name> [--out <file>]\n');
        return 2;
    }
    try {
        const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
        const harnessVersions = flags['harness-versions'] ? readJson(flags['harness-versions'], undefined) : undefined;
        if (flags['harness-versions'] && (!harnessVersions || typeof harnessVersions !== 'object')) throw new Error(`manifest: ${flags['harness-versions']} is not runtime → version JSON`);
        const manifest = buildManifest({
            dir: flags.dir,
            tag: flags.tag,
            repo: flags.repo,
            stamp: stampFor(daemonDir),
            protocol: protocolVersion(resolve(daemonDir, '../..')),
            ...(harnessVersions ? { harnessVersions, previous: readJson(flags.previous, {}), existing } : {})
        });
        const json = `${JSON.stringify(manifest, null, 2)}\n`;
        if (flags.out) writeFileSync(flags.out, json);
        else process.stdout.write(json);
        return 0;
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
