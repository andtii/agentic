/**
 * `fs.request` (#185, architecture §5b): browse the folders inside an
 * environment's `cwdRoots`, add git worktrees there, and locate the checkouts
 * of a repo among them (#331) — a folder picker, never a file browser. A
 * session folder's files (`tree` / `read` / `changes`, #561) are `files.ts`'s.
 *
 * Every path is checked twice: lexically against the roots first (a path
 * outside is refused before the disk is touched), then again after
 * `realpath` of the path and of every root, so neither `..` nor a symlink or
 * junction can reach outside a root. All reads then go through the resolved
 * path. Git badges are read from files (`.git`, `HEAD`, `config`); only a
 * worktree creation runs `git`, through `runGit` with no shell. A `run`
 * (#618) is `run.ts`'s.
 */

import { FS_LIST_MAX_ENTRIES, FS_LOCATE_MAX_DEPTH, FS_LOCATE_MAX_MATCHES, sameOrigin, type FsEntry, type FsError, type FsErrorCode, type FsGitInfo, type FsLocateResult, type FsOp, type FsResult, type LocalEnvironment } from '@agentic/core';
import { LIMITS } from '@agentic/daemon-protocol';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { silentLogger, type Logger } from './logger.js';

import { answerFilesOp } from './files.js';
import { checkWithinRoots, isMissing, withinRoots, type RootCheck } from './roots.js';
import type { VcsProvider } from './vcs/provider.js';
import { runGit } from './vcs/run.js';
import { runCommand } from './run.js';

export { checkWithinRoots, withinRoots, type RootCheck };

// --------------------------------------------------------------------- git

/** Branch names and short shas travel as bounded ids. */
const fitsId = (s: string) => s.length > 0 && s.length <= LIMITS.id;

function headInfo(kind: FsGitInfo['kind'], head: string | undefined): FsGitInfo {
    const text = head?.trim() ?? '';
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    if (ref) return fitsId(ref[1]!) ? { kind, branch: ref[1]! } : { kind };
    if (/^[0-9a-f]{40,64}$/i.test(text)) return { kind, head: text.slice(0, 7) };
    return { kind };
}

const readText = (path: string) => readFile(path, 'utf8').catch(() => undefined);

/**
 * The `url` of `[remote "origin"]` in a git config file: the first one under
 * that section, read line by line (the section name case-insensitively, the
 * subsection as written; `;` and `#` lines are comments). Nothing else of
 * the config is interpreted.
 */
export function originUrl(config: string): string | undefined {
    let inOrigin = false;
    for (const raw of config.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
        if (line.startsWith('[')) {
            const section = /^\[([^\s"\]]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(line);
            inOrigin = section !== null && section[1]!.toLowerCase() === 'remote' && section[2] === 'origin';
            continue;
        }
        if (!inOrigin) continue;
        const url = /^url\s*=\s*(.*)$/i.exec(line)?.[1]?.trim();
        if (url !== undefined) return url !== '' && url.length <= LIMITS.text ? url : undefined;
    }
    return undefined;
}

/**
 * The origin URL of the repo whose gitdir is `gitdir`, from its common config
 * file: `<gitdir>/config`, or for a worktree's gitdir the config of the repo
 * its `commondir` file points to.
 */
async function originOf(gitdir: string): Promise<string | undefined> {
    const commondir = (await readText(join(gitdir, 'commondir')))?.trim();
    const config = await readText(join(commondir ? resolve(gitdir, commondir) : gitdir, 'config'));
    return config === undefined ? undefined : originUrl(config);
}

async function badge(kind: FsGitInfo['kind'], gitdir: string): Promise<FsGitInfo> {
    const info = headInfo(kind, await readText(join(gitdir, 'HEAD')));
    const origin = await originOf(gitdir);
    return origin === undefined ? info : { ...info, origin };
}

/**
 * The folder's git badge, from files only: a `.git` directory is a repo
 * (branch from `.git/HEAD`); a `.git` file whose `gitdir:` ends in
 * `worktrees/<name>` is a worktree (branch from `<gitdir>/HEAD`); another
 * `gitdir:` (a submodule) is a repo read the same way. `origin` comes from
 * the repo's common `config` (#331).
 */
export async function gitInfo(dir: string): Promise<FsGitInfo | undefined> {
    const dotGit = join(dir, '.git');
    let info;
    try {
        info = await lstat(dotGit);
    } catch {
        return undefined;
    }
    if (info.isDirectory()) return badge('repo', dotGit);
    if (!info.isFile()) return undefined;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? '');
    if (!pointer) return undefined;
    const gitdir = resolve(dir, pointer[1]!);
    const kind = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitdir) ? 'worktree' : 'repo';
    return badge(kind, gitdir);
}

// -------------------------------------------------------------------- list

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

/** The subfolders (and links) of `real` that a listing considers, sorted case-insensitively, hidden ones and `node_modules` left out. */
async function subfolders(real: string): Promise<Dirent[]> {
    const dirents = await readdir(real, { withFileTypes: true });
    return dirents
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !skipped(d.name))
        .sort((a, b) => {
            const x = a.name.toLowerCase();
            const y = b.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
}

/** The resolved path of subfolder `d` of `real`; a symlink counts only when it resolves to a directory inside a root. */
async function accepted(real: string, d: Dirent, realRoots: readonly string[], platform: NodeJS.Platform): Promise<string | undefined> {
    const at = join(real, d.name);
    if (d.isDirectory()) return at;
    try {
        const target = await realpath(at);
        return (await stat(target)).isDirectory() && withinRoots(target, realRoots, platform) ? target : undefined;
    } catch {
        return undefined;
    }
}

/** Leaves room for the envelope below the 1 MiB frame limit. */
const LISTING_BUDGET_BYTES = LIMITS.frameBytes - 64 * 1024;

async function list(checked: Extract<RootCheck, { ok: true }>, roots: readonly string[], platform: NodeJS.Platform): Promise<FsResult> {
    const candidates = await subfolders(checked.real);
    const picked: { name: string; path: string; real: string }[] = [];
    let bytes = 0;
    let truncated = false;
    for (const d of candidates) {
        const real = await accepted(checked.real, d, checked.realRoots, platform);
        if (real === undefined) continue;
        const path = join(checked.path, d.name);
        if (path.length > LIMITS.text) continue;
        const size = 2 * (d.name.length + path.length) + 128;
        if (picked.length >= FS_LIST_MAX_ENTRIES || bytes + size > LISTING_BUDGET_BYTES) {
            truncated = true;
            break;
        }
        bytes += size;
        picked.push({ name: d.name, path, real });
    }
    const entries: FsEntry[] = await Promise.all(
        picked.map(async (p) => {
            const git = await gitInfo(p.real);
            return { name: p.name, path: p.path, ...(git ? { git } : {}) };
        })
    );
    const fold = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const isRoot = roots.some((r) => fold(r) === fold(checked.path));
    const git = await gitInfo(checked.real);
    return { kind: 'list', path: checked.path, ...(isRoot ? {} : { parent: dirname(checked.path) }), ...(git ? { git } : {}), entries, truncated };
}

// ------------------------------------------------------------------ locate

/**
 * Every checkout of `op.origin` under the roots (#331): each root in order,
 * walked breadth-first `depth` levels down (capped at `FS_LOCATE_MAX_DEPTH`),
 * so the answer is roots first, shallowest first. The walk follows the
 * listing's rules — no hidden folders or `node_modules`, a symlink or
 * junction only when it resolves to a folder inside the roots — and never
 * visits a resolved folder twice: at each level the folders come before the
 * links beside them, so a link back into a root neither loops nor repeats a
 * match, and a folder is reported under its own name rather than an alias.
 * Paths are reported as the user sees them. A root missing on disk holds
 * nothing; the walk stops once `FS_LOCATE_MAX_MATCHES` are found and the
 * answer says so.
 */
async function locate(op: Extract<FsOp, { kind: 'locate' }>, roots: readonly string[], platform: NodeJS.Platform): Promise<FsLocateResult> {
    const depth = Math.min(op.depth ?? FS_LOCATE_MAX_DEPTH, FS_LOCATE_MAX_DEPTH);
    const fold = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
    const seen = new Set<string>();
    const matches: { path: string; git: FsGitInfo }[] = [];
    let truncated = false;
    for (const root of roots) {
        const checked = await checkWithinRoots(root, roots, platform);
        if (!checked.ok) continue;
        let level: { path: string; real: string }[] = [{ path: checked.path, real: checked.real }];
        for (let d = 0; d <= depth && level.length > 0 && !truncated; d++) {
            const next: typeof level = [];
            for (const at of level) {
                if (seen.has(fold(at.real))) continue;
                seen.add(fold(at.real));
                const git = await gitInfo(at.real);
                if (git?.origin !== undefined && sameOrigin(git.origin, op.origin)) {
                    if (matches.length >= FS_LOCATE_MAX_MATCHES) {
                        truncated = true;
                        break;
                    }
                    matches.push({ path: at.path, git });
                }
                if (d === depth) continue;
                let below: Dirent[];
                try {
                    below = await subfolders(at.real);
                } catch {
                    // A folder that cannot be read holds nothing the walk can reach.
                    continue;
                }
                const links: typeof level = [];
                for (const dirent of below) {
                    const real = await accepted(at.real, dirent, checked.realRoots, platform);
                    const path = join(at.path, dirent.name);
                    if (real !== undefined && path.length <= LIMITS.text) (dirent.isDirectory() ? next : links).push({ path, real });
                }
                next.push(...links);
            }
            level = next;
        }
        if (truncated) break;
    }
    return { kind: 'locate', origin: op.origin, matches, truncated };
}

// ---------------------------------------------------------------- worktree

/** The nearest ancestor of `path` (itself excluded) that exists. */
async function existingAncestor(path: string): Promise<string | undefined> {
    for (let at = dirname(path); ; at = dirname(at)) {
        try {
            await lstat(at);
            return at;
        } catch {
            if (dirname(at) === at) return undefined;
        }
    }
}

const fail = (code: FsErrorCode, message: string): { error: FsError } => ({ error: { code, message: message.slice(0, LIMITS.text) } });

/** One entry of `git worktree list --porcelain`: its folder and the branch it has checked out (none when detached). */
interface ListedWorktree {
    readonly path: string;
    readonly branch?: string;
}

/** Parse `git worktree list --porcelain -z`: records of `key value` fields, each record ended by an empty field. */
export function parseWorktreeList(out: string): ListedWorktree[] {
    const listed: ListedWorktree[] = [];
    let path: string | undefined;
    let branch: string | undefined;
    for (const field of out.split('\0')) {
        if (field === '') {
            if (path !== undefined) listed.push(branch !== undefined ? { path, branch } : { path });
            path = branch = undefined;
        } else if (field.startsWith('worktree ')) path = field.slice('worktree '.length);
        else if (field.startsWith('branch refs/heads/')) branch = field.slice('branch refs/heads/'.length);
    }
    if (path !== undefined) listed.push(branch !== undefined ? { path, branch } : { path });
    return listed;
}

/** `a` and `b` name the same folder: both resolved through links, compared the way the platform's file system does. */
async function sameFolder(a: string, b: string, platform: NodeJS.Platform): Promise<boolean> {
    const real = async (p: string) => realpath(p).catch(() => resolve(p));
    const [x, y] = await Promise.all([real(a), real(b)]);
    return platform === 'win32' || platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The worktree of `branch` at `path` (#617, #618), idempotent: a worktree already there on `branch` is `reused`, a
 * `branch` no worktree holds is checked out there again (`recreated`), anything else at `path` is
 * `worktree-mismatch`, and a `branch` checked out in another folder is `branch-exists`. Only then
 * `git worktree add -b`. Entries whose folder is gone are pruned first, so a worktree removed by hand counts as none.
 */
async function worktree(op: Extract<FsOp, { kind: 'worktree' }>, roots: readonly string[], options: Required<Pick<FsOptions, 'git' | 'worktreeTimeoutMs'>> & { platform: NodeJS.Platform }): Promise<FsOutcome> {
    const { platform, git } = options;
    const repo = await checkWithinRoots(op.repo, roots, platform);
    if (!repo.ok) return fail(repo.code, repo.message);
    if (!(await gitInfo(repo.real))) return fail('not-a-repo', `${op.repo} is not a git repository or worktree`);

    // The folder: inside the roots, and whatever of it (or of its parents) exists resolves inside the roots too.
    if (!isAbsolute(op.path) || !withinRoots(op.path, roots, platform)) return fail('outside-roots', `${op.path} is outside the working roots`);
    const path = resolve(op.path);
    // Only a successful lstat means taken; a permission or I/O error is not "exists" and reaches the caller as `internal`.
    const taken = await lstat(path).then(
        () => true,
        (e: unknown) => {
            if (isMissing(e)) return false;
            throw e;
        }
    );
    const ancestor = taken ? path : await existingAncestor(path);
    const parent = ancestor ? await checkWithinRoots(ancestor, roots, platform) : undefined;
    if (!parent?.ok) return fail('outside-roots', `${taken ? '' : 'the parent of '}${op.path} is outside the working roots`);

    const checkTimeout = Math.min(10_000, options.worktreeTimeoutMs);
    if (op.branch.startsWith('-')) return fail('invalid-branch', `${op.branch} is not a valid branch name`);
    const format = await runGit(git, ['check-ref-format', '--branch', op.branch], { timeoutMs: checkTimeout });
    if (format.code === 'missing') return fail('unsupported', 'git is not installed on this machine');
    if (format.code === 'timeout') return fail('timeout', 'git check-ref-format did not finish');
    if (format.code !== 0) return fail('invalid-branch', `${op.branch} is not a valid branch name`);

    const pruned = await runGit(git, ['-C', repo.real, 'worktree', 'prune'], { timeoutMs: checkTimeout });
    if (pruned.code === 'timeout') return fail('timeout', 'git worktree prune did not finish');
    const list = await runGit(git, ['-C', repo.real, 'worktree', 'list', '--porcelain', '-z'], { timeoutMs: checkTimeout });
    if (list.code === 'timeout') return fail('timeout', 'git worktree list did not finish');
    if (list.code !== 0) return fail('internal', `git worktree list failed: ${list.stderr}`);
    const listed = parseWorktreeList(list.stdout.toString('utf8'));
    let at: ListedWorktree | undefined;
    for (const w of listed) if (await sameFolder(w.path, path, platform)) at = w;
    if (at) {
        if (at.branch === op.branch) return { result: { kind: 'worktree', path, branch: op.branch, reused: true } };
        return fail('worktree-mismatch', `${op.path} is the worktree of ${at.branch ? `branch ${at.branch}` : 'a detached HEAD'}, not ${op.branch}`);
    }
    if (taken) return fail('worktree-mismatch', `${op.path} already exists and is not a worktree of ${op.branch}`);
    const holder = listed.find((w) => w.branch === op.branch);
    if (holder) return fail('branch-exists', `branch ${op.branch} is checked out at ${holder.path}`);

    const known = await runGit(git, ['-C', repo.real, 'show-ref', '--verify', '--quiet', `refs/heads/${op.branch}`], { timeoutMs: checkTimeout });
    const recreate = known.code === 0;
    const args = recreate ? ['worktree', 'add', '--', path, op.branch] : ['worktree', 'add', '-b', op.branch, '--', path, ...(op.base ? [op.base] : [])];
    const added = await runGit(git, ['-C', repo.real, ...args], { timeoutMs: options.worktreeTimeoutMs });
    if (added.code === 0) return { result: { kind: 'worktree', path, branch: op.branch, ...(recreate ? { recreated: true as const } : {}) } };
    if (added.code === 'missing') return fail('unsupported', 'git is not installed on this machine');
    if (added.code === 'timeout') return fail('timeout', `git worktree add did not finish within ${options.worktreeTimeoutMs} ms`);
    if (/a branch named .* already exists|is already (checked out|used by worktree)/i.test(added.stderr)) return fail('branch-exists', `branch ${op.branch} already exists in ${op.repo}`);
    if (/already exists/i.test(added.stderr)) return fail('worktree-mismatch', `${op.path} already exists`);
    if (/invalid reference|not a valid (object|commit)/i.test(added.stderr)) return fail('not-found', `base ${op.base ?? 'HEAD'} was not found in ${op.repo}`);
    return fail('internal', `git worktree add failed: ${added.stderr}`);
}

// ------------------------------------------------------------------- entry

export type FsOutcome = { readonly result: FsResult } | { readonly error: FsError };

export interface FsOptions {
    readonly platform?: NodeJS.Platform;
    readonly logger?: Logger;
    /** The git binary. Default `git` from PATH. */
    readonly git?: string;
    /** How long `git worktree add` may run. Default 60 s. */
    readonly worktreeTimeoutMs?: number;
    /** The VCS providers behind `tree` / `read` / `changes` (#561). Default: git, with `git` as the binary. */
    readonly vcs?: readonly VcsProvider[];
    /** The environment a `run` command sees (#618). Default: the daemon's own. */
    readonly runEnv?: NodeJS.ProcessEnv;
}

/** Answer one `fs.request` for the environment `environmentId` among `environments`. Never throws. */
export async function answerFsRequest(environments: readonly LocalEnvironment[], environmentId: string, op: FsOp, options: FsOptions = {}): Promise<FsOutcome> {
    const logger = options.logger ?? silentLogger;
    const platform = options.platform ?? process.platform;
    logger.debug('fs: request', { environment: environmentId, op: op.kind, ...('root' in op ? { root: op.root } : {}), ...('path' in op ? { path: op.path } : {}), ...('origin' in op ? { origin: op.origin } : {}), ...('scope' in op ? { scope: op.scope } : {}), ...('base' in op && op.base !== undefined ? { base: op.base } : {}), ...(op.kind === 'worktree' ? { repo: op.repo } : {}) });
    const env = environments.find((e) => e.id === environmentId);
    if (!env) return fail('unknown-environment', `no environment ${environmentId} on this machine`);
    try {
        if (op.kind === 'list') {
            const checked = await checkWithinRoots(op.path, env.cwdRoots, platform);
            if (!checked.ok) return fail(checked.code, checked.message);
            return { result: await list(checked, env.cwdRoots, platform) };
        }
        if (op.kind === 'worktree') return await worktree(op, env.cwdRoots, { platform, git: options.git ?? 'git', worktreeTimeoutMs: options.worktreeTimeoutMs ?? 60_000 });
        if (op.kind === 'locate') return { result: await locate(op, env.cwdRoots, platform) };
        if (op.kind === 'run') return await runCommand(op, env.cwdRoots, { platform, ...(options.runEnv ? { env: options.runEnv } : {}) });
        return await answerFilesOp(op, env.cwdRoots, { platform, ...(options.git ? { git: options.git } : {}), ...(options.vcs ? { providers: options.vcs } : {}) });
    } catch (e) {
        logger.warn('fs: request failed', { environment: environmentId, op: op.kind, error: e });
        if (isMissing(e)) return fail('not-found', `${'path' in op ? op.path : op.kind} does not exist`);
        return fail('internal', e instanceof Error ? e.message : String(e));
    }
}
