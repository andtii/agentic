/** `fs.request` against real temp trees (#188): listing, the root checks, git badges and `git worktree add`. */
// @vitest-environment node
import { FS_LIST_MAX_ENTRIES, type EnvironmentId, type FsListResult, type FsOp, type LocalEnvironment } from '@agentic/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { answerFsRequest, checkWithinRoots, gitInfo, type FsOutcome } from '../src/fs';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
const link = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

let base: string;
let root: string;
let outside: string;
let environments: LocalEnvironment[];

beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'agentic-daemon-fs-'));
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(join(outside, 'secret'), { recursive: true });
    environments = [{ id: 'env_a' as EnvironmentId, name: 'A', runtime: 'scripted', cwdRoots: [root], concurrency: 1 }];
});
afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const ask = (op: FsOp, environmentId = 'env_a'): Promise<FsOutcome> => answerFsRequest(environments, environmentId, op);
async function listing(path: string): Promise<FsListResult> {
    const outcome = await ask({ kind: 'list', path });
    if (!('result' in outcome) || outcome.result.kind !== 'list') throw new Error(`expected a listing, got ${JSON.stringify(outcome)}`);
    return outcome.result;
}
const errorOf = (outcome: FsOutcome) => ('error' in outcome ? outcome.error.code : undefined);

describe('fs list', () => {
    it('lists subfolders only, sorted case-insensitively, without hidden folders and node_modules', async () => {
        for (const name of ['beta', 'Alpha', 'gamma', '.hidden', 'node_modules', 'Zeta']) await mkdir(join(root, name));
        await writeFile(join(root, 'file.txt'), 'x');
        const result = await listing(root);
        expect(result.entries.map((e) => e.name)).toEqual(['Alpha', 'beta', 'gamma', 'Zeta']);
        expect(result.entries[0]!.path).toBe(join(root, 'Alpha'));
        expect(result.truncated).toBe(false);
    });

    it(`truncates at ${FS_LIST_MAX_ENTRIES} entries`, async () => {
        const names = Array.from({ length: FS_LIST_MAX_ENTRIES + 3 }, (_, i) => `d${String(i).padStart(4, '0')}`);
        await Promise.all(names.map((n) => mkdir(join(root, n))));
        const result = await listing(root);
        expect(result.entries).toHaveLength(FS_LIST_MAX_ENTRIES);
        expect(result.entries.at(-1)!.name).toBe(names[FS_LIST_MAX_ENTRIES - 1]);
        expect(result.truncated).toBe(true);
    });

    it('offers a parent below a root and none on the root itself', async () => {
        await mkdir(join(root, 'a', 'b'), { recursive: true });
        expect((await listing(root)).parent).toBeUndefined();
        expect((await listing(`${root}/`)).parent).toBeUndefined();
        expect((await listing(join(root, 'a'))).parent).toBe(root);
        expect((await listing(join(root, 'a', 'b'))).parent).toBe(join(root, 'a'));
    });

    it('refuses a `..` escape and a relative path before touching the disk; `..` that stays inside is fine', async () => {
        await mkdir(join(root, 'a'));
        expect(errorOf(await ask({ kind: 'list', path: `${root}/../outside` }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'list', path: `${root}/../does-not-exist` }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'list', path: 'root' }))).toBe('outside-roots');
        expect((await listing(`${root}/a/..`)).path).toBe(root);
    });

    it('answers not-found for a missing folder and unknown-environment for an environment it does not have', async () => {
        expect(errorOf(await ask({ kind: 'list', path: join(root, 'missing') }))).toBe('not-found');
        expect(errorOf(await ask({ kind: 'list', path: root }, 'env_nope'))).toBe('unknown-environment');
    });

    it('a symlink / junction out of the root is neither listed nor listable; one to a folder inside is listed', async () => {
        await mkdir(join(root, 'real'));
        await link(outside, join(root, 'escape'));
        await link(join(root, 'real'), join(root, 'alias'));
        const result = await listing(root);
        expect(result.entries.map((e) => e.name)).toEqual(['alias', 'real']);
        expect(errorOf(await ask({ kind: 'list', path: join(root, 'escape') }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'list', path: join(root, 'escape', 'secret') }))).toBe('outside-roots');
        expect(await checkWithinRoots(join(root, 'escape'), [root])).toMatchObject({ ok: false, code: 'outside-roots' });
        expect(await checkWithinRoots(join(root, 'alias'), [root])).toMatchObject({ ok: true, path: join(root, 'alias') });
    });

    it('a symlinked root is followed: its contents are inside', async () => {
        await mkdir(join(outside, 'secret', 'inner'));
        await link(join(outside, 'secret'), join(base, 'linked-root'));
        environments = [{ ...environments[0]!, cwdRoots: [join(base, 'linked-root')] }];
        const result = await listing(join(base, 'linked-root'));
        expect(result.entries.map((e) => e.name)).toEqual(['inner']);
        expect(result.parent).toBeUndefined();
    });
});

describe('fs git badges (files only)', () => {
    it('reads a repo and its branch, a detached HEAD, and a worktree with its branch', async () => {
        const repo = join(root, 'repo');
        await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
        await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        await writeFile(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/x\n');
        const wt = join(root, 'wt');
        await mkdir(wt);
        await writeFile(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
        const detached = join(root, 'detached');
        await mkdir(join(detached, '.git'), { recursive: true });
        await writeFile(join(detached, '.git', 'HEAD'), `${'a1b2c3d4e5'.repeat(4)}\n`);
        await mkdir(join(root, 'plain'));

        const byName = Object.fromEntries((await listing(root)).entries.map((e) => [e.name, e.git]));
        expect(byName).toEqual({
            detached: { kind: 'repo', head: 'a1b2c3d' },
            plain: undefined,
            repo: { kind: 'repo', branch: 'main' },
            wt: { kind: 'worktree', branch: 'feature/x' }
        });
        expect((await listing(repo)).git).toEqual({ kind: 'repo', branch: 'main' });
        expect(await gitInfo(join(root, 'plain'))).toBeUndefined();
    });

    it('a relative gitdir resolves against the worktree folder', async () => {
        await mkdir(join(root, 'r', '.git', 'worktrees', 'w'), { recursive: true });
        await writeFile(join(root, 'r', '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/rel\n');
        await mkdir(join(root, 'w'));
        await writeFile(join(root, 'w', '.git'), 'gitdir: ../r/.git/worktrees/w\n');
        expect(await gitInfo(join(root, 'w'))).toEqual({ kind: 'worktree', branch: 'rel' });
    });
});

describe.skipIf(!hasGit)('fs worktree (real git)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { windowsHide: true, stdio: 'pipe' });
    let repo: string;
    beforeEach(async () => {
        repo = join(root, 'repo');
        await mkdir(repo);
        git(repo, 'init', '-q', '-b', 'main');
        await writeFile(join(repo, 'README'), 'x');
        git(repo, 'add', 'README');
        git(repo, 'commit', '-q', '-m', 'init');
    });

    it('adds a worktree inside the roots, creating missing parents, and lists it with its badge', async () => {
        const path = join(root, 'repo-worktrees', 'feat-a');
        const outcome = await ask({ kind: 'worktree', repo, branch: 'feat/a', path });
        expect(outcome).toEqual({ result: { kind: 'worktree', path, branch: 'feat/a' } });
        expect((await listing(dirname(path))).entries).toEqual([{ name: 'feat-a', path, git: { kind: 'worktree', branch: 'feat/a' } }]);
        // From the worktree itself, a second one.
        const second = join(root, 'repo-worktrees', 'feat-b');
        expect(await ask({ kind: 'worktree', repo: path, branch: 'feat/b', base: 'main', path: second })).toEqual({ result: { kind: 'worktree', path: second, branch: 'feat/b' } });
    }, 60_000);

    it('names branch-exists, invalid-branch, exists, not-a-repo and a target outside the roots', async () => {
        const target = (n: string) => join(root, 'wts', n);
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'main', path: target('a') }))).toBe('branch-exists');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'bad..name', path: target('b') }))).toBe('invalid-branch');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: '-x', path: target('b') }))).toBe('invalid-branch');
        await mkdir(target('taken'), { recursive: true });
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: target('taken') }))).toBe('exists');
        expect(errorOf(await ask({ kind: 'worktree', repo: target('taken'), branch: 'ok', path: target('c') }))).toBe('not-a-repo');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: join(outside, 'wt') }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: `${root}/../wt` }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'worktree', repo: outside, branch: 'ok', path: target('d') }))).toBe('outside-roots');
        // A parent that is a link out of the roots.
        await link(outside, join(root, 'escape'));
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: join(root, 'escape', 'wt') }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: join(root, 'escape', 'deep', 'wt') }))).toBe('outside-roots');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', base: 'no-such-ref', path: target('e') }))).toBe('not-found');
    }, 60_000);
});
