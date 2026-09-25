/** The `plan` tool family (#751) over a fake Plan port: roster, next, claim refusals, people-only tools, update, ref, handoff. */
import type { ToolContext } from '@sigx/ai';
import { PLAN_LEASE_DEFAULT_MS, PLAN_TOOLS, type AgentId, type Plan, type PlanItem, type ProjectId, type Ref } from '@agentic/core';
import { grantedPlatformTools, planNext, planTools, platformTools, PLATFORM_TOOL_NAMES, type PlanBoard, type PlanPort, type ToolCall } from '../../src/index';
import { fakePorts } from '../anthropic/helpers';

const ctx = (id = 'call_1'): ToolContext => ({ toolCallId: id, signal: new AbortController().signal });

const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const ATLAS = 'agent_atlas' as AgentId;
const LATER = Date.now() + 60 * 60 * 1000;
const EARLIER = Date.now() - 60 * 1000;

const item = (id: number, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `item ${id}`, state: 'ready', after: [], touches: [], refs: [], doneWhen: [], activity: [], ...over });

function plan(items: PlanItem[]): Plan {
    return { id: 'manifests-v2', projectId: 'project_agentic' as ProjectId, title: 'Manifests v2', phases: [{ n: 1, title: 'Registry', items }] };
}

/** The board of the design: #8 done, #9 ready after #8, #10 claimed by Lint, #11 after #9, #12 in Lint's queue. */
function board(over: Partial<PlanBoard> = {}, items?: PlanItem[]): PlanBoard {
    return {
        plans: [
            plan(
                items ?? [
                    item(8, { state: 'done' }),
                    item(9, { after: [8], touches: ['packages/platform/src/registry/', 'plugins/model.ts'], doneWhen: [{ text: 'a', checked: false }, { text: 'b', checked: false }, { text: 'c', checked: false }] }),
                    item(10, { state: 'claimed', assignee: { kind: 'agent', agentId: LINT }, claim: { agentId: LINT, leaseUntil: LATER }, touches: ['plugins/model.ts'] }),
                    item(11, { after: [9] }),
                    item(12, { assignee: { kind: 'agent', agentId: LINT }, queueIndex: 0 })
                ]
            )
        ],
        members: [
            { actor: { kind: 'agent', agentId: FORGE }, handle: 'forge' },
            { actor: { kind: 'agent', agentId: LINT }, handle: 'lint' },
            { actor: { kind: 'agent', agentId: ATLAS }, handle: 'atlas' }
        ],
        me: FORGE,
        manager: ATLAS,
        limit: 1,
        ...over
    };
}

/** A port over a board the test holds; each write is recorded and applied minimally. */
function fakePlanPort(initial: PlanBoard) {
    let state = initial;
    const calls: { op: string; args: unknown; call: ToolCall }[] = [];
    const patch = (n: number, f: (i: PlanItem) => PlanItem): PlanItem => {
        let out: PlanItem | undefined;
        state = { ...state, plans: state.plans.map((p) => ({ ...p, phases: p.phases.map((ph) => ({ ...ph, items: ph.items.map((i) => (i.id === n ? (out = f(i)) : i)) })) })) };
        return out!;
    };
    const port: PlanPort = {
        async board(call) {
            calls.push({ op: 'board', args: undefined, call });
            return state;
        },
        async claim(n, leaseMs, call) {
            calls.push({ op: 'claim', args: { n, leaseMs }, call });
            return patch(n, (i) => ({ ...i, state: 'claimed', claim: { agentId: state.me, leaseUntil: 1_000_000 + leaseMs } }));
        },
        async assign(n, to, index, call) {
            calls.push({ op: 'assign', args: { n, to, index }, call });
            const m = state.members.find((x) => x.handle === to)!;
            return patch(n, (i) => ({ ...i, assignee: m.actor, queueIndex: index ?? 0 }));
        },
        async update(input, call) {
            calls.push({ op: 'update', args: input, call });
            return patch(input.item, (i) => ({ ...i, doneWhen: i.doneWhen.map((d, k) => ({ ...d, checked: input.check?.includes(k) ? true : d.checked })), ...(input.state ? { state: input.state } : {}) }));
        },
        async ref(n, ref, call) {
            calls.push({ op: 'ref', args: { n, ref }, call });
            return ref.kind === 'file' ? { ...ref, sha: '4f2a9c1' } : ref;
        },
        async add(input, call) {
            calls.push({ op: 'add', args: input, call });
            return input.items.map((x, k) => item(20 + k, { title: x.title }));
        },
        async handoff(n, to, note, call) {
            calls.push({ op: 'handoff', args: { n, to, note }, call });
            const m = to !== undefined ? state.members.find((x) => x.handle === to) : undefined;
            return patch(n, ({ claim: _claim, ...i }) => ({ ...i, state: 'ready', ...(m ? { assignee: m.actor } : {}) }));
        }
    };
    return { port, calls, ops: () => calls.map((c) => c.op) };
}

const tool = (port: PlanPort | undefined, name: string) => planTools(port).find((t) => t.name === name)!;

describe('plan tools', () => {
    it('are the eight PLAN_TOOLS on the platform roster, granted like any other tool', () => {
        expect(planTools(undefined).map((t) => t.name)).toEqual([...PLAN_TOOLS]);
        for (const n of PLAN_TOOLS) expect(PLATFORM_TOOL_NAMES).toContain(n);
        const names = platformTools(fakePorts()).map((t) => t.name);
        expect(names.slice(names.indexOf('plan_list'), names.indexOf('plan_list') + 8)).toEqual([...PLAN_TOOLS]);
        const granted = grantedPlatformTools(fakePorts(), [{ name: 'plan_list' }, { name: 'plan_claim', mode: 'deny' }]).map((t) => t.name);
        expect(granted).toEqual(['plan_list']);
        expect(tool(undefined, 'plan_list').annotations).toEqual({ readOnly: true, idempotent: true });
        expect(tool(undefined, 'plan_claim').annotations).toEqual({ readOnly: false, destructive: false });
    });

    it('report the plan unavailable without a port', async () => {
        await expect(tool(undefined, 'plan_next').run({}, ctx())).rejects.toThrow(/plan is not available/);
    });

    it('plan_list answers items with owner handles, waitsOn and refs in the text syntax; the port sees the call', async () => {
        const b = board({}, [item(8, { state: 'done' }), item(9, { after: [8, 7], assignee: { kind: 'agent', agentId: FORGE }, refs: [{ kind: 'pr', n: 604 }] })]);
        const fake = fakePlanPort(b);
        const out = (await tool(fake.port, 'plan_list').run({ mine: true }, ctx('call_7'))) as unknown as { items: { id: number; owner?: string; waitsOn: number[]; refs: string[] }[] };
        expect(out.items).toHaveLength(1);
        expect(out.items[0]).toMatchObject({ id: 9, owner: '@forge', waitsOn: [7], refs: ['pr:604'] });
        expect(fake.calls[0]!.call.callId).toBe('call_7');
    });

    it('plan_next takes the own queue first, then open items whose after are done, and skips path clashes', async () => {
        // #9 touches plugins/model.ts, which Lint's claimed #10 also touches: skipped. #11 waits on #9. Nothing else is open.
        expect(planNext(board())).toBeNull();
        const clear = board({}, [item(8, { state: 'done' }), item(9, { after: [8] }), item(13, { assignee: { kind: 'agent', agentId: FORGE }, queueIndex: 1 }), item(14, { assignee: { kind: 'agent', agentId: FORGE }, queueIndex: 0, after: [9] })]);
        const out = (await tool(fakePlanPort(clear).port, 'plan_next').run({}, ctx())) as unknown as { item: { id: number }; from: string };
        expect(out).toMatchObject({ item: { id: 13 }, from: 'your queue' });
        const open = board({}, [item(8, { state: 'done' }), item(9, { after: [8] })]);
        expect(await tool(fakePlanPort(open).port, 'plan_next').run({}, ctx())).toMatchObject({ item: { id: 9 }, from: 'open items' });
        expect(await tool(fakePlanPort(board()).port, 'plan_next').run({}, ctx())).toMatchObject({ item: null });
    });

    it('plan_claim starts an item with the default lease and warns about overlapping touches', async () => {
        const fake = fakePlanPort(board());
        const out = (await tool(fake.port, 'plan_claim').run({ item: 9 }, ctx())) as unknown as { item: number; headsUp?: string[] };
        expect(fake.calls.find((c) => c.op === 'claim')!.args).toEqual({ n: 9, leaseMs: PLAN_LEASE_DEFAULT_MS });
        expect(out.item).toBe(9);
        expect(out.headsUp).toEqual(['#10 (@lint) also touches plugins/model.ts']);
        await tool(fake.port, 'plan_claim').run({ item: 9, leaseMinutes: 45 }, ctx());
        expect(fake.calls.filter((c) => c.op === 'claim')[1]!.args).toEqual({ n: 9, leaseMs: 45 * 60_000 });
    });

    it('plan_claim refuses blocked, taken, queued-elsewhere and over-limit items without calling claim', async () => {
        const mine = board({}, [
            item(8, { state: 'done' }),
            item(9, { state: 'claimed', claim: { agentId: FORGE, leaseUntil: LATER }, assignee: { kind: 'agent', agentId: FORGE } }),
            item(10, { state: 'claimed', claim: { agentId: LINT, leaseUntil: LATER } }),
            item(11, { after: [9] }),
            item(12, { assignee: { kind: 'agent', agentId: LINT } }),
            item(13),
            item(14, { state: 'claimed', claim: { agentId: LINT, leaseUntil: EARLIER } })
        ]);
        const fake = fakePlanPort(mine);
        const claim = tool(fake.port, 'plan_claim');
        await expect(claim.run({ item: 11 }, ctx())).rejects.toThrow('refused: #11 waits on #9 (claimed by you). Try plan_next.');
        await expect(claim.run({ item: 10 }, ctx())).rejects.toThrow(/refused: #10 is claimed by @lint until .*Try plan_next\./);
        await expect(claim.run({ item: 12 }, ctx())).rejects.toThrow(/refused: #12 is in @lint's queue/);
        await expect(claim.run({ item: 8 }, ctx())).rejects.toThrow('refused: #8 is done.');
        await expect(claim.run({ item: 13 }, ctx())).rejects.toThrow(/refused: you already hold #9 and your limit is 1 at once/);
        await expect(claim.run({ item: 99 }, ctx())).rejects.toThrow(/#99 is not an item.*plan_list/);
        expect(fake.ops()).not.toContain('claim');
        // Renewing its own claim is fine; an expired lease of another agent no longer holds the item.
        await claim.run({ item: 9 }, ctx());
        const roomy = fakePlanPort({ ...mine, limit: 2 });
        await tool(roomy.port, 'plan_claim').run({ item: 14 }, ctx());
        expect(roomy.ops()).toContain('claim');
    });

    it('plan_assign and plan_add refuse agents that are not the project manager, and work for the manager', async () => {
        const forge = fakePlanPort(board());
        await expect(tool(forge.port, 'plan_assign').run({ item: 11, to: 'lint' }, ctx())).rejects.toThrow(/refused: plan_assign is for the project manager and people.*Ask @atlas/);
        await expect(tool(forge.port, 'plan_add').run({ items: [{ title: 'x' }] }, ctx())).rejects.toThrow(/refused: plan_add is for the project manager/);
        expect(forge.ops()).toEqual(['board', 'board']);
        await expect(tool(fakePlanPort(board({ manager: undefined })).port, 'plan_add').run({ items: [{ title: 'x' }] }, ctx())).rejects.toThrow(/Ask a person/);

        const atlas = fakePlanPort(board({ me: ATLAS }));
        expect(await tool(atlas.port, 'plan_assign').run({ item: 11, to: '@lint', index: 0 }, ctx())).toEqual({ item: 11, owner: '@lint', queueIndex: 0 });
        expect(atlas.calls.find((c) => c.op === 'assign')!.args).toEqual({ n: 11, to: 'lint', index: 0 });
        expect(await tool(atlas.port, 'plan_add').run({ items: [{ title: 'Split A' }, { title: 'Split B' }], split: 11 }, ctx())).toEqual({ added: [{ id: 20, title: 'Split A' }, { id: 21, title: 'Split B' }] });
        expect(atlas.calls.find((c) => c.op === 'add')!.args).toEqual({ items: [{ title: 'Split A' }, { title: 'Split B' }], split: 11 });
        await expect(tool(atlas.port, 'plan_add').run({ plan: 'nope', items: [{ title: 'x' }] }, ctx())).rejects.toThrow(/no plan "nope"/);
    });

    it('plan_update ticks done-when, adds notes, and refuses done with unticked lines or unknown lines', async () => {
        const fake = fakePlanPort(board());
        const update = tool(fake.port, 'plan_update');
        expect(await update.run({ item: 9, check: [0, 1], note: 'registry exports kindOrder()' }, ctx())).toEqual({ item: 9, state: 'ready', doneWhen: '2 of 3 done-when ticked' });
        expect(fake.calls.find((c) => c.op === 'update')!.args).toEqual({ item: 9, check: [0, 1], note: 'registry exports kindOrder()' });
        await expect(update.run({ item: 9, state: 'done' }, ctx())).rejects.toThrow('refused: #9 has 2 of 3 done-when ticked; tick them all first, or ask a person to mark it done.');
        await expect(update.run({ item: 9, check: [3] }, ctx())).rejects.toThrow(/#9 has 3 done-when lines .*no line 3/);
        await expect(update.run({ item: 9 }, ctx())).rejects.toThrow(/nothing to change on #9/);
        expect(await update.run({ item: 9, check: [2], state: 'done' }, ctx())).toMatchObject({ state: 'done', doneWhen: '3 of 3 done-when ticked' });
    });

    it('plan_ref parses the shared syntax, answers the pinned form, and refuses what is not one ref', async () => {
        const fake = fakePlanPort(board());
        expect(await tool(fake.port, 'plan_ref').run({ item: 9, ref: 'packages/platform/src/registry/manifest.ts:12-60' }, ctx())).toEqual({ item: 9, ref: 'packages/platform/src/registry/manifest.ts:12-60@4f2a9c1', pinned: '4f2a9c1' });
        expect((fake.calls.find((c) => c.op === 'ref')!.args as { ref: Ref }).ref).toEqual({ kind: 'file', path: 'packages/platform/src/registry/manifest.ts', from: 12, to: 60 });
        expect(await tool(fake.port, 'plan_ref').run({ item: 9, ref: 'pr:604' }, ctx())).toEqual({ item: 9, ref: 'pr:604' });
        await expect(tool(fake.port, 'plan_ref').run({ item: 9, ref: 'two words' }, ctx())).rejects.toThrow(/refused: "two words" is not one ref/);
    });

    it('plan_handoff releases an item the agent holds, to a member, and refuses one it does not hold', async () => {
        const b = board({}, [item(9, { state: 'claimed', claim: { agentId: FORGE, leaseUntil: LATER } }), item(10, { state: 'claimed', claim: { agentId: LINT, leaseUntil: LATER } })]);
        const fake = fakePlanPort(b);
        expect(await tool(fake.port, 'plan_handoff').run({ item: 9, to: '@lint', note: 'ready for your rebase on #10' }, ctx())).toEqual({ item: 9, state: 'ready', to: '@lint' });
        expect(fake.calls.find((c) => c.op === 'handoff')!.args).toEqual({ n: 9, to: 'lint', note: 'ready for your rebase on #10' });
        await expect(tool(fake.port, 'plan_handoff').run({ item: 10, note: 'x' }, ctx())).rejects.toThrow(/refused: #10 is not yours to hand off/);
    });
});
