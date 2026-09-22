/** `env.request` answered under the machine-local policy (#238, decisions 2026-09-19 (c)). */
// @vitest-environment node
import type { EnvironmentId, EnvOp, LocalEnvironment, MachinePolicy } from '@agentic/core';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerEnvRequest, type EnvManageContext } from '../src/env-manage';
import { readEnvironmentsForEdit, writeEnvironments } from '../src/env-store';
import { POLICY_OFF } from '../src/policy';

describe('answerEnvRequest', () => {
    let dir: string;
    let work: string;
    let paths: EnvManageContext['paths'];
    const secure = { run: async () => ({ code: 0, stderr: '' }) };
    const active = new Map<string, number>();
    const byHand: LocalEnvironment = { id: 'env_hand' as EnvironmentId, name: 'By hand', runtime: 'scripted', cwdRoots: [], concurrency: 2, accountLabel: 'me@work' };

    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-envmanage-')));
        work = join(dir, 'work');
        await mkdir(join(work, 'a'), { recursive: true });
        await mkdir(join(work, 'b'), { recursive: true });
        await mkdir(join(dir, 'outside'), { recursive: true });
        paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), environmentsFile: join(dir, 'config', 'environments.json') };
        // Hand-written, on the runtime's default profile (no profileDir).
        await writeEnvironments(paths.environmentsFile, [{ ...byHand, cwdRoots: [join(work, 'a')] }], secure);
        active.clear();
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const ctx = (policy: MachinePolicy = { webManaged: true, allowedRoots: [work] }): EnvManageContext => ({ paths, policy, runtimes: new Set(['scripted']), activeOn: (id) => active.get(id) ?? 0, secure });
    const put = (environment: Record<string, unknown>, c = ctx()) => answerEnvRequest({ op: 'put', environment } as unknown as EnvOp, c);
    const onDisk = () => readFile(paths.environmentsFile, 'utf8');

    it('policy off: nothing is created, changed or removed', async () => {
        const before = await onDisk();
        expect(await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(work, 'b')] }, ctx(POLICY_OFF))).toMatchObject({ error: { code: 'policy-disabled' } });
        expect(await answerEnvRequest({ op: 'remove', environmentId: byHand.id }, ctx(POLICY_OFF))).toMatchObject({ error: { code: 'policy-disabled' } });
        // On, but with no folder allowed, is off.
        expect(await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(work, 'b')] }, ctx({ webManaged: true, allowedRoots: [] }))).toMatchObject({ error: { code: 'policy-disabled' } });
        expect(await onDisk()).toBe(before);
    });

    it('a new environment gets its own profile under the daemon’s folder, and the roots with links resolved', async () => {
        const outcome = await put({ name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b', '..', 'b')] });
        expect(outcome).toMatchObject({ result: { environmentId: 'env_web' } });
        const made = (await readEnvironmentsForEdit(paths.environmentsFile)).find((e) => e.id === 'env_web')!;
        expect(made).toMatchObject({ name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')], profileDir: join(paths.configDir, 'profiles', 'env_web') });
        expect((await stat(made.profileDir!)).isDirectory()).toBe(true);
        // What the daemon now runs with is what is on disk.
        expect('result' in outcome && outcome.environments).toEqual(await readEnvironmentsForEdit(paths.environmentsFile));
    });

    it('a profileDir in the request is never read — the machine chooses it', async () => {
        const outcome = await put({ id: 'env_sneaky', name: 'Sneaky', runtime: 'scripted', cwdRoots: [join(work, 'b')], profileDir: join(dir, 'outside') });
        expect(outcome).toMatchObject({ result: { environmentId: 'env_sneaky' } });
        const made = (await readEnvironmentsForEdit(paths.environmentsFile)).find((e) => e.id === 'env_sneaky')!;
        expect(made.profileDir).toBe(join(paths.configDir, 'profiles', 'env_sneaky'));
    });

    it('an id that is not an id is refused before anything is created', async () => {
        const before = await onDisk();
        expect(await put({ id: '../../outside', name: 'Escape', runtime: 'scripted', cwdRoots: [join(work, 'b')] })).toMatchObject({ error: { code: 'invalid' } });
        expect(await onDisk()).toBe(before);
    });

    it('unknown runtime, no roots, a root outside, a changed runtime: refused, nothing written', async () => {
        const before = await onDisk();
        expect(await put({ name: 'x', runtime: 'no-such-runtime', cwdRoots: [join(work, 'b')] })).toMatchObject({ error: { code: 'unknown-runtime' } });
        expect(await put({ name: 'x', runtime: 'scripted', cwdRoots: [] })).toMatchObject({ error: { code: 'invalid' } });
        // One root outside spoils the request, even beside one inside.
        expect(await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(work, 'b'), join(dir, 'outside')] })).toMatchObject({ error: { code: 'outside-allowed-roots' } });
        expect(await put({ name: 'x', runtime: 'scripted', cwdRoots: [paths.configDir] })).toMatchObject({ error: { code: 'outside-allowed-roots' } });
        expect(await put({ id: byHand.id, name: 'x', runtime: 'other', cwdRoots: [join(work, 'b')] }, { ...ctx(), runtimes: new Set(['scripted', 'other']) })).toMatchObject({ error: { code: 'invalid' } });
        expect(await onDisk()).toBe(before);
    });

    it('a put for an existing id changes its roots and keeps its profile, concurrency and account', async () => {
        expect(await put({ id: byHand.id, name: 'By hand, moved', runtime: 'scripted', cwdRoots: [join(work, 'b')] })).toMatchObject({ result: { environmentId: byHand.id } });
        const [changed] = await readEnvironmentsForEdit(paths.environmentsFile);
        // Still on the runtime's default profile: a new one would sign it out.
        expect(changed).toEqual({ id: byHand.id, name: 'By hand, moved', runtime: 'scripted', cwdRoots: [join(work, 'b')], concurrency: 2, accountLabel: 'me@work' });
        expect(await put({ id: byHand.id, name: 'By hand', runtime: 'scripted', cwdRoots: [join(work, 'b')], concurrency: 5 })).toMatchObject({ result: {} });
        expect((await readEnvironmentsForEdit(paths.environmentsFile))[0]).toMatchObject({ concurrency: 5, accountLabel: 'me@work' });
    });

    it('remove: unknown is unknown, in use is in use, otherwise gone — and its sign-in stays on disk', async () => {
        const made = await put({ name: 'Temp', runtime: 'scripted', cwdRoots: [join(work, 'b')] });
        const id = ('result' in made ? made.result.environmentId : '') as EnvironmentId;
        expect(await answerEnvRequest({ op: 'remove', environmentId: 'env_nope' as EnvironmentId }, ctx())).toMatchObject({ error: { code: 'unknown-environment' } });
        active.set(id, 1);
        expect(await answerEnvRequest({ op: 'remove', environmentId: id }, ctx())).toMatchObject({ error: { code: 'in-use' } });
        active.clear();
        expect(await answerEnvRequest({ op: 'remove', environmentId: id }, ctx())).toMatchObject({ result: { environmentId: id } });
        expect((await readEnvironmentsForEdit(paths.environmentsFile)).map((e) => e.id)).toEqual([byHand.id]);
        expect((await stat(join(paths.configDir, 'profiles', id))).isDirectory()).toBe(true);
    });

    it('an invalid environments.json is `io`, and the answer names no path', async () => {
        await writeFile(paths.environmentsFile, '{nope');
        const outcome = await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(work, 'b')] });
        expect(outcome).toMatchObject({ error: { code: 'io' } });
        expect(JSON.stringify(outcome)).not.toContain(dir.replaceAll('\\', '\\\\'));
        expect(JSON.stringify(outcome)).not.toContain('config');
    });

    it('allowBypassPermissions: true sets, false clears, absent keeps (#355)', async () => {
        const made = await put({ name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')] });
        expect(made).toMatchObject({ result: { environmentId: 'env_web' } });
        const row = async () => (await readEnvironmentsForEdit(paths.environmentsFile)).find((e) => e.id === 'env_web')!;
        expect((await row()).allowBypassPermissions).toBeUndefined();
        await put({ id: 'env_web', name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')], allowBypassPermissions: true });
        expect((await row()).allowBypassPermissions).toBe(true);
        await put({ id: 'env_web', name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')], concurrency: 2 });
        expect((await row()).allowBypassPermissions).toBe(true);
        await put({ id: 'env_web', name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')], allowBypassPermissions: false });
        expect((await row()).allowBypassPermissions).toBeUndefined();
        // Not a boolean: ignored, never coerced.
        await put({ id: 'env_web', name: 'Web', runtime: 'scripted', cwdRoots: [join(work, 'b')], allowBypassPermissions: 'yes' });
        expect((await row()).allowBypassPermissions).toBeUndefined();
    });

    it('env.request never writes policy.json — the web sets the policy only through policy.request and the port cli.ts injects (#355)', async () => {
        const policyFile = join(paths.configDir, 'policy.json');
        await writeFile(policyFile, JSON.stringify({ webManaged: true, allowedRoots: [work] }));
        const before = await readFile(policyFile, 'utf8');
        await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(work, 'b')] });
        await put({ name: 'x', runtime: 'scripted', cwdRoots: [join(dir, 'outside')] });
        await answerEnvRequest({ op: 'remove', environmentId: byHand.id }, ctx());
        expect(await readFile(policyFile, 'utf8')).toBe(before);
        // And by construction: the code that answers the platform's environment requests cannot reach a policy writer. Since #355
        // `policy.request` may set the policy — through `policy-web.ts`, which only `cli.ts` binds into the daemon as a port.
        for (const file of ['env-manage.ts', 'daemon.ts']) {
            const source = await readFile(join(__dirname, '..', 'src', file), 'utf8');
            expect(source).not.toMatch(/writePolicy|policyFile|allowRoot|denyRoot|from '\.\/policy-web/);
        }
    });
});
