/**
 * The project menu's FEATURES block from the manifests (#941): one item per enabled feature whose manifest declares a
 * `ui.section` — its label, its icon as a kit glyph, and a count only when its badge is `open-items` — whether or not
 * the build draws a page for it; the registry only supplies views. And the catalogue's five category chips, always.
 */
import { describe, it, expect } from 'vitest';
import { GIT_FEATURE_ID } from '@agentic/plugins-git';
import { PLAN_FEATURE_ID } from '@agentic/plugins-plan';
import { featureHref, featureIcon, featureSectionOf, featureViewsOf } from '../../src/pages/projects/features/registry';
import { projectMenu, projectMenuFor, type ProjectMenuItem } from '../../src/pages/projects/layout/menu';
import { categoryChips } from '../../src/pages/projects/settings/features/model';

const featuresOf = (menu: ReturnType<typeof projectMenu>) => menu.find((g) => g.label === 'Features')!.items as readonly ProjectMenuItem[];

describe('FEATURES from ui.section (#941)', () => {
    it('draws each enabled feature’s section as its manifest declares it, in the project’s order', () => {
        const menu = projectMenu({ id: 'p1', name: 'one', features: [PLAN_FEATURE_ID, 'not.in.this.build', GIT_FEATURE_ID] }, { features: { [PLAN_FEATURE_ID]: 4, [GIT_FEATURE_ID]: 2 } });
        expect(featuresOf(menu)).toEqual([
            { href: '/projects/p1/plan', label: 'Plan', icon: 'check', count: 4 },
            // Git's section has no badge: its count is not drawn; its `code` icon is the kit's terminal.
            { href: '/projects/p1/code', label: 'Code', icon: 'terminal' }
        ]);
    });

    it('draws nothing for a feature without a section, and the mock project’s menu comes from the manifests', () => {
        expect(featuresOf(projectMenu({ id: 'p1', name: 'one', features: [] }))).toEqual([]);
        const agentic = projectMenuFor({ name: 'project', path: '/projects/p_agentic', params: { id: 'p_agentic' } })!;
        expect(featuresOf(agentic).map((i) => [i.label, i.icon])).toEqual([['Code', 'terminal'], ['Plan', 'check']]);
    });

    it('reads label, icon and badge from a ui block; a page the build lacks lives at f/<feature>', () => {
        expect(featureSectionOf('x', { section: { label: 'Calendar', icon: 'calendar', badge: 'open-items' } })).toEqual({ label: 'Calendar', icon: 'schedules', badge: 'open-items' });
        expect(featureSectionOf('x', { section: { label: 'Docs', icon: 'file' } })).toEqual({ label: 'Docs', icon: 'file', badge: 'none' });
        expect(featureSectionOf('x', { overviewCard: { title: 'Hours' } })).toBeUndefined();
        expect(featureIcon('no-such-glyph')).toBe('plugins');
        expect(featureIcon(undefined)).toBe('plugins');
        expect(featureHref('p1', 'mock.feature.docs')).toBe('/projects/p1/f/mock.feature.docs');
    });

    it('labels a feature’s views from its manifest', () => {
        expect(featureViewsOf(PLAN_FEATURE_ID)?.label).toBe('Plan');
        expect(featureViewsOf(GIT_FEATURE_ID)?.label).toBe('Code');
        expect(featureViewsOf('not.in.this.build')).toBeUndefined();
    });
});

describe('category chips (#941)', () => {
    it('are all five, whatever the catalogue has', () => {
        expect(categoryChips().map((c) => c.value)).toEqual(['all', 'planning', 'events', 'knowledge', 'code', 'ops']);
    });
});
