/**
 * `fs.request` (#185, architecture §5b): browse the folders inside an
 * environment's `cwdRoots` and add git worktrees there — a folder picker,
 * never a file browser.
 *
 * Every path is checked twice: lexically against the roots first (a path
 * outside is refused before the disk is touched), then again after
 * `realpath` of the path and of every root, so neither `..` nor a symlink or
 * junction can reach outside a root. All reads then go through the resolved
 * path. Git badges are read from files (`.git`, `HEAD`); only a worktree
 * creation runs `git`, through `execFile` with no shell.
 */

import { FS_LIST_MAX_ENTRIES, type FsEntry, type FsError, type FsErrorCode, type FsGitInfo, type FsOp, type FsResult, type LocalEnvironment } from '@agentic/core';
import { LIMITS } from '@agentic/daemon-protocol';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { silentLogger, type Logger } from './logger.js';

/** `cwd` lies inside one of `roots` (case-insensitive on Windows) — lexically; `checkWithinRoots` also resolves symlinks. */
export function withinRoots(cwd: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): boolean {
    const norm = (p: string) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const target = norm(cwd);
    return roots.some((root) => {
        const rel = relative(norm(root), target);
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
}

export type RootCheck =
    /** `path`: the request resolved lexically (what the user sees); `real`: after symlinks (what is read). */
    | { readonly ok: true; readonly path: string; readonly real: string; readonly realRoots: readonly string[] }
    | { readonly ok: false; readonly code: 'outside-roots' | 'not-found'; readonly message: string };

const isMissing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '');

/** The roots that exist, symlinks resolved. */
async function realRootsOf(roots: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const root of roots) {
        try {
            out.push(await realpath(resolve(root)));
        } catch {
            // A missing root contains nothing.
        }
    }
    return out;
}

/**
 * Whether `path` is inside one of `roots`: lexically first (answered without
 * touching the disk), then with symlinks resolved on both sides. A path that
 * does not exist is `not-found`; a relative path is outside.
 */
export async function checkWithinRoots(path: string, roots: readonly string[], platform: NodeJS.Platform = process.platform): Promise<RootCheck> {
    const outside: RootCheck = { ok: false, code: 'outside-roots', message: `${path} is outside the working roots` };
    if (!isAbsolute(path) || !withinRoots(path, roots, platform)) return outside;
    // Resolved lexically before `realpath`, so `link/..` means what it looks like.
    const lexical = resolve(path);
    let real: string;
    try {
        real = await realpath(lexical);
    } catch (e) {
        if (isMissing(e)) return { ok: false, code: 'not-found', message: `${path} does not exist` };
        throw e;
    }
    const realRoots = await realRootsOf(roots);
    if (!withinRoots(real, realRoots, platform)) return { ok: false, code: 'outside-roots', message: `${path} resolves outside the working roots` };
    return { ok: true, path: lexical, real, realRoots };
}

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
 * The folder's git badge, from files only: a `.git` directory is a repo
 * (branch from `.git/HEAD`); a `.git` file whose `gitdir:` ends in
 * `worktrees/<name>` is a worktree (branch from `<gitdir>/HEAD`); another
 * `gitdir:` (a submodule) is a repo read the same way.
 */
export async function gitInfo(dir: string): Promise<FsGitInfo | undefined> {
    const dotGit = join(dir, '.git');
    let info;
    try {
        info = await lstat(dotGit);
    } catch {
        return undefined;
    }
    if (info.isDirectory()) return headInfo('repo', await readText(join(dotGit, 'HEAD')));
    if (!info.isFile()) return undefined;
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readText(dotGit)) ?? '');
    if (!pointer) return undefined;
    const gitdir = resolve(dir, pointer[1]!);
    const kind = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitdir) ? 'worktree' : 'repo';
    return headInfo(kind, await readText(join(gitdir, 'HEAD')));
}

// -------------------------------------------------------------------- list

const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

/** Leaves room for the envelope below the 1 MiB frame limit. */
const LISTING_BUDGET_BYTES = LIMITS.frameBytes - 64 * 1024;

async function list(checked: Extract<RootCheck, { ok: true }>, roots: readonly string[], platform: NodeJS.Platform): Promise<FsResult> {
    const dirents = await readdir(checked.real, { withFileTypes: true });
    const candidates = dirents
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !skipped(d.name))
        .sort((a, b) => {
            const x = a.name.toLowerCase();
            const y = b.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
    /** A symlink counts only when it resolves to a directory inside a root. */
    const accepted = async (d: (typeof candidates)[number]): Promise<string | undefined> => {
        const at = join(checked.real, d.name);
        if (d.isDirectory()) return at;
        try {
            const target = await realpath(at);
            return (await stat(target)).isDirectory() && withinRoots(target, checked.realRoots, platform) ? target : undefined;
        } catch {
            return undefined;
        }
    };
    const picked: { name: string; path: string; real: string }[] = [];
    let bytes = 0;
    let truncated = false;
    for (const d of candidates) {
        const real = await accepted(d);
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

// ---------------------------------------------------------------- worktree

interface Run {
    readonly code: number | 'timeout' | 'missing';
    readonly stderr: string;
}

function runGit(git: string, args: readonly string[], timeoutMs: number): Promise<Run> {
    return new Promise((done) => {
        execFile(git, [...args], { shell: false, windowsHide: true, timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (error, _stdout, stderr) => {
            const text = String(stderr ?? '').trim();
            if (!error) return done({ code: 0, stderr: text });
            const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
            if (e.code === 'ENOENT') return done({ code: 'missing', stderr: text });
            if (e.killed) return done({ code: 'timeout', stderr: text });
            done({ code: typeof e.code === 'number' ? e.code : 1, stderr: text || e.message });
        });
    });
}

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

async function worktree(op: Extract<FsOp, { kind: 'worktree' }>, roots: readonly string[], options: Required<Pick<FsOptions, 'git' | 'worktreeTimeoutMs'>> & { platform: NodeJS.Platform }): Promise<FsOutcome> {
    const { platform, git } = options;
    const repo = await checkWithinRoots(op.repo, roots, platform);
    if (!repo.ok) return fail(repo.code, repo.message);
    if (!(await gitInfo(repo.real))) return fail('not-a-repo', `${op.repo} is not a git repository or worktree`);

    // The new folder: inside the roots, not there yet, and whatever of its parents exists resolves inside the roots too.
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
    if (taken) return fail('exists', `${op.path} already exists`);
    const ancestor = await existingAncestor(path);
    const parent = ancestor ? await checkWithinRoots(ancestor, roots, platform) : undefined;
    if (!parent?.ok) return fail('outside-roots', `the parent of ${op.path} is outside the working roots`);

    const checkTimeout = Math.min(10_000, options.worktreeTimeoutMs);
    if (op.branch.startsWith('-')) return fail('invalid-branch', `${op.branch} is not a valid branch name`);
    const format = await runGit(git, ['check-ref-format', '--branch', op.branch], checkTimeout);
    if (format.code === 'missing') return fail('unsupported', 'git is not installed on this machine');
    if (format.code === 'timeout') return fail('timeout', 'git check-ref-format did not finish');
    if (format.code !== 0) return fail('invalid-branch', `${op.branch} is not a valid branch name`);
    const known = await runGit(git, ['-C', repo.real, 'show-ref', '--verify', '--quiet', `refs/heads/${op.branch}`], checkTimeout);
    if (known.code === 0) return fail('branch-exists', `branch ${op.branch} already exists in ${op.repo}`);

    const added = await runGit(git, ['-C', repo.real, 'worktree', 'add', '-b', op.branch, '--', path, ...(op.base ? [op.base] : [])], options.worktreeTimeoutMs);
    if (added.code === 0) return { result: { kind: 'worktree', path, branch: op.branch } };
    if (added.code === 'missing') return fail('unsupported', 'git is not installed on this machine');
    if (added.code === 'timeout') return fail('timeout', `git worktree add did not finish within ${options.worktreeTimeoutMs} ms`);
    if (/a branch named .* already exists/i.test(added.stderr)) return fail('branch-exists', `branch ${op.branch} already exists in ${op.repo}`);
    if (/already exists/i.test(added.stderr)) return fail('exists', `${op.path} already exists`);
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
}

/** Answer one `fs.request` for the environment `environmentId` among `environments`. Never throws. */
export async function answerFsRequest(environments: readonly LocalEnvironment[], environmentId: string, op: FsOp, options: FsOptions = {}): Promise<FsOutcome> {
    const logger = options.logger ?? silentLogger;
    const platform = options.platform ?? process.platform;
    logger.debug('fs: request', { environment: environmentId, op: op.kind, path: op.path, ...(op.kind === 'worktree' ? { repo: op.repo } : {}) });
    const env = environments.find((e) => e.id === environmentId);
    if (!env) return fail('unknown-environment', `no environment ${environmentId} on this machine`);
    try {
        if (op.kind === 'list') {
            const checked = await checkWithinRoots(op.path, env.cwdRoots, platform);
            if (!checked.ok) return fail(checked.code, checked.message);
            return { result: await list(checked, env.cwdRoots, platform) };
        }
        if (op.kind === 'worktree') return await worktree(op, env.cwdRoots, { platform, git: options.git ?? 'git', worktreeTimeoutMs: options.worktreeTimeoutMs ?? 60_000 });
        return fail('unsupported', `unknown fs op ${(op as { kind: string }).kind}`);
    } catch (e) {
        logger.warn('fs: request failed', { environment: environmentId, op: op.kind, error: e });
        if (isMissing(e)) return fail('not-found', `${op.path} does not exist`);
        return fail('internal', e instanceof Error ? e.message : String(e));
    }
}
