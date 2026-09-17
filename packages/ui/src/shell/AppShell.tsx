import { component, onUnmounted, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { Drawer, Navbar } from '@sigx/zero';
import { useMediaQuery } from '../layout/use-media-query';
import { ThemeToggle } from './ThemeToggle';

/** One primary-navigation entry. */
export interface NavItem {
    href: string;
    label: string;
}

/** What the `link` slot receives per item — the app renders its router's Link. */
export interface NavLinkSlotProps {
    item: NavItem;
    active: boolean;
}

export type AppShellProps =
    & Define.Prop<'brand', string>
    & Define.Prop<'items', readonly NavItem[], true>
    /** The current route path — drives `data-state="active"` on the matching item. */
    & Define.Prop<'currentPath', string>
    & Define.Slot<'default'>
    & Define.Slot<'link', NavLinkSlotProps>
    & Define.Slot<'actions'>;

/** The viewport width at which the drawer yields to the sidebar (`shell.css` agrees). */
export const SHELL_BREAKPOINT = '(min-width: 768px)';

function isActive(item: NavItem, path: string | undefined): boolean {
    if (!path) return false;
    if (item.href === '/') return path === '/';
    return path === item.href || path.startsWith(`${item.href}/`);
}

/**
 * Navbar + Drawer + content. Router-agnostic: the app supplies its `Link`
 * through the `link` slot (a plain `<a>` is the fallback), so the shell owns
 * the responsive behaviour and nothing about navigation semantics.
 *
 * The primary nav renders twice — once in the modal Drawer, once in the
 * sidebar — and `shell.css` shows exactly one of them per viewport. The
 * Drawer is never inline: zero's `<dialog>` gets its `open` attribute on the
 * client only, so an inline drawer would flash closed on every server render.
 */
export const AppShell = component<AppShellProps>(({ props, slots }) => {
    const state = signal({ open: false });
    const wide = useMediaQuery(SHELL_BREAKPOINT);
    // When the sidebar takes over, a drawer left open would sit on top of it.
    const stop = watch(() => wide.value, (isWide) => { if (isWide) state.open = false; });
    onUnmounted(() => stop());

    const brand = () => props.brand ?? 'agentic';

    const renderLink = (item: NavItem): JSXElement | JSXElement[] | null => {
        const active = isActive(item, props.currentPath);
        return slots.link
            ? slots.link({ item, active })
            : <a href={item.href} aria-current={active ? 'page' : undefined}>{item.label}</a>;
    };

    // A click on any link inside the drawer's list closes the drawer.
    const onNavClick = (e: MouseEvent) => {
        if ((e.target as Element | null)?.closest('a')) state.open = false;
    };

    const navList = (label: string) => (
        <nav aria-label={label} data-scope="ai-shell" data-part="nav" onClick={onNavClick}>
            <ul data-scope="ai-shell" data-part="nav-list">
                {props.items.map(item => (
                    <li
                        data-scope="ai-shell"
                        data-part="nav-item"
                        data-state={isActive(item, props.currentPath) ? 'active' : 'inactive'}
                    >
                        {renderLink(item)}
                    </li>
                ))}
            </ul>
        </nav>
    );

    return () => (
        <div data-scope="ai-shell" data-part="root">
            <div data-scope="ai-shell" data-part="bar">
                <Navbar.Root>
                    <Navbar.Start>
                        <Drawer.Root model={() => state.open} placement="start" label="Navigation">
                            <span data-scope="ai-shell" data-part="menu">
                                <Drawer.Trigger size="sm">Menu</Drawer.Trigger>
                            </span>
                            <Drawer.Panel>
                                <Drawer.Title>{brand()}</Drawer.Title>
                                {navList('Primary')}
                                <Drawer.Close>Close</Drawer.Close>
                            </Drawer.Panel>
                        </Drawer.Root>
                        <span data-scope="ai-shell" data-part="brand">{brand()}</span>
                    </Navbar.Start>
                    <Navbar.End>
                        {slots.actions?.()}
                        <ThemeToggle />
                    </Navbar.End>
                </Navbar.Root>
            </div>
            <div data-scope="ai-shell" data-part="body">
                <aside data-scope="ai-shell" data-part="sidebar">{navList('Primary')}</aside>
                <main data-scope="ai-shell" data-part="main">{slots.default?.()}</main>
            </div>
        </div>
    );
}, { name: 'AppShell' });
