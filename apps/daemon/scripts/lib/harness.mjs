/**
 * The harness packages (#369): each harness runtime's native build ships apart from the daemon zip, as
 * `harness-<runtime>-<version>-<os>-<arch>.zip` — the runtime's native npm package for that platform laid out as
 * `node_modules/<package>/…` plus a `manifest.json` (`HarnessPackageManifest`). The daemon keeps the SDK's
 * JavaScript and runs the native executable from `<install root>/harnesses/<runtime>/<version>/`
 * (`apps/daemon/src/harness.ts`, which holds the same table for the daemon — `package.test.ts` keeps the two equal).
 *
 * How each SDK is pointed at its executable (the spike, docs/architecture.md §5b):
 * - Claude Code: the Agent SDK's `pathToClaudeCodeExecutable` → `claude(.exe)` at the package root.
 * - Copilot CLI: the Copilot SDK's `RuntimeConnection.forStdio({ path })` (also `COPILOT_CLI_PATH`) →
 *   `prebuilds/<os>-<arch>/copilot-runtime(.exe)`, which loads `runtime.node` beside it.
 * - Codex: the driver's `codexPath` → `vendor/<target triple>/bin/codex(.exe)` (what `@openai/codex`'s launcher runs).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Rust target triples of the Codex builds, by release asset key. */
export const CODEX_TRIPLES = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc'
};

/** @param {string} key */
const exe = (key) => (key.startsWith('win32-') ? '.exe' : '');

/**
 * Per runtime: the SDK package whose version the harness takes (it pins its native package to the same version),
 * the native package for a release asset key, and the executable inside that package.
 * @type {Readonly<Record<string, { sdk: string; native: (key: string) => string; binary: (key: string) => string }>>}
 */
export const HARNESSES = {
    'claude-code': { sdk: '@anthropic-ai/claude-agent-sdk', native: (key) => `@anthropic-ai/claude-agent-sdk-${key}`, binary: (key) => `claude${exe(key)}` },
    'copilot-cli': { sdk: '@github/copilot-sdk', native: (key) => `@github/copilot-sdk-${key}`, binary: (key) => `prebuilds/${key}/copilot-runtime${exe(key)}` },
    'codex-cli': {
        sdk: '@openai/codex',
        native: (key) => `@openai/codex-${key}`,
        binary: (key) => {
            const triple = /** @type {Record<string, string>} */ (CODEX_TRIPLES)[key];
            if (!triple) throw new Error(`harness: Codex has no build for ${key}`);
            return `vendor/${triple}/bin/codex${exe(key)}`;
        }
    }
};

/** The native packages the daemon zip leaves out, every platform's: they travel as harness packages. */
const NATIVE = /^(@anthropic-ai\/claude-agent-sdk-|@github\/copilot-sdk-|@openai\/codex-)/;

/** @param {string} name a dependency name as the dependent lists it (an npm alias included) */
export const isNativeHarnessPackage = (name) => NATIVE.test(name);

/**
 * The digest of a harness tree (`manifest.json`'s `sha256`): SHA-256 over `<relative posix path>\0<file sha256 hex>\n`
 * per file, in code-unit order of the paths. The daemon computes the same over what it unpacked.
 * @param {Iterable<[string, string]>} files `[relative posix path, absolute path]`
 */
export function treeHash(files) {
    const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tree = createHash('sha256');
    for (const [rel, abs] of sorted) tree.update(`${rel}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`);
    return tree.digest('hex');
}

/**
 * `harness-<runtime>-<version>-<os>-<arch>.zip`, the release asset name (#441): named by the upstream version, so a
 * release run finds the zip it would build already uploaded and skips it. Groups: runtime, version, asset key.
 */
export const HARNESS_ZIP = /^harness-([a-z][a-z0-9-]*?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-((?:win32|darwin|linux)-(?:x64|arm64))\.zip$/;

/**
 * The release asset name of a harness build.
 * @param {string} runtime @param {string} version @param {string} key `<os>-<arch>`
 */
export const harnessZipName = (runtime, version, key) => `harness-${runtime}-${version}-${key}.zip`;
