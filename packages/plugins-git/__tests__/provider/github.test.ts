/**
 * The GitHub pull request adapter (#741, PRJ-08) against recorded GitHub responses: `pull-merged.json` and
 * `branch.json` are andtii/agentic#768 as GitHub's GraphQL API answered the adapter's own query;
 * `pull-missing.json` is its answer for a PR number that does not exist; `pull-blocked.json` is #768 re-cut as an
 * open PR (conflicts, a failing, a running and a queued check, a pending status, review required, one thread
 * resolved) to cover every blocker. The REST answers (merge, issues, errors) follow GitHub's documented shapes.
 */
import { pullBlockers } from '@agentic/core';
import { describe, expect, it } from 'vitest';

import { GITHUB_PULL_QUERY, GITHUB_REPLY_MUTATION, PullProviderError, createGitHubPullProvider, githubGraphqlUrl } from '../../src/provider/index';
import blocked from './fixtures/pull-blocked.json';
import branch from './fixtures/branch.json';
import merged from './fixtures/pull-merged.json';
import missing from './fixtures/pull-missing.json';

interface Recorded {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
}

interface Call {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly body?: { query?: string; variables?: Record<string, unknown> } & Record<string, unknown>;
}

const NOW = 1_790_336_000_000;

/** A fetch that answers each call with the next recorded response and keeps what was asked. */
function replay(...responses: Recorded[]) {
    const calls: Call[] = [];
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        calls.push({
            method: init?.method ?? 'GET',
            url: String(input),
            headers: { ...(init?.headers as Record<string, string>) },
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {})
        });
        const next = responses.shift();
        if (!next) throw new Error(`unexpected call ${init?.method} ${String(input)}`);
        return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers });
    };
    const provider = createGitHubPullProvider({ token: 'ghs_secret', fetch, now: () => NOW });
    return { provider, calls };
}

describe('GitHub pull provider — reads', () => {
    it('maps a merged PR: checks with durations, review threads with replies, state and sizes', async () => {
        const { provider, calls } = replay(merged);
        const pr = await provider.get('andtii/agentic', 768);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/graphql', headers: { authorization: 'Bearer ghs_secret' } });
        expect(calls[0]!.body).toEqual({ query: GITHUB_PULL_QUERY, variables: { owner: 'andtii', name: 'agentic', number: 768 } });
        expect(pr).toMatchObject({
            provider: 'github',
            repo: 'andtii/agentic',
            number: 768,
            url: 'https://github.com/andtii/agentic/pull/768',
            head: '724-core-contract',
            base: 'main',
            state: 'merged',
            additions: 358,
            deletions: 6,
            files: 9,
            openedBy: 'andtii',
            openedAt: Date.parse('2026-09-25T11:33:34Z'),
            mergedAt: Date.parse('2026-09-25T11:39:23Z'),
            review: { state: 'none', reviewers: [] }
        });
        expect(pr!.draft).toBeUndefined();
        expect(pr!.checks.find((c) => c.name === 'static')).toEqual({ name: 'static', state: 'passed', durationMs: 32_000 });
        expect(pr!.checks.find((c) => c.name === 'automerge')?.state).toBe('skipped');
        expect(pr!.checks.every((c) => c.state === 'passed' || c.state === 'skipped')).toBe(true);
        expect(pr!.review.threads).toHaveLength(3);
        expect(pr!.review.threads[0]).toMatchObject({
            id: 'PRRT_kwDOUeZuAc6l-2bm',
            author: 'copilot-pull-request-reviewer',
            path: 'packages/core/src/project-ui.ts',
            line: 39,
            state: 'open',
            reply: 'Fixed in cdfcbc5a.'
        });
        expect(pullBlockers(pr!)).toEqual([]);
    });

    it('reads every blocker: conflicts, failing, running and queued checks, pending statuses, open threads, requested reviewers', async () => {
        const { provider } = replay(blocked);
        const pr = await provider.get('andtii/agentic', 768);
        expect(pr!.state).toBe('open');
        expect(pr!.mergedAt).toBeUndefined();
        expect(pr!.mergeable).toBe(false);
        expect(pr!.checks.find((c) => c.name === 'static')).toMatchObject({ state: 'failed', detail: 'oxlint: 2 errors' });
        expect(pr!.checks.find((c) => c.name === 'unit (1)')).toEqual({ name: 'unit (1)', state: 'running' });
        expect(pr!.checks.find((c) => c.name === 'unit (2)')?.state).toBe('queued');
        expect(pr!.checks.find((c) => c.name === 'codecov/patch')).toEqual({ name: 'codecov/patch', state: 'running', detail: 'Measuring bundles' });
        expect(pr!.review).toMatchObject({ state: 'requested', reviewers: ['copilot-pull-request-reviewer', 'core'] });
        expect(pr!.review.threads.map((t) => t.state)).toEqual(['resolved', 'open', 'open']);
        expect(pullBlockers(pr!)).toEqual([
            'conflicts with the base',
            '1 failing check',
            '3 checks running',
            '2 open threads',
            'copilot-pull-request-reviewer, core have not approved'
        ]);
    });

    it('mergeable is undefined while GitHub is still computing it', async () => {
        const pull = { ...blocked.body.data.repository.pullRequest, mergeable: 'UNKNOWN' };
        const { provider } = replay({ status: 200, body: { data: { repository: { pullRequest: pull } } } });
        expect((await provider.get('andtii/agentic', 768))!.mergeable).toBeUndefined();
    });

    it('a PR number the repo does not have is undefined; a repo that does not exist is not-found', async () => {
        expect(await replay(missing).provider.get('andtii/agentic', 999999)).toBeUndefined();
        const noRepo = { status: 200, body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'andtii/nope'." }] } };
        await expect(replay(noRepo).provider.get('andtii/nope', 1)).rejects.toMatchObject({ code: 'not-found' });
    });

    it('forBranch picks the PR whose head is the branch; undefined when none', async () => {
        const { provider, calls } = replay(branch, { status: 200, body: { data: { repository: { pullRequests: { nodes: [] } } } } });
        const pr = await provider.forBranch('andtii/agentic', '724-core-contract');
        expect(calls[0]!.body!.variables).toEqual({ owner: 'andtii', name: 'agentic', branch: '724-core-contract' });
        expect(pr).toMatchObject({ number: 768, head: '724-core-contract', state: 'merged' });
        expect(await provider.forBranch('andtii/agentic', 'nothing-here')).toBeUndefined();
    });

    it('forBranch prefers the open PR over a newer closed one', async () => {
        const base = merged.body.data.repository.pullRequest;
        const nodes = [{ ...base, number: 801, state: 'CLOSED' }, { ...base, number: 800, state: 'OPEN', mergedAt: null }];
        const { provider } = replay({ status: 200, body: { data: { repository: { pullRequests: { nodes } } } } });
        expect((await provider.forBranch('andtii/agentic', '724-core-contract'))!.number).toBe(800);
    });

    it('listOpen maps every open PR', async () => {
        const pull = blocked.body.data.repository.pullRequest;
        const { provider, calls } = replay({ status: 200, body: { data: { repository: { pullRequests: { nodes: [pull, { ...pull, number: 767 }] } } } } });
        const prs = await provider.listOpen('andtii/agentic');
        expect(calls[0]!.body!.variables).toEqual({ owner: 'andtii', name: 'agentic', first: 50 });
        expect(prs.map((p) => [p.number, p.state])).toEqual([[768, 'open'], [767, 'open']]);
    });

    it('refuses a repo that is not owner/name before calling', async () => {
        const { provider, calls } = replay();
        await expect(provider.get('not-a-repo', 1)).rejects.toMatchObject({ code: 'invalid' });
        await expect(provider.listOpen('a/b/c')).rejects.toMatchObject({ code: 'invalid' });
        expect(calls).toHaveLength(0);
    });
});

describe('GitHub pull provider — actions', () => {
    it('merge PUTs the method and the commit message', async () => {
        const { provider, calls } = replay({ status: 200, body: { sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', merged: true, message: 'Pull Request successfully merged' } });
        const out = await provider.merge('andtii/agentic', 768, 'squash', { subject: 'core: x (#768)', body: 'Closes #724.' });
        expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repos/andtii/agentic/pulls/768/merge' });
        expect(calls[0]!.body).toEqual({ merge_method: 'squash', commit_title: 'core: x (#768)', commit_message: 'Closes #724.' });
        expect(out).toEqual({ merged: true, sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', message: 'Pull Request successfully merged' });
    });

    it('a PR that cannot merge (405) or whose head moved (409) answers merged: false with GitHub’s reason', async () => {
        const { provider } = replay(
            { status: 405, body: { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' } },
            { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }
        );
        expect(await provider.merge('andtii/agentic', 768, 'merge')).toEqual({ merged: false, message: 'Pull Request is not mergeable' });
        expect(await provider.merge('andtii/agentic', 768, 'rebase')).toEqual({ merged: false, message: 'Head branch was modified. Review and try the merge again.' });
    });

    it('reply posts the thread reply mutation', async () => {
        const { provider, calls } = replay({ status: 200, body: { data: { addPullRequestReviewThreadReply: { comment: { id: 'PRRC_1' } } } } });
        await provider.reply('PRRT_kwDOUeZuAc6l-2bm', 'Fixed in abc123.');
        expect(calls[0]!.body).toEqual({ query: GITHUB_REPLY_MUTATION, variables: { thread: 'PRRT_kwDOUeZuAc6l-2bm', body: 'Fixed in abc123.' } });
    });

    it('openIssue posts the issue and returns its number and url', async () => {
        const { provider, calls } = replay({ status: 201, body: { number: 812, html_url: 'https://github.com/andtii/agentic/issues/812', title: 'follow-up' } });
        expect(await provider.openIssue('andtii/agentic', 'follow-up', 'details')).toEqual({ number: 812, url: 'https://github.com/andtii/agentic/issues/812' });
        expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/andtii/agentic/issues', body: { title: 'follow-up', body: 'details' } });
    });

    it('a token function is called per request', async () => {
        let n = 0;
        const calls: string[] = [];
        const provider = createGitHubPullProvider({
            token: async () => `t${++n}`,
            fetch: async (_url, init) => {
                calls.push((init!.headers as Record<string, string>).authorization!);
                return new Response(JSON.stringify(missing.body), { status: 200 });
            }
        });
        await provider.get('andtii/agentic', 1);
        await provider.get('andtii/agentic', 2);
        expect(calls).toEqual(['Bearer t1', 'Bearer t2']);
    });
});

describe('GitHub pull provider — errors and rate limits', () => {
    it('remembers the rate-limit window GitHub reports', async () => {
        const { provider } = replay(merged);
        expect(provider.rateLimit()).toBeUndefined();
        await provider.get('andtii/agentic', 768);
        expect(provider.rateLimit()).toEqual({ limit: 5000, remaining: Number(merged.headers['x-ratelimit-remaining']), resetAt: Number(merged.headers['x-ratelimit-reset']) * 1000 });
    });

    it('a throttled response is rate-limited with its retry time, and an exhausted window refuses calls until it resets', async () => {
        const reset = NOW / 1000 + 600;
        const { provider, calls } = replay({ status: 403, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded' } });
        const first = await provider.get('andtii/agentic', 768).catch((e: unknown) => e);
        expect(first).toBeInstanceOf(PullProviderError);
        expect(first).toMatchObject({ code: 'rate-limited', status: 403, retryAt: reset * 1000 });
        await expect(provider.listOpen('andtii/agentic')).rejects.toMatchObject({ code: 'rate-limited', retryAt: reset * 1000 });
        expect(calls).toHaveLength(1);
    });

    it('a secondary limit names retry-after; 429 and GraphQL RATE_LIMITED are rate-limited too', async () => {
        const { provider } = replay(
            { status: 403, headers: { 'retry-after': '30' }, body: { message: 'You have exceeded a secondary rate limit.' } },
            { status: 429, body: { message: 'Too many requests' } },
            { status: 200, body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } }
        );
        await expect(provider.get('andtii/agentic', 1)).rejects.toMatchObject({ code: 'rate-limited', retryAt: NOW + 30_000 });
        await expect(provider.get('andtii/agentic', 1)).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
        await expect(provider.get('andtii/agentic', 1)).rejects.toMatchObject({ code: 'rate-limited' });
    });

    it('401, 403, 404 and 422 map to codes, and no error carries the token', async () => {
        const { provider } = replay(
            { status: 401, body: { message: 'Bad credentials' } },
            { status: 403, body: { message: 'Resource not accessible by integration' } },
            { status: 404, body: { message: 'Not Found' } },
            { status: 422, body: { message: 'Validation Failed' } },
            { status: 502, body: { message: 'Bad Gateway' } }
        );
        const errors = [
            await provider.get('andtii/agentic', 1).catch((e: PullProviderError) => e),
            await provider.merge('andtii/agentic', 1, 'squash').catch((e: PullProviderError) => e),
            await provider.openIssue('andtii/agentic', 't', 'b').catch((e: PullProviderError) => e),
            await provider.openIssue('andtii/agentic', '', 'b').catch((e: PullProviderError) => e),
            await provider.listOpen('andtii/agentic').catch((e: PullProviderError) => e)
        ] as PullProviderError[];
        expect(errors.map((e) => e.code)).toEqual(['unauthorized', 'forbidden', 'not-found', 'invalid', 'failed']);
        for (const e of errors) expect(e.message).not.toContain('ghs_secret');
    });

    it('a network failure is failed', async () => {
        const provider = createGitHubPullProvider({ token: 't', fetch: async () => { throw new TypeError('fetch failed'); } });
        await expect(provider.get('andtii/agentic', 1)).rejects.toMatchObject({ code: 'failed', message: 'GitHub request failed: fetch failed' });
    });
});

describe('githubGraphqlUrl', () => {
    it('maps api.github.com and an Enterprise base', () => {
        expect(githubGraphqlUrl('https://api.github.com')).toBe('https://api.github.com/graphql');
        expect(githubGraphqlUrl('https://ghe.example.com/api/v3/')).toBe('https://ghe.example.com/api/graphql');
    });
});
