/**
 * The shell's connection strip in live mode (#46, OPS-04 "the always-visible
 * half"): this browser's socket (`clientConnection`) first, then every
 * paired machine of the workspace with `Machine.online` and its session
 * count — the rows the design track's `ConnectionStrip` draws
 * (`connectionRows` in `@agentic/ui`). The machine list is the Workspace
 * index read live; each machine's record is a live read of its own
 * (`MachineWatch`, renderless), so a daemon dropping its socket flips its
 * row without a reload.
 */
import { component, effect, onUnmounted, signal, type JSXElement } from 'sigx';
import { useActorState } from '@sigx/actors/app';
import { ConnectionStrip, connectionRows, type MachineConnection } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';
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

/** Renderless: keeps one machine's presence in the shared map through a live read of `Machine.get`. */
const MachineWatch = component<{ id: string; workspaceId: string; onPresence: (id: string, p: MachinePresence) => void }>(({ props }) => {
    const defs = useActorDefs();
    const view = useActorState(defs.Machine, () => [machineKeyOf(props.workspaceId, props.id), 'get'] as const, { live: true });
    const stop = effect(() => {
        const v = view.value;
        if (v) props.onPresence(props.id, { online: v.online, sessions: v.activeSessions.length, ...(v.lastSeen !== undefined ? { lastSeen: v.lastSeen } : {}) });
    });
    onUnmounted(stop);
    return (): JSXElement => null;
});

export const LiveConnection = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const machines = useActorState(defs.Workspace, () => { const ws = viewer.workspaceId; return ws && ([workspaceKeyOf(ws), 'listMachines'] as const); }, { live: true });
    const presence = signal<{ map: Record<string, MachinePresence> }>({ map: {} });
    const report = (id: string, p: MachinePresence): void => {
        const prev = presence.map[id];
        if (prev && prev.online === p.online && prev.sessions === p.sessions && prev.lastSeen === p.lastSeen) return;
        presence.map = { ...presence.map, [id]: p };
    };
    return (): JSXElement => {
        const ws = viewer.workspaceId;
        const list = machines.value ?? [];
        const rows = connectionRows(clientConnection(), machineRowsOf(list, presence.map, Date.now()));
        return (
            <>
                <ConnectionStrip rows={rows} />
                {ws ? list.filter((m) => m.status === 'paired').map((m) => <MachineWatch id={m.id} workspaceId={ws} onPresence={report} />) : null}
            </>
        );
    };
});
