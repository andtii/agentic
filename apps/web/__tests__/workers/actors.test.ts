import { env, evictDurableObject } from 'cloudflare:test';
import type { AgentId, ChatId, WorkspaceId } from '@agentic/core';
import { AgentActor, Chat, Workspace, agentKey, workspaceKey } from '@agentic/platform';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, seen, signIn } from './http';

const userId = 'gh_1001';
const workspaceId = userId as WorkspaceId;

afterEach(() => {
    seen.length = 0;
});

describe('worker: platform actors over the HTTP actor mount', () => {
    it('creates a workspace, an agent and a chat', async () => {
        const cookie = await signIn(userId);
        const ws = overHttp(Workspace, workspaceKey(workspaceId), cookie);

        const { agentId } = await ws.createAgent({ name: 'Ada' });
        const { chatId } = await ws.createChat({});

        const agent = overHttp(AgentActor, agentKey(workspaceId, agentId as AgentId), cookie);
        const created = await agent.update({ name: 'Ada', instructions: 'Be brief.' }, 'create');
        expect(created.version).toBe(1);
        expect((await agent.get()).configVersion).toBe(1);

        const chat = overHttp(Chat, `${workspaceId}:chat:${chatId as ChatId}`, cookie);
        await chat.post('hello');
        const history = await chat.history(null, 10);
        expect(JSON.stringify(history)).toContain('hello');

        const view = await ws.get();
        expect(view.agents).toContain(agentId);
        expect(view.chats).toContain(chatId);

        expect(seen.length).toBe(7);
        for (const path of seen) expect(path.startsWith('/_sigx/actor/')).toBe(true);
    });

    it('keeps state in the Durable Object between calls', async () => {
        const cookie = await signIn(userId);
        const ws = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const before = (await ws.get()).agents.length;
        await ws.createAgent({ name: 'Grace' });
        await ws.createAgent({ name: 'Linus' });
        expect((await ws.get()).agents.length).toBe(before + 2);
    });

    it('survives an eviction of the actor Durable Object', async () => {
        const cookie = await signIn(userId);
        const key = workspaceKey(workspaceId);
        const ws = overHttp(Workspace, key, cookie);
        const { agentId } = await ws.createAgent({ name: 'Evicted' });

        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        await evictDurableObject(namespace.get(namespace.idFromName(durableObjectName({ type: 'Workspace', key }))));

        expect((await ws.get()).agents).toContain(agentId);
    });

    it('refuses an anonymous caller with 401', async () => {
        const ws = overHttp(Workspace, workspaceKey(workspaceId), null);
        await expect(ws.get()).rejects.toMatchObject({ status: 401 });
    });

    it('refuses another workspace with 403', async () => {
        const ws = overHttp(Workspace, workspaceKey('gh_2002'), await signIn(userId));
        await expect(ws.get()).rejects.toMatchObject({ status: 403 });
    });

});
