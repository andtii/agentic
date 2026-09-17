/**
 * OPS-10 on the real `ActorHost` (issue #100): `exportAll` lands in the
 * `ARTIFACTS` R2 bucket, `deleteAll` empties every indexed actor's own
 * Durable Object, the Registry seals secrets under `WORKSPACE_KEK`, and the
 * object's purge endpoint refuses anything without the deployment secret.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { AgentId, ChatId, WorkspaceId } from '@agentic/core';
import { AgentActor, Chat, Registry, Workspace, agentKey, registryKey, workspaceKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { PURGE_HEADER, PURGE_PATH } from '../../src/retention';
import { overHttp, signIn } from './http';

const userId = 'gh_3003';
const workspaceId = userId as WorkspaceId;

interface Bindings {
    ACTORS: DurableObjectNamespace;
    ARTIFACTS: R2Bucket;
}
const bindings = env as unknown as Bindings;
const stubOf = (type: string, key: string) => bindings.ACTORS.get(bindings.ACTORS.idFromName(durableObjectName({ type, key })));
const storedKeys = (type: string, key: string) => runInDurableObject(stubOf(type, key), async (_instance, state) => [...(await state.storage.list()).keys()]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

describe('worker: workspace retention over the Durable Object bindings (OPS-10)', () => {
    it('exports to R2, seals secrets under WORKSPACE_KEK, and deleteAll empties every indexed object', async () => {
        const cookie = await signIn(userId);
        const wsKey = workspaceKey(workspaceId);
        const ws = overHttp(Workspace, wsKey, cookie);
        const { agentId } = await ws.createAgent({ name: 'Ada' });
        await overHttp(AgentActor, agentKey(workspaceId, agentId as AgentId), cookie).update({ name: 'Ada', instructions: 'Be brief.' }, 'create');
        const { chatId } = await ws.createChat({});
        const chatKey = `${workspaceId}:chat:${chatId as ChatId}`;
        await overHttp(Chat, chatKey, cookie).post('hello');
        const registry = overHttp(Registry, registryKey(workspaceId), cookie);
        await registry.setSecret('github-token', 'ghp_example');
        expect(await registry.secrets()).toMatchObject([{ name: 'github-token' }]);

        await ws.exportAll();
        await until(async () => (await ws.get()).ops?.export?.finishedAt !== undefined, 'the export');
        const op = (await ws.get()).ops!.export!;
        expect(op.error).toBeUndefined();
        const listed = await bindings.ARTIFACTS.list({ prefix: `${op.prefix}/` });
        const files = listed.objects.map((o) => o.key.slice(op.prefix!.length + 1));
        expect(files).toEqual(expect.arrayContaining(['manifest.json', 'workspace.ndjson', 'agents.ndjson', 'chats.ndjson', 'registry.ndjson']));
        const registryRows = await (await bindings.ARTIFACTS.get(`${op.prefix}/registry.ndjson`))!.text();
        expect(registryRows).toContain('github-token');
        expect(registryRows).not.toContain('ghp_example');

        const agentRef = ['Agent', agentKey(workspaceId, agentId as AgentId)] as const;
        expect(await storedKeys(...agentRef)).not.toEqual([]);

        await ws.deleteAll();
        // The root clears its own record last; the host's other bookkeeping in that object (reminder shards) is not workspace data (docs/retention.md).
        await until(async () => !(await storedKeys('Workspace', wsKey)).includes(`sigx:state\0Workspace\0${wsKey}`), 'the workspace record to be cleared');
        for (const [type, key] of [agentRef, ['Chat', chatKey], ['Registry', registryKey(workspaceId)]] as const) {
            expect(await storedKeys(type, key), `${type} ${key}`).toEqual([]);
        }
        expect((await ws.get()).agents).toEqual([]);
        expect(await registry.secrets()).toEqual([]);
    });

    it("refuses a purge without the deployment's secret", async () => {
        const key = agentKey(workspaceId, 'agent_kept' as AgentId);
        const cookie = await signIn(userId);
        await overHttp(AgentActor, key, cookie).update({ name: 'Kept', instructions: 'Stay.' }, 'create');
        const before = await storedKeys('Agent', key);
        expect(before).not.toEqual([]);

        const stub = stubOf('Agent', key);
        expect((await stub.fetch(`https://actor-host${PURGE_PATH}`, { method: 'POST' })).status).toBe(403);
        expect((await stub.fetch(`https://actor-host${PURGE_PATH}`, { method: 'POST', headers: { [PURGE_HEADER]: 'wrong' } })).status).toBe(403);
        expect(await storedKeys('Agent', key)).toEqual(before);

        // The Worker never forwards the path to an object.
        const res = await (await import('cloudflare:test')).SELF.fetch(`https://agentic.test${PURGE_PATH}`, { method: 'POST' });
        expect(res.status).not.toBe(204);
        expect(await storedKeys('Agent', key)).toEqual(before);
    });
});
