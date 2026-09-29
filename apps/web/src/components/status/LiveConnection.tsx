/**
 * The shell's connection strip in live mode (#46, OPS-04 "the always-visible
 * half"): this browser's socket (`clientConnection`) first, then every
 * paired machine of the workspace with `Machine.online` and its session
 * count — the rows the design track's `ConnectionStrip` draws
 * (`connectionRows` in `@agentic/ui`). The machine list is the Workspace
 * index read live; each machine's record is the machines store's live
 * `Machine.get` (#1120), so a daemon dropping its socket flips its row
 * without a reload.
 */
import { component, type JSXElement } from 'sigx';
import type { MachineView } from '@agentic/platform';
import { ConnectionStrip, connectionRows, type MachineConnection } from '@agentic/ui';
import { useMachineStore, useWorkspaceStore } from '@agentic/client';
import { clientConnection } from './client';

export interface MachinePresence {
    readonly online: boolean;
    readonly sessions: number;
    readonly lastSeen?: number;
}

/** A relative age for the strip: `3m`, `2h`, `4d`. */
export function ageLabel(lastSeen: number | undefined, now: number): string | undefined {
    if (lastSeen === undefined) return undefined;
    const m = Math.max(0, Math.round((now - lastSeen) / 60_000));
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The strip's machine rows from the index and what each watch reported. */
export function machineRowsOf(machines: readonly { readonly id: string; readonly name: string; readonly status: string }[], presence: Readonly<Record<string, MachinePresence>>, now: number): MachineConnection[] {
    return machines
        .filter((m) => m.status === 'paired')
        .map((m) => {
            const p = presence[m.id];
            const lastSeen = ageLabel(p?.lastSeen, now);
            // A count only while there is one: an idle machine reads `online`, never "0 sessions" (the strip's own rule).
            return { id: m.id, name: m.name, online: p?.online ?? false, ...(p?.online && p.sessions > 0 ? { sessions: p.sessions } : {}), ...(lastSeen ? { lastSeen } : {}) };
        });
}

/** Each machine's presence from its record. */
export function presenceOf(views: Readonly<Record<string, MachineView>>): Record<string, MachinePresence> {
    const out: Record<string, MachinePresence> = {};
    for (const [id, v] of Object.entries(views)) out[id] = { online: v.online, sessions: v.activeSessions.length, ...(v.lastSeen !== undefined ? { lastSeen: v.lastSeen } : {}) };
    return out;
}

export const LiveConnection = component(() => {
    const machines = useWorkspaceStore().machinesRead;
    const store = useMachineStore();
    return (): JSXElement => {
        const list = machines.value ?? [];
        const rows = connectionRows(clientConnection(), machineRowsOf(list, presenceOf(store.views), Date.now()));
        return <ConnectionStrip rows={rows} />;
    };
});
