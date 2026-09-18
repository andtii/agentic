/**
 * The actor keys the pages address (architecture §4), spelled here from
 * `@agentic/core`'s `actorKey` so the browser bundle never imports
 * `@agentic/platform` for a string. Each mirrors the platform's own helper
 * (`workspaceKey`, `agentKey`, `taskKey`, `routingKey`) and the smoke test
 * in `__tests__/pages/chat-live.test.tsx` pins them against those.
 */
import { actorKey, type WorkspaceId } from '@agentic/core';

export const workspaceKeyOf = (ws: string): string => `ws:${ws}`;
export const chatKeyOf = (ws: string, id: string): string => actorKey(ws as WorkspaceId, 'chat', id);
export const agentKeyOf = (ws: string, id: string): string => actorKey(ws as WorkspaceId, 'agent', id);
export const taskKeyOf = (ws: string, id: string): string => actorKey(ws as WorkspaceId, 'task', id);
export const sessionKeyOf = (ws: string, id: string): string => actorKey(ws as WorkspaceId, 'session', id);
export const routingKeyOf = (ws: string): string => `${ws}:routing:main`;
export const inboxKeyOf = (ws: string): string => `${ws}:inbox`;
export const machineKeyOf = (ws: string, id: string): string => `${ws}:machine:${id}`;
export const scheduleKeyOf = (ws: string, id: string): string => `${ws}:schedule:${id}`;
export const registryKeyOf = (ws: string): string => `${ws}:registry`;
export const taskIndexKeyOf = (ws: string): string => `${ws}:task-index`;
export const auditKeyOf = (ws: string): string => `${ws}:audit`;
/** `month` is `yyyy-mm` in UTC (`ledgerMonthOf`). */
export const ledgerKeyOf = (ws: string, month: string): string => `${ws}:ledger:${month}`;
/** The UTC `yyyy-mm` an instant falls in — the platform's `ledgerMonth`. */
export const ledgerMonthOf = (at: number): string => {
    const d = new Date(at);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
