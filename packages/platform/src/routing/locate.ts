/**
 * Where an environment lives: the machine of the workspace that reports it
 * (`Machine.get().environments`), found by scanning the Workspace's machine
 * index. Ids are unique per workspace by design, so the first hit is the
 * one. Shared by the router (`run`) and the schedule trigger's
 * `EnvironmentProbe` (#42), so both answer the same question the same way.
 */

import type { EnvironmentDescriptor, EnvironmentId, Principal, WorkspaceId } from '@agentic/core';
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

/** The machine reporting `environmentId`, with the descriptor, or `null` when no machine of the workspace does. */
export async function locateEnvironment(
    workspaceId: WorkspaceId,
    environmentId: EnvironmentId,
    options: { readonly machines: () => AnyActorDefinition; readonly driver: Principal }
): Promise<LocatedEnvironment | null> {
    const context = asPrincipal(options.driver);
    const listed = await actor(Workspace, workspaceKey(workspaceId)).with({ context }).listMachines();
    for (const entry of listed) {
        const m = await (actor(options.machines(), machineKey(workspaceId, entry.id)).with({ context }) as unknown as MachineGetClient).get();
        const env = m.environments.find((e) => e.id === environmentId);
        if (env) return { machine: m, env };
    }
    return null;
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
