/**
 * Git as a `VcsProvider` (#561). Everything runs `git -C <folder>` through `runGit` (no shell, a timeout, `LC_ALL=C`,
 * `core.quotepath=off`) and reads machine formats only: `status --porcelain=v2 -z`, `diff --numstat -z` /
 * `--name-status -z`, `log -z`, `cat-file --batch-check`. Paths are relative to the folder the repo was opened at —
 * git's repo-relative paths are cut to it with the folder's `--show-prefix`, and `diff --relative` limits the counts
 * to it.
 *
 * The base of a branch: an explicit `base` (the project's git setting), else `main`, else `master`, else what
 * `origin/HEAD` points at. It is compared through its merge-base with HEAD, so a base that moved on since the branch
 * was cut shows as `behind`, not as changes.
 */

import { CHANGES_MAX_COMMITS, CHANGES_MAX_FILES, FS_READ_MAX_BYTES, type ChangeCommit, type ChangedFile, type ChangeScope, type ChangeSet, type FileChangeStatus } from '@agentic/core';
import { LIMITS } from '@agentic/daemon-protocol';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lineCount, textOf } from '../text.js';
import { runGit, type GitRun, type GitRunOptions } from './run.js';
import { VcsFailure, type VcsBlob, type VcsProvider, type VcsRepo } from './provider.js';

export interface GitProviderOptions {
    /** The git binary. Default `git` from PATH. */
    readonly git?: string;
    /** How long one git command may run. Default 30 s. */
    readonly timeoutMs?: number;
}

/** Leaves room for the envelope below the 1 MiB frame limit. */
const CHANGES_BUDGET_BYTES = LIMITS.frameBytes - 64 * 1024;
/** Machine output a listing command may print: generous, and still bounded. */
const LISTING_OUTPUT_BYTES = 8 * 1024 * 1024;

interface StatusEntry {
    readonly path: string;
    readonly oldPath?: string;
    readonly status: FileChangeStatus;
}

interface Status {
    /** HEAD's full id; absent before the first commit. */
    readonly oid?: string;
    /** Absent when HEAD is detached. */
    readonly branch?: string;
    readonly entries: readonly StatusEntry[];
}

interface Counts {
    readonly added?: number;
    readonly removed?: number;
    readonly binary?: true;
}

/** The rest of `record` after its first `fields` space-separated fields — a path may itself hold spaces. */
function after(record: string, fields: number): string {
    let at = 0;
    for (let i = 0; i < fields; i++) {
        at = record.indexOf(' ', at) + 1;
        if (at === 0) return '';
    }
    return record.slice(at);
}

/** A porcelain v2 `XY` against HEAD: index and worktree together, as the user sees the file. */
function statusOf(xy: string): FileChangeStatus | undefined {
    const [x, y] = [xy[0], xy[1]];
    // Added to the index, then deleted from disk: nothing differs from HEAD.
    if (x === 'A') return y === 'D' ? undefined : 'added';
    if (x === 'D' || y === 'D') return 'deleted';
    return 'modified';
}

/** `git status --porcelain=v2 --branch -z` (paths relative to the repo root). */
export function parseStatus(out: string): Status {
    const records = out.split('\0');
    let oid: string | undefined;
    let branch: string | undefined;
    const entries: StatusEntry[] = [];
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        if (r === '') continue;
        if (r.startsWith('# branch.oid ')) {
            const v = r.slice('# branch.oid '.length);
            oid = v === '(initial)' ? undefined : v;
        } else if (r.startsWith('# branch.head ')) {
            const v = r.slice('# branch.head '.length);
            branch = v === '(detached)' ? undefined : v;
        } else if (r.startsWith('1 ')) {
            const status = statusOf(r.slice(2, 4));
            if (status) entries.push({ path: after(r, 8), status });
        } else if (r.startsWith('2 ')) {
            // A rename or copy: the next record is the path it came from.
            const oldPath = records[++i] ?? '';
            entries.push(r[2] === 'C' ? { path: after(r, 9), status: 'added' } : { path: after(r, 9), oldPath, status: 'renamed' });
        } else if (r.startsWith('u ')) {
            entries.push({ path: after(r, 10), status: 'modified' });
        } else if (r.startsWith('? ')) {
            entries.push({ path: r.slice(2), status: 'untracked' });
        }
    }
    return { ...(oid ? { oid } : {}), ...(branch ? { branch } : {}), entries };
}

/** `git diff --numstat -z`: counts by (new) path; a binary file has no line counts. */
export function parseNumstat(out: string): Map<string, Counts> {
    const tokens = out.split('\0');
    const counts = new Map<string, Counts>();
    for (let i = 0; i < tokens.length; i++) {
        const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]!);
        if (!m) continue;
        let path = m[3]!;
        // A rename: `added\tremoved\t` then the old and the new path as their own tokens.
        if (path === '') {
            i += 2;
            path = tokens[i] ?? '';
        }
        if (path === '') continue;
        counts.set(path, m[1] === '-' ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
    }
    return counts;
}

/** `git diff --name-status -z`: one status letter (with a score for renames and copies), then one or two paths. */
export function parseNameStatus(out: string): StatusEntry[] {
    const tokens = out.split('\0');
    const entries: StatusEntry[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const code = tokens[i]!;
        if (code === '') continue;
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
            const oldPath = tokens[++i] ?? '';
            const path = tokens[++i] ?? '';
            entries.push(letter === 'R' ? { path, oldPath, status: 'renamed' } : { path, status: 'added' });
            continue;
        }
        const path = tokens[++i] ?? '';
        const status: FileChangeStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
        entries.push({ path, status });
    }
    return entries;
}

/** `git log -z --format=%H%x1f%h%x1f%ct%x1f%an%x1f%s`. */
export function parseLog(out: string): ChangeCommit[] {
    const commits: ChangeCommit[] = [];
    for (const record of out.split('\0')) {
        const [id, short, at, author, subject] = record.replace(/^\n/, '').split('\x1f');
        if (!id || !short || at === undefined) continue;
        commits.push({ id, short, subject: (subject ?? '').slice(0, LIMITS.text), at: Number(at) * 1000, author: (author ?? '').slice(0, LIMITS.text) });
    }
    return commits;
}

/** Line counts of an untracked file read from disk: every line is added. */
async function untrackedCounts(file: string): Promise<Counts> {
    try {
        const info = await stat(file);
        if (!info.isFile() || info.size > FS_READ_MAX_BYTES) return {};
        const text = textOf(await readFile(file));
        return text === undefined ? { binary: true } : { added: lineCount(text), removed: 0 };
    } catch {
        return {};
    }
}

function repoAt(folder: string, prefix: string, git: string, timeoutMs: number): VcsRepo {
    const run = async (args: readonly string[], options: Partial<GitRunOptions> = {}): Promise<GitRun> => {
        const r = await runGit(git, ['-C', folder, '-c', 'core.quotepath=off', ...args], { timeoutMs, maxBytes: LISTING_OUTPUT_BYTES, ...options });
        if (r.code === 'missing') throw new VcsFailure('unsupported', 'git is not installed on this machine');
        if (r.code === 'timeout') throw new VcsFailure('timeout', `git ${args[0]} did not finish within ${timeoutMs} ms`);
        return r;
    };
    /** Stdout of a command that must succeed. */
    const out = async (args: readonly string[]): Promise<string> => {
        const r = await run(args);
        if (r.overflow) throw new VcsFailure('too-large', `git ${args[0]} printed more than ${LISTING_OUTPUT_BYTES} bytes`);
        if (r.code !== 0) throw new VcsFailure('internal', `git ${args[0]} failed: ${r.stderr}`);
        return r.stdout.toString('utf8');
    };
    /** A repo-relative path cut to the folder, or `undefined` for one outside it. */
    const local = (path: string): string | undefined => (prefix === '' ? path : path.startsWith(prefix) ? path.slice(prefix.length) : undefined);

    const status = async (): Promise<Status> => {
        const raw = parseStatus(await out(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']));
        const entries: StatusEntry[] = [];
        for (const e of raw.entries) {
            const path = local(e.path);
            if (path === undefined || path === '') continue;
            const oldPath = e.oldPath === undefined ? undefined : local(e.oldPath);
            entries.push({ path, status: e.status, ...(oldPath ? { oldPath } : {}) });
        }
        return { ...raw, entries };
    };
    const verified = async (ref: string) => !ref.startsWith('-') && (await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;
    /** The base ref: explicit, else `main`, `master`, what `origin/HEAD` names — or none. */
    const resolveBase = async (explicit: string | undefined): Promise<string | undefined> => {
        if (explicit !== undefined) {
            if (!(await verified(explicit))) throw new VcsFailure('not-found', `base ${explicit} was not found`);
            return explicit;
        }
        for (const candidate of ['main', 'master']) if (await verified(candidate)) return candidate;
        const origin = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
        const named = origin.code === 0 ? origin.stdout.toString('utf8').trim() : '';
        return named !== '' && (await verified(named)) ? named : undefined;
    };
    const mergeBase = async (ref: string): Promise<string | undefined> => {
        const r = await run(['merge-base', 'HEAD', ref]);
        const id = r.code === 0 ? r.stdout.toString('utf8').trim() : '';
        return id === '' ? undefined : id;
    };

    return {
        vcs: 'git',
        async status() {
            return new Map((await status()).entries.map((e) => [e.path, e.status]));
        },
        async ignored(paths) {
            if (paths.length === 0) return new Set();
            // `check-ignore` exits 1 when nothing is ignored; any failure just means no filter.
            const r = await run(['check-ignore', '--stdin', '-z'], { input: paths.join('\0') + '\0' });
            return r.code === 0 ? new Set(r.stdout.toString('utf8').split('\0').filter((p) => p !== '')) : new Set();
        },
        async show(rev, path, options): Promise<VcsBlob> {
            if (/[\r\n]/.test(path)) return { kind: 'missing' };
            let commit = 'HEAD';
            if (rev === 'base') {
                const ref = await resolveBase(options.base);
                const at = ref === undefined ? undefined : await mergeBase(ref);
                if (at === undefined) throw new VcsFailure('not-found', 'the branch has no base to compare with');
                commit = at;
            }
            const check = await run(['cat-file', '--batch-check'], { input: `${commit}:./${path}\n` });
            const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(check.stdout.toString('utf8').trim());
            if (check.code !== 0 || !m || m[2] !== 'blob') return { kind: 'missing' };
            const size = Number(m[3]);
            const partial = size > options.maxBytes;
            const blob = await run(['cat-file', 'blob', m[1]!], { maxBytes: partial ? options.prefixBytes : options.maxBytes });
            // Reading only a prefix kills git once it is read: that overflow is the point, not a failure.
            if (blob.code !== 0 && !(partial && blob.overflow)) throw new VcsFailure('internal', `git cat-file failed: ${blob.stderr}`);
            return { kind: 'blob', size, bytes: blob.stdout, partial };
        },
        async changes(scope: ChangeScope, base?: string): Promise<ChangeSet> {
            const st = await status();
            const baseRef = await resolveBase(base);
            const at = baseRef !== undefined && st.oid !== undefined ? await mergeBase(baseRef) : undefined;
            let ahead: number | undefined;
            let behind: number | undefined;
            let commits: ChangeCommit[] = [];
            if (at !== undefined) {
                const ab = /^(\d+)\s+(\d+)$/.exec((await out(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`])).trim());
                if (ab) [behind, ahead] = [Number(ab[1]), Number(ab[2])];
                commits = parseLog(await out(['log', '-z', '--format=%H%x1f%h%x1f%ct%x1f%an%x1f%s', `-n${CHANGES_MAX_COMMITS + 1}`, `${at}..HEAD`, '--']));
            }
            let truncated = commits.length > CHANGES_MAX_COMMITS;
            commits = commits.slice(0, CHANGES_MAX_COMMITS);

            let entries: StatusEntry[];
            let counts: Map<string, Counts>;
            if (scope === 'uncommitted') {
                entries = [...st.entries];
                // Before the first commit everything is compared with the empty tree.
                const against = st.oid ?? (await out(['hash-object', '-t', 'tree', '--stdin'])).trim();
                counts = parseNumstat(await out(['diff', '--numstat', '-z', '-M', '--relative', against, '--']));
            } else if (at !== undefined) {
                entries = parseNameStatus(await out(['diff', '--name-status', '-z', '-M', '--relative', at, 'HEAD', '--']));
                counts = parseNumstat(await out(['diff', '--numstat', '-z', '-M', '--relative', at, 'HEAD', '--']));
            } else {
                entries = [];
                counts = new Map();
            }

            entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
            const files: ChangedFile[] = [];
            let bytes = commits.reduce((n, c) => n + 2 * (c.subject.length + c.author.length) + 160, 0);
            for (const e of entries) {
                if (e.path.length > LIMITS.text || (e.oldPath?.length ?? 0) > LIMITS.text) continue;
                const size = 2 * (e.path.length + (e.oldPath?.length ?? 0)) + 96;
                if (files.length >= CHANGES_MAX_FILES || bytes + size > CHANGES_BUDGET_BYTES) {
                    truncated = true;
                    break;
                }
                bytes += size;
                let c: Counts = counts.get(e.path) ?? {};
                // A rename git did not pair up in the diff: its old path's removals belong to it.
                const old = e.oldPath === undefined ? undefined : counts.get(e.oldPath);
                if (old && !c.binary && !old.binary) c = { added: (c.added ?? 0) + (old.added ?? 0), removed: (c.removed ?? 0) + (old.removed ?? 0) };
                if (e.status === 'untracked') c = await untrackedCounts(join(folder, e.path));
                files.push({ path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), status: e.status, ...c });
            }

            return {
                kind: 'changes',
                vcs: 'git',
                scope,
                ...(st.branch && st.branch.length <= LIMITS.id ? { branch: st.branch } : {}),
                ...(st.oid ? { head: st.oid.slice(0, 7) } : {}),
                ...(baseRef !== undefined && at !== undefined ? { base: baseRef } : {}),
                ...(ahead !== undefined ? { ahead } : {}),
                ...(behind !== undefined ? { behind } : {}),
                files,
                commits,
                truncated
            };
        }
    };
}

export function gitProvider(options: GitProviderOptions = {}): VcsProvider {
    const git = options.git ?? 'git';
    const timeoutMs = options.timeoutMs ?? 30_000;
    return {
        id: 'git',
        async open(folder) {
            const r = await runGit(git, ['-C', folder, 'rev-parse', '--is-inside-work-tree', '--show-prefix'], { timeoutMs, maxBytes: 64 * 1024 });
            if (r.code === 'missing') throw new VcsFailure('unsupported', 'git is not installed on this machine');
            if (r.code === 'timeout') throw new VcsFailure('timeout', `git rev-parse did not finish within ${timeoutMs} ms`);
            if (r.code !== 0) return undefined;
            const [inside, prefix] = r.stdout.toString('utf8').split(/\r?\n/);
            return inside === 'true' ? repoAt(folder, prefix ?? '', git, timeoutMs) : undefined;
        }
    };
}
