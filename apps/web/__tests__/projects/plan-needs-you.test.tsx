/**
 * A plan item that needs a person (#1044): its detail panel opens on the question with an answer box (Answer & send
 * back is `Plan.answer`, Mark done `update({state: 'done'})`), the comment box is the chat's composer whose `@` names
 * reach the Plan as agent ids, and Home's "Needs you" lists every project's needs-you items — answered in place, the
 * row leaves once the item is ready again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentId, Plan, PlanItem, ProjectId, ProjectRecord } from '@agentic/core';
import { defineRegistry, definePlanActor, planKey, registryKey, Workspace, workspaceKey } from '@agentic/platform';
import { planFeatureManifest } from '@agentic/plugins-plan';
import { clientDefs } from '../../src/actors/client';
import { MOCK_PLANS } from '../../src/mock/projects/plan';
import { needsOfPlans, planItemHref } from '../../src/pages/projects/features/plan/home/needs';
import { ItemDetail } from '../../src/pages/projects/features/plan/list/ItemDetail';
import { PlanList } from '../../src/pages/projects/features/plan/list/PlanList';
import { questionOf } from '../../src/pages/projects/features/plan/shared/NeedsYouCard';
import { planNeedsOf } from '../../src/pages/inbox/NeedsYou';
import { PLAN_FEATURE } from '../../src/pages/projects/layout/counts';
import { saveProjectWith } from '../../src/pages/projects/live';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, tick } from '../pages/mount';
import { USER, WS, mountLive, owner, startLive, until, type LiveHarness } from '../pages/live-harness';

const doc = MOCK_PLANS['p_agentic']![0]!;
const items = doc.plan.phases.flatMap((p) => p.items);
const asked = items.find((i) => i.id === 12)!;
const now = 10_000_000;

const setText = (el: HTMLTextAreaElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the question a needs-you item waits on (#1044)', () => {
    it('is the recorded ask, else the newest activity line', () => {
        expect(questionOf(asked)).toMatchObject({ by: { kind: 'agent', agentId: 'atlas' }, text: expect.stringContaining('Keep a2a') });
        const old: PlanItem = { ...asked, ask: undefined, activity: [{ at: 5, actor: { kind: 'agent', agentId: 'forge' as AgentId }, text: 'which port?' }] };
        expect(questionOf(old)).toEqual({ by: { kind: 'agent', agentId: 'forge' }, text: 'which port?', at: 5 });
    });

    it('Home lists needs-you items oldest question first, each linked to its item', () => {
        const plan: Plan = { ...doc.plan, id: 'plan-1' };
        const needs = needsOfPlans('p1', 'agentic', [plan]);
        expect(needs.map((n) => n.item.id)).toEqual(items.filter((i) => i.state === 'needs-you').map((i) => i.id));
        const later = { ...needs[0]!, item: { ...needs[0]!.item, id: 99, ask: { by: { kind: 'user', userId: 'u' } as const, at: Number.MAX_SAFE_INTEGER } } };
        expect(planNeedsOf([later, ...needs]).at(-1)!.item.id).toBe(99);
        expect(planItemHref(needs[0]!)).toBe(`/projects/p1/plan?plan=plan-1&item=${needs[0]!.item.id}`);
    });
});

describe('the item panel (#1044)', () => {
    const mount = (over: Record<string, unknown> = {}) =>
        mountAt('/projects/p_agentic/plan', <ItemDetail projectId="p_agentic" doc={doc} item={asked} items={items} now={now} members={{ agentIds: ['atlas', 'forge'] as AgentId[], coordinator: 'atlas' as AgentId }} onPick={() => {}} onClose={() => {}} {...over} />);

    it('answers from the card: an option fills the box, Answer & send back sends it', async () => {
        const onAnswer = vi.fn(async () => true);
        const onDone = vi.fn(async () => true);
        const el = await mount({ onAnswer, onDone });
        const card = el.querySelector('[data-plan-needs-you="12"]')!;
        expect(text(card.querySelector('[data-plan-needs-you-who]'))).toContain('Atlas asks');
        [...card.querySelectorAll<HTMLButtonElement>('[data-plan-needs-you-option]')].find((b) => b.textContent === 'Fold a2a into connector')!.click();
        await tick();
        expect(card.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Fold a2a into connector');
        card.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(onAnswer).toHaveBeenCalledWith('Fold a2a into connector');
        [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Mark done')!.click();
        await tick();
        expect(onDone).toHaveBeenCalled();
    });

    it('is read-only without writes', async () => {
        const el = await mount();
        const submit = [...el.querySelectorAll<HTMLButtonElement>('[data-plan-needs-you] button')].find((b) => b.textContent?.trim() === 'Answer & send back')!;
        expect(submit.disabled).toBe(true);
        expect(el.querySelector('[data-plan-needs-you] textarea')!.hasAttribute('disabled')).toBe(true);
    });

    it('a comment sends the agents it @s by id; a refused one goes back into the box', async () => {
        const onComment = vi.fn(async () => false);
        const el = await mount({ onComment });
        const box = el.querySelector<HTMLTextAreaElement>('[data-plan-comment] textarea')!;
        setText(box, '@Forge please look, and @Atlas too');
        el.querySelector('[data-plan-comment] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await tick();
        expect(onComment).toHaveBeenCalledWith('@Forge please look, and @Atlas too', ['forge', 'atlas']);
        await tick();
        expect(el.querySelector<HTMLTextAreaElement>('[data-plan-comment] textarea')!.value).toContain('@Forge please look');
    });
});

describe('Home on mock data (#1044)', () => {
    it('lists the mock plans’ needs-you items with their question', async () => {
        const dom = await mountRoute('/');
        const row = dom.querySelector('[data-needs-plan="12"]')!;
        expect(row).not.toBeNull();
        expect(text(row.querySelector('[data-plan-needs-you-question]'))).toContain('Keep a2a');
        expect(row.querySelector('a')!.getAttribute('href')).toContain('/projects/p_agentic/plan?plan=');
    });
});

describe('needs-you on the live Plan (#1044)', () => {
    let h: LiveHarness;
    const Plan = definePlanActor();
    const Registry = defineRegistry({ catalogue: [planFeatureManifest] });
    beforeEach(async () => {
        h = await startLive(undefined, { actors: [Plan, Registry] });
        await h.app.as(owner).actor(Registry, registryKey(WS)).enable(PLAN_FEATURE);
    });
    afterEach(async () => {
        await h.stop();
    });

    const setUp = async () => {
        const forge = await h.agent('Forge', 'Builds things');
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'agentic', members: { agentIds: [forge], coordinator: null }, folders: {}, connectors: [], features: { [PLAN_FEATURE]: {} } });
        const projectId = id as ProjectId;
        const project = (await h.app.as(owner).actor(Workspace, workspaceKey(WS)).projects()).find((p) => p.id === projectId)! as ProjectRecord;
        const store = h.app.as(owner).actor(Plan, planKey(WS, projectId));
        const plan = await store.create({ title: 'Mobile pass', phases: [{ title: 'Shell', items: [{ title: 'Collapse the rail' }] }] });
        const first = plan.phases[0]!.items[0]!;
        await store.update(first.id, { state: 'needs-you', note: 'Which width does the rail hide under?' });
        const item = async (): Promise<PlanItem> => (await store.list()).plans[0]!.phases[0]!.items[0]!;
        return { projectId, project, first, item };
    };

    it('Home lists the item with its question, answers it in place, and drops the row', { timeout: 30_000 }, async () => {
        const { first, item } = await setUp();
        const home = await mountLive('/', h);
        const row = () => home.querySelector(`[data-needs-plan="${first.id}"]`);
        await until(() => row() !== null, 'the item on Home', 10_000);
        expect(text(row()!.querySelector('[data-plan-needs-you-question]'))).toBe('Which width does the rail hide under?');
        setText(row()!.querySelector<HTMLTextAreaElement>('textarea')!, '720px');
        row()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await item()).state === 'ready', 'the item ready in the store', 10_000);
        expect((await item()).activity.at(-1)!.text).toBe('answered: 720px');
        await until(() => row() === null, 'the row gone from Home', 10_000);
    });

    it('the plan list’s panel answers it', { timeout: 30_000 }, async () => {
        const { project, first, item } = await setUp();
        const dom = await mountLive(`/projects/${project.id}/plan?item=${first.id}`, h, <PlanList project={project} />);
        const card = () => dom.querySelector(`[data-plan-needs-you="${first.id}"]`);
        await until(() => card() !== null, 'the question on the panel', 10_000);
        setText(card()!.querySelector<HTMLTextAreaElement>('textarea')!, '720px');
        card()!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await until(async () => (await item()).state === 'ready', 'the item ready in the store', 10_000);
        await until(() => card() === null, 'the card gone once the item is ready', 10_000);
    });
});
