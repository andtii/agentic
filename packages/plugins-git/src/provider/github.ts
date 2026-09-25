/**
 * The GitHub pull request adapter (#741, PRJ-08) over `fetch`: reads through one GraphQL query per call (the PR,
 * its latest commit's check rollup, review decision, requested reviewers and review threads in a single request),
 * acts through REST (merge, open an issue) and GraphQL (reply on a thread). The token is injected by the caller —
 * the project's GitHub connector credential — and never appears in an error. Rate-limit aware: it remembers the
 * last `x-ratelimit-*` window and refuses to call while an exhausted window has not reset.
 */

import type { PullCheck, PullCheckState, PullRequest, PullReviewState, PullThread } from '@agentic/core';

import { PullProviderError, isPullRepo, type PullIssueRef, type PullMergeMethod, type PullMergeOptions, type PullMergeResult, type PullProvider, type PullRateLimit } from './types.js';

export const GITHUB_PROVIDER_ID = 'github';
export const GITHUB_API_BASE = 'https://api.github.com';

export interface GitHubProviderOptions {
    /** The credential, or a function returning it per request (a connector that refreshes). */
    readonly token: string | (() => string | Promise<string>);
    /** `https://api.github.com`, or an Enterprise `https://host/api/v3` (GraphQL at `https://host/api/graphql`). */
    readonly apiBase?: string;
    readonly fetch?: typeof fetch;
    /** The clock (epoch ms); tests pin it. */
    readonly now?: () => number;
    /** How many open PRs `listOpen` reads (at most 100). Default 50. */
    readonly listLimit?: number;
}

const THREADS_PAGE = 100;
const CHECKS_PAGE = 100;

/** One PR, everything `PullRequest` carries. The first 100 threads and checks — enough for any PR a person reads. */
const PULL_FIELDS = `
    number title url state isDraft headRefName baseRefName additions deletions changedFiles createdAt mergedAt mergeable reviewDecision
    author { login }
    reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { slug } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECKS_PAGE}) { nodes {
        __typename
        ... on CheckRun { name status conclusion title startedAt completedAt }
        ... on StatusContext { context state description }
    } } } } } }
    reviewThreads(first: ${THREADS_PAGE}) { nodes {
        id isResolved path line
        first: comments(first: 1) { nodes { author { login } body } }
        last: comments(last: 1) { totalCount nodes { body } }
    } }`;

export const GITHUB_PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PULL_FIELDS} } } }`;

export const GITHUB_OPEN_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: $first, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PULL_FIELDS} } } } }`;

export const GITHUB_BRANCH_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) { pullRequests(headRefName: $branch, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PULL_FIELDS} } } } }`;

export const GITHUB_REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }`;

// ── the GraphQL shapes read (only the fields asked for) ──

interface GqlLogin { readonly login?: string | null }
interface GqlCheckRun { readonly __typename: 'CheckRun'; readonly name: string; readonly status: string; readonly conclusion?: string | null; readonly title?: string | null; readonly startedAt?: string | null; readonly completedAt?: string | null }
interface GqlStatusContext { readonly __typename: 'StatusContext'; readonly context: string; readonly state: string; readonly description?: string | null }
interface GqlThread {
    readonly id: string;
    readonly isResolved: boolean;
    readonly path?: string | null;
    readonly line?: number | null;
    readonly first: { readonly nodes: readonly { readonly author?: GqlLogin | null; readonly body: string }[] };
    readonly last: { readonly totalCount: number; readonly nodes: readonly { readonly body: string }[] };
}
export interface GqlPull {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly state: 'OPEN' | 'MERGED' | 'CLOSED';
    readonly isDraft?: boolean;
    readonly headRefName: string;
    readonly baseRefName: string;
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly createdAt: string;
    readonly mergedAt?: string | null;
    readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
    readonly reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
    readonly author?: GqlLogin | null;
    readonly reviewRequests?: { readonly nodes: readonly { readonly requestedReviewer?: (GqlLogin & { readonly slug?: string }) | null }[] } | null;
    readonly commits?: { readonly nodes: readonly { readonly commit: { readonly statusCheckRollup?: { readonly contexts: { readonly nodes: readonly (GqlCheckRun | GqlStatusContext | { readonly __typename: string })[] } } | null } }[] } | null;
    readonly reviewThreads?: { readonly nodes: readonly GqlThread[] } | null;
}

// ── mapping ──

const time = (iso: string | null | undefined): number | undefined => {
    if (!iso) return undefined;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? undefined : t;
};

function checkRunState(status: string, conclusion: string | null | undefined): PullCheckState {
    if (status === 'IN_PROGRESS') return 'running';
    if (status !== 'COMPLETED') return 'queued';
    switch (conclusion) {
        case 'SUCCESS':
        case 'NEUTRAL':
            return 'passed';
        case 'SKIPPED':
        case 'STALE':
            return 'skipped';
        default:
            return 'failed';
    }
}

function statusState(state: string): PullCheckState {
    switch (state) {
        case 'SUCCESS':
            return 'passed';
        case 'PENDING':
            return 'running';
        case 'EXPECTED':
            return 'queued';
        default:
            return 'failed';
    }
}

function checksOf(pull: GqlPull): PullCheck[] {
    const contexts = pull.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    const out: PullCheck[] = [];
    for (const node of contexts) {
        if (node.__typename === 'CheckRun') {
            const run = node as GqlCheckRun;
            const started = time(run.startedAt);
            const completed = time(run.completedAt);
            out.push({
                name: run.name,
                state: checkRunState(run.status, run.conclusion),
                ...(run.title ? { detail: run.title } : {}),
                ...(started !== undefined && completed !== undefined && completed >= started ? { durationMs: completed - started } : {})
            });
        } else if (node.__typename === 'StatusContext') {
            const status = node as GqlStatusContext;
            out.push({ name: status.context, state: statusState(status.state), ...(status.description ? { detail: status.description } : {}) });
        }
    }
    return out;
}

function reviewersOf(pull: GqlPull): string[] {
    const out: string[] = [];
    for (const { requestedReviewer: r } of pull.reviewRequests?.nodes ?? []) {
        const name = r?.login ?? r?.slug;
        if (name) out.push(name);
    }
    return out;
}

function reviewStateOf(pull: GqlPull, reviewers: readonly string[]): PullReviewState {
    switch (pull.reviewDecision) {
        case 'APPROVED':
            return 'approved';
        case 'CHANGES_REQUESTED':
            return 'changes-requested';
        case 'REVIEW_REQUIRED':
            return 'requested';
        default:
            return reviewers.length ? 'requested' : 'none';
    }
}

function threadOf(node: GqlThread): PullThread {
    const first = node.first.nodes[0];
    const last = node.last.nodes[0];
    return {
        id: node.id,
        author: first?.author?.login ?? 'ghost',
        ...(node.path ? { path: node.path } : {}),
        ...(typeof node.line === 'number' ? { line: node.line } : {}),
        body: first?.body ?? '',
        state: node.isResolved ? 'resolved' : 'open',
        ...(node.last.totalCount > 1 && last ? { reply: last.body } : {})
    };
}

/** A GraphQL pull request node → core's `PullRequest` (exported for the adapter's tests and future adapters' parity). */
export function pullFromGitHub(repo: string, pull: GqlPull): PullRequest {
    const reviewers = reviewersOf(pull);
    const mergedAt = time(pull.mergedAt);
    return {
        provider: GITHUB_PROVIDER_ID,
        repo,
        number: pull.number,
        title: pull.title,
        url: pull.url,
        head: pull.headRefName,
        base: pull.baseRefName,
        state: pull.state === 'MERGED' ? 'merged' : pull.state === 'CLOSED' ? 'closed' : 'open',
        ...(pull.isDraft ? { draft: true } : {}),
        additions: pull.additions,
        deletions: pull.deletions,
        files: pull.changedFiles,
        openedBy: pull.author?.login ?? 'ghost',
        openedAt: time(pull.createdAt) ?? 0,
        ...(mergedAt !== undefined ? { mergedAt } : {}),
        checks: checksOf(pull),
        review: { state: reviewStateOf(pull, reviewers), reviewers, threads: (pull.reviewThreads?.nodes ?? []).map(threadOf) },
        ...(pull.mergeable === 'MERGEABLE' ? { mergeable: true } : pull.mergeable === 'CONFLICTING' ? { mergeable: false } : {})
    };
}

// ── the adapter ──

interface GqlError { readonly type?: string; readonly message?: string }

const splitRepo = (repo: string): { owner: string; name: string } => {
    if (!isPullRepo(repo)) throw new PullProviderError('invalid', `"${repo}" is not an owner/name repo`);
    const [owner, name] = repo.split('/') as [string, string];
    return { owner, name };
};

/** GraphQL's endpoint for a REST base: `api.github.com` → `/graphql`, an Enterprise `…/api/v3` → `…/api/graphql`. */
export function githubGraphqlUrl(apiBase: string): string {
    const base = apiBase.replace(/\/+$/, '');
    return base.endsWith('/api/v3') ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`;
}

/** A GitHub `PullProvider` over `fetch`. */
export function createGitHubPullProvider(options: GitHubProviderOptions): PullProvider {
    const apiBase = (options.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, '');
    const graphqlUrl = githubGraphqlUrl(apiBase);
    const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    const now = options.now ?? Date.now;
    const listLimit = Math.max(1, Math.min(100, options.listLimit ?? 50));
    let lastWindow: PullRateLimit | undefined;

    const token = async (): Promise<string> => (typeof options.token === 'function' ? options.token() : options.token);

    const remember = (res: Response): void => {
        const remaining = Number(res.headers.get('x-ratelimit-remaining'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        if (res.headers.has('x-ratelimit-remaining') && Number.isFinite(remaining) && Number.isFinite(reset)) {
            const limit = Number(res.headers.get('x-ratelimit-limit'));
            lastWindow = { ...(Number.isFinite(limit) && res.headers.has('x-ratelimit-limit') ? { limit } : {}), remaining, resetAt: reset * 1000 };
        }
    };

    /** The retry time a throttled response names: `retry-after` seconds, else the lastWindow's reset, else a minute. */
    const retryAtOf = (res: Response): number => {
        const after = Number(res.headers.get('retry-after'));
        if (res.headers.has('retry-after') && Number.isFinite(after)) return now() + after * 1000;
        if (lastWindow && lastWindow.remaining === 0) return lastWindow.resetAt;
        return now() + 60_000;
    };

    const request = async (method: string, url: string, body?: unknown): Promise<{ res: Response; json: unknown }> => {
        if (lastWindow && lastWindow.remaining <= 0 && lastWindow.resetAt > now()) {
            throw new PullProviderError('rate-limited', `GitHub rate limit exhausted until ${new Date(lastWindow.resetAt).toISOString()}`, undefined, lastWindow.resetAt);
        }
        const headers: Record<string, string> = {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${await token()}`,
            'x-github-api-version': '2022-11-28'
        };
        if (body !== undefined) headers['content-type'] = 'application/json';
        let res: Response;
        try {
            res = await doFetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        } catch (error) {
            throw new PullProviderError('failed', `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        remember(res);
        const text = await res.text();
        let json: unknown;
        try {
            json = text ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        const message = (json as { message?: unknown } | undefined)?.message;
        const reason = typeof message === 'string' ? message : `HTTP ${res.status}`;
        if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
            throw new PullProviderError('rate-limited', `GitHub rate limit: ${reason}`, res.status, retryAtOf(res));
        }
        if (res.status === 401) throw new PullProviderError('unauthorized', `GitHub rejected the credential: ${reason}`, 401);
        return { res, json };
    };

    const fail = (res: Response, json: unknown, what: string): never => {
        const message = (json as { message?: unknown } | undefined)?.message;
        const reason = typeof message === 'string' ? message : `HTTP ${res.status}`;
        if (res.status === 403) throw new PullProviderError('forbidden', `${what}: ${reason}`, 403);
        if (res.status === 404) throw new PullProviderError('not-found', `${what}: ${reason}`, 404);
        if (res.status === 422) throw new PullProviderError('invalid', `${what}: ${reason}`, 422);
        throw new PullProviderError('failed', `${what}: ${reason}`, res.status);
    };

    /** A GraphQL call's `data`; with `allowMissing`, NOT_FOUND-only errors return the partial `data` (its missing nodes null). */
    const graphql = async <T>(query: string, variables: Record<string, unknown>, what: string, allowMissing = false): Promise<T | undefined> => {
        const { res, json } = await request('POST', graphqlUrl, { query, variables });
        if (!res.ok) return fail(res, json, what);
        const { data, errors } = (json ?? {}) as { data?: T | null; errors?: readonly GqlError[] };
        if (errors?.length) {
            if (errors.some((e) => e.type === 'RATE_LIMITED')) {
                throw new PullProviderError('rate-limited', `${what}: GitHub rate limit`, res.status, retryAtOf(res));
            }
            if (errors.every((e) => e.type === 'NOT_FOUND')) {
                if (allowMissing && data != null) return data;
                throw new PullProviderError('not-found', `${what}: ${errors[0]?.message ?? 'not found'}`, res.status);
            }
            if (errors.some((e) => e.type === 'FORBIDDEN')) throw new PullProviderError('forbidden', `${what}: ${errors[0]?.message ?? 'forbidden'}`, res.status);
            throw new PullProviderError('failed', `${what}: ${errors.map((e) => e.message ?? e.type).join('; ')}`, res.status);
        }
        if (data == null) throw new PullProviderError('failed', `${what}: GitHub returned no data`, res.status);
        return data;
    };

    type RepoData<K extends string, V> = { repository: { [key in K]: V } | null };
    type PullsPage = { nodes: readonly GqlPull[] };

    return {
        id: GITHUB_PROVIDER_ID,

        async get(repo, number) {
            const { owner, name } = splitRepo(repo);
            const data = await graphql<RepoData<'pullRequest', GqlPull | null>>(GITHUB_PULL_QUERY, { owner, name, number }, `GitHub ${repo}#${number}`, true);
            if (!data?.repository) throw new PullProviderError('not-found', `GitHub ${repo}: no such repository`);
            const pull = data.repository.pullRequest;
            return pull ? pullFromGitHub(repo, pull) : undefined;
        },

        async listOpen(repo) {
            const { owner, name } = splitRepo(repo);
            const data = await graphql<RepoData<'pullRequests', PullsPage>>(GITHUB_OPEN_QUERY, { owner, name, first: listLimit }, `GitHub ${repo} open pull requests`);
            if (!data?.repository) throw new PullProviderError('not-found', `GitHub ${repo}: no such repository`);
            return data.repository.pullRequests.nodes.map((pull) => pullFromGitHub(repo, pull));
        },

        async forBranch(repo, branch) {
            const { owner, name } = splitRepo(repo);
            const data = await graphql<RepoData<'pullRequests', PullsPage>>(GITHUB_BRANCH_QUERY, { owner, name, branch }, `GitHub ${repo} pull requests for ${branch}`);
            if (!data?.repository) throw new PullProviderError('not-found', `GitHub ${repo}: no such repository`);
            const nodes = data.repository.pullRequests.nodes;
            const pick = nodes.find((p) => p.state === 'OPEN') ?? nodes[0];
            return pick ? pullFromGitHub(repo, pick) : undefined;
        },

        async merge(repo, number, method: PullMergeMethod, mergeOptions?: PullMergeOptions): Promise<PullMergeResult> {
            splitRepo(repo);
            const body: Record<string, unknown> = { merge_method: method };
            if (mergeOptions?.subject !== undefined) body.commit_title = mergeOptions.subject;
            if (mergeOptions?.body !== undefined) body.commit_message = mergeOptions.body;
            const what = `GitHub merge ${repo}#${number}`;
            const { res, json } = await request('PUT', `${apiBase}/repos/${repo}/pulls/${number}/merge`, body);
            const out = (json ?? {}) as { merged?: boolean; sha?: string; message?: string };
            // 405: not mergeable (conflicts, a required check, a review); 409: the head moved — answers, not failures.
            if (res.status === 405 || res.status === 409) return { merged: false, ...(out.message ? { message: out.message } : {}) };
            if (!res.ok) return fail(res, json, what);
            return { merged: out.merged === true, ...(out.sha ? { sha: out.sha } : {}), ...(out.message ? { message: out.message } : {}) };
        },

        async reply(thread, body) {
            if (!thread) throw new PullProviderError('invalid', 'a review thread id is required');
            await graphql(GITHUB_REPLY_MUTATION, { thread, body }, `GitHub reply on ${thread}`);
        },

        async openIssue(repo, title, body): Promise<PullIssueRef> {
            splitRepo(repo);
            const { res, json } = await request('POST', `${apiBase}/repos/${repo}/issues`, { title, body });
            if (!res.ok) return fail(res, json, `GitHub open issue in ${repo}`);
            const out = json as { number: number; html_url: string };
            return { number: out.number, url: out.html_url };
        },

        rateLimit: () => lastWindow
    };
}
