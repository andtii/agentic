/**
 * What the Pulls actor reads a project's pull requests through (#742, PRJ-08). The actor knows only this port —
 * never a provider: the app hands it `tokenPullSources` over the git feature's adapters (GitHub first,
 * `@agentic/plugins-git` #741), a test hands it a fake. Structurally the read half of plugins-git's `PullProvider`,
 * so an adapter is a `PullSource` as it stands.
 */
import type { ProjectId, PullRequest, WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { registryKey } from '../registry/key.js';
import { registryCode } from '../routing/factory.js';

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
 * The app's port: the ref's adapter over the ref's credential, reused per workspace, project and provider for
 * `ttlMs` (per isolate — a cold object asks again). A failed credential lookup is not cached.
 */
export function tokenPullSources(options: TokenPullSourcesOptions): PullSourcePort {
    const ttl = options.ttlMs ?? PULL_SOURCE_TTL_MS;
    const now = options.now ?? Date.now;
    const cache = new Map<string, { readonly source: PullSource; readonly at: number }>();
    return {
        async open(ref) {
            const adapter = options.adapters[ref.provider];
            if (!adapter) return undefined;
            const id = `${ref.workspaceId}\u0000${ref.projectId}\u0000${ref.provider}`;
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

export interface RegistryPullTokenOptions {
    /** The Registry definition, as a thunk like the other actor ports. */
    readonly registry: () => AnyActorDefinition;
    /** The plugin that holds the `secret:<secret>` grant (the git feature, `agentic.feature.git`). */
    readonly pluginId: string;
    /** The secret's name (`github-token`). */
    readonly secret: string;
}

interface RegistrySecrets {
    openSecret(name: string, pluginId: string): Promise<string>;
}

/** Registry refusals that mean "no credential", not "something broke": by their stable codes. */
const NO_TOKEN_CODES: ReadonlySet<string> = new Set(['secret-missing', 'secret-denied', 'plugin-missing', 'plugin-disabled']);

/**
 * A `TokenPullSourcesOptions.token` over the workspace's Registry (#793): `openSecret(secret, pluginId)` as the
 * workspace owner — enabled plugin, granted secret, audited like every open. No secret, no grant or the plugin
 * off → `undefined` (the actor says there is no source); any other failure throws.
 */
export function registryPullToken(options: RegistryPullTokenOptions): (ref: PullSourceRef) => Promise<string | undefined> {
    return async (ref) => {
        const registry = actor(options.registry(), registryKey(ref.workspaceId)).with({ context: asPrincipal(userPrincipal(ref.workspaceId, ref.workspaceId)) }) as unknown as RegistrySecrets;
        try {
            const token = await registry.openSecret(options.secret, options.pluginId);
            return token.trim() || undefined;
        } catch (e) {
            const code = registryCode(e) ?? (/\[registry\] ".*" was not granted secret:/.test(e instanceof Error ? e.message : '') ? 'secret-denied' : undefined);
            if (code !== undefined && NO_TOKEN_CODES.has(code)) return undefined;
            throw e;
        }
    };
}
