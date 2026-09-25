/** Plan actor keys: `{ws}:plan:{projectId}` — workspace first, like every key `sameWorkspace` reads (#750). */

import { workspaceOfKey, type ProjectId, type WorkspaceId } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const PLAN_TYPE = 'plan';

const MARKER = ':plan:';

/** One Plan actor per project; it holds every plan of the project. */
export function planKey(workspaceId: WorkspaceId | string, projectId: ProjectId | string): string {
    return `${workspaceId}${MARKER}${projectId}`;
}

/** A `{ws}:plan:{project}` key → its parts, or `null` for any other shape. */
export function parsePlanKey(key: string): { readonly workspaceId: WorkspaceId; readonly projectId: ProjectId } | null {
    const ws = workspaceOfKey(key);
    if (ws === null || !key.startsWith(`${ws}${MARKER}`)) return null;
    const projectId = key.slice(ws.length + MARKER.length);
    return projectId ? { workspaceId: ws, projectId: projectId as ProjectId } : null;
}
