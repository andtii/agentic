/**
 * Requests (#883): a person's "open GitHub issue" choice on accept reaches the store and is recorded on the accepted
 * request; the view carries the origin chat's title and when the manager triaged it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type ChatId, type PlanActor, type PmPolicy, type Principal, type ProjectId, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor } from '../../src/plan/index';
import { defineRequestsActor, requestsKey } from '../../src/requests/index';
import { answer, checkResolution, emptyBook, receive, RequestRuleError, requestView, resolve, triage, type RequestCall } from '../../src/requests/rules';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const nova: PlanActor = { kind: 'agent', agentId: NOVA };
const forge: PlanActor = { kind: 'agent', agentId: FORGE };
const person: PlanActor = { kind: 'user', userId: 'u1' };
const policy: PmPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: AG, who: 'any-member', mode: 'allowed' }] };
const call = (actor: PlanActor, now = 1000): RequestCall => ({ now, actor, manager: NOVA, policy });

const bug: Triage = {
    kind: 'bug',
    priority: 'normal',
    similar: [],
    proposedItem: { title: 'batch() drops nested effects', doneWhen: ['test passes'] },
    openIssue: false,
    reply: 'On it.',
    why: ''
};

const codeOf = (fn: () => unknown): string | undefined => {
    try {
        fn();
    } catch (error) {
        return error instanceof RequestRuleError ? error.code : String(error);
    }
    return undefined;
};

describe('Requests rules: open issue, origin chat and triage time (#883)', () => {
    it('keeps the origin chat title with the chat, stamps triagedAt and clears it with the triage on an answer', () => {
        const b = emptyBook(ws, SX);
        const r = receive(b, call(forge), { fromProject: AG, fromChat: 'chat_1' as ChatId, fromChatTitle: '  Batch bug hunt ', title: 't', body: 'b' }, true).value;
        expect(requestView(r)).toMatchObject({ fromChat: 'chat_1', fromChatTitle: 'Batch bug hunt' });
        // No chat, no title.
        expect(receive(b, call(forge), { fromProject: AG, fromChatTitle: 'x', title: 't', body: 'b' }, true).value.fromChatTitle).toBeUndefined();
        expect(codeOf(() => receive(b, call(forge), { fromProject: AG, fromChat: 'chat_1' as ChatId, fromChatTitle: 'x'.repeat(201), title: 't', body: 'b' }, true))).toBe('invalid');

        expect(r.triagedAt).toBeUndefined();
        triage(b, call(nova, 2000), r.id, bug);
        expect(requestView(r).triagedAt).toBe(2000);
        resolve(b, call(nova, 2500), r.id, { action: 'ask', question: 'Which version?' });
        answer(b, call(forge, 3000), r.id, '1.2');
        expect(r.triagedAt).toBeUndefined();
        expect(r.triage).toBeUndefined();
    });

    it("records the open-issue choice on accept: a person's, else the triage's; the manager cannot change it", () => {
        const b = emptyBook(ws, SX);
        const one = receive(b, call(forge), { fromProject: AG, title: 't', body: 'b' }, true).value;
        triage(b, call(nova), one.id, bug);
        expect(codeOf(() => checkResolution(b, call(person), one.id, { action: 'accept', openIssue: 'yes' }))).toBe('invalid');
        expect(codeOf(() => checkResolution(b, call(nova), one.id, { action: 'accept', openIssue: true }))).toBe('forbidden');
        expect(checkResolution(b, call(nova), one.id, { action: 'accept', openIssue: false })).toEqual({ item: bug.proposedItem, openIssue: false });
        expect(checkResolution(b, call(person), one.id, { action: 'accept', openIssue: true })).toEqual({ item: bug.proposedItem, openIssue: true });
        expect(resolve(b, call(person), one.id, { action: 'accept', openIssue: true }, 3).value).toMatchObject({ state: 'accepted', resultItem: 3, openIssue: true });
        // The manager's own triage stays as it proposed.
        expect(one.triage?.openIssue).toBe(false);

        const two = receive(b, call(forge), { fromProject: AG, title: 't2', body: 'b' }, true).value;
        triage(b, call(nova), two.id, { ...bug, openIssue: true, priority: 'high' });
        expect(resolve(b, call(person), two.id, { action: 'accept' }, 4).value.openIssue).toBe(true);
    });
});

describe('Requests actor: resolve with openIssue (#883)', () => {
    const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
    const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
    let app: TestActorApp;
    let Requests: ReturnType<typeof defineRequestsActor>;
    beforeEach(() => {
        const projects = [
            { id: SX, name: 'signalx', members: { agentIds: [NOVA], coordinator: NOVA }, pm: { agentId: NOVA, policy } },
            { id: AG, name: 'agentic', members: { agentIds: [FORGE], coordinator: FORGE }, pm: { agentId: FORGE, policy: PM_POLICY_DEFAULT } }
        ];
        const audit = capturingAuditPort();
        const Plan = definePlanActor({ audit, projects: { project: async (_ctx: unknown, _ws: WorkspaceId, id: ProjectId) => projects.find((p) => p.id === id) } });
        Requests = defineRequestsActor({ audit, projects: { projects: async () => projects }, turns: { async triage() {} } });
        app = testActorApp([Plan, Requests]);
        return app.start();
    });
    afterEach(() => app.stop());

    it('an accept with openIssue records it, and the view carries the chat title and triage time', async () => {
        const store = (p: Principal) => app.as(p).actor(Requests, requestsKey(ws, SX));
        const sent = await store(agentP(FORGE)).send({ fromProject: AG, fromChat: 'chat_9' as ChatId, fromChatTitle: 'Batch bug hunt', title: 'batch() bug', body: 'nested batch' });
        expect(sent).toMatchObject({ fromChat: 'chat_9', fromChatTitle: 'Batch bug hunt' });
        const triaged = await store(agentP(NOVA)).triage(sent.id, { ...bug, priority: 'high' });
        expect(triaged.state).toBe('needs-you');
        expect(typeof triaged.triagedAt).toBe('number');
        const edited = { title: 'batch() nested', doneWhen: ['fixed'] };
        const accepted = await store(user).resolve(sent.id, { action: 'accept', item: edited, openIssue: true });
        expect(accepted).toMatchObject({ state: 'accepted', openIssue: true, fromChatTitle: 'Batch bug hunt' });
        expect((await store(user).get(sent.id)).openIssue).toBe(true);
    });
});
