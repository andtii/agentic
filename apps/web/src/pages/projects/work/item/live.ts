/**
 * The work item page on the platform (#790): the Work view's live inputs (#738) derive the project's work items, and
 * each one without a pull request becomes a `WorkItemDetail` — its task from the TaskIndex row (objective, status,
 * agent, session), that task's chat from the chat rows, and, when a plan holds the item, the plan, its phase and the
 * item with its done-when checklist. `detailsOf` is pure; `useLiveWorkItems` is the hook the page calls in setup.
 */
import type { Plan, ProjectRecord, WorkItem } from '@agentic/core';
import type { TaskIndexRow } from '@agentic/platform';
import { useActorDefs, useViewer } from '../../../../actors/defs';
import { useAgentDirectory } from '../../../chat/directory';
import { useChatRows } from '../../../chat/LiveChats';
import { featuresOf, projectTasks, useFeatureUi, usePlanItems, usePulls, useTaskIndexRows } from '../live';
import { workItemsOf } from '../model';
import type { WorkAgentLookup } from '../WorkView';
import type { WorkItemDetail, WorkItemPlan } from './model';

/** A TaskIndex row as far as the page reads it. */
export type WorkItemTaskRow = Pick<TaskIndexRow, 'id' | 'objective' | 'status' | 'assignee' | 'chatId' | 'sessionId'>;

/** The plan and phase that hold item `#id`, with the item itself. */
export function planOf(plans: readonly Plan[], id: number): WorkItemPlan | undefined {
    for (const plan of plans) {
        for (const phase of plan.phases) {
            const item = phase.items.find((i) => i.id === id);
            if (item) return { title: plan.title, phase: `Phase ${phase.n} · ${phase.title}`, item };
        }
    }
    return undefined;
}

/** The plan item number a work item carries (`#12` → 12), if any. */
const itemNumberOf = (item: WorkItem): number | undefined => {
    const m = /^#(\d+)$/.exec(item.itemRef ?? '');
    return m ? Number(m[1]) : undefined;
};

/**
 * One detail per work item that is not a pull request: the task carrying it out (its id is also the ref the page
 * prints — live tasks have no shorter one), that task's chat and session, and the plan item when a plan holds it.
 */
export function detailsOf(
    items: readonly WorkItem[],
    rows: readonly WorkItemTaskRow[],
    chats: readonly { readonly id: string; readonly title: string }[],
    plans: readonly Plan[] = []
): WorkItemDetail[] {
    const rowById = new Map(rows.map((r) => [r.id as string, r]));
    const chatById = new Map(chats.map((c) => [c.id, c]));
    const out: WorkItemDetail[] = [];
    for (const item of items) {
        if (item.pull !== undefined) continue;
        const row = item.taskId ? rowById.get(item.taskId) : undefined;
        const chat = row?.chatId ? chatById.get(row.chatId) : undefined;
        const n = itemNumberOf(item);
        const plan = n !== undefined ? planOf(plans, n) : undefined;
        out.push({
            item,
            ...(row ? { task: { id: row.id, ref: row.id, objective: row.objective, status: row.status, agentId: row.assignee } } : {}),
            ...(chat ? { chat: { id: chat.id, title: chat.title } } : {}),
            ...(row?.sessionId ? { sessionId: row.sessionId } : {}),
            ...(plan ? { plan } : {})
        });
    }
    return out;
}

export interface LiveWorkItems {
    details(): readonly WorkItemDetail[];
    readonly agentOf: WorkAgentLookup;
    readonly loading: boolean;
}

/**
 * The project's work item details, live: the same inputs as the Work view (TaskIndex rows whose chat is in the
 * project, the Registry's feature stages, pull requests and plan items as `live.ts` has them). No plan store is read
 * yet, so plan-backed items carry no checklist until one is.
 */
export function useLiveWorkItems(project: () => ProjectRecord): LiveWorkItems {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const chats = useChatRows(defs, viewer, directory);
    const index = useTaskIndexRows(defs, viewer);
    const uiOf = useFeatureUi(defs, viewer);
    return {
        details: () => {
            // The project read on every call: the route may move to another one while the page stays mounted.
            const p = project();
            const inProject = chats.rows().filter((c) => c.projectId === p.id);
            const ids = new Set(inProject.map((c) => c.id));
            const rows = index.rows().filter((r) => r.chatId !== undefined && ids.has(r.chatId));
            const items = workItemsOf(projectTasks(rows, ids), usePulls(p.id)(), usePlanItems(p.id)(), featuresOf(p, uiOf), Date.now());
            return detailsOf(items, rows, inProject);
        },
        agentOf: (id) => {
            const a = directory.lookup(id);
            return { name: a.name, hue: a.hue };
        },
        get loading() {
            return index.loading || chats.loading;
        }
    };
}
