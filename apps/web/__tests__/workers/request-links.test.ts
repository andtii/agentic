/**
 * #931 on the real `ActorHost`: a person accepting a request links the items across projects. The requester's item
 * the request names (`agentic#2`) waits on the filed item (`signalx#1`) through a real cross-project `after` — the
 * workspace's link graph (`workspaceLinks`) shows the pair, and the requester's item is blocked until it is done.
 */
import { SELF } from 'cloudflare:test';
import { PM_POLICY_DEFAULT, type AgentId, type Principal, type ProjectId, type SessionId, type WorkspaceId } from '@agentic/core';
import { definePlanActor, defineRequestsActor, planKey, requestsKey, sealAgentToken, Workspace, workspaceKey, workspaceLinks } from '@agentic/platform';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_9310';
const workspaceId = userId as WorkspaceId;
const Plan = definePlanActor();
const Requests = defineRequestsActor();
const TEST_MS = 120_000;

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
        get: (_target, method) => (typeof method === 'string' && method !== 'then' ? (...args: unknown[]) => transport.call(`${type}#${method}`, [key, ...args], { ref: { type, key } }) : undefined)
    });
}

describe('worker: accepting a request links the items (#931)', () => {
    it('workspaceLinks shows the pair; the requester item is blocked until the filed one is done', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
        const agentic = await workspace.upsertProject({ name: 'agentic', members: { agentIds: [forge], coordinator: null } });
        const signalx = await workspace.upsertProject({ name: 'signalx' });
        const nova = signalx.pm!.agentId as AgentId;
        await workspace.setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });

        const agenticPlan = overHttp(Plan, planKey(workspaceId, agentic.id), cookie);
        await agenticPlan.create({ title: 'Ship', phases: [{ title: 'Now', items: [{ title: 'Prep' }, { title: 'Use batch()', after: [1] }] }] });

        const key = requestsKey(workspaceId, signalx.id);
        await (await asAgent(Requests, key, forge)).send({ fromProject: agentic.id, title: 'batch() drops nested effects', body: 'Blocks agentic#2.', refs: ['agentic#2'] });
        await (await asAgent(Requests, key, nova)).triage('req_1', { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix nested batch()', doneWhen: ['test passes'] }, openIssue: false, reply: 'On it.', why: '' });
        const accepted = await overHttp(Requests, key, cookie).resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1, acceptedBy: { kind: 'user', userId } });

        const itemOf = async (plan: typeof agenticPlan, n: number) => (await plan.list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items)).find((i) => i.id === n)!;
        const waiting = await itemOf(agenticPlan, 2);
        expect(waiting.state).toBe('blocked');
        expect((waiting as typeof waiting & { afterRefs?: unknown }).afterRefs).toEqual([{ projectId: signalx.id, n: 1 }]);

        const projects = [agentic, signalx].map((p) => ({ id: p.id as ProjectId, name: p.name }));
        const graph = await workspaceLinks({ projects: async () => projects, items: (id) => overHttp(Plan, planKey(workspaceId, id), cookie).linkItems() });
        expect(graph.edges).toContainEqual(expect.objectContaining({ from: `${signalx.id}#1`, to: `${agentic.id}#2` }));

        await agenticPlan.update(1, { state: 'done' });
        expect((await itemOf(agenticPlan, 2)).state).toBe('blocked');
        await overHttp(Plan, planKey(workspaceId, signalx.id), cookie).update(1, { tick: [{ index: 0, checked: true }], state: 'done' });
        expect((await itemOf(agenticPlan, 2)).state).toBe('ready');
    }, TEST_MS);
});
