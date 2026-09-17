import { component, onUnmounted, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { Drawer, Navbar } from '@sigx/zero';
import { useMediaQuery } from '../layout/use-media-query';

/** One navigation entry. `badge` is the Home count: open inbox items of kind approval, input or interrupted. */
export interface NavItem {
    href: string;
    label: string;
    badge?: number;
}

/** A labelled group of entries — the sidebar shows "Primary" unlabelled and "Workspace" with its heading. */
export interface NavGroup {
    label: string;
    items: readonly NavItem[];
}

/** What the `link` slot receives per item — the app renders its router's Link. */
export interface NavLinkSlotProps {
    item: NavItem;
    active: boolean;
}

export type AppShellProps =
    & Define.Prop<'brand', string>
    /** The primary group, when there is only one. Ignored when `groups` is given. */
    & Define.Prop<'items', readonly NavItem[]>
    /** The navigation in groups; the first group renders without a heading. */
    & Define.Prop<'groups', readonly NavGroup[]>
    /** The current route path — drives `data-state="active"` on the matching item. */
    & Define.Prop<'currentPath', string>
    /** Drop the main column's padding — Chat runs its three columns edge to edge. */
    & Define.Prop<'flush', boolean>
    & Define.Slot<'default'>
    & Define.Slot<'link', NavLinkSlotProps>
    /** Topbar, left: the breadcrumb. */
    & Define.Slot<'breadcrumb'>
    /** Topbar, right: page actions. */
    & Define.Slot<'actions'>
    /** Sidebar foot: the connection strip (this browser's socket, then each machine). */
    & Define.Slot<'connection'>
    /** Sidebar foot: the signed-in user. */
    & Define.Slot<'user'>;

/** The viewport width at which the drawer yields to the sidebar (`shell.css` agrees). */
export const SHELL_BREAKPOINT = '(min-width: 768px)';

function isActive(item: NavItem, path: string | undefined): boolean {
    if (!path) return false;
    if (item.href === '/') return path === '/';
    return path === item.href || path.startsWith(`${item.href}/`);
}

/**
 * Sidebar + topbar + content, on the handoff's shell
 * (`docs/design/HANDOFF.md` → "Layout and shell"): a 232 px sidebar (brand,
 * nav groups, connection strip, user) beside a column of 60 px topbar
 * (breadcrumb, actions) and the main content. Router-agnostic: the app
 * supplies its `Link` through the `link` slot (a plain `<a>` is the
 * fallback), so the shell owns the responsive behaviour and nothing about
 * navigation semantics.
 *
 * The navigation renders twice — once in the modal Drawer, once in the
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
    const groups = (): readonly NavGroup[] =>
        props.groups ?? [{ label: 'Primary', items: props.items ?? [] }];

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

    const navList = (group: NavGroup, index: number) => (
        <nav aria-label={group.label} data-scope="ai-shell" data-part="nav" onClick={onNavClick}>
            {index > 0 ? <div data-scope="ai-shell" data-part="nav-label" aria-hidden="true">{group.label}</div> : null}
            <ul data-scope="ai-shell" data-part="nav-list">
                {group.items.map(item => (
                    <li
                        data-scope="ai-shell"
                        data-part="nav-item"
                        data-state={isActive(item, props.currentPath) ? 'active' : 'inactive'}
                    >
                        {renderLink(item)}
                        {item.badge ? (
                            <span data-scope="ai-shell" data-part="badge" aria-label={item.badge === 1 ? '1 item needs you' : `${item.badge} items need you`}>{item.badge}</span>
                        ) : null}
                    </li>
                ))}
            </ul>
        </nav>
    );

    const navGroups = () => groups().map((group, index) => navList(group, index));

    const brandMark = () => (
        <span data-scope="ai-shell" data-part="brand">
            <span data-scope="ai-shell" data-part="brand-mark" aria-hidden="true">a/</span>
            <span data-scope="ai-shell" data-part="brand-name">{brand()}</span>
        </span>
    );

    const foot = () => (
        <>
            {slots.connection ? <div data-scope="ai-shell" data-part="connection">{slots.connection()}</div> : null}
            {slots.user ? <div data-scope="ai-shell" data-part="user">{slots.user()}</div> : null}
        </>
    );

    return () => (
        <div data-scope="ai-shell" data-part="root">
            <aside data-scope="ai-shell" data-part="sidebar">
                {brandMark()}
                {navGroups()}
                <div data-scope="ai-shell" data-part="sidebar-spacer" aria-hidden="true" />
                {foot()}
            </aside>
            <div data-scope="ai-shell" data-part="body">
                <div data-scope="ai-shell" data-part="bar">
                    <Navbar.Root>
                        <Navbar.Start>
                            <Drawer.Root model={() => state.open} placement="start" label="Navigation">
                                <span data-scope="ai-shell" data-part="menu">
                                    <Drawer.Trigger size="sm">Menu</Drawer.Trigger>
                                </span>
                                <Drawer.Panel>
                                    <Drawer.Title>{brand()}</Drawer.Title>
                                    {navGroups()}
                                    {foot()}
                                    <Drawer.Close>Close</Drawer.Close>
                                </Drawer.Panel>
                            </Drawer.Root>
                            {brandMark()}
                            <div data-scope="ai-shell" data-part="breadcrumb">{slots.breadcrumb?.()}</div>
                        </Navbar.Start>
                        <Navbar.End>
                            <div data-scope="ai-shell" data-part="actions">{slots.actions?.()}</div>
                        </Navbar.End>
                    </Navbar.Root>
                </div>
                <main data-scope="ai-shell" data-part="main" data-flush={props.flush ? '' : undefined}>{slots.default?.()}</main>
            </div>
        </div>
    );
}, { name: 'AppShell' });
