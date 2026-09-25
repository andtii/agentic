/**
 * The autopilot's merge (#820): `githubPullMerger` squashes the PR through the GitHub adapter with the workspace's
 * `github-token`; no token or another provider is "not merged" with why, and GitHub's refusal is the reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, ProjectId, PullRequest, WorkspaceId } from '@agentic/core';
import { ASK_ON_MERGE, AuditActor, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, Workspace } from '@agentic/platform';
import { gitFeatureManifest, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { githubPullMerger } from '../src/actors/pulls';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const ref = { workspaceId: WS, projectId: 'project_1' as ProjectId };
const REPO = 'octo/agentic';
const agentId = 'agent_forge' as AgentId;

const pr: PullRequest = {
    provider: 'github',
    repo: REPO,
    number: 12,
    title: 'Add autopilot',
    url: `https://github.com/${REPO}/pull/12`,
    head: 'chat/12',
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'approved', reviewers: [], threads: [] }
};

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [gitFeatureManifest] });
const actors = { registry: () => Registry, workspace: () => Workspace };
let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([Registry, AuditActor, Workspace]);
    return app.start();
});
afterEach(() => app.stop());

describe('githubPullMerger', () => {
    it('no token or another provider: not merged, with why', async () => {
        const merge = githubPullMerger(actors, ref);
        expect(await merge({ agentId, rule: ASK_ON_MERGE, pr })).toEqual({ merged: false, reason: 'no GitHub token for the git feature' });
        expect(await merge({ agentId, rule: ASK_ON_MERGE, pr: { ...pr, provider: 'gitlab' } })).toEqual({ merged: false, reason: 'no gitlab adapter merges pull requests' });
    });

    it('squashes through GitHub with the token; a refusal comes back as the reason', async () => {
        await app.as(owner).actor(Registry, registryKey(WS)).setSecret(GITHUB_TOKEN_SECRET, 'ghp_secret123');
        const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
        let status = 200;
        const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization') ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined });
            const json = status === 200 ? { merged: true, sha: 'abc' } : { message: 'Head branch was modified' };
            return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const merge = githubPullMerger(actors, ref, fetchImpl);
        expect(await merge({ agentId, rule: ASK_ON_MERGE, pr })).toEqual({ merged: true });
        expect(calls[0]).toMatchObject({ url: `https://api.github.com/repos/${REPO}/pulls/12/merge`, method: 'PUT', body: { merge_method: 'squash', commit_title: 'Add autopilot (#12)' } });
        expect(calls[0]!.auth).toMatch(/ghp_secret123/);
        status = 409;
        expect(await merge({ agentId, rule: ASK_ON_MERGE, pr })).toEqual({ merged: false, reason: 'Head branch was modified' });
    });
});
