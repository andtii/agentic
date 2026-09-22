// @vitest-environment node
/** The `__Host-elevated` cookie (#355): minted for one user, read only beside that user's session, ten minutes long. */
import type { WorkspaceId } from '@agentic/core';
import { isServerFnError } from '@sigx/server';
import { authenticateRequest, clearElevationCookie, ELEVATION_COOKIE, ELEVATION_REQUIRED, ELEVATION_TTL_MS, elevationCookie, elevationFromRequest, isElevated, openElevation, requireElevated, sealElevation, sealSession, sessionCookie, userPrincipal } from '../../src/index';

const SECRET = 'test-session-secret-that-is-long-enough';
const OTHER = 'another-session-secret-that-is-long-enough';
const NOW = 1_800_000_000_000;
const ws = 'gh_42' as WorkspaceId;

const cookie = (...values: string[]) => values.map((v) => v.split(';')[0]!).join('; ');
const request = (...values: string[]) => new Request('https://app.test/x', { headers: { cookie: cookie(...values) } });

describe('elevation cookie', () => {
    it('seals and opens for its user, for ten minutes, under the session secret', async () => {
        const value = await sealElevation({ userId: 'gh_42' }, SECRET, { now: NOW });
        await expect(openElevation(value, SECRET, NOW)).resolves.toMatchObject({ userId: 'gh_42', iat: NOW, exp: NOW + ELEVATION_TTL_MS });
        await expect(openElevation(value, SECRET, NOW + ELEVATION_TTL_MS)).resolves.toBeNull();
        await expect(openElevation(value, OTHER, NOW)).resolves.toBeNull();
        await expect(openElevation(`${value}x`, SECRET, NOW)).resolves.toBeNull();
        await expect(openElevation('', SECRET, NOW)).resolves.toBeNull();
        // A session seal is not an elevation, however valid.
        await expect(openElevation(await sealSession({ userId: 'gh_42', workspaceId: ws }, SECRET, { now: NOW }), SECRET, NOW)).resolves.toBeNull();
    });

    it('is a __Host- cookie: Secure, Path=/, HttpOnly, no Domain; cleared with Max-Age=0', async () => {
        const set = elevationCookie(await sealElevation({ userId: 'gh_42' }, SECRET, { now: NOW }));
        expect(set).toMatch(new RegExp(`^${ELEVATION_COOKIE}=[^;]+; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
        expect(set).not.toMatch(/Domain=/);
        expect(clearElevationCookie()).toBe(`${ELEVATION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    });

    it('authenticate: elevatedUntil rides the user principal only beside the same user’s session', async () => {
        const session = sessionCookie(await sealSession({ userId: 'gh_42', workspaceId: ws }, SECRET, { now: NOW }));
        const other = sessionCookie(await sealSession({ userId: 'gh_7', workspaceId: 'gh_7' as WorkspaceId }, SECRET, { now: NOW }));
        const elevated = elevationCookie(await sealElevation({ userId: 'gh_42' }, SECRET, { now: NOW }));
        const options = { sessionSecret: SECRET, now: () => NOW + 1000 };
        await expect(authenticateRequest(request(session, elevated), options)).resolves.toEqual({ kind: 'user', userId: 'gh_42', workspaceId: ws, elevatedUntil: NOW + ELEVATION_TTL_MS });
        await expect(authenticateRequest(request(session), options)).resolves.toEqual({ kind: 'user', userId: 'gh_42', workspaceId: ws });
        await expect(authenticateRequest(request(other, elevated), options)).resolves.toEqual({ kind: 'user', userId: 'gh_7', workspaceId: 'gh_7' });
        await expect(authenticateRequest(request(elevated), options)).resolves.toBeNull();
        // Expired elevation, live session: a plain user.
        await expect(authenticateRequest(request(session, elevated), { sessionSecret: SECRET, now: () => NOW + ELEVATION_TTL_MS + 1 })).resolves.toEqual({ kind: 'user', userId: 'gh_42', workspaceId: ws });
        // A bearer request never carries one.
        const bearer = new Request('https://app.test/x', { headers: { authorization: 'Bearer nope', cookie: cookie(session, elevated) } });
        await expect(authenticateRequest(bearer, options)).resolves.toBeNull();
        await expect(elevationFromRequest(request(elevated), SECRET, NOW)).resolves.toMatchObject({ userId: 'gh_42' });
    });

    it('requireElevated refuses 403 elevation-required: … for a plain or expired user, a machine, an agent or nobody', () => {
        expect(() => requireElevated(userPrincipal('gh_42', ws, NOW + 1), NOW)).not.toThrow();
        for (const [principal, at] of [
            [userPrincipal('gh_42', ws), NOW],
            [userPrincipal('gh_42', ws, NOW), NOW],
            [{ kind: 'machine', workspaceId: ws, machineId: 'm1' }, NOW],
            [{ kind: 'agent', workspaceId: ws, agentId: 'a', sessionId: 's' }, NOW],
            [null, NOW],
            [undefined, NOW]
        ] as const) {
            try {
                requireElevated(principal as never, at, 'set the folders');
                throw new Error('did not throw');
            } catch (e) {
                if (!isServerFnError(e)) throw e;
                expect(e.status).toBe(403);
                expect(e.message).toMatch(new RegExp(`^${ELEVATION_REQUIRED}: confirm with your login provider to set the folders`));
            }
            expect(isElevated(principal as never, at)).toBe(false);
        }
        expect(isElevated(userPrincipal('gh_42', ws, NOW + 1), NOW)).toBe(true);
    });
});
