/**
 * The projects scaffold (#725) on mock data: every route under `/projects/:id` renders its page inside
 * `ProjectLayout`, its trail starts `Projects › <project>`, and the project's menu is what the sidebar draws under
 * `Projects`. Pages are checked by their `data-page` key, and a page still a stub says which issue builds it — so a
 * page issue replacing its stub never has to edit this file.
 */
import { describe, it, expect } from 'vitest';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import { createServerRouter } from '../../src/router';
import { PROJECT_ROUTE_NAMES, projectMenuFor } from '../../src/pages/projects/layout/menu';
import { pullNumberOf } from '../../src/pages/projects/work/WorkItemRoute';
import { planViewOf } from '../../src/pages/projects/features/plan/Plan';
import { mountRoute, page, texts } from '../pages/mount';

/** Resolve a path to the route the topbar and the menu read. */
async function routeAt(path: string) {
    const router = createServerRouter(path);
    await router.isReady();
    const r = router.currentRoute;
    return { name: r.name, path: r.path, params: r.params as Record<string, string> };
}

const trailAt = async (path: string): Promise<string[]> => {
    const route = await routeAt(path);
    return trailFor(route, topbarFor(route)).map((c) => c.label);
};

/** A page still a stub names its issue. */
function expectStubOrPage(el: HTMLElement): void {
    const stub = el.querySelector<HTMLElement>('[data-stub]');
    if (stub) expect(stub.textContent).toMatch(/^Coming in #\d+\.$/);
}

const PAGES: readonly (readonly [path: string, name: string, page: string, trail: readonly string[]])[] = [
    ['/projects/p_agentic', 'project', 'project-overview', ['Projects', 'agentic']],
    ['/projects/p_agentic/chats', 'project-chats', 'project-chats', ['Projects', 'agentic', 'Chats']],
    ['/projects/p_agentic/work', 'project-work', 'project-work', ['Projects', 'agentic', 'Work']],
    ['/projects/p_agentic/work/t_91a0', 'project-work-item', 'project-work-item', ['Projects', 'agentic', 'Work', 't_91a0']],
    ['/projects/p_agentic/work/pr:603', 'project-work-item', 'project-pull', ['Projects', 'agentic', 'Work', 'PR #603']],
    ['/projects/p_agentic/requests', 'project-requests', 'project-requests', ['Projects', 'agentic', 'Requests']],
    ['/projects/p_agentic/plan', 'project-plan', 'project-plan', ['Projects', 'agentic', 'Plan']],
    ['/projects/p_agentic/settings/members', 'project-settings', 'project-settings', ['Projects', 'agentic', 'Settings', 'Members']],
    ['/projects/p_agentic/code', 'project-code', 'project-feature', ['Projects', 'agentic', 'Code']]
];

describe('the project routes (#725)', () => {
    it.each(PAGES)('%s renders %s inside the project layout, crumbed from Projects › agentic', async (path, name, key, trail) => {
        expect((await routeAt(path)).name).toBe(name);
        expect(PROJECT_ROUTE_NAMES.has(name)).toBe(true);
        const dom = await mountRoute(path);
        const layout = dom.querySelector<HTMLElement>('[data-project-layout="p_agentic"]');
        expect(layout, path).not.toBeNull();
        const el = page(layout!, key);
        expect(el, path).not.toBeNull();
        expectStubOrPage(el!);
        expect(await trailAt(path)).toEqual(trail);
    });

    it('every settings tab renders under the tab strip, the current one marked', async () => {
        for (const tab of ['general', 'members', 'folders', 'connectors', 'features', 'manager']) {
            const dom = await mountRoute(`/projects/p_agentic/settings/${tab}`);
            const settings = page(dom, 'project-settings')!;
            expect(settings, tab).not.toBeNull();
            expect(texts([...settings.querySelectorAll('[data-settings-tabs] a')])).toEqual(['General', 'Members', 'Folders', 'Connectors', 'Features', 'Project manager']);
            expect(settings.querySelector('[data-settings-tabs] a[aria-current="page"]')?.getAttribute('href')).toBe(`/projects/p_agentic/settings/${tab}`);
            expectStubOrPage(settings);
        }
        // General is today's project form until #733.
        const general = await mountRoute('/projects/p_agentic/settings/general');
        expect(general.querySelector<HTMLInputElement>('input[name="project-name"]')!.value).toBe('agentic');
        const unknown = await mountRoute('/projects/p_agentic/settings/nope');
        expect(unknown.querySelector('[data-settings-tabs] a[aria-current="page"]')).toBeNull();
        expect(unknown.textContent).toContain('No such settings tab');
    });

    it('the plan section picks its view from ?view=, the list by default', async () => {
        for (const view of ['list', 'board', 'graph'] as const) {
            const dom = await mountRoute(`/projects/p_agentic/plan?view=${view}`);
            expect(dom.querySelector(`[data-plan-view="${view}"]`), view).not.toBeNull();
        }
        expect(planViewOf('kanban')).toBe('list');
        expect(planViewOf(undefined)).toBe('list');
    });

    it('a work item named pr:<n> is its pull request', () => {
        expect(pullNumberOf('pr:603')).toBe(603);
        expect(pullNumberOf('t_91a0')).toBeUndefined();
        expect(pullNumberOf('pr:')).toBeUndefined();
    });

    it('an unknown project is not found, inside no layout', async () => {
        const dom = await mountRoute('/projects/p_nope/work');
        expect(dom.querySelector('[data-project-layout]')).toBeNull();
        expect(page(dom, 'project-missing')).not.toBeNull();
        expect(dom.textContent).toContain('No project with that id');
    });

    it('/projects/links is its own page, not a project id, crumbed Projects › Links', async () => {
        expect((await routeAt('/projects/links')).name).toBe('projects-links');
        const dom = await mountRoute('/projects/links');
        expect(page(dom, 'projects-links')).not.toBeNull();
        expect(await trailAt('/projects/links')).toEqual(['Projects', 'Links']);
    });

    it('the old /projects list still renders (#729 replaces it)', async () => {
        const dom = await mountRoute('/projects');
        expect(page(dom, 'projects')).not.toBeNull();
        expect(dom.querySelectorAll('[data-project-row]').length).toBe(2);
    });
});

describe('the project menu (#725)', () => {
    it('is drawn only on a project route: Core, Features, Settings', async () => {
        expect(projectMenuFor(await routeAt('/projects'))).toBeUndefined();
        expect(projectMenuFor(await routeAt('/projects/new'))).toBeUndefined();
        expect(projectMenuFor(await routeAt('/chats'))).toBeUndefined();
        expect(projectMenuFor(await routeAt('/projects/p_nope'))).toBeUndefined();
        const menu = projectMenuFor(await routeAt('/projects/p_agentic/work'))!;
        expect(menu.map((g) => g.label)).toEqual(['agentic', 'Features', 'Settings']);
        // The sample agentic project has a coordinator, so it has Requests.
        expect(menu[0]!.items.map((i) => i.href)).toEqual(['/projects/p_agentic', '/projects/p_agentic/chats', '/projects/p_agentic/work', '/projects/p_agentic/requests']);
        // Git draws its Code section (#746), Plan its own (#923 turns it on in the sample project).
        expect(menu[1]!.items.map((i) => [i.href, i.label])).toEqual([['/projects/p_agentic/code', 'Code'], ['/projects/p_agentic/plan', 'Plan']]);
        expect(menu[2]!.items.map((i) => i.label)).toEqual(['General', 'Members', 'Folders', 'Connectors', 'Features', 'Project manager']);
    });
});
