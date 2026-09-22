/**
 * `policy.request` (#355; decisions 2026-09-22): the platform sets this
 * machine's policy for web-managed environments, or browses its folders to
 * pick one. This is the only web-facing module that writes `policy.json` —
 * `daemon.ts` reaches it through the port `cli.ts` injects, never directly.
 *
 * - `set`: every requested root passes what `agentic-daemon policy allow-root`
 *   checks (`allowRoot`: absolute or `~` — expanded here to the daemon user's
 *   home, never on the platform — local, an existing folder, outside the
 *   daemon's own configuration and state folders; stored with links
 *   resolved). One bad root refuses the whole request and changes nothing.
 *   What is written says `source: "web"` and echoes the roots as asked
 *   (`requested`), which is what the platform reads back to tell whether the
 *   machine converged. An empty list turns web management off. A policy the
 *   owner `lock`ed on the machine refuses everything with `policy-locked`.
 * - `browse`: the immediate subfolders of a folder anywhere on the machine —
 *   or, without a path, the machine's roots (the home folder first, then the
 *   drives on Windows, `/` elsewhere) — folders only, no hidden folders or
 *   `node_modules`, and never the daemon's own folders (its configuration,
 *   its state, the account profiles), which are left out as if absent.
 */

import { FS_LIST_MAX_ENTRIES, type MachineListing, type MachinePolicy, type MachinePolicyError, type MachinePolicyInput } from '@agentic/core';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { SecureWriteOptions } from './credentials.js';
import { withinRoots } from './fs.js';
import { silentLogger, type Logger } from './logger.js';
import type { DaemonPaths } from './paths.js';
import { allowRoot, isRemoteOrDevicePath, loadPolicy, POLICY_OFF, PolicyError, type ProtectedDirs, writePolicy } from './policy.js';

export type PolicyOutcome = { readonly policy: MachinePolicy } | { readonly error: MachinePolicyError };
export type BrowseOutcome = { readonly listing: MachineListing } | { readonly error: MachinePolicyError };

export interface PolicyWebContext {
    readonly paths: Pick<DaemonPaths, 'configDir' | 'stateDir' | 'policyFile'>;
    /** The account profiles — never an allowed root, never listed. */
    readonly profileDirs: readonly string[];
    /** What `~` expands to. Default `os.homedir()`. */
    readonly home?: string;
    readonly platform?: NodeJS.Platform;
    readonly secure?: SecureWriteOptions;
    readonly logger?: Logger;
    /** The drive letters to probe for the roots listing on Windows (tests). Default `A`–`Z`. */
    readonly drives?: readonly string[];
}

const fail = (code: MachinePolicyError['code'], message: string): { error: MachinePolicyError } => ({ error: { code, message: message.slice(0, 1024) } });

/** `~`, `~/x`, `~\x` → under `home`; anything else as given. */
export function expandHome(root: string, home: string): string {
    if (root === '~') return home;
    if (root.startsWith('~/') || root.startsWith('~\\')) return join(home, root.slice(2));
    return root;
}

/** Answer `policy.request { op: 'set' }`. Never throws; call it one at a time (it reads, changes and writes `policy.json`). */
export async function applyWebPolicy(input: MachinePolicyInput, c: PolicyWebContext): Promise<PolicyOutcome> {
    const logger = c.logger ?? silentLogger;
    const platform = c.platform ?? process.platform;
    const home = c.home ?? homedir();
    const own = { configDir: c.paths.configDir, stateDir: c.paths.stateDir };
    try {
        const loaded = await loadPolicy(c.paths.policyFile);
        if (!loaded.ok) {
            logger.error('policy: policy.json cannot be edited', { problems: loaded.errors });
            return fail('io', 'the machine’s policy file is invalid; fix it on the machine (`agentic-daemon policy show` says what is wrong)');
        }
        if (loaded.policy.locked) return fail('policy-locked', 'the policy is locked on this machine; run `agentic-daemon policy unlock` there to let the web set it');
        let next: MachinePolicy = POLICY_OFF;
        for (const requested of input.allowedRoots) {
            if (typeof requested !== 'string' || requested.trim() === '') return fail('invalid', 'a folder must be a non-empty path');
            const expanded = expandHome(requested.trim(), home);
            if (!isAbsolute(expanded)) return fail('invalid', `${requested} is not an absolute path (or ~ / ~/…)`);
            next = await allowRoot(next, expanded, own, platform);
        }
        const written: MachinePolicy = { webManaged: next.allowedRoots.length > 0, allowedRoots: next.allowedRoots, source: 'web', requested: input.allowedRoots.map((r) => r.trim()) };
        await writePolicy(c.paths.policyFile, written, c.secure);
        logger.info('policy: set by the platform', { allowedRoots: written.allowedRoots, requested: written.requested });
        return { policy: written };
    } catch (e) {
        if (e instanceof PolicyError) return fail(e.code, e.message);
        logger.error('policy: request failed', { error: e });
        return fail('io', 'the machine could not save the policy; see the daemon log');
    }
}

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

/** The daemon's own folders, as they are on disk, for keeping them out of a listing. */
async function protectedDirs(c: PolicyWebContext): Promise<ProtectedDirs & { readonly all: readonly string[] }> {
    const real = async (p: string) => {
        try {
            return await realpath(resolve(p));
        } catch {
            return resolve(p);
        }
    };
    const dirs = { configDir: await real(c.paths.configDir), stateDir: await real(c.paths.stateDir), profileDirs: await Promise.all(c.profileDirs.map(real)) };
    return { ...dirs, all: [dirs.configDir, dirs.stateDir, ...dirs.profileDirs] };
}

/** Whether `real` is one of the daemon's own folders or inside one. */
const isOwn = (real: string, own: readonly string[], platform: NodeJS.Platform): boolean => withinRoots(real, own, platform);

/** Answer `policy.request { op: 'browse' }`. Never throws. */
export async function browseMachine(path: string | undefined, c: PolicyWebContext): Promise<BrowseOutcome> {
    const logger = c.logger ?? silentLogger;
    const platform = c.platform ?? process.platform;
    const home = c.home ?? homedir();
    try {
        const own = await protectedDirs(c);
        if (path === undefined) return { listing: { path: '', entries: await machineRoots(home, platform, own.all, c.drives), truncated: false } };
        if (typeof path !== 'string' || !isAbsolute(path) || isRemoteOrDevicePath(path)) return fail('invalid', `${String(path)} is not an absolute local path`);
        const lexical = resolve(path);
        let real: string;
        try {
            real = await realpath(lexical);
        } catch (e) {
            if (isMissing(e)) return fail('not-found', `${path} does not exist on this machine`);
            throw e;
        }
        if (isRemoteOrDevicePath(real)) return fail('remote-path', `${path} is on a network share; only local folders can be browsed`);
        if (!(await stat(real)).isDirectory()) return fail('not-a-directory', `${path} is not a folder`);
        // The daemon's own folders read as absent, whichever way they are reached.
        if (isOwn(real, own.all, platform)) return fail('not-found', `${path} does not exist on this machine`);
        const dirents = (await readdir(real, { withFileTypes: true })).filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !skipped(d.name)).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
        const entries: { name: string; path: string }[] = [];
        let truncated = false;
        for (const d of dirents) {
            const at = join(real, d.name);
            let target = at;
            if (!d.isDirectory()) {
                try {
                    target = await realpath(at);
                    if (!(await stat(target)).isDirectory()) continue;
                } catch {
                    continue;
                }
            }
            if (isOwn(target, own.all, platform)) continue;
            if (entries.length >= FS_LIST_MAX_ENTRIES) {
                truncated = true;
                break;
            }
            entries.push({ name: d.name, path: join(lexical, d.name) });
        }
        const parent = dirname(lexical);
        return { listing: { path: lexical, ...(parent === lexical ? {} : { parent }), entries, truncated } };
    } catch (e) {
        logger.error('policy: browse failed', { error: e });
        return fail('io', 'the machine could not read that folder; see the daemon log');
    }
}

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((e as NodeJS.ErrnoException).code ?? '');

/** The top of the machine: the home folder, then every drive that answers (Windows) or `/`. */
async function machineRoots(home: string, platform: NodeJS.Platform, own: readonly string[], drives?: readonly string[]): Promise<{ name: string; path: string }[]> {
    const out: { name: string; path: string }[] = [];
    if (!isOwn(resolve(home), own, platform)) out.push({ name: '~', path: home });
    if (platform === 'win32') {
        for (const letter of drives ?? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
            const drive = `${letter}:\\`;
            try {
                if ((await stat(drive)).isDirectory()) out.push({ name: `${letter}:`, path: drive });
            } catch {
                // no such drive
            }
        }
    } else out.push({ name: '/', path: '/' });
    return out;
}
