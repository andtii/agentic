import { render } from '@sigx/runtime-dom';
import { renderToString } from '@sigx/server-renderer';
import { AppShell, type NavGroup, type NavItem } from '../src/index';
import { installThemes } from '../src/design-system';
import { aiShellAnatomy } from '../src/shell/anatomy';

// The shell asks the registered design system's `md` breakpoint, as the app does after `installThemes()`.
beforeAll(() => installThemes());

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

const tick = () => new Promise((r) => setTimeout(r, 0));
const part = (name: string) => `[data-scope="${aiShellAnatomy.scope}"][data-part="${name}"]`;
const panelSel = '[data-scope="drawer"][data-part="panel"]';
const triggerSel = `${part('bar')} [data-scope="drawer"][data-part="trigger"]`;
const linkSel = '[data-scope="nav-list"][data-part="link"]';

type Listener = (e: { matches: boolean }) => void;

/** A controllable `matchMedia`: one list for every query, `set(wide)` fires the change. */
function stubViewport(wide: boolean) {
    const listeners = new Set<Listener>();
    const list = {
        matches: wide,
        addEventListener: (_: string, fn: Listener) => { listeners.add(fn); },
        removeEventListener: (_: string, fn: Listener) => { listeners.delete(fn); }
    };
    const matchMedia = vi.fn(() => list as unknown as MediaQueryList);
    vi.stubGlobal('matchMedia', matchMedia);
    return {
        matchMedia,
        set(next: boolean) {
            list.matches = next;
            for (const fn of listeners) fn({ matches: next });
        }
    };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('AppShell', () => {
    it('renders the docked drawer, bar and main with the content in main', () => {
        const host = mount(<AppShell brand="agentic" items={items}><p id="content">hi</p></AppShell>);
        expect(host.querySelector(`${part('bar')} [data-scope="navbar"][data-part="root"]`)).not.toBeNull();
        expect(host.querySelector(`${part('main')} #content`)?.textContent).toBe('hi');
        expect(host.querySelector(part('main'))?.hasAttribute('data-flush')).toBe(false);
        // The drawer is the root's first column: docked, open in markup, responsive at md.
        const panel = host.querySelector(`${part('root')} > ${panelSel}`);
        expect(panel?.getAttribute('data-l-dock-above')).toBe('md');
        expect(panel?.getAttribute('data-l-dock')).toBe('inline');
        expect(panel?.hasAttribute('open')).toBe(true);
        expect(panel?.querySelector(`${part('drawer-head')} ${part('brand-name')}`)?.textContent).toBe('agentic');
    });

    it.each([['narrow', false], ['wide', true]] as const)('renders exactly one navigation landmark and one banner (%s)', async (_, wide) => {
        stubViewport(wide);
        const host = mount(<AppShell groups={groups} currentPath="/" />);
        await tick();
        const navs = host.querySelectorAll('nav');
        expect(navs).toHaveLength(1);
        expect(navs[0]!.getAttribute('aria-label')).toBe('Main');
        expect(navs[0]!.getAttribute('data-scope')).toBe('nav-list');
        expect(host.querySelectorAll('header')).toHaveLength(1);
        expect(host.querySelectorAll(panelSel)).toHaveLength(1);
        expect(Array.from(host.querySelectorAll(`nav ${linkSel}`)).map(a => a.getAttribute('href')))
            .toEqual(['/', '/chats', '/history', '/settings']);
    });

    it('renders the SSR markup docked and open, so md+ never flashes', async () => {
        const html = await renderToString(<AppShell groups={groups} currentPath="/" />);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const panel = doc.querySelector(panelSel);
        expect(panel?.hasAttribute('open')).toBe(true);
        expect(panel?.getAttribute('data-l-dock')).toBe('inline');
        expect(panel?.getAttribute('data-state')).toBe('open');
        expect(doc.querySelectorAll('nav')).toHaveLength(1);
        // The trigger renders closed, and is hidden by the compiled CSS while docked.
        const trigger = doc.querySelector('[data-scope="drawer"][data-part="trigger"]');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        expect(trigger?.getAttribute('data-l-dock-above')).toBe('md');
    });

    it('renders the groups on NavList: the first named by its label, the rest by their heading', async () => {
        const host = mount(<AppShell groups={groups} currentPath="/" />);
        await tick();
        const groupEls = Array.from(host.querySelectorAll('[data-scope="nav-list"][data-part="group"]'));
        expect(groupEls.map(g => g.getAttribute('role'))).toEqual(['group', 'group']);
        expect(groupEls[0]!.getAttribute('aria-label')).toBe('Primary');
        expect(groupEls[0]!.querySelector('[data-part="heading"]')).toBeNull();
        const heading = groupEls[1]!.querySelector('[data-scope="nav-list"][data-part="heading"]');
        expect(heading?.textContent).toBe('Workspace');
        expect(groupEls[1]!.getAttribute('aria-labelledby')).toBe(heading?.id);
    });

    it('renders the Home count as a warning Badge with an accessible label in the link meta', () => {
        const host = mount(<AppShell groups={groups} currentPath="/" />);
        const badges = Array.from(host.querySelectorAll('[data-scope="badge"][data-part="root"]'));
        expect(badges).toHaveLength(1);
        expect(badges[0]!.textContent).toBe('3');
        expect(badges[0]!.getAttribute('aria-label')).toBe('3 items need you');
        expect(badges[0]!.getAttribute('data-color')).toBe('warning');
        expect(badges[0]!.getAttribute('data-size')).toBe('sm');
        expect(badges[0]!.parentElement?.getAttribute('data-part')).toBe('meta');
        expect(badges[0]!.closest(linkSel)?.getAttribute('href')).toBe('/');
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
        // The foot is the drawer's, docked or as the phone's sheet.
        expect(host.querySelector(`${panelSel} ${part('connection')} #conn`)).not.toBeNull();
        expect(host.querySelector(`${panelSel} ${part('user')} #usr`)).not.toBeNull();
    });

    it('omits the connection and user parts when the slots are absent', () => {
        const host = mount(<AppShell items={items} />);
        expect(host.querySelector(part('connection'))).toBeNull();
        expect(host.querySelector(part('user'))).toBeNull();
    });

    it('marks the current item with aria-current=page, prefix matching, root exact', () => {
        const host = mount(<AppShell items={items} currentPath="/agents/a1" />);
        const links = Array.from(host.querySelectorAll(linkSel));
        expect(links.map(a => a.getAttribute('data-state'))).toEqual(['inactive', 'active', 'inactive']);
        expect(links.map(a => a.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    });

    it('hands the link slot the NavList.Link part props to spread, with the icon and the count', () => {
        const host = mount(
            <AppShell
                groups={groups}
                currentPath="/"
                slots={{ link: ({ item, active, meta, props }) => <a {...props} class={active ? 'on' : 'off'}>{item.label}!{meta}</a> }}
            />
        );
        const links = Array.from(host.querySelectorAll(linkSel));
        expect(links.map(a => a.textContent)).toEqual(['Home!3', 'Chats!', 'History!', 'Settings!']);
        expect(links.map(a => a.className)).toEqual(['on', 'off', 'off', 'off']);
        expect(links.map(a => a.getAttribute('href'))).toEqual(['/', '/chats', '/history', '/settings']);
        expect(links[0]!.getAttribute('aria-current')).toBe('page');
    });

    it('takes the main column flush for edge-to-edge pages', () => {
        const host = mount(<AppShell items={items} flush />);
        expect(host.querySelector(part('main'))?.hasAttribute('data-flush')).toBe(true);
    });

    it('renders a 44 px icon trigger in the bar, a close in the drawer head and a visually hidden title', () => {
        const host = mount(<AppShell items={items} />);
        const trigger = host.querySelector(triggerSel);
        expect(trigger?.tagName).toBe('BUTTON');
        expect(trigger?.getAttribute('aria-label')).toBe('Menu');
        expect(trigger?.getAttribute('data-l-dock-above')).toBe('md');
        expect(trigger?.querySelector('svg[data-icon="menu"]')).not.toBeNull();
        const panel = host.querySelector(panelSel);
        expect(panel?.querySelector(`${part('drawer-head')} button[data-scope="drawer"][data-part="close"]`)?.getAttribute('aria-label')).toBe('Close');
        const title = panel?.querySelector('[data-scope="drawer"][data-part="title"]');
        expect(title?.textContent).toBe('agentic navigation');
        expect(title?.hasAttribute('data-visually-hidden')).toBe(true);
    });

    it("is a sheet below the design system's md and closes it when the viewport widens", async () => {
        const viewport = stubViewport(false);
        const host = mount(<AppShell items={items} />);
        await tick();
        // `{ below: 'md' }` asks daisy's md, 48rem (768 px), the width shell.css switches at.
        expect(viewport.matchMedia).toHaveBeenCalledWith('(min-width: 48rem)');
        const panel = host.querySelector(panelSel)!;
        expect(panel.getAttribute('data-l-dock')).toBe('sheet');
        expect(panel.getAttribute('data-state')).toBe('closed');
        (host.querySelector(triggerSel) as HTMLButtonElement).click();
        await tick();
        expect(panel.getAttribute('data-state')).toBe('open');
        expect(host.querySelector(triggerSel)?.getAttribute('aria-expanded')).toBe('true');

        // A link click inside closes the sheet.
        (panel.querySelector(linkSel) as HTMLAnchorElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await tick();
        expect(panel.getAttribute('data-state')).toBe('closed');

        (host.querySelector(triggerSel) as HTMLButtonElement).click();
        await tick();
        expect(panel.getAttribute('data-state')).toBe('open');
        // Widening docks the panel and takes the sheet down with it.
        viewport.set(true);
        await tick();
        expect(panel.getAttribute('data-l-dock')).toBe('inline');
        viewport.set(false);
        await tick();
        expect(panel.getAttribute('data-l-dock')).toBe('sheet');
        expect(panel.getAttribute('data-state')).toBe('closed');
    });

    it('renders an item icon inside the fallback link and hands it to the link slot', () => {
        const iconItems: NavItem[] = [{ href: '/', label: 'Home', icon: 'home' }, { href: '/agents', label: 'Agents' }];
        const plain = mount(<AppShell items={iconItems} currentPath="/" />);
        const links = Array.from(plain.querySelectorAll(linkSel));
        expect(links[0]!.querySelector('[data-scope="nav-list"][data-part="icon"] svg[data-icon="home"]')).not.toBeNull();
        expect(links[0]!.textContent).toBe('Home');
        expect(links[1]!.querySelector('svg')).toBeNull();

        const slotted = mount(
            <AppShell items={iconItems} slots={{ link: ({ item, icon, props }) => <a {...props} class={icon ? 'with-icon' : 'plain'}>{icon}{item.label}</a> }} />
        );
        const custom = Array.from(slotted.querySelectorAll(linkSel));
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
        expect(bar.querySelector('[data-scope="drawer"][data-part="trigger"]')).not.toBeNull();
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
