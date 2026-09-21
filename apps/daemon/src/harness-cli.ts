/**
 * `agentic-daemon harness list`
 * `agentic-daemon harness install <runtime>… [--version <release>] [--channel latest|stable] [--manifest <url>]`
 * `agentic-daemon harness update [<runtime>…] [same flags]`
 * `agentic-daemon harness rm <runtime>`
 *
 * The harness store (`harness.ts`, #369) from the terminal, reading the same release manifests as the one-line
 * installers: `--manifest` names one, `--version <semver>` the `daemon-v<semver>` release, `--channel` (or
 * `AGENTIC_CHANNEL`) a channel's rolling one; by default a stable daemon takes its own release — the harnesses it was
 * built with — and any other build the `latest` channel. `AGENTIC_RELEASES` points at another releases URL.
 *
 * A running daemon keeps the version it started with until it restarts (the platform's `harness.request` drains and
 * switches live); it removes the versions it no longer uses when it starts. `rm` is refused while an environment in
 * `environments.json` runs on the runtime, as the platform's removal is.
 */

import type { ReleaseManifest } from '@agentic/core';
import { loadEnvironments } from './environments.js';
import { fetchReleaseManifest, harnessAsset, HarnessError, releaseManifestUrl, type HarnessStore } from './harness.js';
import type { DaemonPaths } from './paths.js';
import { DAEMON_CHANNEL, DAEMON_VERSION } from './version.js';

export const HARNESS_USAGE = `  agentic-daemon harness list
  agentic-daemon harness install <runtime>… [--version <release>] [--channel latest|stable] [--manifest <url>]
                       (from the release this daemon came from, or the one named; runtimes: claude-code, copilot-cli, codex-cli)
  agentic-daemon harness update [<runtime>…] [--version <release>] [--channel latest|stable] [--manifest <url>]
  agentic-daemon harness rm <runtime>`;

export interface HarnessCommandContext {
    readonly store: HarnessStore;
    /** The runtimes this daemon has drivers for. */
    readonly runtimes: readonly string[];
    readonly paths: Pick<DaemonPaths, 'environmentsFile'>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    readonly fetch?: typeof fetch;
    /** `AGENTIC_CHANNEL`, `AGENTIC_RELEASES`. Default `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /** The release asset key; default this process's `<platform>-<arch>`. */
    readonly platform?: string;
    /** The build this CLI is (tests); default the stamped one. */
    readonly build?: { readonly version: string; readonly channel: string };
}

const text = (v: string | true | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** Which release manifest the flags, the environment and this build name. */
export function harnessManifestUrl(flags: Readonly<Record<string, string | true>>, env: Readonly<Record<string, string | undefined>>, build: { readonly version: string; readonly channel: string }): string {
    const manifest = text(flags.manifest);
    if (manifest) return manifest;
    const releases = env.AGENTIC_RELEASES || undefined;
    const version = text(flags.version);
    const channel = text(flags.channel) ?? (env.AGENTIC_CHANNEL || undefined);
    if (version) return releaseManifestUrl({ ...(releases ? { releases } : {}), version });
    if (channel) return releaseManifestUrl({ ...(releases ? { releases } : {}), channel });
    // A stable build takes its own release: the harnesses it was built and tested with.
    if (build.channel === 'stable') return releaseManifestUrl({ ...(releases ? { releases } : {}), version: build.version });
    return releaseManifestUrl({ ...(releases ? { releases } : {}), channel: 'latest' });
}

export async function harnessCommand(sub: string | undefined, positional: readonly string[], flags: Readonly<Record<string, string | true>>, c: HarnessCommandContext): Promise<number> {
    const env = c.env ?? process.env;
    const build = c.build ?? { version: DAEMON_VERSION, channel: DAEMON_CHANNEL };
    const platform = c.platform ?? `${process.platform}-${process.arch}`;
    for (const flag of ['version', 'channel', 'manifest']) {
        if (flags[flag] === true) {
            c.err(`--${flag} needs a value\n\n${HARNESS_USAGE}`);
            return 2;
        }
    }
    const unknown = positional.filter((r) => !c.runtimes.includes(r));
    if (unknown.length) {
        c.err(`this daemon has no runtime ${unknown.join(', ')} (it has: ${c.runtimes.join(', ')})`);
        return 1;
    }

    let manifest: ReleaseManifest | undefined;
    const release = async (): Promise<ReleaseManifest> => {
        if (manifest) return manifest;
        const url = harnessManifestUrl(flags, env, build);
        c.out(`reading ${url}`);
        manifest = await fetchReleaseManifest(url, c.fetch ?? fetch);
        return manifest;
    };
    /** Install the release's build of `runtime`; `false` when the release has none for this platform. */
    const install = async (runtime: string, only: 'always' | 'if-newer'): Promise<boolean> => {
        const m = await release();
        const asset = harnessAsset(m, runtime, platform);
        if (!asset) {
            c.err(`the release ${m.version} ships no ${runtime} harness for ${platform}`);
            return false;
        }
        const now = c.store.locate(runtime);
        if (only === 'if-newer' && now?.source === 'store' && now.version === asset.version) {
            c.out(`${runtime} ${asset.version} is up to date`);
            return true;
        }
        const staged = await c.store.stage(runtime, asset, {
            onPhase: (phase) => c.out(`${runtime}: ${phase}${phase === 'downloading' ? ` ${asset.url} (${(asset.bytes / 1024 / 1024).toFixed(1)} MB)` : ''}`),
            ...(c.fetch ? { fetch: c.fetch } : {})
        });
        if (staged.already) {
            c.out(`${runtime} ${staged.version} is already installed`);
            return true;
        }
        await c.store.activate(runtime, staged.version);
        c.out(`installed ${runtime} ${staged.version} (${staged.dir}); a running daemon uses it after a restart`);
        return true;
    };

    try {
        switch (sub) {
            case 'list': {
                for (const runtime of c.runtimes) {
                    const state = c.store.state(runtime);
                    const pinned = c.store.pinned(runtime);
                    if (state.status === 'ready') {
                        const { location } = state;
                        c.out(`${runtime}\t${location.version}\t${location.source === 'store' ? 'installed' : "the daemon's own node_modules"}${pinned && pinned !== location.version ? `\t(this daemon was built with ${pinned})` : ''}\t${location.binary}`);
                    } else if (state.status === 'broken') c.out(`${runtime}\tbroken\t${state.problem}`);
                    else c.out(`${runtime}\tnot installed\t(agentic-daemon harness install ${runtime})`);
                }
                return 0;
            }
            case 'install': {
                if (positional.length === 0) {
                    c.err(`harness install needs a runtime\n\n${HARNESS_USAGE}`);
                    return 2;
                }
                let ok = true;
                for (const runtime of positional) ok = (await install(runtime, 'always')) && ok;
                return ok ? 0 : 1;
            }
            case 'update': {
                // Without runtimes: every one installed in the store.
                const runtimes = positional.length ? positional : c.runtimes.filter((r) => c.store.locate(r)?.source === 'store' || c.store.state(r).status === 'broken');
                if (runtimes.length === 0) {
                    c.out('no harness is installed — install one with `agentic-daemon harness install <runtime>`');
                    return 0;
                }
                let ok = true;
                for (const runtime of runtimes) ok = (await install(runtime, 'if-newer')) && ok;
                return ok ? 0 : 1;
            }
            case 'rm': {
                const runtime = positional[0];
                if (!runtime || positional.length > 1) {
                    c.err(`harness rm needs one runtime\n\n${HARNESS_USAGE}`);
                    return 2;
                }
                const loaded = await loadEnvironments(c.paths.environmentsFile);
                const users = loaded.ok ? loaded.environments.filter((e) => e.runtime === runtime) : [];
                if (users.length) {
                    c.err(`environment${users.length === 1 ? '' : 's'} ${users.map((e) => e.id).join(', ')} run${users.length === 1 ? 's' : ''} on ${runtime}; remove ${users.length === 1 ? 'it' : 'them'} first (agentic-daemon env rm <id>)`);
                    return 1;
                }
                if (!(await c.store.remove(runtime))) {
                    c.err(`${runtime} has no harness installed in ${c.store.root}`);
                    return 1;
                }
                c.out(`removed the ${runtime} harness`);
                return 0;
            }
            default:
                c.err(`${sub ? `unknown harness command "${sub}"` : 'harness needs a command'}\n\n${HARNESS_USAGE}`);
                return 2;
        }
    } catch (e) {
        if (!(e instanceof HarnessError)) throw e;
        c.err(`${e.message} (${e.code})`);
        return 1;
    }
}
