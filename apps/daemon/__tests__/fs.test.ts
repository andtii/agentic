/** `fs.request` against real temp trees (#188, #331): listing, the root checks, git badges with their origin, `locate` and `git worktree add`. */
// @vitest-environment node
import { FS_LIST_MAX_ENTRIES, FS_LOCATE_MAX_MATCHES, FS_RUN_OUTPUT_TAIL, type EnvironmentId, type FsListResult, type FsLocateResult, type FsOp, type LocalEnvironment } from '@agentic/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { answerFsRequest, checkWithinRoots, gitInfo, originUrl, parseWorktreeList, withinRoots, type FsOptions, type FsOutcome } from '../src/fs';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
/** A directory link: a junction on Windows (no privilege needed), a symlink elsewhere. */
const link = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
/** Does the volume holding `dir` fold case? A filesystem property: most macOS and Windows volumes do, most Linux ones do not. */
async function foldsCase(dir: string): Promise<boolean> {
    const probe = join(dir, 'case-probe');
    await mkdir(probe, { recursive: true });
    try {
        await stat(probe.toUpperCase());
        return true;
    } catch (e) {
        // Only "no such path" answers the question — anything else is a real failure.
        if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return false;
        throw e;
    }
}

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

const ask = (op: FsOp, environmentId = 'env_a', options?: FsOptions): Promise<FsOutcome> => answerFsRequest(environments, environmentId, op, options);
async function listing(path: string): Promise<FsListResult> {
    const outcome = await ask({ kind: 'list', path });
    if (!('result' in outcome) || outcome.result.kind !== 'list') throw new Error(`expected a listing, got ${JSON.stringify(outcome)}`);
    return outcome.result;
}
async function located(origin: string, depth?: number, options?: FsOptions): Promise<FsLocateResult> {
    const outcome = await ask({ kind: 'locate', origin, ...(depth === undefined ? {} : { depth }) }, 'env_a', options);
    if (!('result' in outcome) || outcome.result.kind !== 'locate') throw new Error(`expected a locate result, got ${JSON.stringify(outcome)}`);
    return outcome.result;
}
const errorOf = (outcome: FsOutcome) => ('error' in outcome ? outcome.error.code : undefined);

const ORIGIN = 'git@github.com:andtii/agentic.git';
const config = (origin: string | null, before = '') => `[core]\n\trepositoryformatversion = 0\n\tbare = false\n${before}${origin === null ? '' : `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`}[branch "main"]\n\tremote = origin\n`;
/** A hand-written repo: `.git/HEAD` on `main` and a config naming `origin` (`null`: none). */
async function repoAt(dir: string, origin: string | null = ORIGIN, extra = ''): Promise<string> {
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(dir, '.git', 'config'), config(origin, extra));
    return dir;
}

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

    it('carries the origin URL from the config of a repo, and of a worktree through its commondir (#331)', async () => {
        const repo = await repoAt(join(root, 'repo'));
        await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
        await writeFile(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/x\n');
        await writeFile(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
        await mkdir(join(root, 'wt'));
        await writeFile(join(root, 'wt', '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
        expect(await gitInfo(repo)).toEqual({ kind: 'repo', branch: 'main', origin: ORIGIN });
        expect(await gitInfo(join(root, 'wt'))).toEqual({ kind: 'worktree', branch: 'feature/x', origin: ORIGIN });
        expect((await listing(root)).entries.map((e) => [e.name, e.git?.origin])).toEqual([
            ['repo', ORIGIN],
            ['wt', ORIGIN]
        ]);
        expect((await listing(repo)).git).toEqual({ kind: 'repo', branch: 'main', origin: ORIGIN });
    });

    it('leaves origin out without an origin remote, and picks origin among other remotes', async () => {
        expect(await gitInfo(await repoAt(join(root, 'none'), null))).toEqual({ kind: 'repo', branch: 'main' });
        const upstreamFirst = await repoAt(join(root, 'two'), 'https://github.com/andtii/agentic.git', '[remote "upstream"]\n\turl = https://github.com/sigx/agentic.git\n');
        expect((await gitInfo(upstreamFirst))?.origin).toBe('https://github.com/andtii/agentic.git');
        const onlyUpstream = await repoAt(join(root, 'up'), null, '[remote "upstream"]\n\turl = https://github.com/sigx/agentic.git\n');
        expect((await gitInfo(onlyUpstream))?.origin).toBeUndefined();
        // A worktree whose gitdir has no commondir reads the config beside its HEAD.
        await mkdir(join(root, 'r2', '.git', 'worktrees', 'w'), { recursive: true });
        await writeFile(join(root, 'r2', '.git', 'worktrees', 'w', 'HEAD'), 'ref: refs/heads/w\n');
        await writeFile(join(root, 'r2', '.git', 'worktrees', 'w', 'config'), config(ORIGIN));
        await mkdir(join(root, 'w2'));
        await writeFile(join(root, 'w2', '.git'), 'gitdir: ../r2/.git/worktrees/w\n');
        expect(await gitInfo(join(root, 'w2'))).toEqual({ kind: 'worktree', branch: 'w', origin: ORIGIN });
    });

    it('originUrl reads only the origin section, skipping comments and blank lines', () => {
        expect(originUrl('[Remote "origin"]\n\t; comment\n\t# comment\n\n\turl = a\n\turl = b\n')).toBe('a');
        expect(originUrl('[remote "origin"]\n[remote "other"]\n\turl = b\n')).toBeUndefined();
        expect(originUrl('[remote "Origin"]\n\turl = b\n')).toBeUndefined();
        expect(originUrl('[remote]\n\turl = b\n[remote "origin"]\n\tURL=  c  \n')).toBe('c');
        expect(originUrl('[remote "origin"]\n\turl =\n')).toBeUndefined();
        expect(originUrl('')).toBeUndefined();
    });
});

describe('fs locate (#331)', () => {
    it('finds every checkout of the origin under the roots, roots first and shallowest first, and nothing outside', async () => {
        await repoAt(join(root, 'a'), 'https://GitHub.com/andtii/agentic.git');
        await repoAt(join(root, 'deep', 'x', 'b'), 'git@github.com:andtii/agentic');
        await repoAt(join(root, 'other'), 'https://github.com/andtii/other.git');
        await repoAt(join(root, 'p', 'q', 'r', 's'));
        await repoAt(join(root, 'node_modules', 'm'));
        await repoAt(join(root, '.hidden', 'h'));
        await repoAt(join(outside, 'escaped'));
        await link(outside, join(root, 'escape'));
        const result = await located(ORIGIN);
        expect(result).toEqual({
            kind: 'locate',
            origin: ORIGIN,
            matches: [
                { path: join(root, 'a'), git: { kind: 'repo', branch: 'main', origin: 'https://GitHub.com/andtii/agentic.git' } },
                { path: join(root, 'deep', 'x', 'b'), git: { kind: 'repo', branch: 'main', origin: 'git@github.com:andtii/agentic' } }
            ],
            truncated: false
        });
        expect((await located('https://github.com/andtii/other')).matches.map((m) => m.path)).toEqual([join(root, 'other')]);
        expect((await located('https://github.com/nobody/nothing')).matches).toEqual([]);
    });

    it('honours depth, capped at 3; a checkout at the root itself is depth 0', async () => {
        await repoAt(root);
        await repoAt(join(root, 'a'));
        await repoAt(join(root, 'deep', 'x', 'b'));
        await repoAt(join(root, 'p', 'q', 'r', 's'));
        const paths = async (depth?: number) => (await located(ORIGIN, depth)).matches.map((m) => m.path);
        expect(await paths(0)).toEqual([root]);
        expect(await paths(1)).toEqual([root, join(root, 'a')]);
        expect(await paths(99)).toEqual([root, join(root, 'a'), join(root, 'deep', 'x', 'b')]);
        expect(await paths()).toEqual(await paths(3));
    });

    it('reports a folder once under its own name when a link beside it points there, and never walks a root twice', async () => {
        await repoAt(join(root, 'real'));
        await link(join(root, 'real'), join(root, 'aaa-alias'));
        await link(root, join(root, 'self'));
        expect((await located(ORIGIN)).matches.map((m) => m.path)).toEqual([join(root, 'real')]);
        // A link that is the only way to a checkout is followed and reported by its own name.
        await mkdir(join(root, 'nested', 'deep', 'far'), { recursive: true });
        await repoAt(join(root, 'nested', 'deep', 'far', 'z'));
        await link(join(root, 'nested', 'deep', 'far', 'z'), join(root, 'via'));
        expect((await located(ORIGIN)).matches.map((m) => m.path)).toEqual([join(root, 'real'), join(root, 'via')]);
    });

    it(`stops at ${FS_LOCATE_MAX_MATCHES} matches and says so`, async () => {
        await Promise.all(Array.from({ length: FS_LOCATE_MAX_MATCHES + 1 }, (_, i) => repoAt(join(root, `c${String(i).padStart(2, '0')}`))));
        const result = await located(ORIGIN);
        expect(result.matches).toHaveLength(FS_LOCATE_MAX_MATCHES);
        expect(result.truncated).toBe(true);
        await rm(join(root, 'c20'), { recursive: true });
        expect((await located(ORIGIN)).truncated).toBe(false);
    });

    it('walks the roots in order, skips a root missing on disk, and refuses an unknown environment', async () => {
        const second = join(base, 'second');
        await repoAt(join(second, 'z'));
        await repoAt(join(root, 'a'));
        environments = [{ ...environments[0]!, cwdRoots: [join(base, 'missing'), second, root] }];
        expect((await located(ORIGIN)).matches.map((m) => m.path)).toEqual([join(second, 'z'), join(root, 'a')]);
        expect(errorOf(await ask({ kind: 'locate', origin: ORIGIN }, 'env_nope'))).toBe('unknown-environment');
    });

    it('logs the origin rather than a path, and compares roots case-insensitively on Windows only', async () => {
        await repoAt(join(root, 'a'));
        const lines: unknown[] = [];
        const logger = { debug: (msg: string, data?: unknown) => lines.push([msg, data]), info() {}, warn() {}, error() {} };
        expect((await located(ORIGIN, undefined, { logger })).matches).toHaveLength(1);
        expect(lines).toEqual([['fs: request', { environment: 'env_a', op: 'locate', origin: ORIGIN }]]);
        // The platform rule itself, lexically — no filesystem in the way. `path.relative` folds case
        // on Windows whatever platform is injected, so the case-sensitive half only runs off it.
        expect(withinRoots(join(root, 'a'), [root.toUpperCase()], 'win32')).toBe(true);
        if (process.platform !== 'win32') expect(withinRoots(join(root, 'a'), [root.toUpperCase()], 'linux')).toBe(false);
        if (process.platform === 'win32') {
            environments = [{ ...environments[0]!, cwdRoots: [root.toUpperCase()] }];
            expect((await located(ORIGIN, undefined, { platform: 'win32' })).matches.map((m) => m.path)).toEqual([join(root.toUpperCase(), 'a')]);
        } else {
            // Off Windows the rule is case-sensitive, but `locate` resolves the root with `realpath`
            // first: a case-folding volume (macOS by default) finds the uppercased root anyway (#357).
            const folds = await foldsCase(base);
            environments = [{ ...environments[0]!, cwdRoots: [root.toUpperCase()] }];
            const matches = (await located(ORIGIN, undefined, { platform: 'linux' })).matches.map((m) => m.path);
            expect(matches).toEqual(folds ? [join(root.toUpperCase(), 'a')] : []);
        }
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

    it('names branch-exists, invalid-branch, worktree-mismatch, not-a-repo and a target outside the roots', async () => {
        const target = (n: string) => join(root, 'wts', n);
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'main', path: target('a') }))).toBe('branch-exists');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'bad..name', path: target('b') }))).toBe('invalid-branch');
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: '-x', path: target('b') }))).toBe('invalid-branch');
        await mkdir(target('taken'), { recursive: true });
        expect(errorOf(await ask({ kind: 'worktree', repo, branch: 'ok', path: target('taken') }))).toBe('worktree-mismatch');
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

    it('reuses a worktree already there, re-creates one removed by hand, and refuses another branch at the path (#618)', async () => {
        const path = join(root, 'wts', 'chat-1');
        const op = { kind: 'worktree', repo, branch: 'chat/1', path } as const;
        expect(await ask(op)).toEqual({ result: { kind: 'worktree', path, branch: 'chat/1' } });
        expect(await ask(op)).toEqual({ result: { kind: 'worktree', path, branch: 'chat/1', reused: true } });
        // Asked from the worktree itself, the same answer.
        expect(await ask({ ...op, repo: path })).toEqual({ result: { kind: 'worktree', path, branch: 'chat/1', reused: true } });

        // Removed with the branch kept (`git worktree remove`, `pnpm wt rm`, …): checked out again, work intact.
        await writeFile(join(path, 'work.txt'), 'w');
        git(path, 'add', 'work.txt');
        git(path, 'commit', '-q', '-m', 'work');
        git(repo, 'worktree', 'remove', path);
        expect(await ask(op)).toEqual({ result: { kind: 'worktree', path, branch: 'chat/1', recreated: true } });
        expect(await stat(join(path, 'work.txt'))).toBeTruthy();
        // Deleted from disk without git knowing: pruned, then re-created.
        await rm(path, { recursive: true, force: true });
        expect(await ask(op)).toEqual({ result: { kind: 'worktree', path, branch: 'chat/1', recreated: true } });

        // Another branch's worktree at the path, and the branch checked out in another folder.
        expect(errorOf(await ask({ ...op, branch: 'chat/2' }))).toBe('worktree-mismatch');
        expect(errorOf(await ask({ ...op, path: join(root, 'wts', 'elsewhere') }))).toBe('branch-exists');
    }, 60_000);
});

describe.skipIf(!hasGit)('fs worktrees (real git, #622)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { windowsHide: true, stdio: 'pipe' });

    it('lists every worktree of the repo, the one root is in marked current, one outside the roots marked outside', async () => {
        const repo = join(root, 'repo');
        await mkdir(repo);
        git(repo, 'init', '-q', '-b', 'main');
        await writeFile(join(repo, 'README'), 'x');
        git(repo, 'add', 'README');
        git(repo, 'commit', '-q', '-m', 'init');
        const wt = join(root, 'wts', 'feat');
        git(repo, 'worktree', 'add', '-q', '-b', 'feat', wt);
        const away = join(outside, 'away');
        git(repo, 'worktree', 'add', '-q', '--detach', away);
        git(repo, 'worktree', 'lock', wt);
        await mkdir(join(wt, 'src'));

        const outcome = await ask({ kind: 'worktrees', root: join(wt, 'src') });
        if (!('result' in outcome) || outcome.result.kind !== 'worktrees') throw new Error(JSON.stringify(outcome));
        const byPath = new Map(await Promise.all(outcome.result.entries.map(async (e) => [await realpath(e.path).catch(() => e.path), e] as const)));
        expect(outcome.result).toMatchObject({ root: join(wt, 'src'), truncated: false });
        expect(outcome.result.entries).toHaveLength(3);
        expect(byPath.get(await realpath(repo))).toMatchObject({ branch: 'main', head: expect.stringMatching(/^[0-9a-f]{7}$/) });
        expect(byPath.get(await realpath(repo))).not.toHaveProperty('current');
        expect(byPath.get(await realpath(wt))).toMatchObject({ branch: 'feat', locked: true, current: true });
        expect(byPath.get(await realpath(away))).toMatchObject({ detached: true, outside: true });
        expect(byPath.get(await realpath(away))).not.toHaveProperty('branch');
        // Inside the roots, each is named under the root as written — not git's resolved form (`/private/var` on macOS) —
        // so the platform's lexical check admits it when it is opened as a `root`.
        expect(outcome.result.entries.map((e) => e.path)).toEqual(expect.arrayContaining([repo, wt]));

        expect(errorOf(await ask({ kind: 'worktrees', root: outside }))).toBe('outside-roots');
        await mkdir(join(root, 'plain'));
        expect(errorOf(await ask({ kind: 'worktrees', root: join(root, 'plain') }))).toBe('not-a-repo');
    }, 60_000);
});

describe('parseWorktreeList (#618)', () => {
    it('reads porcelain -z records: a branch, a detached HEAD, a bare repo', () => {
        const out = ['worktree /r', 'HEAD abc', 'branch refs/heads/main', '', 'worktree /w', 'HEAD def', 'detached', 'locked reason', 'prunable gitdir file points to non-existent location', '', 'worktree /b', 'bare', '', ''].join('\0');
        expect(parseWorktreeList(out)).toEqual([{ path: '/r', head: 'abc', branch: 'main' }, { path: '/w', head: 'def', detached: true, locked: true, prunable: true }, { path: '/b' }]);
        expect(parseWorktreeList('')).toEqual([]);
    });
});

describe('fs run (#618)', () => {
    const node = process.execPath;
    const run = (argv: string[], cwd = root, timeoutMs?: number) => ask({ kind: 'run', cwd, argv, ...(timeoutMs ? { timeoutMs } : {}) });

    it('runs argv in the folder, never through a shell, and answers the exit code with both tails', async () => {
        await mkdir(join(root, 'app'));
        const outcome = await run([node, '-e', 'process.stdout.write(process.cwd()); process.stderr.write("e"); process.exit(3)', '$HOME;&|'], join(root, 'app'));
        expect(outcome).toMatchObject({ result: { kind: 'run', exitCode: 3, stderrTail: 'e' } });
        const cwd = 'result' in outcome && outcome.result.kind === 'run' ? outcome.result.stdoutTail : '';
        expect(cwd).toBe(await realpath(join(root, 'app')));
        // An argument that looks like shell syntax arrives as written.
        expect(await run([node, '-e', 'process.stdout.write(process.argv[1])', '$HOME;&|'])).toMatchObject({ result: { exitCode: 0, stdoutTail: '$HOME;&|' } });
    }, 30_000);

    it('keeps only the tail of a long output', async () => {
        const outcome = await run([node, '-e', `process.stdout.write('a'.repeat(${FS_RUN_OUTPUT_TAIL}) + 'z'.repeat(10))`]);
        const out = 'result' in outcome && outcome.result.kind === 'run' ? outcome.result.stdoutTail : '';
        expect(out).toHaveLength(FS_RUN_OUTPUT_TAIL);
        expect(out.endsWith('z'.repeat(10))).toBe(true);
    }, 30_000);

    it('refuses a folder outside the roots or missing, names a missing program, and stops at its time', async () => {
        expect(errorOf(await run([node, '-e', '0'], outside))).toBe('outside-roots');
        expect(errorOf(await run([node, '-e', '0'], join(root, 'nope')))).toBe('not-found');
        expect(errorOf(await run(['agentic-no-such-program-618']))).toBe('not-found');
        // A script file, not `-e`: nothing for cmd.exe to read on Windows. Its whole tree is stopped at the time.
        await writeFile(join(root, 'sleep.js'), 'setTimeout(function () {}, 60000);');
        expect(errorOf(await run([node, join(root, 'sleep.js')], root, 1_000))).toBe('timeout');
    }, 30_000);
});
