#!/usr/bin/env node
// The agentic node the desktop app carries (#991): a Node single-executable `agentic-node` (Tauri's
// `externalBin`) plus the node's files (a Tauri resource), which src-tauri/src/node.rs starts.
//
//   pnpm --filter @agentic/node bundle              # apps/node/dist, apps/web/dist/client, apps/daemon/dist
//   node apps/desktop/scripts/sidecar.mjs [--target <rust triple>]
//   pnpm tauri build --config src-tauri/node.conf.json   (a release: release-config.mjs --node)
//
// Writes, under apps/desktop/src-tauri (both git-ignored):
//
//   binaries/agentic-node-<triple>[.exe]   the Node binary this script runs on, of the target's platform
//                                          (downloaded from nodejs.org at the same version when it is
//                                          another), with sidecar/sea-main.cjs injected as its SEA blob;
//                                          `universal-apple-darwin` is both macOS builds, lipo'd
//   node/                                  sidecar/launch.cjs and the node's files as the repo lays them
//                                          out, so the relative paths the build uses still resolve:
//                                          apps/node/dist (+ ws), apps/web/dist/client, apps/daemon/dist
//                                          with its production dependency closure (never the runtimes'
//                                          native harness packages, which the daemon installs itself, #369)

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(DESKTOP, '..', '..');
const TAURI = join(DESKTOP, 'src-tauri');

export const SIDECAR = 'agentic-node';
/** Node's SEA fuse (docs: single-executable-applications). */
export const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';

/** The node's files the app needs, relative to the repo; checked before anything is written. */
export const BUILT = ['apps/node/dist/main.js', 'apps/web/dist/client', 'apps/daemon/dist/cli.js'];

/** Tauri's `externalBin` name for a target: `agentic-node-<triple>`, `.exe` on Windows. */
export function sidecarFile(triple) {
    return `${SIDECAR}-${triple}${triple.includes('-windows-') ? '.exe' : ''}`;
}

/** nodejs.org's `<os>-<arch>` builds a Rust target triple runs; two for the universal macOS build. */
export function nodePlatforms(triple) {
    if (triple === 'universal-apple-darwin') return ['darwin-arm64', 'darwin-x64'];
    const arch = triple.startsWith('x86_64-') ? 'x64' : triple.startsWith('aarch64-') ? 'arm64' : null;
    const os = triple.includes('-windows-') ? 'win' : triple.includes('-apple-darwin') ? 'darwin' : triple.includes('-linux-') ? 'linux' : null;
    if (!arch || !os) throw new Error(`sidecar: no Node build for ${triple}`);
    return [`${os}-${arch}`];
}

/** This machine's nodejs.org platform. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
    return `${platform === 'win32' ? 'win' : platform}-${arch}`;
}

/** Where nodejs.org keeps a platform's binary at `version` (`v22.13.0`), and the path inside the archive. */
export function nodeDownload(version, platform) {
    const base = `https://nodejs.org/dist/${version}`;
    if (platform.startsWith('win-')) return { url: `${base}/${platform}/node.exe`, archive: false, entry: 'node.exe' };
    const name = `node-${version}-${platform}`;
    return { url: `${base}/${name}.tar.gz`, archive: true, entry: `${name}/bin/node` };
}

/** The SEA config: no snapshot, no code cache, so one blob serves every platform of this Node version. */
export function seaConfig(main, output) {
    return { main, output, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false };
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' && !command.includes('\\'), ...options });
    if (result.status !== 0) throw new Error(`sidecar: ${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`);
    return result;
}

function hostTriple() {
    const out = spawnSync('rustc', ['-vV'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout ?? '';
    const host = /^host: (\S+)/m.exec(out)?.[1];
    if (!host) throw new Error('sidecar: no --target and `rustc -vV` names no host');
    return host;
}

async function nodeBinary(platform, work) {
    if (platform === hostPlatform()) return process.execPath;
    const { url, archive, entry } = nodeDownload(process.version, platform);
    const dir = join(work, platform);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, archive ? 'node.tar.gz' : 'node.exe');
    console.log(`sidecar: downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`sidecar: ${url}: HTTP ${response.status}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    if (!archive) return file;
    run('tar', ['-xzf', file, '-C', dir, entry], { shell: false });
    return join(dir, entry);
}

/** Copies `node` to `out` and injects the blob (macOS: re-signed ad hoc, which Apple Silicon requires). */
function inject(node, blob, out) {
    copyFileSync(node, out);
    chmodSync(out, 0o755);
    const mac = process.platform === 'darwin';
    if (mac) run('codesign', ['--remove-signature', out], { shell: false });
    run('npx', ['--yes', POSTJECT, out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE, ...(mac ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
    if (mac) run('codesign', ['--sign', '-', out], { shell: false });
}

const SKIP_FILE = /\.(d\.[cm]?ts|map)$/;
/** Copies a package's files: everything but its own `node_modules`, `.git`, type declarations and source maps. */
function copyPackage(from, to, only) {
    mkdirSync(to, { recursive: true });
    for (const name of only ?? readdirSync(from)) {
        const src = join(from, name);
        if (name === 'node_modules' || name === '.git' || !existsSync(src)) continue;
        cpSync(src, join(to, name), { recursive: true, dereference: true, filter: (path) => !(statSync(path).isFile() && SKIP_FILE.test(path)) });
    }
}

/** The node's files, laid out under `out` as in the repo. */
async function stage(out) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    copyFileSync(join(DESKTOP, 'sidecar', 'launch.cjs'), join(out, 'launch.cjs'));

    // The node: its bundle, and `ws`, the one package it loads at run time (apps/web/vite.config.ts `runtimeExternal`).
    const nodeOut = join(out, 'apps', 'node');
    copyPackage(join(REPO, 'apps', 'node'), nodeOut, ['dist']);
    writeFileSync(join(nodeOut, 'package.json'), `${JSON.stringify({ name: '@agentic/node', private: true, type: 'module' }, null, 2)}\n`);
    const ws = dirname(createRequire(join(REPO, 'apps', 'node', 'package.json')).resolve('ws/package.json'));
    copyPackage(ws, join(nodeOut, 'node_modules', 'ws'));

    copyPackage(join(REPO, 'apps', 'web', 'dist'), join(out, 'apps', 'web', 'dist'), ['client']);

    // The daemon the node runs in-process, with the closure its installer zip carries (apps/daemon/scripts/package.mjs).
    const daemon = join(REPO, 'apps', 'daemon');
    const { resolveClosure } = await import(new URL('../../daemon/scripts/package.mjs', import.meta.url).href);
    const daemonOut = join(out, 'apps', 'daemon');
    copyPackage(daemon, daemonOut, ['dist', 'package.json']);
    for (const [target, source] of resolveClosure(daemon)) {
        copyPackage(source.real, join(daemonOut, ...target.split('/')), source.workspace ? ['package.json', 'dist'] : undefined);
    }
}

async function main(argv) {
    let target;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--target' && argv[i + 1]) target = argv[++i];
        else throw new Error(`sidecar: unknown argument ${argv[i]}`);
    }
    target ??= hostTriple();
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) throw new Error(`sidecar: Node ${process.version} — the node needs >= 22.13 (node:sqlite)`);
    const missing = BUILT.filter((path) => !existsSync(join(REPO, path)));
    if (missing.length) throw new Error(`sidecar: ${missing.join(', ')} missing — run \`pnpm --filter @agentic/node bundle\` first`);

    await stage(join(TAURI, 'node'));
    console.log(`sidecar: staged ${join(TAURI, 'node')}`);

    const work = join(tmpdir(), `agentic-sidecar-${process.pid}`);
    mkdirSync(work, { recursive: true });
    try {
        const blob = join(work, 'sea.blob');
        const config = join(work, 'sea-config.json');
        writeFileSync(config, JSON.stringify(seaConfig(join(DESKTOP, 'sidecar', 'sea-main.cjs'), blob)));
        run(process.execPath, ['--experimental-sea-config', config], { shell: false });

        const binaries = join(TAURI, 'binaries');
        mkdirSync(binaries, { recursive: true });
        const out = join(binaries, sidecarFile(target));
        const platforms = nodePlatforms(target);
        const thin = [];
        for (const platform of platforms) {
            const file = platforms.length === 1 ? out : join(work, `${SIDECAR}-${platform}`);
            inject(await nodeBinary(platform, work), blob, file);
            thin.push(file);
        }
        if (thin.length > 1) run('lipo', ['-create', ...thin, '-output', out], { shell: false });
        console.log(`sidecar: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1]?.endsWith('sidecar.mjs')) {
    main(process.argv.slice(2)).catch((e) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    });
}
