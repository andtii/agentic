/**
 * Daemon releases and updates (#358; OPS-03, OPS-05, PLG-02, PLG-09): the
 * release manifest the platform reads, the phases an update or a harness
 * change reports on the daemon socket, and the workspace update policy.
 * Types only — `compareVersions` / `platformKey` live in
 * `@agentic/daemon-protocol`.
 */

import type { RuntimeId } from './agent.js';

/** Which releases a machine follows: `stable`, or `latest` (every published release). */
export type ReleaseChannel = 'stable' | 'latest';

/** One downloadable build, pinned by its digest. */
export interface ReleaseAsset {
    readonly url: string;
    /** Hex SHA-256 of the file at `url`; the daemon refuses a download that does not match. */
    readonly sha256: string;
    readonly bytes: number;
    readonly version: string;
}

/** A published release: the daemon build per platform and the harness builds it ships with. */
export interface ReleaseManifest {
    readonly version: string;
    readonly channel: ReleaseChannel;
    /** Epoch ms. */
    readonly publishedAt: number;
    readonly commit: string;
    /** The `DAEMON_PROTOCOL_VERSION` the build speaks. */
    readonly protocol: number;
    readonly notesUrl?: string;
    /** Keyed by release asset key, `<platform>-<arch>` as Node names them (`win32-x64`, `darwin-arm64`, `linux-x64`), as `DaemonBuild.platform` names it. */
    readonly assets: Readonly<Record<string, ReleaseAsset>>;
    /** The harness builds the release ships, by runtime; a runtime it ships none for is absent. */
    readonly harnesses: Readonly<Partial<Record<RuntimeId, { readonly version: string; readonly assets: Readonly<Record<string, ReleaseAsset>> }>>>;
}

/** Where a daemon self-update is (`update.status`). */
export type UpdatePhase = 'downloading' | 'verifying' | 'staged' | 'draining' | 'restarting' | 'failed';

/** Where a harness install, update or removal is (`harness.status`). */
export type HarnessPhase = 'downloading' | 'verifying' | 'staged' | 'draining' | 'applying' | 'done' | 'failed';

/** A runtime harness as a daemon has it: installed or not, and whether it is the release's version. */
export interface HarnessReport {
    readonly runtime: RuntimeId;
    readonly installed?: { readonly version: string; readonly at: number };
    readonly status: 'ready' | 'missing' | 'broken';
    /** The installed version is the one the release names. */
    readonly current?: boolean;
}

/** When a machine takes an update: only when asked, as soon as it is idle, or inside a recurring window. */
export type UpdatePolicy =
    | { readonly kind: 'manual' }
    | { readonly kind: 'auto-when-idle' }
    /** `cron` opens the window in `tz` (IANA); it stays open `durationMs`. */
    | { readonly kind: 'window'; readonly cron: string; readonly tz: string; readonly durationMs: number };
