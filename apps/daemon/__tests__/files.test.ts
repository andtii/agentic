/** `fs.request` `tree` / `read` / `changes` against real temp folders and real git repos (#561). */
// @vitest-environment node
import { CHANGES_MAX_COMMITS, FS_READ_MAX_BYTES, type ChangeSet, type EnvironmentId, type FsOp, type FsReadResult, type FsTreeResult, type LocalEnvironment } from '@agentic/core';
import { fsResult } from '@agentic/daemon-protocol';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerFsRequest, type FsOptions, type FsOutcome } from '../src/fs';
import { parseLog, parseNameStatus, parseNumstat, parseStatus } from '../src/vcs/git';
import type { VcsProvider } from '../src/vcs/provider';
import { runGit } from '../src/vcs/run';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
const link = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

let base: string;
let root: string;
let repo: string;
let plain: string;
let outside: string;
let environments: LocalEnvironment[];

/** `git -C repo …`, quietly, with no signing and no line-ending conversion whatever the global config says. */
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
const put = async (path: string, text: string | Buffer) => {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), text);
};
const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
};

beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'agentic-daemon-files-')));
    root = join(base, 'root');
    repo = join(root, 'repo');
    plain = join(root, 'plain');
    outside = join(base, 'outside');
    await mkdir(repo, { recursive: true });
    await mkdir(join(plain, 'docs'), { recursive: true });
    await writeFile(join(plain, 'docs', 'notes.md'), '# notes\n');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'secret\n');
    environments = [{ id: 'env_a' as EnvironmentId, name: 'A', runtime: 'scripted', cwdRoots: [root], concurrency: 1 }];
});
afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const ask = (op: FsOp, options?: FsOptions): Promise<FsOutcome> => answerFsRequest(environments, 'env_a', op, options);
const errorOf = (outcome: FsOutcome) => ('error' in outcome ? outcome.error.code : undefined);
/** The result, after checking it passes the wire schema the platform decodes it with. */
function resultOf<K extends 'tree' | 'read' | 'changes'>(outcome: FsOutcome, kind: K) {
    if (!('result' in outcome) || outcome.result.kind !== kind) throw new Error(`expected a ${kind} result, got ${JSON.stringify(outcome)}`);
    expect(fsResult.safeParse(outcome.result).success).toBe(true);
    return outcome.result as K extends 'tree' ? FsTreeResult : K extends 'read' ? FsReadResult : ChangeSet;
}
const tree = async (folder: string, path = '', options?: FsOptions) => resultOf(await ask({ kind: 'tree', root: folder, path }, options), 'tree');
const read = async (path: string, rev?: 'working' | 'head' | 'base', folder = repo) => resultOf(await ask({ kind: 'read', root: folder, path, ...(rev ? { rev } : {}) }), 'read');
const changes = async (scope: 'uncommitted' | 'branch', baseRef?: string, folder = repo) => resultOf(await ask({ kind: 'changes', root: folder, scope, ...(baseRef ? { base: baseRef } : {}) }), 'changes');

describe('files: confinement (OPS-01)', () => {
    it('refuses a root outside the working roots, a path climbing out of root, and an absolute path', async () => {
        expect(errorOf(await ask({ kind: 'tree', root: outside, path: '' }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'tree', root: plain, path: '../..' }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: '../../outside/secret.txt' }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: join(outside, 'secret.txt') }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: '/etc/passwd' }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'C:\\Windows\\win.ini' }))).toBe('outside-roots');
        // A sibling folder inside the roots is still outside this session's folder.
        expect(errorOf(await ask({ kind: 'read', root: plain, path: '../repo/x.txt' }))).toBe('outside-roots');
    });

    it('refuses a link that resolves out of the session folder, and follows one that stays inside', async () => {
        await link(outside, join(plain, 'escape'));
        await link(join(plain, 'docs'), join(plain, 'alias'));
        expect(errorOf(await ask({ kind: 'tree', root: plain, path: 'escape' }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'escape/secret.txt' }))).toBe('outside-roots');
        expect((await read('alias/notes.md', undefined, plain)).text).toBe('# notes\n');
        const listed = await tree(plain);
        expect(listed.entries.find((e) => e.name === 'escape')?.type).toBe('symlink');
    });

    it('answers not-found for a missing root, file or folder, and for a folder read as a file', async () => {
        expect(errorOf(await ask({ kind: 'tree', root: join(root, 'gone'), path: '' }))).toBe('not-found');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'nope.txt' }))).toBe('not-found');
        expect(errorOf(await ask({ kind: 'tree', root: plain, path: 'docs/notes.md' }))).toBe('not-found');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'docs' }))).toBe('not-found');
        expect(errorOf(await answerFsRequest(environments, 'env_nope', { kind: 'tree', root: plain, path: '' }))).toBe('unknown-environment');
    });
});

describe('files: a folder under no version control', () => {
    it('lists everything but has no ignore filter and no changes', async () => {
        await writeFile(join(plain, 'a.txt'), 'a\n');
        const listed = await tree(plain);
        expect(listed).toMatchObject({ kind: 'tree', root: plain, path: '', ignoredHidden: false, truncated: false });
        expect(listed.entries.map((e) => [e.name, e.type])).toEqual([
            ['docs', 'dir'],
            ['a.txt', 'file']
        ]);
        expect(listed.entries[1]).toMatchObject({ path: 'a.txt', size: 2 });
        expect((await tree(plain, 'docs')).entries).toEqual([{ name: 'notes.md', path: 'docs/notes.md', type: 'file', size: 8 }]);
        expect(errorOf(await ask({ kind: 'changes', root: plain, scope: 'uncommitted' }))).toBe('not-a-repo');
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'a.txt', rev: 'head' }))).toBe('not-a-repo');
    });
});

describe('files: another VCS plugs in', () => {
    it('asks the providers in turn and answers from the first that owns the folder', async () => {
        const opened: string[] = [];
        const fake: VcsProvider = {
            id: 'fake',
            async open(folder) {
                opened.push(folder);
                return {
                    vcs: 'fake',
                    changes: async (scope) => ({ kind: 'changes', vcs: 'fake', scope, files: [{ path: 'docs/notes.md', status: 'modified', added: 1, removed: 0 }], commits: [], truncated: false }),
                    status: async () => new Map([['docs/notes.md', 'modified' as const]]),
                    ignored: async () => new Set(['docs/hidden.md']),
                    show: async () => ({ kind: 'blob', size: 3, bytes: Buffer.from('old'), partial: false })
                };
            }
        };
        await writeFile(join(plain, 'docs', 'hidden.md'), 'x');
        const options: FsOptions = { vcs: [fake] };
        expect((await ask({ kind: 'changes', root: plain, scope: 'uncommitted' }, options)) as unknown).toMatchObject({ result: { vcs: 'fake', files: [{ path: 'docs/notes.md' }] } });
        const docs = await tree(plain, 'docs', options);
        expect(docs.ignoredHidden).toBe(true);
        expect(docs.entries).toEqual([{ name: 'notes.md', path: 'docs/notes.md', type: 'file', size: 8, change: 'modified' }]);
        expect((await tree(plain, '', options)).entries[0]).toMatchObject({ name: 'docs', change: 'modified' });
        expect(resultOf(await ask({ kind: 'read', root: plain, path: 'docs/notes.md', rev: 'head' }, options), 'read')).toEqual({ kind: 'read', path: 'docs/notes.md', rev: 'head', size: 3, text: 'old', lines: 1 });
        expect(opened.every((f) => f === plain)).toBe(true);
    });
});

describe('files: reading', () => {
    it('reads text with its line count, and answers binary and oversized files as metadata or too-large', async () => {
        await writeFile(join(plain, 'a.txt'), 'one\ntwo\n');
        expect(await read('a.txt', undefined, plain)).toEqual({ kind: 'read', path: 'a.txt', rev: 'working', size: 8, text: 'one\ntwo\n', lines: 2 });
        await writeFile(join(plain, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
        expect(await read('img.png', undefined, plain)).toEqual({ kind: 'read', path: 'img.png', rev: 'working', size: 7, binary: true });
        // Not UTF-8, or a control character JSON would escape six-fold: binary too.
        await writeFile(join(plain, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
        expect((await read('latin1.txt', undefined, plain)).binary).toBe(true);
        await writeFile(join(plain, 'ctl.txt'), 'a\u0001b');
        expect((await read('ctl.txt', undefined, plain)).binary).toBe(true);
        // Past the cap: a text file is too-large; a binary one still answers its metadata.
        await writeFile(join(plain, 'big.txt'), 'x'.repeat(FS_READ_MAX_BYTES + 1));
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'big.txt' }))).toBe('too-large');
        const bigBinary = Buffer.alloc(FS_READ_MAX_BYTES + 10);
        await writeFile(join(plain, 'big.bin'), bigBinary);
        expect(await read('big.bin', undefined, plain)).toEqual({ kind: 'read', path: 'big.bin', rev: 'working', size: bigBinary.length, binary: true });
        // …also one with no NUL early on: bytes that are not UTF-8 are binary at any size, never too-large.
        const bigLatin1 = Buffer.alloc(FS_READ_MAX_BYTES + 10, 0xe9);
        await writeFile(join(plain, 'big-latin1.dat'), bigLatin1);
        expect(await read('big-latin1.dat', undefined, plain)).toEqual({ kind: 'read', path: 'big-latin1.dat', rev: 'working', size: bigLatin1.length, binary: true });
        // A large UTF-8 text whose sniffed prefix ends inside a multi-byte character is still text, so too-large.
        await writeFile(join(plain, 'big-utf8.txt'), 'é'.repeat(FS_READ_MAX_BYTES));
        expect(errorOf(await ask({ kind: 'read', root: plain, path: 'big-utf8.txt' }))).toBe('too-large');
        // Exactly at the cap still reads.
        await writeFile(join(plain, 'edge.txt'), 'y'.repeat(FS_READ_MAX_BYTES));
        expect((await read('edge.txt', undefined, plain)).text?.length).toBe(FS_READ_MAX_BYTES);
    });

    it('normalises the path it answers with', async () => {
        await writeFile(join(plain, 'docs', 'b.md'), 'b');
        expect((await read('./docs//b.md', undefined, plain)).path).toBe('docs/b.md');
        expect((await read('docs\\b.md', undefined, plain)).path).toBe('docs/b.md');
        expect((await tree(plain, 'docs/')).path).toBe('docs');
    });
});

// Each case runs a dozen git processes; a loaded Windows runner needs more than the default 5 s.
describe.skipIf(!hasGit)('files: a git repo', { timeout: 60_000 }, () => {
    beforeEach(async () => {
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'files@example.test');
        git('config', 'user.name', 'files test');
        await put('.gitignore', 'node_modules/\nbuild\n');
        await put('src/app.css', '.a {\n  color: red;\n}\n');
        await put('src/keep.ts', 'export const keep = 1;\n');
        await put('src/old-name.ts', 'export const moved = 1;\n');
        await put('README.md', '# repo\n');
        await put('logo.bin', Buffer.from([0, 1, 2, 3]));
        commit('init');
    });

    it('tree: hides .git and ignored entries, and marks what changed — a folder when something inside did', async () => {
        await mkdir(join(repo, 'node_modules', 'x'), { recursive: true });
        await mkdir(join(repo, 'build'), { recursive: true });
        await put('src/app.css', '.a {\n  color: blue;\n}\n');
        await put('src/new.ts', 'export {};\n');
        const top = await tree(repo);
        expect(top.ignoredHidden).toBe(true);
        expect(top.entries.map((e) => e.name)).toEqual(['src', '.gitignore', 'logo.bin', 'README.md']);
        expect(top.entries[0]).toEqual({ name: 'src', path: 'src', type: 'dir', change: 'modified' });
        expect(top.entries.find((e) => e.name === 'README.md')?.change).toBeUndefined();
        const src = await tree(repo, 'src');
        expect(Object.fromEntries(src.entries.map((e) => [e.name, e.change ?? null]))).toEqual({ 'app.css': 'modified', 'keep.ts': null, 'new.ts': 'untracked', 'old-name.ts': null });
    });

    it('tree still lists when git cannot run, just without the filter or marks', async () => {
        await mkdir(join(repo, 'node_modules'), { recursive: true });
        const listed = await tree(repo, '', { git: join(base, 'no-such-git') });
        expect(listed.ignoredHidden).toBe(false);
        expect(listed.entries.map((e) => e.name)).toContain('node_modules');
        expect(errorOf(await ask({ kind: 'changes', root: repo, scope: 'uncommitted' }, { git: join(base, 'no-such-git') }))).toBe('unsupported');
    });

    it('read: working, head and base texts; a file missing from a revision is not-found', async () => {
        git('checkout', '-q', '-b', 'feature');
        await put('src/app.css', '.a {\n  color: green;\n}\n');
        commit('green');
        await put('src/app.css', '.a {\n  color: blue;\n}\n');
        expect((await read('src/app.css')).text).toContain('blue');
        expect(await read('src/app.css', 'head')).toMatchObject({ rev: 'head', text: '.a {\n  color: green;\n}\n', lines: 3 });
        expect((await read('src/app.css', 'base')).text).toContain('red');
        expect(await read('logo.bin', 'head')).toEqual({ kind: 'read', path: 'logo.bin', rev: 'head', size: 4, binary: true });
        await put('src/fresh.ts', 'new\n');
        expect(errorOf(await ask({ kind: 'read', root: repo, path: 'src/fresh.ts', rev: 'head' }))).toBe('not-found');
        // A deleted file is gone from disk but still in HEAD.
        await unlink(join(repo, 'src', 'keep.ts'));
        expect(errorOf(await ask({ kind: 'read', root: repo, path: 'src/keep.ts' }))).toBe('not-found');
        expect((await read('src/keep.ts', 'head')).text).toBe('export const keep = 1;\n');
        expect(errorOf(await ask({ kind: 'read', root: repo, path: 'src/app.css', rev: 'base', base: 'no-such-branch' }))).toBe('not-found');
    });

    it('read: a committed text past the cap is too-large', async () => {
        await put('huge.txt', 'z'.repeat(FS_READ_MAX_BYTES + 1));
        commit('huge');
        expect(errorOf(await ask({ kind: 'read', root: repo, path: 'huge.txt', rev: 'head' }))).toBe('too-large');
        // A committed binary past the cap, with no NUL to give it away, answers its metadata from the prefix alone.
        await put('huge.dat', Buffer.alloc(FS_READ_MAX_BYTES + 1, 0xe9));
        commit('huge binary');
        expect(await read('huge.dat', 'head')).toEqual({ kind: 'read', path: 'huge.dat', rev: 'head', size: FS_READ_MAX_BYTES + 1, binary: true });
    });

    it('changes (uncommitted): modified, added, deleted, renamed and untracked, with line counts', async () => {
        await put('src/app.css', '.a {\n  color: blue;\n  margin: 0;\n}\n');
        await put('src/staged.ts', 'a\nb\n');
        git('add', 'src/staged.ts');
        await unlink(join(repo, 'README.md'));
        git('mv', 'src/old-name.ts', 'src/new-name.ts');
        await put('src/untracked.ts', 'one\ntwo\nthree\n');
        await put('pic.bin', Buffer.from([0, 9, 9]));
        // Not UTF-8 and no NUL: still binary, not a made-up line count.
        await put('pic.dat', Buffer.from([0xe9, 0x0a, 0xe9]));
        const set = await changes('uncommitted');
        expect(set).toMatchObject({ kind: 'changes', vcs: 'git', scope: 'uncommitted', branch: 'main', base: 'main', ahead: 0, behind: 0, commits: [], truncated: false });
        expect(set.head).toMatch(/^[0-9a-f]{7}$/);
        expect(set.files).toEqual([
            { path: 'README.md', status: 'deleted', added: 0, removed: 1 },
            { path: 'pic.bin', status: 'untracked', binary: true },
            { path: 'pic.dat', status: 'untracked', binary: true },
            { path: 'src/app.css', status: 'modified', added: 2, removed: 1 },
            { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed', added: 0, removed: 0 },
            { path: 'src/staged.ts', status: 'added', added: 2, removed: 0 },
            { path: 'src/untracked.ts', status: 'untracked', added: 3, removed: 0 }
        ]);
    });

    it('changes (branch): ahead and behind of the base, the branch commits newest first, the branch files', async () => {
        git('checkout', '-q', '-b', '47-mobile-drawer');
        await put('src/app.css', '.a {\n  color: green;\n}\n');
        commit('shell: extract breakpoint token');
        await put('src/drawer.ts', 'export const drawer = 1;\n');
        commit('shell: drawer state');
        git('checkout', '-q', 'main');
        await put('CHANGELOG.md', 'x\n');
        commit('main moved on');
        git('checkout', '-q', '47-mobile-drawer');
        await put('src/keep.ts', 'export const keep = 2;\n');

        const branch = await changes('branch');
        expect(branch).toMatchObject({ scope: 'branch', branch: '47-mobile-drawer', base: 'main', ahead: 2, behind: 1, truncated: false });
        expect(branch.commits.map((c) => c.subject)).toEqual(['shell: drawer state', 'shell: extract breakpoint token']);
        expect(branch.commits[0]).toMatchObject({ author: 'files test', short: expect.stringMatching(/^[0-9a-f]{7,}$/) });
        expect(branch.commits[0]!.at).toBeGreaterThan(Date.now() - 600_000);
        // Committed on the branch only: main's CHANGELOG and the uncommitted keep.ts are not in it.
        expect(branch.files).toEqual([
            { path: 'src/app.css', status: 'modified', added: 1, removed: 1 },
            { path: 'src/drawer.ts', status: 'added', added: 1, removed: 0 }
        ]);

        const uncommitted = await changes('uncommitted');
        expect(uncommitted.files.map((f) => f.path)).toEqual(['src/keep.ts']);
        expect(uncommitted.commits).toHaveLength(2);

        // An explicit base; a base that does not exist is not-found.
        expect((await changes('branch', 'main')).ahead).toBe(2);
        expect(errorOf(await ask({ kind: 'changes', root: repo, scope: 'branch', base: 'no-such-branch' }))).toBe('not-found');
        expect(errorOf(await ask({ kind: 'changes', root: repo, scope: 'branch', base: '--output=x' }))).toBe('not-found');
    });

    it('changes: a session folder below the repo root sees paths relative to itself, and only its own files', async () => {
        await put('src/app.css', '.a {\n  color: blue;\n}\n');
        await put('README.md', '# changed\n');
        const set = await changes('uncommitted', undefined, join(repo, 'src'));
        expect(set.files).toEqual([{ path: 'app.css', status: 'modified', added: 1, removed: 1 }]);
        expect((await read('app.css', 'head', join(repo, 'src'))).text).toContain('red');
        expect((await tree(join(repo, 'src'))).entries.find((e) => e.name === 'app.css')?.change).toBe('modified');
    });

    it('changes: a detached HEAD has no branch; with no base to compare there are no branch commits', async () => {
        git('checkout', '-q', '--detach');
        const set = await changes('uncommitted');
        expect(set.branch).toBeUndefined();
        expect(set.head).toMatch(/^[0-9a-f]{7}$/);
        git('checkout', '-q', 'main');
        git('branch', '-q', '-m', 'main', 'trunk');
        const none = await changes('branch');
        expect(none).toMatchObject({ branch: 'trunk', files: [], commits: [] });
        expect(none.base).toBeUndefined();
    });

    it('changes: caps the commits and says so', async () => {
        git('checkout', '-q', '-b', 'long');
        for (let i = 0; i <= CHANGES_MAX_COMMITS; i++) git('commit', '-q', '--allow-empty', '-m', `c${i}`);
        const set = await changes('branch');
        expect(set.commits).toHaveLength(CHANGES_MAX_COMMITS);
        expect(set.truncated).toBe(true);
        expect(set.ahead).toBe(CHANGES_MAX_COMMITS + 1);
    });
});

describe.skipIf(!hasGit)('files: a repo before its first commit', { timeout: 60_000 }, () => {
    it('reports everything as added or untracked', async () => {
        git('init', '-q', '-b', 'main');
        await put('a.txt', 'a\nb\n');
        git('add', 'a.txt');
        await put('b.txt', 'c\n');
        const set = await changes('uncommitted');
        expect(set).toMatchObject({ branch: 'main', commits: [] });
        expect(set.head).toBeUndefined();
        expect(set.files).toEqual([
            { path: 'a.txt', status: 'added', added: 2, removed: 0 },
            { path: 'b.txt', status: 'untracked', added: 1, removed: 0 }
        ]);
        expect(errorOf(await ask({ kind: 'read', root: repo, path: 'a.txt', rev: 'head' }))).toBe('not-found');
    });
});

describe('runGit', () => {
    it('kills a command past maxBytes and reports it as overflow with a non-zero code, never a success', async () => {
        const r = await runGit(process.execPath, ['-e', 'process.stdout.write("x".repeat(1 << 20)); setTimeout(() => {}, 5000)'], { timeoutMs: 20_000, maxBytes: 10 });
        expect(r.overflow).toBe(true);
        expect(r.stdout.toString()).toBe('x'.repeat(10));
        expect(r.code).not.toBe(0);
    });

    it('feeds stdin, reports the exit code, and says missing for a binary that is not there', async () => {
        const echo = await runGit(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeoutMs: 20_000, input: 'a\0b' });
        expect(echo).toMatchObject({ code: 0, overflow: false });
        expect(echo.stdout.toString()).toBe('a\0b');
        expect((await runGit(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 20_000 })).code).toBe(3);
        expect((await runGit(join(tmpdir(), 'agentic-no-such-git'), ['--version'], { timeoutMs: 20_000 })).code).toBe('missing');
        expect((await runGit(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })).code).toBe('timeout');
    });
});

describe('git output parsers', () => {
    it('parses porcelain v2 status with a rename, an unmerged file and an untracked path with spaces', () => {
        const out = ['# branch.oid 0123456789abcdef0123456789abcdef01234567', '# branch.head feat', '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts', '2 R. N... 100644 100644 100644 aaa aaa R100 src/new.ts', 'src/old.ts', 'u UU N... 100644 100644 100644 100644 a b c conflict.ts', '? my notes.md', ''].join('\0');
        expect(parseStatus(out)).toEqual({
            oid: '0123456789abcdef0123456789abcdef01234567',
            branch: 'feat',
            entries: [
                { path: 'src/a b.ts', status: 'modified' },
                { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'renamed' },
                { path: 'conflict.ts', status: 'modified' },
                { path: 'my notes.md', status: 'untracked' }
            ]
        });
        expect(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0')).toEqual({ entries: [] });
    });

    it('parses numstat, name-status and log', () => {
        expect(parseNumstat('1\t2\ta.ts\0-\t-\tlogo.png\0' + '3\t0\t\0old.ts\0new.ts\0')).toEqual(
            new Map<string, unknown>([
                ['a.ts', { added: 1, removed: 2 }],
                ['logo.png', { binary: true }],
                ['new.ts', { added: 3, removed: 0 }]
            ])
        );
        expect(parseNameStatus('M\0a.ts\0R097\0old.ts\0new.ts\0A\0b.ts\0D\0c.ts\0T\0d.ts\0')).toEqual([
            { path: 'a.ts', status: 'modified' },
            { path: 'new.ts', oldPath: 'old.ts', status: 'renamed' },
            { path: 'b.ts', status: 'added' },
            { path: 'c.ts', status: 'deleted' },
            { path: 'd.ts', status: 'modified' }
        ]);
        expect(parseLog('abc\x1fab\x1f1700000000\x1fAndii\x1fshell: drawer\0\nabd\x1fad\x1f1700000100\x1fAndii\x1f\0')).toEqual([
            { id: 'abc', short: 'ab', subject: 'shell: drawer', at: 1_700_000_000_000, author: 'Andii' },
            { id: 'abd', short: 'ad', subject: '', at: 1_700_000_100_000, author: 'Andii' }
        ]);
    });
});
