/**
 * The Machines / Machine / Pair pages' actor calls inside workerd (#144):
 * the Pair page's `Workspace.registerMachinePending` over the HTTP mount,
 * the daemon redeeming that code through `POST /auth/pair` (the route
 * `agentic-daemon pair` calls), an `InMemoryDaemon` on the real daemon
 * socket reporting its environments and doctor verdicts to the Machine
 * Durable Object, the reads the pages make (`listMachines`, `get`,
 * `doctor`), and `Machine.revoke` from the page refusing the next connect.
 */
import { SELF } from 'cloudflare:test';
import type { EnvironmentId, MachineId, WorkspaceId } from '@agentic/core';
import { inMemoryEnvironment, inMemoryHarness, type InMemoryDaemon } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { overHttp, signIn } from './http';

const userId = 'gh_machines_pages';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
/** A definition for `overHttp` — only its `type` matters on the wire. */
const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });

let cookie = '';
beforeAll(async () => {
    cookie = await signIn(userId);
});

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

/** What `agentic-daemon pair <code> --url <origin> --name <name>` does: the code and the name to `POST /auth/pair`. */
function redeem(code: string, name: string): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });
}

/** Dial the daemon socket with the token and bridge `daemon` onto it; resolves once the platform's `welcome` arrived. */
async function connectDaemon(machineId: MachineId, token: string, daemon: InMemoryDaemon): Promise<{ close(): void }> {
    const response = await SELF.fetch(`${ORIGIN}/_agentic/daemon/${machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } });
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket upgrade, got HTTP ${response.status}`);
    ws.accept();
    const seat = daemon.dial();
    let welcomed = false;
    ws.addEventListener('message', (event) => {
        const text = String(event.data);
        if ((JSON.parse(text) as { t: string }).t === 'welcome') welcomed = true;
        seat.sendRaw!(text);
    });
    ws.addEventListener('close', () => seat.drop());
    void (async () => {
        try {
            for (;;) ws.send((await seat.next()) as string);
        } catch {
            // dropped
        }
    })();
    await until(async () => welcomed, 'the welcome');
    return {
        close() {
            seat.drop();
            ws.close(1000, 'bye');
        }
    };
}

describe('worker: the machine pages over the Durable Objects', () => {
    it('Pair mints a code the daemon redeems at /auth/pair; the pages read the daemon’s report; revoke refuses the next connect', async () => {
        const workspace = overHttp(Workspace, workspaceKey(WS), cookie);

        // The Pair page: register under the name the daemon will pair with.
        const minted = await workspace.registerMachinePending({ name: 'laptop' });
        expect(minted.pairingCode).toMatch(/^[A-Z2-9]{6}$/);
        expect(minted.expiresAt).toBeGreaterThan(Date.now());
        const machine = overHttp(Machine, machineKey(WS, minted.machineId), cookie);
        // Pending: the page watches `paired` on this record; the list page does not show it yet.
        expect((await machine.get()).paired).toBe(false);
        expect((await workspace.listMachines()).map((m) => [m.name, m.status])).toEqual([['laptop', 'pending']]);

        // The daemon redeems it — a wrong code is refused, the right one returns the token once.
        expect((await redeem('ZZZZZZ', 'laptop')).status).toBe(401);
        const paired = await redeem(minted.pairingCode, 'laptop');
        expect(paired.status).toBe(200);
        const { token, machineId, workspaceId } = (await paired.json()) as { token: string; machineId: MachineId; workspaceId: WorkspaceId };
        expect(machineId).toBe(minted.machineId);
        expect(workspaceId).toBe(WS);
        expect((await redeem(minted.pairingCode, 'laptop')).status).toBe(401);
        expect(await machine.get()).toMatchObject({ paired: true, name: 'laptop', online: false });
        expect((await workspace.listMachines()).map((m) => [m.name, m.status])).toEqual([['laptop', 'paired']]);

        // The daemon connects and reports two environments with their verdicts: what the Machine page shows.
        const checkedAt = Date.now();
        const work = { ...inMemoryEnvironment(machineId, 'env_work' as EnvironmentId), name: 'work', account: { label: 'work', authStatus: 'ok' as const }, isolation: 'config-dir' as const, doctor: { ok: true, findings: [], checkedAt } };
        const home = { ...inMemoryEnvironment(machineId, 'env_home' as EnvironmentId), name: 'home', account: { label: 'home', authStatus: 'expired' as const }, isolation: 'config-dir' as const };
        const daemon = inMemoryHarness({ machineId, environments: [work, home] }).start({ events: 1, heartbeatMs: 600_000 }) as InMemoryDaemon;
        const link = await connectDaemon(machineId, token, daemon);
        const view = await machine.get();
        expect(view).toMatchObject({ online: true, paired: true, revoked: false });
        expect(view.environments.map((e) => [e.id, e.account.authStatus])).toEqual([
            ['env_work', 'ok'],
            ['env_home', 'expired']
        ]);
        const doctor = await machine.doctor();
        expect(doctor).toMatchObject({ online: true, ok: false, unverified: ['env_home'] });
        expect(doctor.environments.map((e) => [e.environmentId, e.verdict?.ok])).toEqual([
            ['env_work', true],
            ['env_home', undefined]
        ]);

        // Revoke from the page: the record says so at once, the socket is closed, and the token is refused at the door.
        expect(await machine.revoke()).toMatchObject({ revoked: true, online: false });
        link.close();
        const refused = await SELF.fetch(`${ORIGIN}/_agentic/daemon/${machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${token}` } });
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: 'unauthorized', reason: 'revoked' });
        // Pairing again with the old code is refused too: the code was single use, and the machine is revoked.
        expect((await redeem(minted.pairingCode, 'laptop')).status).toBe(401);
        expect((await machine.get()).environments.map((e) => e.id)).toEqual(['env_work', 'env_home']);
    });
});
