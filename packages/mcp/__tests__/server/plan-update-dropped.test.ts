/** `plan_update` on the platform MCP surface drops an item (#1065, #1041): a note, an optional `supersededBy`, and what to relink. */
import type { Plan, PlanItem, ProjectId, WorkspaceId } from '@agentic/core';
import { platformTools, type ExternalPrincipal, type PlatformPort } from '@agentic/mcp';
import type { PlanMcpPort, PlanMcpUpdate } from '../../src/server/plan';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['projects'] };
const item = (id: number, state: PlanItem['state'], after: number[] = []): PlanItem => ({ id, title: `Item ${id}`, state, after, touches: [], refs: [], doneWhen: [], activity: [] });

function planUpdate(others: PlanItem[] = []) {
    const calls: unknown[] = [];
    const none = async (): Promise<never> => {
        throw new Error('not called');
    };
    const plan: PlanMcpPort = {
        next: none,
        claim: none,
        assign: none,
        ref: none,
        add: none,
        handoff: none,
        list: async (): Promise<readonly Plan[]> => [{ id: 'p1', projectId: 'prj_ag' as ProjectId, title: 'Plan', phases: [{ n: 1, title: 'One', items: [item(16, 'dropped'), ...others] }] }],
        update: async (projectId: ProjectId, n: number, update: PlanMcpUpdate) => {
            calls.push(['update', projectId, n, update]);
            return item(n, update.state === 'dropped' ? 'dropped' : 'ready');
        }
    };
    const tool = platformTools({ plan } as unknown as PlatformPort, principal).find((t) => t.name === 'plan_update')!;
    return { tool, calls };
}

const valid = async (schema: { readonly '~standard': { validate(v: unknown): unknown } }, args: unknown): Promise<boolean> => !((await schema['~standard'].validate(args)) as { issues?: unknown }).issues;

describe('plan_update with state dropped', () => {
    it('reaches the port with the note and supersededBy', async () => {
        const { tool, calls } = planUpdate();
        const args = { projectId: 'prj_ag', item: 16, state: 'dropped', note: 'superseded by #20', supersededBy: 20 };
        expect(await valid(tool.input, args)).toBe(true);
        expect(await tool.run(args, ctx)).toMatchObject({ id: 16, state: 'dropped' });
        expect(calls).toEqual([['update', 'prj_ag', 16, { note: 'superseded by #20', state: 'dropped', supersededBy: 20 }]]);
    });

    it('names the open items that wait on the dropped one', async () => {
        const { tool } = planUpdate([item(17, 'blocked', [16]), item(18, 'done', [16]), item(19, 'blocked', [3])]);
        const out = (await tool.run({ projectId: 'prj_ag', item: 16, state: 'dropped', note: 'no longer wanted' }, ctx)) as { relink?: string };
        expect(out.relink).toBe('#17 waits on #16 and stays blocked: set their after with plan_update.');
    });

    it('needs a note, and supersededBy only goes with dropped', async () => {
        const { tool, calls } = planUpdate();
        await expect(tool.run({ projectId: 'prj_ag', item: 16, state: 'dropped' }, ctx)).rejects.toThrow(/pass a note/);
        await expect(tool.run({ projectId: 'prj_ag', item: 16, state: 'ready', supersededBy: 20 }, ctx)).rejects.toThrow(/supersededBy goes with state dropped/);
        expect(await valid(tool.input, { projectId: 'prj_ag', item: 16, state: 'dropped', note: 'n', supersededBy: 0 })).toBe(false);
        expect(calls).toEqual([]);
    });
});
