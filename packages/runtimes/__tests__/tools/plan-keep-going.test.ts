/** Finishing an item is not the end of the turn (#981): `plan_update` answers a done item with "keep working the queue". */
import type { ToolContext } from '@sigx/ai';
import type { AgentId, PlanItem, ProjectId } from '@agentic/core';
import { planTools, type PlanBoard, type PlanPort, type PlanUpdateInput } from '../../src/index';
import { PLAN_KEEP_GOING } from '../../src/tools/plan';

const FORGE = 'agent_forge' as AgentId;
const ctx: ToolContext = { toolCallId: 'call_1', signal: new AbortController().signal };
const item = (over: Partial<PlanItem> = {}): PlanItem => ({ id: 3, title: 'Reconnect', state: 'claimed', after: [], touches: [], refs: [], doneWhen: [{ text: 'a', checked: false }, { text: 'b', checked: false }], activity: [], ...over });
const board: PlanBoard = {
    plans: [{ id: 'p1', projectId: 'prj_agentic' as ProjectId, title: 'P', phases: [{ n: 1, title: 'One', items: [item({ assignee: { kind: 'agent', agentId: FORGE }, claim: { agentId: FORGE, leaseUntil: Date.now() + 60_000 } })] }] }],
    members: [{ actor: { kind: 'agent', agentId: FORGE }, handle: 'forge' }],
    me: FORGE,
    limit: 1
};

function updateTool() {
    const port = {
        board: async () => board,
        update: async (input: PlanUpdateInput) => {
            const checked = (k: number) => !!input.check?.includes(k);
            const doneWhen = [0, 1].map((k) => ({ text: k ? 'b' : 'a', checked: checked(k) }));
            return item({ doneWhen, state: doneWhen.every((d) => d.checked) ? 'done' : 'claimed' });
        }
    } as unknown as PlanPort;
    return planTools(port).find((t) => t.name === 'plan_update')!;
}

describe('plan_update: keep going', () => {
    it('a done item answers with the next step: plan_next until it returns nothing, then one status', async () => {
        const out = (await updateTool().run({ item: 3, check: [0, 1] }, ctx)) as Record<string, unknown>;
        expect(out).toMatchObject({ state: 'done', next: PLAN_KEEP_GOING });
        expect(PLAN_KEEP_GOING).toMatch(/plan_next.*returns nothing.*post one status/);
    });

    it('an item still open answers no next step', async () => {
        const out = (await updateTool().run({ item: 3, check: [0] }, ctx)) as Record<string, unknown>;
        expect(out).not.toHaveProperty('next');
    });
});

describe('plan_next: nothing ready', () => {
    it('asks for one status', async () => {
        const port = { board: async () => ({ ...board, plans: [] }) } as unknown as PlanPort;
        const out = (await planTools(port).find((t) => t.name === 'plan_next')!.run({}, ctx)) as { item: null; note: string };
        expect(out.item).toBeNull();
        expect(out.note).toMatch(/Post one status/);
    });
});
