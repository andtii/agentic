/**
 * The environments a folder can be picked in (#193), on either data source:
 * live, the workspace's environment directory (`useEnvironmentDirectory`,
 * one `Machine.get()` per paired machine); on mock data, `mock/ops.ts`.
 * `machineOf` is where a folder request for an environment goes.
 */
import type { WorkdirEnvironment } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { opsEnvironments, opsMachine, opsQuota } from '../../mock/ops';
import { useEnvironmentDirectory, type EnvironmentEntry } from '../ops/environments';
import { workdirEnvironmentsOf } from './model';

export interface WorkdirEnvironments {
    list(): WorkdirEnvironment[];
    machineOf(environmentId: string): string | undefined;
    readonly loading: boolean;
}

export function useLiveWorkdirEnvironments(defs: Pick<ActorDefs, 'Workspace' | 'Machine'>, viewer: Pick<ViewerState, 'workspaceId'>): WorkdirEnvironments {
    const directory = useEnvironmentDirectory(defs, viewer);
    return {
        list: () => workdirEnvironmentsOf(directory.all()),
        machineOf: (id) => directory.lookup(id)?.machineId,
        get loading() {
            return directory.loading;
        }
    };
}

/** The mock machines' environments as directory entries: the same adapter as live. */
const mockEntries: readonly EnvironmentEntry[] = opsEnvironments.map((d) => {
    const m = opsMachine(d.machineId);
    return {
        id: d.id,
        machineId: d.machineId,
        machineName: m?.name ?? d.machineId,
        online: m?.online ?? false,
        ...(m?.os ? { os: m.os } : {}),
        descriptor: d,
        line: { machine: m?.name ?? d.machineId, runtime: d.runtime, account: d.account.label },
        label: `${m?.name ?? d.machineId} / ${d.runtime} / ${d.account.label}`,
        quota: opsQuota[d.id] ?? null
    };
});

export const mockWorkdirEnvironments: WorkdirEnvironments = {
    list: () => workdirEnvironmentsOf(mockEntries),
    machineOf: (id) => mockEntries.find((e) => e.id === id)?.machineId,
    loading: false
};
