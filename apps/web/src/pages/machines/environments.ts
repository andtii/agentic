/**
 * The workspace's environments as picker options (#144): one live read of
 * the Workspace's machine index, then `Machine.get()` per paired machine in
 * one `useData` fetch — what the agent Config tab's "Default environment"
 * select offers for `execution.defaultEnvironmentId`.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { FieldOption } from '@agentic/ui';
import type { MachineView } from '@agentic/platform';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';
import { environmentOptions } from './live';

export interface EnvironmentOptions {
    /** Every environment of every paired machine; empty until the reads land. */
    options(): FieldOption[];
    readonly loading: boolean;
}

export function useEnvironmentOptions(defs: ActorDefs, viewer: ViewerState): EnvironmentOptions {
    const index = useActorState(defs.Workspace, () => { const ws = viewer.workspaceId; return ws && ([workspaceKeyOf(ws), 'listMachines'] as const); }, { live: true });
    const machines = useData(
        () => {
            const ws = viewer.workspaceId;
            const ids = index.value?.filter((m) => m.status === 'paired').map((m) => m.id);
            return ws && ids ? (['machine-environments', ws, ...ids] as const) : false;
        },
        async (key): Promise<FieldOption[]> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const views = await Promise.all(
                ids.map(async (id): Promise<MachineView | null> => {
                    try {
                        return await actor(defs.Machine, machineKeyOf(ws, id)).get();
                    } catch {
                        // Revoked or gone: nothing to offer from it.
                        return null;
                    }
                })
            );
            return environmentOptions(views.filter((v): v is MachineView => v !== null && !v.revoked));
        }
    );
    return {
        options: () => machines.value ?? [],
        get loading() {
            return index.loading || machines.loading;
        }
    };
}
