/** Registry actor keys: `{ws}:registry` (architecture §4). */

import type { WorkspaceId } from '@agentic/core';
import { workspaceOfKey } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const REGISTRY_TYPE = 'Registry';

const SUFFIX = ':registry';

export function registryKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}${SUFFIX}`;
}

/** The workspace of a `{ws}:registry` key, or `null` for any other shape. */
export function parseRegistryKey(key: string): WorkspaceId | null {
    if (!key.endsWith(SUFFIX) || key.length === SUFFIX.length) return null;
    const ws = workspaceOfKey(key);
    return ws !== null && `${ws}${SUFFIX}` === key ? ws : null;
}
