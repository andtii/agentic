/**
 * The in-memory daemon's session folders (#559): `fs.request` `tree`, `read` and `changes` answered from a few folders
 * held as `{ path → text }` maps, with an optional fake VCS (the committed and merge-base texts, commits, ignored
 * paths). Confinement is checked the way the real daemon does lexically: `root` within the environment's `cwdRoots`,
 * `path` within `root`.
 */

import {
    CHANGES_MAX_COMMITS,
    CHANGES_MAX_FILES,
    FS_LIST_MAX_ENTRIES,
    FS_PIN_MAX_LINES,
    FS_READ_MAX_BYTES,
    isBinaryText,
    normalizePath,
    pathWithin,
    type ChangeCommit,
    type ChangedFile,
    type ChangeSet,
    type EnvironmentDescriptor,
    type FileChangeStatus,
    type FsError,
    type FsOp,
    type FsResult,
    type FsTreeEntry
} from '@agentic/core';
import type { ConformanceFiles } from './harness.js';

/** A fake VCS over an `InMemoryFolder`: what was committed, what the branch started from, and its history. */
export interface InMemoryVcs {
    /** The provider id a change set names. Default `git`. */
    readonly id?: string;
    readonly branch?: string;
    /** The base ref name a change set names. */
    readonly base?: string;
    readonly ahead?: number;
    readonly behind?: number;
    /** The committed texts (`rev: 'head'`). Default: the working files, i.e. nothing uncommitted. */
    readonly head?: Readonly<Record<string, string>>;
    /** The texts at the merge-base (`rev: 'base'`). Default: `head`, i.e. nothing on the branch. */
    readonly baseFiles?: Readonly<Record<string, string>>;
    /** The branch's commits since the merge-base, newest first. */
    readonly commits?: readonly ChangeCommit[];
    /** Paths an ignore file hides from `tree`. */
    readonly ignored?: readonly string[];
    /** The full id of HEAD, what `pin` answers (#752). Default: the newest commit's id, else `IN_MEMORY_HEAD_SHA`. */
    readonly headSha?: string;
}

/** HEAD's id in a fake repository that names no commit (#752). */
export const IN_MEMORY_HEAD_SHA = 'feedfacefeedfacefeedfacefeedfacefeedface';

/** A session folder on the fake's disk: an absolute POSIX `root` and its files by relative, `/`-separated path. */
export interface InMemoryFolder {
    readonly root: string;
    readonly files: Readonly<Record<string, string>>;
    /** Under version control; absent → `changes` answers `not-a-repo`. */
    readonly vcs?: InMemoryVcs;
}

export const IN_MEMORY_PROJECT_ROOT = '/work/project';
export const IN_MEMORY_PLAIN_ROOT = '/work/plain';

/** The folders the fake holds by default: a repository with uncommitted work and a branch commit, and a plain folder. */
export const IN_MEMORY_SESSION_FOLDERS: readonly InMemoryFolder[] = [
    {
        root: IN_MEMORY_PROJECT_ROOT,
        files: { 'README.md': '# project\n', 'src/app.ts': 'export const answer = 42;\nexport const question = "?";\n', 'dist/out.js': 'built\n' },
        vcs: {
            branch: 'feature/files',
            base: 'main',
            ahead: 1,
            behind: 0,
            head: { 'README.md': '# project\n', 'src/app.ts': 'export const answer = 41;\n', 'old.txt': 'gone\n' },
            baseFiles: { 'README.md': '# project\n', 'old.txt': 'gone\n' },
            commits: [{ id: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe', short: 'c0ffee0', subject: 'app: the answer', at: 1_700_000_000_000, author: 'Fake Author' }],
            ignored: ['dist']
        }
    },
    { root: IN_MEMORY_PLAIN_ROOT, files: { 'notes.txt': 'notes\n' } }
];

/** What the conformance `files` cases read from the default folders. */
export const IN_MEMORY_CONFORMANCE_FILES: ConformanceFiles = {
    root: IN_MEMORY_PROJECT_ROOT,
    file: { path: 'src/app.ts', text: IN_MEMORY_SESSION_FOLDERS[0]!.files['src/app.ts']! },
    changed: true,
    plain: IN_MEMORY_PLAIN_ROOT
};

type Answer = { readonly result: FsResult; readonly error?: undefined } | { readonly result?: undefined; readonly error: FsError };
type FilesOp = Extract<FsOp, { kind: 'tree' | 'read' | 'changes' }>;

const err = (code: FsError['code'], message: string): Answer => ({ error: { code, message } });
const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** `path` relative to a root, resolved: `''` for the root, `null` when it climbs out of it or is absolute (POSIX, UNC or a drive). */
function relative(path: string): string | null {
    if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path)) return null;
    const out: string[] = [];
    for (const s of path.replace(/\\/g, '/').split('/')) {
        if (s === '' || s === '.') continue;
        if (s === '..') {
            if (!out.length) return null;
            out.pop();
        } else out.push(s);
    }
    return out.join('/');
}

/** Past this many cells the line LCS is not computed: every line counts as removed and added. */
const LCS_MAX_CELLS = 1_000_000;

/** Lines added and removed between two texts, by a longest-common-subsequence of lines (conservative for large texts). */
function lineCounts(before: string | undefined, after: string | undefined): { added: number; removed: number } {
    const split = (t: string | undefined) => (t === undefined || t === '' ? [] : t.replace(/\n$/, '').split('\n'));
    const a = split(before);
    const b = split(after);
    if ((a.length + 1) * (b.length + 1) > LCS_MAX_CELLS) return { added: b.length, removed: a.length };
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    const common = lcs[0]![0]!;
    return { added: b.length - common, removed: a.length - common };
}

/** The files that differ between `from` and `to`, by path. `untracked` marks a file `to` adds when it is the working tree. */
function diff(from: Readonly<Record<string, string>>, to: Readonly<Record<string, string>>, added: FileChangeStatus): ChangedFile[] {
    const out: ChangedFile[] = [];
    for (const path of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
        const a = from[path];
        const b = to[path];
        if (a === b) continue;
        const status: FileChangeStatus = a === undefined ? added : b === undefined ? 'deleted' : 'modified';
        out.push({ path, status, ...lineCounts(a, b) });
    }
    return out;
}

function changeSet(folder: InMemoryFolder, vcs: InMemoryVcs, scope: ChangeSet['scope']): ChangeSet {
    const head = vcs.head ?? folder.files;
    const files = scope === 'uncommitted' ? diff(head, folder.files, 'untracked') : diff(vcs.baseFiles ?? head, head, 'added');
    const commits = vcs.commits ?? [];
    return {
        kind: 'changes',
        vcs: vcs.id ?? 'git',
        scope,
        ...(vcs.branch !== undefined ? { branch: vcs.branch } : {}),
        head: (commits[0]?.short ?? '0000000').slice(0, 7),
        ...(vcs.base !== undefined ? { base: vcs.base } : {}),
        ...(vcs.ahead !== undefined ? { ahead: vcs.ahead } : {}),
        ...(vcs.behind !== undefined ? { behind: vcs.behind } : {}),
        files: files.slice(0, CHANGES_MAX_FILES),
        commits: commits.slice(0, CHANGES_MAX_COMMITS),
        truncated: files.length > CHANGES_MAX_FILES || commits.length > CHANGES_MAX_COMMITS
    };
}

function tree(folder: InMemoryFolder, root: string, path: string): Answer {
    const ignored = folder.vcs?.ignored ?? [];
    const hidden = (p: string) => ignored.some((i) => p === i || p.startsWith(`${i}/`));
    const changes = folder.vcs ? new Map(diff(folder.vcs.head ?? folder.files, folder.files, 'untracked').map((f) => [f.path, f.status])) : new Map<string, FileChangeStatus>();
    const prefix = path === '' ? '' : `${path}/`;
    if (path !== '' && folder.files[path] !== undefined) return err('not-found', `${path} is a file, not a folder`);
    const byName = new Map<string, FsTreeEntry>();
    for (const [file, text] of Object.entries(folder.files)) {
        if (!file.startsWith(prefix) || hidden(file)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const entryPath = `${prefix}${name}`;
        const change = slash < 0 ? changes.get(file) : [...changes.keys()].some((c) => c.startsWith(`${entryPath}/`)) ? ('modified' as const) : undefined;
        byName.set(name, slash < 0 ? { name, path: entryPath, type: 'file', size: bytes(text), ...(change ? { change } : {}) } : { name, path: entryPath, type: 'dir', ...(change ? { change } : {}) });
    }
    if (path !== '' && byName.size === 0) return err('not-found', `${path} does not exist`);
    const all = [...byName.values()].sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'dir' ? -1 : 1));
    const entries = all.slice(0, FS_LIST_MAX_ENTRIES);
    return { result: { kind: 'tree', root, path, entries, truncated: all.length > entries.length, ignoredHidden: folder.vcs !== undefined } };
}

function read(folder: InMemoryFolder, path: string, rev: 'working' | 'head' | 'base'): Answer {
    if (rev !== 'working' && !folder.vcs) return err('not-a-repo', `${folder.root} is not under version control`);
    const texts = rev === 'working' ? folder.files : rev === 'head' ? (folder.vcs!.head ?? folder.files) : (folder.vcs!.baseFiles ?? folder.vcs!.head ?? folder.files);
    const text = texts[path];
    if (text === undefined) return err('not-found', `${path} does not exist at ${rev}`);
    const size = bytes(text);
    if (isBinaryText(text)) return { result: { kind: 'read', path, rev, size, binary: true } };
    if (size > FS_READ_MAX_BYTES) return err('too-large', `${path} is ${size} bytes; at most ${FS_READ_MAX_BYTES} are read`);
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { result: { kind: 'read', path, rev, size, text, lines } };
}

/**
 * Answer a session-files `fs.request` over `folders`. `anywhere` (a fault) skips the confinement checks, so the
 * conformance suite can prove it catches a daemon that reads outside its roots.
 */
export function answerFilesOp(folders: readonly InMemoryFolder[], env: EnvironmentDescriptor, op: FilesOp, anywhere = false): Answer {
    const root = normalizePath(op.root, 'linux');
    if (!root || (!anywhere && !pathWithin(root, env.cwdRoots, 'linux'))) return err('outside-roots', `${op.root} is outside the working roots`);
    const path = op.kind === 'changes' ? '' : relative(op.path);
    if (path === null) {
        if (!anywhere) return err('outside-roots', `${op.kind === 'changes' ? '' : op.path} is outside ${op.root}`);
        return err('not-found', `${op.kind === 'changes' ? '' : op.path} does not exist`);
    }
    const folder = folders.find((f) => normalizePath(f.root, 'linux') === root);
    if (!folder) return err('not-found', `${root} does not exist`);
    switch (op.kind) {
        case 'tree':
            return tree(folder, root, path);
        case 'read':
            return read(folder, path, op.rev ?? 'working');
        case 'changes':
            return folder.vcs ? { result: changeSet(folder, folder.vcs, op.scope) } : err('not-a-repo', `${root} is not under version control`);
    }
}

/**
 * `pin` / `read-at` (#752) over `folders`: the fake knows one commit, HEAD, holding the `head` texts. `read-at` answers a
 * `sha` that is HEAD's id or a prefix of it (at least 4 characters) and `not-found` for any other.
 */
export function answerPinOp(folders: readonly InMemoryFolder[], env: EnvironmentDescriptor, op: Extract<FsOp, { kind: 'pin' | 'read-at' }>): Answer {
    const root = normalizePath(op.root, 'linux');
    if (!root || !pathWithin(root, env.cwdRoots, 'linux')) return err('outside-roots', `${op.root} is outside the working roots`);
    const path = relative(op.path);
    if (path === null) return err('outside-roots', `${op.path} is outside ${op.root}`);
    if (!Number.isInteger(op.from) || !Number.isInteger(op.to) || op.from < 1 || op.to < op.from) return err('not-found', `lines ${op.from}-${op.to} are not a range`);
    if (op.to - op.from + 1 > FS_PIN_MAX_LINES) return err('too-large', `a pin covers at most ${FS_PIN_MAX_LINES} lines`);
    const folder = folders.find((f) => normalizePath(f.root, 'linux') === root);
    if (!folder) return err('not-found', `${root} does not exist`);
    if (!folder.vcs) return err('not-a-repo', `${root} is not under version control`);
    const sha = folder.vcs.headSha ?? folder.vcs.commits?.[0]?.id ?? IN_MEMORY_HEAD_SHA;
    if (op.kind === 'read-at' && !(op.sha.length >= 4 && sha.startsWith(op.sha.toLowerCase()))) return err('not-found', `no commit ${op.sha} in ${root}`);
    const text = (folder.vcs.head ?? folder.files)[path];
    if (text === undefined) return err('not-found', `${path} is not a file at ${sha.slice(0, 7)}`);
    if (isBinaryText(text)) return err('unsupported', `${path} is binary at ${sha.slice(0, 7)}`);
    const all = text === '' ? [] : text.replace(/\r?\n$/, '').split('\n').map((l) => l.replace(/\r$/, ''));
    if (op.from > all.length) return err('not-found', `${path} has ${all.length} lines at ${sha.slice(0, 7)}`);
    const to = Math.min(op.to, all.length);
    return { result: { kind: op.kind, path, sha, from: op.from, to, lines: all.slice(op.from - 1, to) } };
}
