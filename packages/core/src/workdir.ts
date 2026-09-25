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
    /**
     * The worktree of `branch` at `path` in `repo`, made idempotent (#617): a worktree already there on `branch` is
     * `reused`; a `branch` no worktree holds is checked out at `path` again (`recreated`); otherwise
     * `git worktree add -b branch path [base]`. A `path` that holds anything else is `worktree-mismatch`.
     */
    | { readonly kind: 'worktree'; readonly repo: string; readonly branch: string; readonly base?: string; readonly path: string }
    /**
     * Every checkout of `origin` under the environment's `cwdRoots` (#330): the roots walked
     * `depth` levels down (default and cap `FS_LOCATE_MAX_DEPTH`), compared with `sameOrigin`.
     * How a project finds its repo on a machine where it has no folder yet.
     */
    | { readonly kind: 'locate'; readonly origin: string; readonly depth?: number }
    /**
     * A session's folder, read-only (#559; the `files` daemon feature). Every one carries `root`, the session's `cwd`
     * (absolute, machine-native, within the environment's `cwdRoots`), and names files by `path` relative to it with
     * `/` separators (`''` is `root` itself); the daemon refuses a `path` outside `root` and a `root` outside the roots.
     */
    /** One level of `path`: files and folders, `.git` and ignored entries left out. */
    | { readonly kind: 'tree'; readonly root: string; readonly path: string }
    /**
     * One file's text at `rev` (default `working`, the file on disk). `head` is the last commit, `base` the merge-base
     * with `base` (a ref name) or, without one, the one the daemon's VCS resolves. Binary files answer metadata only.
     */
    | { readonly kind: 'read'; readonly root: string; readonly path: string; readonly rev?: FsReadRev; readonly base?: string }
    /** What changed in `root`: uncommitted work, or everything on the branch since its merge-base with `base`. */
    | { readonly kind: 'changes'; readonly root: string; readonly scope: ChangeScope; readonly base?: string }
    /**
     * A project-configured command (#617; the `run` daemon feature): `argv[0]` with the rest as its arguments, in `cwd`
     * (within the roots), never through a shell. How a project creates or prepares a worktree its own way. At most
     * `timeoutMs` (default `FS_RUN_DEFAULT_TIMEOUT_MS`, capped at `FS_RUN_MAX_TIMEOUT_MS`), then `timeout`.
     */
    | { readonly kind: 'run'; readonly cwd: string; readonly argv: readonly string[]; readonly timeoutMs?: number }
    /**
     * Every worktree of the repository `root` belongs to (#622; the `worktrees` daemon feature), read-only: what a
     * session's Files / Changes may switch to for a look, without the session moving (EXE-12).
     */
    | { readonly kind: 'worktrees'; readonly root: string }
    /**
     * Remove the worktree at `path` of `repo` (#623), never by force: one with uncommitted or untracked changes is
     * `dirty` and stays, one on another branch than `branch` is `worktree-mismatch`. With `deleteBranch`, `branch` is
     * then deleted if merged (`git branch -d`); an unmerged one is kept (`branchDeleted: false`).
     */
    | { readonly kind: 'worktree-remove'; readonly repo: string; readonly path: string; readonly branch?: string; readonly deleteBranch?: boolean }
    /**
     * Pin file lines to a commit (#752; the `pin` daemon feature, PRJ-11): lines `from`–`to` (1-based, inclusive) of
     * `path` (relative to `root`, `/`-separated, as the `files` kinds name it) as committed at the HEAD of the repository
     * `root` is in, answered with that commit's full sha. `root` lies within the environment's `cwdRoots`. At most
     * `FS_PIN_MAX_LINES` lines; a `to` past the file's end stops at its last line.
     */
    | { readonly kind: 'pin'; readonly root: string; readonly path: string; readonly from: number; readonly to: number }
    /** The same lines read back at `sha` (#752), however the file changed since: how a pinned file ref shows its code. */
    | { readonly kind: 'read-at'; readonly root: string; readonly path: string; readonly sha: string; readonly from: number; readonly to: number };

/** Which version of a file a `read` returns (#559). */
export type FsReadRev = 'working' | 'head' | 'base';

/** What a `changes` covers (#559): the working tree against HEAD, or the branch against its merge-base. */
export type ChangeScope = 'uncommitted' | 'branch';

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
    /** The worktree was already at `path` on `branch`; nothing was changed. */
    readonly reused?: true;
    /** `branch` existed with no worktree holding it and was checked out at `path` again. */
    readonly recreated?: true;
}

/**
 * What a `run` did (#617). A command that exits non-zero is still a result — the caller judges `exitCode`; one that
 * cannot start is `not-found`, one that outlives its time `timeout`. The tails are the last `FS_RUN_OUTPUT_TAIL`
 * characters of each stream.
 */
export interface FsRunResult {
    readonly kind: 'run';
    readonly exitCode: number;
    readonly stdoutTail: string;
    readonly stderrTail: string;
}

export interface FsLocateResult {
    readonly kind: 'locate';
    readonly origin: string;
    /** Repos and worktrees of `origin` under the roots, roots first, shallowest first. */
    readonly matches: readonly { readonly path: string; readonly git: FsGitInfo }[];
    /** More than `FS_LOCATE_MAX_MATCHES` checkouts: only the first ones are listed. */
    readonly truncated: boolean;
}

/** How a file differs from the committed version (#559). VCS-neutral: a provider maps its own codes onto these. */
export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** One entry of a `tree` listing. */
export interface FsTreeEntry {
    readonly name: string;
    /** Relative to the request's `root`, `/`-separated. */
    readonly path: string;
    readonly type: 'file' | 'dir' | 'symlink';
    /** Bytes, for a file. */
    readonly size?: number;
    /** Set when the file (or, for a folder, something inside it) differs from the committed version. */
    readonly change?: FileChangeStatus;
}

export interface FsTreeResult {
    readonly kind: 'tree';
    readonly root: string;
    /** The listed folder, relative to `root` (`''` for `root`). */
    readonly path: string;
    /** Folders first, then files, each by name. */
    readonly entries: readonly FsTreeEntry[];
    /** More than `FS_LIST_MAX_ENTRIES` entries: only the first ones are listed. */
    readonly truncated: boolean;
    /** An ignore filter (`.gitignore`) was applied, so ignored entries are not listed. */
    readonly ignoredHidden: boolean;
}

/**
 * One file (#559). `text` for a text file of at most `FS_READ_MAX_BYTES`; a binary file carries `binary: true` and no
 * text. A larger text file is the error `too-large`, never a truncated text.
 */
export interface FsReadResult {
    readonly kind: 'read';
    readonly path: string;
    readonly rev: FsReadRev;
    /** Bytes on disk (or in the revision). */
    readonly size: number;
    readonly text?: string;
    readonly binary?: true;
    /** Line count of `text`. */
    readonly lines?: number;
}

/** One changed file in a `ChangeSet`. `added` / `removed` are line counts, absent for a binary file. */
export interface ChangedFile {
    /** Relative to the request's `root`, `/`-separated. */
    readonly path: string;
    /** The previous path of a rename. */
    readonly oldPath?: string;
    readonly status: FileChangeStatus;
    readonly added?: number;
    readonly removed?: number;
    readonly binary?: true;
}

/** One commit on the branch since its merge-base (`scope: 'branch'`). */
export interface ChangeCommit {
    readonly id: string;
    readonly short: string;
    readonly subject: string;
    /** Commit time, epoch ms. */
    readonly at: number;
    readonly author: string;
}

/**
 * What changed in a session's folder (#559), VCS-neutral: `vcs` names the provider that answered (`git` first).
 * `files` are the uncommitted changes for `scope: 'uncommitted'`, the branch's against its merge-base for `branch`;
 * `commits` are the branch's commits since the merge-base, newest first, in both scopes.
 */
export interface ChangeSet {
    readonly kind: 'changes';
    readonly vcs: string;
    readonly scope: ChangeScope;
    /** The checked-out branch; absent when HEAD is detached. */
    readonly branch?: string;
    /** Short id of HEAD. */
    readonly head?: string;
    /** The ref the branch is compared with, when one resolved. */
    readonly base?: string;
    /** Commits on the branch not on `base`, and the reverse. */
    readonly ahead?: number;
    readonly behind?: number;
    readonly files: readonly ChangedFile[];
    readonly commits: readonly ChangeCommit[];
    /** More than `CHANGES_MAX_FILES` files or `CHANGES_MAX_COMMITS` commits: only the first ones are listed. */
    readonly truncated: boolean;
}

/** One worktree of a repository (#622), as `git worktree list` has it. */
export interface FsWorktreeEntry {
    /** Absolute, machine-native. */
    readonly path: string;
    /** The checked-out branch; absent when HEAD is detached (or the repo is bare). */
    readonly branch?: string;
    /** Short id of HEAD. */
    readonly head?: string;
    readonly detached?: true;
    readonly locked?: true;
    /** Its folder is gone; `git worktree prune` would drop it. */
    readonly prunable?: true;
    /** The worktree `root` itself is in. */
    readonly current?: true;
    /** Outside the environment's `cwdRoots`: listed, but nothing in it can be read. */
    readonly outside?: true;
}

export interface FsWorktreesResult {
    readonly kind: 'worktrees';
    readonly root: string;
    /** The main worktree first, then the linked ones as git lists them. */
    readonly entries: readonly FsWorktreeEntry[];
    /** More than `FS_WORKTREES_MAX` worktrees: only the first ones are listed. */
    readonly truncated: boolean;
}


/** What a `worktree-remove` did (#623): `removed` false when no worktree was at `path`. */
export interface FsWorktreeRemoveResult {
    readonly kind: 'worktree-remove';
    readonly path: string;
    readonly removed: boolean;
    /** Set when the branch was asked to go: whether it went. */
    readonly branchDeleted?: boolean;
}


/**
 * Pinned file lines (#752): `path`'s lines `from`–`to` as committed at `sha` (a full commit id). `to` is the last line
 * actually returned, so `lines.length === to - from + 1`. The answer to both `pin` (at HEAD) and `read-at`.
 */
export interface FsPinnedLines {
    readonly kind: 'pin' | 'read-at';
    readonly path: string;
    readonly sha: string;
    readonly from: number;
    readonly to: number;
    /** The lines, without their line endings. */
    readonly lines: readonly string[];
}

export type FsResult = FsListResult | FsWorktreeResult | FsLocateResult | FsTreeResult | FsReadResult | ChangeSet | FsRunResult | FsWorktreesResult | FsWorktreeRemoveResult | FsPinnedLines;

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
    | 'too-large'
    /** A `worktree` whose `path` exists but is not `branch`'s worktree (#617). */
    | 'worktree-mismatch'
    /** A `worktree-remove` of a worktree holding uncommitted or untracked changes (#623): left as it is. */
    | 'dirty'
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
 * A `read` returns text of at most this many UTF-8 bytes (#559), else the error `too-large`. Chosen so the answer
 * fits one frame (1 MiB) even when JSON doubles every character (`"`, `\`, newline, tab…): a daemon treats a file
 * holding any other C0 control character — which JSON would escape six-fold — as binary (`isBinaryText`).
 */
export const FS_READ_MAX_BYTES = 480 * 1024;
/** A `ChangeSet` lists at most this many files… */
export const CHANGES_MAX_FILES = 500;
/** …and this many commits. */
export const CHANGES_MAX_COMMITS = 100;
/** A `worktrees` answer lists at most this many (#622). */
export const FS_WORKTREES_MAX = 100;
/** A `pin` / `read-at` covers at most this many lines (#752); a wider range is `too-large`. */
export const FS_PIN_MAX_LINES = 200;
/** A `run` without `timeoutMs` stops after this long (#617)… */
export const FS_RUN_DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** …and none runs longer than this. */
export const FS_RUN_MAX_TIMEOUT_MS = 30 * 60_000;
/** A `run` names at most this many arguments, `argv[0]` included. */
export const FS_RUN_MAX_ARGS = 64;
/** A `run` result keeps at most this many trailing characters of stdout and of stderr. */
export const FS_RUN_OUTPUT_TAIL = 8 * 1024;

/**
 * Whether decoded file text must be answered as binary (#559): it holds a NUL or a C0 control character other than
 * tab, line feed, carriage return, form feed and backspace (the ones JSON escapes in two characters). Pure, so the
 * daemon and every test agree.
 */
export function isBinaryText(text: string): boolean {
    // oxlint-disable-next-line no-control-regex
    return /[\u0000-\u0007\u000B\u000E-\u001F]/.test(text);
}

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

/** `~` or `~/…` (`~\…`): a root the daemon expands to its user's home folder (#355). */
export function isHomeRelativeRoot(root: string): boolean {
    return /^~([\\/].*)?$/.test(root);
}

/**
 * The comparable spelling of a requested policy root (#355): a `~` form with
 * its separators unified and no trailing separator; anything else through
 * `normalizePath` when it is absolute, else trimmed as typed. Case is folded
 * on Windows. Only spellings are compared — links are the daemon's business.
 */
export function policyRootKey(root: string, os: HostOs): string {
    const t = root.trim();
    const sep = os === 'windows' ? '\\' : '/';
    let key: string;
    if (isHomeRelativeRoot(t)) key = t.replace(/[\\/]+/g, sep).replace(new RegExp(`\\${sep}+$`), '');
    else key = normalizePath(t, os) ?? t;
    return os === 'windows' ? key.toLowerCase() : key;
}

/**
 * Whether a machine's reported policy is what the platform asked for (#355):
 * it was set from the web and the roots it *requested* (`MachinePolicy.requested`,
 * the input before `~` expansion) are the desired set, order aside. A policy
 * set on the machine, or one a daemon predating #355 reports, never converges —
 * the platform then sends the desired policy once more. No home directory is
 * needed on this side: `~` stays `~`.
 */
export function policyConverged(desired: readonly string[], reported: { readonly source?: 'local' | 'web'; readonly requested?: readonly string[] } | undefined, os: HostOs): boolean {
    if (!reported || reported.source !== 'web') return false;
    const want = new Set(desired.map((r) => policyRootKey(r, os)));
    const have = new Set((reported.requested ?? []).map((r) => policyRootKey(r, os)));
    if (want.size !== have.size) return false;
    for (const k of want) if (!have.has(k)) return false;
    return true;
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
