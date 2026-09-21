/**
 * `agentic-daemon update [--channel stable|latest] [--version daemon-v…] [--check] [--now]` (#364).
 *
 * Reads the release manifest the way the one-line installers do (`apps/web/public/install.*`: `AGENTIC_RELEASES`,
 * `daemon-<channel>` or `daemon-v<semver>`), prints what is installed and what is available, and — unless `--check` —
 * downloads, verifies and stages this machine's build with the update client's own functions (`./update.ts`). It
 * then leaves `state/update-request.json` for the running daemon, which drains (no new turns, up to 10 minutes;
 * `--now` skips it) and exits 75 so the supervisor swaps the staged build in. The command waits until the new
 * version is up (`state/ready`) or the supervisor rolled it back. It needs the supervisor: without
 * `state/supervisor.json` it says how to reinstall.
 */

import { compareVersions, platformKey } from '@agentic/daemon-protocol';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { ParsedArgs } from './cli.js';
import type { InstallPaths } from './paths.js';
import { CLI_DRAIN_TIMEOUT_MS, downloadAsset, downloadFile, fetchableAsset, stageZip, unstage, updateLayout, UpdateError, verifyDownload, type LocalUpdateRequest, type StagedCheck } from './update.js';
import { DAEMON_CHANNEL, DAEMON_VERSION, versionLine } from './version.js';

export const UPDATE_USAGE = `  agentic-daemon update [--channel stable|latest] [--version daemon-v<semver>] [--check] [--now]
                       (installed vs. available; without --check downloads, verifies and stages the release, then the
                        running daemon restarts onto it once no turn is running (up to 10 minutes; --now: at once))`;

/** Where the manifests are published; `AGENTIC_RELEASES` overrides it, as it does for the installers. */
export const DEFAULT_RELEASES = 'https://github.com/andtii/agentic/releases';

const REINSTALL = `this daemon does not run under the supervisor, which applies updates — reinstall it with the one-line installer from the platform's Pair page (it keeps the pairing), then run \`agentic-daemon update\` again`;

/** Tests only: timings, the staged `--version` run, the asset key and `http:` on the loopback. */
export interface UpdateTestOptions {
    readonly allowLoopbackHttp?: boolean;
    readonly check?: StagedCheck;
    /** How often the CLI looks at `state/`, and the daemon for `state/update-request.json`. */
    readonly pollMs?: number;
    /** How long the running daemon has to take the request. Default 30 s. */
    readonly pickupMs?: number;
    /** How long the CLI waits for the new version once taken. Default the drain plus 3 minutes. */
    readonly waitMs?: number;
    readonly platformKey?: string;
}

export interface UpdateCliContext {
    readonly install: InstallPaths;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof fetch;
    readonly test?: UpdateTestOptions;
}

/** The supervisor runs this daemon (#362): it wrote `state/supervisor.json` and set `AGENTIC_INSTALL_DIR` for it. */
export async function isSupervised(install: Pick<InstallPaths, 'supervisorFile'>, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
    return !!env.AGENTIC_INSTALL_DIR && existsSync(install.supervisorFile);
}

/** The manifest of a pinned release (`daemon-v<semver>` or `<semver>`) or of a channel. */
export function manifestUrl(releases: string, pick: { readonly version: string } | { readonly channel: 'stable' | 'latest' }): string {
    const base = releases.replace(/\/+$/, '');
    return 'version' in pick ? `${base}/download/daemon-v${pick.version.replace(/^daemon-v/, '')}/manifest.json` : `${base}/download/daemon-${pick.channel}/manifest.json`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

export async function updateCommand(flags: ParsedArgs['flags'], context: UpdateCliContext): Promise<number> {
    const { out, err, install } = context;
    const test = context.test ?? {};
    const allowLoopbackHttp = test.allowLoopbackHttp === true;
    if (flags.version === true) {
        err(`--version needs a release, e.g. daemon-v0.2.0\n\n${UPDATE_USAGE}`);
        return 2;
    }
    const channel = flags.channel ?? (DAEMON_CHANNEL === 'dev' ? 'latest' : DAEMON_CHANNEL);
    if (channel !== 'stable' && channel !== 'latest') {
        err(`--channel takes stable or latest\n\n${UPDATE_USAGE}`);
        return 2;
    }
    const pinned = typeof flags.version === 'string' ? flags.version : undefined;
    const url = manifestUrl(context.env.AGENTIC_RELEASES || DEFAULT_RELEASES, pinned ? { version: pinned } : { channel });
    if (!fetchableAsset({ url, sha256: '0'.repeat(64), bytes: 1, version: '0.0.0' }, allowLoopbackHttp)) {
        err(`refusing to read ${url}: releases are read over https: only`);
        return 1;
    }

    out(`installed: ${versionLine()}`);
    let manifest: { version?: unknown; channel?: unknown; commit?: unknown; assets?: Record<string, unknown> };
    try {
        const response = await (context.fetch ?? fetch)(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        manifest = (await response.json()) as typeof manifest;
    } catch (e) {
        err(`no release manifest at ${url}: ${(e as Error).message}`);
        return 1;
    }
    const key = test.platformKey ?? platformKey(process.platform, process.arch);
    const asset = manifest.assets?.[key] as Parameters<typeof downloadAsset>[0] | undefined;
    if (!asset || typeof asset !== 'object' || typeof asset.version !== 'string') {
        err(`the release at ${url} has no daemon for ${key}`);
        return 1;
    }
    if (!fetchableAsset(asset, allowLoopbackHttp)) {
        err(`the release at ${url} names no https: download with a sha256 for ${key}`);
        return 1;
    }
    // Main builds carry their commit time (`-main.<unix seconds>.<sha7>`, #437), so they order like releases do.
    const order = compareVersions(asset.version, DAEMON_VERSION);
    out(`available: agentic-daemon ${asset.version} (${String(manifest.channel ?? channel)}, ${String(manifest.commit ?? 'unknown')}) — ${order > 0 ? 'newer' : order === 0 ? 'the installed version' : 'older'}`);
    if (flags.check) return 0;
    if (!pinned && order === 0) {
        out('already up to date');
        return 0;
    }
    if (!pinned && order < 0) {
        out(`the installed version is newer than the ${channel} channel's; pass --version to go back to ${asset.version}`);
        return 0;
    }
    if (!existsSync(install.supervisorFile)) {
        err(REINSTALL);
        return 1;
    }

    const layout = updateLayout(install.root);
    if (existsSync(layout.staged)) {
        err(`an update is already staged at ${layout.staged}; wait for it to apply, or restart the daemon's service to drop it`);
        return 1;
    }
    const file = downloadFile(layout, asset.version);
    try {
        out(`downloading ${asset.url}`);
        let shown = -1;
        const got = await downloadAsset(asset, file, {
            ...(context.fetch ? { fetch: context.fetch } : {}),
            ...(allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
            onProgress: ({ bytes, total }) => {
                const percent = Math.floor((bytes / total) * 100);
                if (percent !== shown) out(`  ${percent}% of ${(total / 1024 / 1024).toFixed(1)} MB`);
                shown = percent;
            }
        });
        out('verifying the sha256');
        await verifyDownload(file, got, asset);
        out(`staging ${layout.staged}`);
        await stageZip(file, layout, { version: asset.version, ...(test.check ? { check: test.check } : {}) });
    } catch (e) {
        err(e instanceof UpdateError ? `update failed (${e.code}): ${e.message}` : `update failed: ${(e as Error).message}`);
        return 1;
    } finally {
        await rm(file, { force: true });
    }

    // The running daemon drains and exits 75; the supervisor swaps the staged build in and waits for its `ready`.
    const mode = flags.now ? 'now' : 'drain';
    const requestedAt = Date.now();
    const request: LocalUpdateRequest = { mode, drainTimeoutMs: CLI_DRAIN_TIMEOUT_MS, version: asset.version, at: requestedAt };
    await mkdir(install.stateDir, { recursive: true });
    // Temp file and rename: the running daemon never reads half a request.
    const temp = `${layout.requestFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(request)}\n`);
    await rename(temp, layout.requestFile);
    out(mode === 'now' ? 'restarting the daemon now' : 'the daemon restarts once no turn is running (up to 10 minutes)');

    const pollMs = test.pollMs ?? 1_000;
    const pickupBy = requestedAt + (test.pickupMs ?? 30_000);
    const waitUntil = requestedAt + (test.waitMs ?? (mode === 'now' ? 0 : CLI_DRAIN_TIMEOUT_MS) + 3 * 60_000);
    for (;;) {
        await sleep(pollMs);
        if (existsSync(layout.requestFile)) {
            if (Date.now() < pickupBy) continue;
            await rm(layout.requestFile, { force: true });
            await unstage(layout);
            err('the running daemon did not take the update — it is not running, or predates `agentic-daemon update`; reinstall with the one-line installer from the Pair page');
            return 1;
        }
        const ready = await readJson(install.readyFile);
        const failed = await readJson(install.updateFailedFile);
        if (failed && typeof failed.at === 'number' && failed.at >= requestedAt) {
            err(`the supervisor rolled the update back (${String(failed.reason)}); see ${install.supervisorLog}`);
            return 1;
        }
        if (ready && typeof ready.at === 'number' && ready.at >= requestedAt) {
            if (ready.version === asset.version) {
                out(`updated: agentic-daemon ${asset.version} is running`);
                return 0;
            }
            err(`the daemon came back on ${String(ready.version)}, not ${asset.version}: the update was rolled back; see ${install.supervisorLog}`);
            return 1;
        }
        if (Date.now() >= waitUntil) {
            err(`agentic-daemon ${asset.version} did not come up in time; see ${install.supervisorLog}`);
            return 1;
        }
    }
}
