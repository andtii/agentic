/**
 * Visiting project managers (#762; PRJ-16): who visits a chat, who an `@` mention brings in, the request card's pill,
 * the Across projects list — and the HANDOFF "Project manager and requests" flow (lines 468–479) on a real in-process
 * host: Forge finds the bug is upstream, you bring Nova (SignalX's manager) in by `@`, the request goes to SignalX,
 * Nova triages it to you, you accept, and the chat reads the filed item back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, actorKey, type AgentId, type ChatId, type Principal, type ProjectId, type ProjectRequest, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { Chat, ChatPage } from '../../src/chat/index';
import {
    VISITING_ROLE,
    acrossProjects,
    bringInVisitors,
    chatRequests,
    projectManagerOf,
    requestCardState,
    visitingManagers,
    visitorOf,
    visitorsIn,
    visitorsToBringIn,
    type VisitingProject
} from '../../src/chat/participants-visiting';
import { definePlanActor } from '../../src/plan/index';
import { defineRequestsActor, requestsKey } from '../../src/requests/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_v' as WorkspaceId;
const AG = 'prj_ag' as ProjectId;
const SX = 'prj_sx' as ProjectId;
const DOC = 'prj_doc' as ProjectId;
const FORGE = 'agent_forge' as AgentId;
const KEEL = 'agent_keel' as AgentId;
const NOVA = 'agent_nova' as AgentId;
const CORE = 'agent_core' as AgentId;
const QUILL = 'agent_quill' as AgentId;
const CHAT = 'c_rings' as ChatId;

const projects: VisitingProject[] = [
    { id: AG, name: 'agentic', members: { agentIds: [FORGE, KEEL], coordinator: KEEL }, pm: { agentId: KEEL, policy: PM_POLICY_DEFAULT } },
    { id: SX, name: 'SignalX', members: { agentIds: [NOVA, CORE], coordinator: NOVA }, pm: { agentId: NOVA, policy: { ...PM_POLICY_DEFAULT, senders: [{ project: AG, who: 'any-member', mode: 'allowed' }] } } },
    // No `pm`: its coordinator manages it.
    { id: DOC, name: 'docs', members: { agentIds: [QUILL], coordinator: QUILL } }
];

const request = (r: Partial<ProjectRequest> & Pick<ProjectRequest, 'id' | 'state'>): ProjectRequest => ({
    fromProject: AG,
    fromChat: CHAT,
    sender: { kind: 'agent', agentId: FORGE },
    toProject: SX,
    title: 'batch() drops updates when an effect throws',
    body: '',
    refs: [],
    createdAt: 1,
    updatedAt: 1,
    ...r
});

describe('who visits', () => {
    it('a project manager is pm.agentId, else the coordinator', () => {
        expect(projectManagerOf(projects[1]!)).toBe(NOVA);
        expect(projectManagerOf(projects[2]!)).toBe(QUILL);
        expect(projectManagerOf({ members: { agentIds: [], coordinator: null } })).toBeNull();
    });

    it('the other projects’ managers visit; the chat’s own project and a chat outside a project have none', () => {
        expect(visitingManagers(projects, AG)).toEqual([
            { agentId: NOVA, projectId: SX, projectName: 'SignalX', role: VISITING_ROLE },
            { agentId: QUILL, projectId: DOC, projectName: 'docs', role: VISITING_ROLE }
        ]);
        expect(visitingManagers(projects, SX).map((v) => v.agentId)).toEqual([KEEL, QUILL]);
        expect(visitingManagers(projects, null)).toEqual([]);
    });

    it('a manager that is also a member of the chat’s project is at home, not visiting', () => {
        const shared = projects.map((p) => (p.id === AG ? { ...p, members: { ...p.members, agentIds: [...p.members.agentIds, NOVA] } } : p));
        expect(visitorOf(NOVA, shared, AG)).toBeUndefined();
        expect(visitorOf(NOVA, projects, AG)?.projectName).toBe('SignalX');
    });

    it('members that visit, in member order; a mention brings in only managers that are not members yet', () => {
        expect(visitorsIn([FORGE, QUILL, NOVA], projects, AG).map((v) => v.agentId)).toEqual([QUILL, NOVA]);
        expect(visitorsToBringIn([NOVA, FORGE, NOVA, QUILL], [FORGE, QUILL], projects, AG).map((v) => v.agentId)).toEqual([NOVA]);
        expect(visitorsToBringIn([CORE], [], projects, AG)).toEqual([]);
    });
});

describe('the request card and Across projects', () => {
    it('the pill follows the request, ACCEPTED → SIGNALX#14 once filed', () => {
        expect(requestCardState(request({ id: 'req_1', state: 'triaging' }), 'SignalX', 'Nova').label).toBe('NOVA TRIAGING');
        expect(requestCardState(request({ id: 'req_1', state: 'needs-you' }), 'SignalX', 'Nova').label).toBe('NEEDS YOU');
        expect(requestCardState(request({ id: 'req_1', state: 'accepted', resultItem: 14 }), 'SignalX', 'Nova').label).toBe('ACCEPTED → SIGNALX#14');
        expect(requestCardState(request({ id: 'req_1', state: 'declined' }), 'SignalX', 'Nova').label).toBe('DECLINED');
    });

    it('only this chat’s requests, oldest first, each once', () => {
        const a = request({ id: 'req_2', state: 'triaging', createdAt: 5 });
        const b = request({ id: 'req_1', state: 'accepted', createdAt: 2 });
        const other = request({ id: 'req_3', state: 'triaging', fromChat: 'c_other' as ChatId });
        expect(chatRequests([a, b, other, a], CHAT).map((r) => r.id)).toEqual(['req_1', 'req_2']);
    });

    it('lists the filed item and the chat project’s items a request names', () => {
        const refs = [{ kind: 'project-item' as const, project: 'agentic', n: 16 }, { kind: 'project-item' as const, project: 'other', n: 3 }];
        const filed = request({ id: 'req_1', state: 'accepted', resultItem: 14, refs, updatedAt: 9 });
        expect(acrossProjects([filed], projects, AG)).toEqual([
            { ref: 'signalx#14', projectId: SX, n: 14, state: 'filed' },
            { ref: 'agentic#16', projectId: AG, n: 16, state: 'waits' }
        ]);
        expect(acrossProjects([request({ id: 'req_1', state: 'declined', refs })], projects, AG)).toEqual([{ ref: 'agentic#16', projectId: AG, n: 16, state: 'open' }]);
        expect(acrossProjects([request({ id: 'req_1', state: 'triaging' })], projects, AG)).toEqual([]);
    });
});

describe('PMChat flow (HANDOFF 468–479)', () => {
    const user: Principal = { kind: 'user', userId: 'u_andii', workspaceId: ws };
    const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
    let app: TestActorApp;
    let Requests: ReturnType<typeof defineRequestsActor>;

    beforeEach(() => {
        const audit = capturingAuditPort();
        const Plan = definePlanActor({ audit, projects: { project: async (_ctx: unknown, _ws: WorkspaceId, id: ProjectId) => projects.find((p) => p.id === id) } });
        Requests = defineRequestsActor({ audit, projects: { projects: async () => projects }, turns: { async triage() {} } });
        app = testActorApp([Chat, ChatPage, Plan, Requests]);
        return app.start();
    });
    afterEach(() => app.stop());

    const chatAs = (p: Principal) => app.as(p).actor(Chat, actorKey(ws, 'chat', CHAT));
    const requestsAs = (p: Principal, project: ProjectId) => app.as(p).actor(Requests, requestsKey(ws, project));

    it('@Nova brings SignalX’s manager in, the request card updates in place, and the filed item links back', async () => {
        const chat = chatAs(user);
        await chat.addAgent(FORGE, 'all');

        // Forge finds the bug is upstream in SignalX.
        await chatAs(agentP(FORGE)).post('The ring test isn’t our bug. batch() in SignalX drops two updates when an effect inside it throws.');

        // You: "@Nova can SignalX take this?" — Nova is not a member: the mention brings her in as a visitor, then the message activates her.
        const members = Object.keys((await chat.get()).members);
        const brought = await bringInVisitors(chat, [NOVA], members, projects, AG);
        expect(brought).toEqual([{ agentId: NOVA, projectId: SX, projectName: 'SignalX', role: VISITING_ROLE }]);
        const posted = await chat.post('@Nova can SignalX take this? We need it for agentic 0.5. Forge, add your repro.', [NOVA]);
        expect(posted.activated).toEqual([NOVA]);
        const summary = await chat.get();
        // History from now: Nova reads from the entry that brought her in (after Forge's join and message), not before.
        expect(summary.members[NOVA]?.historyFrom).toBe(2);
        expect(visitorsIn(Object.keys(summary.members), projects, AG).map((v) => [v.agentId, v.projectName, v.role])).toEqual([[NOVA, 'SignalX', 'project manager, visiting']]);
        // A second mention brings no one in again.
        expect(await bringInVisitors(chat, [NOVA], Object.keys(summary.members), projects, AG)).toEqual([]);

        // The request goes to SignalX from this chat, with Forge's repro and the agentic item that waits on it.
        const sent = await requestsAs(agentP(FORGE), SX).send({ fromProject: AG, fromChat: CHAT, title: 'batch() drops updates when an effect throws', body: 'Repro in usage.test.ts.', refs: ['packages/ui/src/usage.test.ts:12-40', 'agentic#16'] });
        const card = async () => chatRequests(await requestsAs(user, SX).from(AG), CHAT);
        expect((await card()).map((r) => requestCardState(r, 'SignalX', 'Nova').label)).toEqual(['NOVA TRIAGING']);

        // Nova triages: high priority, so it goes in front of you.
        const triage: Triage = {
            kind: 'bug',
            priority: 'high',
            reproduced: { ok: true, note: 'reproduced on signalx main' },
            similar: [],
            proposedItem: { title: 'batch() drops updates when an effect throws', doneWhen: ['the repro passes'], assignee: { kind: 'agent', agentId: CORE } },
            openIssue: false,
            reply: 'On it. I reproduced it on signalx main.',
            why: ''
        };
        await requestsAs(agentP(NOVA), SX).triage(sent.id, triage);
        expect((await card()).map((r) => requestCardState(r, 'SignalX', 'Nova').label)).toEqual(['NEEDS YOU']);

        // You accept in SignalX: the same card now reads the filed item; Across projects lists it and the agentic item that waits.
        const accepted = await requestsAs(user, SX).resolve(sent.id, { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1 });
        const [after] = await card();
        expect(after?.id).toBe(sent.id);
        expect(requestCardState(after!, 'SignalX', 'Nova').label).toBe('ACCEPTED → SIGNALX#1');
        expect(acrossProjects(await card(), projects, AG)).toEqual([
            { ref: 'signalx#1', projectId: SX, n: 1, state: 'filed' },
            { ref: 'agentic#16', projectId: AG, n: 16, state: 'waits' }
        ]);
    });
});
