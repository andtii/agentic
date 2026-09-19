/**
 * `policy.json` — the machine-local policy for web-managed environments
 * (#238, decisions 2026-09-19 (c)): whether the platform may add, change and
 * remove this machine's environments at all, and inside which folders.
 *
 * ```json
 * { "webManaged": true, "allowedRoots": ["C:\\src"] }
 * ```
 *
 * A missing file is OFF, and so is a file that does not parse: the policy
 * fails closed. It is edited only here, on the machine — `pair --allow-root`
 * and `agentic-daemon policy …` (`policy-cli.ts`). Nothing that arrives over
 * the socket reaches a function in this module that writes.
 *
 * Allowed roots are stored as the `realpath` of a directory that exists, so
 * what the owner allowed cannot later be re-pointed through a link. The
 * path rules a web-supplied working root must pass live here too
 * (`checkWorkingRoot`), over the same symlink-aware containment the folder
 * browser uses (`fs.ts`).
 */

import type { MachinePolicy } from '@agentic/core';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { writeOwnerOnly, type SecureWriteOptions } from './credentials.js';
import { watchConfigFile, type WatchConfigFileOptions } from './env-store.js';
import { checkWithinRoots, withinRoots } from './fs.js';

/** The default, and what any doubt resolves to. */
export const POLICY_OFF: MachinePolicy = { webManaged: false, allowedRoots: [] };

export type PolicyResult = { readonly ok: true; readonly policy: MachinePolicy; readonly missing?: true } | { readonly ok: false; readonly errors: readonly string[] };

export type PolicyErrorCode = 'invalid' | 'not-found' | 'not-a-directory' | 'remote-path' | 'protected';

export class PolicyError extends Error {
    override readonly name = 'PolicyError';
    constructor(
        readonly code: PolicyErrorCode,
        message: string
    ) {
        super(message);
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePolicy(value: unknown): PolicyResult {
    if (!isRecord(value)) return { ok: false, errors: ['policy.json must be { "webManaged": boolean, "allowedRoots": [...] }'] };
    const errors: string[] = [];
    if (typeof value.webManaged !== 'boolean') errors.push('policy.webManaged must be true or false');
    const roots = value.allowedRoots ?? [];
    if (!Array.isArray(roots) || !roots.every((r) => typeof r === 'string' && isAbsolute(r) && !isRemoteOrDevicePath(r))) errors.push('policy.allowedRoots must be a list of absolute local paths');
    if (errors.length) return { ok: false, errors };
    return { ok: true, policy: { webManaged: value.webManaged as boolean, allowedRoots: [...(roots as string[])] } };
}

export async function loadPolicy(file: string): Promise<PolicyResult> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, policy: POLICY_OFF, missing: true };
        throw e;
    }
    try {
        return parsePolicy(JSON.parse(text));
    } catch (e) {
        return { ok: false, errors: [`policy.json is not JSON: ${(e as Error).message}`] };
    }
}

/** Atomic and owner-only, like `credentials.json`: whoever can write this file decides what the web may reach. */
export async function writePolicy(file: string, policy: MachinePolicy, options: SecureWriteOptions = {}): Promise<void> {
    await writeOwnerOnly(file, `${JSON.stringify({ webManaged: policy.webManaged, allowedRoots: policy.allowedRoots }, null, 2)}\n`, options);
}

/** What `hello` / `env` carry: the roots only while the web may use them — on with none allowed is refused like off, so it says off. */
export function reportedPolicy(policy: MachinePolicy): MachinePolicy {
    return policy.webManaged && policy.allowedRoots.length > 0 ? { webManaged: true, allowedRoots: [...policy.allowedRoots] } : POLICY_OFF;
}

export function watchPolicy(options: Omit<WatchConfigFileOptions<PolicyResult>, 'load'>): Promise<{ close(): void }> {
    return watchConfigFile({ ...options, load: loadPolicy });
}

// ------------------------------------------------------------------- paths

/**
 * A UNC share (`\\server\share`, `\\?\UNC\…`) or a device path (`\\.\…`,
 * `\\?\C:\…`): never a working root and never an allowed root. Checked on
 * every platform — on POSIX a leading `//` is only ever a spelling of `/`.
 */
export function isRemoteOrDevicePath(path: string): boolean {
    return /^[\\/]{2}/.test(path);
}

/** One of the two lies inside the other (or they are the same folder). */
const overlaps = (a: string, b: string, platform: NodeJS.Platform): boolean => withinRoots(a, [b], platform) || withinRoots(b, [a], platform);

/** `path` with links resolved when it exists, as given otherwise. */
async function realOrLexical(path: string): Promise<string> {
    try {
        return await realpath(resolve(path));
    } catch {
        return resolve(path);
    }
}

/** The daemon's own folders — configuration (token, policy, profiles), state (session logs) and every environment's profile. */
export interface ProtectedDirs {
    readonly configDir: string;
    readonly stateDir: string;
    readonly profileDirs: readonly string[];
}

export type WorkingRootCheck =
    /** `real`: the root with links resolved — what is stored, so the grant cannot be re-pointed later. */
    | { readonly ok: true; readonly real: string }
    | { readonly ok: false; readonly code: 'invalid' | 'outside-allowed-roots'; readonly message: string };

/**
 * May the web use `root` as a working root under `allowedRoots`? In order:
 * absolute; not a share or a device; inside an allowed root lexically (so
 * `..` is judged by where it leads) and again after `realpath` of both sides
 * (so a symlink or junction cannot lead out — `checkWithinRoots`) — a path
 * that is outside only lexically but whose `realpath` is inside (a short
 * name, a link to an allowed folder) counts as that real folder; an
 * existing directory; and not overlapping any of the daemon's own folders in
 * either direction. Outside answers the same whether the folder exists or
 * not. Messages name only the path that was asked for.
 */
export async function checkWorkingRoot(root: unknown, allowedRoots: readonly string[], protectedDirs: ProtectedDirs, platform: NodeJS.Platform = process.platform): Promise<WorkingRootCheck> {
    if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) return { ok: false, code: 'invalid', message: `working root ${JSON.stringify(root)} must be an absolute path` };
    const outside = { ok: false, code: 'outside-allowed-roots', message: `${root} is not inside a folder this machine allows` } as const;
    if (isRemoteOrDevicePath(root)) return { ...outside, message: `${root} is a network or device path; working roots are local folders` };
    let within = await checkWithinRoots(root, allowedRoots, platform);
    if (!within.ok && within.code === 'outside-roots') {
        // Another spelling of a folder inside — an 8.3 short name, or a link to it such as macOS's /var → /private/var — is
        // judged by where it leads. Everything else answers the same whether it exists or not, so the web learns nothing
        // about folders it may not use.
        const real = await realpath(resolve(root)).catch(() => undefined);
        if (real === undefined || isRemoteOrDevicePath(real)) return outside;
        within = await checkWithinRoots(real, allowedRoots, platform);
        if (!within.ok) return outside;
    }
    if (!within.ok) return within.code === 'not-found' ? { ok: false, code: 'invalid', message: `${root} does not exist on this machine` } : outside;
    const { real } = within;
    // A mapped drive resolves to its share.
    if (isRemoteOrDevicePath(real)) return { ...outside, message: `${root} is on a network share; working roots are local folders` };
    const isDirectory = await stat(real).then(
        (s) => s.isDirectory(),
        () => false
    );
    if (!isDirectory) return { ok: false, code: 'invalid', message: `${root} is not a folder` };
    const own = [protectedDirs.configDir, protectedDirs.stateDir, ...protectedDirs.profileDirs];
    for (const dir of own) {
        if (overlaps(real, await realOrLexical(dir), platform) || overlaps(real, resolve(dir), platform)) return { ...outside, message: `${root} overlaps the daemon's own folders (its configuration, session logs or an account profile)` };
    }
    return { ok: true, real };
}

// ---------------------------------------------------------- local editing

const fold = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.toLowerCase() : p);

/**
 * `policy` with `dir` allowed (and web management on). `dir` must be an
 * existing local directory outside the daemon's configuration and state
 * folders; it is stored with links resolved. A folder that CONTAINS those is
 * fine — `checkWorkingRoot` still keeps every working root off them.
 */
export async function allowRoot(policy: MachinePolicy, dir: string, own: Pick<ProtectedDirs, 'configDir' | 'stateDir'>, platform: NodeJS.Platform = process.platform): Promise<MachinePolicy> {
    if (!isAbsolute(dir)) throw new PolicyError('invalid', `${dir} must be an absolute path`);
    if (isRemoteOrDevicePath(dir)) throw new PolicyError('remote-path', `${dir} is a network or device path; only local folders can be allowed`);
    let real: string;
    try {
        real = await realpath(resolve(dir));
    } catch {
        throw new PolicyError('not-found', `${dir} does not exist`);
    }
    if (isRemoteOrDevicePath(real)) throw new PolicyError('remote-path', `${dir} is on a network share (${real}); only local folders can be allowed`);
    if (!(await stat(real)).isDirectory()) throw new PolicyError('not-a-directory', `${dir} is not a folder`);
    for (const mine of [own.configDir, own.stateDir]) {
        if (withinRoots(real, [await realOrLexical(mine)], platform) || withinRoots(real, [resolve(mine)], platform)) throw new PolicyError('protected', `${dir} is inside the daemon's own folder ${mine}`);
    }
    const kept = policy.allowedRoots.filter((r) => fold(r, platform) !== fold(real, platform));
    return { webManaged: true, allowedRoots: [...kept, real] };
}

/** `policy` without `dir`; with no root left the web manages nothing, so it goes off. */
export async function denyRoot(policy: MachinePolicy, dir: string, platform: NodeJS.Platform = process.platform): Promise<MachinePolicy> {
    const candidates = new Set([fold(resolve(dir), platform), fold(await realOrLexical(dir), platform)]);
    const kept = policy.allowedRoots.filter((r) => !candidates.has(fold(resolve(r), platform)));
    if (kept.length === policy.allowedRoots.length) throw new PolicyError('not-found', `${dir} is not an allowed root`);
    return kept.length === 0 ? POLICY_OFF : { webManaged: policy.webManaged, allowedRoots: kept };
}
