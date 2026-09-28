/** The daemon keepalive on the hibernation auto-response (#984): `{"p":1}` is answered `{"p":1}` by the runtime, and an old `heartbeat` still lands. */
import { SELF } from 'cloudflare:test';
import type { MachineId, WorkspaceId } from '@agentic/core';
import { DAEMON_PROTOCOL_VERSION } from '@agentic/daemon-protocol';
import { IN_MEMORY_CAPABILITIES, inMemoryEnvironment } from '@agentic/daemon-protocol/testing';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { overHttp, signInElevated } from './http';

const userId = 'gh_daemon_ping';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
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

function open(response: Response): { ws: WebSocket; next(): Promise<string> } {
    const ws = response.webSocket;
    if (!ws) throw new Error(`expected a WebSocket, got HTTP ${response.status}`);
    ws.accept();
    const queue: string[] = [];
    const waiters: ((text: string) => void)[] = [];
    ws.addEventListener('message', (event) => {
        const text = String(event.data);
        const w = waiters.shift();
        if (w) w(text);
        else queue.push(text);
    });
    return { ws, next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))) };
}

describe('worker: daemon keepalive', () => {
    it('answers the ping without the actor, and still takes a legacy heartbeat', async () => {
        const m = await pairNew('pinger');
        const response = await SELF.fetch(`${ORIGIN}/_agentic/daemon/${m.machineId}`, { headers: { upgrade: 'websocket', authorization: `Bearer ${m.token}` } });
        const socket = open(response);
        socket.ws.send(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'hello', machineId: m.machineId, daemonVersion: '0.0.0-test', os: 'linux', environments: [inMemoryEnvironment(m.machineId, 'env_p' as never)], capabilities: [IN_MEMORY_CAPABILITIES], resume: {} }));
        expect(JSON.parse(await socket.next())).toMatchObject({ t: 'welcome' });

        socket.ws.send('{"p":1}');
        expect(await socket.next()).toBe('{"p":1}');

        socket.ws.send(JSON.stringify({ v: DAEMON_PROTOCOL_VERSION, t: 'heartbeat', at: Date.now(), active: [] }));
        socket.ws.send('{"p":1}');
        expect(await socket.next()).toBe('{"p":1}');
        expect(await m.machine.get()).toMatchObject({ online: true });
        socket.ws.close(1000, 'done');
    });
});
