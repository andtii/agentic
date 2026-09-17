/** The Routing actor's key: one router per workspace, `{ws}:routing:main`. */

import type { WorkspaceId } from '@agentic/core';

export const ROUTING_TYPE = 'routing';
const SUFFIX = ':routing:main';

export function routingKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}${SUFFIX}`;
}

/** The workspace a `{ws}:routing:main` key names, or `null` for any other shape. */
export function parseRoutingKey(key: string): { readonly workspaceId: WorkspaceId } | null {
    if (!key.endsWith(SUFFIX)) return null;
    const ws = key.slice(0, -SUFFIX.length);
    return ws && !ws.includes(':') ? { workspaceId: ws as WorkspaceId } : null;
}
