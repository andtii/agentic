/**
 * The work item page's view model (#739, PRJ-05): a work item without a pull request, with what it links to — the
 * task carrying it out, that task's chat and session, and, when the item comes from Plan, the plan item with its
 * done-when checklist. Pure: the mock fixtures and (later) live data render through the same helpers.
 */
import { WORK_STAGES_FALLBACK, type PlanDoneWhen, type PlanItem, type WorkItem, type WorkOwner, type WorkStageState } from '@agentic/core';

/** The task a work item is carried out by, as the page links it. */
export interface WorkItemTask {
    /** The task's id: `/tasks/<id>`. */
    readonly id: string;
    /** The short ref the page prints (`t_52a1`). */
    readonly ref: string;
    readonly objective: string;
    readonly status: string;
    readonly agentId: string;
}

/** The plan an item comes from: which plan, which phase, and the item itself. */
export interface WorkItemPlan {
    readonly title: string;
    readonly phase: string;
    readonly item: PlanItem;
}

export interface WorkItemDetail {
    readonly item: WorkItem;
    readonly task?: WorkItemTask;
    readonly chat?: { readonly id: string; readonly title: string };
    readonly sessionId?: string;
    readonly plan?: WorkItemPlan;
}

/**
 * The detail a route's `:item` names: a work item id (`task:<ref>`, `item:<n>`), a bare task ref (`t_52a1`) or a bare
 * plan item ref (`#12`). A pull request (`pr:<n>`) is never this page's: `undefined`.
 */
export function findWorkItem(details: readonly WorkItemDetail[], param: string): WorkItemDetail | undefined {
    const key = param.trim();
    if (!key || key.startsWith('pr:')) return undefined;
    return details.find((d) => d.item.pull === undefined && (
        d.item.id === key
        || d.item.id === `task:${key}`
        || (d.task !== undefined && d.task.ref === key)
        || (d.item.itemRef !== undefined && (d.item.itemRef === key || d.item.itemRef === `#${key.replace(/^item:/, '')}`))
    ));
}

/** The stages the stepper draws: the item's own, else the fallback Ready → Do → Review → Done. */
export function stagesOf(item: Pick<WorkItem, 'stages'>): readonly string[] {
    return item.stages.length >= 2 ? item.stages : WORK_STAGES_FALLBACK;
}

export type StepState = 'passed' | 'current' | 'later';

export interface Step {
    readonly name: string;
    readonly state: StepState;
    /** The current step's state colour; passed and later steps have none. */
    readonly tone?: WorkStageState;
}

/**
 * One step per stage: those before the current one passed, the current one in the item's state, the rest later. An
 * item whose state is `done` has every stage up to and including the current one passed.
 */
export function stepsOf(item: Pick<WorkItem, 'stages' | 'stage' | 'stageState'>): Step[] {
    const stages = stagesOf(item);
    const current = Math.min(Math.max(0, Math.floor(item.stage)), stages.length - 1);
    return stages.map((name, i) => {
        if (i < current || (i === current && item.stageState === 'done')) return { name, state: 'passed' };
        if (i === current) return { name, state: 'current', tone: item.stageState };
        return { name, state: 'later' };
    });
}

/** Who acts next, as the owner badge says it: `You`, or the agent's name. */
export function ownerLabel(owner: WorkOwner, agentName: (id: string) => string): string {
    return owner.kind === 'you' ? 'You' : agentName(owner.agentId);
}

/** The checklist's progress, `2 of 3 done`, or `''` for an empty list. */
export function doneWhenProgress(list: readonly PlanDoneWhen[]): string {
    return list.length ? `${list.filter((d) => d.checked).length} of ${list.length} done` : '';
}
