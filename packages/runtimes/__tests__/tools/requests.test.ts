/** The `requests` tool family (#759) over a fake Requests port: roster, list, manager-only triage/resolve, policy routing, sending. */
import type { ToolContext } from '@sigx/ai';
import { PM_POLICY_DEFAULT, REQUEST_TOOLS, type AgentId, type PmPolicy, type ProjectId, type ProjectRequest, type Triage } from '@agentic/core';
import { grantedPlatformTools, platformTools, requestTools, PLATFORM_TOOL_NAMES, type RequestResolution, type RequestsBoard, type RequestsPort, type RequestTarget, type ToolCall } from '../../src/index';
import { fakePorts } from '../anthropic/helpers';

const ctx = (id = 'call_1'): ToolContext => ({ toolCallId: id, signal: new AbortController().signal });

const NOVA = 'agent_nova' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const SIGNALX = 'project_signalx' as ProjectId;
const AGENTIC = 'project_agentic' as ProjectId;

const request = (id: string, over: Partial<ProjectRequest> = {}): ProjectRequest => ({
    id,
    fromProject: AGENTIC,
    sender: { kind: 'agent', agentId: FORGE },
    toProject: SIGNALX,
    title: `request ${id}`,
    body: 'batch() drops the last update',
    refs: [{ kind: 'pr', n: 604 }],
    state: 'triaging',
    createdAt: 1,
    updatedAt: 1,
    ...over
});

const triaged = (over: Partial<Triage> = {}): Triage => ({ kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'Fix batch()', doneWhen: ['test passes'] }, openIssue: false, reply: 'on it', why: '', ...over });

function board(over: Partial<RequestsBoard> = {}): RequestsBoard {
    return {
        project: SIGNALX,
        me: NOVA,
        member: true,
        manager: NOVA,
        policy: PM_POLICY_DEFAULT,
        requests: [request('req_1'), request('req_2', { state: 'accepted', resultItem: 14 }), request('req_3', { triage: triaged() }), request('req_4', { triage: triaged({ kind: 'duplicate', proposedItem: undefined as never }) })],
        ...over
    };
}

function fakeRequestsPort(state: RequestsBoard, targets: Record<string, RequestTarget> = {}) {
    const calls: { op: string; args: unknown; call: ToolCall }[] = [];
    const port: RequestsPort = {
        async board(call) {
            calls.push({ op: 'board', args: undefined, call });
            return state;
        },
        async target(projectId, call) {
            calls.push({ op: 'target', args: projectId, call });
            return targets[projectId] ?? null;
        },
        async triage(id, triage, call) {
            calls.push({ op: 'triage', args: { id, triage }, call });
            return { ...state.requests.find((r) => r.id === id)!, triage, state: triage.why ? 'needs-you' : 'triaging' };
        },
        async resolve(id, resolution: RequestResolution, call) {
            calls.push({ op: 'resolve', args: { id, resolution }, call });
            const r = state.requests.find((x) => x.id === id)!;
            if (resolution.action === 'accept') return { ...r, state: 'accepted', resultItem: 21 };
            if (resolution.action === 'decline') return { ...r, state: 'declined', declineReason: resolution.reason };
            return { ...r, state: 'asked-for-more' };
        },
        async send(input, call) {
            calls.push({ op: 'send', args: input, call });
            return request('req_new', { fromProject: state.project, toProject: input.toProject, title: input.title, state: 'triaging' });
        }
    };
    return { port, calls, ops: () => calls.map((c) => c.op) };
}

const tool = (port: RequestsPort | undefined, name: string) => requestTools(port).find((t) => t.name === name)!;
const run = async (port: RequestsPort | undefined, name: string, input: Record<string, unknown>) => (await tool(port, name).run(input as never, ctx())) as unknown as Record<string, unknown>;

describe('request tools', () => {
    it('are the four REQUEST_TOOLS on the platform roster, granted like any other tool', () => {
        expect(requestTools(undefined).map((t) => t.name)).toEqual([...REQUEST_TOOLS]);
        for (const n of REQUEST_TOOLS) expect(PLATFORM_TOOL_NAMES).toContain(n);
        const names = platformTools(fakePorts()).map((t) => t.name);
        expect(names.slice(names.indexOf('requests_list'), names.indexOf('requests_list') + 4)).toEqual([...REQUEST_TOOLS]);
        expect(grantedPlatformTools(fakePorts(), [{ name: 'projects_request' }, { name: 'requests_triage', mode: 'deny' }]).map((t) => t.name)).toEqual(['projects_request']);
        expect(tool(undefined, 'requests_list').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool(undefined, 'projects_request').annotations).toEqual({ readOnly: false, destructive: false });
    });

    it('report requests unavailable without a port', async () => {
        await expect(run(undefined, 'requests_list', {})).rejects.toThrow(/requests are not available/);
    });

    it('requests_list answers the inbox with refs in the text syntax, filtered by state', async () => {
        const fake = fakeRequestsPort(board());
        const all = await run(fake.port, 'requests_list', {});
        expect(all).toMatchObject({ project: SIGNALX, manager: true });
        expect((all.requests as unknown[]).length).toBe(4);
        const out = await run(fake.port, 'requests_list', { state: 'accepted' });
        expect(out.requests).toEqual([expect.objectContaining({ id: 'req_2', from: AGENTIC, sender: FORGE, refs: ['pr:604'], resultItem: 14 })]);
        await expect(run(fakeRequestsPort(board({ me: FORGE, member: false })).port, 'requests_list', {})).rejects.toThrow(/refused: you are not a member of project_signalx/);
    });

    it('triage and resolve are the manager’s: any other agent is refused without a write', async () => {
        const fake = fakeRequestsPort(board({ me: FORGE }));
        await expect(run(fake.port, 'requests_triage', { request: 'req_1', kind: 'bug', priority: 'low', proposedItem: { title: 'x', doneWhen: ['y'] }, reply: 'ok' })).rejects.toThrow(/refused: requests_triage is for this project's manager/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_3', action: 'accept' })).rejects.toThrow(/refused: requests_resolve is for this project's manager/);
        await expect(run(fakeRequestsPort(board({ manager: undefined })).port, 'requests_resolve', { request: 'req_3', action: 'accept' })).rejects.toThrow(/Ask a person/);
        expect(fake.ops()).toEqual(['board', 'board']);
    });

    it('requests_triage stores the triage and says when the policy lets the manager act alone', async () => {
        const fake = fakeRequestsPort(board());
        const out = await run(fake.port, 'requests_triage', { request: 'req_1', kind: 'bug', priority: 'normal', reproduced: { ok: true, note: 'fails on main' }, similar: [{ ref: 'signalx#9', note: 'different cause' }], proposedItem: { title: 'Fix batch()', phase: 2, doneWhen: ['nested batch test'] }, reply: 'Accepted as signalx#14' });
        expect(out).toMatchObject({ request: 'req_1', needsPerson: false });
        const sent = fake.calls.find((c) => c.op === 'triage')!.args as { id: string; triage: Triage };
        expect(sent.id).toBe('req_1');
        expect(sent.triage).toEqual({ kind: 'bug', priority: 'normal', reproduced: { ok: true, note: 'fails on main' }, similar: [{ ref: { kind: 'project-item', project: 'signalx', n: 9 }, note: 'different cause' }], proposedItem: { title: 'Fix batch()', phase: 2, doneWhen: ['nested batch test'] }, openIssue: false, reply: 'Accepted as signalx#14', why: '' });
    });

    it('requests_triage routes high priority and what the policy withholds to a person, with the why line', async () => {
        const fake = fakeRequestsPort(board());
        const out = await run(fake.port, 'requests_triage', { request: 'req_1', kind: 'bug', priority: 'high', proposedItem: { title: 'x', doneWhen: ['y'] }, openIssue: true, reply: 'ok' });
        expect(out).toMatchObject({ needsPerson: true, state: 'needs-you' });
        expect(out.why).toMatch(/high and urgent always come to a person/);
        expect(out.why).toMatch(/open GitHub issues/);
    });

    it('requests_triage refuses closed requests, unknown ids and incoherent triage', async () => {
        const fake = fakeRequestsPort(board());
        const base = { kind: 'bug', priority: 'low', proposedItem: { title: 'x', doneWhen: ['y'] }, reply: 'ok' };
        await expect(run(fake.port, 'requests_triage', { ...base, request: 'req_2' })).rejects.toThrow(/req_2 is already accepted/);
        await expect(run(fake.port, 'requests_triage', { ...base, request: 'req_9' })).rejects.toThrow(/not a request to this project. Try requests_list/);
        await expect(run(fake.port, 'requests_triage', { ...base, request: 'req_1', kind: 'duplicate' })).rejects.toThrow(/a duplicate adds no item/);
        await expect(run(fake.port, 'requests_triage', { request: 'req_1', kind: 'duplicate', priority: 'low', reply: 'ok' })).rejects.toThrow(/name the item it duplicates/);
        await expect(run(fake.port, 'requests_triage', { request: 'req_1', kind: 'feature', priority: 'low', reply: 'ok' })).rejects.toThrow(/propose the item/);
        await expect(run(fake.port, 'requests_triage', { request: 'req_1', kind: 'duplicate', priority: 'low', similar: [{ ref: 'not a ref at all' }], reply: 'ok' })).rejects.toThrow(/is not one ref/);
        expect(fake.ops()).not.toContain('triage');
    });

    it('requests_resolve accepts a triaged request the policy allows, and declines a duplicate with a reason', async () => {
        const fake = fakeRequestsPort(board());
        expect(await run(fake.port, 'requests_resolve', { request: 'req_3', action: 'accept' })).toEqual({ request: 'req_3', state: 'accepted', item: '#21' });
        expect(await run(fake.port, 'requests_resolve', { request: 'req_4', action: 'decline', reason: 'duplicate of #9' })).toEqual({ request: 'req_4', state: 'declined', declineReason: 'duplicate of #9' });
        expect(await run(fake.port, 'requests_resolve', { request: 'req_1', action: 'ask-for-more', question: 'which version?' })).toMatchObject({ state: 'asked-for-more' });
        expect(fake.calls.filter((c) => c.op === 'resolve').map((c) => c.args)).toEqual([
            { id: 'req_3', resolution: { action: 'accept' } },
            { id: 'req_4', resolution: { action: 'decline', reason: 'duplicate of #9' } },
            { id: 'req_1', resolution: { action: 'ask-for-more', question: 'which version?' } }
        ]);
    });

    it('requests_resolve refuses what a person decides, untriaged accepts, non-duplicate declines and missing text', async () => {
        const noAdd: PmPolicy = { ...PM_POLICY_DEFAULT, autonomy: { ...PM_POLICY_DEFAULT.autonomy, addItems: false } };
        const b = board({ requests: [...board().requests, request('req_5', { triage: triaged({ priority: 'urgent' }) })] });
        const fake = fakeRequestsPort(b);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_5', action: 'accept' })).rejects.toThrow(/req_5 needs a person: the priority/);
        await expect(run(fakeRequestsPort(board({ policy: noAdd })).port, 'requests_resolve', { request: 'req_3', action: 'accept' })).rejects.toThrow(/add items alone/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_1', action: 'accept' })).rejects.toThrow(/no triage yet/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_4', action: 'accept' })).rejects.toThrow(/triaged as a duplicate/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_3', action: 'decline', reason: 'no' })).rejects.toThrow(/only a person declines/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_4', action: 'decline' })).rejects.toThrow(/say why it is declined/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_1', action: 'ask-for-more' })).rejects.toThrow(/say what the sender should add/);
        await expect(run(fake.port, 'requests_resolve', { request: 'req_2', action: 'ask-for-more', question: 'q' })).rejects.toThrow(/already accepted/);
        expect(fake.ops()).not.toContain('resolve');
    });

    it('projects_request sends from the session’s project and reports what the target’s policy does with it', async () => {
        const allowAgentic: PmPolicy = { ...PM_POLICY_DEFAULT, senders: [{ project: AGENTIC, who: 'any-member', mode: 'allowed' }] };
        const targets = { [SIGNALX]: { project: SIGNALX, name: 'SignalX', policy: allowAgentic, hasManager: true }, project_zero: { project: 'project_zero' as ProjectId, name: 'Zero', policy: PM_POLICY_DEFAULT, hasManager: true } };
        const fake = fakeRequestsPort(board({ project: AGENTIC, me: FORGE, manager: undefined }), targets);
        const out = await run(fake.port, 'projects_request', { toProject: SIGNALX, title: 'batch() drops updates', body: 'repro in pr:604', refs: ['pr:604', 'src/batch.ts:10-12'] });
        expect(out).toMatchObject({ request: 'req_new', mode: 'allowed' });
        expect(out.note).toMatch(/SignalX's manager triages it/);
        expect(fake.calls.find((c) => c.op === 'send')!.args).toEqual({ toProject: SIGNALX, title: 'batch() drops updates', body: 'repro in pr:604', refs: [{ kind: 'pr', n: 604 }, { kind: 'file', path: 'src/batch.ts', from: 10, to: 12 }] });
        expect(await run(fake.port, 'projects_request', { toProject: 'project_zero', title: 't', body: 'b' })).toMatchObject({ mode: 'ask' });
    });

    it('projects_request refuses its own project, non-members, unknown targets, targets without a manager and bad refs', async () => {
        const targets = { project_bare: { project: 'project_bare' as ProjectId, policy: PM_POLICY_DEFAULT, hasManager: false } };
        const fake = fakeRequestsPort(board({ project: AGENTIC, me: FORGE }), targets);
        const base = { title: 't', body: 'b' };
        await expect(run(fake.port, 'projects_request', { ...base, toProject: AGENTIC })).rejects.toThrow(/that is this project/);
        await expect(run(fake.port, 'projects_request', { ...base, toProject: 'project_nope' })).rejects.toThrow(/no project "project_nope"/);
        await expect(run(fake.port, 'projects_request', { ...base, toProject: 'project_bare' })).rejects.toThrow(/has no project manager/);
        await expect(run(fake.port, 'projects_request', { ...base, toProject: SIGNALX, refs: ['???'] })).rejects.toThrow(/is not one ref/);
        await expect(run(fakeRequestsPort(board({ project: AGENTIC, me: FORGE, member: false }), targets).port, 'projects_request', { ...base, toProject: SIGNALX })).rejects.toThrow(/not a member/);
        expect(fake.ops()).not.toContain('send');
    });
});
