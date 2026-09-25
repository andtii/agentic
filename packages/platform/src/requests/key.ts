/** Requests actor keys: `{ws}:requests:{projectId}` — workspace first, like every key `sameWorkspace` reads (#758). */

import { workspaceOfKey, type ProjectId, type WorkspaceId } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const REQUESTS_TYPE = 'requests';

const MARKER = ':requests:';

/** One Requests actor per project: the requests sent to it, and which projects it sent requests to. */
export function requestsKey(workspaceId: WorkspaceId | string, projectId: ProjectId | string): string {
    return `${workspaceId}${MARKER}${projectId}`;
}

/** A `{ws}:requests:{project}` key → its parts, or `null` for any other shape. */
export function parseRequestsKey(key: string): { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId } | null {
    const ws = workspaceOfKey(key);
    if (ws === null || !key.startsWith(`${ws}${MARKER}`)) return null;
    const projectId = key.slice(ws.length + MARKER.length);
    return projectId ? { workspaceId: ws, projectId: projectId as ProjectId } : null;
}
