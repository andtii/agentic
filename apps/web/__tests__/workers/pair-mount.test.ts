/**
 * `POST /auth/pair` on a dev-login-only deployment (#180): the workers pool
 * binds ONLY `SESSION_SECRET`, `WORKSPACE_KEK` and `AGENTIC_DEV_LOGIN` — no
 * GitHub OAuth app, no `APP_ORIGIN` — exactly what `pnpm dev` has on a
 * fresh `.dev.vars`. The daemon's redeem route (and `/auth/me`,
 * `/auth/logout`) must be mounted from the session secret alone; only the
 * GitHub login needs the OAuth secrets and stays unmounted (404) without them.
 */
import { SELF } from 'cloudflare:test';
import type { MachineId, WorkspaceId } from '@agentic/core';
import { Workspace, workspaceKey } from '@agentic/platform';
import { overHttp, signIn } from './http';

const userId = 'dev_pair_mount';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';

describe('worker: the session-secret-only auth routes (#180)', () => {
    it('POST /auth/pair answers JSON without the GitHub secrets; GET /auth/login is not mounted', async () => {
        const cookie = await signIn(userId);
        const minted = await overHttp(Workspace, workspaceKey(WS), cookie).registerMachinePending({ name: 'box' });

        const paired = await SELF.fetch(`${ORIGIN}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: minted.pairingCode, name: 'box' }) });
        expect(paired.status).toBe(200);
        expect(paired.headers.get('content-type')).toMatch(/^application\/json/);
        const body = (await paired.json()) as { token: string; workspaceId: WorkspaceId; machineId: MachineId };
        expect(body.workspaceId).toBe(WS);
        expect(body.machineId).toBe(minted.machineId);
        expect(body.token).toMatch(/^amt\./);

        const me = await SELF.fetch(`${ORIGIN}/auth/me`, { headers: { cookie } });
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ principal: { kind: 'user', userId } });

        const logout = await SELF.fetch(`${ORIGIN}/auth/logout`, { method: 'POST', redirect: 'manual' });
        expect(logout.status).toBe(302);

        // No OAuth app configured: the GitHub door does not exist.
        expect((await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: 'manual' })).status).toBe(404);
        expect((await SELF.fetch(`${ORIGIN}/auth/callback?code=x&state=y`, { redirect: 'manual' })).status).toBe(404);
    });
});
