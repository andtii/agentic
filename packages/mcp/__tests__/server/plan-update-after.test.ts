/** `plan_update` on the platform MCP surface takes `after` (#931), `project#n` included, through `PlanMcpPort.after`. */
import type { PlanItem, ProjectId, WorkspaceId } from '@agentic/core';
import { platformTools, type ExternalPrincipal, type PlatformPort } from '@agentic/mcp';
import type { PlanMcpPort, PlanMcpUpdate } from '../../src/server/plan';

const ctx = { signal: new AbortController().signal, toolCallId: 'c1' };
const principal: ExternalPrincipal = { kind: 'external', workspaceId: 'gh_1' as WorkspaceId, clientId: 'oac_x', scopes: ['projects'] };
const item = (state: PlanItem['state']): PlanItem => ({ id: 16, title: 'Use batch()', state, after: [], touches: [], refs: [], doneWhen: [], activity: [] });

function planUpdate(withAfter = true) {
    const calls: unknown[] = [];
    const none = async (): Promise<never> => {
        throw new Error('not called');
    };
    const plan: PlanMcpPort = {
        list: none,
        next: none,
        claim: none,
        assign: none,
        ref: none,
        add: none,
        handoff: none,
        update: async (projectId: ProjectId, n: number, update: PlanMcpUpdate) => {
            calls.push(['update', projectId, n, update]);
            return item('ready');
        },
        ...(withAfter
            ? {
                  after: async (projectId: ProjectId, n: number, after: readonly (number | string)[]) => {
                      calls.push(['after', projectId, n, after]);
                      return item('blocked');
                  }
              }
            : {})
    };
    const tool = platformTools({ plan } as unknown as PlatformPort, principal).find((t) => t.name === 'plan_update')!;
    return { tool, calls };
}

const valid = async (schema: { readonly '~standard': { validate(v: unknown): unknown } }, args: unknown): Promise<boolean> => !((await schema['~standard'].validate(args)) as { issues?: unknown }).issues;

describe('plan_update with after', () => {
    it('hands after to the port as written; alone it answers the item', async () => {
        const { tool, calls } = planUpdate();
        const args = { projectId: 'prj_ag', item: 16, after: [3, 'signalx#14'] };
        expect(await valid(tool.input, args)).toBe(true);
        expect(await tool.run(args, ctx)).toMatchObject({ id: 16, state: 'blocked' });
        expect(calls).toEqual([['after', 'prj_ag', 16, [3, 'signalx#14']]]);
    });

    it('after and a note: both, after first', async () => {
        const { tool, calls } = planUpdate();
        await tool.run({ projectId: 'prj_ag', item: 16, after: ['signalx#14'], note: 'n' }, ctx);
        expect(calls.map((c) => (c as unknown[])[0])).toEqual(['after', 'update']);
    });

    it('refuses a bad entry, and a host without after', async () => {
        const { tool } = planUpdate();
        expect(await valid(tool.input, { projectId: 'prj_ag', item: 16, after: ['signalx'] })).toBe(false);
        await expect(planUpdate(false).tool.run({ projectId: 'prj_ag', item: 16, after: ['signalx#14'] }, ctx)).rejects.toThrow(/not available/);
    });
});
