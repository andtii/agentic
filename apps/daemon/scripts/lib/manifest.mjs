#!/usr/bin/env node
/**
 * The release manifest (`manifest.json`, the `ReleaseManifest` shape): one per
 * GitHub release, uploaded beside the zips by `.github/workflows/daemon-release.yml`.
 * The one-line installers read it to find this machine's zip and its sha256.
 *
 * Each `agentic-daemon-<os>-<arch>.zip` in the release folder needs the
 * `<zip>.sha256` sidecar `package.mjs --sha256` wrote beside it, so nothing is
 * re-hashed here; a missing or malformed sidecar is an error.
 *
 * Usage: node scripts/lib/manifest.mjs --dir <release folder> --tag <release tag> --repo <owner/name> [--out <file>]
 *   (version, commit and channel from the build stamp of this checkout: scripts/lib/stamp.mjs)
 */

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * @param {{
 *   dir: string; tag: string; repo: string;
 *   stamp: { version: string; commit: string; channel: 'stable' | 'latest' };
 *   protocol: number; publishedAt?: string;
 * }} input
 */
export function buildManifest({ dir, tag, repo, stamp, protocol, publishedAt }) {
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
    return {
        version: stamp.version,
        channel: stamp.channel,
        publishedAt: publishedAt ?? new Date().toISOString(),
        commit: stamp.commit,
        protocol,
        notesUrl: `https://github.com/${repo}/releases/tag/${tag}`,
        assets,
        harnesses: {}
    };
}

/** @param {readonly string[]} argv */
function main(argv) {
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
    if (!flags.dir || !flags.tag || !flags.repo) {
        process.stderr.write('Usage: node scripts/lib/manifest.mjs --dir <release folder> --tag <release tag> --repo <owner/name> [--out <file>]\n');
        return 2;
    }
    try {
        const daemonDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
        const manifest = buildManifest({ dir: flags.dir, tag: flags.tag, repo: flags.repo, stamp: stampFor(daemonDir), protocol: protocolVersion(resolve(daemonDir, '../..')) });
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
