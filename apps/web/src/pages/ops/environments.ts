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
import type { EnvironmentDescriptor, HostOs } from '@agentic/core';
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
}

export interface EnvironmentDirectory {
    /** The entry for an environment id, or `null` while unknown (machine offline for good, or still loading). */
    lookup(id: string): EnvironmentEntry | null;
    /** Every environment of every paired machine, machine order. */
    all(): EnvironmentEntry[];
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
        async (key): Promise<EnvironmentEntry[]> => {
            const [, ws, ...ids] = key as readonly [string, string, ...string[]];
            const out: EnvironmentEntry[] = [];
            await Promise.all(
                ids.map(async (machineId) => {
                    try {
                        const m = await actor(defs.Machine, machineKeyOf(ws, machineId)).get();
                        for (const d of m.environments) {
                            out.push({
                                id: d.id,
                                machineId,
                                machineName: m.name,
                                online: m.online,
                                ...(m.os ? { os: m.os } : {}),
                                descriptor: d,
                                line: { machine: m.name, runtime: d.runtime, account: d.account.label },
                                label: `${m.name} / ${d.runtime} / ${d.account.label}`
                            });
                        }
                    } catch {
                        // Not paired yet, or gone: its environments are not offered.
                    }
                })
            );
            return out.sort((a, b) => ids.indexOf(a.machineId) - ids.indexOf(b.machineId) || a.id.localeCompare(b.id));
        }
    );
    return {
        lookup: (id) => (entries.value ?? []).find((e) => e.id === id) ?? null,
        all: () => entries.value ?? [],
        get loading() {
            return index.loading || entries.loading;
        }
    };
}
