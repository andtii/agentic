/**
 * The `plan_*` tools reach the Plan actor inside workerd (#816): an agent session in a project with the plan feature
 * on runs the runtimes' tools over `createActorToolPorts` — every actor call over the Worker's own mount, as the agent
 * (a sealed `agt.` bearer), the project catalogue as the workspace's user — through the whole lease loop:
 * `plan_next` → `plan_claim` → `plan_update` ticking every done-when line, and the item is done. A claim the actor
 * refuses comes back with its reason and rule code.
 */
import type { AgentId, ChatId, Principal, SessionId, WorkspaceId } from '@agentic/core';
import { AgentActor, agentKey, createActorToolPorts, definePlanActor, planKey, sealAgentToken, ToolCallError, Workspace, workspaceKey, type AgentPrincipal } from '@agentic/platform';
import type { AnyActorDefinition } from '@sigx/actors';
import { PLAN_FEATURE_ID } from '@agentic/plugins-plan';
import { platformTools } from '@agentic/runtimes';
import type { ActorTransport } from '@sigx/actors/client';
import { configureActors, fetchTransport } from '@sigx/actors/client';
import { SELF } from 'cloudflare:test';
import { clientDefs } from '../../src/actors/client';
import { createActorPlatformPort } from '../../src/auth/oauth-server/port';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_8160';
const workspaceId = userId as WorkspaceId;
/** Only its `type` ('plan') matters on the wire; the host runs the app's own definition. */
const Plan = definePlanActor();
const TEST_MS = 120_000;

const transport = (headers: Record<string, string>) =>
    fetchTransport({
        endpoint: `${ORIGIN}/_sigx/actor`,
        headers: { ...headers, origin: ORIGIN },
        fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
    });

/**
 * The wire a session's tool ports use: calls go out as the agent, except the Workspace root, which the ports read as
 * the workspace's user (the root admits its owner only), and the members' Agent records (display names only), which
 * the Worker's mount does not open to an agent bearer. In-process the principal rides on each call's context.
 */
function sessionWire(cookie: string, agentToken: string): ActorTransport {
    const owner = transport({ cookie });
    const agent = transport({ authorization: `Bearer ${agentToken}` });
    const pick = (symbol: string) => (symbol.startsWith('Workspace#') || symbol.startsWith('Agent#') ? owner : agent);
    return { name: 'session-wire', call: (symbol, args, init) => pick(symbol).call(symbol, args, init), stream: (symbol, args, init) => pick(symbol).stream(symbol, args, init) };
}

afterEach(() => {
    configureActors(null);
});

describe('worker: plan tools over the Plan actor', () => {
    it(
        'PRJ-12: an agent session in a plan project runs plan_next → plan_claim → plan_update and the item ends done; a refused claim says why',
        async () => {
            const cookie = await signIn(userId);
            configureActors(transport({ cookie }));
            const defs = clientDefs();
            const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
            const pm = (await workspace.createAgent({ name: 'Keel' })).agentId as AgentId;
            const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
            const project = await workspace.upsertProject({ name: 'plans', members: { agentIds: [pm, forge], coordinator: pm }, features: { [PLAN_FEATURE_ID]: {} } });
            expect(project.features).toHaveProperty(PLAN_FEATURE_ID);
            const chatId = (await createChatWith(defs, workspaceId, [pm, forge], pm, project.id)) as ChatId;

            const plan = overHttp(Plan, planKey(workspaceId, project.id), cookie);
            await plan.create({ title: 'Ship', phases: [{ title: 'One', items: [{ title: 'store', doneWhen: ['tests pass', 'docs written'] }, { title: 'tools', after: [1] }] }] });

            for (const [id, name] of [[pm, 'Keel'], [forge, 'Forge']] as const) await overHttp(AgentActor, agentKey(workspaceId, id), cookie).update({ name }, 'name');
            const principal: AgentPrincipal = { kind: 'agent', workspaceId, agentId: forge, sessionId: `sess_${forge}` as SessionId };
            configureActors(sessionWire(cookie, await sealAgentToken(principal as Principal & { kind: 'agent' }, TEST_SESSION_SECRET)));
            const ports = createActorToolPorts({ principal, chatId });
            expect(ports.plan).toBeDefined();
            const tools = platformTools(ports);
            const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input, { toolCallId: `call_${name}`, signal: new AbortController().signal } as never);

            // The actor refuses a claim on an item that waits on another: its reason and its rule code, unchanged.
            const refused = await ports.plan!.claim(2, 60_000, { callId: 'call_refused', signal: new AbortController().signal }).catch((e: unknown) => e);
            expect(refused).toBeInstanceOf(ToolCallError);
            expect(refused).toMatchObject({ code: 'blocked', message: expect.stringContaining('#2 waits on #1') });

            expect(await run('plan_next', {})).toMatchObject({ item: { id: 1, title: 'store' }, from: 'open items' });
            expect(await run('plan_claim', { item: 1 })).toMatchObject({ item: 1, state: 'claimed' });
            expect(await run('plan_list', { mine: true })).toMatchObject({ items: [{ id: 1, claimedBy: '@forge' }] });
            expect(await run('plan_update', { item: 1, check: [0, 1] })).toMatchObject({ item: 1, state: 'done', doneWhen: '2 of 2 done-when ticked' });

            configureActors(null);
            const [done, next] = (await plan.get('plan-1')).phases[0]!.items;
            expect(done).toMatchObject({ id: 1, state: 'done' });
            expect(done!.claim).toBeUndefined();
            expect(next).toMatchObject({ id: 2, state: 'ready' });
        },
        TEST_MS
    );

    it(
        'PRJ-12: the MCP surface’s plan port reaches the same actor per project, members by handle, in the user’s name',
        async () => {
            const user = 'gh_8161';
            const ws = user as WorkspaceId;
            const cookie = await signIn(user);
            const workspace = overHttp(Workspace, workspaceKey(ws), cookie);
            const pm = (await workspace.createAgent({ name: 'Keel' })).agentId as AgentId;
            const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
            const project = await workspace.upsertProject({ name: 'mcp plans', members: { agentIds: [pm, forge], coordinator: pm } });
            await overHttp(Plan, planKey(ws, project.id), cookie).create({ title: 'Ship', phases: [{ title: 'One', items: [{ title: 'store' }, { title: 'tools', after: [1] }] }] });
            await overHttp(AgentActor, agentKey(ws, forge), cookie).update({ name: 'Forge' }, 'name');

            // The port runs every plan call as the workspace's user; here that is the owner's own wire.
            configureActors(transport({ cookie }));
            const stub = (type: string) => ({ type }) as unknown as AnyActorDefinition;
            const plan = createActorPlatformPort({ kind: 'external', workspaceId: ws, clientId: 'client_1', scopes: ['projects'] }, { actors: ['session', 'machine', 'routing', 'Schedule'].map(stub) }).plan!;
            expect((await plan.list(project.id)).map((p) => p.id)).toEqual(['plan-1']);
            expect(await plan.list(project.id, 'plan-9')).toEqual([]);
            expect(await plan.next(project.id, forge)).toMatchObject({ id: 1 });
            expect(await plan.assign(project.id, 1, '@forge')).toMatchObject({ id: 1, assignee: { kind: 'agent', agentId: forge } });
            await expect(plan.assign(project.id, 1, 'nobody')).rejects.toThrow(/not a member of this project/);
            expect(await plan.update(project.id, 1, { note: 'from outside' })).toMatchObject({ id: 1, activity: expect.arrayContaining([expect.objectContaining({ text: 'from outside' })]) });
            expect((await plan.add(project.id, { items: [{ title: 'docs' }] })).map((i) => i.id)).toEqual([3]);
            expect(await plan.handoff(project.id, 1, undefined, 'back to the pool')).toMatchObject({ id: 1 });
            await expect(plan.claim(project.id, 1, 'agent_stranger' as AgentId, 60_000)).rejects.toThrow(/not a member of project/);
        },
        TEST_MS
    );
});
