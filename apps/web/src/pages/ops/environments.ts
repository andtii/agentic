/**
 * The workspace's environments as a lookup (#145): the Schedules "Runs on"
 * column and the Settings default-environment select resolve ids through it,
 * the way the chat directory resolves agents. The machines store (#1120,
 * `useMachineStore` in `@agentic/client`) owns the reads — the Workspace's
 * machine index, then each paired machine's `Machine.get`, fetched once and
 * kept live for the app's lifetime; this is its thin wrapper.
 */
import type { AccountEntry, AccountRef, RuntimeId } from '@agentic/core';
import { useMachineStore, useWorkspaceStore, type EnvironmentEntry, type MachineEntry } from '@agentic/client';
import type { ActorDefs, ViewerState } from '../../actors/defs';

export type { EnvironmentEntry, MachineEntry };

export interface EnvironmentDirectory {
    /** The entry for an environment id, or `null` while unknown (machine offline for good, or still loading). */
    lookup(id: string): EnvironmentEntry | null;
    /** The entry for an environment id AS ONE MACHINE reports it (#414): ids are minted per daemon, so two machines may report the same one. */
    lookupOn(machineId: string, id: string): EnvironmentEntry | null;
    /** Every environment of every paired machine, machine order. */
    all(): EnvironmentEntry[];
    /** Every paired machine, index order, with what it reports. */
    machines(): MachineEntry[];
    /** The accounts the machines report (#414, `accountDirectory`): the same login on two machines is one entry. */
    accounts(): AccountEntry[];
    /** Whether `machineId` reports environment `id`. */
    hosted(machineId: string, id: string): boolean;
    /** The environment of `ref` on `machineId` for `runtime` — the one the router would take (#414) — or `undefined`. */
    accountEnvironment(machineId: string, runtime: RuntimeId, ref: AccountRef): EnvironmentEntry | undefined;
    /** `Workspace.get().lastMachineId`: what the New chat picker preselects. */
    lastMachineId(): string | null;
    readonly loading: boolean;
}

/** The directory over the machines store. `defs` and `viewer` stay in the signature for the call sites; the store reads its own. */
export function useEnvironmentDirectory(_defs: Pick<ActorDefs, 'Workspace' | 'Machine'>, _viewer: Pick<ViewerState, 'workspaceId'>): EnvironmentDirectory {
    const store = useMachineStore();
    const workspace = useWorkspaceStore();
    const all = (): EnvironmentEntry[] => [...store.environments];
    return {
        lookup: (id) => store.environments.find((e) => e.id === id) ?? null,
        lookupOn: (machineId, id) => store.environments.find((e) => e.machineId === machineId && e.id === id) ?? null,
        all,
        machines: () => [...store.machines],
        accounts: () => store.accounts(),
        hosted: (machineId, id) => store.environments.some((e) => e.machineId === machineId && e.id === id),
        accountEnvironment: (machineId, runtime, ref) => store.accountEnvironment(machineId, runtime, ref),
        lastMachineId: () => workspace.view?.lastMachineId ?? null,
        get loading() {
            return store.loading;
        }
    };
}
