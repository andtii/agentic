/** `plan_update` takes `after` (#931): the project manager replaces what an item waits on, `project#n` included. */
import type { ToolContext } from '@sigx/ai';
import type { AgentId, PlanItem, ProjectId } from '@agentic/core';
import { planTools, planUpdateInput, type PlanBoard, type PlanPort, type PlanUpdateInput } from '../../src/index';

const ATLAS = 'agent_atlas' as AgentId;
const LINT = 'agent_lint' as AgentId;
const ctx: ToolContext = { toolCallId: 'call_1', signal: new AbortController().signal };
const item = (over: Partial<PlanItem> = {}): PlanItem => ({ id: 16, title: 'Use batch()', state: 'ready', after: [], touches: [], refs: [], doneWhen: [{ text: 'works', checked: false }], activity: [], ...over });
const boardOf = (me: AgentId): PlanBoard => ({
    plans: [{ id: 'p1', projectId: 'prj_agentic' as ProjectId, title: 'P', phases: [{ n: 1, title: 'One', items: [item()] }] }],
    members: [{ actor: { kind: 'agent', agentId: ATLAS }, handle: 'atlas' }, { actor: { kind: 'agent', agentId: LINT }, handle: 'lint' }],
    me,
    manager: ATLAS,
    limit: 1
});

function portFor(me: AgentId, withAfter = true) {
    const afters: (readonly (number | string)[])[] = [];
    const updates: PlanUpdateInput[] = [];
    const port = {
        board: async () => boardOf(me),
        update: async (input: PlanUpdateInput) => {
            updates.push(input);
            return item({ after: [3], afterRefs: [{ projectId: 'prj_sx', n: 14 }] } as Partial<PlanItem>);
        },
        ...(withAfter
            ? {
                  after: async (_n: number, after: readonly (number | string)[]) => {
                      afters.push(after);
                      return item({ state: 'blocked', after: [3], afterRefs: [{ projectId: 'prj_sx', n: 14 }] } as Partial<PlanItem>);
                  }
              }
            : {})
    } as unknown as PlanPort;
    return { tool: planTools(port).find((t) => t.name === 'plan_update')!, afters, updates };
}

describe('plan_update: after', () => {
    it('accepts numbers, #n and project#n; [] clears', () => {
        expect(planUpdateInput.parse({ item: 16, after: [3, '#4', 'signalx#14'] }).after).toEqual([3, '#4', 'signalx#14']);
        expect(planUpdateInput.parse({ item: 16, after: [] }).after).toEqual([]);
        expect(() => planUpdateInput.parse({ item: 16, after: [0] })).toThrow();
    });

    it('the manager sets it through the port, as written; alone it answers the new waits', async () => {
        const { tool, afters, updates } = portFor(ATLAS);
        expect(await tool.run({ item: 16, after: [3, 'signalx#14'] }, ctx)).toEqual({ item: 16, state: 'blocked', after: ['#3', 'prj_sx#14'] });
        expect(afters).toEqual([[3, 'signalx#14']]);
        expect(updates).toEqual([]);
    });

    it('with a note too: after first, then the patch', async () => {
        const { tool, afters, updates } = portFor(ATLAS);
        expect(await tool.run({ item: 16, after: ['signalx#14'], note: 'waits on the fix' }, ctx)).toMatchObject({ item: 16, after: ['#3', 'prj_sx#14'] });
        expect(afters).toHaveLength(1);
        expect(updates).toEqual([{ item: 16, note: 'waits on the fix' }]);
    });

    it('refuses another agent, and a host without the port method', async () => {
        await expect(portFor(LINT).tool.run({ item: 16, after: ['signalx#14'] }, ctx)).rejects.toThrow(/refused: plan_update with after is for the project manager/);
        await expect(portFor(ATLAS, false).tool.run({ item: 16, after: ['signalx#14'] }, ctx)).rejects.toThrow(/refused: changing what an item waits on is not available here/);
    });
});
