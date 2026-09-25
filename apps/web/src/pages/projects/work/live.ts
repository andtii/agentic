/**
 * Where the Work view's inputs come from (#738): on mock data the fixtures in `mock/projects/work.ts`; live, the
 * workspace's TaskIndex (a task is the project's when its chat is), the Registry's project features for the stages,
 * the project's Plan actor for the plan items (#882) and its Pulls actor for the pull requests (#865). Hooks only;
 * the derivation is `model.ts`.
 */
import { useActorState } from '@sigx/actors/app';
import type { AgentId, Plan, PlanItem, ProjectFeatureUi, ProjectRecord, PullRequest, TaskId } from '@agentic/core';
import type { PullsReadiness, TaskIndexRow } from '@agentic/platform';
import { useActorDefs, useViewer, type ActorDefs, type ViewerState } from '../../../actors/defs';
import { planKeyOf, pullsKeyOf, registryKeyOf, taskIndexKeyOf } from '../../../actors/keys';
import { dataMode } from '../../../data-mode';
import { MOCK_WORK, mockFeatureUi } from '../../../mock/projects/work';
import type { WorkFeatures, WorkTask } from './model';

const projectIdOf = (projectId: string | (() => string)): (() => string) => (typeof projectId === 'function' ? projectId : () => projectId);

/**
 * The project's pull requests: live the Pulls actor's `get` view (#865), on mock data the Work fixtures. Call it in
 * setup; given a getter, the read follows the project it names.
 */
export function usePulls(projectId: string | (() => string)): () => readonly PullRequest[] {
    return usePullsState(projectId).pulls;
}

/** The project's pull requests and whether the Pulls actor can read them (#915): `readiness` is live only. */
export interface PullsState {
    pulls(): readonly PullRequest[];
    /** `needs-sign-in`: the last poll found no GitHub credential for the project's repo. */
    readiness(): PullsReadiness | undefined;
}

/** `usePulls` with the view's `readiness` beside the PRs, from the same one read. */
export function usePullsState(projectId: string | (() => string)): PullsState {
    const id = projectIdOf(projectId);
    if (dataMode() !== 'live') return { pulls: () => MOCK_WORK[id()]?.pulls ?? [], readiness: () => undefined };
    const defs = useActorDefs();
    const viewer = useViewer()();
    const view = useActorState(defs.Pulls, () => viewer.workspaceId && ([pullsKeyOf(viewer.workspaceId, id()), 'get'] as const), { live: true });
    return { pulls: () => view.value?.pulls ?? [], readiness: () => view.value?.readiness };
}

/** Where a live plan read goes: the actor defs and the viewer (injected when not given). */
export interface PlanReadDeps {
    readonly defs: Pick<ActorDefs, 'Plan'>;
    readonly viewer: Pick<ViewerState, 'workspaceId'>;
}

/**
 * The project's plans, live: one `useActorState` read of its Plan actor's `list()` (#750), opened here in setup.
 * `projectId` may be a getter, so a page that stays mounted while the route moves to another project follows it.
 * `[]` until the read lands, and on mock data (the mock plan items come through `usePlanItems`).
 */
export function usePlans(projectId: string | (() => string), deps?: PlanReadDeps): { plans(): readonly Plan[]; readonly loading: boolean } {
    if (dataMode() !== 'live') return { plans: () => [], loading: false };
    const defs = deps?.defs ?? useActorDefs();
    const viewer = deps?.viewer ?? useViewer()();
    const id = projectIdOf(projectId);
    const list = useActorState(defs.Plan, () => viewer.workspaceId && ([planKeyOf(viewer.workspaceId, id()), 'list'] as const), { live: true });
    return {
        plans: () => list.value?.plans ?? [],
        get loading() {
            return list.loading;
        }
    };
}

/** Every item of `plans`, in plan, phase and item order. */
export const planItemsOf = (plans: readonly Plan[]): PlanItem[] => plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));

/** The project's plan items: live every item of its plans (`usePlans`), on mock data the fixtures. */
export function usePlanItems(projectId: string | (() => string), deps?: PlanReadDeps): () => readonly PlanItem[] {
    if (dataMode() !== 'live') {
        const id = projectIdOf(projectId);
        return () => MOCK_WORK[id()]?.planItems ?? [];
    }
    const read = usePlans(projectId, deps);
    return () => planItemsOf(read.plans());
}

/** The project's tasks on mock data. */
export const mockWorkTasks = (projectId: string): readonly WorkTask[] => MOCK_WORK[projectId]?.tasks ?? [];

/** A TaskIndex row as a Work task. */
export const workTaskOf = (row: Pick<TaskIndexRow, 'id' | 'objective' | 'status' | 'wait' | 'assignee' | 'updatedAt'>): WorkTask => ({
    id: row.id as TaskId,
    title: row.objective,
    status: row.status,
    ...(row.wait ? { wait: row.wait } : {}),
    assignee: row.assignee as AgentId,
    updatedAt: row.updatedAt
});

/** The project's tasks: the index rows whose chat is one of `chatIds`. */
export function projectTasks(rows: readonly TaskIndexRow[], chatIds: ReadonlySet<string>): WorkTask[] {
    return rows.filter((r) => r.chatId !== undefined && chatIds.has(r.chatId)).map(workTaskOf);
}

/** The enabled features of `project` and their `ui` blocks; live the Registry's `projectFeatures()`. */
export function featuresOf(project: Pick<ProjectRecord, 'features'>, uiOf: (id: string) => ProjectFeatureUi | undefined): WorkFeatures {
    return { enabled: Object.keys(project.features), uiOf };
}

export const mockWorkFeatures = (project: Pick<ProjectRecord, 'features'>): WorkFeatures => featuresOf(project, mockFeatureUi);

/** The Registry's project features as a `ui` lookup (empty until the read lands, so the stages fall back meanwhile). */
export function useFeatureUi(defs: Pick<ActorDefs, 'Registry'>, viewer: Pick<ViewerState, 'workspaceId'>): (id: string) => ProjectFeatureUi | undefined {
    const views = useActorState(defs.Registry, () => viewer.workspaceId && ([registryKeyOf(viewer.workspaceId), 'projectFeatures'] as const), { live: true });
    return (id) => (views.value ?? []).find((v) => v.id === id)?.ui;
}

/** The workspace's TaskIndex, live. */
export function useTaskIndexRows(defs: Pick<ActorDefs, 'TaskIndex'>, viewer: Pick<ViewerState, 'workspaceId'>): { rows(): readonly TaskIndexRow[]; readonly loading: boolean } {
    const index = useActorState(defs.TaskIndex, () => viewer.workspaceId && ([taskIndexKeyOf(viewer.workspaceId), 'list'] as const), { live: true });
    return {
        rows: () => index.value ?? [],
        get loading() {
            return index.loading;
        }
    };
}
