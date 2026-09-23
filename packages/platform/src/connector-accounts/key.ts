/** ConnectorAccounts actor keys: `{ws}:connector-accounts` (architecture §4, §9 "connectors that sign in"). */

import type { WorkspaceId } from '@agentic/core';
import { workspaceOfKey } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const CONNECTOR_ACCOUNTS_TYPE = 'ConnectorAccounts';

const SUFFIX = ':connector-accounts';

export function connectorAccountsKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}${SUFFIX}`;
}

/** The workspace of a `{ws}:connector-accounts` key, or `null` for any other shape. */
export function parseConnectorAccountsKey(key: string): WorkspaceId | null {
    if (!key.endsWith(SUFFIX) || key.length === SUFFIX.length) return null;
    const ws = workspaceOfKey(key);
    return ws !== null && `${ws}${SUFFIX}` === key ? ws : null;
}
