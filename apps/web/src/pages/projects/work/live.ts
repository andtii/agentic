/**
 * Where the Work view's inputs come from (#738): on mock data the fixtures in `mock/projects/work.ts`; live, the
 * workspace's TaskIndex (a task is the project's when its chat is), the Registry's project features for the stages,
 * and — until the git feature's pull request store (G2) and the Plan store (PL1) exist — no pull requests and no
 * plan items. Hooks only; the derivation is `model.ts`.
 */
import { useActorState } from '@sigx/actors/app';
import type { AgentId, PlanItem, ProjectFeatureUi, ProjectRecord, PullRequest, TaskId } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../../actors/defs';
import { registryKeyOf, taskIndexKeyOf } from '../../../actors/keys';
import { dataMode } from '../../../data-mode';
import { MOCK_WORK, mockFeatureUi } from '../../../mock/projects/work';
import type { WorkFeatures, WorkTask } from './model';

/** The project's pull requests: `[]` live until the git feature stores them (G2). */
export function usePulls(projectId: string): () => readonly PullRequest[] {
    return () => (dataMode() === 'live' ? [] : (MOCK_WORK[projectId]?.pulls ?? []));
}

/** The project's plan items: `[]` live until the Plan store exists (PL1). */
export function usePlanItems(projectId: string): () => readonly PlanItem[] {
    return () => (dataMode() === 'live' ? [] : (MOCK_WORK[projectId]?.planItems ?? []));
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
