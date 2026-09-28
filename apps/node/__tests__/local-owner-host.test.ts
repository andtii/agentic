/**
 * The local owner through `NodeHost.fetch` (#989): a claim over plain http on a
 * LAN address sets `agentic-*` cookies that sign in, and the same host behind a
 * TLS proxy (`X-Forwarded-Proto: https`, what `tailscale serve` sends) keeps `__Host-*`.
 *
 * Gated on `node:sqlite` (Node >= 22.13; CI's compat leg runs Node 20).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetServerAppStamp } from '../../web/src/platform.app';
import { fsBucket } from '../src/fs-bucket';
import { memoryLocalOwnerStore, prepareClaim } from '../src/local-owner';

const nodeSqlite = await import('node:sqlite').then(
    (m) => m,
    () => null
);
const sqlite = nodeSqlite ? await import('@sigx/actors-sqlite') : null;
const { createNodeHost } = nodeSqlite ? await import('../src/host') : ({} as typeof import('../src/host'));

const SECRET = 's'.repeat(40);
const PASS = 'correct horse battery';

const pairs = (response: Response): string => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

describe.skipIf(!nodeSqlite)('NodeHost local owner', () => {
    const cleanup: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
        for (const fn of cleanup.splice(0).reverse()) await fn();
        resetServerAppStamp();
    });

    const start = async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-node-owner-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const storage = sqlite!.sqliteStorage({ path: join(dir, 'agentic.db') });
        const localOwner = memoryLocalOwnerStore();
        const token = (await prepareClaim(localOwner, SECRET))!;
        const node = await createNodeHost({ storage, bucket: fsBucket(join(dir, 'files')), env: { SESSION_SECRET: SECRET, APP_ORIGIN: 'http://localhost:8787' }, localOwner, passphraseIterations: 1_000 });
        cleanup.push(async () => {
            await node.stop({ timeoutMs: 2_000 });
            storage.close();
        });
        return { node, token };
    };
    const claim = (origin: string, token: string, headers: Record<string, string> = {}): Request =>
        new Request(`${origin}/auth/claim`, { method: 'POST', body: new URLSearchParams({ t: token, passphrase: PASS, confirm: PASS }), headers });

    it('claims over http://<lan-ip> with agentic-* cookies that sign in', async () => {
        const { node, token } = await start();
        const claimed = await node.fetch(claim('http://192.168.1.5:8787', token));
        expect(claimed.status).toBe(303);
        const cookies = claimed.headers.getSetCookie();
        expect(cookies.map((c) => c.split('=')[0])).toEqual(['agentic-session', 'agentic-elevated']);
        for (const c of cookies) {
            expect(c).not.toMatch(/;\s*Secure/i);
            expect(c).toContain('SameSite=Lax');
        }
        const me = await node.fetch(new Request('http://192.168.1.5:8787/auth/me', { headers: { cookie: pairs(claimed) } }));
        expect(me.status).toBe(200);
        expect(((await me.json()) as { principal: unknown }).principal).toMatchObject({ kind: 'user', userId: 'local_owner', workspaceId: 'local_owner' });

        // Logout clears the plain cookie, not the __Host- one the browser never had.
        const out = await node.fetch(new Request('http://192.168.1.5:8787/auth/logout', { method: 'POST', headers: { cookie: pairs(claimed) } }));
        expect(out.headers.getSetCookie().some((c) => c.startsWith('agentic-session=;'))).toBe(true);
    });

    it('keeps __Host-* behind an https proxy', async () => {
        const { node, token } = await start();
        const claimed = await node.fetch(claim('http://127.0.0.1:8787', token, { 'x-forwarded-proto': 'https' }));
        expect(claimed.status).toBe(303);
        const cookies = claimed.headers.getSetCookie();
        expect(cookies.map((c) => c.split('=')[0])).toEqual(['__Host-session', '__Host-elevated']);
        for (const c of cookies) expect(c).toContain('; Secure');
        const me = await node.fetch(new Request('http://127.0.0.1:8787/auth/me', { headers: { cookie: pairs(claimed), 'x-forwarded-proto': 'https' } }));
        expect(me.status).toBe(200);
        // The secure cookie presented over plain http is not read.
        expect((await node.fetch(new Request('http://127.0.0.1:8787/auth/me', { headers: { cookie: pairs(claimed) } }))).status).toBe(401);
    });
});
