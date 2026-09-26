/**
 * A plan handoff wakes its target on the real `ActorHost` (#938): Forge hands the item it works to Lint, and Lint is
 * told in the plan's chat — a message addressed to Lint, which starts Lint's task — instead of the notice waiting on
 * the Plan actor for Lint's next plan call.
 */
import { SELF } from 'cloudflare:test';
import type { AgentId, ChatId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { Chat, definePlanActor, planKey, sealAgentToken, Workspace, workspaceKey } from '@agentic/platform';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_9380';
const workspaceId = userId as WorkspaceId;
/** Only its `type` ('plan') matters on the wire; the host runs the app's own definition. */
const Plan = definePlanActor();
const TEST_MS = 120_000;

/** A client that calls as `agentId` with a sealed agent token, as a daemon relaying a tool call does. */
async function asAgent<D extends AnyActorDefinition>(def: D, key: string, agentId: AgentId): Promise<ActorClient<D>> {
    const principal: Principal & { kind: 'agent' } = { kind: 'agent', workspaceId, agentId, sessionId: `sess_${agentId}` as SessionId };
    const token = await sealAgentToken(principal, TEST_SESSION_SECRET);
    const transport = fetchTransport({
        endpoint: `${ORIGIN}/_sigx/actor`,
        headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
        fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
    });
    const type = (def as unknown as { type: string }).type;
    return new Proxy({} as ActorClient<D>, {
        // Not a thenable: this client is handed out of an async function.
        get: (_target, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => transport.call(`${type}#${method}`, [key, ...args], { ref: { type, key } }) : undefined)
    });
}

describe('worker: a plan handoff wakes its target', () => {
    it('PRJ-11: the target is addressed in the plan’s chat and its notice no longer waits on the actor', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
        const lint = (await workspace.createAgent({ name: 'Lint' })).agentId as AgentId;
        const project = await workspace.upsertProject({ name: 'wake', members: { agentIds: [forge, lint], coordinator: null } });
        const { chatId } = await workspace.createChat({ projectId: project.id });
        const chat = overHttp(Chat, chatKeyOf(workspaceId, chatId as ChatId), cookie);
        await chat.addAgent(forge, 'all');
        await chat.addAgent(lint, 'all');

        const key = planKey(workspaceId, project.id);
        await overHttp(Plan, key, cookie).create({ title: 'Ship', originChatId: chatId as ChatId, phases: [{ title: 'One', items: [{ title: 'store' }] }] });
        const asForge = await asAgent(Plan, key, forge);
        await asForge.claim(1);
        await asForge.handoff(1, { kind: 'agent', agentId: lint }, 'tests pass, review it');

        const { entries } = await chat.history(null, 20);
        const wake = entries.map((e) => e.entry).find((e) => e.t === 'msg' && e.mentions.includes(lint));
        expect(wake).toBeDefined();
        expect(JSON.stringify(wake)).toContain('handed #1 to you: tests pass, review it');
        // Woken, so not delivered a second time on Lint's next plan call.
        expect(await (await asAgent(Plan, key, lint)).takeNotices()).toEqual([]);
    }, TEST_MS);
});
