/**
 * The daemon's build stamp: which version, commit and channel a build is.
 * `vite.config.ts` bakes it into `src/version.ts` (`__DAEMON_VERSION__` …)
 * and writes it to `dist/build.json`; `scripts/package.mjs` names the zip
 * from `dist/build.json`; `scripts/lib/manifest.mjs` writes it into the
 * release manifest. One function, so the three never disagree.
 *
 * - A release tag `daemon-v<semver>` (`AGENTIC_DAEMON_TAG`, or the pushed
 *   tag `GITHUB_REF_NAME` on a tag run): version `<semver>`, channel `stable`.
 * - Anything else: `<package.json version>-main.<commit time>.<sha7>`, channel
 *   `latest`. The commit time (unix seconds, `git log -1 --format=%ct`) is a
 *   numeric prerelease identifier, so semver orders main builds by when their
 *   commit was made, and all of them below the `x.y.z` release (#437). A sha7
 *   of digits only with a leading zero is not a valid semver identifier; it
 *   gets a `g` in front (`g0123456`), as `git describe` writes it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A release tag: `daemon-v` + semver (a pre-release suffix allowed: `daemon-v0.1.0-rc.1`). */
export const RELEASE_TAG = /^daemon-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * @param {{ tag?: string | undefined; packageVersion: string; commit: string; committedAt?: number | undefined }} input
 * @returns {{ version: string; commit: string; channel: 'stable' | 'latest'; tag: string | null }}
 */
export function buildStamp({ tag, packageVersion, commit, committedAt }) {
    const short = commit.slice(0, 7);
    if (tag) {
        const m = RELEASE_TAG.exec(tag);
        if (!m) throw new Error(`stamp: ${tag} is not a release tag (daemon-v<semver>)`);
        return { version: /** @type {string} */ (m[1]), commit: short, channel: 'stable', tag };
    }
    const time = Number.isSafeInteger(committedAt) && /** @type {number} */ (committedAt) > 0 ? committedAt : 0;
    const id = /^0\d*$/.test(short) && short.length > 1 ? `g${short}` : short;
    return { version: `${packageVersion}-main.${time}.${id}`, commit: short, channel: 'latest', tag: null };
}

/**
 * The release tag this build is for, from the environment: `AGENTIC_DAEMON_TAG`
 * (the workflow sets it on a tag push and on a `workflow_dispatch` with a `tag`),
 * else a pushed `daemon-v*` tag (`GITHUB_REF_TYPE=tag`). Empty → not a release.
 * @param {Record<string, string | undefined>} env
 */
export function releaseTagFrom(env) {
    if (env.AGENTIC_DAEMON_TAG) return env.AGENTIC_DAEMON_TAG;
    if (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME && env.GITHUB_REF_NAME.startsWith('daemon-v')) return env.GITHUB_REF_NAME;
    return undefined;
}

/**
 * The commit being built: `GITHUB_SHA` in CI, else `git rev-parse HEAD`, else `unknown`.
 * @param {string} cwd @param {Record<string, string | undefined>} env
 */
export function currentCommit(cwd, env) {
    if (env.GITHUB_SHA) return env.GITHUB_SHA;
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * When `commit` was made, unix seconds (`git log -1 --format=%ct`); 0 when git cannot say (no git, a shallow
 * checkout without it, `unknown`).
 * @param {string} cwd @param {string} commit
 */
export function commitTime(cwd, commit) {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return 0;
    try {
        const out = execFileSync('git', ['log', '-1', '--format=%ct', commit], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return /^\d+$/.test(out) ? Number(out) : 0;
    } catch {
        return 0;
    }
}

/**
 * The stamp for a build of `daemonDir` (apps/daemon) in this environment.
 * @param {string} daemonDir @param {Record<string, string | undefined>} [env]
 */
export function stampFor(daemonDir, env = process.env) {
    const packageVersion = JSON.parse(readFileSync(join(daemonDir, 'package.json'), 'utf8')).version;
    const commit = currentCommit(daemonDir, env);
    return buildStamp({ tag: releaseTagFrom(env), packageVersion, commit, committedAt: commitTime(daemonDir, commit) });
}

/**
 * `DAEMON_PROTOCOL_VERSION` as `packages/core/src/daemon.ts` declares it — read from
 * the source so the release job needs no build.
 * @param {string} repoRoot
 */
export function protocolVersion(repoRoot) {
    const source = readFileSync(join(repoRoot, 'packages/core/src/daemon.ts'), 'utf8');
    const m = /export const DAEMON_PROTOCOL_VERSION = (\d+)/.exec(source);
    if (!m) throw new Error('stamp: DAEMON_PROTOCOL_VERSION not found in packages/core/src/daemon.ts');
    return Number(m[1]);
}
