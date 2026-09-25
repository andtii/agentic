/** Pulls actor keys: `{ws}:pulls:{projectId}` — workspace first, like every key `sameWorkspace` reads (#742). */

import { workspaceOfKey, type ProjectId, type WorkspaceId } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const PULLS_TYPE = 'pulls';

const MARKER = ':pulls:';

export function pullsKey(workspaceId: WorkspaceId | string, projectId: ProjectId | string): string {
    return `${workspaceId}${MARKER}${projectId}`;
}

/** A `{ws}:pulls:{project}` key → its parts, or `null` for any other shape. */
export function parsePullsKey(key: string): { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId } | null {
    const ws = workspaceOfKey(key);
    if (ws === null || !key.startsWith(`${ws}${MARKER}`)) return null;
    const projectId = key.slice(ws.length + MARKER.length);
    return projectId ? { workspaceId: ws, projectId: projectId as ProjectId } : null;
}
