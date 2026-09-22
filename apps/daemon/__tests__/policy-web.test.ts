/** The policy set from the web (#355; decisions 2026-09-22): `policy.request { op: 'set' | 'browse' }` answered by `policy-web.ts`. */
// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, localEdit, parsePolicy, POLICY_OFF, reportedPolicy, withLock, writePolicy } from '../src/policy';
import { applyWebPolicy, browseMachine, expandHome, type PolicyWebContext } from '../src/policy-web';

const win = process.platform === 'win32';

describe('policy.request', () => {
    let dir: string;
    let home: string;
    let paths: PolicyWebContext['paths'];
    const secure = { run: async () => ({ code: 0, stderr: '' }) };
    const ctx = (extra: Partial<PolicyWebContext> = {}): PolicyWebContext => ({ paths, profileDirs: [join(paths.configDir, 'profiles')], home, secure, ...extra });

    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'agentic-policy-web-')));
        home = join(dir, 'home');
        paths = { configDir: join(dir, 'config'), stateDir: join(dir, 'state'), policyFile: join(dir, 'config', 'policy.json') };
        await mkdir(join(home, 'src', 'app'), { recursive: true });
        await mkdir(join(home, '.hidden'), { recursive: true });
        await mkdir(join(home, 'node_modules'), { recursive: true });
        await mkdir(join(dir, 'work'), { recursive: true });
        await mkdir(join(paths.configDir, 'profiles', 'env_work'), { recursive: true });
        await mkdir(paths.stateDir, { recursive: true });
        await writeFile(join(home, 'file.txt'), 'x');
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe('set', () => {
        it('expands ~ on the machine, stores real folders, echoes what was asked, and says the web set it', async () => {
            const outcome = await applyWebPolicy({ allowedRoots: ['~', '~/src/../src', join(dir, 'work')] }, ctx());
            expect(outcome).toEqual({ policy: { webManaged: true, allowedRoots: [home, join(home, 'src'), join(dir, 'work')], source: 'web', requested: ['~', '~/src/../src', join(dir, 'work')] } });
            // What was written is what a reader gets back — and what the daemon runs with stringifies the same, so the watcher stays quiet.
            const loaded = await loadPolicy(paths.policyFile);
            expect(loaded).toEqual({ ok: true, policy: (outcome as { policy: unknown }).policy });
            expect(JSON.stringify(loaded.ok && loaded.policy)).toBe(JSON.stringify((outcome as { policy: unknown }).policy));
            expect(reportedPolicy(loaded.ok ? loaded.policy : POLICY_OFF)).toMatchObject({ source: 'web', requested: ['~', '~/src/../src', join(dir, 'work')] });
        });

        it('an empty list turns web management off — from the web, with nothing requested', async () => {
            await writePolicy(paths.policyFile, { webManaged: true, allowedRoots: [join(dir, 'work')], source: 'local' });
            expect(await applyWebPolicy({ allowedRoots: [] }, ctx())).toEqual({ policy: { webManaged: false, allowedRoots: [], source: 'web', requested: [] } });
        });

        it('refuses the whole request for one bad root and changes nothing', async () => {
            await writePolicy(paths.policyFile, { webManaged: true, allowedRoots: [join(dir, 'work')], source: 'local' });
            const before = await readFile(paths.policyFile, 'utf8');
            expect(await applyWebPolicy({ allowedRoots: ['~', join(dir, 'missing')] }, ctx())).toMatchObject({ error: { code: 'not-found' } });
            expect(await applyWebPolicy({ allowedRoots: ['~', join(home, 'file.txt')] }, ctx())).toMatchObject({ error: { code: 'not-a-directory' } });
            expect(await applyWebPolicy({ allowedRoots: ['src'] }, ctx())).toMatchObject({ error: { code: 'invalid' } });
            expect(await applyWebPolicy({ allowedRoots: [''] }, ctx())).toMatchObject({ error: { code: 'invalid' } });
            expect(await applyWebPolicy({ allowedRoots: ['\\\\server\\share'] }, ctx())).toMatchObject({ error: { code: 'remote-path' } });
            // The daemon's own folders: configuration (and so the profiles inside it) and state.
            expect(await applyWebPolicy({ allowedRoots: [paths.configDir] }, ctx())).toMatchObject({ error: { code: 'protected' } });
            expect(await applyWebPolicy({ allowedRoots: [join(paths.configDir, 'profiles', 'env_work')] }, ctx())).toMatchObject({ error: { code: 'protected' } });
            expect(await applyWebPolicy({ allowedRoots: [paths.stateDir] }, ctx())).toMatchObject({ error: { code: 'protected' } });
            expect(await readFile(paths.policyFile, 'utf8')).toBe(before);
        });

        it('a folder that CONTAINS the daemon’s folders is fine — a working root inside them is still refused by checkWorkingRoot', async () => {
            expect(await applyWebPolicy({ allowedRoots: [dir] }, ctx())).toMatchObject({ policy: { allowedRoots: [dir] } });
        });

        it('a locked policy refuses every set until the machine unlocks it', async () => {
            await writePolicy(paths.policyFile, withLock({ webManaged: true, allowedRoots: [join(dir, 'work')], source: 'local' }, true));
            const before = await readFile(paths.policyFile, 'utf8');
            expect(await applyWebPolicy({ allowedRoots: ['~'] }, ctx())).toMatchObject({ error: { code: 'policy-locked' } });
            expect(await applyWebPolicy({ allowedRoots: [] }, ctx())).toMatchObject({ error: { code: 'policy-locked' } });
            expect(await readFile(paths.policyFile, 'utf8')).toBe(before);
            const loaded = await loadPolicy(paths.policyFile);
            expect(reportedPolicy(loaded.ok ? loaded.policy : POLICY_OFF)).toEqual({ webManaged: true, allowedRoots: [join(dir, 'work')], source: 'local', locked: true });
            await writePolicy(paths.policyFile, withLock(loaded.ok ? loaded.policy : POLICY_OFF, false));
            expect(await applyWebPolicy({ allowedRoots: ['~'] }, ctx())).toMatchObject({ policy: { allowedRoots: [home], source: 'web' } });
        });

        it('a broken policy file is io, not silently replaced, and names no path', async () => {
            await writeFile(paths.policyFile, '{nope');
            const outcome = await applyWebPolicy({ allowedRoots: ['~'] }, ctx());
            expect(outcome).toMatchObject({ error: { code: 'io' } });
            expect(JSON.stringify(outcome)).not.toContain(dir.replaceAll('\\', '\\\\'));
            expect(await readFile(paths.policyFile, 'utf8')).toBe('{nope');
        });

        it('a command on the machine afterwards says so and drops what the web asked for; the lock rides along', async () => {
            const set = await applyWebPolicy({ allowedRoots: ['~'] }, ctx());
            const local = localEdit({ ...(set as { policy: { webManaged: boolean; allowedRoots: string[] } }).policy, locked: true });
            expect(local).toEqual({ webManaged: true, allowedRoots: [home], source: 'local', locked: true });
            expect(parsePolicy({ webManaged: true, allowedRoots: [home], source: 'web', requested: ['~'], locked: false })).toEqual({ ok: true, policy: { webManaged: true, allowedRoots: [home], source: 'web', requested: ['~'] } });
            expect(parsePolicy({ webManaged: true, allowedRoots: [home], source: 'cloud' }).ok).toBe(false);
            expect(parsePolicy({ webManaged: true, allowedRoots: [home], requested: [''] }).ok).toBe(false);
        });

        it('expandHome stays under the home folder', () => {
            expect(expandHome('~', '/h', 'linux')).toBe('/h');
            expect(expandHome('~/x/y', '/h', 'linux')).toBe(join('/h', 'x/y'));
            expect(expandHome('~//x', '/h', 'linux')).toBe(join('/h', 'x'));
            expect(expandHome('~/x/../y', '/h', 'linux')).toBe(join('/h', 'y'));
            expect(expandHome('~x', '/h', 'linux')).toBe('~x');
            expect(expandHome('/abs', '/h', 'linux')).toBe('/abs');
            // Out of home dressed as home: refused, whatever the spelling.
            expect(expandHome('~/../etc', '/h', 'linux')).toBeNull();
            expect(expandHome('~/x/../../etc', '/h', 'linux')).toBeNull();
            expect(expandHome('~/..', '/h', 'linux')).toBeNull();
            expect(expandHome('~\\x', 'C:\\Users\\me', 'win32')).toBe(join('C:\\Users\\me', 'x'));
            expect(expandHome('~\\..\\Windows', 'C:\\Users\\me', 'win32')).toBeNull();
        });

        it('a ~ form that leads out of home is refused; a network path is remote-path on every platform', async () => {
            expect(await applyWebPolicy({ allowedRoots: ['~/../work'] }, ctx())).toMatchObject({ error: { code: 'invalid' } });
            expect(await applyWebPolicy({ allowedRoots: ['//server/share'] }, ctx())).toMatchObject({ error: { code: 'remote-path' } });
        });
    });

    describe('browse', () => {
        it('without a path lists the machine’s roots: the home folder first', async () => {
            const outcome = await browseMachine(undefined, ctx({ drives: [] }));
            expect(outcome).toMatchObject({ listing: { path: '', truncated: false } });
            const { listing } = outcome as unknown as { listing: { entries: { name: string; path: string }[]; parent?: string } };
            expect(listing.parent).toBeUndefined();
            expect(listing.entries[0]).toEqual({ name: '~', path: home });
            if (!win) expect(listing.entries[1]).toEqual({ name: '/', path: '/' });
        });

        it('on Windows, the drives that answer', async () => {
            if (!win) return;
            const outcome = await browseMachine(undefined, ctx({ drives: ['C', 'Q'] }));
            const { listing } = outcome as unknown as { listing: { entries: { name: string; path: string }[] } };
            expect(listing.entries.map((e) => e.name)).toEqual(['~', 'C:']);
            expect(listing.entries[1]!.path).toBe('C:\\');
        });

        it('lists a folder’s subfolders, no hidden ones or node_modules, no files, with its parent', async () => {
            const outcome = await browseMachine(home, ctx());
            expect(outcome).toEqual({ listing: { path: home, parent: dir, entries: [{ name: 'src', path: join(home, 'src') }], truncated: false } });
            expect(await browseMachine(join(home, 'src'), ctx())).toEqual({ listing: { path: join(home, 'src'), parent: home, entries: [{ name: 'app', path: join(home, 'src', 'app') }], truncated: false } });
        });

        it('never lists the daemon’s own folders, and reads them as absent', async () => {
            const around = await browseMachine(dir, ctx());
            const names = (around as unknown as { listing: { entries: { name: string }[] } }).listing.entries.map((e) => e.name);
            expect(names).toEqual(['home', 'work']);
            expect(await browseMachine(paths.configDir, ctx())).toMatchObject({ error: { code: 'not-found' } });
            expect(await browseMachine(join(paths.configDir, 'profiles'), ctx())).toMatchObject({ error: { code: 'not-found' } });
            expect(await browseMachine(paths.stateDir, ctx())).toMatchObject({ error: { code: 'not-found' } });
            // A profile outside the configuration folder is protected all the same.
            await mkdir(join(dir, 'work', 'profile'), { recursive: true });
            const listing = await browseMachine(join(dir, 'work'), ctx({ profileDirs: [join(dir, 'work', 'profile')] }));
            expect(listing).toEqual({ listing: { path: join(dir, 'work'), parent: dir, entries: [], truncated: false } });
        });

        it('a link is listed only when it leads to a folder — and never into the daemon’s own', async () => {
            try {
                await symlink(join(home, 'src'), join(dir, 'work', 'to-src'), 'junction');
                await symlink(paths.configDir, join(dir, 'work', 'to-config'), 'junction');
            } catch {
                return; // no link support here
            }
            const outcome = await browseMachine(join(dir, 'work'), ctx());
            expect((outcome as unknown as { listing: { entries: { name: string }[] } }).listing.entries.map((e) => e.name)).toEqual(['to-src']);
        });

        it('refuses a relative, a network and a missing path, and a file', async () => {
            expect(await browseMachine('src', ctx())).toMatchObject({ error: { code: 'invalid' } });
            expect(await browseMachine('\\\\server\\share', ctx())).toMatchObject({ error: { code: 'invalid' } });
            expect(await browseMachine(join(dir, 'missing'), ctx())).toMatchObject({ error: { code: 'not-found' } });
            expect(await browseMachine(join(home, 'file.txt'), ctx())).toMatchObject({ error: { code: 'not-a-directory' } });
        });

        it('the root of a filesystem has no parent', async () => {
            const root = win ? 'C:\\' : '/';
            const outcome = await browseMachine(root, ctx());
            expect(outcome).toMatchObject({ listing: { path: root } });
            expect((outcome as unknown as { listing: { parent?: string } }).listing.parent).toBeUndefined();
        });
    });
});
