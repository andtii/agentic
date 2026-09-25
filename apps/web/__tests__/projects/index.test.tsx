/**
 * `/projects` on mock data (#333; split out of `pages/projects.test.tsx` by the scaffold #725): the list with its
 * place badges, members and features, and the project routes' topbar crumbs. #729 owns this file.
 */
import { describe, it, expect } from 'vitest';
import { topbarFor } from '../../src/components/topbar';
import { text } from '../pages/helpers';
import { mountRoute, page, texts } from '../pages/mount';

describe('/projects (mock)', () => {
    it('lists both projects with a badge per environment that has a folder, the members and the enabled features; the topbar offers New project', async () => {
        const dom = await mountRoute('/projects');
        expect(page(dom, 'projects')).not.toBeNull();
        const rows = [...dom.querySelectorAll<HTMLElement>('[data-project-row]')];
        expect(rows.map((r) => r.getAttribute('data-project-row'))).toEqual(['p_agentic', 'p_docs']);
        // The machine's folder by the machine's name, an override by its environment (#702).
        expect(texts([...rows[0]!.querySelectorAll('.project-env')])).toEqual(['alien01', 'alien01 / personal']);
        expect(texts([...rows[0]!.querySelectorAll('.project-feature')])).toEqual(['Git']);
        expect(rows[0]!.querySelectorAll('[data-member-tiles] [data-scope="avatar"][data-part="root"]').length).toBe(3);
        expect(texts([...rows[1]!.querySelectorAll('.project-env')])).toEqual(['alien01 / personal']);
        expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/projects/p_agentic');
        expect(text(topbarFor({ name: 'projects', path: '/projects', params: {} })?.actions?.() as never)).toBe('');
        expect(topbarFor({ name: 'project', path: '/projects/p_agentic', params: { id: 'p_agentic' } })?.crumb).toBe('agentic');
        expect(topbarFor({ name: 'project-new', path: '/projects/new', params: {} })?.crumb).toBe('New project');
    });
});
