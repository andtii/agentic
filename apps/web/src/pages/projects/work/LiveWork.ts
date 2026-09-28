/**
 * The Work view on the platform (#738): the project's tasks — TaskIndex rows whose chat is in the project — the
 * Registry's feature `ui` blocks for the stages, the agent directory for names and hues, and the Pulls actor's pull
 * requests (#865); plan items stay `[]` until their store exists (`live.ts`). Called in the page's setup; `WorkView` renders the board.
 */
import { actor } from '@sigx/actors';
import type { EnvironmentId, PlanItem, ProjectRecord, PullRequest, TaskId } from '@agentic/core';
import type { PullsReadiness } from '@agentic/platform';
import { useActorDefs, useViewer, type ActorDefs } from '../../../actors/defs';
import { taskKeyOf } from '../../../actors/keys';
import { useAgentDirectory } from '../../chat/directory';
import type { AgentLookup } from '../../chat/live';
import { useChatRows } from '../../chat/LiveChats';
import { startTaskWith } from '../../task/start';
import type { WorkActionPorts } from './actions';
import { featuresOf, projectTasks, useFeatureUi, usePlanItems, usePullsState, useTaskIndexRows } from './live';
import type { WorkFeatures, WorkTask } from './model';
import type { WorkAgentLookup } from './WorkView';

export interface LiveWorkInputs {
    tasks(): readonly WorkTask[];
    pulls(): readonly PullRequest[];
    /** The Pulls actor's `needs-sign-in` (#915): no GitHub credential for the project's repo. */
    pullsReadiness(): PullsReadiness | undefined;
    planItems(): readonly PlanItem[];
    features(): WorkFeatures;
    readonly agentOf: WorkAgentLookup;
    /** The row actions' live calls (#1040); `undefined` until the workspace is known. */
    ports(): WorkActionPorts | undefined;
    readonly loading: boolean;
}

/**
 * The row actions on the platform (#1040): Stop is `TaskActor.cancel` (the COL-12 cascade), Dismiss and its Undo
 * `dismiss`/`undismiss`, Retry the Start task path (`startTaskWith`) for the failed task's agent and objective, in the
 * same project, on the same machine and folder.
 */
export function workActionPorts(defs: ActorDefs, ws: string, projectId: string, lookup: AgentLookup): WorkActionPorts {
    const task = (id: string) => actor(defs.TaskActor, taskKeyOf(ws, id as TaskId));
    return {
        cancel: (id) => task(id).cancel('user'),
        dismiss: (id) => task(id).dismiss('user'),
        undismiss: (id) => task(id).undismiss('user'),
        retry: async (id) => {
            const v = await task(id).get();
            const workdir = v.workdir !== undefined && v.environmentId !== undefined ? { environmentId: v.environmentId as EnvironmentId, path: v.workdir } : null;
            await startTaskWith(defs, ws, { agentId: v.assignee, objective: v.objective, workdir, machineId: v.machineId ?? null, projectId }, lookup);
        }
    };
}

export function useLiveWork(project: () => ProjectRecord): LiveWorkInputs {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const chats = useChatRows(defs, viewer, directory);
    const index = useTaskIndexRows(defs, viewer);
    const uiOf = useFeatureUi(defs, viewer);
    const pullsState = usePullsState(() => project().id);
    const planItems = usePlanItems(project().id);
    return {
        tasks: () => {
            const id = project().id;
            const ids = new Set(chats.rows().filter((c) => c.projectId === id).map((c) => c.id));
            return projectTasks(index.rows(), ids);
        },
        pulls: pullsState.pulls,
        pullsReadiness: pullsState.readiness,
        planItems,
        features: () => featuresOf(project(), uiOf),
        agentOf: (id) => {
            const a = directory.lookup(id);
            return { name: a.name, hue: a.hue };
        },
        ports: () => (viewer.workspaceId ? workActionPorts(defs, viewer.workspaceId, project().id, directory.lookup) : undefined),
        get loading() {
            return index.loading || chats.loading;
        }
    };
}
