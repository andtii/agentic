/**
 * The request tools reach the Requests actor inside workerd (#930): an agent of one project sends another project a
 * request with `projects_request` from its chat session; the target's manager, in the triage task the request
 * started, triages it with its own `requests_triage` tool call — every actor call over the Worker's own mount, as the
 * agent (a sealed `agt.` bearer), the project catalogue as the workspace's user — and the request ends where the
 * target's policy says: accepted into the plan, or in Needs you. The MCP surface lists the four request tools.
 */
import type { AgentId, ChatId, Principal, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { PM_POLICY_DEFAULT } from '@agentic/core';
import { AgentActor, agentKey, createActorToolPorts, definePlanActor, defineRequestsActor, planKey, requestsKey, requestTurnTaskId, sealAgentToken, Workspace, workspaceKey, type AgentPrincipal } from '@agentic/platform';
import { platformTools as mcpTools } from '@agentic/mcp';
import { platformTools } from '@agentic/runtimes';
import type { AnyActorDefinition } from '@sigx/actors';
import type { ActorTransport } from '@sigx/actors/client';
import { configureActors, fetchTransport } from '@sigx/actors/client';
import { SELF } from 'cloudflare:test';
import { clientDefs } from '../../src/actors/client';
import { createActorPlatformPort } from '../../src/auth/oauth-server/port';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
/** Only their `type` matters on the wire; the host runs the app's own definitions. */
const Plan = definePlanActor();
const Requests = defineRequestsActor();
const TEST_MS = 120_000;

const transport = (headers: Record<string, string>) =>
    fetchTransport({
        endpoint: `${ORIGIN}/_sigx/actor`,
        headers: { ...headers, origin: ORIGIN },
        fetch: (input, init) => SELF.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)
    });

/** As in plan-tools: the Workspace root and the Agent records as the owner, everything else as the agent. */
function sessionWire(cookie: string, agentToken: string): ActorTransport {
    const owner = transport({ cookie });
    const agent = transport({ authorization: `Bearer ${agentToken}` });
    const pick = (symbol: string) => (symbol.startsWith('Workspace#') || symbol.startsWith('Agent#') ? owner : agent);
    return { name: 'session-wire', call: (symbol, args, init) => pick(symbol).call(symbol, args, init), stream: (symbol, args, init) => pick(symbol).stream(symbol, args, init) };
}

afterEach(() => {
    configureActors(null);
});

async function session(cookie: string, principal: AgentPrincipal, chatId?: ChatId) {
    configureActors(sessionWire(cookie, await sealAgentToken(principal as Principal & { kind: 'agent' }, TEST_SESSION_SECRET)));
    const ports = createActorToolPorts({ principal, ...(chatId ? { chatId } : {}) });
    const tools = platformTools(ports);
    return (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input, { toolCallId: `call_${name}`, signal: new AbortController().signal } as never);
}

describe('worker: request tools over the Requests actor', () => {
    it(
        'PRJ-15: projects_request → the manager’s requests_triage in its triage task → accepted, or Needs you, as the policy says',
        async () => {
            const userId = 'gh_9300';
            const ws = userId as WorkspaceId;
            const cookie = await signIn(userId);
            configureActors(transport({ cookie }));
            const workspace = overHttp(Workspace, workspaceKey(ws), cookie);
            const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
            const agentic = await workspace.upsertProject({ name: 'agentic', members: { agentIds: [forge], coordinator: null } });
            const signalx = await workspace.upsertProject({ name: 'signalx' });
            const nova = signalx.pm!.agentId as AgentId;
            await workspace.setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });
            await overHttp(AgentActor, agentKey(ws, forge), cookie).update({ name: 'Forge' }, 'name');
            const chatId = (await createChatWith(clientDefs(), ws, [forge], forge, agentic.id)) as ChatId;

            const forgeRun = await session(cookie, { kind: 'agent', workspaceId: ws, agentId: forge, sessionId: `sess_${forge}` as SessionId }, chatId);
            expect(await forgeRun('projects_request', { toProject: signalx.id, title: 'batch() drops nested effects', body: 'Found while testing.' })).toMatchObject({ request: 'req_1', state: 'triaging', mode: 'allowed' });
            expect(await forgeRun('projects_request', { toProject: signalx.id, title: 'release blocker', body: 'Blocks our release.' })).toMatchObject({ request: 'req_2', state: 'triaging' });

            // The manager works each request in the triage task it started: the task names the project.
            const triage = async (request: string, priority: 'normal' | 'high') => {
                const taskId = requestTurnTaskId(signalx.id, request, 1) as TaskId;
                const run = await session(cookie, { kind: 'agent', workspaceId: ws, agentId: nova, sessionId: `sess_${nova}_${request}` as SessionId, taskId });
                const out = await run('requests_triage', { request, kind: 'bug', priority, proposedItem: { title: `Fix ${request}`, doneWhen: ['test passes'] }, reply: 'Reproduced.' });
                return { out, run };
            };
            const normal = await triage('req_1', 'normal');
            expect(normal.out).toMatchObject({ request: 'req_1', state: 'triaging', needsPerson: false });
            expect(await normal.run('requests_resolve', { request: 'req_1', action: 'accept' })).toEqual({ request: 'req_1', state: 'accepted', item: '#1' });
            const high = await triage('req_2', 'high');
            expect(high.out).toMatchObject({ request: 'req_2', state: 'needs-you', needsPerson: true });

            configureActors(null);
            const incoming = await overHttp(Requests, requestsKey(ws, signalx.id), cookie).incoming();
            expect(Object.fromEntries(incoming.map((r) => [r.id, r.state]))).toEqual({ req_1: 'accepted', req_2: 'needs-you' });
            expect(incoming.find((r) => r.id === 'req_1')).toMatchObject({ fromChat: chatId, resultItem: 1 });
            const { plans } = await overHttp(Plan, planKey(ws, signalx.id), cookie).list();
            expect(plans[0]!.phases[0]!.items.map((i) => i.title)).toEqual(['Fix req_1']);
        },
        TEST_MS
    );

    it(
        'the MCP surface lists the four request tools and reaches the same actor in the user’s name',
        async () => {
            const user = 'gh_9301';
            const ws = user as WorkspaceId;
            const cookie = await signIn(user);
            const workspace = overHttp(Workspace, workspaceKey(ws), cookie);
            const agentic = await workspace.upsertProject({ name: 'agentic' });
            const signalx = await workspace.upsertProject({ name: 'signalx' });
            await workspace.setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });

            configureActors(transport({ cookie }));
            const stub = (type: string) => ({ type }) as unknown as AnyActorDefinition;
            const principal = { kind: 'external', workspaceId: ws, clientId: 'client_1', scopes: ['projects'] } as const;
            const port = createActorPlatformPort(principal, { actors: ['session', 'machine', 'routing', 'Schedule'].map(stub) });
            const names = mcpTools(port, principal).map((t) => t.name);
            expect(names).toEqual(expect.arrayContaining(['requests_list', 'requests_triage', 'requests_resolve', 'projects_request']));

            const requests = port.requests!;
            // A person sends from agentic, which signalx lets straight in to triage.
            expect(await requests.send({ fromProject: agentic.id, toProject: signalx.id, title: 'x', body: 'y', refs: [] })).toMatchObject({ id: 'req_1', state: 'triaging' });
            expect((await requests.list(signalx.id)).map((r) => r.id)).toEqual(['req_1']);
            expect(await requests.list(signalx.id, 'accepted')).toEqual([]);
            // Triage is made as signalx's manager; a normal bug stays with it, and a person accepts it.
            expect(await requests.triage(signalx.id, 'req_1', { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix x', doneWhen: ['done'] }, openIssue: false, reply: 'ok', why: '' })).toMatchObject({ state: 'triaging' });
            expect(await requests.resolve(signalx.id, 'req_1', { action: 'accept' })).toMatchObject({ state: 'accepted', resultItem: 1 });
        },
        TEST_MS
    );
});
