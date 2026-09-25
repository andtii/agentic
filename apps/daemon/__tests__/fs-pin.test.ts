/** `fs.request` `pin` / `read-at` (#752, PRJ-11) against a real temp git repo: lines pinned to HEAD, read back after edits. */
// @vitest-environment node
import { FS_PIN_MAX_LINES, type EnvironmentId, type FsOp, type FsPinnedLines, type LocalEnvironment } from '@agentic/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerFsRequest, type FsOutcome } from '../src/fs';

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

let base: string;
let repo: string;
let outside: string;
let environments: LocalEnvironment[];

const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
async function commit(files: Record<string, string>, message: string): Promise<string> {
    for (const [path, text] of Object.entries(files)) {
        const parts = path.split('/');
        await mkdir(join(repo, ...parts.slice(0, -1)), { recursive: true });
        await writeFile(join(repo, ...parts), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'agentic-daemon-pin-')));
    repo = join(base, 'root', 'repo');
    outside = join(base, 'outside');
    await mkdir(repo, { recursive: true });
    await mkdir(outside);
    environments = [{ id: 'env_a' as EnvironmentId, name: 'A', runtime: 'scripted', cwdRoots: [join(base, 'root')], concurrency: 1 }];
    if (!hasGit) return;
    git('init', '-q');
    git('config', 'user.email', 'pin@example.test');
    git('config', 'user.name', 'pin');
    git('config', 'core.autocrlf', 'false');
    git('config', 'commit.gpgsign', 'false');
}, 30_000);
afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const ask = (op: FsOp): Promise<FsOutcome> => answerFsRequest(environments, 'env_a', op);
function pinned(outcome: FsOutcome): FsPinnedLines {
    if (!('result' in outcome) || (outcome.result.kind !== 'pin' && outcome.result.kind !== 'read-at')) throw new Error(`expected pinned lines, got ${JSON.stringify(outcome)}`);
    return outcome.result;
}
const errorOf = (outcome: FsOutcome) => ('error' in outcome ? outcome.error.code : undefined);
const numbered = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;

describe.skipIf(!hasGit)('fs pin / read-at (#752)', { timeout: 60_000 }, () => {
    it('pins lines to the HEAD sha and reads the same lines back after the file changed', async () => {
        const first = await commit({ 'src/app.ts': numbered(50) }, 'init');
        const pin = pinned(await ask({ kind: 'pin', root: repo, path: 'src/app.ts', from: 38, to: 41 }));
        expect(pin).toEqual({ kind: 'pin', path: 'src/app.ts', sha: first, from: 38, to: 41, lines: ['line 38', 'line 39', 'line 40', 'line 41'] });

        // Lines inserted above, committed, and more uncommitted edits on disk: the pin still shows what it pinned.
        const second = await commit({ 'src/app.ts': 'inserted\n'.repeat(5) + numbered(50) }, 'shift');
        await writeFile(join(repo, 'src', 'app.ts'), 'wiped\n');
        const back = pinned(await ask({ kind: 'read-at', root: repo, path: 'src/app.ts', sha: first, from: 38, to: 41 }));
        expect(back).toEqual({ ...pin, kind: 'read-at' });
        // A short sha resolves to the full one.
        expect(pinned(await ask({ kind: 'read-at', root: repo, path: 'src/app.ts', sha: first.slice(0, 7), from: 38, to: 38 })).sha).toBe(first);
        // A new pin follows HEAD, never the working copy.
        expect(pinned(await ask({ kind: 'pin', root: repo, path: 'src/app.ts', from: 1, to: 1 }))).toMatchObject({ sha: second, lines: ['inserted'] });
    });

    it('cuts a range past the end at the last line, drops CR line endings, and answers from a subfolder root', async () => {
        await commit({ 'pkg/lib/crlf.txt': 'one\r\ntwo\r\nthree' }, 'crlf');
        const pin = pinned(await ask({ kind: 'pin', root: join(repo, 'pkg'), path: 'lib\\crlf.txt', from: 2, to: 99 }));
        expect(pin).toMatchObject({ path: 'lib/crlf.txt', from: 2, to: 3, lines: ['two', 'three'] });
    });

    it('refuses what it cannot pin', async () => {
        const sha = await commit({ 'a.txt': numbered(3), 'bin.dat': 'a\u0000b', 'sub/b.txt': 'b\n' }, 'init');
        const pin = (op: Partial<Extract<FsOp, { kind: 'pin' }>>) => ask({ kind: 'pin', root: repo, path: 'a.txt', from: 1, to: 1, ...op });
        expect(errorOf(await pin({ from: 4, to: 5 }))).toBe('not-found');
        expect(errorOf(await pin({ from: 3, to: 2 }))).toBe('not-found');
        expect(errorOf(await pin({ from: 0, to: 1 }))).toBe('not-found');
        expect(errorOf(await pin({ from: 1, to: FS_PIN_MAX_LINES + 1 }))).toBe('too-large');
        expect(errorOf(await pin({ path: 'missing.txt' }))).toBe('not-found');
        expect(errorOf(await pin({ path: 'sub' }))).toBe('not-found');
        expect(errorOf(await pin({ path: 'bin.dat' }))).toBe('unsupported');
        expect(errorOf(await pin({ path: '../../outside/x.txt' }))).toBe('outside-roots');
        expect(errorOf(await pin({ path: join(outside, 'x.txt') }))).toBe('outside-roots');
        expect(errorOf(await pin({ root: outside }))).toBe('outside-roots');
        const readAt = (sha: string) => ask({ kind: 'read-at', root: repo, path: 'a.txt', sha, from: 3, to: 3 });
        expect(errorOf(await readAt('--output=x'))).toBe('not-found');
        expect(errorOf(await readAt('HEAD~1'))).toBe('not-found');
        expect(errorOf(await readAt('deadbeefdeadbeef'))).toBe('not-found');
        expect(pinned(await readAt(sha)).lines).toEqual(['line 3']);
    });

    it('says not-a-repo outside a repository and not-found before the first commit', async () => {
        const plain = join(base, 'root', 'plain');
        await mkdir(plain);
        await writeFile(join(plain, 'a.txt'), 'a\n');
        expect(errorOf(await ask({ kind: 'pin', root: plain, path: 'a.txt', from: 1, to: 1 }))).toBe('not-a-repo');
        expect(errorOf(await ask({ kind: 'pin', root: repo, path: 'a.txt', from: 1, to: 1 }))).toBe('not-found');
        expect(errorOf(await answerFsRequest(environments, 'env_missing', { kind: 'pin', root: repo, path: 'a.txt', from: 1, to: 1 }))).toBe('unknown-environment');
    });
});
