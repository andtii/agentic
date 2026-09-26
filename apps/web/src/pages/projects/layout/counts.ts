/**
 * The counts on a project's menu (#728; HANDOFF "Navigation inside a project"): Chats and Work carry a count, Work's
 * turns into the `needs-you` badge when something there waits on the person, and a feature section may carry one.
 *
 * Where they come from: the Workspace's `projectSummaries()` (#734) when it has a line for the project, else they
 * are derived here from the chats the page already has (`countsFromChats`). Mock mode reads the sample counts
 * (`MOCK_PROJECT_MENU_COUNTS`), else derives from the sample chats. Live, `ProjectLayout` publishes the summary line
 * to `projectCounts`, keyed by project id like `projectHead`.
 *
 * Live (#934), the summary line also carries the project's work — Work counts its open items and turns into the
 * needs-you badge on your-move ones — its open plan items (the Plan section) and its requests that need a person.
 */
import { signal } from 'sigx';

export interface ProjectMenuCounts {
    /** Open chats in the project. */
    readonly chats?: number;
    /** Open work items. */
    readonly work?: number;
    /** What in the project waits on the person: drawn as Work's `needs-you` badge instead of its count. */
    readonly needsYou?: number;
    /** A count per feature section, by feature id. */
    readonly features?: Readonly<Record<string, number>>;
    /** Incoming requests waiting on the person (#934). */
    readonly requests?: number;
}

/** The Plan feature's id (`@agentic/plugins-plan`'s `PLAN_FEATURE_ID`, as `features/registry.ts` keys it): its section counts open plan items. */
export const PLAN_FEATURE = 'agentic.feature.plan';

/** The subset of a chat summary the derivation reads (`MockChatSummary`, or a live chat's summary). */
export interface CountableChat {
    readonly projectId?: string;
    /** An approval or a question is open in the chat. */
    readonly waiting: boolean;
}

/** The subset of `ProjectSummaryLine` (#734, #934) the menu reads; the counts a source could not read are absent. */
export interface CountableSummaryLine {
    readonly projectId: string;
    readonly openChats: number;
    readonly work?: { readonly yourMove: number; readonly agentsOnIt: number; readonly waiting: number };
    readonly openPlanItems?: number;
    readonly requestsNeedYou?: number;
}

/** A summary line as menu counts: chats, open work (your move, agents on it, waiting) with your move as needs-you, the Plan section, requests. */
export function countsOfLine(line: CountableSummaryLine): ProjectMenuCounts {
    const w = line.work;
    return {
        chats: line.openChats,
        ...(w ? { work: w.yourMove + w.agentsOnIt + w.waiting, needsYou: w.yourMove } : {}),
        ...(line.openPlanItems !== undefined ? { features: { [PLAN_FEATURE]: line.openPlanItems } } : {}),
        ...(line.requestsNeedYou !== undefined ? { requests: line.requestsNeedYou } : {})
    };
}

/** A project's counts derived from chats: the ones in the project, and those of them that wait on the person. */
export function countsFromChats(projectId: string, chats: readonly CountableChat[]): ProjectMenuCounts {
    const mine = chats.filter((c) => c.projectId === projectId);
    return { chats: mine.length, needsYou: mine.filter((c) => c.waiting).length };
}

/**
 * The project's counts: its summary line when the Workspace answered one, else derived from `chats`; `undefined`
 * when there is neither.
 */
export function countsFor(projectId: string, lines: readonly CountableSummaryLine[] | undefined, chats?: readonly CountableChat[]): ProjectMenuCounts | undefined {
    const line = lines?.find((l) => l.projectId === projectId);
    if (line) return countsOfLine(line);
    return chats ? countsFromChats(projectId, chats) : undefined;
}

/** Live: the counts `ProjectLayout` read for the open project. */
export const projectCounts = signal<{ value: { readonly id: string; readonly counts: ProjectMenuCounts } | null }>({ value: null });
