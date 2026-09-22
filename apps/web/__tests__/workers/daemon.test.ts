/** The daemon socket end to end inside workerd (#36): pair, connect to the Machine object, hello/welcome, drop, revoke. */
import { SELF } from 'cloudflare:test';
import type { MachineId, WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { fetchTransport } from '@sigx/actors/client';
import { overHttp, signInElevated } from './http';

const userId = 'gh_daemon';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
/** A definition for `overHttp` — only its `type` matters on the wire. */
const Machine = defineMachineActor({ socket: { send: () => false, close: () => {} } });

let cookie = '';
beforeAll(async () => {
    cookie = await signInElevated(userId);
});

async function pairNew(name: string): Promise<{ machineId: MachineId; token: string; machine: ReturnType<typeof overHttp<typeof Machine>> }> {
    const ws = overHttp(Workspace, workspaceKey(WS), cookie);
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const machine = overHttp(Machine, machineKey(WS, machineId), cookie);
    const { token } = await machine.pair(pairingCode, { name });
    return { machineId, token, machine };
}

function connect(machineId: string, token: string | null, path = `/_agentic/daemon/${machineId}`): Promise<Response> {
    return SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: 'websocket', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

/** Open the daemon end of an accepted upgrade and collect what the platform sends. */
function open(response: Response): { ws: WebSocket; next(): Promise<Record<string, unknown>> } {
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket, got HTTP ${response.status}`);
    ws.accept();
    const queue: Record<string, unknown>[] = [];
    const waiters: ((f: Record<string, unknown>) => void)[] = [];
    ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        const w = waiters.shift();
        if (w) w(frame);
        else queue.push(frame);
    });
    return {
        ws,
        next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve)))
    };
}

const hello = (machineId: string, environments: unknown[]) => JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId, daemonVersion: '0.0.0-test', os: 'windows', environments, capabilities: [IN_MEMORY_CAPABILITIES], resume: {} });

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

describe('worker: daemon socket on the Machine Durable Object', () => {
    it('two paired daemons connect and appear with independent environments and availability (AC-01)', async () => {
        const a = await pairNew('alpha');
        const b = await pairNew('beta');
        const envA = inMemoryEnvironment(a.machineId, 'env_a' as never);
        const envB1 = { ...inMemoryEnvironment(b.machineId, 'env_b1' as never), name: 'work', account: { label: 'work', authStatus: 'ok' } };
        const envB2 = { ...inMemoryEnvironment(b.machineId, 'env_b2' as never), name: 'home', account: { label: 'home', authStatus: 'missing' } };

        const socketA = open(await connect(a.machineId, a.token));
        const socketB = open(await connect(b.machineId, b.token));
        socketA.ws.send(hello(a.machineId, [envA]));
        socketB.ws.send(hello(b.machineId, [envB1, envB2]));
        expect(await socketA.next()).toMatchObject({ t: 'welcome', wanted: {} });
        expect(await socketB.next()).toMatchObject({ t: 'welcome', wanted: {} });

        const viewA = await a.machine.get();
        const viewB = await b.machine.get();
        expect(viewA).toMatchObject({ online: true, os: 'windows', daemonVersion: '0.0.0-test', name: 'alpha' });
        expect(viewA.environments.map((e) => e.id)).toEqual(['env_a']);
        expect(viewB.environments.map((e) => e.id)).toEqual(['env_b1', 'env_b2']);
        expect(viewB.environments[1]?.account.authStatus).toBe('missing');

        // Dropping A's socket takes A offline at once and leaves B online.
        socketA.ws.close(1000, 'bye');
        await until(async () => !(await a.machine.get()).online, 'alpha offline');
        expect((await b.machine.get()).online).toBe(true);
        socketB.ws.close(1000, 'bye');
        await until(async () => !(await b.machine.get()).online, 'beta offline');
    });

    it('refuses a missing, malformed, mismatched, unknown or revoked token at connect', async () => {
        const m = await pairNew('gamma');
        expect((await connect(m.machineId, null)).status).toBe(401);
        expect((await connect(m.machineId, 'nonsense')).status).toBe(401);
        // A token for another machine on this machine's path: the address and the credential disagree.
        const other = await pairNew('delta');
        expect((await connect(m.machineId, other.token)).status).toBe(403);
        // Right shape, wrong secret: the hash does not match.
        const forged = m.token.slice(0, -1) + (m.token.endsWith('A') ? 'B' : 'A');
        expect((await connect(m.machineId, forged)).status).toBe(401);
        // Not a WebSocket upgrade.
        expect((await SELF.fetch(`${ORIGIN}/_agentic/daemon/${m.machineId}`, { headers: { authorization: `Bearer ${m.token}` } })).status).toBe(426);

        expect((await connect(m.machineId, m.token)).status).toBe(101);
        await m.machine.revoke();
        const refused = await connect(m.machineId, m.token);
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: 'unauthorized', reason: 'revoked' });
        expect(await m.machine.get()).toMatchObject({ revoked: true, online: false });
    });

    it('a machine token authenticates on the actor mount once paired (the machines lookup)', async () => {
        const m = await pairNew('epsilon');
        const key = machineKey(WS, m.machineId);
        const transport = fetchTransport({ endpoint: `${ORIGIN}/_sigx/actor`, headers: { origin: ORIGIN, authorization: `Bearer ${m.token}` }, fetch: (input, init) => SELF.fetch(input as string, init) });
        const record = (await transport.call('machine#tokenRecord', [key], { ref: { type: 'machine', key } })) as { tokenHash: string; revokedAt: number | null };
        expect(record.revokedAt).toBeNull();
        expect(typeof record.tokenHash).toBe('string');
        // A revoked token is anonymous on the mount too.
        await m.machine.revoke();
        await expect(transport.call('machine#tokenRecord', [key], { ref: { type: 'machine', key } })).rejects.toMatchObject({ status: 401 });
    });
});
