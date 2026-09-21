/**
 * The folder picker's view model (#193): what the pages hand `WorkdirField`
 * / `WorkdirDialog` (`@agentic/ui`, #191) — the environments a folder can be
 * picked in, with their roots and path rules, and why one cannot be browsed
 * right now. Pure: the live side builds it from the environment directory
 * (`useEnvironmentDirectory`), the mock side from `mock/ops.ts`.
 */
import type { EnvironmentDescriptor, EnvironmentId, FsError, HostOs, WorkdirRef } from '@agentic/core';
import type { WorkdirEnvironment } from '@agentic/ui';
import type { EnvironmentEntry } from '../ops/environments';

/**
 * A machine that never said hello has no OS yet: Windows is the platform's
 * first daemon target (decision 1), and its rules are the lenient ones
 * (either separator, any case), so a path typed before the first hello is
 * not refused for its spelling. The daemon checks again either way.
 */
export const DEFAULT_OS: HostOs = 'windows';

/** Why an environment cannot be browsed now: the first thing the user would have to fix, or `undefined`. */
export function unavailableReason(descriptor: EnvironmentDescriptor, online: boolean): string | undefined {
    if (!online) return 'Machine offline';
    if (descriptor.cwdRoots.length === 0) return 'No working roots configured';
    switch (descriptor.account.authStatus) {
        case 'missing':
            return 'Not signed in';
        case 'expired':
            return 'Sign-in expired';
        default:
            return undefined;
    }
}

/** One directory entry as the picker shows it: "alien01 / work". */
export function workdirEnvironmentOf(entry: EnvironmentEntry): WorkdirEnvironment {
    const unavailable = unavailableReason(entry.descriptor, entry.online);
    return {
        id: entry.id as EnvironmentId,
        label: `${entry.machineName} / ${entry.descriptor.name}`,
        os: entry.os ?? DEFAULT_OS,
        roots: entry.descriptor.cwdRoots,
        ...(unavailable ? { unavailable } : {}),
        // Its account's limits (#315): shown in the picker's strip, and where a chat member or New chat names this environment.
        ...(entry.quota !== undefined ? { quota: entry.quota } : {}),
        // What a chat member's model and mode rows offer here (#453).
        ...(entry.descriptor.models?.length ? { models: entry.descriptor.models } : {}),
        ...(entry.descriptor.allowBypassPermissions ? { allowBypassPermissions: true } : {})
    };
}

/** Only daemon runtimes run in a folder: an environment belongs to a machine, so every directory entry qualifies. */
export const workdirEnvironmentsOf = (entries: readonly EnvironmentEntry[]): WorkdirEnvironment[] => entries.map(workdirEnvironmentOf);

/** The folders a picker opens on: the value's environment when it has one, else the first browsable environment. */
export function startingPoint(value: WorkdirRef | null | undefined, environments: readonly WorkdirEnvironment[], preferred?: EnvironmentId | null): { readonly environmentId: EnvironmentId | null; readonly path: string | null } {
    if (value && environments.some((e) => e.id === value.environmentId)) return { environmentId: value.environmentId, path: value.path };
    const pick = environments.find((e) => e.id === preferred && !e.unavailable) ?? environments.find((e) => !e.unavailable);
    return { environmentId: pick?.id ?? null, path: null };
}

/** A failed actor call as the picker's error: a server error's message, else the thrown text. */
export function requestError(e: unknown): FsError {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 503) return { code: 'timeout', message: 'The machine is offline' };
    if (status === 404) return { code: 'unknown-environment', message };
    if (status === 403) return { code: 'unsupported', message: 'Only the workspace owner can do that' };
    return { code: 'internal', message };
}

/** How long the picker waits on a machine before it says so — the platform's own deadline is longer (#189). */
export const CLIENT_TIMEOUT_MS = 20_000;
