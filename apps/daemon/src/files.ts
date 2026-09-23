/**
 * `fs.request` `tree` / `read` / `changes` (#559, #561; the `files` feature): a session's folder, read-only. Beside the
 * folder picker in `fs.ts`, never mixed into it.
 *
 * Confinement: `root` (the session's cwd) must lie in the environment's `cwdRoots` and `path` (relative to it,
 * `/`-separated) in `root` — each checked lexically first, then again after `realpath`, so neither `..` nor a symlink
 * or junction reaches outside. Everything on disk is read through the resolved path. Committed text, change marks,
 * the ignore filter and change sets come from the first `VcsProvider` that owns the folder (git by default); a folder
 * no provider owns still lists and reads, and its `changes` is `not-a-repo`.
 */

import { FS_LIST_MAX_ENTRIES, FS_READ_MAX_BYTES, type ChangeSet, type FsError, type FsErrorCode, type FsOp, type FsReadRev, type FsReadResult, type FsTreeEntry, type FsTreeResult } from '@agentic/core';
import { LIMITS } from '@agentic/daemon-protocol';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkWithinRoots, isMissing, withinRoots } from './roots.js';
import { lineCount, SNIFF_BYTES, textOf } from './text.js';
import { gitProvider } from './vcs/git.js';
import { openRepo, VcsFailure, type VcsProvider, type VcsRepo } from './vcs/provider.js';

export type FilesOp = Extract<FsOp, { kind: 'tree' | 'read' | 'changes' }>;
export type FilesOutcome = { readonly result: FsTreeResult | FsReadResult | ChangeSet } | { readonly error: FsError };

export interface FilesOptions {
    readonly platform?: NodeJS.Platform;
    /** The VCS providers asked in turn. Default: git (with `git` as the binary). */
    readonly providers?: readonly VcsProvider[];
    /** The git binary of the default provider. Default `git` from PATH. */
    readonly git?: string;
}

/** Leaves room for the envelope below the 1 MiB frame limit. */
const LISTING_BUDGET_BYTES = LIMITS.frameBytes - 64 * 1024;

const fail = (code: FsErrorCode, message: string): { error: FsError } => ({ error: { code, message: message.slice(0, LIMITS.text) } });

class Refusal extends Error {
    constructor(
        readonly code: FsErrorCode,
        message: string
    ) {
        super(message);
    }
}

interface Folder {
    /** `root` resolved lexically and after symlinks. */
    readonly path: string;
    readonly real: string;
}

/** `root` inside the roots, and a folder. */
async function folderOf(root: string, roots: readonly string[], platform: NodeJS.Platform): Promise<Folder> {
    const checked = await checkWithinRoots(root, roots, platform);
    if (!checked.ok) throw new Refusal(checked.code, checked.message);
    if (!(await stat(checked.real)).isDirectory()) throw new Refusal('not-found', `${root} is not a folder`);
    return { path: checked.path, real: checked.real };
}

/** `path` relative to the folder: normalised to `/`-separated, `''` for the folder itself, refused when it climbs out. */
function relativePath(folder: Folder, path: string, platform: NodeJS.Platform): { readonly rel: string; readonly lexical: string } {
    const outside = new Refusal('outside-roots', `${path} is outside the session folder`);
    if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) throw outside;
    const lexical = resolve(folder.path, ...path.split(/[\\/]/).filter((p) => p !== ''));
    if (!withinRoots(lexical, [folder.path], platform)) throw outside;
    return { rel: relative(folder.path, lexical).split(sep).join('/'), lexical };
}

/** The resolved path of `lexical`, still inside the folder once symlinks are followed. */
async function onDisk(folder: Folder, lexical: string, shown: string, platform: NodeJS.Platform): Promise<string> {
    let real: string;
    try {
        real = await realpath(lexical);
    } catch (e) {
        if (isMissing(e)) throw new Refusal('not-found', `${shown} does not exist`);
        throw e;
    }
    if (!withinRoots(real, [folder.real], platform)) throw new Refusal('outside-roots', `${shown} resolves outside the session folder`);
    return real;
}

/**
 * The repo that owns the folder, or none. For a listing (`lenient`) a provider that cannot run (no git) owns nothing, so
 * the folder still lists; a `changes` or a committed read says `unsupported` instead.
 */
async function repoOf(providers: readonly VcsProvider[], folder: Folder, lenient = false): Promise<VcsRepo | undefined> {
    try {
        return await openRepo(providers, folder.real);
    } catch (e) {
        if (lenient && e instanceof VcsFailure && e.code === 'unsupported') return undefined;
        throw e;
    }
}

// -------------------------------------------------------------------- tree

async function tree(op: Extract<FsOp, { kind: 'tree' }>, folder: Folder, providers: readonly VcsProvider[], platform: NodeJS.Platform): Promise<FsTreeResult> {
    const { rel, lexical } = relativePath(folder, op.path, platform);
    const real = await onDisk(folder, lexical, op.path || op.root, platform);
    if (!(await stat(real)).isDirectory()) throw new Refusal('not-found', `${op.path} is not a folder`);
    const child = (name: string) => (rel === '' ? name : `${rel}/${name}`);
    const dirents = (await readdir(real, { withFileTypes: true })).filter((d) => d.name !== '.git' && (d.isDirectory() || d.isFile() || d.isSymbolicLink()));

    const repo = await repoOf(providers, folder, true);
    const ignored = repo ? await repo.ignored(dirents.map((d) => child(d.name))) : new Set<string>();
    const marks = repo ? await repo.status() : new Map();
    const changeOf = (path: string, dir: boolean): FsTreeEntry['change'] => {
        if (!dir) return marks.get(path);
        const inside = `${path}/`;
        for (const key of marks.keys()) if (key.startsWith(inside)) return 'modified';
        return undefined;
    };

    const visible = dirents
        .filter((d) => !ignored.has(child(d.name)))
        .map((d) => ({ d, type: (d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file') as FsTreeEntry['type'] }))
        .sort((a, b) => {
            if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
            const x = a.d.name.toLowerCase();
            const y = b.d.name.toLowerCase();
            return x < y ? -1 : x > y ? 1 : a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0;
        });

    const entries: FsTreeEntry[] = [];
    let bytes = 0;
    let truncated = false;
    for (const { d, type } of visible) {
        const path = child(d.name);
        if (path.length > LIMITS.text) continue;
        const cost = 2 * (d.name.length + path.length) + 96;
        if (entries.length >= FS_LIST_MAX_ENTRIES || bytes + cost > LISTING_BUDGET_BYTES) {
            truncated = true;
            break;
        }
        bytes += cost;
        const size = type === 'file' ? await lstat(join(real, d.name)).then((s) => s.size, () => undefined) : undefined;
        const change = changeOf(path, type === 'dir');
        entries.push({ name: d.name, path, type, ...(size !== undefined ? { size } : {}), ...(change ? { change } : {}) });
    }
    return { kind: 'tree', root: op.root, path: rel, entries, truncated, ignoredHidden: repo !== undefined };
}

// -------------------------------------------------------------------- read

/**
 * A read answer from a file's size and bytes — all of them, or only its first `SNIFF_BYTES` when `partial`. Binary is
 * decided first, so a large binary file answers its metadata; only a large text file is `too-large`.
 */
function answer(path: string, rev: FsReadRev, size: number, bytes: Buffer, partial: boolean): FsReadResult {
    const text = textOf(bytes, partial);
    if (text === undefined) return { kind: 'read', path, rev, size, binary: true };
    if (partial) throw new Refusal('too-large', `${path} is ${size} bytes, more than the ${FS_READ_MAX_BYTES} a read returns`);
    return { kind: 'read', path, rev, size, text, lines: lineCount(text) };
}

async function readWorking(real: string, rel: string): Promise<FsReadResult> {
    const info = await stat(real);
    if (!info.isFile()) throw new Refusal('not-found', `${rel} is not a file`);
    const partial = info.size > FS_READ_MAX_BYTES;
    const file = await open(real, 'r');
    try {
        const want = partial ? SNIFF_BYTES : info.size;
        const buffer = Buffer.alloc(want);
        const { bytesRead } = await file.read(buffer, 0, want, 0);
        return answer(rel, 'working', info.size, buffer.subarray(0, bytesRead), partial);
    } finally {
        await file.close();
    }
}

async function read(op: Extract<FsOp, { kind: 'read' }>, folder: Folder, providers: readonly VcsProvider[], platform: NodeJS.Platform): Promise<FsReadResult> {
    const { rel, lexical } = relativePath(folder, op.path, platform);
    if (rel === '') throw new Refusal('not-found', 'the session folder is not a file');
    const rev = op.rev ?? 'working';
    if (rev === 'working') return readWorking(await onDisk(folder, lexical, op.path, platform), rel);
    const repo = await repoOf(providers, folder);
    if (!repo) throw new Refusal('not-a-repo', `${op.root} is not under version control`);
    const blob = await repo.show(rev, rel, { ...(op.base !== undefined ? { base: op.base } : {}), maxBytes: FS_READ_MAX_BYTES, prefixBytes: SNIFF_BYTES });
    if (blob.kind === 'missing') throw new Refusal('not-found', `${rel} is not in ${rev === 'head' ? 'the last commit' : 'the base'}`);
    return answer(rel, rev, blob.size, blob.bytes, blob.partial);
}

// ------------------------------------------------------------------- entry

/** Answer one `tree` / `read` / `changes` inside `roots`. Never throws. */
export async function answerFilesOp(op: FilesOp, roots: readonly string[], options: FilesOptions = {}): Promise<FilesOutcome> {
    const platform = options.platform ?? process.platform;
    const providers = options.providers ?? [gitProvider(options.git ? { git: options.git } : {})];
    try {
        const folder = await folderOf(op.root, roots, platform);
        if (op.kind === 'tree') return { result: await tree(op, folder, providers, platform) };
        if (op.kind === 'read') return { result: await read(op, folder, providers, platform) };
        const repo = await repoOf(providers, folder);
        if (!repo) return fail('not-a-repo', `${op.root} is not under version control`);
        return { result: await repo.changes(op.scope, op.base) };
    } catch (e) {
        if (e instanceof Refusal || e instanceof VcsFailure) return fail(e.code, e.message);
        if (isMissing(e)) return fail('not-found', `${'path' in op ? op.path : op.root} does not exist`);
        return fail('internal', e instanceof Error ? e.message : String(e));
    }
}
