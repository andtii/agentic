/** `plan_add` takes `project#n` in `after` (#822; PRJ-17): the tool hands it to the port as written; the actor resolves it. */
import type { ToolContext } from '@sigx/ai';
import type { AgentId, PlanItem, ProjectId } from '@agentic/core';
import { planAddInput, planTools, type PlanAddInput, type PlanBoard, type PlanPort } from '../../src/index';

const ATLAS = 'agent_atlas' as AgentId;
const ctx: ToolContext = { toolCallId: 'call_1', signal: new AbortController().signal };
const board: PlanBoard = {
    plans: [{ id: 'p1', projectId: 'prj_agentic' as ProjectId, title: 'P', phases: [{ n: 1, title: 'One', items: [] }] }],
    members: [{ actor: { kind: 'agent', agentId: ATLAS }, handle: 'atlas' }],
    me: ATLAS,
    manager: ATLAS,
    limit: 1
};

describe('plan_add: cross-project after', () => {
    it('accepts numbers, #n and project#n', () => {
        expect(planAddInput.parse({ items: [{ title: 'x', after: [3, '#4', 'signalx#14'] }] }).items[0]!.after).toEqual([3, '#4', 'signalx#14']);
        expect(() => planAddInput.parse({ items: [{ title: 'x', after: [0] }] })).toThrow();
        expect(() => planAddInput.parse({ items: [{ title: 'x', after: [''] }] })).toThrow();
    });

    it('passes after to the port as written', async () => {
        const added: PlanAddInput[] = [];
        const port = {
            board: async () => board,
            add: async (input: PlanAddInput) => {
                added.push(input);
                return [{ id: 1, title: 'x', state: 'blocked', after: [], touches: [], refs: [], doneWhen: [], activity: [] } satisfies PlanItem];
            }
        } as unknown as PlanPort;
        const add = planTools(port).find((t) => t.name === 'plan_add')!;
        expect(await add.run({ items: [{ title: 'x', after: ['signalx#14', 2] }] }, ctx)).toEqual({ added: [{ id: 1, title: 'x' }] });
        expect(added[0]!.items[0]!.after).toEqual(['signalx#14', 2]);
    });
});
