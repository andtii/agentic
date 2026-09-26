/**
 * The GitHub issue an accepted request opens (#932; PRJ-15): when an accept says `openIssue` (a person's choice, else
 * the triage's), the receiving project's git provider opens an issue for the plan item it became, and its URL is added
 * to that item as a ref. The platform never reaches a provider itself: the app hands the Requests actor a
 * `RequestIssuePort` (production: the git feature's GitHub adapter with the project's own credential, #840).
 */
import type { ProjectId, WorkspaceId } from '@agentic/core';

/** One issue to open: in the receiving project's repo, for the plan item an accepted request became. */
export interface RequestIssue {
    readonly workspaceId: WorkspaceId;
    readonly projectId: ProjectId;
    readonly projectName: string;
    readonly requestId: string;
    /** The plan item (`#n` in `projectId`) the request became. */
    readonly itemN: number;
    readonly title: string;
    readonly body: string;
}

/** An opened issue. */
export interface OpenedRequestIssue {
    readonly url: string;
    readonly number?: number;
}

/** Opens a request's issue. `null` when the project cannot open one (no git origin, no credential). */
export interface RequestIssuePort {
    open(issue: RequestIssue): Promise<OpenedRequestIssue | null>;
}

/** No provider (tests; a deployment without the git feature): nothing is opened, the choice stays recorded. */
export const NO_REQUEST_ISSUES: RequestIssuePort = { async open() { return null; } };

/** The issue's body: the request as it came in, and where it lives on the platform. */
export function requestIssueBody(r: { readonly id: string; readonly body: string; readonly fromProjectName: string }, projectName: string, itemN: number): string {
    return `${r.body}\n\n---\nRequested by ${r.fromProjectName} (${r.id}); tracked as ${projectName}#${itemN}.`;
}
