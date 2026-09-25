/**
 * The PMChat flow on the real `ActorHost` (#762; PRJ-16; HANDOFF "Project manager and requests", lines 468–479):
 * Forge (agentic) finds the bug is upstream in SignalX; you `@` SignalX's manager in the agentic chat and she joins
 * as a visitor; the request goes to SignalX from that chat; she triages it high priority, so it comes to you; you
 * accept in SignalX; the chat's request card reads `ACCEPTED → SIGNALX#1` and Across projects links the filed item and
 * the agentic item that waits on it.
 */
import { SELF } from 'cloudflare:test';
import { PM_POLICY_DEFAULT, type AgentId, type ChatId, type Principal, type SessionId, type WorkspaceId } from '@agentic/core';
import { Chat, VISITING_ROLE, Workspace, acrossProjects, bringInVisitors, chatRequests, defineRequestsActor, requestCardState, requestsKey, sealAgentToken, visitorsIn, workspaceKey } from '@agentic/platform';
import type { ActorClient, AnyActorDefinition } from '@sigx/actors';
import { fetchTransport } from '@sigx/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { overHttp, signIn } from './http';
import { TEST_SESSION_SECRET } from './secret';

const ORIGIN = 'https://agentic.test';
const userId = 'gh_7620';
const workspaceId = userId as WorkspaceId;
/** Only its `type` matters on the wire; the host runs the app's own definition. */
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

describe('worker: visiting project manager in chat (PMChat)', () => {
    it('PRJ-16: @ another project’s manager, the request card updates in place, the filed item links back', async () => {
        const cookie = await signIn(userId);
        const workspace = overHttp(Workspace, workspaceKey(workspaceId), cookie);
        const forge = (await workspace.createAgent({ name: 'Forge' })).agentId as AgentId;
        const agentic = await workspace.upsertProject({ name: 'agentic', members: { agentIds: [forge], coordinator: null } });
        const signalx = await workspace.upsertProject({ name: 'SignalX' });
        const nova = signalx.pm!.agentId as AgentId;
        await workspace.setProjectPmPolicy(signalx.id, { ...PM_POLICY_DEFAULT, senders: [{ project: agentic.id, who: 'any-member', mode: 'allowed' }] });

        // The agentic chat: Forge is in it and finds the bug upstream.
        const { chatId } = await workspace.createChat({ projectId: agentic.id });
        const chat = overHttp(Chat, chatKeyOf(workspaceId, chatId as ChatId), cookie);
        await chat.addAgent(forge, 'all');

        // You `@Nova`: SignalX's manager joins as a visitor before the message, so the message activates her.
        const projects = await workspace.projects();
        const brought = await bringInVisitors(chat, [nova], Object.keys((await chat.get()).members), projects, agentic.id);
        expect(brought.map((v) => [v.agentId, v.projectName, v.role])).toEqual([[nova, 'SignalX', VISITING_ROLE]]);
        expect((await chat.post('@Nova can SignalX take this?', [nova])).activated).toEqual([nova]);
        expect(visitorsIn(Object.keys((await chat.get()).members), projects, agentic.id).map((v) => v.agentId)).toEqual([nova]);

        // The request goes to SignalX from this chat.
        const key = requestsKey(workspaceId, signalx.id);
        const sent = await (await asAgent(Requests, key, forge)).send({ fromProject: agentic.id, fromChat: chatId as ChatId, title: 'batch() drops updates when an effect throws', body: 'Repro in usage.test.ts.', refs: ['agentic#16'] });
        const cards = async () => chatRequests(await overHttp(Requests, key, cookie).from(agentic.id), chatId);
        expect((await cards()).map((r) => requestCardState(r, 'SignalX', 'Nova').label)).toEqual(['NOVA TRIAGING']);

        // Nova triages it high priority: it comes to you.
        await (await asAgent(Requests, key, nova)).triage(sent.id, { kind: 'bug', priority: 'high', similar: [], proposedItem: { title: 'Fix batch() on a throwing effect', doneWhen: ['the repro passes'] }, openIssue: false, reply: 'On it.', why: '' });
        expect((await cards()).map((r) => requestCardState(r, 'SignalX', 'Nova').label)).toEqual(['NEEDS YOU']);

        // You accept in SignalX: the same card reads the filed item, and Across projects links it and the waiting agentic item.
        await overHttp(Requests, key, cookie).resolve(sent.id, { action: 'accept' });
        const after = await cards();
        expect(after.map((r) => [r.id, requestCardState(r, 'SignalX', 'Nova').label])).toEqual([[sent.id, 'ACCEPTED → SIGNALX#1']]);
        expect(acrossProjects(after, projects, agentic.id).map((i) => [i.ref, i.state])).toEqual([['signalx#1', 'filed'], ['agentic#16', 'waits']]);
    }, TEST_MS);
});
