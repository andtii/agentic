/**
 * A cold isolate whose FIRST request is `POST /auth/pair` (#182). The
 * Worker's own host used to boot only when a request went through the
 * actor mount (`createWorkerHandler` builds the app lazily on its first
 * `fetch`), and an auth route never does — so a daemon's redeem landing on
 * a fresh isolate hopped through no host at all: 500 "no host is running".
 *
 * The workers pool runs every file in its own isolate, and the pool never
 * saw the bug because every test minted its code over the mount first. Here
 * the code is minted INSIDE the Workspace's Durable Object (`runInDurableObject`
 * over the `ACTORS` stub — the object's own host, never the Worker's), so the
 * Worker's first request of any kind is the redeem.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import type { MachineId, WorkspaceId } from '@agentic/core';
import { Workspace, asPrincipal, userPrincipal, workspaceKey } from '@agentic/platform';
import { actor, type Host } from '@sigx/actors';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { runWithHost } from '../../src/host-scope';

const userId = 'dev_cold_pair';
const WS = userId as WorkspaceId;
const ORIGIN = 'https://agentic.test';
const bindings = env as unknown as { ACTORS: DurableObjectNamespace };

describe('worker: POST /auth/pair as the first request of a cold isolate (#182)', () => {
    it('redeems a code minted in the Workspace object without any request having booted the Worker host', async () => {
        const key = workspaceKey(WS);
        const stub = bindings.ACTORS.get(bindings.ACTORS.idFromName(durableObjectName({ type: 'Workspace', key })));
        const minted = await runInDurableObject(stub, async (instance) => {
            const host = await (instance as unknown as { host(): Promise<Host> }).host();
            return runWithHost(host, () => actor(Workspace, key).with({ context: asPrincipal(userPrincipal(WS, WS)) }).registerMachinePending({ name: 'box' }));
        });

        const paired = await SELF.fetch(`${ORIGIN}/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: minted.pairingCode, name: 'box' }) });
        expect(paired.headers.get('content-type'), await paired.clone().text()).toMatch(/^application\/json/);
        expect(paired.status).toBe(200);
        const body = (await paired.json()) as { token: string; workspaceId: WorkspaceId; machineId: MachineId };
        expect(body.workspaceId).toBe(WS);
        expect(body.machineId).toBe(minted.machineId);
        expect(body.token).toMatch(/^amt\./);
    });
});
