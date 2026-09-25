/**
 * The Plan actor as the `plan_*` tools' port (#816): `createPlanPort` over a real in-process Plan actor, under the
 * calling agent. The board carries members by handle, the manager and the caller's limit; every write is the actor
 * method of the same name and its refusal comes back in the actor's words; notices are handed over after each call;
 * a file ref is pinned when the host can. The runtimes' tools run the whole lease loop over it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, FileRef, Principal, ProjectId, ProjectMembers, SessionId, WorkspaceId } from '@agentic/core';
import { planTools, type ToolCall } from '@agentic/runtimes';
import { capturingAuditPort } from '../../src/audit/port';
import { createPlanPort, definePlanActor, planHandle, planKey, planPatch, resolvePlanMember, type PlanActorClient, type PlanNotice, type PlanPortDeps } from '../../src/plan/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const LINT = 'agent_lint' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });
const names = new Map<AgentId, string>([
    [PM, 'Keel'],
    [FORGE, 'Forge Bot'],
    [LINT, 'Lint']
]);

let members: ProjectMembers;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    members = { agentIds: [PM, FORGE, LINT], coordinator: PM, limits: { [LINT]: 2 } };
    Plan = definePlanActor({ audit: capturingAuditPort(), projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    app = testActorApp([Plan], { scheduler: manualScheduler(), defaults: { reminderTickMs: 60_000 } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const store = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
const client = (p: Principal) => store(p) as unknown as PlanActorClient;
const call = (callId = 'call_1'): ToolCall => ({ callId, signal: new AbortController().signal });

function port(me: AgentId, extra: Partial<PlanPortDeps> = {}) {
    const delivered: PlanNotice[] = [];
    const p = createPlanPort({
        me,
        scope: async () => ({ plan: client(agentP(me)), project: { members }, names, users: ['u1'] }),
        deliver: async (notices) => {
            delivered.push(...notices);
        },
        ...extra
    });
    return { port: p, delivered };
}

async function seed() {
    return store().create({
        title: 'Ship plans',
        phases: [
            { title: 'Build', items: [{ title: 'store', touches: ['src/x/'], doneWhen: ['tests', 'docs'] }, { title: 'tools', after: [1] }, { title: 'docs', touches: ['src/x/y.ts'] }] }
        ]
    } as never);
}

const tool = (p: ReturnType<typeof createPlanPort>, name: string) => planTools(p).find((t) => t.name === name)!;
const ctx = (id = 'call_1') => ({ toolCallId: id, signal: new AbortController().signal }) as never;

describe('plan port (#816)', () => {
    it('handles: a name as a slug, resolved by handle, id or name; an unknown one lists the members', () => {
        expect(planHandle('Forge Bot')).toBe('forge-bot');
        expect(planHandle('  Ada  ')).toBe('ada');
        const people = { project: { members: { agentIds: [PM, FORGE], coordinator: PM } }, names, users: ['u1'] };
        expect(resolvePlanMember(people, '@forge-bot')).toEqual({ kind: 'agent', agentId: FORGE });
        expect(resolvePlanMember(people, 'Keel')).toEqual({ kind: 'agent', agentId: PM });
        expect(resolvePlanMember(people, FORGE)).toEqual({ kind: 'agent', agentId: FORGE });
        expect(resolvePlanMember(people, 'u1')).toEqual({ kind: 'user', userId: 'u1' });
        expect(() => resolvePlanMember(people, 'nobody')).toThrow(/@nobody is not a member of this project\. Members: @keel, @forge-bot, @u1/);
    });

    it('patch: ticks, unticks, note and state as the actor’s update', () => {
        expect(planPatch({ check: [0, 1], uncheck: [2], note: 'n', state: 'stuck' })).toEqual({
            tick: [
                { index: 0, checked: true },
                { index: 1, checked: true },
                { index: 2, checked: false }
            ],
            note: 'n',
            state: 'stuck'
        });
        expect(planPatch({})).toEqual({});
    });

    it('board: the plans, members by handle, the caller, the manager and the caller’s limit', async () => {
        await seed();
        const board = await port(LINT).port.board(call());
        expect(board.plans.map((p) => p.id)).toEqual(['plan-1']);
        expect(board.members.map((m) => m.handle)).toEqual(['keel', 'forge-bot', 'lint', 'u1']);
        expect(board).toMatchObject({ me: LINT, manager: PM, limit: 2 });
        expect((await port(FORGE).port.board(call())).limit).toBe(1);
    });

    it('the lease loop through the tools: plan_next → plan_claim → plan_update ticking all, and the item is done', async () => {
        await seed();
        const { port: p } = port(FORGE, { taskId: () => 'task_9' as never });
        expect(await tool(p, 'plan_next').run({}, ctx())).toMatchObject({ item: { id: 1 }, from: 'open items' });
        expect(await tool(p, 'plan_claim').run({ item: 1 }, ctx())).toMatchObject({ item: 1, state: 'claimed' });
        const claimed = (await store().get('plan-1')).phases[0]!.items[0]!;
        expect(claimed.claim).toMatchObject({ agentId: FORGE, taskId: 'task_9' });
        expect(await tool(p, 'plan_update').run({ item: 1, check: [0, 1] }, ctx())).toMatchObject({ item: 1, state: 'done', doneWhen: '2 of 2 done-when ticked' });
        expect((await store().get('plan-1')).phases[0]!.items[0]!.state).toBe('done');
    });

    it('a refused claim comes back in the actor’s own words', async () => {
        await seed();
        await port(FORGE).port.claim(1, 60_000, call());
        await expect(port(LINT).port.claim(1, 60_000, call())).rejects.toThrow(`#1 is being worked by @${FORGE}`);
        await expect(port(LINT).port.claim(2, 60_000, call())).rejects.toThrow('#2 waits on #1');
    });

    it('notices are taken after each call and handed to deliver', async () => {
        await seed();
        const lint = port(LINT);
        const forge = port(FORGE);
        await lint.port.claim(1, 60_000, call());
        await forge.port.claim(3, 60_000, call());
        expect(forge.delivered).toMatchObject([{ kind: 'touches', itemId: 3, otherItemId: 1 }]);
        await lint.port.board(call());
        expect(lint.delivered).toMatchObject([{ kind: 'touches', itemId: 1, otherItemId: 3 }]);
        await lint.port.board(call());
        expect(lint.delivered).toHaveLength(1);
    });

    it('assign and add by the manager: handles resolve to agents, add lands in the only plan’s last phase, split replaces', async () => {
        await seed();
        const pm = port(PM).port;
        expect(await pm.assign(3, '@forge-bot', undefined, call())).toMatchObject({ id: 3, assignee: { kind: 'agent', agentId: FORGE } });
        await expect(pm.assign(3, 'nobody', undefined, call())).rejects.toThrow(/not a member/);
        expect((await pm.add({ items: [{ title: 'more', doneWhen: ['x'] }] }, call())).map((i) => i.id)).toEqual([4]);
        const split = await pm.add({ split: 2, items: [{ title: 'tools a' }, { title: 'tools b' }] }, call());
        expect(split.map((i) => i.title)).toEqual(['tools a', 'tools b']);
        await store().create({ title: 'Later', phases: [{ title: 'One', items: [] }] });
        await expect(pm.add({ items: [{ title: 'where?' }] }, call())).rejects.toThrow(/name one with `plan`/);
        expect((await pm.add({ plan: 'plan-2', items: [{ title: 'here' }] }, call()))[0]).toMatchObject({ title: 'here' });
        // A member that is not the manager is refused by the actor, in its words.
        await expect(port(LINT).port.add({ plan: 'plan-1', items: [{ title: 'x' }] }, call())).rejects.toThrow(/project manager/);
    });

    it('handoff: to a handle, or back to whoever assigned it', async () => {
        await seed();
        await port(PM).port.assign(3, 'lint', undefined, call());
        await port(LINT).port.claim(3, 60_000, call());
        const back = await port(LINT).port.handoff(3, undefined, 'half done', call());
        expect(back.assignee).toEqual({ kind: 'agent', agentId: PM });
        const on = await port(PM).port.handoff(3, 'forge-bot', 'yours', call());
        expect(on.assignee).toEqual({ kind: 'agent', agentId: FORGE });
    });

    it('ref: a file ref is pinned when the host can, stored unpinned otherwise; other refs as given', async () => {
        await seed();
        const file: FileRef = { kind: 'file', path: 'src/a.ts', from: 3, to: 5 };
        const pin = vi.fn(async (r: FileRef) => ({ ...r, sha: 'a'.repeat(40) }));
        expect(await port(PM, { pin }).port.ref(1, file, call())).toEqual({ ...file, sha: 'a'.repeat(40) });
        expect(pin).toHaveBeenCalledOnce();
        const other: FileRef = { kind: 'file', path: 'src/b.ts', from: 1, to: 1 };
        expect(await port(PM, { pin: async () => undefined }).port.ref(1, other, call())).toEqual(other);
        expect(await port(PM, { pin: async () => Promise.reject(new Error('offline')) }).port.ref(2, other, call())).toEqual(other);
        expect(await port(PM).port.ref(1, { kind: 'pr', n: 604 }, call())).toEqual({ kind: 'pr', n: 604 });
        const refs = (await store().get('plan-1')).phases[0]!.items[0]!.refs;
        expect(refs).toContainEqual({ ...file, sha: 'a'.repeat(40) });
        expect(refs).toContainEqual(other);
    });
});
