/**
 * The items a turn leaves done or dropped are released (#1075): the Plan actor tells its `PlanReleasePort` once per
 * turn, after the turn is saved — an item ticked done, set done, done by its pull request merging, or dropped — so a
 * project feature can remove what it made for the item (the git feature: its worktree). Nothing else is released, and
 * a failing port never undoes the change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineActor } from '@sigx/actors';
import type { AgentId, Principal, ProjectId, ProjectMembers, SessionId, TaskId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey, type PlanItemRelease, type PlanReleasePort } from '../../src/plan/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const agentP = (agentId: AgentId): Principal => ({ kind: 'agent', agentId, workspaceId: ws, sessionId: `sess_${agentId}` as SessionId });

let released: { workspaceId: WorkspaceId; projectId: ProjectId; items: readonly PlanItemRelease[] }[];
let fail: boolean;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;
let Merges: ReturnType<typeof defineActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    released = [];
    fail = false;
    const members: ProjectMembers = { agentIds: [PM, FORGE], coordinator: PM };
    const release: PlanReleasePort = {
        async released(r) {
            released.push(r);
            if (fail) throw new Error('router down');
        }
    };
    Plan = definePlanActor({ audit: capturingAuditPort(), wake: { wake: async () => true }, release, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    Merges = defineActor({
        type: 'merges',
        allowAnonymous: true,
        state: () => ({}),
        methods: (ctx) => ({
            async merged(number: number, taskId: TaskId) {
                return ctx.actor(Plan, planKey(ws, project)).pullMerged({ number, taskId });
            }
        })
    });
    app = testActorApp([Plan, Merges]);
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));
const items = () => released.map((r) => r.items);

describe('releasing finished plan items (#1075)', () => {
    it('an item ticked done is released once, with the project; later calls release nothing more', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a', doneWhen: ['works'] }, { title: 'b' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1);
        expect(released).toEqual([]);
        await plan(agentP(FORGE)).update(1, { tick: [{ index: 0, checked: true }] });
        expect(released).toEqual([{ workspaceId: ws, projectId: project, items: [{ n: 1, reason: 'done' }] }]);
        await plan().update(2, { note: 'later' });
        expect(released).toHaveLength(1);
    });

    it('a dropped item is released as dropped; reopened and done, it is released again', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        await plan().update(1, { state: 'dropped', note: 'not needed' });
        await plan().update(1, { state: 'ready' });
        await plan().update(1, { state: 'done' });
        expect(items()).toEqual([[{ n: 1, reason: 'dropped' }], [{ n: 1, reason: 'done' }]]);
    });

    it('an item done by its pull request merging is released', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        await plan().assign(1, { kind: 'agent', agentId: FORGE });
        await plan(agentP(FORGE)).claim(1, { taskId: 'task_a' as TaskId });
        await plan(agentP(FORGE)).handoff(1, null, 'PR open');
        await (app.as(user).actor(Merges, 'm') as unknown as { merged(n: number, t: TaskId): Promise<number[]> }).merged(1075, 'task_a' as TaskId);
        expect(items()).toEqual([[{ n: 1, reason: 'done' }]]);
    });

    it('a failing port never undoes the change', async () => {
        await plan().create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'a' }] }] });
        fail = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await expect(plan().update(1, { state: 'done' })).resolves.toMatchObject({ id: 1, state: 'done' });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('releasing #1 failed'), expect.any(Error));
        warn.mockRestore();
        expect(items()).toEqual([[{ n: 1, reason: 'done' }]]);
    });
});
