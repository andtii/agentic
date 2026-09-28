/**
 * What `NodeHost.fetch` records for the shell's signed-out state (#1016): with a local owner store, "unclaimed" until
 * the claim, then the passphrase login — which lands back on `returnTo`. Without one, neither.
 *
 * Gated on `node:sqlite` (Node >= 22.13; CI's compat leg runs Node 20).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentSignInOptions, localLoginHref, setSignInOptions } from '../../web/src/auth/sign-in';
import { resetServerAppStamp } from '../../web/src/platform.app';
import { fsBucket } from '../src/fs-bucket';
import { memoryLocalOwnerStore, prepareClaim, type LocalOwnerStore } from '../src/local-owner';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const sqlite = nodeSqlite ? await import('@sigx/actors-sqlite') : null;
const { createNodeHost } = nodeSqlite ? await import('../src/host') : ({} as typeof import('../src/host'));

const SECRET = 's'.repeat(40);
const PASS = 'correct horse battery';
const ORIGIN = 'http://127.0.0.1:8787';

describe.skipIf(!nodeSqlite)('NodeHost sign-in options', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
        resetServerAppStamp();
        setSignInOptions({ github: false, devLogin: false });
    });

    const start = async (localOwner?: LocalOwnerStore) => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-node-signin-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const storage = sqlite!.sqliteStorage({ path: join(dir, 'agentic.db') });
        const node = await createNodeHost({
            storage,
            bucket: fsBucket(join(dir, 'files')),
            env: { SESSION_SECRET: SECRET, APP_ORIGIN: ORIGIN },
            ...(localOwner ? { localOwner, passphraseIterations: 1_000 } : {})
        });
        cleanup.push(async () => {
            await node.stop({ timeoutMs: 2_000 });
            storage.close();
        });
        return node;
    };
    const signedOutRequest = () => new Request(`${ORIGIN}/auth/me`);

    it('an unclaimed node says so, then offers the passphrase login that lands on returnTo', async () => {
        const store = memoryLocalOwnerStore();
        const token = (await prepareClaim(store, SECRET))!;
        const node = await start(store);

        await node.fetch(signedOutRequest());
        expect(currentSignInOptions()).toEqual({ github: false, devLogin: false, localPassphrase: false, localUnclaimed: true });

        const claimed = await node.fetch(new Request(`${ORIGIN}/auth/claim`, { method: 'POST', body: new URLSearchParams({ t: token, passphrase: PASS, confirm: PASS }) }));
        expect(claimed.status).toBe(303);

        await node.fetch(signedOutRequest());
        expect(currentSignInOptions()).toEqual({ github: false, devLogin: false, localPassphrase: true, localUnclaimed: false });

        // The link the shell renders opens the form with returnTo, and the form's post lands back there.
        const href = localLoginHref('/projects/p1');
        const form = await node.fetch(new Request(`${ORIGIN}${href}`));
        expect(form.status).toBe(200);
        expect(await form.text()).toContain('name="returnTo" value="/projects/p1"');
        const login = await node.fetch(new Request(`${ORIGIN}/auth/local-login`, { method: 'POST', body: new URLSearchParams({ passphrase: PASS, returnTo: '/projects/p1' }) }));
        expect(login.status).toBe(303);
        expect(login.headers.get('location')).toBe('/projects/p1');
    });

    it('without a local owner store, neither local door is reported', async () => {
        const node = await start();
        setSignInOptions({ github: false, devLogin: false, localPassphrase: true, localUnclaimed: true });
        await node.fetch(signedOutRequest());
        expect(currentSignInOptions()).toMatchObject({ localPassphrase: false, localUnclaimed: false });
    });
});
