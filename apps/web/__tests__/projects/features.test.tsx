/**
 * Settings › Features (#736, PRJ-07): the on-list with slot marks and switches, the Add a feature catalogue (search,
 * category chips, a `needs` the project lacks shown in place of Add), the detail panel (what each slot adds, presets,
 * settings, Remove from project), the view model, and enable / remove round-tripping through `Workspace.upsertProject`
 * on the live wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ProjectFeatureManifest, ProjectPatch, ProjectRecord } from '@agentic/core';
import { defineRegistry } from '@agentic/platform';
import { MOCK_FEATURE_CATALOGUE } from '../../src/mock/projects/features';
import { PROJECTS } from '../../src/mock/workspace';
import { FeaturesView } from '../../src/pages/projects/settings/features/FeaturesView';
import { applyFeaturesPatch, catalogueTiles, categoryChips, enabledEntries, featureEntriesOf, featurePatch, removePatch, slotLines, unmetNeeds } from '../../src/pages/projects/settings/features/model';
import { saveProjectWith } from '../../src/pages/projects/LiveProjects';
import { projectHead } from '../../src/pages/projects/head';
import { actor } from '@sigx/actors';
import { clientDefs } from '../../src/actors/client';
import { workspaceKeyOf } from '../../src/actors/keys';
import { mountAt, setText, text } from '../pages/helpers';
import { mountRoute } from '../pages/mount';
import { USER, mountLive, startLive, until, type LiveHarness } from '../pages/live-harness';

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const GIT = 'agentic.feature.git';
const PLAN = 'mock.feature.plan';
const byId = (id: string) => MOCK_FEATURE_CATALOGUE.find((e) => e.id === id)!;
const agentic = PROJECTS.find((p) => p.id === 'p_agentic')!;
const bare: ProjectRecord = { ...agentic, folders: {}, features: { [PLAN]: {} } };
const rows = (dom: ParentNode): string[] => [...dom.querySelectorAll('[data-feature-row]')].map((r) => r.getAttribute('data-feature-row')!);
const tiles = (dom: ParentNode): string[] => [...dom.querySelectorAll('[data-feature-tile]')].map((r) => r.getAttribute('data-feature-tile')!);
const tile = (dom: ParentNode, id: string): HTMLElement => dom.querySelector<HTMLElement>(`[data-feature-tile="${id}"]`)!;

describe('features view model (#736)', () => {
    it('describes the slots a feature fills, in mark order, in the plugin’s words or from its ui block', () => {
        expect(slotLines(byId(PLAN)).map((l) => l.title)).toEqual(['Section', 'Overview card', 'Work stages', 'Chat context', 'Agent instructions and tools']);
        expect(slotLines(byId('mock.feature.incidents')).map((l) => l.text)).toEqual(['Incidents: a page in this project’s sidebar.', 'Work items move through Triage → Fix → Review.']);
        expect(slotLines(byId('mock.feature.docs')).map((l) => l.slot)).toEqual(['section', 'tools']);
    });

    it('a folder need is unmet on a project without a folder', () => {
        expect(unmetNeeds(byId(GIT), bare)).toEqual(['folder']);
        expect(unmetNeeds(byId(GIT), agentic)).toEqual([]);
        expect(unmetNeeds(byId(PLAN), bare)).toEqual([]);
    });

    it('the catalogue leaves out what is on and filters by search and category', () => {
        expect(catalogueTiles(MOCK_FEATURE_CATALOGUE, bare, { query: '', category: 'all' })).not.toContainEqual(byId(PLAN));
        expect(catalogueTiles(MOCK_FEATURE_CATALOGUE, bare, { query: 'rsvp', category: 'all' }).map((e) => e.name)).toEqual(['Guest list']);
        expect(catalogueTiles(MOCK_FEATURE_CATALOGUE, bare, { query: '', category: 'code' }).map((e) => e.id)).toEqual([GIT]);
        expect(categoryChips(MOCK_FEATURE_CATALOGUE).map((c) => c.label)).toEqual(['All', 'Planning', 'Events', 'Knowledge', 'Code', 'Ops']);
    });

    it('enable, save and remove are one feature key of a patch; the mock merge follows upsertProject', () => {
        expect(featurePatch(agentic, PLAN, { template: 'sprint' })).toEqual({ id: 'p_agentic', features: { [PLAN]: { template: 'sprint' } } });
        expect(removePatch(agentic, GIT)).toEqual({ id: 'p_agentic', features: { [GIT]: null } });
        expect(Object.keys(applyFeaturesPatch(agentic.features, { features: { [GIT]: null, [PLAN]: {} } }))).toEqual([PLAN]);
    });

    it('a feature the catalogue does not know is still listed by its id', () => {
        expect(enabledEntries([], { features: { 'x.gone': {} } })).toMatchObject([{ id: 'x.gone', name: 'x.gone' }]);
    });

    it('joins the Registry views with their settings schema and the build’s presets', () => {
        const [git] = featureEntriesOf(
            [{ id: GIT, name: 'Git', description: 'd', version: '1', enabled: true, builtin: true, ui: { section: { label: 'Code', icon: 'code' } }, category: 'code', needs: ['folder'], presets: [], usedBy: 1 }],
            [],
            { [GIT]: { manifest: byId(GIT) as never, presets: [{ id: 'p', label: 'P', settings: {} }], instructions: () => 'x' } }
        );
        expect(git).toMatchObject({ id: GIT, needs: ['folder'], presets: [{ id: 'p' }], instructions: true });
    });
});

describe('/projects/:id/settings/features (mock)', () => {
    it('lists what is on with slot marks, the catalogue of the rest and the first feature’s detail', async () => {
        const dom = await mountRoute('/projects/p_agentic/settings/features');
        expect(rows(dom)).toEqual([GIT]);
        const marks = dom.querySelector(`[data-feature-row="${GIT}"] [data-ag-project="slot-marks"]`)!;
        expect(marks.getAttribute('data-used')).toContain('section');
        expect(tiles(dom)).not.toContain(GIT);
        expect(tiles(dom)).toContain(PLAN);
        expect(dom.querySelector('[data-feature-detail]')!.getAttribute('data-feature-detail')).toBe(GIT);
        expect(text(dom.querySelector('[data-feature-remove]'))).toContain('Items are kept for 30 days');
    });

    it('search and category chips narrow the tiles', async () => {
        const dom = await mountRoute('/projects/p_agentic/settings/features');
        setText(dom.querySelector<HTMLInputElement>('input[name="feature-search"]')!, 'hours');
        await settle();
        expect(tiles(dom)).toEqual(['mock.feature.timesheets']);
        setText(dom.querySelector<HTMLInputElement>('input[name="feature-search"]')!, '');
        await settle();
        [...dom.querySelectorAll<HTMLButtonElement>('[data-filter-chips] button')].find((b) => b.textContent?.trim() === 'Planning')!.click();
        await settle();
        expect(tiles(dom)).toEqual([PLAN, 'mock.feature.milestones']);
    });

    it('Add puts a feature on and opens it; its preset fills the settings; Remove takes it off', async () => {
        const dom = await mountRoute('/projects/p_agentic/settings/features');
        tile(dom, PLAN).querySelector<HTMLButtonElement>('button[aria-label="Add Plan"]')!.click();
        await settle();
        expect(rows(dom)).toEqual([GIT, PLAN]);
        const detail = dom.querySelector<HTMLElement>(`[data-feature-detail="${PLAN}"]`)!;
        expect([...detail.querySelectorAll('[data-feature-slot] strong')].map((s) => s.textContent)).toEqual(['Section', 'Overview card', 'Work stages', 'Chat context', 'Agent instructions and tools']);
        const preset = detail.querySelector<HTMLSelectElement>(`select[name="feature-${PLAN}-preset"]`)!;
        preset.value = 'sprint';
        preset.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(detail.querySelector<HTMLSelectElement>(`[name="feature-${PLAN}.template"]`)!.value).toBe('sprint');
        [...detail.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Remove from project')!.click();
        await settle();
        expect(rows(dom)).toEqual([GIT]);
        expect(tiles(dom)).toContain(PLAN);
    });
});

describe('FeaturesView', () => {
    it('shows NEEDS A FOLDER in place of Add on a project without a folder, and writes each change as a patch', async () => {
        const patches: ProjectPatch[] = [];
        const dom = await mountAt('/', <FeaturesView project={bare} entries={MOCK_FEATURE_CATALOGUE} save={async (p: ProjectPatch) => { patches.push(p); }} />);
        await settle();
        expect(tile(dom, GIT).hasAttribute('data-unmet')).toBe(true);
        expect(text(tile(dom, GIT).querySelector('[data-feature-needs]'))).toBe('NEEDS A FOLDER');
        expect(tile(dom, GIT).querySelector('button[aria-label="Add Git"]')).toBeNull();
        tile(dom, 'mock.feature.docs').querySelector<HTMLButtonElement>('button[aria-label="Add Docs"]')!.click();
        await settle();
        expect(patches).toEqual([{ id: 'p_agentic', features: { 'mock.feature.docs': {} } }]);
    });

    it('shows the save’s refusal', async () => {
        const dom = await mountAt('/', <FeaturesView project={bare} entries={MOCK_FEATURE_CATALOGUE} save={async () => { throw new Error('feature x: nope'); }} />);
        await settle();
        tile(dom, 'mock.feature.docs').querySelector<HTMLButtonElement>('button[aria-label="Add Docs"]')!.click();
        await settle();
        expect(text(dom.querySelector('[data-features-error]'))).toContain('feature x: nope');
    });
});

describe('/projects/:id/settings/features (live)', () => {
    let h: LiveHarness | undefined;
    afterEach(async () => {
        projectHead.value = null;
        await h?.stop();
        h = undefined;
    });

    const plan: ProjectFeatureManifest = {
        id: 'agentic.project.plan',
        name: 'Plan',
        description: 'Milestones and a work list',
        version: '1.0.0',
        kind: 'project-feature',
        capabilities: [],
        config: { type: 'object' },
        projectSettings: { type: 'object', properties: { agentsMayTick: { type: 'boolean', title: 'Agents may tick items', default: false } } },
        permissions: [],
        compat: { platform: '*', core: '*' },
        category: 'planning',
        ui: { overviewCard: { title: 'Plan' }, tools: ['plan'] }
    };

    it('enable and remove round-trip through upsertProject', { timeout: 20_000 }, async () => {
        h = await startLive(undefined, { actors: [defineRegistry({ catalogue: [plan] })] });
        const { id } = await saveProjectWith(clientDefs(), USER, { name: 'event', members: { agentIds: [], coordinator: null }, folders: {}, connectors: [], features: {} });
        const dom = await mountLive(`/projects/${id}/settings/features`, h);
        await until(() => dom.querySelector(`[data-feature-tile="${plan.id}"]`) !== null, 'the catalogue tile');
        dom.querySelector<HTMLButtonElement>('button[aria-label="Add Plan"]')!.click();
        await until(() => dom.querySelector(`[data-feature-row="${plan.id}"]`) !== null, 'the feature on');
        const stored = (): Promise<readonly ProjectRecord[]> => actor(clientDefs().Workspace, workspaceKeyOf(USER)).projects();
        expect(Object.keys((await stored()).find((p) => p.id === id)!.features)).toEqual([plan.id]);
        [...dom.querySelectorAll<HTMLButtonElement>(`[data-feature-detail="${plan.id}"] button`)].find((b) => b.textContent?.trim() === 'Remove from project')!.click();
        await until(() => dom.querySelector(`[data-feature-row="${plan.id}"]`) === null, 'the feature off');
        expect((await stored()).find((p) => p.id === id)!.features).toEqual({});
    });
});
