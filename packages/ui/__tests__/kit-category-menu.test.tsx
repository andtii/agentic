/**
 * `CategoryMenu` (#629): a labelled `<nav>` on zero's `NavList`, groups under
 * a mono label, 34 px links, `aria-current="page"` on the current item only,
 * a dim but clickable `0`, and the amber badge count.
 */
import { CategoryMenu, type CategoryMenuGroup } from '@agentic/ui';
import { mount } from './helpers';

const groups: readonly CategoryMenuGroup[] = [
    {
        items: [
            { id: 'all', label: 'All plugins', count: 14, href: '/plugins' },
            { id: 'attention', label: 'Needs attention', count: 2, badge: true, href: '/plugins?kind=attention' }
        ]
    },
    {
        label: 'Runtimes',
        items: [
            { id: 'harness', label: 'Harness', count: 3, href: '/plugins?kind=harness' },
            { id: 'remote', label: 'Remote agents', count: 0, href: '/plugins?kind=remote' }
        ]
    }
];

const link = (root: ParentNode, id: string): HTMLAnchorElement => root.querySelector<HTMLAnchorElement>(`a[data-category="${id}"]`)!;
const count = (root: ParentNode, id: string): HTMLElement => link(root, id).querySelector<HTMLElement>('[data-count]')!;

describe('CategoryMenu', () => {
    it('is one labelled navigation landmark with a link per item', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} current="all" />);
        const navs = root.querySelectorAll('nav');
        expect(navs).toHaveLength(1);
        expect(navs[0]!.getAttribute('aria-label')).toBe('Plugin categories');
        const links = [...root.querySelectorAll('a')];
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['/plugins', '/plugins?kind=attention', '/plugins?kind=harness', '/plugins?kind=remote']);
        expect(links.every((a) => a.getAttribute('style')!.includes('block-size: 34px'))).toBe(true);
    });

    it('puts aria-current="page" on the current item only', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} current="harness" />);
        const current = [...root.querySelectorAll('[aria-current]')];
        expect(current).toHaveLength(1);
        expect(current[0]).toBe(link(root, 'harness'));
        expect(current[0]!.getAttribute('aria-current')).toBe('page');
        expect(link(root, 'all').hasAttribute('aria-current')).toBe(false);
    });

    it('marks nothing current when current matches no item', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} />);
        expect(root.querySelectorAll('[aria-current]')).toHaveLength(0);
    });

    it('labels a group with a mono heading, and leaves an unlabelled group without one', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} current="all" />);
        const headings = [...root.querySelectorAll<HTMLElement>('[data-category-heading]')];
        expect(headings.map((h) => h.textContent)).toEqual(['Runtimes']);
        expect(headings[0]!.getAttribute('style')).toContain('font-family: var(--font-mono)');
        const [unlabelled, labelled] = root.querySelectorAll('[data-scope="nav-list"][data-part="group"]');
        expect(unlabelled!.hasAttribute('aria-labelledby')).toBe(false);
        expect(labelled!.getAttribute('aria-labelledby')).toBe(headings[0]!.id);
    });

    it('shows a mono count; a 0 is text-dim and stays a clickable link', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} current="all" />);
        expect(count(root, 'harness').textContent).toBe('3');
        expect(count(root, 'harness').getAttribute('style')).toContain('font-family: var(--font-mono)');
        const empty = link(root, 'remote');
        expect(count(root, 'remote').textContent).toBe('0');
        expect(count(root, 'remote').getAttribute('data-tone')).toBe('dim');
        expect(count(root, 'remote').getAttribute('style')).toContain('color: var(--ag-text-dim)');
        expect(empty.hasAttribute('data-empty')).toBe(true);
        expect(empty.getAttribute('href')).toBe('/plugins?kind=remote');
        expect(empty.hasAttribute('aria-disabled')).toBe(false);
    });

    it('paints a badge count as the amber needs-you badge, and a zero badge as a plain dim count', () => {
        const root = mount(<CategoryMenu label="Plugin categories" groups={groups} current="all" />);
        const badge = count(root, 'attention');
        expect(badge.textContent).toBe('2');
        expect(badge.getAttribute('data-tone')).toBe('needs-you');
        expect(badge.getAttribute('style')).toContain('background: var(--color-warning)');
        const none = mount(<CategoryMenu label="c" groups={[{ items: [{ id: 'attention', label: 'Needs attention', count: 0, badge: true, href: '#' }] }]} />);
        expect(count(none, 'attention').getAttribute('data-tone')).toBe('dim');
    });
});
