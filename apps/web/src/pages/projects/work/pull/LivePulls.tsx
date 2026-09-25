/**
 * The workspace's pull requests on the platform (#865): every project with Git on has a Pulls actor
 * (`{ws}:pulls:{projectId}`), and Home's "Needs you" and the task tree read them all. `PullsFeed` mounts one live
 * `Pulls.get` read per such project (`usePulls`) and gathers their PRs into a `WorkspacePulls` the pages read; a
 * project that loses Git (or is deleted) drops out with its reader. Home merges through the project's Pulls actor.
 */
import { component, effect, onUnmounted, signal, untrack, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import type { PullRequest } from '@agentic/core';
import { useActorDefs, useViewer, type ActorDefs } from '../../../../actors/defs';
import { pullsKeyOf } from '../../../../actors/keys';
import type { PullNeeds } from '../../../inbox/NeedsYou';
import { GIT_FEATURE_ID } from '../../features/git/model';
import { useProjects } from '../../live';
import { usePulls } from '../live';
import { pullPageHref } from './links';

/** A pull request with the project whose Pulls actor holds it. */
export interface ProjectPull {
    readonly projectId: string;
    readonly pr: PullRequest;
}

/** Every Git project's pull requests, as the mounted `PullsFeed` last read them. */
export interface WorkspacePulls {
    all(): readonly ProjectPull[];
    /** What `PullsFeed` writes: the PRs of `projectId`, `null` to drop the project. */
    put(projectId: string, pulls: readonly PullRequest[] | null): void;
}

export function createWorkspacePulls(): WorkspacePulls {
    const st = signal<{ byProject: Readonly<Record<string, readonly PullRequest[]>> }>({ byProject: {} });
    return {
        all: () => Object.entries(st.byProject).flatMap(([projectId, prs]) => prs.map((pr) => ({ projectId, pr }))),
        put: (projectId, pulls) => {
            // Untracked: a reader's effect writes here, and must not depend on what the other projects hold.
            untrack(() => {
                const { [projectId]: _dropped, ...rest } = st.byProject;
                st.byProject = pulls ? { ...rest, [projectId]: pulls } : rest;
            });
        }
    };
}

const ProjectPullsReader = component<{ projectId: string; feed: WorkspacePulls }>(({ props }) => {
    const id = props.projectId;
    const pulls = usePulls(id);
    const stop = effect(() => props.feed.put(id, pulls()));
    onUnmounted(() => {
        stop();
        props.feed.put(id, null);
    });
    return () => null;
}, { name: 'ProjectPullsReader' });

/** Reads every Git project's Pulls actor into `feed`; renders nothing. */
export const PullsFeed = component<{ feed: WorkspacePulls }>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const projects = useProjects(defs, viewer);
    return (): JSXElement => (
        <>
            {projects.list().filter((p) => GIT_FEATURE_ID in p.features).map((p) => <ProjectPullsReader key={p.id} projectId={p.id} feed={props.feed} />)}
        </>
    );
}, { name: 'PullsFeed' });

/**
 * Home's pull requests live: the feed's PRs, each opening its PR page; "Squash and merge" answers the project's
 * Pulls actor (`answerMerge`) and rejects when the actor refuses; the PR leaves the list once its poll reads it merged.
 */
export function livePullNeeds(feed: WorkspacePulls, defs: Pick<ActorDefs, 'Pulls'>, workspaceId: () => string | null, me?: string): PullNeeds {
    // Keyed by repo and number, not by object: the list hands the card a reactive view of the record.
    const key = (pr: Pick<PullRequest, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`;
    const projectOf = (pr: PullRequest): string | undefined => feed.all().find((p) => key(p.pr) === key(pr))?.projectId;
    return {
        usePulls: () => () => feed.all().map((p) => p.pr),
        ...(me !== undefined ? { me } : {}),
        href: (pr) => {
            const projectId = projectOf(pr);
            return projectId ? pullPageHref(projectId, pr.number) : undefined;
        },
        merge: async (pr) => {
            const ws = workspaceId();
            const projectId = projectOf(pr);
            if (!ws || !projectId) throw new Error('the pull request is no longer in a project');
            // The actor polls after the merge; the card leaves once the live read shows it merged.
            await actor(defs.Pulls, pullsKeyOf(ws, projectId)).answerMerge(pr.number, true);
        }
    };
}

/** The pull request one of `taskIds` resolved to (`PullRequest.taskId`), if any. */
export function taskPullOf(pulls: readonly ProjectPull[], ...taskIds: readonly (string | undefined)[]): PullRequest | undefined {
    const ids = new Set(taskIds.filter((id): id is string => !!id));
    return ids.size ? pulls.find(({ pr }) => pr.taskId !== undefined && ids.has(pr.taskId))?.pr : undefined;
}
