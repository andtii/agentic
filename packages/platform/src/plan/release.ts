/**
 * A plan item's work ended (#1075): once a turn leaves an item `done` (ticked, set done, or its pull request merged) or
 * `dropped` that was neither before, the Plan actor tells a `PlanReleasePort` so the project's features can tidy up
 * what they made for the tasks that carried the item — the git feature removes its worktree (`plan/<project>-<n>`,
 * `ProjectFeaturePlugin.onPlanItemReleased`). Best effort, after the turn is saved: a failure is logged, never undoes
 * the change. A reopened item that finishes again is released again.
 */
import type { ProjectFeatureItemReleaseReason, ProjectId, WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import { routingKey } from '../routing/key.js';
import type { StoredItem } from './rules.js';

/** One item whose work ended, and why. */
export interface PlanItemRelease {
    readonly n: number;
    readonly reason: ProjectFeatureItemReleaseReason;
}

export interface PlanReleasePort {
    /** Items of project `projectId` done or dropped in one turn, in item order. */
    released(release: { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId; readonly items: readonly PlanItemRelease[] }): Promise<void>;
}

/** The items finished (`done` / `dropped`) by number: what a turn is compared against. */
export function finishedStates(items: Readonly<Record<string, StoredItem>>): Map<number, ProjectFeatureItemReleaseReason> {
    const out = new Map<number, ProjectFeatureItemReleaseReason>();
    for (const i of Object.values(items)) if (i.state === 'done' || i.state === 'dropped') out.set(i.id, i.state);
    return out;
}

/** The items finished now that were not (or finished another way) `before`, in item order. */
export function newlyFinished(before: ReadonlyMap<number, ProjectFeatureItemReleaseReason>, items: Readonly<Record<string, StoredItem>>): PlanItemRelease[] {
    return [...finishedStates(items)]
        .filter(([n, reason]) => before.get(n) !== reason)
        .sort(([a], [b]) => a - b)
        .map(([n, reason]) => ({ n, reason }));
}

export interface RouterPlanReleaseOptions {
    /** The Routing actor definition (`defineRoutingActor`), as a thunk like `pullMergeRelease`'s. */
    readonly routing: () => AnyActorDefinition;
}

interface ItemReleaseClient {
    planItemReleased(projectId: ProjectId, items: readonly PlanItemRelease[]): Promise<void>;
}

/**
 * The production `PlanReleasePort` (#1081): tells the router `planItemReleased(projectId, items)` one-way, as the
 * workspace user (the Plan's turn may carry an agent, whom the router refuses), like `pullMergeRelease`. The router
 * checks each item is still done or dropped, closes the items' sessions and runs every feature's `onPlanItemReleased`
 * on each online folder of the project, audited `project.item-released`.
 */
export function routerPlanRelease(options: RouterPlanReleaseOptions): PlanReleasePort {
    return {
        async released({ workspaceId, projectId, items }) {
            const router = actor(options.routing(), routingKey(workspaceId)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)), oneWay: true }) as unknown as ItemReleaseClient;
            await router.planItemReleased(projectId, items);
        }
    };
}
