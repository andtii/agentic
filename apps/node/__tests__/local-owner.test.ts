/** The local owner on the Node host (#989): the claim file, the claim link, the passphrase login. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCAL_OWNER_ID, openElevation, openSession, readCookie, sealSession, sessionCookie, type LocalOwnerRecord } from '@agentic/platform';
import type { WorkspaceId } from '@agentic/core';
import { claimUrl, createLocalOwnerRoutes, fileLocalOwnerStore, memoryLocalOwnerStore, prepareClaim, type LocalOwnerStore } from '../src/local-owner';

const SECRET = 's'.repeat(40);
const PASS = 'correct horse battery';
const ORIGIN = 'http://192.168.1.5:8787';

const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Request =>
    new Request(`${ORIGIN}${path}`, { method: 'POST', body: new URLSearchParams(fields), headers });

async function serve(routes: ReturnType<typeof createLocalOwnerRoutes>, request: Request): Promise<Response | undefined> {
    const route = await routes(request);
    return route ? route(request) : undefined;
}

const cookieValue = (response: Response, name: string): string | null => readCookie(response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), name);

describe('prepareClaim', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    it('writes one token to the data dir, reuses it on a restart, and stops once claimed', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'agentic-owner-'));
        dirs.push(dir);
        const store = fileLocalOwnerStore(dir);
        const token = await prepareClaim(store, SECRET, 1_000);
        expect(token).toBeTruthy();
        expect(readFileSync(join(dir, 'claim-token'), 'utf8').trim()).toBe(token);
        expect((JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as LocalOwnerRecord).claim?.exp).toBeGreaterThan(1_000);
        expect(await prepareClaim(fileLocalOwnerStore(dir), SECRET, 2_000)).toBe(token);
        expect(claimUrl('http://localhost:8787/', token!)).toBe(`http://localhost:8787/auth/claim?t=${encodeURIComponent(token!)}`);

        // Expired: a fresh token replaces it.
        const later = await prepareClaim(store, SECRET, 1_000 + 25 * 60 * 60 * 1000);
        expect(later).not.toBe(token);

        const routes = createLocalOwnerRoutes({ store, secret: SECRET, iterations: 1_000, now: () => 1_000 + 25 * 60 * 60 * 1000 });
        expect((await serve(routes, form('/auth/claim', { t: later!, passphrase: PASS, confirm: PASS })))!.status).toBe(303);
        expect(existsSync(join(dir, 'claim-token'))).toBe(false);
        expect(await prepareClaim(fileLocalOwnerStore(dir), SECRET)).toBeNull();
    });
});

describe('createLocalOwnerRoutes', () => {
    const setup = async (): Promise<{ store: LocalOwnerStore; token: string; routes: ReturnType<typeof createLocalOwnerRoutes> }> => {
        const store = memoryLocalOwnerStore();
        const token = (await prepareClaim(store, SECRET))!;
        return { store, token, routes: createLocalOwnerRoutes({ store, secret: SECRET, iterations: 1_000 }) };
    };

    it('claims once: the form, then an elevated local_owner session; the link is dead after', async () => {
        const { token, routes } = await setup();
        const get = (await serve(routes, new Request(`${ORIGIN}/auth/claim?t=${encodeURIComponent(token)}`)))!;
        expect(get.status).toBe(200);
        expect(await get.text()).toContain('data-claim');

        const claimed = (await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS })))!;
        expect(claimed.status).toBe(303);
        expect(claimed.headers.get('location')).toBe('/');
        const session = await openSession(cookieValue(claimed, '__Host-session'), SECRET);
        expect(session).toMatchObject({ userId: LOCAL_OWNER_ID, workspaceId: LOCAL_OWNER_ID });
        expect(await openElevation(cookieValue(claimed, '__Host-elevated'), SECRET)).toMatchObject({ userId: LOCAL_OWNER_ID });

        const again = (await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS })))!;
        expect(again.status).toBe(403);
        expect(again.headers.getSetCookie()).toEqual([]);
        expect((await serve(routes, new Request(`${ORIGIN}/auth/claim?t=${encodeURIComponent(token)}`)))!.status).toBe(403);
    });

    it('redeems a token once even when two posts race', async () => {
        const { token, routes } = await setup();
        const [a, b] = await Promise.all([serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS })), serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS }))]);
        expect([a!.status, b!.status].sort()).toEqual([303, 403]);
    });

    it('refuses a forged token, mismatched or short passphrases, without spending the token', async () => {
        const { token, routes, store } = await setup();
        expect((await serve(routes, new Request(`${ORIGIN}/auth/claim?t=nope`)))!.status).toBe(403);
        expect((await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: `${PASS}!` })))!.status).toBe(400);
        expect((await serve(routes, form('/auth/claim', { t: token, passphrase: 'short', confirm: 'short' })))!.status).toBe(400);
        expect(store.load().owner).toBeFalsy();
        expect((await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS })))!.status).toBe(303);
    });

    it('signs the owner in with the passphrase, elevated when asked, and throttles guesses', async () => {
        const { token, routes } = await setup();
        // No owner yet: the login is not mounted.
        expect(await routes(new Request(`${ORIGIN}/auth/local-login`))).toBeUndefined();
        await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS }));

        expect((await serve(routes, new Request(`${ORIGIN}/auth/local-login?returnTo=/machines`)))!.status).toBe(200);
        const ok = (await serve(routes, form('/auth/local-login', { passphrase: PASS, returnTo: '/machines' })))!;
        expect(ok.status).toBe(303);
        expect(ok.headers.get('location')).toBe('/machines');
        expect(await openSession(cookieValue(ok, '__Host-session'), SECRET)).toMatchObject({ userId: LOCAL_OWNER_ID });
        expect(cookieValue(ok, '__Host-elevated')).toBeNull();

        const elevated = (await serve(routes, form('/auth/local-login', { passphrase: PASS, elevate: '1', returnTo: '//evil.example' })))!;
        expect(elevated.headers.get('location')).toBe('/');
        expect(await openElevation(cookieValue(elevated, '__Host-elevated'), SECRET)).toMatchObject({ userId: LOCAL_OWNER_ID });

        for (let i = 0; i < 5; i++) expect((await serve(routes, form('/auth/local-login', { passphrase: 'wrong wrong wrong' })))!.status).toBe(401);
        expect((await serve(routes, form('/auth/local-login', { passphrase: PASS })))!.status).toBe(429);
    });

    it('holds the guess limit when wrong passphrases arrive in parallel (#1013)', async () => {
        const { token, routes } = await setup();
        await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS }));
        const burst = await Promise.all(Array.from({ length: 20 }, () => serve(routes, form('/auth/local-login', { passphrase: 'wrong wrong wrong' }))));
        const statuses = burst.map((r) => r!.status);
        expect(statuses.filter((s) => s === 401)).toHaveLength(5);
        expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    });

    it('a right passphrase resets the guess count (#1013)', async () => {
        const { token, routes } = await setup();
        await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS }));
        for (let i = 0; i < 4; i++) expect((await serve(routes, form('/auth/local-login', { passphrase: 'wrong wrong wrong' })))!.status).toBe(401);
        expect((await serve(routes, form('/auth/local-login', { passphrase: PASS })))!.status).toBe(303);
        for (let i = 0; i < 5; i++) expect((await serve(routes, form('/auth/local-login', { passphrase: 'wrong wrong wrong' })))!.status).toBe(401);
    });

    it('sends the local owner to the passphrase for /auth/elevate, and anyone else on', async () => {
        const { token, routes } = await setup();
        await serve(routes, form('/auth/claim', { t: token, passphrase: PASS, confirm: PASS }));
        const mine = sessionCookie(await sealSession({ userId: LOCAL_OWNER_ID, workspaceId: LOCAL_OWNER_ID as WorkspaceId }, SECRET)).split(';')[0]!;
        const elevate = (await serve(routes, new Request(`${ORIGIN}/auth/elevate?returnTo=/machines`, { headers: { cookie: mine } })))!;
        expect(elevate.status).toBe(303);
        expect(elevate.headers.get('location')).toBe('/auth/local-login?elevate=1&returnTo=%2Fmachines');
        const theirs = sessionCookie(await sealSession({ userId: 'gh_1', workspaceId: 'gh_1' as WorkspaceId }, SECRET)).split(';')[0]!;
        expect(await routes(new Request(`${ORIGIN}/auth/elevate`, { headers: { cookie: theirs } }))).toBeUndefined();
        expect(await routes(new Request(`${ORIGIN}/auth/elevate`))).toBeUndefined();
        expect(await routes(new Request(`${ORIGIN}/agents`))).toBeUndefined();
    });
});
