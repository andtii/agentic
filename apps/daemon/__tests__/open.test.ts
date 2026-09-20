/** `agentic-daemon open` (#336): the folder → environment resolution, the deep link, the opener, and the exits. */
// @vitest-environment node
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli';
import { openLink, resolveOpen } from '../src/open';
import { daemonPaths } from '../src/paths';

const ORIGIN = 'git@github.com:andtii/agentic.git';
const URL_BASE = 'https://agentic.example';
const env = (id: string, name: string, ...cwdRoots: string[]): LocalEnvironment => ({ id: id as EnvironmentId, name, runtime: 'claude-code', cwdRoots, concurrency: 1 });

let dir: string;
let work: string;
let out: string[];
let opened: string[];
let roots: { work: string; oss: string; elsewhere: string };

/** A hand-written repo: `.git/HEAD` on `main` and a config naming `origin` (`null`: none). */
async function repoAt(path: string, origin: string | null = ORIGIN): Promise<string> {
    await mkdir(join(path, '.git'), { recursive: true });
    await writeFile(join(path, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(path, '.git', 'config'), `[core]\n\tbare = false\n${origin === null ? '' : `[remote "origin"]\n\turl = ${origin}\n`}`);
    return path;
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentic-open-home-'));
    work = await mkdtemp(join(tmpdir(), 'agentic-open-work-'));
    roots = { work: join(work, 'work'), oss: join(work, 'oss'), elsewhere: join(work, 'elsewhere') };
    for (const r of Object.values(roots)) await mkdir(r);
    out = [];
    opened = [];
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
});

const paths = () => daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });
const ctx = () => ({ paths: paths(), out: (t: string) => out.push(t), err: (t: string) => out.push(t), opener: async (url: string) => { opened.push(url); } });
const paired = () => writeFile(paths().credentialsFile, JSON.stringify({ url: `${URL_BASE}/`, workspaceId: 'ws_test', machineId: 'm_test', token: 'tok', name: 'box', pairedAt: 1 }));
const withEnvironments = (...environments: LocalEnvironment[]) => writeFile(paths().environmentsFile, JSON.stringify({ environments }));
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe('agentic-daemon open', () => {
    it('inside a root: prints the link with the environment, the native path and the origin, then opens it once', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work), env('env_oss', 'OSS', roots.oss));
        const repo = await repoAt(join(roots.work, 'agentic'));
        expect(await main(['open', repo], ctx())).toBe(0);
        expect(out).toHaveLength(1);
        const url = out[0]!;
        expect(url.startsWith(`${URL_BASE}/chats/new?env=env_work&path=${encodeURIComponent(repo)}&origin=`)).toBe(true);
        expect(query(url)).toEqual({ env: 'env_work', path: repo, origin: ORIGIN });
        expect(opened).toEqual([url]);
    });

    it('defaults to the current directory and reads a worktree’s origin through its commondir', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work));
        const repo = await repoAt(join(roots.work, 'agentic', 'main'));
        await mkdir(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
        await writeFile(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature\n');
        await writeFile(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
        const wt = join(roots.work, 'agentic', 'branches', 'wt');
        await mkdir(wt, { recursive: true });
        await writeFile(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
        expect(await main(['open'], { ...ctx(), cwd: wt })).toBe(0);
        expect(query(out[0]!)).toEqual({ env: 'env_work', path: wt, origin: ORIGIN });
        expect(opened).toHaveLength(1);
    });

    it('a folder that is not a repo links without an origin; --no-browser prints and never opens', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work));
        const plain = join(roots.work, 'notes');
        await mkdir(plain);
        expect(await main(['open', plain, '--no-browser'], ctx())).toBe(0);
        expect(query(out[0]!)).toEqual({ env: 'env_work', path: plain });
        expect(out[0]).not.toContain('origin=');
        expect(opened).toEqual([]);
        // The flag before the folder: the folder is still the folder.
        out = [];
        expect(await main(['open', '--no-browser', plain], ctx())).toBe(0);
        expect(query(out[0]!).path).toBe(plain);
        expect(opened).toEqual([]);
    });

    it('outside every root: exit 1, every environment’s roots listed, nothing opened', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work), env('env_oss', 'OSS', roots.oss));
        expect(await main(['open', roots.elsewhere], ctx())).toBe(1);
        const text = out.join('\n');
        expect(text).toContain(`${roots.elsewhere} is outside every environment's working roots`);
        expect(text).toContain(`env_work (Work): ${roots.work}`);
        expect(text).toContain(`env_oss (OSS): ${roots.oss}`);
        expect(opened).toEqual([]);
        // A folder that does not exist says so.
        expect(await main(['open', join(roots.work, 'nope')], ctx())).toBe(1);
        expect(out.at(-1)).toMatch(/does not exist/);
    });

    it('under two environments’ roots: exit 2 naming both until --env picks one; --env naming the wrong one exits 1', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work), env('env_all', 'Everything', work), env('env_oss', 'OSS', roots.oss));
        const repo = await repoAt(join(roots.work, 'agentic'));
        expect(await main(['open', repo], ctx())).toBe(2);
        expect(out.at(-1)).toContain('2 environments');
        expect(out.at(-1)).toContain('--env <id>');
        expect(out.at(-1)).toContain('env_work (Work)');
        expect(out.at(-1)).toContain('env_all (Everything)');
        expect(out.at(-1)).not.toContain('env_oss');
        expect(opened).toEqual([]);
        out = [];
        expect(await main(['open', repo, '--env', 'env_all'], ctx())).toBe(0);
        expect(query(out[0]!)).toEqual({ env: 'env_all', path: repo, origin: ORIGIN });
        expect(opened).toEqual([out[0]]);
        out = [];
        expect(await main(['open', repo, '--env', 'env_oss'], ctx())).toBe(1);
        expect(out.at(-1)).toContain(`is outside the working roots of env_oss`);
        expect(out.at(-1)).toContain(`env_oss (OSS): ${roots.oss}`);
        expect(await main(['open', repo, '--env', 'env_nope'], ctx())).toBe(1);
        expect(out.at(-1)).toMatch(/no environment "env_nope"/);
        expect(await main(['open', repo, '--env'], ctx())).toBe(2);
        expect(opened).toHaveLength(1);
    });

    it('not paired, no environments, or a broken environments file: exit 1 with the reason', async () => {
        expect(await main(['open', roots.work], ctx())).toBe(1);
        expect(out.at(-1)).toMatch(/not paired/);
        await paired();
        expect(await main(['open', roots.work], ctx())).toBe(1);
        expect(out.at(-1)).toMatch(/no environments/);
        await writeFile(paths().environmentsFile, '{ nope');
        expect(await main(['open', roots.work], ctx())).toBe(1);
        expect(out.at(-1)).toMatch(/environments.json is invalid/);
        expect(opened).toEqual([]);
    });

    it('a failing opener leaves the link and exits 0', async () => {
        await paired();
        await withEnvironments(env('env_work', 'Work', roots.work));
        expect(await main(['open', roots.work], { ...ctx(), opener: async () => { throw new Error('no browser here'); } })).toBe(0);
        expect(out[0]).toContain('/chats/new?env=env_work');
        expect(out[1]).toMatch(/could not open a browser \(no browser here\)/);
    });
});

describe('resolveOpen / openLink', () => {
    const environments = () => [env('env_work', 'Work', roots.work)];

    it('encodes the environment, the native path and the origin into the link on the normalized platform URL', () => {
        expect(openLink('https://agentic.example/', 'env_work', 'C:\\Dev\\agentic main', 'git@github.com:andtii/agentic.git')).toBe(
            'https://agentic.example/chats/new?env=env_work&path=C%3A%5CDev%5Cagentic%20main&origin=git%40github.com%3Aandtii%2Fagentic.git'
        );
        expect(openLink('http://localhost:8787/base/', 'env_work', '/home/me/src', undefined)).toBe('http://localhost:8787/base/chats/new?env=env_work&path=%2Fhome%2Fme%2Fsrc');
    });

    it('reads the origin through the injected git reader and reports the lexical path', async () => {
        const inside = join(roots.work, 'a', '..', 'b');
        await mkdir(join(roots.work, 'b'));
        const resolved = await resolveOpen({ path: inside, environments: environments(), url: URL_BASE, gitInfo: async () => ({ kind: 'repo', origin: ORIGIN }) });
        expect(resolved).toEqual({ ok: true, url: openLink(URL_BASE, 'env_work', join(roots.work, 'b'), ORIGIN), environmentId: 'env_work', path: join(roots.work, 'b'), origin: ORIGIN });
    });

    it.runIf(process.platform === 'win32')('on Windows the roots match regardless of case, and the link carries the path as typed', async () => {
        const repo = join(roots.work, 'Agentic');
        await mkdir(repo);
        const swapped = repo.toUpperCase();
        const win = await resolveOpen({ path: swapped, environments: environments(), url: URL_BASE, platform: 'win32', gitInfo: async () => undefined });
        expect(win).toMatchObject({ ok: true, environmentId: 'env_work', path: swapped });
    });

    it('a relative path resolves against the given cwd', async () => {
        await mkdir(join(roots.work, 'rel'));
        const resolved = await resolveOpen({ path: 'rel', cwd: roots.work, environments: environments(), url: URL_BASE, gitInfo: async () => undefined });
        expect(resolved).toMatchObject({ ok: true, path: join(roots.work, 'rel') });
    });
});
