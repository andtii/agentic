/**
 * The ReleaseDirectory — `global:releases` (architecture §4; OPS-03, EXE-08, #365). What daemon releases exist: the
 * `manifest.json` of each release channel, read from GitHub every hour and kept here, so every Machine compares its
 * daemon's build against one cached copy instead of fetching on its own. A failed fetch keeps the last good manifest
 * and records the error. Read-only for everyone: `get()` for any signed-in principal (a Machine over a hop), `refresh()`
 * for a user.
 *
 * The URLs are the rolling `daemon-stable` / `daemon-latest` releases (#361) — never GitHub's `releases/latest`, which
 * points at the app releases. Save persistence; every mutation ends in `ctx.save()` inside the turn.
 */

import { isVersion, releaseAsset } from '@agentic/daemon-protocol';
import type { Principal, ReleaseAsset, ReleaseChannel, ReleaseManifest, RuntimeId } from '@agentic/core';
import { defineActor, type ActorPolicy } from '@sigx/actors';

export const RELEASE_DIRECTORY_TYPE = 'ReleaseDirectory';
/** The single directory every workspace reads. */
export const RELEASE_DIRECTORY_KEY = 'global:releases';
/** Where each channel's manifest is published (#361). */
export const RELEASE_SOURCES: Readonly<Record<ReleaseChannel, string>> = {
    stable: 'https://github.com/andtii/agentic/releases/download/daemon-stable/manifest.json',
    latest: 'https://github.com/andtii/agentic/releases/download/daemon-latest/manifest.json'
};
export const RELEASE_REFRESH_MS = 60 * 60_000;
/** `check` reads again only when the last read is older than this (#468): page visits never hammer GitHub. */
export const RELEASE_CHECK_MIN_MS = 5 * 60_000;
export const RELEASE_FETCH_TIMEOUT_MS = 10_000;
/** A manifest larger than this is refused unread. */
export const RELEASE_MANIFEST_MAX_BYTES = 1024 * 1024;
/** The reminder that re-reads the manifests. */
export const REFRESH = 'refresh';

/**
 * The oldest daemon build this platform serves: an older one is `outdated` on its Machine and told so on `welcome`.
 * The lowest version there is — every build so far is served; raise it when the platform stops speaking to one.
 */
export const MIN_DAEMON_VERSION = '0.0.0-0';
/** This platform's own version, as `welcome.platform.version` names it. The web app carries no build stamp yet. */
export const PLATFORM_VERSION = '0.1.0';

/** What `welcome.platform.version` carries. */
export function platformVersion(): string {
    return PLATFORM_VERSION;
}

export interface ReleaseDirectoryOptions {
    /** Defaults to the global `fetch`; tests hand in a fake. */
    readonly fetch?: typeof fetch;
    /** Manifest URL per channel. Default `RELEASE_SOURCES`. */
    readonly sources?: Partial<Record<ReleaseChannel, string>>;
    readonly now?: () => number;
    /** How often the manifests are read again. Default one hour. */
    readonly refreshMs?: number;
    /** Per fetch. Default 10 s. */
    readonly timeoutMs?: number;
}

export interface ReleaseDirectoryState {
    v: 1;
    channels: { stable?: ReleaseManifest; latest?: ReleaseManifest };
    lastCheckedAt?: number;
    /** Why the last read failed, per channel, joined; absent when it all succeeded. */
    error?: string;
    /** When the refresh reminder was last armed, so a `get` arms it once. */
    armedAt?: number;
}

/** `ReleaseDirectory.get()`. */
export interface ReleasesView {
    readonly channels: { readonly stable?: ReleaseManifest; readonly latest?: ReleaseManifest };
    readonly lastCheckedAt?: number;
    readonly error?: string;
}

const CHANNELS: readonly ReleaseChannel[] = ['stable', 'latest'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function assets(value: unknown, where: string): Record<string, ReleaseAsset> {
    if (!isRecord(value)) throw new Error(`${where} must be an object keyed by platform`);
    const out: Record<string, ReleaseAsset> = {};
    for (const [key, asset] of Object.entries(value)) {
        const parsed = releaseAsset.safeParse(asset);
        if (!parsed.success) throw new Error(`${where}.${key}: ${parsed.error.issues[0]?.message ?? 'invalid asset'}`);
        out[key] = parsed.data;
    }
    return out;
}

/** Validate a fetched manifest and rebuild it field by field (unknown keys dropped). Throws a message naming the bad field. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
    if (!isRecord(value)) throw new Error('the manifest is not an object');
    const { version, channel, publishedAt, commit, protocol, notesUrl, harnesses } = value;
    if (typeof version !== 'string' || !isVersion(version)) throw new Error('version must be a semver version');
    if (channel !== 'stable' && channel !== 'latest') throw new Error('channel must be stable or latest');
    if (typeof publishedAt !== 'number' || !Number.isFinite(publishedAt) || publishedAt < 0) throw new Error('publishedAt must be epoch ms');
    if (typeof commit !== 'string' || !commit) throw new Error('commit is required');
    if (typeof protocol !== 'number' || !Number.isInteger(protocol) || protocol < 1) throw new Error('protocol must be a positive integer');
    if (notesUrl !== undefined && typeof notesUrl !== 'string') throw new Error('notesUrl must be a string');
    const shipped: Partial<Record<RuntimeId, { version: string; assets: Record<string, ReleaseAsset> }>> = {};
    if (harnesses !== undefined) {
        if (!isRecord(harnesses)) throw new Error('harnesses must be an object keyed by runtime');
        for (const [runtime, h] of Object.entries(harnesses)) {
            if (!isRecord(h) || typeof h.version !== 'string' || !h.version) throw new Error(`harnesses.${runtime} needs a version`);
            shipped[runtime as RuntimeId] = { version: h.version, assets: assets(h.assets, `harnesses.${runtime}.assets`) };
        }
    }
    return { version, channel, publishedAt, commit, protocol, ...(notesUrl ? { notesUrl } : {}), assets: assets(value.assets, 'assets'), harnesses: shipped };
}

/** GET one manifest: 10 s, at most 1 MiB, JSON, validated. Throws a one-line reason. */
async function fetchManifest(doFetch: typeof fetch, url: string, timeoutMs: number): Promise<ReleaseManifest> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await doFetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (declared > RELEASE_MANIFEST_MAX_BYTES) throw new Error(`the manifest is ${declared} bytes, more than ${RELEASE_MANIFEST_MAX_BYTES}`);
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = res.body?.getReader();
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > RELEASE_MANIFEST_MAX_BYTES) {
                    await reader.cancel().catch(() => undefined);
                    throw new Error(`the manifest is more than ${RELEASE_MANIFEST_MAX_BYTES} bytes`);
                }
                chunks.push(value);
            }
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
            bytes.set(c, at);
            at += c.byteLength;
        }
        let json: unknown;
        try {
            json = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            throw new Error('the manifest is not JSON');
        }
        return parseReleaseManifest(json);
    } catch (e) {
        if (controller.signal.aborted) throw new Error(`no answer within ${timeoutMs} ms`);
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/** `get` and the rate-limited `check` for anyone signed in (a Machine's hop, the web); `refresh` for a user. */
const directoryPolicy: ActorPolicy = (principal: Principal | null, _rq, op) => {
    if (!principal) return false;
    const method = (op.resource as { method?: string } | undefined)?.method;
    return method === 'get' || method === 'check' || principal.kind === 'user';
};

/** Build the ReleaseDirectory over its fetch. The default export {@link ReleaseDirectory} uses the global `fetch`. */
export function defineReleaseDirectory(options: ReleaseDirectoryOptions = {}) {
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    // Only a URL that is given overrides the default: `{ stable: undefined }` keeps it.
    const sources: Record<ReleaseChannel, string> = { stable: options.sources?.stable ?? RELEASE_SOURCES.stable, latest: options.sources?.latest ?? RELEASE_SOURCES.latest };
    // Read per call, never captured: a clock swapped after definition (tests' fake timers) is the one used.
    const now = options.now ?? (() => Date.now());
    const refreshMs = options.refreshMs ?? RELEASE_REFRESH_MS;
    const timeoutMs = options.timeoutMs ?? RELEASE_FETCH_TIMEOUT_MS;

    const view = (s: ReleaseDirectoryState): ReleasesView => ({
        channels: s.channels,
        ...(s.lastCheckedAt !== undefined ? { lastCheckedAt: s.lastCheckedAt } : {}),
        ...(s.error ? { error: s.error } : {})
    });

    /** Read every channel; a failure keeps that channel's last good manifest. */
    async function read(s: ReleaseDirectoryState): Promise<void> {
        const results = await Promise.all(CHANNELS.map(async (channel) => ({ channel, result: await fetchManifest(doFetch, sources[channel], timeoutMs).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) })));
        const errors: string[] = [];
        for (const { channel, result } of results) {
            if (result instanceof Error) errors.push(`${channel}: ${result.message}`);
            else s.channels[channel] = result;
        }
        s.lastCheckedAt = now();
        if (errors.length) s.error = errors.join('; ');
        else delete s.error;
    }

    return defineActor({
        type: RELEASE_DIRECTORY_TYPE,
        authorize: [directoryPolicy],
        persistence: 'explicit',
        state: (): ReleaseDirectoryState => ({ v: 1, channels: {} }),
        methods: (ctx) => ({
            /**
             * The cached manifests. Never fetches in the caller's turn: a copy that is missing or older than the refresh
             * interval arms the refresh reminder (once), and the next `get` sees what it read.
             */
            async get(): Promise<ReleasesView> {
                const s = ctx.state;
                const at = now();
                const stale = s.lastCheckedAt === undefined || s.lastCheckedAt + refreshMs <= at;
                if (stale && (s.armedAt === undefined || s.armedAt + refreshMs <= at)) {
                    s.armedAt = at;
                    await ctx.reminders.set(REFRESH, { due: 0 });
                    await ctx.save();
                }
                return ctx.snapshot(view(s));
            },

            /**
             * Read the manifests now unless the last read is younger than `minAgeMs` (#468: a machine's page opening, its
             * "Check for updates") — so a release shows at once, and a burst of visits reads GitHub once.
             */
            async check(minAgeMs: number = RELEASE_CHECK_MIN_MS): Promise<ReleasesView> {
                const s = ctx.state;
                const floor = Math.max(RELEASE_CHECK_MIN_MS, Number.isFinite(minAgeMs) ? minAgeMs : RELEASE_CHECK_MIN_MS);
                if (s.lastCheckedAt !== undefined && s.lastCheckedAt + floor > now()) return ctx.snapshot(view(s));
                await read(s);
                s.armedAt = now();
                await ctx.reminders.set(REFRESH, { due: refreshMs });
                await ctx.save();
                return ctx.snapshot(view(s));
            },

            /** Read the manifests now (a user's "check for updates"). */
            async refresh(): Promise<ReleasesView> {
                const s = ctx.state;
                await read(s);
                s.armedAt = now();
                await ctx.reminders.set(REFRESH, { due: refreshMs });
                await ctx.save();
                return ctx.snapshot(view(s));
            }
        }),
        /** The hourly read; it re-arms itself. */
        onReminder: async (ctx, name) => {
            if (name !== REFRESH) return;
            const s = ctx.state;
            await read(s);
            s.armedAt = now();
            await ctx.reminders.set(REFRESH, { due: refreshMs });
            await ctx.save();
        }
    });
}

/** The directory over the global `fetch`. */
export const ReleaseDirectory = defineReleaseDirectory();

export type ReleaseDirectoryActor = typeof ReleaseDirectory;
