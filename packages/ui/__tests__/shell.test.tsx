import { render } from '@sigx/runtime-dom';
import { AppShell, type NavItem } from '../src/index';

const items: NavItem[] = [
    { href: '/', label: 'Inbox' },
    { href: '/agents', label: 'Agents' },
    { href: '/settings', label: 'Settings' }
];

function mount(el: Parameters<typeof render>[0]): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(el, host);
    return host;
}

describe('AppShell', () => {
    it('renders bar, sidebar and main with the content in main', () => {
        const host = mount(<AppShell brand="agentic" items={items}><p id="content">hi</p></AppShell>);
        expect(host.querySelector('[data-scope="ai-shell"][data-part="bar"] [data-scope="navbar"][data-part="root"]')).not.toBeNull();
        expect(host.querySelector('[data-scope="ai-shell"][data-part="sidebar"]')).not.toBeNull();
        expect(host.querySelector('[data-scope="ai-shell"][data-part="main"] #content')?.textContent).toBe('hi');
        expect(host.querySelector('[data-scope="ai-shell"][data-part="brand"]')?.textContent).toBe('agentic');
    });

    it('renders the primary nav in both the drawer and the sidebar', () => {
        const host = mount(<AppShell items={items} />);
        const lists = host.querySelectorAll('[data-scope="ai-shell"][data-part="nav-list"]');
        expect(lists).toHaveLength(2);
        expect(host.querySelector('[data-scope="drawer"][data-part="panel"] [data-part="nav-list"]')).not.toBeNull();
        expect(host.querySelector('[data-part="sidebar"] [data-part="nav-list"]')).not.toBeNull();
        for (const list of lists) {
            expect(Array.from(list.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['/', '/agents', '/settings']);
        }
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

    it('renders the drawer closed on first paint with a trigger in the bar', () => {
        const host = mount(<AppShell items={items} />);
        const trigger = host.querySelector('[data-scope="ai-shell"][data-part="menu"] [data-scope="drawer"][data-part="trigger"]');
        expect(trigger?.textContent).toBe('Menu');
        expect(host.querySelector('[data-scope="drawer"][data-part="panel"]')?.getAttribute('data-state')).toBe('closed');
    });
});
