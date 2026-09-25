/**
 * The provider-neutral pull request adapter (#741, PRJ-08): what the git feature reads and does on a repo's
 * pull requests, whatever hosts it. Adapters (GitHub first, `./github.ts`) fill core's `PullRequest`; nothing
 * provider specific leaks past this seam. Edge-safe — no `node:` imports; the caller injects the credential
 * and, for tests, `fetch`.
 */

import type { ProjectFolderInfo, PullRequest } from '@agentic/core';

/** How a PR is merged — the three methods every provider we target offers. */
export type PullMergeMethod = 'merge' | 'squash' | 'rebase';

/** The commit message a merge writes; the provider's own default when omitted. */
export interface PullMergeOptions {
    readonly subject?: string;
    readonly body?: string;
}

export interface PullMergeResult {
    readonly merged: boolean;
    /** The merge commit, when it merged. */
    readonly sha?: string;
    /** The provider's reason when it did not (conflicts, a failing required check, the head moved). */
    readonly message?: string;
}

export interface PullIssueRef {
    readonly number: number;
    readonly url: string;
}

/** The last rate-limit window a provider reported: `remaining` requests until `resetAt` (epoch ms). */
export interface PullRateLimit {
    readonly limit?: number;
    readonly remaining: number;
    readonly resetAt: number;
}

/**
 * One provider's pull requests. `repo` is always `owner/name` (see `pullRepoOf`); `thread` is a
 * `PullThread.id` as `get` returned it.
 */
export interface PullProvider {
    /** The adapter id, the `PullRequest.provider` it fills (`github`). */
    readonly id: string;
    /** The PR, or `undefined` when the repo has no PR by that number. */
    get(repo: string, number: number): Promise<PullRequest | undefined>;
    /** The repo's open PRs, newest first. */
    listOpen(repo: string): Promise<PullRequest[]>;
    /** The PR whose head is `branch`: the open one when there is one, else the most recently updated; `undefined` when none. */
    forBranch(repo: string, branch: string): Promise<PullRequest | undefined>;
    /** Merges the PR; `merged: false` with the provider's reason when it cannot (not an error). */
    merge(repo: string, number: number, method: PullMergeMethod, options?: PullMergeOptions): Promise<PullMergeResult>;
    /** Replies on a review thread. */
    reply(thread: string, body: string): Promise<void>;
    /** Opens an issue (a follow-up an agent files). */
    openIssue(repo: string, title: string, body: string): Promise<PullIssueRef>;
    /** The last rate-limit window the provider reported; `undefined` before the first response. */
    rateLimit(): PullRateLimit | undefined;
}

export type PullProviderErrorCode = 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'invalid' | 'failed';

/** Every adapter failure: a code the caller can act on, and a message that never carries the credential. */
export class PullProviderError extends Error {
    override readonly name = 'PullProviderError';
    constructor(
        readonly code: PullProviderErrorCode,
        message: string,
        readonly status?: number,
        /** When a `rate-limited` call may be retried (epoch ms). */
        readonly retryAt?: number
    ) {
        super(message);
    }
}

/** Where a repo lives: the adapter id and its `owner/name`. */
export interface PullRepoRef {
    readonly provider: string;
    readonly repo: string;
}

/** Hosts whose origins an adapter reads, host → adapter id. Add an Enterprise host to reach it. */
export const DEFAULT_PULL_HOSTS: Readonly<Record<string, string>> = { 'github.com': 'github' };

const REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Whether `repo` is a well-formed `owner/name`. */
export function isPullRepo(repo: string): boolean {
    const parts = repo.split('/');
    return parts.length === 2 && parts.every((p) => REPO_SEGMENT.test(p) && p !== '.' && p !== '..');
}

/**
 * An origin remote URL → `{provider, repo}`: `https://github.com/o/r(.git)`, `git@github.com:o/r.git`,
 * `ssh://git@github.com[:22]/o/r.git`. `undefined` for a host no adapter reads, or a path that is not `owner/name`.
 */
export function pullRepoOfOrigin(origin: string, hosts: Readonly<Record<string, string>> = DEFAULT_PULL_HOSTS): PullRepoRef | undefined {
    const text = origin.trim();
    let host: string;
    let path: string;
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            return undefined;
        }
        host = url.hostname;
        path = url.pathname;
    } else if (scp) {
        host = scp[1]!;
        path = scp[2]!;
    } else return undefined;
    const provider = hosts[host.toLowerCase()];
    if (!provider) return undefined;
    const repo = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
    return isPullRepo(repo) ? { provider, repo } : undefined;
}

/** The folder's `{provider, repo}` from its origin (`identityOf`); `undefined` when it has none an adapter reads. */
export function pullRepoOf(folder: ProjectFolderInfo, hosts?: Readonly<Record<string, string>>): PullRepoRef | undefined {
    // `identityOf`, inline: this module is the `./provider` entry and must not pull the feature plugin in with it.
    const origin = folder.git?.origin;
    return origin ? pullRepoOfOrigin(origin, hosts) : undefined;
}
