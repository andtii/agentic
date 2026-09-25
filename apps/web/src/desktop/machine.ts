/**
 * "This computer" on `/machines` (#846). Machines belong to the account's
 * workspace however they were paired, from the web or from the app; the
 * desktop app only adds which one, if any, is the computer it runs on.
 */
import type { LocalMachine } from './bridge';

/** What the desktop app knows about this computer: `null` in a browser. */
export type ThisComputer = { readonly local: LocalMachine | null } | null;

/** Whether the machine `machineId` of workspace `workspaceId` is the computer the app runs on. */
export function isThisComputer(here: ThisComputer, workspaceId: string | undefined, machineId: string): boolean {
    return !!here?.local && here.local.workspaceId === workspaceId && here.local.machineId === machineId;
}

/**
 * Whether to offer "Pair this computer": in the app, signed in, and no daemon here is paired to this
 * workspace — none at all, one paired to another workspace, or one this workspace has since revoked.
 */
export function offerPairing(here: ThisComputer, workspaceId: string | undefined, pairedIds: readonly string[]): boolean {
    if (!here || !workspaceId) return false;
    const local = here.local;
    return !local || local.workspaceId !== workspaceId || !pairedIds.includes(local.machineId);
}
