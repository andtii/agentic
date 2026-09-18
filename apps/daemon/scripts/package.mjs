#!/usr/bin/env node
/**
 * `pnpm --filter @agentic/daemon package` — the daemon installer zip.
 *
 * Produces `apps/daemon/release/agentic-daemon-<version>-<os>-<arch>.zip`
 * holding the built daemon (`bin/`, `dist/`), its production dependency
 * closure copied into a plain `node_modules/` (the `@agentic/*` workspace
 * packages as their built `dist/`, the Claude Code SDK with the native CLI
 * for THIS platform), `install.ps1` / `uninstall.ps1` (Windows scheduled
 * task), the `scripts/` they call and a README. Node ≥ 22.12 on the target
 * machine is the only prerequisite; nothing is fetched at install time.
 *
 * Run `pnpm build` at the repo root first — the zip is assembled from `dist/`
 * directories and refuses to run without them.
 *
 * Usage: node scripts/package.mjs [--out <dir>]
 * See `docs/runbook.md` → "Daemon on a Windows machine".
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './lib/zip.mjs';

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files of the daemon package itself that ship, relative to `apps/daemon`. */
const DAEMON_FILES = ['bin', 'dist', 'CHANGELOG.md'];
/** The zip root: what a user sees first. `scripts/package/README.md` becomes the root `README.md`. */
const ROOT_FILES = { 'install.ps1': 'scripts/package/install.ps1', 'uninstall.ps1': 'scripts/package/uninstall.ps1', 'README.md': 'scripts/package/README.md' };
const SCRIPT_FILES = ['scripts/install-service.ps1', 'scripts/uninstall-service.ps1'];
/** In a workspace package only the built output ships; everything else stays in the repo. */
const WORKSPACE_PACKAGE_FILES = ['package.json', 'dist', 'README.md', 'CHANGELOG.md', 'LICENSE'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
/** Type declarations and source maps are no use at runtime and are most of the file count. */
const SKIP_FILE = /\.(d\.[cm]?ts|map)$/;

/** @param {string} dir */
const readPackage = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
/** @param {string} dir */
const isWorkspacePackage = (dir) => !dir.split(sep).includes('node_modules');

/**
 * Node's resolution of a bare package name from `fromDir`: the nearest
 * `node_modules/<name>` walking up, followed to its real directory (pnpm
 * links every dependency into a virtual store).
 * @param {string} fromDir @param {string} name
 */
function findPackage(fromDir, name) {
    let dir = fromDir;
    for (;;) {
        const candidate = join(dir, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/**
 * Every file under `dir` (recursively, `SKIP_DIRS` pruned) as
 * `[relative posix path, absolute path]`, sorted for a stable archive.
 * @param {string} dir @param {readonly string[]} [only] top-level names to include (default: all)
 */
function listFiles(dir, only) {
    /** @type {[string, string][]} */
    const files = [];
    const walk = (/** @type {string} */ abs, /** @type {string} */ rel) => {
        const stat = statSync(abs);
        if (stat.isDirectory()) {
            for (const name of readdirSync(abs).sort()) {
                if (SKIP_DIRS.has(name)) continue;
                walk(join(abs, name), rel ? `${rel}/${name}` : name);
            }
        } else if (stat.isFile() && !SKIP_FILE.test(abs)) files.push([rel, abs]);
    };
    for (const name of only ?? readdirSync(dir).sort()) {
        const abs = join(dir, name);
        if (SKIP_DIRS.has(name) || !existsSync(abs)) continue;
        walk(abs, name);
    }
    return files;
}

/**
 * Lay the production dependency closure out as a plain `node_modules` tree:
 * every package at the top level unless the top level already holds another
 * instance of that name, in which case it nests under the package that needs
 * it — exactly what Node's resolver will find at runtime.
 *
 * @param {string} rootDir the package whose `dependencies` seed the closure (apps/daemon)
 * @returns {Map<string, { real: string; name: string; version: string; workspace: boolean }>} target path (posix, relative to the zip root) → source
 */
export function resolveClosure(rootDir) {
    /** @type {Map<string, { real: string; name: string; version: string; workspace: boolean }>} */
    const placed = new Map();
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {string[]} */
    const problems = [];

    // Breadth-first from the root, so the root's own dependencies claim the top level before any
    // transitive dependency of the same name can, and a nested placement always sits under the
    // package that needs it (a dependent's own path is never the empty root).
    /** @type {{ target: string; real: string; isRoot: boolean }[]} */
    const queue = [{ target: '', real: realpathSync(rootDir), isRoot: true }];
    for (let i = 0; i < queue.length; i++) {
        const { target, real, isRoot } = queue[i];
        const key = `${target}\0${real}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const pkg = readPackage(real);
        const wanted = isRoot
            ? { hard: Object.keys(pkg.dependencies ?? {}), soft: [] }
            : { hard: Object.keys(pkg.dependencies ?? {}), soft: [...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})] };
        for (const [name, hard] of [...wanted.hard.map((n) => [n, true]), ...wanted.soft.map((n) => [n, false])]) {
            const depReal = findPackage(real, /** @type {string} */ (name));
            if (!depReal) {
                if (hard) problems.push(`${pkg.name}@${pkg.version} depends on ${name}, which is not installed`);
                continue;
            }
            const depPkg = readPackage(depReal);
            const top = `node_modules/${name}`;
            const at = placed.get(top);
            const depTarget = !at || at.real === depReal ? top : `${target}/node_modules/${name}`;
            const existing = placed.get(depTarget);
            if (existing && existing.real !== depReal) problems.push(`${depTarget} would hold both ${existing.real} and ${depReal}`);
            if (!existing) placed.set(depTarget, { real: depReal, name: depPkg.name, version: depPkg.version, workspace: isWorkspacePackage(depReal) });
            queue.push({ target: depTarget, real: depReal, isRoot: false });
        }
    }
    if (problems.length) throw new Error(`package: the dependency closure is incomplete — run \`pnpm install\` and \`pnpm build\` first:\n  ${problems.join('\n  ')}`);
    return placed;
}

/**
 * Assemble the zip.
 * @param {{ outDir?: string; log?: (line: string) => void }} [options]
 * @returns {{ zipFile: string; version: string; entries: number; bytes: number; packages: number }}
 */
export function packageDaemon(options = {}) {
    const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    const pkg = readPackage(DAEMON_DIR);
    const version = pkg.version;
    if (!existsSync(join(DAEMON_DIR, 'dist', 'cli.js'))) throw new Error('package: apps/daemon/dist is missing — run `pnpm build` at the repo root first');

    const closure = resolveClosure(DAEMON_DIR);
    for (const [target, source] of closure) {
        if (source.workspace && !existsSync(join(source.real, 'dist'))) throw new Error(`package: ${source.name} has no dist (${target}) — run \`pnpm build\` at the repo root first`);
    }

    /** @type {[string, string][]} name in the zip → absolute source */
    const files = [];
    for (const [rel, abs] of listFiles(DAEMON_DIR, DAEMON_FILES)) files.push([rel, abs]);
    for (const [name, source] of Object.entries(ROOT_FILES)) files.push([name, join(DAEMON_DIR, source)]);
    for (const rel of SCRIPT_FILES) files.push([rel, join(DAEMON_DIR, rel)]);
    for (const [target, source] of closure) {
        const only = source.workspace ? WORKSPACE_PACKAGE_FILES : undefined;
        for (const [rel, abs] of listFiles(source.real, only)) files.push([`${target}/${rel}`, abs]);
    }
    for (const [name, abs] of files) if (!existsSync(abs)) throw new Error(`package: ${name} is missing at ${abs}`);

    // package.json: the runtime shape only — no scripts, no dev dependencies, no workspace ranges.
    const shipped = {
        name: pkg.name,
        version,
        private: true,
        description: pkg.description,
        type: pkg.type,
        bin: pkg.bin,
        engines: pkg.engines,
        dependencies: Object.fromEntries(
            Object.entries(pkg.dependencies ?? {}).map(([name, range]) => {
                const at = closure.get(`node_modules/${name}`);
                return [name, at ? at.version : range];
            })
        )
    };

    const outDir = resolve(options.outDir ?? join(DAEMON_DIR, 'release'));
    const zipFile = join(outDir, `agentic-daemon-${version}-${process.platform}-${process.arch}.zip`);
    const entries = function* () {
        yield { name: 'package.json', data: Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`, 'utf8') };
        for (const [name, abs] of files) {
            const mode = name.startsWith('bin/') ? 0o755 : (statSync(abs).mode & 0o111) ? 0o755 : 0o644;
            yield { name, data: readFileSync(abs), mode };
        }
    };
    const result = writeZip(zipFile, entries());
    log(`package: ${relative(process.cwd(), zipFile) || zipFile} — ${result.entries} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB, ${closure.size} packages`);
    return { zipFile, version, entries: result.entries, bytes: result.bytes, packages: closure.size };
}

/** @param {readonly string[]} argv */
function main(argv) {
    let outDir;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
        else if (argv[i] === '--help' || argv[i] === '-h') {
            process.stdout.write('Usage: node scripts/package.mjs [--out <dir>]\n');
            return 0;
        } else {
            process.stderr.write(`package: unknown argument ${argv[i]}\n`);
            return 2;
        }
    }
    try {
        packageDaemon(outDir ? { outDir } : {});
        return 0;
    } catch (e) {
        process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
