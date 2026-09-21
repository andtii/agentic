/**
 * The working-folder picker's data and pure helpers (#191): the shapes the
 * host feeds `WorkdirField` / `WorkdirDialog`, the compact label a chip
 * shows, the breadcrumb a folder path splits into, and the plain text each
 * `FsErrorCode` reads as. No DOM, no component code: a page can compute the
 * same label server-side.
 */

import { normalizePath, pathWithin, type EnvironmentDescriptor, type EnvironmentId, type FsError, type FsErrorCode, type HostOs, type MachineInfo, type ModelOption, type QuotaSnapshot, type WorkdirRef } from '@agentic/core';
import { environmentStatus } from './environment-card.js';

/** One environment the picker can browse. */
export interface WorkdirEnvironment {
    readonly id: EnvironmentId;
    /** "alien01 / work" — machine / environment name. */
    readonly label: string;
    readonly os: HostOs;
    readonly roots: readonly string[];
    /** Why it cannot be browsed now ("Machine offline", "Sign-in expired"); absent = browsable. */
    readonly unavailable?: string;
    /** Its account's provider limits (#315): `null` before the first report; absent when the caller has none to show. */
    readonly quota?: QuotaSnapshot | null;
    /** The models its account reports (#453, `EnvironmentDescriptor.models`); absent until reported. */
    readonly models?: readonly ModelOption[];
    /** Sessions here may run in a mode that asks about nothing (#453); set on the machine only. */
    readonly allowBypassPermissions?: boolean;
}

export interface WorkdirRecent {
    readonly environmentId: EnvironmentId;
    readonly path: string;
    readonly at?: number;
}

export interface WorkdirWorktreeRequest {
    readonly environmentId: EnvironmentId;
    readonly repo: string;
    readonly branch: string;
    readonly base?: string;
    readonly path: string;
}

/** The chip's text when no folder is chosen. */
export const WORKDIR_EMPTY = 'Environment default (first root)';

const ELLIPSIS = '…';

/** The separator a path on `os` uses; guessed from the path itself when the environment is unknown. */
export function pathSeparator(os: HostOs | undefined, path = ''): '\\' | '/' {
    if (os) return os === 'windows' ? '\\' : '/';
    return /^[A-Za-z]:|\\/.test(path) ? '\\' : '/';
}

/** A path's non-empty segments, either separator. */
function segmentsOf(path: string): string[] {
    return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Compact display of a WorkdirRef: "alien01 / work · …\branches\47-drawer"
 * — the environment's label, then the last two segments of the path (the
 * whole path when it has no more). The full path belongs in a `title`.
 */
export function workdirLabel(ref: WorkdirRef | null | undefined, environments: readonly WorkdirEnvironment[], empty?: string): string {
    if (!ref) return empty ?? WORKDIR_EMPTY;
    const env = environments.find((e) => e.id === ref.environmentId);
    return `${env?.label ?? ref.environmentId} · ${workdirPath(ref, environments)}`;
}

/** The path part of `workdirLabel` alone — "…\branches\47-drawer" — for where the environment is already on show (a chat member's card). */
export function workdirPath(ref: WorkdirRef, environments: readonly WorkdirEnvironment[]): string {
    const env = environments.find((e) => e.id === ref.environmentId);
    const sep = pathSeparator(env?.os, ref.path);
    const segments = segmentsOf(ref.path);
    return segments.length > 2 ? `${ELLIPSIS}${sep}${segments.slice(-2).join(sep)}` : ref.path;
}

/** Whether two paths name the same folder on `os`: normalized, and case-insensitive on Windows. */
export function samePath(a: string, b: string, os: HostOs): boolean {
    const na = normalizePath(a, os) ?? a;
    const nb = normalizePath(b, os) ?? b;
    return os === 'windows' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** `text` cut in the middle to at most `max` characters: "C:\Dev\ag…\branches\47-drawer". The tail — the folder's own name — survives. */
export function middleTruncate(text: string, max = 44): string {
    if (text.length <= max) return text;
    const keep = Math.max(max - 1, 2);
    const tail = Math.ceil(keep * 0.6);
    return `${text.slice(0, keep - tail)}${ELLIPSIS}${text.slice(text.length - tail)}`;
}

/** One step of the breadcrumb: the root first, nothing above it. */
export interface WorkdirCrumb {
    readonly label: string;
    readonly path: string;
}

/**
 * The breadcrumb for `path`: the root it lies in (as the environment names
 * it), then one crumb per folder below. A path inside no root is one crumb.
 */
export function workdirCrumbs(path: string, env: Pick<WorkdirEnvironment, 'os' | 'roots'>): WorkdirCrumb[] {
    const sep = pathSeparator(env.os, path);
    const target = normalizePath(path, env.os);
    // The deepest root containing the path, so nested roots crumb from the nearer one.
    const root = [...env.roots]
        .filter((r) => pathWithin(path, [r], env.os))
        .sort((a, b) => segmentsOf(normalizePath(b, env.os) ?? b).length - segmentsOf(normalizePath(a, env.os) ?? a).length)[0];
    if (!target || root === undefined) return [{ label: path, path }];
    const rootNorm = normalizePath(root, env.os) ?? root;
    const below = segmentsOf(target).slice(segmentsOf(rootNorm).length);
    const crumbs: WorkdirCrumb[] = [{ label: root, path: root }];
    let at = rootNorm;
    for (const segment of below) {
        at = at.endsWith(sep) ? `${at}${segment}` : `${at}${sep}${segment}`;
        crumbs.push({ label: segment, path: at });
    }
    return crumbs;
}

/** Plain text for each `FsErrorCode` — never the raw code. */
export const FS_ERROR_TEXT: Record<FsErrorCode, string> = {
    'outside-roots': "That folder is outside this environment's working roots",
    'not-found': "That folder doesn't exist on the machine",
    'not-a-repo': 'That folder is not a git repository',
    'branch-exists': 'A branch with that name already exists',
    'invalid-branch': 'Git does not accept that branch name',
    exists: 'Something already exists at the target path',
    timeout: "The machine didn't answer",
    'unknown-environment': "This environment isn't on the machine any more",
    unsupported: "The machine's daemon can't do this yet — update it",
    internal: 'The machine hit an error while reading the folder'
};

/** An error prop as the text the picker shows: a known code maps to plain words, a string is shown as is. */
export function fsErrorText(error: FsError | string | null | undefined): string | null {
    if (!error) return null;
    if (typeof error === 'string') return error;
    return FS_ERROR_TEXT[error.code] ?? error.message;
}

/**
 * A `WorkdirEnvironment` from what the Machines page already reads: the
 * label is `machine / environment`, and the reason it cannot be browsed is
 * `environmentStatus()`'s — an offline machine or an account that is not
 * signed in. Busy and unknown-auth environments stay browsable.
 */
export function toWorkdirEnvironment(env: EnvironmentDescriptor, machine?: Pick<MachineInfo, 'name' | 'os' | 'online'>): WorkdirEnvironment {
    const status = environmentStatus(env, machine as MachineInfo | undefined);
    const blocked = status.state === 'offline' || status.state === 'auth-expired' || status.state === 'auth-missing';
    return {
        id: env.id,
        label: `${machine?.name ?? env.machineId} / ${env.name}`,
        os: machine?.os ?? 'linux',
        roots: env.cwdRoots,
        ...(blocked ? { unavailable: status.label } : {})
    };
}
