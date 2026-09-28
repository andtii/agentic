/**
 * A task carries one plan item (#1047): from a task whose item is claimed, `plan_claim` refuses a second item without
 * calling the actor, and `plan_next` points back at the task's own item. A second item beside the first must be
 * independent of it (touches named and disjoint).
 */
import type { ToolContext } from '@sigx/ai';
import type { AgentId, PlanItem, ProjectId, TaskId } from '@agentic/core';
import { planTools, type PlanBoard, type PlanPort } from '../../src/index';

const FORGE = 'agent_forge' as AgentId;
const TASK = 'task_a' as TaskId;
const LATER = Date.now() + 60 * 60_000;
const ctx: ToolContext = { toolCallId: 'call_1', signal: new AbortController().signal };
const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `item ${id}`, state: 'ready', after: [], touches: [`src/${id}/`], refs: [], doneWhen: [], activity: [], ...over });
const mine = (id: number, taskId?: TaskId, over: Partial<PlanItem> = {}): PlanItem => item(id, { state: 'claimed', assignee: { kind: 'agent', agentId: FORGE }, claim: { agentId: FORGE, leaseUntil: LATER, ...(taskId ? { taskId } : {}) }, ...over });

function board(items: PlanItem[], over: Partial<PlanBoard> = {}): PlanBoard {
    return { plans: [{ id: 'p1', projectId: 'prj_1' as ProjectId, title: 'P', phases: [{ n: 1, title: 'One', items }] }], members: [{ actor: { kind: 'agent', agentId: FORGE }, handle: 'forge' }], me: FORGE, limit: 3, ...over };
}

function tools(b: PlanBoard) {
    const calls: number[] = [];
    const port = {
        board: async () => b,
        claim: async (n: number) => {
            calls.push(n);
            return mine(n);
        }
    } as unknown as PlanPort;
    const all = planTools(port);
    return { claim: all.find((t) => t.name === 'plan_claim')!, next: all.find((t) => t.name === 'plan_next')!, calls };
}

describe('a task carries one plan item (#1047)', () => {
    it('plan_claim from a task that carries an item refuses a second one without calling the actor', async () => {
        const t = tools(board([mine(1, TASK), item(2)], { task: TASK }));
        await expect(t.claim.run({ item: 2 }, ctx)).rejects.toThrow(/refused: this task already carries #1, and a task carries one item/);
        expect(t.calls).toEqual([]);
        // Its own item renews.
        await t.claim.run({ item: 1 }, ctx);
        expect(t.calls).toEqual([1]);
    });

    it('from a task carrying nothing, or outside a task, a second independent item is claimed', async () => {
        for (const over of [{ task: 'task_b' as TaskId }, {}]) {
            const t = tools(board([mine(1, TASK), item(2)], over));
            await t.claim.run({ item: 2 }, ctx);
            expect(t.calls).toEqual([2]);
        }
    });

    it('a second item must be independent: overlapping touches, or none, are refused', async () => {
        const overlap = tools(board([mine(1), item(2, { touches: ['src/1/deep.ts'] })]));
        await expect(overlap.claim.run({ item: 2 }, ctx)).rejects.toThrow(/refused: #2 touches src\/1\/deep\.ts, as #1 does/);
        const none = tools(board([mine(1), item(2, { touches: [] })]));
        await expect(none.claim.run({ item: 2 }, ctx)).rejects.toThrow(/refused: #2 names no touches, so it runs alone/);
        const alone = tools(board([mine(1, undefined, { touches: [] }), item(2)]));
        await expect(alone.claim.run({ item: 2 }, ctx)).rejects.toThrow(/refused: #1 names no touches, so it runs alone/);
    });

    it('plan_next from a task that carries an item answers that item', async () => {
        const t = tools(board([mine(1, TASK), item(2)], { task: TASK }));
        const out = (await t.next.run({}, ctx)) as { item: { id: number }; from: string };
        expect(out).toMatchObject({ item: { id: 1 }, from: 'this task' });
        const free = tools(board([mine(1, TASK), item(2)]));
        expect(((await free.next.run({}, ctx)) as { item: { id: number } }).item.id).toBe(2);
    });
});
