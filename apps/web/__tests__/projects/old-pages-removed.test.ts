/**
 * The pre-redesign projects pages are gone (#767; PRJ-18): no source file of the #333 list and form is left, and the
 * crumbs they used to register come from their new owners — `project-new` from `new/NewProject.tsx`, `project` from
 * `overview/Overview.tsx` — once the route table is loaded. #767 owns this file.
 */
import { describe, it, expect } from 'vitest';
import { topbarFor } from '../../src/components/topbar';
import { trailFor } from '../../src/crumbs';
import { routes } from '../../src/router';

const pages = Object.keys(import.meta.glob('../../src/pages/**/*.{ts,tsx}'));

describe('the old projects pages (#767)', () => {
    it('no source file of the old list and form is left', () => {
        expect(pages.length).toBeGreaterThan(0);
        const gone = ['pages/Projects.tsx', 'pages/projects/ProjectsView.tsx', 'pages/projects/ProjectForm.tsx', 'pages/projects/LiveProjects.tsx'];
        for (const path of gone) expect(pages.some((p) => p.endsWith(`/src/${path}`)), path).toBe(false);
    });

    it('the route table still carries /projects/new and /projects/:id', () => {
        expect(routes.map((r) => r.name)).toEqual(expect.arrayContaining(['projects', 'project-new', 'project']));
    });

    it('the crumbs come from the new pages: New project, and the project’s name on its home', () => {
        expect(topbarFor({ name: 'project-new', path: '/projects/new', params: {} })?.crumb).toBe('New project');
        const home = { name: 'project', path: '/projects/p_agentic', params: { id: 'p_agentic' } };
        expect(topbarFor(home)?.crumb).toBe('agentic');
        expect(trailFor(home, topbarFor(home)).map((c) => c.label)).toEqual(['Projects', 'agentic']);
        // The index keeps New project in its own head; the topbar adds no action.
        expect(topbarFor({ name: 'projects', path: '/projects', params: {} })?.actions).toBeUndefined();
    });
});
