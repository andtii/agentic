/**
 * The request tools over the actors (#930): `createActorToolPorts(...).requests` binds `projects_request`,
 * `requests_list`, `requests_triage` and `requests_resolve` to the Requests actors under the session's agent, in the
 * session's project. A request sent by one project's agent is triaged by the target's manager through its own tool
 * call and ends where the target's policy says — accepted into the plan, or waiting on a person. An agent's
 * `chat_post` that mentions another project's manager brings it into the chat as a visitor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { actorKey, PM_POLICY_DEFAULT, type AgentId, type ChatId, type SessionId, type WorkspaceId } from '@agentic/core';
import { platformTools, type RequestResolution, type RequestsBoard } from '@agentic/runtimes';

import { AgentActor } from '../../src/agent/index';
import { AuditActor } from '../../src/audit/index';
import { mintAgentPrincipal, workspaceKey } from '../../src/auth/index';
import { Chat, ChatPage } from '../../src/chat/index';
import { ToolCallError } from '../../src/machine/index';
import { definePlanActor, planKey } from '../../src/plan/index';
import { actorResolution, createRequestsPort, defineRequestsActor, requestsKey, requestsMember, type RequestsActorClient, type RequestsProject, type RequestTurn } from '../../src/requests/index';
import { createActorToolPorts, type AgentPrincipal } from '../../src/routing/index';
import { TaskActor } from '../../src/task/index';
import { testActorApp, userPrincipal, type TestActorApp } from '../../src/testing/index';
import { Workspace } from '../../src/workspace/index';

const WS = 'u1' as WorkspaceId;
const owner = userPrincipal('u1');
const call = (id = 'c1') => ({ callId: id, signal: new AbortController().signal });

let app: TestActorApp;
let turns: RequestTurn[];
const Plan = definePlanActor();

beforeEach(async () => {
    turns = [];
    const Requests = defineRequestsActor({ turns: { triage: async (_hop, turn) => void turns.push(turn) } });
    app = testActorApp([Requests, Plan, TaskActor, Chat, ChatPage, Workspace, AuditActor, AgentActor]);
    await app.start();
});
afterEach(() => app.stop());

const workspace = () => app.as(owner).actor(Workspace, workspaceKey(WS));
const chat = (id: ChatId) => app.as(owner).actor(Chat, actorKey(WS, 'chat', id));

/** Two projects, each with its own manager; `agentic`'s Forge may send to `signalx` straight to triage. */
async function setup() {
    const forge = (await workspace().createAgent({ name: 'Forge' })).agentId as AgentId;
    const agentic = await workspace().upsertProject({ name: 'agentic', members: { agentIds: [forge], coordinator: null } });
    const signalx = await workspace().upsertProject({ name: 'signalx' });
    const nova = signalx.pm!.agentId as AgentId;
    expect(nova).toBeDefined();
    await workspace().setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });
    const forgeChat = 'chat_forge' as ChatId;
    await chat(forgeChat).addAgent(forge, 'all');
    await chat(forgeChat).setProject(agentic.id);
    const novaChat = 'chat_nova' as ChatId;
    await chat(novaChat).addAgent(nova, 'all');
    await chat(novaChat).setProject(signalx.id);
    const session = (agentId: AgentId, chatId: ChatId) => {
        const principal = mintAgentPrincipal({ workspaceId: WS, agentId, sessionId: `sess_${agentId}` as SessionId }) as AgentPrincipal;
        const ports = createActorToolPorts({ principal, chatId });
        const tools = platformTools(ports);
        const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input, { toolCallId: `call_${name}`, signal: new AbortController().signal } as never);
        return { ports, run };
    };
    return { forge, nova, agentic, signalx, forgeChat, forge$: session(forge, forgeChat), nova$: session(nova, novaChat) };
}

const triageInput = (request: string, priority: 'normal' | 'high') => ({
    request,
    kind: 'bug',
    priority,
    proposedItem: { title: 'Fix nested batch()', doneWhen: ['nested batch test passes'] },
    reply: 'Reproduced; filed.'
});

describe('request tools over the Requests actor (#930)', () => {
    it('PRJ-15: projects_request → the target manager’s requests_triage → requests_resolve accepts it into the plan', async () => {
        const { forge, signalx, agentic, forgeChat, forge$, nova$ } = await setup();
        expect(forge$.ports.requests).toBeDefined();

        const sent = await forge$.run('projects_request', { toProject: signalx.id, title: 'batch() drops nested effects', body: 'Found while testing.', refs: ['agentic#16'] });
        expect(sent).toMatchObject({ request: 'req_1', state: 'triaging', mode: 'allowed' });
        expect(turns).toMatchObject([{ projectId: signalx.id, request: { id: 'req_1', fromProject: agentic.id, fromChat: forgeChat, sender: { kind: 'agent', agentId: forge } } }]);

        expect(await nova$.run('requests_list', {})).toMatchObject({ project: signalx.id, manager: true, requests: [{ id: 'req_1', state: 'triaging', refs: ['agentic#16'] }] });
        expect(await nova$.run('requests_triage', triageInput('req_1', 'normal'))).toMatchObject({ request: 'req_1', state: 'triaging', needsPerson: false });
        expect(await nova$.run('requests_resolve', { request: 'req_1', action: 'accept' })).toEqual({ request: 'req_1', state: 'accepted', item: '#1' });

        const { plans } = await app.as(owner).actor(Plan, planKey(WS, signalx.id)).list();
        expect(plans[0]!.phases[0]!.items.map((i) => i.title)).toEqual(['Fix nested batch()']);
    });

    it('PRJ-15: a triage the policy keeps from the manager ends in Needs you, and resolving it is refused', async () => {
        const { signalx, forge$, nova$ } = await setup();
        await forge$.run('projects_request', { toProject: signalx.id, title: 'release blocker', body: 'Blocks our release.' });
        expect(await nova$.run('requests_triage', triageInput('req_1', 'high'))).toMatchObject({ request: 'req_1', state: 'needs-you', needsPerson: true });
        await expect(nova$.run('requests_resolve', { request: 'req_1', action: 'accept' })).rejects.toThrow(/needs a person/);
        const [stored] = await app.as(owner).actor(defineRequestsActor(), requestsKey(WS, signalx.id)).incoming();
        expect(stored).toMatchObject({ state: 'needs-you', needs: 'decision' });
    });

    it('the actor’s refusal comes back as a tool error with its code; a session in no project is told why', async () => {
        const { nova, signalx, forge$ } = await setup();
        await forge$.run('projects_request', { toProject: signalx.id, title: 'x', body: 'y' });
        // Straight to the port (past the tool's early refusals): Forge's session is in agentic, which holds no req_1 — the
        // actor's refusal comes back with its rule code and its words.
        const port = forge$.ports.requests!;
        const board = await port.board(call());
        expect(board).toMatchObject({ member: true, manager: expect.any(String) });
        expect(board.manager).not.toBe(nova);
        const refused = await port.triage('req_1', { kind: 'bug', priority: 'normal', similar: [], openIssue: false, reply: 'x', why: '' }, call()).catch((e: unknown) => e);
        expect(refused).toBeInstanceOf(ToolCallError);
        expect(refused).toMatchObject({ code: 'not-found', message: expect.stringContaining('no request req_1') });

        const lonely = mintAgentPrincipal({ workspaceId: WS, agentId: nova, sessionId: 'sess_lonely' as SessionId }) as AgentPrincipal;
        const none = createActorToolPorts({ principal: lonely });
        await expect(none.requests!.board(call())).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('in no project') });
        await expect(none.requests!.board(call())).rejects.toBeInstanceOf(ToolCallError);
    });

    it('PRJ-16: an agent’s chat_post mentioning another project’s manager brings it in as a visitor', async () => {
        const { nova, forge, forgeChat, forge$ } = await setup();
        expect(Object.keys((await chat(forgeChat).get()).members)).toEqual([forge]);
        await forge$.run('chat_post', { text: '@Nova can you look at this?', mentions: [nova] });
        expect(Object.keys((await chat(forgeChat).get()).members)).toEqual([forge, nova]);
        // Not another project's manager (the agent's own chat mate, or an unknown id): nobody is added.
        await forge$.run('chat_post', { text: 'hi', mentions: ['agent_nobody'] });
        expect(Object.keys((await chat(forgeChat).get()).members)).toEqual([forge, nova]);
    });
});

describe('createRequestsPort (#930)', () => {
    const P1 = { id: 'prj_a', name: 'a', members: { agentIds: ['agent_me'], coordinator: null } } as unknown as RequestsProject;
    const P2 = { id: 'prj_b', name: 'b', members: { agentIds: [], coordinator: 'agent_c' } } as unknown as RequestsProject;
    const me = 'agent_me' as AgentId;

    it('maps ask-for-more onto the actor’s ask, and sends from the session’s project and chat', async () => {
        const seen: unknown[] = [];
        const client = (projectId: string): RequestsActorClient => ({
            incoming: async () => [],
            triage: async () => ({}) as never,
            resolve: async (id, r) => (seen.push([projectId, 'resolve', id, r]), {} as never),
            send: async (input) => (seen.push([projectId, 'send', input]), {} as never)
        });
        const port = createRequestsPort({ me, scope: async () => ({ projectId: P1.id, projects: [P1, P2], chat: { id: 'chat_1' as ChatId, title: 'Fix it' } }), requests: client });
        await port.resolve('req_1', { action: 'ask-for-more', question: 'which version?' } as RequestResolution, call());
        await port.send({ toProject: P2.id, title: 't', body: 'b', refs: [] }, call());
        expect(seen).toEqual([
            ['prj_a', 'resolve', 'req_1', { action: 'ask', question: 'which version?' }],
            ['prj_b', 'send', { fromProject: 'prj_a', fromChat: 'chat_1', fromChatTitle: 'Fix it', title: 't', body: 'b', refs: [] }]
        ]);
        expect(await port.target(P2.id, call())).toMatchObject({ project: 'prj_b', name: 'b', hasManager: true });
        expect(await port.target('prj_x' as never, call())).toBeNull();
        const board: RequestsBoard = await port.board(call());
        expect(board).toMatchObject({ project: 'prj_a', me, member: true, requests: [] });
        expect(board.manager).toBeUndefined();
        expect(actorResolution({ action: 'decline', reason: 'dup' })).toEqual({ action: 'decline', reason: 'dup' });
        expect(requestsMember(P2, 'agent_c' as AgentId)).toBe(true);
        expect(requestsMember(P2, me)).toBe(false);
    });
});
