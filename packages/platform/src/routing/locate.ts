/**
 * Where an environment lives: the machine of the workspace that reports it
 * (`Machine.get().environments`), found by scanning the Workspace's machine
 * index. Environment ids are minted per daemon, so two machines may report the
 * same id (#414): a caller that knows the machine asks for it first
 * (`preferMachineId`); otherwise the first machine of the index wins. Shared
 * by the router (`run`) and the schedule trigger's `EnvironmentProbe` (#42),
 * so both answer the same question the same way.
 */

import type { EnvironmentDescriptor, EnvironmentId, MachineId, Principal, WorkspaceId } from '@agentic/core';
import { actor, type AnyActorDefinition } from '@sigx/actors';

import { asPrincipal, userPrincipal, workspaceKey } from '../auth/index.js';
import { machineKey, type MachineView } from '../machine/index.js';
import type { EnvironmentProbe } from '../schedule/index.js';
import { Workspace } from '../workspace/index.js';

export interface LocatedEnvironment {
    readonly machine: MachineView;
    readonly env: EnvironmentDescriptor;
}

export interface EnvironmentProbeOptions {
    /** The Machine actor definition this app built (`defineMachineActor`). */
    readonly machines: () => AnyActorDefinition;
    /** The principal the scan runs as. Default: the workspace's user (v1: `workspaceId === userId`). */
    readonly driver?: (workspaceId: WorkspaceId) => Principal;
}

interface MachineGetClient {
    get(): Promise<MachineView>;
}

interface LocateOptions {
    readonly machines: () => AnyActorDefinition;
    readonly driver: Principal;
    /** Asked first (#414): the machine a task names is the one that tells colliding ids apart. */
    readonly preferMachineId?: MachineId;
}

/**
 * The machine reporting `environmentId`, with the descriptor, or `null` when no machine of the workspace does —
 * the preferred machine first when one is named, then the index in order.
 */
export async function locateEnvironment(workspaceId: WorkspaceId, environmentId: EnvironmentId, options: LocateOptions): Promise<LocatedEnvironment | null> {
    const context = asPrincipal(options.driver);
    const listed = await actor(Workspace, workspaceKey(workspaceId)).with({ context }).listMachines();
    const ordered = options.preferMachineId === undefined ? listed : [...listed.filter((e) => e.id === options.preferMachineId), ...listed.filter((e) => e.id !== options.preferMachineId)];
    for (const entry of ordered) {
        const m = await (actor(options.machines(), machineKey(workspaceId, entry.id)).with({ context }) as unknown as MachineGetClient).get();
        const env = m.environments.find((e) => e.id === environmentId);
        if (env) return { machine: m, env };
    }
    return null;
}

/** The view of one machine the Workspace index lists as paired (#414), or `null` when it lists no such machine or the machine is revoked. */
export async function readMachine(workspaceId: WorkspaceId, machineId: MachineId, options: Pick<LocateOptions, 'machines' | 'driver'>): Promise<MachineView | null> {
    const context = asPrincipal(options.driver);
    const listed = await actor(Workspace, workspaceKey(workspaceId)).with({ context }).listMachines();
    if (!listed.some((e) => e.id === machineId && e.status === 'paired')) return null;
    const m = await (actor(options.machines(), machineKey(workspaceId, machineId)).with({ context }) as unknown as MachineGetClient).get();
    return m.revoked ? null : m;
}

/** The schedule trigger's `EnvironmentProbe` over the Machines: online when a machine reports the environment and is connected. */
export function createEnvironmentProbe(options: EnvironmentProbeOptions): EnvironmentProbe {
    const driverOf = options.driver ?? ((ws: WorkspaceId): Principal => userPrincipal(ws, ws));
    return {
        async isOnline(workspaceId, environmentId) {
            const found = await locateEnvironment(workspaceId, environmentId, { machines: options.machines, driver: driverOf(workspaceId) });
            return found !== null && found.machine.online;
        }
    };
}
