/**
 * The PairingDirectory — `global:pairing` (architecture §4 Workspace, §9;
 * USR-04, issue #37). The one actor a pairing code can be looked up in
 * without knowing the workspace: `POST /auth/pair` is anonymous and the code
 * alone names no workspace, so `Workspace.registerMachinePending` files
 * every code here over a hop and the route resolves it to the machine it
 * was issued for, then redeems it with `Machine.pair(code, info)` (which
 * consumes the Workspace's own record). Single use, 10-minute TTL — the
 * same rules the Workspace enforces, applied a second time at the door.
 *
 * Only the mapping lives here (no token, no hash); save persistence, every
 * mutation ends in `ctx.save()` inside the turn.
 */

import type { MachineId, Principal, WorkspaceId } from '@agentic/core';
import { defineActor, type ActorPolicy } from '@sigx/actors';

export const PAIRING_DIRECTORY_TYPE = 'PairingDirectory';
/** The single directory every workspace files its codes in. */
export const PAIRING_DIRECTORY_KEY = 'global:pairing';

/** Whom a code was issued for. */
export interface PairingTarget {
    readonly workspaceId: WorkspaceId;
    readonly machineId: MachineId;
}

export interface PairingDirectoryEntry extends PairingTarget {
    readonly expiresAt: number;
}

export interface PairingDirectoryState {
    v: 1;
    /** By the code as issued (uppercase, no separators). */
    codes: Record<string, PairingDirectoryEntry>;
}

/** Uppercase, strip separators and whitespace — what a user typed becomes what was issued. */
export function normalizeDirectoryCode(code: string): string {
    return code.toUpperCase().replace(/[\s-]+/g, '');
}

/**
 * `resolve` is the anonymous door (`POST /auth/pair`): the code is the
 * proof, as on the route itself. Everything else is the workspace user's —
 * in practice the `Workspace.registerMachinePending` hop, which carries the
 * user's principal.
 */
const directoryPolicy: ActorPolicy = (principal: Principal | null, _rq, op) => {
    const method = (op.resource as { method?: string } | undefined)?.method;
    if (method === 'resolve') return true;
    return principal?.kind === 'user';
};

export const PairingDirectory = defineActor({
    type: PAIRING_DIRECTORY_TYPE,
    allowAnonymous: true,
    authorize: [directoryPolicy],
    persistence: 'explicit',
    state: (): PairingDirectoryState => ({ v: 1, codes: {} }),
    methods: (ctx) => {
        const prune = (now: number): void => {
            for (const [code, entry] of Object.entries(ctx.state.codes)) if (entry.expiresAt <= now) delete ctx.state.codes[code];
        };

        return {
            /** File a code the Workspace just issued. A code already filed is replaced (codes are random; a collision is a reissue). */
            async register(code: string, entry: PairingDirectoryEntry): Promise<void> {
                const now = Date.now();
                prune(now);
                ctx.state.codes[normalizeDirectoryCode(code)] = { workspaceId: entry.workspaceId, machineId: entry.machineId, expiresAt: entry.expiresAt };
                await ctx.save();
            },

            /**
             * The machine a live code was issued for — and the code is gone from
             * here: single use. `null` for an unknown, used or expired code; the
             * caller cannot tell which, by design.
             */
            async resolve(code: string): Promise<PairingTarget | null> {
                const now = Date.now();
                prune(now);
                const key = normalizeDirectoryCode(code);
                const entry = ctx.state.codes[key];
                if (!entry) {
                    await ctx.save();
                    return null;
                }
                delete ctx.state.codes[key];
                await ctx.save();
                return { workspaceId: entry.workspaceId, machineId: entry.machineId };
            },

            /** Live codes on file (never the codes themselves). */
            async count(): Promise<number> {
                const now = Date.now();
                return Object.values(ctx.state.codes).filter((e) => e.expiresAt > now).length;
            }
        };
    }
});

export type PairingDirectoryActor = typeof PairingDirectory;
