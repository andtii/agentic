/**
 * `Plan.touches` (#1074) on a real in-process host: a person sets an item's touches, a member agent is refused (403),
 * and the change is audited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, Principal, ProjectId, ProjectMembers, SessionId, WorkspaceId } from '@agentic/core';
import { capturingAuditPort } from '../../src/audit/port';
import { definePlanActor, planKey } from '../../src/plan/index';
import { statusOf, testActorApp, type TestActorApp } from '../../src/testing/index';

const ws = 'ws_1' as WorkspaceId;
const project = 'prj_1' as ProjectId;
const PM = 'agent_pm' as AgentId;
const FORGE = 'agent_forge' as AgentId;
const user: Principal = { kind: 'user', userId: 'u1', workspaceId: ws };
const forge: Principal = { kind: 'agent', agentId: FORGE, workspaceId: ws, sessionId: 'sess_forge' as SessionId };

let audit: ReturnType<typeof capturingAuditPort>;
let app: TestActorApp;
let Plan: ReturnType<typeof definePlanActor>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const members: ProjectMembers = { agentIds: [PM, FORGE], coordinator: PM };
    audit = capturingAuditPort();
    Plan = definePlanActor({ audit, projects: { project: async (_ctx, _ws, id) => (id === project ? { id: project, members } : undefined) } });
    app = testActorApp([Plan]);
    return app.start();
});
afterEach(async () => {
    await app.stop();
    vi.useRealTimers();
});

const plan = (p: Principal = user) => app.as(p).actor(Plan, planKey(ws, project));

describe('Plan.touches (#1074)', () => {
    it('a person replaces the touches; a member agent is refused; the change is audited', async () => {
        await plan().create({ title: 'Plan', phases: [{ title: 'Build', items: [{ title: 'one' }] }] });
        const item = await plan().touches(1, ['packages/a/', 'apps/web/']);
        expect(item.touches).toEqual(['packages/a/', 'apps/web/']);
        expect(await statusOf(plan(forge).touches(1, []))).toBe(403);
        expect((await plan().list()).plans[0]!.phases[0]!.items[0]!.touches).toEqual(['packages/a/', 'apps/web/']);
        expect(audit.events.some((e) => JSON.stringify(e).includes('#1 touches packages/a/, apps/web/'))).toBe(true);
    });
});
