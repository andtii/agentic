/**
 * The git feature's pull requests, wired into the Pulls actor (#793; PRJ-08, PRJ-10).
 *
 * - `githubPullSources`: the actor's `PullSourcePort` — the GitHub adapter (`@agentic/plugins-git/provider`, its own
 *   entry so the feature plugin's bundle stays small) over the project's GitHub credential (#840, `projectPullToken`):
 *   the project's `github` connector, else the workspace's, else the workspace's `github-token` secret under the git
 *   plugin's `secret:github-token` grant.
 * - `pullsPlacement`: the router's `placed` hook — a task placed in a project with Git on watches the repo its
 *   `origin` names (`Pulls.watch`, once per repo), and a chat with a worktree of its own links its branch to the task
 *   (`Pulls.linkBranch`), so the PR the agent opens from it waits the task and completes it on merge.
 * - `pullsAutopilot`: the actor's autopilot port (#820) — turns in the PR's chat and Inbox rows from the platform's
 *   `chatAutopilotPort`, the merge from `githubPullMerger`: a squash through the git feature's `PullProvider.merge`
 *   with the same per-project token (#915), only ever after the approval rule `ask on merge` was answered yes (`Pulls.answerMerge`).
 */
import { asPrincipal, chatAutopilotPort, projectPullToken, pullsKey, tokenPullSources, userPrincipal, type AutopilotPort, type PullLink, type PullsAutopilotPort, type PullsRepo, type PullSourcePort, type PullsView, type ProjectPlacement } from '@agentic/platform';
import { configDefaults, enabledProjectFeatures, type ProjectId, type WorkspaceId } from '@agentic/core';
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
        const origin = settings['origin'];
        const ref = typeof origin === 'string' ? pullRepoOfOrigin(origin) : undefined;
        if (!ref) return;
        const client = actor(pulls(), pullsKey(workspaceId, project.id)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)) }) as unknown as PullsClient;
        const view = await client.get();
        if (view.repo?.provider !== ref.provider || view.repo.repo !== ref.repo) await client.watch(ref);
        if (!chatId || settings['worktreePerChat'] !== true || cwd === undefined) return;
        let branch: string;
        try {
            ({ branch } = chatWorktreeFor(settings, { chatId, cwd, projectName: project.name }));
        } catch {
            return; // a template that cannot expand parked the task already; nothing to link
        }
        await client.linkBranch(branch, { chatId, taskId });
    };
}
