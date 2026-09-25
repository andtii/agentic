/**
 * The Work view on the platform (#738): the project's tasks — TaskIndex rows whose chat is in the project — the
 * Registry's feature `ui` blocks for the stages, the agent directory for names and hues, and the Pulls actor's pull
 * requests (#865); plan items stay `[]` until their store exists (`live.ts`). Called in the page's setup; `WorkView` renders the board.
 */
import type { PlanItem, ProjectRecord, PullRequest } from '@agentic/core';
import type { PullsReadiness } from '@agentic/platform';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { useAgentDirectory } from '../../chat/directory';
import { useChatRows } from '../../chat/LiveChats';
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
    readonly loading: boolean;
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
        get loading() {
            return index.loading || chats.loading;
        }
    };
}
