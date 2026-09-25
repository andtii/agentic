/**
 * A request sent from a chat hears back in that chat (#839; PMChat, HANDOFF 468–479): the manager's triage reply, as
 * the manager, then the result of the accept — on a real in-process host with Chat, Plan and Requests. Declines and
 * questions post their reason; a request from nowhere, or a reply that fails, changes nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, actorKey, type AgentId, type ChatEntry, type ChatId, type Principal, type ProjectId, type ProjectRecord, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { Chat, ChatPage } from '../../src/chat/index';
import { definePlanActor } from '../../src/plan/index';
import { defineRequestsActor, requestsKey, type RequestReply, type RequestView } from '../../src/requests/index';
import { requestReplyFor, requestReplyText } from '../../src/requests/reply';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_r' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const CORE = 'agent_core' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const KEEL = 'agent_keel' as AgentId;
const CHAT_A = 'c_a' as ChatId;
const CHAT_B = 'c_b' as ChatId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

const projects: Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>[] = [
    { id: SX, name: 'SignalX', members: { agentIds: [NOVA, CORE], coordinator: NOVA }, pm: { agentId: NOVA, policy: { ...PM_POLICY_DEFAULT, senders: [{ project: AG, who: 'any-member', mode: 'allowed' }] } } },
    { id: AG, name: 'agentic', members: { agentIds: [KEEL, FORGE], coordinator: KEEL }, pm: { agentId: KEEL, policy: PM_POLICY_DEFAULT } }
];

const triage: Triage = {
    kind: 'bug',
    priority: 'high',
    reproduced: { ok: true, note: 'reproduced on signalx main' },
    similar: [],
    proposedItem: { title: 'batch() drops updates when an effect throws', doneWhen: ['the repro passes'], assignee: { kind: 'agent', agentId: CORE } },
    openIssue: false,
    reply: 'On it. Nova will post in agentic once it is filed.',
    why: ''
};

const view = (r: Partial<RequestView>): RequestView => ({
    id: 'req_1',
    fromProject: AG,
    fromChat: CHAT_A,
    sender: { kind: 'agent', agentId: FORGE },
    toProject: SX,
    title: 'batch() drops updates',
    body: '',
    refs: [],
    state: 'triaging',
    createdAt: 1,
    updatedAt: 1,
    ...r
});

describe('requestReplyText', () => {
    it('says the triage reply, the result, the reason and the question; nothing else', () => {
        expect(requestReplyText('SignalX', { op: 'triaged' }, view({ triage }))).toBe(triage.reply);
        expect(requestReplyText('SignalX', { op: 'accepted' }, view({ state: 'accepted', resultItem: 14 }))).toBe('SignalX#14 · accepted: "batch() drops updates" (req_1)');
        expect(requestReplyText('SignalX', { op: 'declined' }, view({ state: 'declined', declineReason: 'a duplicate of signalx#9' }))).toBe('SignalX declined "batch() drops updates" (req_1): a duplicate of signalx#9');
        expect(requestReplyText('SignalX', { op: 'asked' }, view({ state: 'asked-for-more', question: 'Which version?' }))).toBe('SignalX asks about "batch() drops updates" (req_1): Which version?');
        for (const op of ['received', 'admitted', 'answered'] as const) expect(requestReplyText('SignalX', { op }, view({}))).toBeNull();
    });

    it('a request from no chat, or a triage with no reply, posts nothing', () => {
        expect(requestReplyText('SignalX', { op: 'triaged' }, view({ fromChat: undefined, triage }))).toBeNull();
        expect(requestReplyFor(ws, SX, 'SignalX', { op: 'accepted' }, view({ fromChat: undefined, state: 'accepted', resultItem: 2 }))).toBeNull();
        expect(requestReplyText('SignalX', { op: 'triaged' }, view({ triage: { ...triage, reply: '  ' } }))).toBeNull();
        expect(requestReplyFor(ws, SX, 'SignalX', { op: 'triaged' }, view({ triage }))).toMatchObject({ workspaceId: ws, projectId: SX, chatId: CHAT_A, op: 'triaged', text: triage.reply });
    });
});

describe('replies in the requester’s chat', () => {
    let app: TestActorApp;
    let Requests: ReturnType<typeof defineRequestsActor>;

    const start = (options: Parameters<typeof defineRequestsActor>[0] = {}) => {
        const audit = capturingAuditPort();
        const Plan = definePlanActor({ audit, projects: { project: async (_ctx: unknown, _ws: WorkspaceId, id: ProjectId) => projects.find((p) => p.id === id) } });
        Requests = defineRequestsActor({ audit, projects: { projects: async () => projects }, turns: { async triage() {} }, ...options });
        app = testActorApp([Chat, ChatPage, Plan, Requests]);
        return app.start();
    };
    afterEach(() => app.stop());

    const chat = (id: ChatId) => app.as(user).actor(Chat, actorKey(ws, 'chat', id));
    const requestsAs = (p: Principal) => app.as(p).actor(Requests, requestsKey(ws, SX));
    const messages = async (id: ChatId) =>
        (await chat(id).history()).entries
            .map((e) => e.entry)
            .filter((e): e is Extract<ChatEntry, { t: 'msg' }> => e.t === 'msg')
            .map((m) => ({ author: m.author.kind === 'agent' ? m.author.agentId : m.author.kind, text: m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') }));

    const sendFrom = (chatId: ChatId | undefined) =>
        requestsAs(agentP(FORGE)).send({ fromProject: AG, ...(chatId ? { fromChat: chatId } : {}), title: 'batch() drops updates when an effect throws', body: 'Repro in usage.test.ts.', refs: [] });

    describe('with the chat port', () => {
        beforeEach(() => start());

        it('a request sent from chat A gets the manager’s triage reply and the result in chat A', async () => {
            await chat(CHAT_A).addAgent(FORGE, 'all');
            await chat(CHAT_B).addAgent(FORGE, 'all');
            const sent = await sendFrom(CHAT_A);
            expect(await messages(CHAT_A)).toEqual([]);

            await requestsAs(agentP(NOVA)).triage(sent.id, triage);
            expect(await messages(CHAT_A)).toEqual([{ author: NOVA, text: triage.reply }]);

            const accepted = await requestsAs(user).resolve(sent.id, { action: 'accept' });
            expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1 });
            expect(await messages(CHAT_A)).toEqual([
                { author: NOVA, text: triage.reply },
                { author: 'user', text: `SignalX#1 · accepted: "batch() drops updates when an effect throws" (${sent.id})` }
            ]);
            // Only the chat it came from hears back.
            expect(await messages(CHAT_B)).toEqual([]);
        });

        it('a decline posts its reason, and asking for more posts the question', async () => {
            const a = await sendFrom(CHAT_A);
            const b = await sendFrom(CHAT_B);
            await requestsAs(user).resolve(a.id, { action: 'decline', reason: 'a duplicate of signalx#9' });
            await requestsAs(user).resolve(b.id, { action: 'ask', question: 'Which SignalX version?' });
            expect(await messages(CHAT_A)).toEqual([{ author: 'user', text: `SignalX declined "batch() drops updates when an effect throws" (${a.id}): a duplicate of signalx#9` }]);
            expect(await messages(CHAT_B)).toEqual([{ author: 'user', text: `SignalX asks about "batch() drops updates when an effect throws" (${b.id}): Which SignalX version?` }]);
        });
    });

    it('a request from no chat posts nothing; a reply that fails does not stop the request', async () => {
        const posted: RequestReply[] = [];
        let fail = true;
        await start({
            replies: {
                async post(_hop, reply) {
                    if (fail) throw new Error('chat unavailable');
                    posted.push(reply);
                }
            }
        });
        const quiet = await sendFrom(undefined);
        const loud = await sendFrom(CHAT_A);
        expect(await requestsAs(agentP(NOVA)).triage(loud.id, triage)).toMatchObject({ id: loud.id, triage: { reply: triage.reply } });
        fail = false;
        await requestsAs(agentP(NOVA)).triage(quiet.id, triage);
        expect(await requestsAs(user).resolve(loud.id, { action: 'accept' })).toMatchObject({ state: 'accepted' });
        expect(posted.map((r) => [r.chatId, r.op, r.request.id])).toEqual([[CHAT_A, 'accepted', loud.id]]);
    });
});
