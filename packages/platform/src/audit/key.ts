/**
 * Audit actor keys (architecture §4 Audit). One LIVE log per workspace,
 * `{ws}:audit`, holding the most recent events and the history page's live
 * read; older events roll over into one ARCHIVE actor per UTC month,
 * `{ws}:audit:{yyyy-mm}`, written by the live actor when its window
 * overflows and read back by `list` when a cursor walks past the window.
 */

import type { WorkspaceId } from '@agentic/core';

/** The actor `type` — the wire, directory and storage name. */
export const AUDIT_TYPE = 'audit';

/** The live log of workspace `ws`: `{ws}:audit`. */
export function auditKey(workspaceId: WorkspaceId | string): string {
    return `${workspaceId}:${AUDIT_TYPE}`;
}

/** The archive of one UTC month: `{ws}:audit:{yyyy-mm}`. */
export function auditMonthKey(workspaceId: WorkspaceId | string, month: string): string {
    return `${workspaceId}:${AUDIT_TYPE}:${month}`;
}

/** The `yyyy-mm` an instant falls in, in UTC — months are UTC so an event has one archive whatever the workspace zone. */
export function auditMonth(at: number): string {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) throw new RangeError(`auditMonth: not an instant: ${String(at)}`);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface ParsedAuditKey {
    readonly workspaceId: WorkspaceId;
    /** Set for an archive key; absent for the live log. */
    readonly month?: string;
}

/** Split an audit key into its workspace and (for an archive) its month; `null` for any other shape. */
export function parseAuditKey(key: string): ParsedAuditKey | null {
    const parts = key.split(':');
    if (!parts[0] || parts[1] !== AUDIT_TYPE) return null;
    if (parts.length === 2) return { workspaceId: parts[0] as WorkspaceId };
    if (parts.length === 3 && MONTH.test(parts[2]!)) return { workspaceId: parts[0] as WorkspaceId, month: parts[2]! };
    return null;
}
