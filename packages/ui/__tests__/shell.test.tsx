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
        expect(badges[0]!.getAttribute('aria-label')).toBe('3 items need you');
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

    it('renders the drawer closed on first paint with a 44 px icon trigger in the bar', () => {
        const host = mount(<AppShell items={items} />);
        const trigger = host.querySelector(`${part('menu')} button[data-scope="drawer"][data-part="trigger"]`);
        expect(trigger?.getAttribute('aria-label')).toBe('Menu');
        expect(trigger?.querySelector('svg[data-icon="menu"]')).not.toBeNull();
        const panel = host.querySelector('[data-scope="drawer"][data-part="panel"]');
        expect(panel?.getAttribute('data-state')).toBe('closed');
        // The drawer's head: brand + a labelled close button; the connection strip stays at its foot.
        expect(panel?.querySelector(`${part('drawer-head')} ${part('brand-name')}`)?.textContent).toBe('agentic');
        expect(panel?.querySelector(`${part('drawer-head')} button[data-scope="drawer"][data-part="close"]`)?.getAttribute('aria-label')).toBe('Close');
        expect(panel?.querySelector('[data-scope="drawer"][data-part="title"]')?.textContent).toBe('agentic navigation');
    });

    it('renders an item icon inside the fallback link and hands it to the link slot', () => {
        const iconItems: NavItem[] = [{ href: '/', label: 'Home', icon: 'home' }, { href: '/agents', label: 'Agents' }];
        const plain = mount(<AppShell items={iconItems} currentPath="/" />);
        const links = Array.from(plain.querySelectorAll('[data-part="sidebar"] a'));
        expect(links[0]!.querySelector('svg[data-icon="home"]')).not.toBeNull();
        expect(links[0]!.textContent).toBe('Home');
        expect(links[1]!.querySelector('svg')).toBeNull();

        const slotted = mount(
            <AppShell items={iconItems} slots={{ link: ({ item, icon }) => <a href={item.href} class={icon ? 'with-icon' : 'plain'}>{icon}{item.label}</a> }} />
        );
        const custom = Array.from(slotted.querySelectorAll('[data-part="sidebar"] a'));
        expect(custom.map(a => a.className)).toEqual(['with-icon', 'plain']);
        expect(custom[0]!.querySelector('svg[data-icon="home"]')).not.toBeNull();
    });

    it('renders the app-bar regime: title with sub-line, the phone action beside the actions, and a menu on a root route', () => {
        const host = mount(
            <AppShell
                items={items}
                title="Home"
                slots={{
                    subtitle: () => <span id="sub">3 open</span>,
                    actions: () => <button id="act">New chat</button>,
                    phoneAction: () => <button id="phone">+</button>
                }}
            />
        );
        const bar = host.querySelector(part('bar'))!;
        expect(bar.getAttribute('data-regime')).toBe('root');
        expect(bar.querySelector(`${part('title')} ${part('title-text')}`)?.textContent).toBe('Home');
        expect(bar.querySelector(`${part('title')} ${part('subtitle')} #sub`)).not.toBeNull();
        expect(bar.querySelector(`${part('actions')} #act`)).not.toBeNull();
        expect(bar.querySelector(`${part('phone-action')} #phone`)).not.toBeNull();
        expect(bar.querySelector(part('menu'))).not.toBeNull();
        expect(bar.querySelector(part('back'))).toBeNull();
        // Without a title the bar falls back to the brand mark.
        expect(bar.querySelector(`[data-scope="navbar"][data-part="start"] > ${part('brand')}`)).toBeNull();
        const untitled = mount(<AppShell items={items} />);
        expect(untitled.querySelector(`${part('bar')} [data-scope="navbar"][data-part="start"] > ${part('brand')}`)).not.toBeNull();
        expect(untitled.querySelector(part('title'))).toBeNull();
        expect(untitled.querySelector(part('phone-action'))).toBeNull();
    });

    it('renders a back link on a detail route, through the back slot when given', () => {
        const plain = mount(<AppShell items={items} title="Scout" back="/agents" />);
        const bar = plain.querySelector(part('bar'))!;
        expect(bar.getAttribute('data-regime')).toBe('detail');
        const back = bar.querySelector(`${part('back')} a`);
        expect(back?.getAttribute('href')).toBe('/agents');
        expect(back?.getAttribute('aria-label')).toBe('Back');
        expect(back?.querySelector('svg[data-icon="back"]')).not.toBeNull();

        const slotted = mount(
            <AppShell items={items} title="Scout" back="/agents" slots={{ back: ({ href, icon }) => <a id="custom-back" href={`${href}?from=slot`}>{icon}</a> }} />
        );
        expect(slotted.querySelector(`${part('back')} #custom-back`)?.getAttribute('href')).toBe('/agents?from=slot');
    });
});
