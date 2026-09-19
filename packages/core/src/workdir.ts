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
    | { readonly kind: 'worktree'; readonly repo: string; readonly branch: string; readonly base?: string; readonly path: string }
    /**
     * Every checkout of `origin` under the environment's `cwdRoots` (#330): the roots walked
     * `depth` levels down (default and cap `FS_LOCATE_MAX_DEPTH`), compared with `sameOrigin`.
     * How a project finds its repo on a machine where it has no folder yet.
     */
    | { readonly kind: 'locate'; readonly origin: string; readonly depth?: number };

export interface FsGitInfo {
    /** `repo`: `.git` is a directory; `worktree`: `.git` is a file pointing into another repo's `worktrees/`. */
    readonly kind: 'repo' | 'worktree';
    /** The checked-out branch; absent when HEAD is detached. */
    readonly branch?: string;
    /** Short commit id when HEAD is detached. */
    readonly head?: string;
    /** The `origin` remote's URL as written in the git config (#330); absent without one. The repo's identity across machines. */
    readonly origin?: string;
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

export interface FsLocateResult {
    readonly kind: 'locate';
    readonly origin: string;
    /** Repos and worktrees of `origin` under the roots, roots first, shallowest first. */
    readonly matches: readonly { readonly path: string; readonly git: FsGitInfo }[];
    /** More than `FS_LOCATE_MAX_MATCHES` checkouts: only the first ones are listed. */
    readonly truncated: boolean;
}

export type FsResult = FsListResult | FsWorktreeResult | FsLocateResult;

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
/** A `locate` walks at most this many levels below each root (and `depth` is capped to it). */
export const FS_LOCATE_MAX_DEPTH = 3;
/** A `locate` reports at most this many checkouts. */
export const FS_LOCATE_MAX_MATCHES = 20;

/**
 * The comparable form of a remote URL: scheme, user and a trailing `.git` or `/`
 * dropped, the host case-folded, `git@host:path` read as `host/path`. So
 * `https://github.com/andtii/agentic.git`, `git@github.com:andtii/agentic` and
 * `ssh://git@GitHub.com/andtii/agentic/` are one repo. `''` for a blank.
 */
export function originKey(url: string): string {
    let s = url.trim();
    if (!s) return '';
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(s);
    if (scheme) s = s.slice(scheme[0].length);
    else {
        // scp-like `user@host:path`
        const scp = /^([^@/]+@)?([^:/]+):(.+)$/.exec(s);
        if (scp) s = `${scp[2]}/${scp[3]}`;
    }
    s = s.replace(/^[^@/]+@/, '');
    const slash = s.indexOf('/');
    const host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase();
    let path = slash < 0 ? '' : s.slice(slash);
    path = path.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return `${host}${path}`;
}

/** Whether two remote URLs name the same repo (`originKey` equal and non-empty). */
export function sameOrigin(a: string, b: string): boolean {
    const ka = originKey(a);
    return ka !== '' && ka === originKey(b);
}

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
