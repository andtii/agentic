/**
 * The Plan list (#754, PRJ-13) on mock data: the model (progress, row meta, owner status, crew, filters, overlaps,
 * ref labels), the page (header, crew strip, phases, rows, detail panel, file ref hover card, comment ref hints) and
 * the Overview card registered for `agentic.feature.plan`.
 */
import { describe, it, expect } from 'vitest';
import type { PlanActor, PlanItem } from '@agentic/core';
import { MOCK_PLANS, MOCK_PLAN_VIEWER } from '../../src/mock/projects/plan';
import { MOCK_EVENT_PROJECT } from '../../src/mock/projects/overview';
import { featureViewsOf, featureHref } from '../../src/pages/projects/features/registry';
import { actorName } from '../../src/pages/projects/features/plan/shared/data';
import {
    crewCounts, crewOf, defaultItem, filterPhases, itemMeta, leaseMinutesLeft, nextItems, ownerStatus, pinLine, planOf, planProgress,
    progressText, queuePlace, refLabel, shortPath, touchOverlaps, unblocksOf
} from '../../src/pages/projects/features/plan/shared/model';
import { PlanOverviewCard, planHref } from '../../src/pages/projects/features/plan/shared/parts';
import { mountAt, text } from '../pages/helpers';
import { mountRoute, page, texts, tick } from '../pages/mount';

const doc = MOCK_PLANS['p_agentic']![0]!;
const plan = doc.plan;
const items = plan.phases.flatMap((p) => p.items);
const byId = (n: number): PlanItem => items.find((i) => i.id === n)!;
const me: PlanActor = MOCK_PLAN_VIEWER;
const metaText = (n: number): string => itemMeta(byId(n), items, actorName, doc.runs?.[n]).map((m) => m.text).join(' · ');

describe('the plan model (#754)', () => {
    it('counts progress over the plan and per phase', () => {
        const p = planProgress(plan);
        expect(progressText(p)).toBe(`${p.done} of ${p.total} done`);
        expect(p.total).toBe(14);
        expect(p.done).toBe(5);
        expect(p.pct).toBe(36);
        expect(planProgress({ phases: [] })).toEqual({ done: 0, total: 0, pct: 0 });
    });

    it('writes the line under each title the way the board does', () => {
        expect(metaText(8)).toBe('');
        expect(metaText(9)).toBe('after #8 · touches 2 paths · t_93d1');
        expect(metaText(10)).toBe('touches plugins/model.ts · overlaps #9');
        expect(metaText(11)).toBe('waits on #9');
        expect(metaText(12)).toBe('Atlas asks you · 2 options');
        expect(metaText(16)).toBe('waits on signalx#14');
        expect(metaText(15)).toBe('waits on #10, #11');
        expect(itemMeta(byId(10), items, actorName).find((m) => m.text.startsWith('overlaps'))?.tone).toBe('needs-you');
    });

    it('says what the owner is doing', () => {
        expect(ownerStatus(byId(8))).toEqual({ text: 'done', tone: 'dim' });
        expect(ownerStatus(byId(9))).toEqual({ text: 'working', tone: 'working' });
        expect(ownerStatus(byId(12))).toEqual({ text: 'your call', tone: 'needs-you' });
        expect(ownerStatus(byId(16)).text).toBe('queued 3');
        expect(ownerStatus(byId(15)).text).toBe('not assigned');
        expect(ownerStatus({ ...byId(9), state: 'stuck' })).toEqual({ text: 'stuck', tone: 'failed' });
    });

    it('lists the crew: manager first, members, anyone else holding items, then you', () => {
        const crew = crewOf(plan, { agentIds: ['forge', 'lint', 'atlas'], coordinator: 'atlas' }, me);
        expect(crew.map((c) => actorName(c.actor))).toEqual(['Atlas', 'Forge', 'Lint', 'Scout', 'You']);
        expect(crew[0]!.manager).toBe(true);
        expect(crewCounts(crew[1]!).map((c) => c.text)).toEqual(['1 working', '3 queued']);
        expect(crewCounts(crew[2]!).map((c) => c.text)).toEqual(['1 working', '1 queued']);
        expect(crewCounts(crew[3]!).map((c) => c.text)).toEqual(['1 queued']);
        expect(crewCounts(crew[4]!).map((c) => c.text)).toEqual(['1 needs you']);
    });

    it('filters by search, Mine and Open, dropping phases left empty', () => {
        expect(filterPhases(plan, '', 'all', me).map((p) => p.items.length)).toEqual([4, 6, 4]);
        expect(filterPhases(plan, '', 'mine', me).flatMap((p) => p.items.map((i) => i.id))).toEqual([12]);
        expect(filterPhases(plan, '', 'open', me).map((p) => p.phase.n)).toEqual([2, 3]);
        expect(filterPhases(plan, 'manifest.ts', 'all', me).flatMap((p) => p.items.map((i) => i.id))).toEqual([8, 9]);
        expect(filterPhases(plan, '#16', 'all', me).flatMap((p) => p.items.map((i) => i.id))).toEqual([16]);
        expect(filterPhases(plan, 'pr:604', 'all', me).flatMap((p) => p.items.map((i) => i.id))).toEqual([9]);
    });

    it('finds overlapping touches, unblocked items and the queue place', () => {
        expect(touchOverlaps(byId(9), items).map((o) => [o.item.id, shortPath(o.path)])).toEqual([[10, 'plugins/model.ts'], [11, 'plugins/model.ts']]);
        expect(touchOverlaps(byId(8), items).map((o) => o.item.id)).toEqual([9]);
        expect(touchOverlaps(byId(12), items)).toEqual([]);
        expect(unblocksOf(byId(9), items).map((i) => i.id)).toEqual([11, 13]);
        expect(queuePlace(byId(14), items)).toBe('2 of 3 in queue');
        expect(queuePlace(byId(9), items)).toBeUndefined();
        expect(leaseMinutesLeft(1_000 + 15.5 * 60_000, 1_000)).toBe(16);
        expect(leaseMinutesLeft(0, 1_000)).toBe(0);
    });

    it('labels refs for their chips and pins', () => {
        const refs = byId(9).refs;
        expect(refs.map(refLabel)).toEqual(['plugins/model.ts:38-41', 'registry/manifest.ts:12-60', '4f2a9c1', '#604', 'chat · msg-42', 'docs/architecture.md §7', 'modelcontextprotocol.io/spec']);
        const file = refs[0] as Extract<(typeof refs)[number], { kind: 'file' }>;
        expect(pinLine(file, { branch: 'main', lines: [] })).toBe('L38–41 · main@4f2a9c1');
        expect(pinLine({ kind: 'file', path: 'a.ts', from: 3, to: 3 }, undefined)).toBe('L3 · not pinned');
    });

    it('picks the plan, the default item and the next three', () => {
        expect(planOf(MOCK_PLANS['p_agentic']!, 'nope')?.plan.id).toBe('pl_manifests');
        expect(planOf([], undefined)).toBeUndefined();
        expect(defaultItem(plan)?.id).toBe(9);
        expect(nextItems(plan).map((i) => i.id)).toEqual([9, 10, 11]);
        expect(planHref('p_x', 'list')).toBe('/projects/p_x/plan');
        expect(planHref('p_x', 'board', 'pl_1')).toBe('/projects/p_x/plan?view=board&plan=pl_1');
    });
});

describe('the Plan list page on mock data (#754)', () => {
    it('draws the header, crew strip and phases, a finished phase closed', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan');
        const el = page(dom, 'project-plan')!;
        expect(el.querySelector('[data-plan-title]')?.textContent).toBe('Plugin manifests v2');
        expect(el.querySelector('[data-plan-origin] a')?.getAttribute('href')).toBe('/projects/p_agentic/chats/c_restructure'); // inside the project (#929)
        expect(el.querySelector('[data-plan-progress-text]')?.textContent).toBe('5 of 14 done');
        expect(el.querySelector('[data-plan-view-link="list"]')?.getAttribute('aria-current')).toBe('page');
        expect(el.querySelector('[data-plan-view-link="board"]')?.getAttribute('href')).toBe('/projects/p_agentic/plan?view=board');
        expect(texts([...el.querySelectorAll('[data-plan-crew-name]')])).toEqual(['Atlas', 'Forge', 'Lint', 'Scout', 'You']);
        expect(el.querySelector('[data-plan-crew-role]')?.textContent).toBe('project manager');
        const heads = [...el.querySelectorAll<HTMLButtonElement>('[data-plan-phase-head]')];
        expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'true']);
        expect(text(el.querySelector('[data-plan-phase="2"] [data-plan-phase-count]'))).toBe('1/6');
        expect(el.querySelector('[data-plan-phase="1"] [data-plan-rows]')).toBeNull();
        const row = el.querySelector('[data-plan-item="10"]')!;
        expect(text(row.querySelector('[data-plan-item-meta]'))).toBe('touches plugins/model.ts · overlaps #9');
        expect(text(row.querySelector('[data-plan-owner-name]'))).toBe('Lint');
        expect(text(row.querySelector('[data-plan-owner-status]'))).toBe('working');
        expect(row.querySelector('[data-plan-item-refs]')?.getAttribute('aria-label')).toBe('4 refs');
        expect(text(row.querySelector('[data-plan-item-age]'))).toBe('9m');
        expect(text(el.querySelector('[data-plan-item="15"] [data-plan-owner-status]'))).toBe('not assigned');
        heads[0]!.click();
        await tick();
        expect(el.querySelectorAll('[data-plan-phase="1"] [data-plan-item]')).toHaveLength(4);
    });

    it('opens on the claimed item: facts, overlap warning, refs, done-when and activity', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan');
        const d = dom.querySelector<HTMLElement>('[data-plan-detail]')!;
        expect(d.getAttribute('data-plan-detail')).toBe('9');
        expect(dom.querySelector('[data-plan-item="9"] [data-plan-row]')?.getAttribute('aria-pressed')).toBe('true');
        expect(text(d.querySelector('[data-plan-detail-title]'))).toBe('Move KIND_ORDER into the manifest registry');
        expect(text(d.querySelector('[data-fact="assigned"]'))).toContain('by Atlas');
        expect(text(d.querySelector('[data-fact="claimed"]'))).toContain('lease 16 min left');
        expect(d.querySelector('[data-fact="runs"] a')?.getAttribute('href')).toBe('/tasks/t1-1');
        expect(text(d.querySelector('[data-fact="runs"]'))).toContain('alien01 · branch 604-mcp-tools');
        expect(text(d.querySelector('[data-fact="after"]'))).toBe('#8 done');
        expect(texts([...d.querySelectorAll('[data-fact="unblocks"] button')])).toEqual(['#11', '#13']);
        expect(texts([...d.querySelectorAll('[data-plan-overlap]')])).toEqual(['#10 (Lint) touches plugins/model.ts too.', '#11 (Forge) touches plugins/model.ts too.']);
        expect(d.querySelector('[data-plan-chip="pr"]')?.getAttribute('href')).toBe('/projects/p_agentic/work/pr:604');
        expect(d.querySelectorAll('[data-plan-done-when] li[data-checked="true"]')).toHaveLength(2);
        expect(d.querySelectorAll('[data-plan-activity] li')).toHaveLength(5);
        expect(text(d.querySelector('[data-plan-activity] li'))).toContain('Lint on #10 touches the same file');
    });

    it('opens a file ref’s hover card with the pinned lines', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan');
        const chip = dom.querySelector<HTMLButtonElement>('[data-plan-chip="file"]')!;
        expect(dom.querySelector('[data-plan-pin]')).toBeNull();
        chip.click();
        await tick();
        const pin = dom.querySelector('[data-plan-pin]')!;
        expect(chip.getAttribute('aria-expanded')).toBe('true');
        expect(text(pin.querySelector('[data-plan-pin-path]'))).toBe('apps/web/src/pages/plugins/model.ts');
        expect(text(pin.querySelector('[data-plan-pin-at]'))).toBe('L38–41 · main@4f2a9c1');
        expect([...pin.querySelectorAll('[data-plan-pin-line]')].map((l) => l.getAttribute('data-plan-pin-line'))).toEqual(['38', '39', '40', '41']);
        expect(pin.querySelector('[data-plan-pin-foot] a')?.getAttribute('href')).toBe('/sessions/s1/files');
        chip.click();
        await tick();
        expect(dom.querySelector('[data-plan-pin]')).toBeNull();
    });

    it('picks another item, closes the panel, and names refs typed in a comment', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan');
        dom.querySelector<HTMLButtonElement>('[data-fact="unblocks"] button')!.click();
        await tick();
        expect(dom.querySelector('[data-plan-detail]')?.getAttribute('data-plan-detail')).toBe('11');
        const input = dom.querySelector<HTMLInputElement>('[data-plan-comment] input')!;
        input.value = 'see #9 and pr:604 with @lint';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect([...dom.querySelectorAll('[data-plan-comment-refs] li')].map((l) => l.getAttribute('data-ref-kind'))).toEqual(['item', 'pr', 'member']);
        dom.querySelector<HTMLButtonElement>('[data-plan-detail-close]')!.click();
        await tick();
        expect(dom.querySelector('[data-plan-detail]')).toBeNull();
        expect(dom.querySelector('[data-plan-list]')?.getAttribute('data-detail')).toBe('closed');
        dom.querySelector<HTMLButtonElement>('[data-plan-item="12"] [data-plan-row]')!.click();
        await tick();
        expect(text(dom.querySelector('[data-plan-detail] [data-plan-options]'))).toContain('Fold a2a into connector');
    });

    it('opens on ?item= and narrows with search and Mine', async () => {
        const dom = await mountRoute('/projects/p_agentic/plan?item=13');
        expect(dom.querySelector('[data-plan-detail]')?.getAttribute('data-plan-detail')).toBe('13');
        const search = dom.querySelector<HTMLInputElement>('[data-plan-toolbar] input[type="search"]')!;
        search.value = 'SINGLE_SLOT';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect([...dom.querySelectorAll('[data-plan-item]')].map((i) => i.getAttribute('data-plan-item'))).toEqual(['11']);
        search.value = 'nothing like this';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await tick();
        expect(text(dom.querySelector('[data-plan-none]'))).toBe('No items match.');
    });

    it('says so for a project with no plan', async () => {
        const dom = await mountRoute('/projects/p_docs/plan');
        expect(dom.querySelector('[data-plan-list] [data-plan-head]')).toBeNull();
        expect(text(dom.querySelector('[data-plan-list]'))).toContain('No plan yet');
    });
});

describe('the plan feature’s registry entry and Overview card (#754)', () => {
    it('registers a section at /plan and an Overview card', () => {
        const views = featureViewsOf('agentic.feature.plan')!;
        expect(views.label).toBe('Plan');
        expect(views.Section).toBeDefined();
        expect(views.OverviewCard).toBe(PlanOverviewCard);
        expect(featureHref('p_event', 'agentic.feature.plan')).toBe('/projects/p_event/plan');
    });

    it('shows N of M done, the bar and the next three items', async () => {
        const dom = await mountAt('/projects/p_event', <PlanOverviewCard project={MOCK_EVENT_PROJECT} />);
        await tick();
        expect(text(dom.querySelector('[data-plan-card-done]'))).toBe('2 of 5 done');
        expect(dom.querySelector('[data-plan-bar="card"] > span')?.getAttribute('style')).toContain('40%');
        expect(texts([...dom.querySelectorAll('[data-plan-card-next] a')])).toEqual(['Book the venue', 'Choose catering', 'Send the invites']);
        expect(dom.querySelector('[data-plan-card-item="3"] a')?.getAttribute('href')).toBe('/projects/p_event/plan?item=3');
        expect(dom.querySelector('[data-overview-card-aside] a')?.getAttribute('href')).toBe('/projects/p_event/plan');
    });

    it('says so when the project has no plan', async () => {
        const dom = await mountAt('/projects/p_docs', <PlanOverviewCard project={{ ...MOCK_EVENT_PROJECT, id: 'p_docs' as never }} />);
        await tick();
        expect(text(dom.querySelector('[data-plan-card] [data-overview-empty]'))).toBe('No plan in this project yet.');
    });
});
