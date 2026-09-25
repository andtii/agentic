/** `plan_add` on the platform MCP surface takes a cross-project `after` (`project#n`), as the runtimes tool does (#881). */
import type { PlanItem, ProjectId, WorkspaceId } from '@agentic/core';
import { platformTools, type ExternalPrincipal, type PlatformPort } from '@agentic/mcp';
import type { PlanMcpAdd, PlanMcpPort } from '../../src/server/plan';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['projects'] };
const item = (id: number, title: string): PlanItem => ({ id, title, state: 'blocked', after: [], touches: [], refs: [], doneWhen: [], activity: [] });

function planAdd() {
    const added: { projectId: ProjectId; input: PlanMcpAdd }[] = [];
    const none = async (): Promise<never> => {
        throw new Error('not called');
    };
    const plan: PlanMcpPort = {
        list: none,
        next: none,
        claim: none,
        assign: none,
        update: none,
        ref: none,
        handoff: none,
        add: async (projectId, input) => {
            added.push({ projectId, input });
            return input.items.map((i, k) => item(20 + k, i.title));
        }
    };
    const tool = platformTools({ plan } as unknown as PlatformPort, principal).find((t) => t.name === 'plan_add')!;
    return { tool, added };
}

/** Whether the tool's input schema takes `args` (Standard Schema). */
const valid = async (schema: { readonly '~standard': { validate(v: unknown): unknown } }, args: unknown): Promise<boolean> => !((await schema['~standard'].validate(args)) as { issues?: unknown }).issues;

describe('plan_add with a cross-project after', () => {
    it('accepts project#n beside local numbers and hands them to the port as written', async () => {
        const { tool, added } = planAdd();
        const args = { projectId: 'project_agentic', items: [{ title: 'Bump SignalX', after: [3, 'signalx#14', 'docs.site#2', '#5'] }] };
        expect(await valid(tool.input, args)).toBe(true);
        expect(await tool.run(args, ctx)).toEqual({ added: [{ id: 20, title: 'Bump SignalX' }] });
        expect(added).toEqual([{ projectId: 'project_agentic', input: { items: [{ title: 'Bump SignalX', after: [3, 'signalx#14', 'docs.site#2', '#5'] }] } }]);
    });

    it('refuses an after entry that is neither an item number nor project#n', async () => {
        const { tool } = planAdd();
        for (const bad of ['signalx', 'signalx#', 'signalx#x', 'a b#1', 'signalx#0', '#0', 0]) {
            expect(await valid(tool.input, { projectId: 'project_agentic', items: [{ title: 'A', after: [bad] }] }), String(bad)).toBe(false);
        }
    });
});
