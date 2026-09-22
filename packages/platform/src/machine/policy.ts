/**
 * The desired policy (#355; decisions 2026-09-22): the folders the web may use
 * on a machine, as the owner set them (`Machine.setPolicy`) or the Pair page
 * preset them. The daemon applies them (`policy.request { op: 'set' }`,
 * `~` expanded there) and reports what it holds; the Machine compares the
 * two with core's `policyConverged` and re-sends once per drift — never to a
 * locked machine, never in a loop. The pure half lives here.
 */
import { isHomeRelativeRoot, normalizePath, POLICY_MAX_ROOTS, policyConverged, policyRootKey, type HostOs, type MachinePolicy } from '@agentic/core';
import { ServerFnError } from '@sigx/server';
import type { MachineOs, PolicyDesired } from './state.js';

/** `by` on an automatic request: the reconcile, not a person. */
export const SYSTEM_SETUP = 'system:setup';

const hostOs = (os: MachineOs | undefined): HostOs | undefined => (os === 'windows' || os === 'darwin' || os === 'linux' ? os : undefined);

/**
 * What the platform holds a desired root to before it leaves: text, ≤ `POLICY_MAX_ROOTS` of them, each a `~` form or an
 * absolute path on the machine's OS (a lexical check only when the OS is not known yet — at pairing), never a network
 * or device path. The daemon has the last word on existence, links and its own folders. Throws 400.
 */
export function checkPolicyRoots(input: unknown, os: MachineOs | undefined): string[] {
    const roots = (input as { allowedRoots?: unknown } | null)?.allowedRoots;
    if (!Array.isArray(roots)) throw new ServerFnError(400, 'machine: a policy names its folders (allowedRoots)');
    if (roots.length > POLICY_MAX_ROOTS) throw new ServerFnError(400, `machine: at most ${POLICY_MAX_ROOTS} folders`);
    const out: string[] = [];
    const keys = new Set<string>();
    // With the OS unknown (at pairing), a Windows-looking root is keyed as Windows, so `C:/src` and `c:\src` are one folder there too.
    const keyOs = (root: string): HostOs => hostOs(os) ?? (/^[A-Za-z]:[\\/]|^~\\/.test(root) ? 'windows' : 'linux');
    for (const raw of roots) {
        if (typeof raw !== 'string' || raw.trim() === '') throw new ServerFnError(400, 'machine: a folder is a non-empty path');
        const root = raw.trim();
        if (root.length > 1024) throw new ServerFnError(400, 'machine: a folder path is at most 1024 characters');
        if (/^[\\/]{2}/.test(root)) throw new ServerFnError(400, `machine: ${root} is a network or device path; only local folders can be allowed`);
        if (!isHomeRelativeRoot(root)) {
            const known = hostOs(os);
            const absolute = known ? normalizePath(root, known) !== null : /^([A-Za-z]:[\\/]|\/)/.test(root);
            if (!absolute) throw new ServerFnError(400, `machine: ${root} is not an absolute path (or ~ / ~/…)`);
        }
        // The same folder spelled twice (`C:/src` and `C:/src/`) is one folder; the first spelling stays.
        const key = policyRootKey(root, keyOs(root));
        if (!keys.has(key)) {
            keys.add(key);
            out.push(root);
        }
    }
    return out;
}

/**
 * Whether to send the desired policy now, without ever looping (#480). Only a `hello` or an `env` asks; a
 * `policy.response` never does. All of: the daemon answers `policy.request`; something is desired; the machine is not
 * locked; the report is not what is desired; nothing is in flight; and either no automatic request went out yet, the last
 * one converged (so this is a genuine drift), the owner changed the desired set since, or this is a fresh connection.
 * A refused automatic request (`policy-locked` included) therefore holds until the owner changes the set or the daemon
 * reconnects — bound per connect: one, plus the local drifts.
 */
export function shouldReconcile(input: { readonly trigger: 'hello' | 'env'; readonly features: readonly string[] | undefined; readonly desired: PolicyDesired | undefined; readonly reported: MachinePolicy | undefined; readonly os: MachineOs | undefined; readonly pending: boolean; readonly connectedAt: number | undefined }): boolean {
    const { desired, reported } = input;
    if (!input.features?.includes('policy') || !desired || reported?.locked || input.pending) return false;
    const os = hostOs(input.os) ?? 'linux';
    if (policyConverged(desired.allowedRoots, reported, os)) return false;
    const last = desired.lastAuto;
    if (!last || last.converged || desired.setAt > last.at) return true;
    return input.trigger === 'hello' && input.connectedAt !== undefined && input.connectedAt > last.at;
}
