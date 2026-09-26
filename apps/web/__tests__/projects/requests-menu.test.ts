/**
 * The project menu's Requests item draws the requests waiting on a person as a needs-you badge (#944; HANDOFF
 * "Navigation inside a project"): `counts.requests` when > 0, nothing at 0 or absent, and no item without a manager.
 */
import { describe, it, expect } from 'vitest';
import { projectMenu, type ProjectMenuItem } from '../../src/pages/projects/layout/menu';

const requestsOf = (menu: ReturnType<typeof projectMenu>) =>
    (menu[0]!.items as readonly ProjectMenuItem[]).find((i) => i.label === 'Requests');

describe('Requests needs-you badge (#944)', () => {
    const managed = { id: 'p1', name: 'one', manager: true };

    it('draws badge 2 for a project with a manager and two requests waiting', () => {
        expect(requestsOf(projectMenu(managed, { requests: 2 }))).toEqual({ href: '/projects/p1/requests', label: 'Requests', icon: 'delegate', badge: 2 });
    });

    it('draws no badge at 0 or when the count is absent', () => {
        const plain = { href: '/projects/p1/requests', label: 'Requests', icon: 'delegate' };
        expect(requestsOf(projectMenu(managed, { requests: 0 }))).toEqual(plain);
        expect(requestsOf(projectMenu(managed))).toEqual(plain);
    });

    it('draws no Requests item without a manager, whatever the count', () => {
        expect(requestsOf(projectMenu({ id: 'p1', name: 'one' }, { requests: 3 }))).toBeUndefined();
    });
});
