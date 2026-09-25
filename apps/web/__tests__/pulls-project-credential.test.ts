/**
 * The autopilot's merge and the poll read with the project's GitHub credential (#915, over #840's `projectPullToken`):
 * a project whose own `github` connector has a secret merges with that token, not the workspace's `github-token`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId, PullRequest, WorkspaceId } from '@agentic/core';
import { mcpConnectorSetup } from '@agentic/mcp';
import { AgentActor, ASK_ON_MERGE, AuditActor, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey, Workspace, workspaceKey } from '@agentic/platform';
import { gitFeatureManifest, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { githubPullMerger, githubPullSources } from '../src/actors/pulls';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const REPO = 'octo/agentic';
const agentId = 'agent_forge' as AgentId;

const pr: PullRequest = {
    provider: 'github',
    repo: REPO,
    number: 7,
    title: 'Ship it',
    url: `https://github.com/${REPO}/pull/7`,
    head: 'chat/7',
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
    app = testActorApp([Registry, AuditActor, Workspace, AgentActor]);
    return app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));
const ws = () => app.as(owner).actor(Workspace, workspaceKey(WS));

/** A GitHub MCP connector `id` (conduit id `github`) whose bearer is `value`. */
async function githubConnector(id: string, value: string): Promise<void> {
    const setup = mcpConnectorSetup({ id, name: id, transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', secret: `${id}.token` });
    await reg().register(setup.manifest, { enabled: true, grant: 'declared' });
    await reg().putConnector({ ...setup.connector, connector: 'github' });
    await reg().setSecret(`${id}.token`, value);
}

/** A fetch that records the bearer each call carries and answers a merge / an empty list. */
function recordingFetch(auths: string[]): typeof fetch {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
        auths.push(new Headers(init?.headers).get('authorization') ?? '');
        const body = String(url).endsWith('/merge') ? { merged: true, sha: 'abc' } : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
}

describe('per-project GitHub credential', () => {
    it("the autopilot's merge uses the project connector's token over the workspace github-token", async () => {
        await reg().setSecret(GITHUB_TOKEN_SECRET, 'tok_workspace');
        await githubConnector('gh-agentic', 'tok_project');
        const project = await ws().upsertProject({ name: 'Agentic', connectors: [{ id: 'gh-agentic' }] });
        const bare = await ws().upsertProject({ name: 'Other' });

        const auths: string[] = [];
        const fetchImpl = recordingFetch(auths);
        expect(await githubPullMerger(actors, { workspaceId: WS, projectId: project.id }, fetchImpl)({ agentId, rule: ASK_ON_MERGE, pr })).toEqual({ merged: true });
        expect(auths.at(-1)).toMatch(/tok_project/);

        // A project without its own connector merges with the workspace fallback.
        expect(await githubPullMerger(actors, { workspaceId: WS, projectId: bare.id }, fetchImpl)({ agentId, rule: ASK_ON_MERGE, pr })).toEqual({ merged: true });
        expect(auths.at(-1)).toMatch(/tok_workspace/);
    });

    it('the poll opens GitHub with the project connector token too', async () => {
        await githubConnector('gh-agentic', 'tok_project');
        const project = await ws().upsertProject({ name: 'Agentic', connectors: [{ id: 'gh-agentic' }] });
        const auths: string[] = [];
        const source = await githubPullSources(actors, recordingFetch(auths)).open({ workspaceId: WS, projectId: project.id, provider: 'github', repo: REPO });
        expect(source).toBeDefined();
        // Only the bearer matters here; the fake's empty answer is not a GraphQL body.
        await source!.listOpen(REPO).catch(() => undefined);
        expect(auths.length).toBeGreaterThan(0);
        expect(auths.every((a) => a.includes('tok_project'))).toBe(true);
    });
});
