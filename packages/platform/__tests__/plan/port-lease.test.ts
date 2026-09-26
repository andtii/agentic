/**
 * `plan_claim` without `leaseMinutes` takes the project's lease; an explicit one always wins, even when it equals the
 * tool default (#962). Through the runtimes' tool, the port and a real in-process Plan actor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualScheduler } from '@sigx/actors/host';
import type { AgentId, Principal, ProjectId, ProjectMembers, SessionId, WorkspaceId } from '@agentic/core';
import { PLAN_FEATURE_ID } from '@agentic/plugins-plan';
import { planTools } from '@agentic/runtimes';
import { capturingAuditPort } from '../../src/audit/port';
import { createPlanPort, definePlanActor, planKey, type PlanActorClient } from '../../src/plan/index';
import { testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const FORGE = 'agent_forge' as AgentId;
const T0 = 1_000_000;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const forge: Principal = { kind: 'agent', agentId: FORGE, workspaceId: ws, sessionId: 'sess_forge' as SessionId };
const members: ProjectMembers = { agentIds: [FORGE], coordinator: FORGE };

let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    Plan = definePlanActor({
        audit: capturingAuditPort(),
        projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members, features: { [PLAN_FEATURE_ID]: { leaseMinutes: 90 } } } : undefined) }
    });
    app = testActorApp([Plan], { scheduler: manualScheduler(), defaults: { reminderTickMs: 60_000 } });
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const store = (p: Principal) => app.as(p).actor(Plan, planKey(ws, project));
const port = createPlanPort({ me: FORGE, scope: async () => ({ plan: store(forge) as unknown as PlanActorClient, project: { members }, names: new Map(), users: ['u1'] }) });
const claimTool = () => planTools(port).find((t) => t.name === 'plan_claim')!;
const ctx = () => ({ toolCallId: 'call_1', signal: new AbortController().signal }) as never;

async function claimedLease(input: { item: number; leaseMinutes?: number }): Promise<number> {
    await claimTool().run(input, ctx());
    const item = (await store(user).get('plan-1')).phases[0]!.items.find((i: { id: number }) => i.id === input.item)!;
    return item.claim!.leaseUntil - T0;
}

describe('plan_claim lease (#962)', () => {
    beforeEach(async () => {
        await store(user).create({ title: 'Ship', phases: [{ title: 'Build', items: [{ title: 'a' }, { title: 'b' }] }] } as never);
    });

    it('omitted: the project’s lease', async () => {
        expect(await claimedLease({ item: 1 })).toBe(90 * 60_000);
    });

    it('an explicit 30 minutes: 30 minutes, not the project’s lease', async () => {
        expect(await claimedLease({ item: 1, leaseMinutes: 30 })).toBe(30 * 60_000);
    });
});
