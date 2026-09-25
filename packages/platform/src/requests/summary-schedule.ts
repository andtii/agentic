/**
 * The weekly summary's Schedule entry (#763, #868): pure, and free of actor imports so the Workspace can build the
 * entry from `setProjectPmPolicy` without importing the Requests actor (which imports the Workspace). `summary.ts`
 * re-exports everything here.
 */
import { actorKey, type PmWeeklySummary, type ProjectId, type ProjectRecord, type ScheduleId, type WorkspaceId } from '@agentic/core';
import type { ScheduleSpec } from '../schedule/actor.js';

/** When a project's summary goes out unless its manager's settings say otherwise: Monday 08:45. */
export const PM_SUMMARY_DEFAULT: PmWeeklySummary = { day: 1, time: '08:45' };

/** The prompt that marks a Schedule entry as a project's weekly summary. */
export const PM_SUMMARY_PROMPT = 'pm:weekly-summary';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The Schedule id of a project's weekly summary — one per project, so a settings change patches the same entry. */
export function pmSummaryScheduleId(projectId: ProjectId): ScheduleId {
    return `sch_pm_${projectId}` as ScheduleId;
}

/** `{ws}:schedule:sch_pm_{project}`. */
export function pmSummaryScheduleKey(workspaceId: WorkspaceId, projectId: ProjectId): string {
    return actorKey(workspaceId, 'schedule', pmSummaryScheduleId(projectId));
}

/** The cron for a weekly summary (`45 8 * * 1`); throws on a day outside 0–6 or a time that is not `HH:MM`. */
export function pmSummaryCron(summary: PmWeeklySummary = PM_SUMMARY_DEFAULT): string {
    if (!Number.isInteger(summary.day) || summary.day < 0 || summary.day > 6) throw new Error(`[requests] a weekly summary day is 0 (Sunday) to 6, got ${String(summary.day)}`);
    const m = TIME_RE.exec(summary.time);
    if (!m) throw new Error(`[requests] a weekly summary time is HH:MM, got ${String(summary.time)}`);
    return `${Number(m[2])} ${Number(m[1])} * * ${summary.day}`;
}

/**
 * The Schedule entry for a project's weekly summary, on the workspace's time zone `tz`. No agent: the firing is
 * turned into the summary by `pmSummaryTrigger`, not into a task.
 */
export function pmSummarySchedule(project: Pick<ProjectRecord, 'id' | 'name'>, tz: string, summary: PmWeeklySummary = PM_SUMMARY_DEFAULT): ScheduleSpec {
    return {
        kind: 'recurring',
        title: `Weekly summary · ${project.name}`,
        recurrence: { kind: 'cron', cron: pmSummaryCron(summary), tz },
        projectId: project.id,
        prompt: PM_SUMMARY_PROMPT
    };
}
