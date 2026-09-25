/**
 * What the Pulls actor reads a project's pull requests through (#742, PRJ-08). The actor knows only this port —
 * never a provider: the app hands it `tokenPullSources` over the git feature's adapters (GitHub first,
 * `@agentic/plugins-git` #741), a test hands it a fake. Structurally the read half of plugins-git's `PullProvider`,
 * so an adapter is a `PullSource` as it stands.
 */
import type { ProjectId, PullRequest, WorkspaceId } from '@agentic/core';

/** The reads the actor makes: one PR by number, and the repo's open PRs. */
export interface PullSource {
    /** The PR, or `undefined` when the repo has no PR by that number. */
    get(repo: string, number: number): Promise<PullRequest | undefined>;
    /** The repo's open PRs. */
    listOpen(repo: string): Promise<PullRequest[]>;
}

/** Whose pull requests: the project, and the repo its origin names (`{provider, repo}`, plugins-git `pullRepoOf`). */
export interface PullSourceRef {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    /** The adapter id (`github`). */
    readonly provider: string;
    /** `owner/name`. */
    readonly repo: string;
}

/**
 * Opens a source per poll. `undefined` when there is none for the ref (no adapter, no credential) — the actor says
 * so on its view and backs off; a throw is the same, with the error's message.
 */
export interface PullSourcePort {
    open(ref: PullSourceRef): PullSource | undefined | Promise<PullSource | undefined>;
}

/** An adapter built from its credential — `(token) => createGitHubPullProvider({ token })`. */
export type PullSourceAdapter = (token: string) => PullSource;

export interface TokenPullSourcesOptions {
    /** Adapter id → factory. */
    readonly adapters: Readonly<Record<string, PullSourceAdapter>>;
    /** The credential for a ref; `undefined` when there is none. */
    token(ref: PullSourceRef): Promise<string | undefined>;
    /** How long an opened source is reused before its credential is asked for again, ms. Default 10 minutes. */
    readonly ttlMs?: number;
    /** Clock; default `Date.now`. */
    readonly now?: () => number;
}

/** The default reuse window: a poll every minute must not open the secret (and audit it) every minute. */
export const PULL_SOURCE_TTL_MS = 10 * 60_000;

/**
 * The app's port: the ref's adapter over the ref's credential, reused per workspace and provider for `ttlMs`
 * (per isolate — a cold object asks again). A failed credential lookup is not cached.
 */
export function tokenPullSources(options: TokenPullSourcesOptions): PullSourcePort {
    const ttl = options.ttlMs ?? PULL_SOURCE_TTL_MS;
    const now = options.now ?? Date.now;
    const cache = new Map<string, { readonly source: PullSource; readonly at: number }>();
    return {
        async open(ref) {
            const adapter = options.adapters[ref.provider];
            if (!adapter) return undefined;
            const id = `${ref.workspaceId}\u0000${ref.provider}`;
            const hit = cache.get(id);
            if (hit && now() - hit.at < ttl) return hit.source;
            const token = await options.token(ref);
            if (!token) {
                cache.delete(id);
                return undefined;
            }
            const source = adapter(token);
            cache.set(id, { source, at: now() });
            return source;
        }
    };
}

/** No source for any ref: every poll says so on the view. What an app registers until it wires an adapter. */
export const NO_PULL_SOURCES: PullSourcePort = { open: () => undefined };
