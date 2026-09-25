import { describe, expect, it } from 'vitest';
import { createServerRouter, routes } from '../../src/router';
import { CRUMBS } from '../../src/crumbs';
import { featureHref } from '../../src/pages/projects/features/registry';
import { gitSectionHref, GIT_FEATURE_ID } from '../../src/pages/projects/features/git/model';

const at = async (path: string) => {
    const router = createServerRouter(path);
    await router.isReady();
    return router.currentRoute;
};

describe('/projects/:id/code, the git section (#841)', () => {
    it('is a literal route before `f/:feature`, crumbed from Projects', () => {
        const index = (path: string) => routes.findIndex((r) => r.path === path);
        expect(index('/projects/:id/code')).toBeGreaterThan(-1);
        expect(index('/projects/:id/code')).toBeLessThan(index('/projects/:id/f/:feature'));
        expect(index('/projects/:id/f/agentic.feature.git')).toBeLessThan(index('/projects/:id/f/:feature'));
        expect(CRUMBS['project-code']!.href).toBe('/projects');
    });

    it('resolves `/projects/p1/code` to the code route', async () => {
        const route = await at('/projects/p1/code');
        expect(route.name).toBe('project-code');
        expect(route.params.id).toBe('p1');
    });

    it('redirects the old `f/agentic.feature.git` address to `/code`', async () => {
        const route = await at('/projects/p1/f/agentic.feature.git');
        expect(route.name).toBe('project-code');
        expect(route.path).toBe('/projects/p1/code');
        // Another feature still lands on its `f/<feature>` section.
        expect((await at('/projects/p1/f/acme.feature.docs')).name).toBe('project-feature');
    });

    it('points the sidebar item and the overview card at `/code`', () => {
        expect(featureHref('p1', GIT_FEATURE_ID)).toBe('/projects/p1/code');
        expect(gitSectionHref('p1')).toBe('/projects/p1/code');
    });
});
