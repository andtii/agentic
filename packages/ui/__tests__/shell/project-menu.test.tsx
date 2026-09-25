/**
 * The project sub-menu's visuals (#727, HANDOFF "Navigation inside a project"): the switcher emitting `switch`,
 * sub-item counts and `needs-you` badges, the mono FEATURES label, the divider before Settings, 15 px glyphs and the
 * page on the sub-item it is on (`aria-current="page"`). The phone sheet renders the same tree — the navigation
 * renders once, in one Drawer.
 */
import { AppShell, type NavGroup, type NavItem } from '../../src/index';
import { installThemes } from '../../src/design-system';
import { mount, tick } from '../helpers';

beforeAll(() => installThemes());

const menu: NavGroup[] = [
    {
        label: 'agentic',
        items: [
            { href: '/projects/p1', label: 'Overview', icon: 'home' },
            { href: '/projects/p1/chats', label: 'Chats', count: 5 },
            { href: '/projects/p1/work', label: 'Work', badge: 3, count: 12 },
            { href: '/projects/p1/requests', label: 'Requests' }
        ]
    },
    { label: 'Features', items: [{ href: '/projects/p1/f/git', label: 'Code' }, { href: '/projects/p1/plan', label: 'Plan', count: 9 }] },
    { label: 'Settings', divider: true, items: [{ href: '/projects/p1/settings/general', label: 'Settings' }] }
];

const projects: NavItem = { href: '/projects', label: 'Projects', children: menu, switcher: { name: 'agentic', id: 'p1', color: 'violet' } };
const groups: NavGroup[] = [{ label: 'Primary', items: [{ href: '/', label: 'Home', badge: 2, count: 7 }, projects] }];

const sub = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-nav-children]')!;
const link = (host: ParentNode, href: string): HTMLAnchorElement => sub(host).querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;

describe('AppShell project sub-menu', () => {
    it('draws the switcher first: the project square, name and chevron, named "Switch project"', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1" />);
        await tick();
        const button = sub(host).firstElementChild as HTMLButtonElement;
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('type')).toBe('button');
        expect(button.getAttribute('aria-label')).toBe('Switch project');
        expect(button.querySelector('[data-nav-switcher-name]')?.textContent).toBe('agentic');
        const square = button.querySelector('[data-ag-project="square"]')!;
        expect(square.getAttribute('data-size')).toBe('22');
        expect(square.getAttribute('data-color')).toBe('violet');
        expect(button.querySelector('svg[data-icon="chevron-down"]')).not.toBeNull();
    });

    it('emits switch with the entry when the switcher is pressed, and leaves the sheet as it is', async () => {
        const seen: NavItem[] = [];
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1" onSwitch={(item: NavItem) => seen.push(item)} />);
        await tick();
        sub(host).querySelector<HTMLButtonElement>('[data-nav-switcher]')!.click();
        expect(seen.map((i) => i.href)).toEqual(['/projects']);
    });

    it('draws no switcher when the entry has none', async () => {
        const host = mount(<AppShell groups={[{ label: 'Primary', items: [{ ...projects, switcher: undefined }] }]} currentPath="/projects/p1" />);
        await tick();
        expect(host.querySelector('[data-nav-switcher]')).toBeNull();
        expect(sub(host).querySelectorAll('a')).toHaveLength(7);
    });

    it('shows a plain count in mono, and a count that needs you as the badge instead', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1" />);
        await tick();
        expect(link(host, '/projects/p1/chats').querySelector('[data-nav-count]')?.textContent).toBe('5');
        expect(link(host, '/projects/p1/plan').querySelector('[data-nav-count]')?.textContent).toBe('9');
        const work = link(host, '/projects/p1/work');
        expect(work.querySelector('[data-nav-count]')).toBeNull();
        const badge = work.querySelector('[data-scope="badge"][data-part="root"]')!;
        expect(badge.textContent).toBe('3');
        expect(badge.getAttribute('aria-label')).toBe('3 items need you');
        expect(link(host, '/projects/p1/requests').querySelector('[data-scope="nav-list"][data-part="meta"]')).toBeNull();
        // A top-level entry keeps only its badge.
        const home = host.querySelector<HTMLAnchorElement>('a[href="/"]')!;
        expect(home.querySelector('[data-nav-count]')).toBeNull();
        expect(home.querySelector('[data-scope="badge"][data-part="root"]')?.textContent).toBe('2');
    });

    it('opens Features under its mono label and Settings after a divider', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1" />);
        await tick();
        const blocks = [...sub(host).querySelectorAll<HTMLElement>('[data-nav-block]')];
        expect(blocks.map((b) => b.getAttribute('data-nav-block'))).toEqual(['agentic', 'Features', 'Settings']);
        expect(blocks[0]!.querySelector('[data-nav-block-heading], [data-nav-block-divider]')).toBeNull();
        expect(blocks[1]!.querySelector('[data-nav-block-heading]')?.textContent).toBe('Features');
        expect(blocks[1]!.querySelector('[data-nav-block-divider]')).toBeNull();
        expect(blocks[2]!.querySelector('[data-nav-block-heading]')).toBeNull();
        expect(blocks[2]!.querySelector('hr[data-nav-block-divider]')).not.toBeNull();
        // Each block is a list named by its label.
        expect(blocks.map((b) => b.querySelector('[data-scope="nav-list"][data-part="list"]')?.getAttribute('aria-label'))).toEqual(['agentic', 'Features', 'Settings']);
    });

    it('draws sub-item glyphs at 15 px and top-level ones at 17', async () => {
        const host = mount(<AppShell groups={[{ label: 'Primary', items: [{ ...projects, icon: 'home' }] }]} currentPath="/projects/p1" />);
        await tick();
        expect(link(host, '/projects/p1').querySelector('svg')?.getAttribute('width')).toBe('15');
        expect(host.querySelector('a[href="/projects"] svg')?.getAttribute('width')).toBe('17');
    });

    it('marks only the sub-item the page is on, active and aria-current', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1/plan" />);
        await tick();
        const current = [...host.querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href'));
        expect(current).toEqual(['/projects/p1/plan']);
        expect(link(host, '/projects/p1/plan').getAttribute('data-state')).toBe('active');
        expect(link(host, '/projects/p1').getAttribute('data-state')).not.toBe('active');
    });

    it('keeps the tree inside the one navigation drawer, so the phone sheet shows it too', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/projects/p1" />);
        await tick();
        expect(host.querySelectorAll('[data-nav-children]')).toHaveLength(1);
        expect(sub(host).closest('[data-scope="drawer"][data-part="panel"]')).not.toBeNull();
    });
});
