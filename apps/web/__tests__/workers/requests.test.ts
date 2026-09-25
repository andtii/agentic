/**
 * The Requests actor on the real `ActorHost` (#758): an agent of one project sends another project a request over
 * the wire (its own `agt.` bearer); the receiving project's own manager — created with the project (#784) — triages
 * it within the policy the owner set, and accepting it creates the item in that project's Plan and links it.
 */
import { SELF } from 'cloudflare:test';
import { PM_POLICY_DEFAULT, type AgentId, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { definePlanActor, defineRequestsActor, planKey, requestsKey, sealAgentToken, Workspace, workspaceKey } from '@agentic/platform';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_7580';
const workspaceId = userId as WorkspaceId;
/** Only their `type` matters on the wire; the host runs the app's own definitions. */
const Plan = definePlanActor();
const Requests = defineRequestsActor();
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

describe('worker: Requests', () => {
    it('PRJ-15: send → the manager triages within its policy → accept creates the plan item and links it', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
        const agentic = await workspace.upsertProject({ name: 'agentic', members: { agentIds: [forge], coordinator: null } });
        const signalx = await workspace.upsertProject({ name: 'signalx' });
        const nova = signalx.pm!.agentId as AgentId;
        expect(nova).toBeDefined();
        await workspace.setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });

        const key = requestsKey(workspaceId, signalx.id);
        const sent = await (await asAgent(Requests, key, forge)).send({ fromProject: agentic.id, title: 'batch() drops nested effects', body: 'Found while testing.' });
        expect(sent).toMatchObject({ id: 'req_1', state: 'triaging', sender: { kind: 'agent', agentId: forge } });

        const asNova = await asAgent(Requests, key, nova);
        await asNova.triage('req_1', { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix nested batch()', doneWhen: ['test passes'] }, openIssue: false, reply: 'On it.', why: '' });
        expect(await asNova.resolve('req_1', { action: 'accept' })).toMatchObject({ state: 'accepted', resultItem: 1 });

        const { plans } = await overHttp(Plan, planKey(workspaceId, signalx.id), cookie).list();
        expect(plans[0]!.phases[0]!.items.map((i) => [i.id, i.title])).toEqual([[1, 'Fix nested batch()']]);
        const sentView = await overHttp(Requests, requestsKey(workspaceId, agentic.id), cookie).sent();
        expect(sentView.map((r) => [r.id, r.state, r.resultItem])).toEqual([['req_1', 'accepted', 1]]);
    }, TEST_MS);
});
