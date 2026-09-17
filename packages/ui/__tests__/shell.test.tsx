import { render } from '@sigx/runtime-dom';
import { AppShell, type NavGroup, type NavItem } from '../src/index';

const items: NavItem[] = [
    { href: '/', label: 'Inbox' },
    { href: '/agents', label: 'Agents' },
    { href: '/settings', label: 'Settings' }
];

const groups: NavGroup[] = [
    { label: 'Primary', items: [{ href: '/', label: 'Home', badge: 3 }, { href: '/chats', label: 'Chats' }] },
    { label: 'Workspace', items: [{ href: '/history', label: 'History' }, { href: '/settings', label: 'Settings' }] }
];

function mount(el: Parameters<typeof render>[0]): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(el, host);
    return host;
}

const part = (name: string) => `[data-scope="ai-shell"][data-part="${name}"]`;

describe('AppShell', () => {
    it('renders sidebar, bar and main with the content in main', () => {
        const host = mount(<AppShell brand="agentic" items={items}><p id="content">hi</p></AppShell>);
        expect(host.querySelector(`${part('bar')} [data-scope="navbar"][data-part="root"]`)).not.toBeNull();
        expect(host.querySelector(part('sidebar'))).not.toBeNull();
        expect(host.querySelector(`${part('main')} #content`)?.textContent).toBe('hi');
        expect(host.querySelector(`${part('sidebar')} > ${part('brand')} ${part('brand-name')}`)?.textContent).toBe('agentic');
        expect(host.querySelector(part('main'))?.hasAttribute('data-flush')).toBe(false);
    });

    it('renders the primary nav in both the drawer and the sidebar', () => {
        const host = mount(<AppShell items={items} />);
        const lists = host.querySelectorAll(part('nav-list'));
        expect(lists).toHaveLength(2);
        expect(host.querySelector('[data-scope="drawer"][data-part="panel"] [data-part="nav-list"]')).not.toBeNull();
        expect(host.querySelector('[data-part="sidebar"] [data-part="nav-list"]')).not.toBeNull();
        for (const list of lists) {
            expect(Array.from(list.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['/', '/agents', '/settings']);
        }
    });

    it('renders one labelled <nav> per group, the first without a visible heading', () => {
        const host = mount(<AppShell groups={groups} currentPath="/" />);
        const navs = Array.from(host.querySelectorAll(`[data-part="sidebar"] ${part('nav')}`));
        expect(navs.map(n => n.getAttribute('aria-label'))).toEqual(['Primary', 'Workspace']);
        expect(navs[0]!.querySelector(part('nav-label'))).toBeNull();
        expect(navs[1]!.querySelector(part('nav-label'))?.textContent).toBe('Workspace');
        expect(Array.from(host.querySelectorAll('[data-part="sidebar"] a')).map(a => a.getAttribute('href')))
            .toEqual(['/', '/chats', '/history', '/settings']);
    });

    it('renders the badge count on the item that carries one', () => {
        const host = mount(<AppShell groups={groups} currentPath="/" />);
        const badges = Array.from(host.querySelectorAll(`[data-part="sidebar"] ${part('badge')}`));
        expect(badges).toHaveLength(1);
        expect(badges[0]!.textContent).toBe('3');
        expect(badges[0]!.closest('[data-part="nav-item"]')?.querySelector('a')?.getAttribute('href')).toBe('/');
    });

    it('renders the breadcrumb, actions, connection and user slots in their parts', () => {
        const host = mount(
            <AppShell
                items={items}
                slots={{
                    breadcrumb: () => <span id="crumb">Home</span>,
                    actions: () => <button id="act">New chat</button>,
                    connection: () => <span id="conn">live</span>,
                    user: () => <span id="usr">andy</span>
                }}
            />
        );
        expect(host.querySelector(`${part('bar')} ${part('breadcrumb')} #crumb`)).not.toBeNull();
        expect(host.querySelector(`${part('bar')} ${part('actions')} #act`)).not.toBeNull();
        expect(host.querySelector(`${part('sidebar')} ${part('connection')} #conn`)).not.toBeNull();
        expect(host.querySelector(`${part('sidebar')} ${part('user')} #usr`)).not.toBeNull();
        // The foot renders in the drawer too, so a phone sees the connection strip.
        expect(host.querySelector(`[data-scope="drawer"][data-part="panel"] ${part('connection')}`)).not.toBeNull();
    });

    it('omits the connection and user parts when the slots are absent', () => {
        const host = mount(<AppShell items={items} />);
        expect(host.querySelector(part('connection'))).toBeNull();
        expect(host.querySelector(part('user'))).toBeNull();
    });

    it('marks the current item active with prefix matching, root exact', () => {
        const host = mount(<AppShell items={items} currentPath="/agents/a1" />);
        const states = Array.from(host.querySelectorAll('[data-part="sidebar"] [data-part="nav-item"]'))
            .map(li => li.getAttribute('data-state'));
        expect(states).toEqual(['inactive', 'active', 'inactive']);
        expect(host.querySelector('[data-part="sidebar"] a[aria-current="page"]')?.getAttribute('href')).toBe('/agents');
    });

    it('renders links through the link slot when given', () => {
        const host = mount(
            <AppShell
                items={items}
                currentPath="/"
                slots={{ link: ({ item, active }) => <a href={item.href} class={active ? 'on' : 'off'}>{item.label}!</a> }}
            />
        );
        const links = Array.from(host.querySelectorAll('[data-part="sidebar"] a'));
        expect(links.map(a => a.textContent)).toEqual(['Inbox!', 'Agents!', 'Settings!']);
        expect(links.map(a => a.className)).toEqual(['on', 'off', 'off']);
    });

    it('takes the main column flush for edge-to-edge pages', () => {
        const host = mount(<AppShell items={items} flush />);
        expect(host.querySelector(part('main'))?.hasAttribute('data-flush')).toBe(true);
    });

    it('renders the drawer closed on first paint with a trigger in the bar', () => {
        const host = mount(<AppShell items={items} />);
        const trigger = host.querySelector(`${part('menu')} [data-scope="drawer"][data-part="trigger"]`);
        expect(trigger?.textContent).toBe('Menu');
        expect(host.querySelector('[data-scope="drawer"][data-part="panel"]')?.getAttribute('data-state')).toBe('closed');
    });
});
