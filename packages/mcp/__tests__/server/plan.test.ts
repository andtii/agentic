/** The `plan` tool family on the orchestration surface (#751) over a fake Plan port: scope gate, argument mapping, ref parsing. */
import { PLAN_TOOLS, type PlanItem, type ProjectId, type Ref, type WorkspaceId } from '@agentic/core';
import { platformTools, scopeOfTool, type ExternalPrincipal, type PlatformPort } from '@agentic/mcp';
import type { PlanMcpPort } from '../../src/server/plan';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
const principal = (scopes: ExternalPrincipal['scopes']): ExternalPrincipal => ({ kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes });
const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });

function fakePlan() {
    const calls: { op: string; args: unknown[] }[] = [];
    const rec =
        <R>(op: string, answer: (...args: never[]) => R) =>
        async (...args: unknown[]) => {
            calls.push({ op, args });
            return answer(...(args as never[]));
        };
    const port: PlanMcpPort = {
        list: rec('list', () => [{ id: 'p1', projectId: 'project_agentic' as ProjectId, title: 'Plan', phases: [{ n: 1, title: 'One', items: [item(9)] }] }]) as PlanMcpPort['list'],
        next: rec('next', () => item(9)) as PlanMcpPort['next'],
        claim: rec('claim', () => item(9, { state: 'claimed' })) as PlanMcpPort['claim'],
        assign: rec('assign', () => item(9)) as PlanMcpPort['assign'],
        update: rec('update', () => item(9)) as PlanMcpPort['update'],
        ref: rec('ref', (_p: never, _i: never, ref: Ref) => (ref.kind === 'file' ? { ...ref, sha: '4f2a9c1' } : ref)) as PlanMcpPort['ref'],
        add: rec('add', () => [item(20, { title: 'A' })]) as PlanMcpPort['add'],
        handoff: rec('handoff', () => item(9)) as PlanMcpPort['handoff']
    };
    return { port, calls };
}

const toolsOf = (plan: PlanMcpPort | undefined, scopes: ExternalPrincipal['scopes'] = ['projects']) => {
    const p = principal(scopes);
    const tools = platformTools((plan ? { plan } : {}) as unknown as PlatformPort, p);
    return (name: string) => tools.find((t) => t.name === name)!;
};

describe('plan tools on the platform MCP surface', () => {
    it('declares the eight PLAN_TOOLS under the projects scope, with read/write annotations', () => {
        const tool = toolsOf(fakePlan().port);
        for (const name of PLAN_TOOLS) {
            expect(tool(name), name).toBeDefined();
            expect(scopeOfTool(name)).toBe('projects');
        }
        expect(tool('plan_list').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool('plan_next').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool('plan_claim').annotations).toEqual({ readOnly: false, destructive: false });
    });

    it('refuses a client without the projects scope; a host without plans declares none of the tools', async () => {
        await expect(toolsOf(fakePlan().port, ['machines'])('plan_list').run({ projectId: 'project_agentic' }, ctx)).rejects.toThrow(/"projects" scope/);
        for (const name of PLAN_TOOLS) expect(toolsOf(undefined)(name)).toBeUndefined();
    });

    it('maps each call onto the port: no lease asked (the project’s applies), bare handles, only the fields given', async () => {
        const fake = fakePlan();
        const tool = toolsOf(fake.port);
        expect(await tool('plan_list').run({ projectId: 'project_agentic' }, ctx)).toMatchObject({ plans: [{ id: 'p1' }] });
        expect(await tool('plan_next').run({ projectId: 'project_agentic', agentId: 'agent_forge' }, ctx)).toMatchObject({ item: { id: 9 } });
        await tool('plan_claim').run({ projectId: 'project_agentic', item: 9, agentId: 'agent_forge' }, ctx);
        await tool('plan_claim').run({ projectId: 'project_agentic', item: 9, agentId: 'agent_forge', leaseMinutes: 10 }, ctx);
        await tool('plan_assign').run({ projectId: 'project_agentic', item: 11, to: '@lint', index: 0 }, ctx);
        await tool('plan_update').run({ projectId: 'project_agentic', item: 9, check: [0], state: 'done' }, ctx);
        expect(await tool('plan_add').run({ projectId: 'project_agentic', items: [{ title: 'A' }], split: 11 }, ctx)).toEqual({ added: [{ id: 20, title: 'A' }] });
        await tool('plan_handoff').run({ projectId: 'project_agentic', item: 9, note: 'done here' }, ctx);
        expect(fake.calls).toEqual([
            { op: 'list', args: ['project_agentic', undefined] },
            { op: 'next', args: ['project_agentic', 'agent_forge', undefined] },
            { op: 'claim', args: ['project_agentic', 9, 'agent_forge', undefined] },
            { op: 'claim', args: ['project_agentic', 9, 'agent_forge', 10 * 60_000] },
            { op: 'assign', args: ['project_agentic', 11, 'lint', 0] },
            { op: 'update', args: ['project_agentic', 9, { check: [0], state: 'done' }] },
            { op: 'add', args: ['project_agentic', { items: [{ title: 'A' }], split: 11 }] },
            { op: 'handoff', args: ['project_agentic', 9, undefined, 'done here'] }
        ]);
    });

    it('plan_update needs a change; plan_ref parses the shared syntax and refuses what is not one ref', async () => {
        const fake = fakePlan();
        const tool = toolsOf(fake.port);
        await expect(tool('plan_update').run({ projectId: 'project_agentic', item: 9 }, ctx)).rejects.toThrow(/nothing to change on #9/);
        expect(await tool('plan_ref').run({ projectId: 'project_agentic', item: 9, ref: 'src/a.ts:3-4' }, ctx)).toEqual({ item: 9, ref: 'src/a.ts:3-4@4f2a9c1' });
        await expect(tool('plan_ref').run({ projectId: 'project_agentic', item: 9, ref: 'not a ref' }, ctx)).rejects.toThrow(/is not one ref/);
        expect(fake.calls.map((c) => c.op)).toEqual(['ref']);
    });
});
