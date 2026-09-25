/**
 * The environments a folder can be picked in (#193), on either data source:
 * live, the workspace's environment directory (`useEnvironmentDirectory`,
 * one `Machine.get()` per paired machine); on mock data, `mock/ops.ts`.
 * `machineOf` is where a folder request for an environment goes.
 */
import { accountDirectory, environmentsForAccount, type AccountEntry, type AccountRef, type RuntimeId } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { opsEnvironments, opsMachine, opsMachines, opsQuota } from '../../mock/ops';
import { useEnvironmentDirectory, type EnvironmentEntry, type MachineEntry } from '../ops/environments';
import type { ProjectMachine } from '../projects/model';
import { workdirEnvironmentOf, workdirEnvironmentsOf } from './model';

export interface WorkdirEnvironments {
    list(): WorkdirEnvironment[];
    machineOf(environmentId: string): string | undefined;
    /** Every machine with the environments it reports (#702: an environment id is only unique on its machine) — the project folder rows. */
    projectMachines(): ProjectMachine[];
    /** The paired machines and what they report (#414): the New chat picker's choices. */
    machines(): MachineEntry[];
    /** The accounts across them (#414). */
    accounts(): AccountEntry[];
    /** Whether `machineId` reports environment `id` (#414). */
    hosted(machineId: string, id: string): boolean;
    /** The environment id of `ref` on `machineId` for `runtime` — the one the router takes (#414) — or `undefined`. */
    accountEnvironment(machineId: string, runtime: RuntimeId, ref: AccountRef): string | undefined;
    /** `Workspace.get().lastMachineId` (#414). */
    lastMachineId(): string | null;
    readonly loading: boolean;
}

/** Directory entries grouped by machine, in the directory's order. */
export function projectMachinesOf(entries: readonly EnvironmentEntry[]): ProjectMachine[] {
    const out = new Map<string, { id: string; name: string; environments: WorkdirEnvironment[] }>();
    for (const e of entries) {
        const m = out.get(e.machineId) ?? { id: e.machineId, name: e.machineName, environments: [] };
        m.environments.push(workdirEnvironmentOf(e));
        out.set(e.machineId, m);
    }
    return [...out.values()];
}

export function useLiveWorkdirEnvironments(defs: Pick<ActorDefs, 'Workspace' | 'Machine'>, viewer: Pick<ViewerState, 'workspaceId'>): WorkdirEnvironments {
    const directory = useEnvironmentDirectory(defs, viewer);
    return {
        list: () => workdirEnvironmentsOf(directory.all()),
        machineOf: (id) => directory.lookup(id)?.machineId,
        projectMachines: () => projectMachinesOf(directory.all()),
        machines: () => directory.machines(),
        accounts: () => directory.accounts(),
        hosted: (machineId, id) => directory.hosted(machineId, id),
        accountEnvironment: (machineId, runtime, ref) => directory.accountEnvironment(machineId, runtime, ref)?.id,
        lastMachineId: () => directory.lastMachineId(),
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

const mockMachines: readonly MachineEntry[] = opsMachines.map((m) => ({ id: m.id, name: m.name, online: m.online, ...(m.os ? { os: m.os } : {}), environments: opsEnvironments.filter((d) => d.machineId === m.id) }));

export const mockWorkdirEnvironments: WorkdirEnvironments = {
    list: () => workdirEnvironmentsOf(mockEntries),
    machineOf: (id) => mockEntries.find((e) => e.id === id)?.machineId,
    projectMachines: () => projectMachinesOf(mockEntries),
    machines: () => [...mockMachines],
    accounts: () => accountDirectory(mockMachines.map((m) => ({ machineId: m.id as never, environments: m.environments }))),
    hosted: (machineId, id) => mockEntries.some((e) => e.machineId === machineId && e.id === id),
    accountEnvironment: (machineId, runtime, ref) => {
        const m = mockMachines.find((x) => x.id === machineId);
        return m ? environmentsForAccount(m.environments, runtime, ref)[0]?.id : undefined;
    },
    lastMachineId: () => null,
    loading: false
};
