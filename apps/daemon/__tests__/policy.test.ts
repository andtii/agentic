/** `policy.json` and the path rules a web-supplied working root must pass (#238, decisions 2026-09-19 (c)). */
// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowRoot, checkWorkingRoot, denyRoot, isRemoteOrDevicePath, loadPolicy, parsePolicy, POLICY_OFF, reportedPolicy, writePolicy, type ProtectedDirs } from '../src/policy';

const win = process.platform === 'win32';

describe('policy.json', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-policy-')));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('a missing file is off; so is anything that does not parse (fails closed)', async () => {
        expect(await loadPolicy(join(dir, 'policy.json'))).toEqual({ ok: true, policy: POLICY_OFF, missing: true });
        await writeFile(join(dir, 'policy.json'), '{nope');
        expect(await loadPolicy(join(dir, 'policy.json'))).toMatchObject({ ok: false });
        expect(parsePolicy({ webManaged: 'yes', allowedRoots: [] }).ok).toBe(false);
        expect(parsePolicy({ webManaged: true, allowedRoots: ['relative/dir'] }).ok).toBe(false);
        expect(parsePolicy({ webManaged: true, allowedRoots: ['\\\\server\\share'] }).ok).toBe(false);
        expect(parsePolicy({ webManaged: true, allowedRoots: [dir] })).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [dir] } });
    });

    it('is written atomically and owner-only, and read back as written', async () => {
        const calls: string[][] = [];
        const file = join(dir, 'cfg', 'policy.json');
        await writePolicy(file, { webManaged: true, allowedRoots: [dir] }, { platform: 'win32', env: { USERNAME: 'me' }, run: async (command, args) => (calls.push([command, ...args]), { code: 0, stderr: '' }) });
        expect(calls[0]![0]).toBe('icacls');
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ webManaged: true, allowedRoots: [dir] });
        expect(await loadPolicy(file)).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [dir] } });
    });

    it('reports the roots only while the web may use them', () => {
        expect(reportedPolicy({ webManaged: false, allowedRoots: [dir] })).toEqual(POLICY_OFF);
        // On with nothing allowed is refused like off, so it is reported off.
        expect(reportedPolicy({ webManaged: true, allowedRoots: [] })).toEqual(POLICY_OFF);
        expect(reportedPolicy({ webManaged: true, allowedRoots: [dir] })).toEqual({ webManaged: true, allowedRoots: [dir] });
    });

    describe('allow-root / deny-root (edited on the machine only)', () => {
        const own = () => ({ configDir: join(dir, 'config'), stateDir: join(dir, 'state') });

        it('stores the realpath of an existing folder and turns web management on', async () => {
            await mkdir(join(dir, 'work'));
            const policy = await allowRoot(POLICY_OFF, join(dir, 'work', '..', 'work'), own());
            expect(policy).toEqual({ webManaged: true, allowedRoots: [join(dir, 'work')] });
            // Allowed twice is allowed once.
            expect(await allowRoot(policy, join(dir, 'work'), own())).toEqual(policy);
        });

        it('refuses a missing folder, a file, a relative path, a network path and the daemon’s own folders', async () => {
            await writeFile(join(dir, 'file.txt'), 'x');
            await mkdir(join(dir, 'config', 'profiles'), { recursive: true });
            await mkdir(join(dir, 'state'), { recursive: true });
            await expect(allowRoot(POLICY_OFF, join(dir, 'missing'), own())).rejects.toMatchObject({ code: 'not-found' });
            await expect(allowRoot(POLICY_OFF, join(dir, 'file.txt'), own())).rejects.toMatchObject({ code: 'not-a-directory' });
            await expect(allowRoot(POLICY_OFF, 'relative', own())).rejects.toMatchObject({ code: 'invalid' });
            await expect(allowRoot(POLICY_OFF, '\\\\server\\share', own())).rejects.toMatchObject({ code: win ? 'remote-path' : 'invalid' });
            await expect(allowRoot(POLICY_OFF, join(dir, 'config'), own())).rejects.toMatchObject({ code: 'protected' });
            await expect(allowRoot(POLICY_OFF, join(dir, 'config', 'profiles'), own())).rejects.toMatchObject({ code: 'protected' });
            await expect(allowRoot(POLICY_OFF, join(dir, 'state'), own())).rejects.toMatchObject({ code: 'protected' });
        });

        it('deny-root removes one; with none left the web manages nothing', async () => {
            await mkdir(join(dir, 'a'));
            await mkdir(join(dir, 'b'));
            const both = await allowRoot(await allowRoot(POLICY_OFF, join(dir, 'a'), own()), join(dir, 'b'), own());
            expect(await denyRoot(both, join(dir, 'a'))).toEqual({ webManaged: true, allowedRoots: [join(dir, 'b')] });
            expect(await denyRoot(await denyRoot(both, join(dir, 'a')), join(dir, 'b'))).toEqual(POLICY_OFF);
            await expect(denyRoot(both, join(dir, 'c'))).rejects.toMatchObject({ code: 'not-found' });
        });
    });
});

describe('checkWorkingRoot — what a web-supplied working root must pass', () => {
    let dir: string;
    let allowed: string;
    let own: ProtectedDirs;
    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-roots-')));
        allowed = join(dir, 'allowed');
        await mkdir(join(allowed, 'repo', 'sub'), { recursive: true });
        await mkdir(join(dir, 'outside'), { recursive: true });
        await mkdir(join(dir, 'allowed-evil'), { recursive: true });
        // The daemon's own folders inside the allowed root: the worst case, and the one a careless `--allow-root <home>` makes.
        own = { configDir: join(allowed, 'config'), stateDir: join(allowed, 'state'), profileDirs: [join(allowed, 'config', 'profiles'), join(allowed, 'profile-by-hand')] };
        for (const d of [own.configDir, own.stateDir, ...own.profileDirs]) await mkdir(d, { recursive: true });
        await writeFile(join(allowed, 'file.txt'), 'x');
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    const check = (root: unknown) => checkWorkingRoot(root, [allowed], own);

    it('accepts a folder inside an allowed root; not the allowed root itself while it holds the daemon’s folders', async () => {
        expect(await check(join(allowed, 'repo', 'sub'))).toEqual({ ok: true, real: join(allowed, 'repo', 'sub') });
        expect(await check(allowed)).toMatchObject({ ok: false, code: 'outside-allowed-roots' }); // it contains the daemon's folders
    });

    it('relative, empty or not a string: invalid', async () => {
        expect(await check('repo')).toMatchObject({ ok: false, code: 'invalid' });
        expect(await check('')).toMatchObject({ ok: false, code: 'invalid' });
        expect(await check(42)).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('`..` is judged by where it leads', async () => {
        expect(await check(join(allowed, 'repo', '..', '..', 'outside'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        expect(await check(join(allowed, 'repo', 'sub', '..'))).toEqual({ ok: true, real: join(allowed, 'repo') });
    });

    it('another spelling of a folder inside (a link to it, an 8.3 short name, macOS /var) is judged by where it leads, and stored resolved', async () => {
        // A link outside the allowed root that leads into it: using it reaches nothing the owner did not allow.
        await symlink(join(allowed, 'repo'), join(dir, 'alias'), win ? 'junction' : 'dir');
        expect(await check(join(dir, 'alias', 'sub'))).toEqual({ ok: true, real: join(allowed, 'repo', 'sub') });
    });

    it('outside is outside whether it exists or not: the web learns nothing about folders it may not use', async () => {
        const missing = await check(join(dir, 'outside', 'nope'));
        const existing = await check(join(dir, 'outside'));
        expect(missing).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        expect(existing).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        expect(!missing.ok && missing.message.replace(join(dir, 'outside', 'nope'), '<path>')).toBe(!existing.ok && existing.message.replace(join(dir, 'outside'), '<path>'));
    });

    it('a sibling that only shares a prefix is outside', async () => {
        expect(await check(join(dir, 'allowed-evil'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
    });

    it('missing, or a file: invalid (never created on the platform’s say-so)', async () => {
        expect(await check(join(allowed, 'nope'))).toMatchObject({ ok: false, code: 'invalid' });
        expect(await check(join(allowed, 'file.txt'))).toMatchObject({ ok: false, code: 'invalid' });
    });

    it('UNC shares and device paths: outside, on every platform', async () => {
        for (const p of ['\\\\server\\share\\repo', '\\\\?\\UNC\\server\\share', '\\\\?\\C:\\repo', '\\\\.\\PhysicalDrive0', '//server/share/repo']) {
            expect(isRemoteOrDevicePath(p)).toBe(true);
            expect(await checkWorkingRoot(p, [allowed, '\\\\server\\share'], own, 'win32')).toMatchObject({ ok: false });
        }
        // Even when the owner's policy file names the share itself.
        expect(await checkWorkingRoot('//server/share/repo', ['//server/share'], own)).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
    });

    it('the daemon’s configuration, state and every profile: never, inside or around', async () => {
        for (const root of [own.configDir, join(own.configDir, 'profiles'), join(own.configDir, 'profiles', 'env_x'), own.stateDir, own.profileDirs[1]!]) {
            await mkdir(root, { recursive: true });
            expect(await check(root)).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        }
        // A folder that contains one of them is refused too: the session could read the sign-in.
        await mkdir(join(allowed, 'wrap'), { recursive: true });
        const wrapped = { ...own, profileDirs: [join(allowed, 'wrap', 'profile')] };
        await mkdir(wrapped.profileDirs[0]!, { recursive: true });
        expect(await checkWorkingRoot(join(allowed, 'wrap'), [allowed], wrapped)).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
    });

    it.skipIf(win)('a symlink inside the allowed root that leads out is outside', async () => {
        await symlink(join(dir, 'outside'), join(allowed, 'link'));
        expect(await check(join(allowed, 'link'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        // …and one that leads at the daemon's configuration.
        await symlink(own.configDir, join(allowed, 'to-config'));
        expect(await check(join(allowed, 'to-config'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
    });

    it.runIf(win)('a junction inside the allowed root that leads out is outside', async () => {
        await symlink(join(dir, 'outside'), join(allowed, 'junction'), 'junction');
        expect(await check(join(allowed, 'junction'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
        await symlink(own.configDir, join(allowed, 'to-config'), 'junction');
        expect(await check(join(allowed, 'to-config'))).toMatchObject({ ok: false, code: 'outside-allowed-roots' });
    });

    it.runIf(win)('Windows: case does not matter, and the real spelling is what is stored', async () => {
        const upper = join(allowed, 'repo').toUpperCase();
        expect(await check(upper)).toEqual({ ok: true, real: join(allowed, 'repo') });
    });
});
