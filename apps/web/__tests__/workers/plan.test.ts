/**
 * The Plan actor on the real `ActorHost` (#750): an agent claims an item with a short lease over the wire (its
 * own `agt.` bearer), and the object's own alarm — nothing else calling it — runs the lease out and disarms: the item goes
 * back to the top of the agent's queue and the project manager has a notice. Alarms are advanced with
 * `runDurableObjectAlarm`.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import type { AgentId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { definePlanActor, planKey, sealAgentToken, Workspace, workspaceKey } from '@agentic/platform';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { durableObjectName } from '@sigx/actors-cloudflare';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_7500';
const workspaceId = userId as WorkspaceId;
/** Only its `type` ('plan') matters on the wire; the host runs the app's own definition. */
const Plan = definePlanActor();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

describe('worker: Plan lease alarm', () => {
    it('PRJ-11: a lease that runs out puts the item back at the top of the queue and tells the manager', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const pm = (await workspace.createAgent({ name: 'Keel' })).agentId as AgentId;
        const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
        const project = await workspace.upsertProject({ name: 'plans', members: { agentIds: [pm, forge], coordinator: pm } });

        const key = planKey(workspaceId, project.id);
        const plan = overHttp(Plan, key, cookie);
        await plan.create({ title: 'Ship', phases: [{ title: 'One', items: [{ title: 'store' }, { title: 'tools' }] }] });
        await plan.assign(2, { kind: 'agent', agentId: forge });

        const asForge = await asAgent(Plan, key, forge);
        const { item } = await asForge.claim(1, { leaseMs: 1_000 });
        expect(item).toMatchObject({ state: 'claimed', claim: { agentId: forge } });

        const namespace = (env as unknown as { ACTORS: DurableObjectNamespace }).ACTORS;
        const stub = namespace.get(namespace.idFromName(durableObjectName({ type: 'plan', key })));
        // The lease end is armed on the object's own alarm.
        const alarmAt = () => runInDurableObject(stub, (_instance, state: DurableObjectState) => state.storage.getAlarm());
        const armed = await alarmAt();
        expect(armed).not.toBeNull();
        expect(armed! - Date.now()).toBeLessThanOrEqual(1_000);
        // Nobody calls the object from here until its alarm has run (any call would expire the lease itself): workerd
        // fires it on time; `runDurableObjectAlarm` runs it now if it has not fired yet.
        await sleep(1_200);
        await runDurableObjectAlarm(stub);
        expect(await alarmAt()).toBeNull();
        const first = async () => (await plan.get('plan-1')).phases[0]!.items[0]!;
        expect(await first()).toMatchObject({ state: 'ready', assignee: { kind: 'agent', agentId: forge }, queueIndex: 0 });
        const asPm = await asAgent(Plan, key, pm);
        expect(await asPm.takeNotices()).toMatchObject([{ kind: 'lease-expired', itemId: 1 }]);
        // The manager is read from the project record over the Workspace hop, for an agent caller too.
        expect((await asPm.add('plan-1', 1, [{ title: 'docs' }])).map((i) => i.id)).toEqual([3]);
        await expect(asForge.add('plan-1', 1, [{ title: 'nope' }])).rejects.toThrow(/project manager/);
    }, TEST_MS);
});
