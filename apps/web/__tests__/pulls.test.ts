/**
 * The git feature's pull requests wired into the Pulls actor (#793): `githubPullSources` opens the GitHub adapter
 * over the workspace's `github-token` secret (the git plugin's grant), and `pullsPlacement` watches the repo a
 * project's origin names and links a chat's worktree branch to its task.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatId, ProjectId, ProjectRecord, PullRequest, TaskId, WorkspaceId } from '@agentic/core';
import { AuditActor, definePullsActor, defineRegistry, generateWorkspaceKek, importWorkspaceKek, pullsKey, registryKey, TaskActor, Workspace, type PullSource } from '@agentic/platform';
import { gitBranchFor, gitFeatureManifest, GIT_FEATURE_ID, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { testActorApp, userPrincipal, type TestActorApp } from '../../../packages/platform/src/testing/index';
import { githubPullSources, pullsPlacement } from '../src/actors/pulls';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const PROJECT = 'project_1' as ProjectId;
const CHAT = 'chat_ab12cd34ef' as ChatId;
const TASK = 'task_1' as TaskId;
const REPO = 'octo/agentic';

const pr = (number: number, head: string): PullRequest => ({
    provider: 'github',
    repo: REPO,
    number,
    title: `PR ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    head,
    base: 'main',
    state: 'open',
    additions: 1,
    deletions: 0,
    files: 1,
    openedBy: 'forge',
    openedAt: 0,
    checks: [],
    review: { state: 'none', reviewers: [], threads: [] }
});

class FakeSource implements PullSource {
    readonly prs = new Map<number, PullRequest>();
    lists = 0;
    async get(_repo: string, number: number): Promise<PullRequest | undefined> {
        return this.prs.get(number);
    }
    async listOpen(): Promise<PullRequest[]> {
        this.lists++;
        return [...this.prs.values()];
    }
}

const projectOf = (features: ProjectRecord['features']): ProjectRecord => ({ id: PROJECT, name: 'Agentic', members: { agents: [], users: [] } as unknown as ProjectRecord['members'], folders: {}, connectors: [], features, createdAt: 0, updatedAt: 0 });

const KEK = generateWorkspaceKek();
const Registry = defineRegistry({ kek: () => importWorkspaceKek(KEK), catalogue: [gitFeatureManifest] });
let source: FakeSource;
let Pulls: ReturnType<typeof definePullsActor>;
let app: TestActorApp;

beforeEach(() => {
    source = new FakeSource();
    Pulls = definePullsActor({ sources: { open: () => source } });
    app = testActorApp([Registry, AuditActor, TaskActor, Workspace, Pulls]);
    return app.start();
});
afterEach(() => app.stop());

const ref = { workspaceId: WS, projectId: PROJECT, provider: 'github', repo: REPO };
const pulls = () => app.as(owner).actor(Pulls, pullsKey(WS, PROJECT));

describe('githubPullSources', () => {
    it('has no source until the workspace stores a github-token, then reads GitHub with it', async () => {
        expect(await githubPullSources({ registry: () => Registry, workspace: () => Workspace }).open(ref)).toBeUndefined();
        await app.as(owner).actor(Registry, registryKey(WS)).setSecret(GITHUB_TOKEN_SECRET, 'ghp_secret123');
        const auth: string[] = [];
        const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            auth.push(new Headers(init?.headers).get('authorization') ?? '');
            return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const opened = await githubPullSources({ registry: () => Registry, workspace: () => Workspace }, fetchImpl).open(ref);
        expect(opened).toBeDefined();
        await opened!.get(REPO, 7).catch(() => undefined);
        expect(auth.length).toBeGreaterThan(0);
        expect(auth[0]).toContain('ghp_secret123');
        // Another provider has no adapter.
        expect(await githubPullSources({ registry: () => Registry, workspace: () => Workspace }).open({ ...ref, provider: 'gitlab' })).toBeUndefined();
    });
});

describe('pullsPlacement', () => {
    const placed = (project: ProjectRecord, extra: { chatId?: ChatId; cwd?: string } = {}) => pullsPlacement(() => Pulls)({ workspaceId: WS, project, taskId: TASK, ...extra });

    it('watches the repo the origin names once, and leaves a project without Git (or without a readable origin) alone', async () => {
        await placed(projectOf({}));
        await placed(projectOf({ [GIT_FEATURE_ID]: { origin: 'https://example.com/o/r.git' } }));
        expect((await pulls().get()).repo).toBeUndefined();

        await placed(projectOf({ [GIT_FEATURE_ID]: { origin: `git@github.com:${REPO}.git` } }));
        expect((await pulls().get()).repo).toEqual({ provider: 'github', repo: REPO });
        const lists = source.lists;
        await placed(projectOf({ [GIT_FEATURE_ID]: { origin: `https://github.com/${REPO}.git` } }));
        expect(source.lists).toBe(lists); // same repo: no second watch, no forced poll
    });

    it("links a chat's worktree branch to its task, so the PR opened from it carries the task", async () => {
        const branch = gitBranchFor(CHAT);
        source.prs.set(9, pr(9, branch));
        await placed(projectOf({ [GIT_FEATURE_ID]: { origin: `https://github.com/${REPO}`, worktreePerChat: true } }), { chatId: CHAT, cwd: 'C:\\src\\agentic' });
        const view = await pulls().poll();
        expect(view.pulls.find((p) => p.number === 9)).toMatchObject({ head: branch, chatId: CHAT, taskId: TASK });
    });

    it('links nothing when the project has no worktree per chat', async () => {
        source.prs.set(9, pr(9, gitBranchFor(CHAT)));
        await placed(projectOf({ [GIT_FEATURE_ID]: { origin: `https://github.com/${REPO}` } }), { chatId: CHAT, cwd: '/src/agentic' });
        const view = await pulls().poll();
        expect(view.pulls.find((p) => p.number === 9)?.chatId).toBeUndefined();
    });
});
