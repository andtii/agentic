/**
 * The folders the web may use, from the Machine page (#355, #482): the pure
 * half of the folders card over `Machine.setPolicy` / `browseMachine` /
 * `policyResult` (#480) — what state the card is in, the rows it lists
 * (what was asked beside what the daemon made of it), what a typed folder
 * must look like, how a refusal reads — and of the daemon log disclosure
 * over `logTail` / `logResult` (#481). Nothing here touches a hook or the DOM.
 */
import type { DaemonFeature, DaemonLogError, FsListResult, HostOs, MachineListing, MachinePolicy, MachinePolicyError, MachinePolicyErrorCode } from '@agentic/core';
import type { MachineView } from '@agentic/platform';
import { isAbsoluteRoot } from './manage';

/**
 * Where the folders card stands: `no-feature` — the daemon predates `policy.request` (the local `allow-root`
 * command is all there is); `locked` — `agentic-daemon policy lock` on the machine, read-only here; `web` /
 * `local` — on, set from here or on the machine; `off` — nothing allowed yet.
 */
export type PolicyCardState = 'no-feature' | 'locked' | 'web' | 'local' | 'off';

export function policyCardState(policy: MachinePolicy | undefined, features: readonly DaemonFeature[] | undefined): PolicyCardState {
    if (!features?.includes('policy')) return 'no-feature';
    if (policy?.locked) return 'locked';
    if (!policy?.webManaged) return 'off';
    return policy.source === 'web' ? 'web' : 'local';
}

/** `~`, `~/src`, `~\src` — the daemon user's home folder, expanded on the machine. */
export const isHomeRoot = (path: string): boolean => /^~([\\/].*)?$/.test(path);

/** What a folder typed into the card must be: a `~` form, or a full local path for the machine's OS. */
export function policyRootError(path: string, os: HostOs): string | null {
    const p = path.trim();
    if (!p) return 'Enter a folder.';
    if (p.startsWith('\\\\') || p.startsWith('//')) return 'A network share cannot be allowed; only local folders can.';
    if (isHomeRoot(p) || isAbsoluteRoot(p, os)) return null;
    return `${p} is not a full path on this machine. Use ~ for the home folder, or a path like ${os === 'windows' ? 'C:\\Dev' : '/home/me/src'}.`;
}

/** `MachineView.policyDesired` (#480): what the owner wants, and whether the machine reports it. */
export type PolicyDesiredView = NonNullable<MachineView['policyDesired']>;

/** The roots the card starts from: what the owner last asked for, else what the daemon reports (as asked, else as resolved). */
export function policyRootsOf(policy: MachinePolicy | undefined, desired: PolicyDesiredView | undefined): string[] {
    if (desired) return [...desired.allowedRoots];
    if (!policy) return [];
    return [...(policy.requested ?? policy.allowedRoots)];
}

/** A row of the card: the root as asked, and what the daemon made of it when it reports that very set. */
export interface PolicyRow {
    readonly requested: string;
    readonly resolved?: string;
}

/** `~ → C:\Users\andy`: the reported `requested[i]` pairs with `allowedRoots[i]` (the daemon keeps the order); a root the machine has not applied yet has no `resolved`. */
export function policyRows(roots: readonly string[], policy: MachinePolicy | undefined): PolicyRow[] {
    const requested = policy?.requested ?? [];
    const applied = policy?.allowedRoots ?? [];
    return roots.map((requestedRoot) => {
        const i = requested.indexOf(requestedRoot);
        const byRequest = i >= 0 && requested.length === applied.length ? applied[i] : undefined;
        const resolved = byRequest ?? (applied.includes(requestedRoot) ? requestedRoot : undefined);
        return resolved === undefined ? { requested: requestedRoot } : { requested: requestedRoot, resolved };
    });
}

/** The same folders in the same order. */
export const sameRoots = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((r, i) => r === b[i]);

/** Unlocks the policy on the machine — the one step that stays there, by design. */
export const unlockCommand = (): string => 'agentic-daemon policy unlock';

/** Why the page never sent a policy request, beside the daemon's own codes. */
export type PolicyFailureCode = MachinePolicyErrorCode | 'machine-offline' | 'revoked' | 'forbidden' | 'not-found' | 'internal';

export interface PolicyFailure {
    readonly code: PolicyFailureCode;
    readonly message: string;
}

/** A policy refusal as a sentence; the daemon's message follows where it names the folder. */
export function policyFailureText(failure: PolicyFailure): string {
    const detail = failure.message ? ` ${failure.message}` : '';
    switch (failure.code) {
        case 'policy-locked':
            return 'The policy is locked on the machine. Run agentic-daemon policy unlock there, then try again.';
        case 'invalid':
            return `The daemon refused a folder.${detail}`;
        case 'not-found':
            return `A folder does not exist on the machine.${detail}`;
        case 'not-a-directory':
            return `That path is not a folder.${detail}`;
        case 'remote-path':
            return `A network share cannot be allowed.${detail}`;
        case 'protected':
            return `A folder is inside the daemon's own folders (its configuration, state or an account profile) and cannot be allowed.${detail}`;
        case 'io':
            return `The daemon could not write its policy file.${detail}`;
        case 'timeout':
            return "The machine didn't answer in time. It may still apply the change — check again in a moment.";
        case 'unsupported':
            return 'The daemon on this machine does not take its policy from the web. Update agentic-daemon there.';
        case 'machine-offline':
            return 'The machine is offline. The folders can be changed while its daemon is connected.';
        case 'revoked':
            return 'This machine is revoked.';
        case 'forbidden':
            return 'Only the workspace owner can change a machine.';
        default:
            return failure.message || 'Something went wrong.';
    }
}

/** A thrown `setPolicy` / `browseMachine` call as a refusal (the Machine's status codes). */
export function policyCallFailure(e: unknown): PolicyFailure {
    const status = (e as { status?: number } | null)?.status;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 503) return { code: 'machine-offline', message };
    if (status === 409) return { code: 'unsupported', message };
    if (status === 404) return { code: 'not-found', message };
    if (status === 403) return { code: /revoked/.test(message) ? 'revoked' : 'forbidden', message };
    if (status === 400) return { code: 'invalid', message: message.replace(/^machine: /, '') };
    return { code: 'internal', message };
}

export const policyAnswerFailure = (error: MachinePolicyError): PolicyFailure => ({ code: error.code, message: error.message });

/** A machine listing as the picker's listing: the same shape without git badges. */
export function listingOf(listing: MachineListing): FsListResult {
    return {
        kind: 'list',
        path: listing.path,
        ...(listing.parent !== undefined ? { parent: listing.parent } : {}),
        entries: listing.entries.map((e) => ({ name: e.name, path: e.path })),
        truncated: listing.truncated
    };
}

/* ------------------------------------------------------------------ the log */

/** The disclosure's state: `pending` while the daemon has not answered, then the lines or why there are none. */
export interface LogState {
    readonly status: 'pending' | 'done' | 'error';
    readonly lines?: readonly string[];
    readonly truncated?: boolean;
    readonly error?: DaemonLogError | { readonly code: 'machine-offline' | 'internal'; readonly message: string };
}

/** Why there are no lines, as a sentence. */
export function logErrorText(error: NonNullable<LogState['error']>): string {
    switch (error.code) {
        case 'no-log':
            return 'The daemon is running in a terminal (agentic-daemon run), so it writes no log file: its output is on that terminal.';
        case 'io':
            return `The daemon could not read its log.${error.message ? ` ${error.message}` : ''}`;
        case 'timeout':
            return "The machine didn't answer in time.";
        case 'unsupported':
            return 'The daemon on this machine does not serve its log. Update agentic-daemon there.';
        case 'machine-offline':
            return 'The machine is offline. The log can be read while its daemon is connected.';
        default:
            return error.message || 'Something went wrong.';
    }
}
