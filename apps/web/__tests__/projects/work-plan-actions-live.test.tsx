/**
 * Settling plan items from Work on live data (#1041): a stuck row's Reopen puts it back to ready, Reassign moves it
 * to another member's queue, Drop drops it with the reason given; a needs-you row offers Decide (the item on the Plan)
 * and Drop; the dropped item leaves Work and shows as dropped, with its reason, on the Plan page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, PlanItem, ProjectId } from '@agentic/core';
import { definePlanActor, planKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { projectHead } from '../../src/pages/projects/head';
import { saveProjectWith } from '../../src/pages/projects/live';
import { closeWorkNotice, workHidden } from '../../src/pages/projects/work/actions';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

describe('plan item rows settle from Work on live data (#1041)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan] });
    });
    afterEach(async () => {
        closeWorkNotice();
        workHidden.ids = [];
        projectHead.value = null;
        await h.stop();
    });

    it('Reopen, Reassign and Drop on stuck rows; Decide and Drop on a needs-you row; dropped shows on the Plan', { timeout: 60_000 }, async () => {
        const forge = (await h.agent('Forge', 'Builds things')) as AgentId;
        const lint = (await h.agent('Lint', 'Checks things')) as AgentId;
        const { id: projectId } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge, lint], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId as ProjectId));
        const plan = await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Reopen me' }, { title: 'Reassign me' }, { title: 'Drop me' }, { title: 'Decide me' }] }] });
        const [a, b, c, d] = plan.phases[0]!.items.map((i) => i.id);
        for (const n of [a!, b!, c!]) {
            await store.assign(n, { kind: 'agent', agentId: forge });
            await store.update(n, { state: 'stuck', note: 'cannot go on' });
        }
        await store.update(d!, { state: 'needs-you', note: 'Which breakpoint?' });
        const itemOf = async (n: number): Promise<PlanItem> => (await store.list()).plans.flatMap((p) => p.phases.flatMap((ph) => ph.items)).find((i) => i.id === n)!;

        const work = await mountLive(`/projects/${projectId}/work`, h);
        const row = (n: number) => work.querySelector<HTMLElement>(`[data-work-row="item:${n}"]`);
        const button = (n: number, name: string, value: string) => row(n)?.querySelector<HTMLButtonElement>(`button[name="${name}"][value="${value}"]`) ?? null;
        await until(() => row(a!) !== null && row(d!) !== null, 'the plan rows on Work', 10_000);

        // The buttons each row offers.
        const offered = (n: number) => [...row(n)!.querySelectorAll<HTMLElement>('[name="work-plan-action"], [data-work-plan-action]')].map((e) => e.getAttribute('value') ?? e.getAttribute('data-work-plan-action'));
        expect(offered(a!)).toEqual(['reopen', 'reassign', 'drop']);
        expect(offered(d!)).toEqual(['decide', 'drop']);
        expect(row(d!)!.querySelector('[data-work-plan-action="decide"] a')?.getAttribute('href')).toBe(`/projects/${projectId}/plan?item=${d}`);

        // Reopen: back to ready, in the same queue; the row leaves Work.
        button(a!, 'work-plan-action', 'reopen')!.click();
        await until(async () => (await itemOf(a!)).state === 'ready', 'the item reopened', 10_000);
        expect((await itemOf(a!)).assignee).toEqual({ kind: 'agent', agentId: forge });
        await until(() => row(a!) === null, 'the reopened row off Work', 10_000);

        // Reassign: the member picker offers the other member; the item goes to their queue, ready.
        button(b!, 'work-plan-action', 'reassign')!.click();
        await until(() => button(b!, 'work-reassign', lint) !== null, 'the member picker');
        expect(button(b!, 'work-reassign', forge)).toBeNull();
        button(b!, 'work-reassign', lint)!.click();
        await until(async () => {
            const it = await itemOf(b!);
            return it.state === 'ready' && it.assignee?.kind === 'agent' && it.assignee.agentId === lint;
        }, 'the item in Lint’s queue', 10_000);

        // Drop, with a reason.
        button(c!, 'work-plan-action', 'drop')!.click();
        await until(() => row(c!)?.querySelector('[data-work-drop-reason]') !== null, 'the reason field');
        const reason = row(c!)!.querySelector<HTMLInputElement>('[data-work-drop-reason]')!;
        reason.value = 'superseded by the second cut';
        reason.dispatchEvent(new Event('input', { bubbles: true }));
        row(c!)!.querySelector<HTMLButtonElement>('button[name="work-drop-confirm"]')!.click();
        await until(async () => (await itemOf(c!)).state === 'dropped', 'the item dropped', 10_000);
        expect((await itemOf(c!)).dropped).toMatchObject({ by: { kind: 'user' }, note: 'superseded by the second cut' });
        await until(() => row(c!) === null && work.querySelector('button[name="work-undo"]') !== null, 'the row gone, with Undo', 10_000);

        // Drop on the needs-you row is there too.
        expect(button(d!, 'work-plan-action', 'drop')).not.toBeNull();

        // The Plan page shows the dropped item struck through with its reason.
        closeWorkNotice();
        const planPage = await mountLive(`/projects/${projectId}/plan`, h);
        const planRow = () => planPage.querySelector<HTMLElement>(`[data-plan-item="${c}"]`);
        await until(() => planRow() !== null, 'the Plan list', 10_000);
        expect(planRow()!.getAttribute('data-state')).toBe('dropped');
        expect(planRow()!.querySelector('[data-plan-item-meta]')?.textContent).toContain('superseded by the second cut');
    });

    it('the work item page has the same buttons', { timeout: 30_000 }, async () => {
        const forge = (await h.agent('Forge', 'Builds things')) as AgentId;
        const { id: projectId } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: forge }, folders: {}, connectors: [], features: {} });
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId as ProjectId));
        const plan = await store.create({ title: 'P', phases: [{ title: 'One', items: [{ title: 'Stuck one' }] }] });
        const n = plan.phases[0]!.items[0]!.id;
        await store.update(n, { state: 'stuck', note: 'cannot go on' });
        const dom = await mountLive(`/projects/${projectId}/work/item:${n}`, h);
        const actions = () => dom.querySelector<HTMLElement>(`[data-work-item-head] [data-plan-item-actions="${n}"]`);
        await until(() => actions() !== null, 'the plan item buttons on the page', 10_000);
        actions()!.querySelector<HTMLButtonElement>('button[value="reopen"]')!.click();
        await until(async () => (await store.list()).plans[0]!.phases[0]!.items[0]!.state === 'ready', 'the item reopened', 10_000);
    });
});
