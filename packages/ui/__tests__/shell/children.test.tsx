/**
 * `NavItem.children` (#725): an entry's sub-menu drawn minimally — its blocks indented under the entry, the first
 * without a heading, empty blocks dropped — and the page marked on the sub-item it is on (the longest match), not on
 * the entry. #727 draws the real visuals and owns this folder.
 */
import { AppShell, type NavGroup } from '../../src/index';
import { installThemes } from '../../src/design-system';
import { mount, tick } from '../helpers';

beforeAll(() => installThemes());

const menu: NavGroup[] = [
    { label: 'agentic', items: [{ href: '/projects/p1', label: 'Overview' }, { href: '/projects/p1/work', label: 'Work', badge: 2 }] },
    { label: 'Features', items: [] },
    { label: 'Settings', items: [{ href: '/projects/p1/settings/general', label: 'General' }] }
];

const groups: NavGroup[] = [{ label: 'Primary', items: [{ href: '/', label: 'Home' }, { href: '/projects', label: 'Projects', children: menu }] }];

const current = (host: ParentNode): string[] => [...host.querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href') ?? '');

describe('AppShell nav children', () => {
    it('draws the non-empty blocks under the entry, headed after the first', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1/work" />);
        await tick();
        const sub = host.querySelector<HTMLElement>('[data-nav-children]')!;
        expect(sub).not.toBeNull();
        expect([...sub.querySelectorAll('[data-nav-block]')].map((b) => b.getAttribute('data-nav-block'))).toEqual(['agentic', 'Settings']);
        expect([...sub.querySelectorAll('[data-nav-block-heading]')].map((h) => h.textContent)).toEqual(['Settings']);
        expect([...sub.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/projects/p1', '/projects/p1/work', '/projects/p1/settings/general']);
        // A sub-item's badge renders like Home's.
        expect(sub.querySelector('[data-scope="badge"][data-part="root"]')?.textContent).toBe('2');
    });

    it('marks the longest matching sub-item as the page, not the entry or Overview', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1/work" />);
        await tick();
        expect(current(host)).toEqual(['/projects/p1/work']);
    });

    it('marks Overview on the project root, and the entry itself when no sub-item matches', async () => {
        const root = mount(<AppShell groups={groups} currentPath="/projects/p1" />);
        await tick();
        expect(current(root)).toEqual(['/projects/p1']);
        const list = mount(<AppShell groups={[{ label: 'Primary', items: [{ href: '/projects', label: 'Projects' }] }]} currentPath="/projects" />);
        await tick();
        expect(current(list)).toEqual(['/projects']);
        expect(list.querySelector('[data-nav-children]')).toBeNull();
    });
});
