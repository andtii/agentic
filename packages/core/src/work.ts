/**
 * Work items (#724, projects redesign #722): the Work view's rows, derived — never stored — from tasks, pull requests
 * and plan items. The owner is whoever acts next (docs/design/projects/HANDOFF.md, "Work").
 */

import type { AgentId, TaskId } from './ids.js';
import type { ProjectFeatureUi } from './project-ui.js';

/** The stages a work item moves through when no enabled feature declares its own. */
export const WORK_STAGES_FALLBACK: readonly string[] = ['Ready', 'Do', 'Review', 'Done'];

export type WorkStageState = 'working' | 'needs-you' | 'failed' | 'done';
export type WorkGroup = 'your-move' | 'agents' | 'waiting' | 'done';
export type WorkOwner = { readonly kind: 'you' } | { readonly kind: 'agent'; readonly agentId: AgentId };

export interface WorkItem {
    /** Stable within the project: `task:<id>`, `pr:<n>` or `item:<n>`. */
    readonly id: string;
    readonly title: string;
    readonly taskId?: TaskId;
    /** The plan item it carries out, `#n`. */
    readonly itemRef?: string;
    /** The pull request number, when it has one. */
    readonly pull?: number;
    readonly stages: readonly string[];
    /** Index into `stages`. */
    readonly stage: number;
    readonly stageState: WorkStageState;
    readonly owner: WorkOwner;
    /** What the owner does next, one line ("Merge — green, Lint approved"). */
    readonly nextStep: string;
    readonly group: WorkGroup;
    readonly updatedAt: number;
}

/**
 * The stages for a project's work items: those of the first enabled feature (in `enabled` order) that declares
 * `ui.workStages`, else `WORK_STAGES_FALLBACK`.
 */
export function workStagesFor(enabled: readonly string[], uiOf: (featureId: string) => ProjectFeatureUi | undefined): readonly string[] {
    for (const id of enabled) {
        const stages = uiOf(id)?.workStages;
        if (stages && stages.length >= 2) return stages;
    }
    return WORK_STAGES_FALLBACK;
}
