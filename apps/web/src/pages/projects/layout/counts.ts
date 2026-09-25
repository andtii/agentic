/**
 * The counts on a project's menu (#728; HANDOFF "Navigation inside a project"): Chats and Work carry a count, Work's
 * turns into the `needs-you` badge when something there waits on the person, and a feature section may carry one.
 *
 * Where they come from: the Workspace's `projectSummaries()` (#734) when it has a line for the project, else they
 * are derived here from the chats the page already has (`countsFromChats`). Mock mode reads the sample counts
 * (`MOCK_PROJECT_MENU_COUNTS`), else derives from the sample chats. Live, `ProjectLayout` publishes the summary line
 * to `projectCounts`, keyed by project id like `projectHead`.
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
}

/** The subset of a chat summary the derivation reads (`MockChatSummary`, or a live chat's summary). */
export interface CountableChat {
    readonly projectId?: string;
    /** An approval or a question is open in the chat. */
    readonly waiting: boolean;
}

/** The subset of `ProjectSummaryLine` (#734) the menu reads. */
export interface CountableSummaryLine {
    readonly projectId: string;
    readonly openChats: number;
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
    if (line) return { chats: line.openChats };
    return chats ? countsFromChats(projectId, chats) : undefined;
}

/** Live: the counts `ProjectLayout` read for the open project. */
export const projectCounts = signal<{ value: { readonly id: string; readonly counts: ProjectMenuCounts } | null }>({ value: null });
