/** `plan_update` drops an item (#1041): the project manager, with a note, optionally naming what supersedes it. */
import type { ToolContext } from '@sigx/ai';
import type { AgentId, PlanItem, ProjectId } from '@agentic/core';
import { planTools, planUpdateInput, type PlanBoard, type PlanPort, type PlanUpdateInput } from '../../src/index';

const ATLAS = 'agent_atlas' as AgentId;
const LINT = 'agent_lint' as AgentId;
const ctx: ToolContext = { toolCallId: 'call_1', signal: new AbortController().signal };
const item = (over: Partial<PlanItem> = {}): PlanItem => ({ id: 9, title: 'First cut', state: 'stuck', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });
const boardOf = (me: AgentId): PlanBoard => ({
    plans: [{ id: 'p1', projectId: 'prj_agentic' as ProjectId, title: 'P', phases: [{ n: 1, title: 'One', items: [item(), item({ id: 12, title: 'Uses it', state: 'blocked', after: [9] }), item({ id: 18, title: 'Second cut', state: 'ready' })] }] }],
    members: [{ actor: { kind: 'agent', agentId: ATLAS }, handle: 'atlas' }, { actor: { kind: 'agent', agentId: LINT }, handle: 'lint' }],
    me,
    manager: ATLAS,
    limit: 1
});

function portFor(me: AgentId) {
    const updates: PlanUpdateInput[] = [];
    const port = {
        board: async () => boardOf(me),
        update: async (input: PlanUpdateInput) => {
            updates.push(input);
            return item({ state: 'dropped', dropped: { by: { kind: 'agent', agentId: ATLAS }, at: 1, note: input.note, supersededBy: input.supersededBy } });
        }
    } as unknown as PlanPort;
    return { tool: planTools(port).find((t) => t.name === 'plan_update')!, updates };
}

describe('plan_update: dropped (#1041)', () => {
    it('accepts dropped and supersededBy', () => {
        expect(planUpdateInput.parse({ item: 9, state: 'dropped', note: 'replaced', supersededBy: 18 })).toEqual({ item: 9, state: 'dropped', note: 'replaced', supersededBy: 18 });
    });

    it('the manager drops with a note; the answer names what waits on it to relink', async () => {
        const { tool, updates } = portFor(ATLAS);
        expect(await tool.run({ item: 9, state: 'dropped', note: 'replaced by #18', supersededBy: 18 }, ctx)).toMatchObject({ item: 9, state: 'dropped', relink: expect.stringContaining('#12 waits on #9') });
        expect(updates).toEqual([{ item: 9, note: 'replaced by #18', state: 'dropped', supersededBy: 18 }]);
    });

    it('refuses another agent, a drop without a note, supersededBy alone, and an unknown replacement', async () => {
        await expect(portFor(LINT).tool.run({ item: 9, state: 'dropped', note: 'meh' }, ctx)).rejects.toThrow(/refused: dropping an item is for the project manager/);
        await expect(portFor(ATLAS).tool.run({ item: 9, state: 'dropped' }, ctx)).rejects.toThrow(/refused: say why #9 is dropped/);
        await expect(portFor(ATLAS).tool.run({ item: 9, supersededBy: 18, note: 'x' }, ctx)).rejects.toThrow(/refused: supersededBy goes with state dropped/);
        await expect(portFor(ATLAS).tool.run({ item: 9, state: 'dropped', note: 'x', supersededBy: 99 }, ctx)).rejects.toThrow(/refused: #99 is not an item/);
    });

    it('plan_list shows a dropped item with who dropped it and why', async () => {
        const board = boardOf(ATLAS);
        const dropped = item({ id: 7, title: 'Old', state: 'dropped', dropped: { by: { kind: 'agent', agentId: ATLAS }, at: 1, note: 'superseded', supersededBy: 18 } });
        const port = { board: async () => ({ ...board, plans: [{ ...board.plans[0]!, phases: [{ n: 1, title: 'One', items: [dropped] }] }] }) } as unknown as PlanPort;
        const list = planTools(port).find((t) => t.name === 'plan_list')!;
        const out = (await list.run({ state: 'dropped' }, ctx)) as { items: { id: number; dropped?: unknown }[] };
        expect(out.items).toMatchObject([{ id: 7, dropped: { by: '@atlas', note: 'superseded', supersededBy: 18 } }]);
    });
});
