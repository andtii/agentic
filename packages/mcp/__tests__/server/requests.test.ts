/** The `requests` tool family on the orchestration surface (#759) over a fake Requests port: scope gate, argument mapping, ref parsing. */
import { REQUEST_TOOLS, type ProjectId, type ProjectRequest, type WorkspaceId } from '@agentic/core';
import { platformTools, scopeOfTool, type ExternalPrincipal, type PlatformPort } from '@agentic/mcp';
import type { RequestsMcpPort } from '../../src/server/requests';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
const principal = (scopes: ExternalPrincipal['scopes']): ExternalPrincipal => ({ kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes });
const req = (over: Partial<ProjectRequest> = {}): ProjectRequest => ({
    id: 'req_1',
    fromProject: 'project_agentic' as ProjectId,
    sender: { kind: 'user', userId: 'u1' },
    toProject: 'project_signalx' as ProjectId,
    title: 't',
    body: 'b',
    refs: [],
    state: 'triaging',
    createdAt: 1,
    updatedAt: 1,
    ...over
});

function fakeRequests() {
    const calls: { op: string; args: unknown[] }[] = [];
    const rec =
        (op: string, answer: () => unknown) =>
        async (...args: unknown[]) => {
            calls.push({ op, args });
            return answer();
        };
    const port: RequestsMcpPort = {
        list: rec('list', () => [req()]) as RequestsMcpPort['list'],
        triage: rec('triage', () => req()) as RequestsMcpPort['triage'],
        resolve: rec('resolve', () => req({ state: 'accepted', resultItem: 14 })) as RequestsMcpPort['resolve'],
        send: rec('send', () => req({ id: 'req_new' })) as RequestsMcpPort['send']
    };
    return { port, calls };
}

const toolsOf = (requests: RequestsMcpPort | undefined, scopes: ExternalPrincipal['scopes'] = ['projects']) => {
    const tools = platformTools((requests ? { requests } : {}) as unknown as PlatformPort, principal(scopes));
    return (name: string) => tools.find((t) => t.name === name)!;
};

describe('request tools on the platform MCP surface', () => {
    it('declares the four REQUEST_TOOLS under the projects scope, with read/write annotations', () => {
        const tool = toolsOf(fakeRequests().port);
        for (const name of REQUEST_TOOLS) {
            expect(tool(name), name).toBeDefined();
            expect(scopeOfTool(name)).toBe('projects');
        }
        expect(tool('requests_list').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool('requests_resolve').annotations).toEqual({ readOnly: false, destructive: false });
    });

    it('refuses a client without the projects scope; a host without requests declares none of the tools', async () => {
        await expect(toolsOf(fakeRequests().port, ['machines'])('requests_list').run({ projectId: 'project_signalx' }, ctx)).rejects.toThrow(/"projects" scope/);
        for (const name of REQUEST_TOOLS) expect(toolsOf(undefined)(name)).toBeUndefined();
    });

    it('maps each call onto the port: parsed refs, only the fields given, the resolution by action', async () => {
        const fake = fakeRequests();
        const tool = toolsOf(fake.port);
        expect(await tool('requests_list').run({ projectId: 'project_signalx', state: 'needs-you' }, ctx)).toMatchObject({ requests: [{ id: 'req_1' }] });
        await tool('requests_triage').run({ projectId: 'project_signalx', request: 'req_1', kind: 'bug', priority: 'high', similar: [{ ref: '#9' }], proposedItem: { title: 'Fix', doneWhen: ['test'], assignee: { kind: 'agent', agentId: 'agent_forge' } }, reply: 'ok' }, ctx);
        await tool('requests_resolve').run({ projectId: 'project_signalx', request: 'req_1', action: 'accept' }, ctx);
        await tool('requests_resolve').run({ projectId: 'project_signalx', request: 'req_1', action: 'decline', reason: 'out of scope' }, ctx);
        await tool('requests_resolve').run({ projectId: 'project_signalx', request: 'req_1', action: 'ask-for-more', question: 'which version?' }, ctx);
        await tool('projects_request').run({ fromProject: 'project_agentic', fromChat: 'chat_1', toProject: 'project_signalx', title: 't', body: 'b', refs: ['pr:604'] }, ctx);
        expect(fake.calls).toEqual([
            { op: 'list', args: ['project_signalx', 'needs-you'] },
            {
                op: 'triage',
                args: ['project_signalx', 'req_1', { kind: 'bug', priority: 'high', similar: [{ ref: { kind: 'item', n: 9 } }], proposedItem: { title: 'Fix', doneWhen: ['test'], assignee: { kind: 'agent', agentId: 'agent_forge' } }, openIssue: false, reply: 'ok', why: '' }]
            },
            { op: 'resolve', args: ['project_signalx', 'req_1', { action: 'accept' }] },
            { op: 'resolve', args: ['project_signalx', 'req_1', { action: 'decline', reason: 'out of scope' }] },
            { op: 'resolve', args: ['project_signalx', 'req_1', { action: 'ask-for-more', question: 'which version?' }] },
            { op: 'send', args: [{ fromProject: 'project_agentic', fromChat: 'chat_1', toProject: 'project_signalx', title: 't', body: 'b', refs: [{ kind: 'pr', n: 604 }] }] }
        ]);
    });

    it('refuses missing reason or question, a duplicate with an item, a request to the same project and bad refs — without calling the port', async () => {
        const fake = fakeRequests();
        const tool = toolsOf(fake.port);
        await expect(tool('requests_resolve').run({ projectId: 'p', request: 'req_1', action: 'decline' }, ctx)).rejects.toThrow(/decline needs a reason/);
        await expect(tool('requests_resolve').run({ projectId: 'p', request: 'req_1', action: 'ask-for-more' }, ctx)).rejects.toThrow(/needs the question/);
        await expect(tool('requests_triage').run({ projectId: 'p', request: 'req_1', kind: 'duplicate', priority: 'low', proposedItem: { title: 'x', doneWhen: ['y'] }, reply: 'r' }, ctx)).rejects.toThrow(/a duplicate adds no item/);
        await expect(tool('requests_triage').run({ projectId: 'p', request: 'req_1', kind: 'duplicate', priority: 'low', similar: [{ ref: '???' }], reply: 'r' }, ctx)).rejects.toThrow(/is not one ref/);
        await expect(tool('projects_request').run({ fromProject: 'p', toProject: 'p', title: 't', body: 'b' }, ctx)).rejects.toThrow(/another project/);
        await expect(tool('projects_request').run({ fromProject: 'p', toProject: 'q', title: 't', body: 'b', refs: ['???'] }, ctx)).rejects.toThrow(/is not one ref/);
        expect(fake.calls).toEqual([]);
    });
});
