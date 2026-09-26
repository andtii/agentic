/**
 * The git feature's pull requests, wired into the Pulls actor (#793; PRJ-08, PRJ-10).
 *
 * - `githubPullSources`: the actor's `PullSourcePort` — the GitHub adapter (`@agentic/plugins-git/provider`, its own
 *   entry so the feature plugin's bundle stays small) over the project's GitHub credential (#840, `projectPullToken`):
 *   the project's `github` connector, else the workspace's, else the workspace's `github-token` secret under the git
 *   plugin's `secret:github-token` grant.
 * - `pullsPlacement`: the router's `placed` hook — a task placed in a project with Git on watches the repo its
 *   `origin` names (`Pulls.watch`, once per repo), and a chat with a worktree of its own links its branch to the task
 *   (`Pulls.linkBranch`), so the PR the agent opens from it waits the task and completes it on merge. The branch is
 *   recorded on the task too (`Task.note`, #937), so its index row carries it before any PR exists.
 * - `pullsAutopilot`: the actor's autopilot port (#820) — turns in the PR's chat and Inbox rows from the platform's
 *   `chatAutopilotPort`, the merge from `githubPullMerger`: a squash through the git feature's `PullProvider.merge`
 *   with the same per-project token (#915), only ever after the approval rule `ask on merge` was answered yes (`Pulls.answerMerge`).
 * - `githubRequestIssues`: the Requests actor's issue port (#932) — an accept with "open GitHub issue" opens it in the
 *   repo the project's git `origin` names, through `PullProvider.openIssue` with the same per-project token.
 */
import { asPrincipal, chatAutopilotPort, projectPullToken, pullsKey, TaskActor, taskKey, tokenPullSources, userPrincipal, workspaceKey, type AutopilotPort, type RequestIssuePort, type PullLink, type PullsAutopilotPort, type PullsRepo, type PullSourcePort, type PullsView, type ProjectPlacement } from '@agentic/platform';
import { configDefaults, enabledProjectFeatures, type ProjectId, type ProjectRecord, type WorkspaceId } from '@agentic/core';
import { chatWorktreeFor, gitProjectSettings, GIT_FEATURE_ID, GITHUB_TOKEN_SECRET } from '@agentic/plugins-git';
import { createGitHubPullProvider, pullRepoOfOrigin } from '@agentic/plugins-git/provider';
import { actor, type AnyActorDefinition } from '@sigx/actors';

/** Where a project's GitHub credential is looked up: the Registry (secrets, connectors) and the Workspace (projects). */
export interface PullCredentialActors {
    readonly registry: () => AnyActorDefinition;
    readonly workspace: () => AnyActorDefinition;
}

/** The project's GitHub token (#840): its connector, the workspace's, then the git feature's `github-token`. */
const gitPullToken = (actors: PullCredentialActors): ReturnType<typeof projectPullToken> =>
    projectPullToken({ registry: actors.registry, workspace: actors.workspace, pluginId: GIT_FEATURE_ID, secret: GITHUB_TOKEN_SECRET });

/** The Pulls port over GitHub, with the project's GitHub credential (`projectPullToken`). */
export function githubPullSources(actors: PullCredentialActors, fetchImpl?: typeof fetch): PullSourcePort {
    return tokenPullSources({
        adapters: { github: (token) => createGitHubPullProvider({ token, ...(fetchImpl ? { fetch: fetchImpl } : {}) }) },
        token: gitPullToken(actors)
    });
}

/** Whose autopilot: the Pulls actor's workspace and project. */
export interface AutopilotRef {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
}

/**
 * The autopilot's merge (#820): a squash of the PR through the GitHub adapter with the project's GitHub credential
 * (#915, the same lookup the poll reads with).
 * No adapter for the PR's provider, or no token → not merged, with why; the provider's own refusal (not mergeable,
 * the head moved) comes back as its reason.
 */
export function githubPullMerger(actors: PullCredentialActors, ref: AutopilotRef, fetchImpl?: typeof fetch): AutopilotPort['merge'] {
    const token = gitPullToken(actors);
    return async ({ pr }) => {
        if (pr.provider !== 'github') return { merged: false, reason: `no ${pr.provider} adapter merges pull requests` };
        const secret = await token({ ...ref, provider: pr.provider, repo: pr.repo });
        if (!secret) return { merged: false, reason: 'no GitHub token for the git feature' };
        const provider = createGitHubPullProvider({ token: secret, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
        const out = await provider.merge(pr.repo, pr.number, 'squash', { subject: `${pr.title} (#${pr.number})` });
        return { merged: out.merged, ...(out.message ? { reason: out.message } : {}) };
    };
}

/**
 * The Requests actor's issue port (#932): the issue opens in the GitHub repo the project's git `origin` names, with the
 * project's GitHub credential (#840). A project without Git on, a non-GitHub origin, or no token → `null` (nothing opened).
 */
export function githubRequestIssues(actors: PullCredentialActors, fetchImpl?: typeof fetch): RequestIssuePort {
    const token = gitPullToken(actors);
    return {
        async open({ workspaceId, projectId, title, body }) {
            const context = asPrincipal(userPrincipal(workspaceId, workspaceId));
            const workspace = actor(actors.workspace(), workspaceKey(workspaceId)).with({ context }) as unknown as { projects(): Promise<readonly ProjectRecord[]> };
            const project = (await workspace.projects()).find((p) => p.id === projectId);
            if (!project || !enabledProjectFeatures(project).includes(GIT_FEATURE_ID)) return null;
            const origin = { ...configDefaults(gitProjectSettings), ...project.features[GIT_FEATURE_ID] }['origin'];
            const ref = typeof origin === 'string' ? pullRepoOfOrigin(origin) : undefined;
            if (ref?.provider !== 'github') return null;
            const secret = await token({ workspaceId, projectId, provider: ref.provider, repo: ref.repo });
            if (!secret) return null;
            const issue = await createGitHubPullProvider({ token: secret, ...(fetchImpl ? { fetch: fetchImpl } : {}) }).openIssue(ref.repo, title, body);
            return { url: issue.url, number: issue.number };
        }
    };
}

export interface PullsAutopilotOptions {
    readonly routing: () => AnyActorDefinition;
    readonly inbox: () => AnyActorDefinition;
    readonly registry: () => AnyActorDefinition;
    readonly workspace: () => AnyActorDefinition;
    readonly fetch?: typeof fetch;
}

/** The Pulls actor's `autopilot` option: the platform's chat-and-inbox port with the GitHub merge. */
export function pullsAutopilot(options: PullsAutopilotOptions): (ref: AutopilotRef) => PullsAutopilotPort {
    return (ref) => ({
        ...chatAutopilotPort({ workspaceId: ref.workspaceId, routing: options.routing, inbox: options.inbox }),
        merge: githubPullMerger(options, ref, options.fetch)
    });
}

/** The slice of the Pulls actor the hook drives. */
interface PullsClient {
    get(): Promise<PullsView>;
    watch(ref: PullsRepo): Promise<PullsView>;
    linkBranch(branch: string, link: PullLink): Promise<PullsView>;
}

/**
 * The router's `placed` hook (#793). A project without Git on, or whose origin names no host an adapter reads, is
 * left alone. The repo is watched only when the actor tracks another (or none), so a placement does not force a poll.
 */
export function pullsPlacement(pulls: () => AnyActorDefinition): (placement: ProjectPlacement) => Promise<void> {
    return async ({ workspaceId, project, taskId, chatId, cwd }) => {
        if (!enabledProjectFeatures(project).includes(GIT_FEATURE_ID)) return;
        const settings: Readonly<Record<string, unknown>> = { ...configDefaults(gitProjectSettings), ...project.features[GIT_FEATURE_ID] };
        const context = asPrincipal(userPrincipal(workspaceId, workspaceId));
        let branch: string | undefined;
        if (chatId && settings['worktreePerChat'] === true && cwd !== undefined) {
            try {
                ({ branch } = chatWorktreeFor(settings, { chatId, cwd, projectName: project.name }));
            } catch {
                // a template that cannot expand parked the task already; nothing to record or link
            }
        }
        // The task carries its branch (#937): Work's "branch X · no PR yet" and the Code card read it off the index row.
        if (branch !== undefined) await actor(TaskActor, taskKey(workspaceId, taskId)).with({ context }).note({ branch }).catch(() => undefined);
        const origin = settings['origin'];
        const ref = typeof origin === 'string' ? pullRepoOfOrigin(origin) : undefined;
        if (!ref) return;
        const client = actor(pulls(), pullsKey(workspaceId, project.id)).with({ context }) as unknown as PullsClient;
        const view = await client.get();
        if (view.repo?.provider !== ref.provider || view.repo.repo !== ref.repo) await client.watch(ref);
        if (branch === undefined || !chatId) return;
        await client.linkBranch(branch, { chatId, taskId });
    };
}
