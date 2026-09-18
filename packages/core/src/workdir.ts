/**
 * Working folders (#185): where on a machine a task's session runs, and the
 * `fs.request` operations a daemon answers so a user can browse for one.
 * A folder is only meaningful on one machine, so it always travels with its
 * environment; it must lie within that environment's `cwdRoots` (decision 3).
 * Pure path helpers: no `node:path`, so every layer checks the same way.
 */

import type { EnvironmentId } from './ids.js';

/** The operating system a daemon reports in `hello` — it decides path syntax and case rules. */
export type HostOs = 'windows' | 'darwin' | 'linux';

/** A folder on a machine: an absolute, machine-native path inside the environment's `cwdRoots`. */
export interface WorkdirRef {
    readonly environmentId: EnvironmentId;
    readonly path: string;
}

/** What `fs.request` asks a daemon to do. */
export type FsOp =
    /** The immediate subfolders of `path`. */
    | { readonly kind: 'list'; readonly path: string }
    /** `git worktree add -b branch path [base]` in `repo`; `path` must not exist yet. */
    | { readonly kind: 'worktree'; readonly repo: string; readonly branch: string; readonly base?: string; readonly path: string };

export interface FsGitInfo {
    /** `repo`: `.git` is a directory; `worktree`: `.git` is a file pointing into another repo's `worktrees/`. */
    readonly kind: 'repo' | 'worktree';
    /** The checked-out branch; absent when HEAD is detached. */
    readonly branch?: string;
    /** Short commit id when HEAD is detached. */
    readonly head?: string;
}

/** One folder in a listing. */
export interface FsEntry {
    readonly name: string;
    /** Absolute, machine-native. */
    readonly path: string;
    readonly git?: FsGitInfo;
}

export interface FsListResult {
    readonly kind: 'list';
    /** The listed folder, absolute and machine-native. */
    readonly path: string;
    /** Its parent — absent when `path` is one of the roots (nothing above it is browsable). */
    readonly parent?: string;
    /** The folder itself, when it is a repo or worktree. */
    readonly git?: FsGitInfo;
    readonly entries: readonly FsEntry[];
    /** More than `FS_LIST_MAX_ENTRIES` subfolders: only the first ones are listed. */
    readonly truncated: boolean;
}

export interface FsWorktreeResult {
    readonly kind: 'worktree';
    readonly path: string;
    readonly branch: string;
}

export type FsResult = FsListResult | FsWorktreeResult;

export type FsErrorCode =
    | 'outside-roots'
    | 'not-found'
    | 'not-a-repo'
    | 'branch-exists'
    | 'invalid-branch'
    | 'exists'
    | 'timeout'
    | 'unknown-environment'
    | 'unsupported'
    | 'internal';

export interface FsError {
    readonly code: FsErrorCode;
    readonly message: string;
}

/** A listing carries at most this many folders. */
export const FS_LIST_MAX_ENTRIES = 500;

interface ParsedPath {
    /** `C:` / `//server/share` on Windows, `` on POSIX. */
    readonly prefix: string;
    readonly segments: readonly string[];
}

/** Split an absolute path into its root prefix and resolved segments; `null` for a relative path. `..` never climbs above the root. */
function parse(path: string, os: HostOs): ParsedPath | null {
    let rest: string;
    let prefix: string;
    if (os === 'windows') {
        const p = path.replace(/\\/g, '/');
        const drive = /^([A-Za-z]):\//.exec(p);
        const unc = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(p);
        if (drive) {
            prefix = `${drive[1]!.toUpperCase()}:`;
            rest = p.slice(2);
        } else if (unc) {
            prefix = `//${unc[1]}/${unc[2]}`;
            rest = p.slice(unc[0].length);
        } else return null;
    } else {
        if (!path.startsWith('/')) return null;
        prefix = '';
        rest = path;
    }
    const segments: string[] = [];
    for (const s of rest.split('/')) {
        if (s === '' || s === '.') continue;
        if (s === '..') segments.pop();
        else segments.push(s);
    }
    return { prefix, segments };
}

/**
 * `path` resolved to its canonical, machine-native form (`C:\src\app`,
 * `/home/me/src`): separators unified, `.`/`..` and duplicate separators
 * resolved, case kept. No trailing separator except on a filesystem or
 * share root (`C:\`, `/`). `null` for a relative path.
 */
export function normalizePath(path: string, os: HostOs): string | null {
    const p = parse(path, os);
    if (!p) return null;
    if (os === 'windows') return `${p.prefix.replace(/\//g, '\\')}\\${p.segments.join('\\')}`;
    return `/${p.segments.join('/')}`;
}

/**
 * Whether `path` is one of `roots` or inside one — lexically, after
 * normalizing both (Windows: case-insensitive, either separator). A sibling
 * that merely shares a prefix (`C:/src2` for root `C:/src`) is outside, and
 * so is any relative path. The daemon additionally resolves symlinks.
 */
export function pathWithin(path: string, roots: readonly string[], os: HostOs): boolean {
    const target = parse(path, os);
    if (!target) return false;
    const fold = (s: string) => (os === 'windows' ? s.toLowerCase() : s);
    return roots.some((r) => {
        const root = parse(r, os);
        if (!root || fold(root.prefix) !== fold(target.prefix) || root.segments.length > target.segments.length) return false;
        return root.segments.every((s, i) => fold(s) === fold(target.segments[i]!));
    });
}

/**
 * Where a new worktree for `branch` of `repo` goes by default: beside the
 * other worktrees in the sigx layout (`<repo>/main` + `<repo>/branches/<slug>`;
 * from a worktree already under `branches/`, a sibling), else
 * `<repo>-worktrees/<slug>`. The slug is the branch with `/` as `-`.
 * `null` when `repo` is not absolute.
 */
export function suggestWorktreePath(repo: string, branch: string, os: HostOs): string | null {
    const p = parse(repo, os);
    if (!p) return null;
    const slug = branch.trim().replace(/[\\/]+/g, '-');
    const fold = (s: string | undefined) => (os === 'windows' ? s?.toLowerCase() : s);
    const name = fold(p.segments.at(-1));
    const parent = p.segments.slice(0, -1);
    // A worktree already under `branches/` (even one named `main`) gets a sibling; the checkout named `main` gets `branches/` beside it.
    const segments = fold(parent.at(-1)) === 'branches' ? [...parent, slug] : name === 'main' ? [...parent, 'branches', slug] : [...parent, `${p.segments.at(-1) ?? ''}-worktrees`, slug];
    const sep = os === 'windows' ? '\\' : '/';
    return os === 'windows' ? `${p.prefix.replace(/\//g, '\\')}\\${segments.join(sep)}` : `/${segments.join(sep)}`;
}
