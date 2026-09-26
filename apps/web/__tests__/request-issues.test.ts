/**
 * #932: the Requests actor's issue port opens the issue in the repo the project's git origin names, with the project's
 * GitHub credential (#840); a project without Git, with a non-GitHub origin, or without a token opens nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectId, ProjectRecord, WorkspaceId } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { AuditActor, defineRegistry, generateWorkspaceKek, importWorkspaceKek, registryKey } from '@agentic/platform';
import { gitFeatureManifest, GIT_FEATURE_ID, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { githubRequestIssues } from '../src/actors/pulls';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [gitFeatureManifest] });

/** The workspace's projects, as the port reads them (`projects()`): a GitHub origin, a GitLab one, Git off. */
const project = (id: string, features: ProjectRecord['features']): ProjectRecord =>
    ({ id: id as ProjectId, name: id, members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features }) as unknown as ProjectRecord;
const PROJECTS: ProjectRecord[] = [
    project('prj_gh', { [GIT_FEATURE_ID]: { origin: 'https://github.com/octo/signalx.git' } }),
    project('prj_gl', { [GIT_FEATURE_ID]: { origin: 'https://gitlab.com/octo/x.git' } }),
    project('prj_bare', {})
];
const FakeWorkspace = defineActor({ type: 'FakeWorkspace', allowAnonymous: true, state: () => ({}), methods: () => ({ async projects() { return PROJECTS; } }) });
const actors = { registry: () => Registry, workspace: () => FakeWorkspace };
let app: TestActorApp;
beforeEach(() => {
    app = testActorApp([Registry, AuditActor, FakeWorkspace]);
    return app.start();
});
afterEach(() => app.stop());

const reg = () => app.as(owner).actor(Registry, registryKey(WS));

interface Call {
    readonly url: string;
    readonly auth: string;
    readonly body: unknown;
}

/** A fake GitHub: answers an issue create with #41. */
function fakeGitHub(calls: Call[]): typeof fetch {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(JSON.stringify({ number: 41, html_url: 'https://github.com/octo/signalx/issues/41' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
}

const issue = (projectId: string) => ({ workspaceId: WS, projectId: projectId as ProjectId, projectName: 'signalx', requestId: 'req_1', itemN: 1, title: 'Fix nested batch()', body: 'details' });

describe('githubRequestIssues (#932)', () => {
    it("opens the issue in the origin's repo with the project's GitHub token", async () => {
        await reg().setSecret(GITHUB_TOKEN_SECRET, 'tok_workspace');
        const calls: Call[] = [];
        expect(await githubRequestIssues(actors, fakeGitHub(calls)).open(issue('prj_gh'))).toEqual({ url: 'https://github.com/octo/signalx/issues/41', number: 41 });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toMatch(/\/repos\/octo\/signalx\/issues$/);
        expect(calls[0]!.auth).toMatch(/tok_workspace/);
        expect(calls[0]!.body).toEqual({ title: 'Fix nested batch()', body: 'details' });
    });

    it('opens nothing without Git, with a non-GitHub origin, or without a token', async () => {
        const calls: Call[] = [];
        const port = githubRequestIssues(actors, fakeGitHub(calls));
        expect(await port.open(issue('prj_bare'))).toBeNull();
        expect(await port.open(issue('prj_gl'))).toBeNull();
        expect(await port.open(issue('prj_gone'))).toBeNull();
        // A GitHub origin with no token anywhere: nothing to open with.
        expect(await port.open(issue('prj_gh'))).toBeNull();
        expect(calls).toHaveLength(0);
    });
});
