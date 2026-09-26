/**
 * #932: an accept with "open GitHub issue" opens it once through the app's issue port and links its URL on the item it
 * became; the sending project's manager is refused a send while its "send requests to other projects" switch is off.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PM_POLICY_DEFAULT, type AgentId, type PmPolicy, type Principal, type ProjectId, type ProjectRecord, type SessionId, type Triage, type WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import { defineRequestsActor, requestsKey, type RequestIssue, type RequestIssuePort } from '../../src/requests/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const SX = 'prj_sx' as ProjectId;
const AG = 'prj_ag' as ProjectId;
const NOVA = 'agent_nova' as AgentId;
const KEEL = 'agent_keel' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

type Rec = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'pm'>;
const sxPolicy: PmPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: '*', who: 'any-member', mode: 'allowed' }] };
let agPolicy: PmPolicy;
let projects: Rec[];

/** A fake provider: records every issue it is asked to open. */
let opened: RequestIssue[];
let answer: 'open' | 'none' | 'throw';
const fakeIssues: RequestIssuePort = {
    async open(issue) {
        opened.push(issue);
        if (answer === 'throw') throw new Error('GitHub is down');
        if (answer === 'none') return null;
        return { url: `https://github.com/octo/signalx/issues/${40 + opened.length}`, number: 40 + opened.length };
    }
};

let app: TestActorApp;
let Requests: ReturnType<typeof defineRequestsActor>;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    opened = [];
    answer = 'open';
    agPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: '*', who: 'any-member', mode: 'allowed' }] };
    projects = [
        { id: SX, name: 'signalx', members: { agentIds: [NOVA], coordinator: NOVA }, pm: { agentId: NOVA, policy: sxPolicy } },
        { id: AG, name: 'agentic', members: { agentIds: [KEEL, FORGE], coordinator: KEEL }, pm: { agentId: KEEL, policy: agPolicy } }
    ];
    const audit = capturingAuditPort();
    Plan = definePlanActor({ audit, projects: { project: async (_ctx, _ws, id) => projects.find((p) => p.id === id) } });
    Requests = defineRequestsActor({ audit, projects: { projects: async () => projects }, turns: { async triage() {} }, issues: fakeIssues });
    app = testActorApp([Plan, Requests]);
    return app.start();
});
afterEach(() => app.stop());

const requests = (project: ProjectId = SX, p: Principal = user) => app.as(p).actor(Requests, requestsKey(ws, project));
const items = async () => (await app.as(user).actor(Plan, planKey(ws, SX)).list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items));

const triage = (openIssue: boolean): Triage => ({ kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix nested batch()', doneWhen: ['nested batch test passes'] }, openIssue, reply: 'On it.', why: '' });

async function triaged(openIssue: boolean): Promise<void> {
    await requests(SX, agentP(FORGE)).send({ fromProject: AG, title: 'batch() drops nested effects', body: 'Found while testing.', refs: [] });
    await requests(SX, agentP(NOVA)).triage('req_1', triage(openIssue));
}

describe('#932: accepting opens the GitHub issue when asked', () => {
    it('opens the issue once, keeps its URL on the request and links it on the item', async () => {
        await triaged(true);
        const accepted = await requests().resolve('req_1', { action: 'accept' });
        expect(opened).toHaveLength(1);
        expect(opened[0]).toMatchObject({ workspaceId: ws, projectId: SX, projectName: 'signalx', requestId: 'req_1', itemN: 1, title: 'Fix nested batch()' });
        expect(opened[0]!.body).toContain('Found while testing.');
        expect(opened[0]!.body).toContain('agentic (req_1)');
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1, openIssue: true, issueUrl: 'https://github.com/octo/signalx/issues/41' });
        expect((await items())[0]!.refs).toContainEqual({ kind: 'url', url: 'https://github.com/octo/signalx/issues/41' });

        // An accepted request is final: resolving again opens nothing more.
        await expect(requests().resolve('req_1', { action: 'accept' })).rejects.toThrow();
        expect(opened).toHaveLength(1);
        expect((await requests().get('req_1')).issueUrl).toBe('https://github.com/octo/signalx/issues/41');
    });

    it("a person's choice wins over the triage's: no issue when they turn it off, one when they turn it on", async () => {
        await triaged(true);
        await requests().resolve('req_1', { action: 'accept', openIssue: false });
        expect(opened).toHaveLength(0);

        await requests(SX, agentP(FORGE)).send({ fromProject: AG, title: 'second', body: 'b', refs: [] });
        await requests(SX, agentP(NOVA)).triage('req_2', triage(false));
        const second = await requests().resolve('req_2', { action: 'accept', openIssue: true });
        expect(opened).toHaveLength(1);
        expect(second.issueUrl).toBeDefined();
    });

    it('no provider answer or a provider failure leaves the request accepted without an issue', async () => {
        answer = 'none';
        await triaged(true);
        const accepted = await requests().resolve('req_1', { action: 'accept' });
        expect(accepted).toMatchObject({ state: 'accepted', resultItem: 1 });
        expect(accepted.issueUrl).toBeUndefined();

        answer = 'throw';
        await requests(SX, agentP(FORGE)).send({ fromProject: AG, title: 'again', body: 'b', refs: [] });
        await requests(SX, agentP(NOVA)).triage('req_2', triage(true));
        const second = await requests().resolve('req_2', { action: 'accept' });
        expect(second.state).toBe('accepted');
        expect(second.issueUrl).toBeUndefined();
        expect(opened).toHaveLength(2);
    });
});

describe('#932: the send-requests switch is enforced', () => {
    it("the sending project's manager is refused while the switch is off; a person and other members still send", async () => {
        await expect(requests(SX, agentP(KEEL)).send({ fromProject: AG, title: 'from the PM', body: 'b', refs: [] })).rejects.toMatchObject({ status: 403 });
        expect(await requests(SX).incoming()).toHaveLength(0);

        await expect(requests(SX, user).send({ fromProject: AG, title: 'from a person', body: 'b', refs: [] })).resolves.toMatchObject({ id: 'req_1' });
        await expect(requests(SX, agentP(FORGE)).send({ fromProject: AG, title: 'from a member', body: 'b', refs: [] })).resolves.toMatchObject({ id: 'req_2' });
    });

    it('the manager sends once the switch is on', async () => {
        projects[1] = { ...projects[1]!, pm: { agentId: KEEL, policy: { ...agPolicy, autonomy: { ...agPolicy.autonomy, sendRequests: true } } } };
        await expect(requests(SX, agentP(KEEL)).send({ fromProject: AG, title: 'from the PM', body: 'b', refs: [] })).resolves.toMatchObject({ id: 'req_1' });
    });
});
