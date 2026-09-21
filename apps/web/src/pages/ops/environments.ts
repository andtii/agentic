/**
 * The workspace's environments as a lookup (#145): the Workspace's machine
 * index (live), then `Machine.get()` per paired machine in one `useData`
 * fetch — the shape the Schedules "Runs on" column and the Settings
 * default-environment select resolve ids through, the way the chat
 * directory resolves agents.
 */
import { useData } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { accountDirectory, environmentsForAccount, type AccountEntry, type AccountRef, type EnvironmentDescriptor, type HostOs, type QuotaSnapshot, type RuntimeId } from '@agentic/core';
import type { EnvironmentParts } from '@agentic/ui';
import type { ActorDefs, ViewerState } from '../../actors/defs';
import { machineKeyOf, workspaceKeyOf } from '../../actors/keys';

export interface EnvironmentEntry {
    readonly id: string;
    readonly machineId: string;
    readonly machineName: string;
    readonly online: boolean;
    /** What the daemon said in `hello`; absent until it has connected once. Paths follow its rules (#193). */
    readonly os?: HostOs;
    readonly descriptor: EnvironmentDescriptor;
    /** The environment line's three parts. */
    readonly line: EnvironmentParts;
    /** "alien01 / claude-code / work" — the select's label. */
    readonly label: string;
    /** Its account's provider limits as the machine last reported them (#315); `null` before the first report. */
    readonly quota?: QuotaSnapshot | null;
}

/** One paired machine as the directory lists it (#414): a machine that never connected has no environments yet. */
export interface MachineEntry {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly os?: HostOs;
    readonly environments: readonly EnvironmentDescriptor[];
}

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

export function useEnvironmentDirectory(defs: Pick<ActorDefs, 'Workspace' | 'Machine'>, viewer: Pick<ViewerState, 'workspaceId'>): EnvironmentDirectory {
    const index = useActorState(defs.Workspace, () => viewer.workspaceId && ([workspaceKeyOf(viewer.workspaceId), 'get'] as const), { live: true });
    const entries = useData(
        () => {
            const ws = viewer.workspaceId;
            const machines = index.value?.machines;
            return ws && machines ? (['environments', ws, ...machines.filter((m) => m.status === 'paired').map((m) => m.id)] as const) : false;
        },
        async (key): Promise<{ entries: EnvironmentEntry[]; machines: MachineEntry[] }> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const out: EnvironmentEntry[] = [];
            const machines: MachineEntry[] = [];
            await Promise.all(
                ids.map(async (machineId) => {
                    try {
                        const m = await actor(defs.Machine, machineKeyOf(ws, machineId)).get();
                        if (m.revoked) return;
                        machines.push({ id: machineId, name: m.name, online: m.online, ...(m.os ? { os: m.os } : {}), environments: m.environments });
                        for (const d of m.environments) {
                            out.push({
                                id: d.id,
                                machineId,
                                machineName: m.name,
                                online: m.online,
                                ...(m.os ? { os: m.os } : {}),
                                descriptor: d,
                                line: { machine: m.name, runtime: d.runtime, account: d.account.label },
                                label: `${m.name} / ${d.runtime} / ${d.account.label}`,
                                quota: m.quota?.[d.id] ?? null
                            });
                        }
                    } catch {
                        // Not paired yet, or gone: its environments are not offered.
                    }
                })
            );
            return {
                entries: out.sort((a, b) => ids.indexOf(a.machineId) - ids.indexOf(b.machineId) || a.id.localeCompare(b.id)),
                machines: machines.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
            };
        }
    );
    const all = () => entries.value?.entries ?? [];
    const machines = () => entries.value?.machines ?? [];
    return {
        lookup: (id) => all().find((e) => e.id === id) ?? null,
        lookupOn: (machineId, id) => all().find((e) => e.machineId === machineId && e.id === id) ?? null,
        all,
        machines,
        accounts: () => accountDirectory(machines().map((m) => ({ machineId: m.id as never, environments: m.environments }))),
        hosted: (machineId, id) => all().some((e) => e.machineId === machineId && e.id === id),
        accountEnvironment: (machineId, runtime, ref) => {
            const m = machines().find((x) => x.id === machineId);
            const env = m ? environmentsForAccount(m.environments, runtime, ref)[0] : undefined;
            return env ? (all().find((e) => e.machineId === machineId && e.id === env.id) ?? undefined) : undefined;
        },
        lastMachineId: () => index.value?.lastMachineId ?? null,
        get loading() {
            return index.loading || entries.loading;
        }
    };
}
