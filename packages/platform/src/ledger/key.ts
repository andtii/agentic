/** Ledger actor keys: `{ws}:ledger:{yyyy-mm}` (architecture §4) — one actor per workspace and calendar month. */

import type { WorkspaceId } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const LEDGER_TYPE = 'ledger';

/** The `yyyy-mm` an instant falls in, in UTC. Months are UTC so a row has one ledger whatever the workspace zone. */
export function ledgerMonth(at: number): string {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) throw new RangeError(`ledgerMonth: not an instant: ${String(at)}`);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function ledgerKey(workspaceId: WorkspaceId, month: string): string {
    return `${workspaceId}:${LEDGER_TYPE}:${month}`;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Split a ledger key into its workspace and month; `null` for any other shape. */
export function parseLedgerKey(key: string): { readonly workspaceId: WorkspaceId; readonly month: string } | null {
    const parts = key.split(':');
    if (parts.length !== 3 || parts[1] !== LEDGER_TYPE || !parts[0] || !MONTH.test(parts[2]!)) return null;
    return { workspaceId: parts[0] as WorkspaceId, month: parts[2]! };
}
