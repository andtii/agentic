/**
 * The phone keeps its menu on a route with a sub-menu (#923): below 768 px a detail route swaps the menu for a back
 * link, but a project's own menu lives only in the navigation — so while the current route opens an entry's sub-menu
 * the bar marks itself `data-sub-menu` and the shell's CSS keeps the trigger beside the back link.
 */
import { AppShell, type NavGroup } from '../../src/index';
import { installThemes } from '../../src/design-system';
import { mount, tick } from '../helpers';

beforeAll(() => installThemes());

const withMenu: NavGroup[] = [{
    label: 'Primary',
    items: [
        { href: '/', label: 'Home' },
        { href: '/projects', label: 'Projects', children: [{ label: 'agentic', items: [{ href: '/projects/p1', label: 'Overview' }, { href: '/projects/p1/requests', label: 'Requests' }] }] }
    ]
}];
const bar = (host: ParentNode): HTMLElement => host.querySelector<HTMLElement>('[data-scope="ai-shell"][data-part="bar"]')!;

describe('AppShell phone menu on a sub-menu route', () => {
    it('marks the bar when the current route opens a sub-menu, and keeps both menu and back', async () => {
        const host = mount(<AppShell groups={withMenu} currentPath="/projects/p1/work" back="/projects/p1" title="Work" />);
        await tick();
        expect(bar(host).getAttribute('data-regime')).toBe('detail');
        expect(bar(host).hasAttribute('data-sub-menu')).toBe(true);
        expect(bar(host).querySelector('button[aria-label="Menu"]')).not.toBeNull();
        expect(bar(host).querySelector('[data-part="back"] a[aria-label="Back"]')).not.toBeNull();
        // Back comes first in the DOM, so the focus order matches what the phone draws: Back, then Menu.
        const controls = [...bar(host).querySelectorAll('[data-part="back"] a, button[aria-label="Menu"]')].map((el) => el.getAttribute('aria-label'));
        expect(controls).toEqual(['Back', 'Menu']);
    });

    it('leaves the bar unmarked off the entry with the sub-menu', async () => {
        const host = mount(<AppShell groups={withMenu} currentPath="/chats/c1" back="/" title="Chat" />);
        await tick();
        expect(bar(host).hasAttribute('data-sub-menu')).toBe(false);
    });

    it('leaves the bar unmarked when the sub-menu is empty', async () => {
        const empty: NavGroup[] = [{ label: 'Primary', items: [{ href: '/projects', label: 'Projects', children: [{ label: 'agentic', items: [] }] }] }];
        const host = mount(<AppShell groups={empty} currentPath="/projects/p1" back="/projects" title="agentic" />);
        await tick();
        expect(bar(host).hasAttribute('data-sub-menu')).toBe(false);
    });
});
