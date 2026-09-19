// @vitest-environment node
import type { EnvironmentId, LocalEnvironment } from '@agentic/core';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEnvironment, deleteEnvironment, EnvironmentStoreError, newEnvironmentId, profileDirFor, putEnvironment, removeEnvironment, watchEnvironments } from '../src/env-store';
import { loadEnvironments, type EnvironmentsResult } from '../src/environments';
import { daemonPaths } from '../src/paths';

const code = (fn: () => unknown): string => {
    try {
        fn();
    } catch (e) {
        if (e instanceof EnvironmentStoreError) return e.code;
        throw e;
    }
    return 'no error';
};

describe('env-store', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'agentic-envstore-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const paths = () => daemonPaths({ env: { AGENTIC_DAEMON_HOME: dir } });
    const secure = { run: async () => ({ code: 0, stderr: '' }) };
    const input = (extra: object = {}) => ({ name: 'Work', runtime: 'claude-code', cwdRoots: [dir], ...extra });

    it('ids are slugs of the name, made unique', () => {
        expect(newEnvironmentId('My Work!', new Set())).toBe('env_my_work');
        expect(newEnvironmentId('My Work!', new Set(['env_my_work', 'env_my_work_2']))).toBe('env_my_work_3');
        expect(newEnvironmentId('…', new Set())).toBe('env_environment');
    });

    it('add allocates the profile dir under the config dir and defaults concurrency', () => {
        const { environments, environment } = addEnvironment([], input(), paths());
        expect(environment).toEqual({ id: 'env_work', name: 'Work', runtime: 'claude-code', profileDir: profileDirFor(paths(), 'env_work'), cwdRoots: [dir], concurrency: 1 });
        expect(environments).toEqual([environment]);
    });

    it('add refuses an existing id, a shared profile dir, a relative root and an invalid row', () => {
        const { environments } = addEnvironment([], input({ id: 'env_a' }), paths());
        expect(code(() => addEnvironment(environments, input({ id: 'env_a' }), paths()))).toBe('exists');
        expect(code(() => addEnvironment(environments, input({ id: 'env_b', profileDir: profileDirFor(paths(), 'env_a') }), paths()))).toBe('shared-profile-dir');
        expect(code(() => addEnvironment([], input({ cwdRoots: ['relative/dir'] }), paths()))).toBe('invalid');
        expect(code(() => addEnvironment([], input({ cwdRoots: [] }), paths()))).toBe('invalid');
        expect(code(() => addEnvironment([], input({ concurrency: 0 }), paths()))).toBe('invalid');
        expect(code(() => addEnvironment([], input({ id: 'not ok' }), paths()))).toBe('invalid');
    });

    it('a profile dir differing only in case is shared on Windows, distinct elsewhere', () => {
        const existing: LocalEnvironment[] = [{ id: 'env_a' as EnvironmentId, name: 'A', runtime: 'claude-code', profileDir: join(dir, 'Profile'), cwdRoots: [dir], concurrency: 1 }];
        const next = input({ id: 'env_b', profileDir: join(dir, 'profile') });
        expect(code(() => addEnvironment(existing, next, paths(), { platform: 'win32' }))).toBe('shared-profile-dir');
        expect(code(() => addEnvironment(existing, next, paths(), { platform: 'linux' }))).toBe('no error');
    });

    it('replace updates roots and concurrency and keeps the profile dir', () => {
        const first = addEnvironment([], input({ id: 'env_a', profileDir: join(dir, 'custom') }), paths());
        const other = join(dir, 'other');
        const { environments, environment } = addEnvironment(first.environments, input({ id: 'env_a', cwdRoots: [other], concurrency: 3 }), paths(), { replace: true });
        expect(environment).toMatchObject({ id: 'env_a', profileDir: join(dir, 'custom'), cwdRoots: [other], concurrency: 3 });
        expect(environments).toHaveLength(1);
    });

    it('remove names the row it dropped; an unknown id is not-found', () => {
        const { environments } = addEnvironment([], input({ id: 'env_a' }), paths());
        expect(removeEnvironment(environments, 'env_a')).toMatchObject({ environments: [], removed: { id: 'env_a' } });
        expect(code(() => removeEnvironment(environments, 'env_x'))).toBe('not-found');
    });

    it('put writes a file that loads, creates the profile dir and leaves no temp file; delete keeps the profile', async () => {
        const environment = await putEnvironment(paths(), input(), secure);
        expect((await stat(environment.profileDir!)).isDirectory()).toBe(true);
        expect(await loadEnvironments(paths().environmentsFile)).toEqual({ ok: true, environments: [environment] });
        expect(JSON.parse(await readFile(paths().environmentsFile, 'utf8'))).toEqual({ environments: [environment] });
        expect((await readdir(dir)).sort()).toEqual(['environments.json', 'profiles']);
        await putEnvironment(paths(), input({ name: 'Home' }), secure);
        expect(await loadEnvironments(paths().environmentsFile)).toMatchObject({ ok: true, environments: [{ id: 'env_work' }, { id: 'env_home' }] });
        expect((await deleteEnvironment(paths(), 'env_work', secure)).id).toBe('env_work');
        expect((await stat(environment.profileDir!)).isDirectory()).toBe(true);
    });

    it('an invalid file is never overwritten', async () => {
        await writeFile(paths().environmentsFile, '{nope');
        await expect(putEnvironment(paths(), input(), secure)).rejects.toMatchObject({ code: 'invalid' });
        expect(await readFile(paths().environmentsFile, 'utf8')).toBe('{nope');
    });

    it('watch: a burst of events for the file is one re-read; other files are ignored', async () => {
        let listener!: (event: string, filename: string | null) => void;
        let closed = false;
        const seen: EnvironmentsResult[] = [];
        const watcher = await watchEnvironments({
            file: paths().environmentsFile,
            debounceMs: 10,
            onChange: (r) => void seen.push(r),
            watch: (_dir, l) => ((listener = l), { close: () => void (closed = true), on: () => undefined as never })
        });
        listener('rename', 'credentials.json');
        listener('rename', `environments.json.${process.pid}.tmp`);
        await new Promise((r) => setTimeout(r, 40));
        expect(seen).toEqual([]);
        await putEnvironment(paths(), input(), secure);
        listener('rename', 'environments.json');
        listener('change', 'environments.json');
        listener('change', null);
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        expect(seen[0]).toMatchObject({ ok: true, environments: [{ id: 'env_work' }] });
        watcher.close();
        expect(closed).toBe(true);
        listener('change', 'environments.json');
        await new Promise((r) => setTimeout(r, 40));
        expect(seen).toHaveLength(1);
    });
});
