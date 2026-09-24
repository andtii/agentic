import { component, onUnmounted, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { watch } from '@sigx/reactivity';
import { Drawer, Navbar, type PartProps } from '@sigx/zero';
import { Icon, type IconName } from '../kit/icons';
import { useMediaQuery } from '@sigx/zero/behaviors';

/** One navigation entry. `badge` is the Home count: open inbox items of kind approval, input or interrupted. */
export interface NavItem {
    href: string;
    label: string;
    badge?: number;
    /** The 17 px glyph before the label (20 px in the drawer); the `link` slot renders it through `NavLinkSlotProps.icon`. */
    icon?: IconName;
}

/** A labelled group of entries — the sidebar shows "Primary" unlabelled and "Workspace" with its heading. */
export interface NavGroup {
    label: string;
    items: readonly NavItem[];
}

/** What the `link` slot receives per item — the app renders its router's Link around `icon` + the label. */
export interface NavLinkSlotProps {
    item: NavItem;
    active: boolean;
    /** The item's glyph, already sized for the nav; `null` when the item declares none. */
    icon: JSXElement | null;
}

/** What the `back` slot receives — the app renders its router's Link with the arrow inside. */
export interface BackSlotProps {
    href: string;
    /** The arrow glyph. */
    icon: JSXElement;
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
    /** The app bar's title below 768 px (16 / 600) — the breadcrumb's current page. */
    & Define.Prop<'title', string>
    /** Below 768 px a back link replaces the menu button — the breadcrumb's parent. */
    & Define.Prop<'back', string>
    & Define.Slot<'default'>
    & Define.Slot<'link', NavLinkSlotProps>
    & Define.Slot<'back', BackSlotProps>
    /** Topbar, left: the breadcrumb (≥ 768 px). */
    & Define.Slot<'breadcrumb'>
    /** The app bar's optional sub-line under the title (member tiles, a status summary). */
    & Define.Slot<'subtitle'>
    /** Topbar, right: page actions (≥ 768 px, and below when no `phoneAction` is given). */
    & Define.Slot<'actions'>
    /** The app bar's one right slot below 768 px. */
    & Define.Slot<'phoneAction'>
    /** Sidebar foot: the connection strip (this browser's socket, then each machine). */
    & Define.Slot<'connection'>
    /** Sidebar foot: the signed-in user. */
    & Define.Slot<'user'>;

function isActive(item: NavItem, path: string | undefined): boolean {
    if (!path) return false;
    if (item.href === '/') return path === '/';
    return path === item.href || path.startsWith(`${item.href}/`);
}

/**
 * Sidebar + topbar + content, on the handoff's shell
 * (`docs/design/HANDOFF.md` → "Layout and shell", "Mobile specifics"): a
 * 232 px sidebar (brand, nav groups, connection strip, user) beside a
 * column of 60 px topbar (breadcrumb, actions) and the main content. Below
 * 768 px the sidebar becomes a 312 px Drawer behind a 44 px menu button and
 * the topbar becomes a 60 px app bar: menu or back, title with an optional
 * sub-line, one right slot. Router-agnostic: the app supplies its `Link`
 * through the `link` and `back` slots (a plain `<a>` is the fallback), so
 * the shell owns the responsive behaviour and nothing about navigation
 * semantics.
 *
 * The navigation renders twice — once in the modal Drawer, once in the
 * sidebar — and `shell.css` shows exactly one of them per viewport. The
 * Drawer is never inline: zero's `<dialog>` gets its `open` attribute on the
 * client only, so an inline drawer would flash closed on every server render.
 */
export const AppShell = component<AppShellProps>(({ props, slots }) => {
    const state = signal({ open: false });
    // The drawer yields to the sidebar from the design system's `md` up (`shell.css` agrees).
    const wide = useMediaQuery({ above: 'md' }, { initial: false });
    // When the sidebar takes over, a drawer left open would sit on top of it.
    const stop = watch(() => wide.value, (isWide) => { if (isWide) state.open = false; });
    onUnmounted(() => stop());

    const brand = () => props.brand ?? 'agentic';
    const groups = (): readonly NavGroup[] =>
        props.groups ?? [{ label: 'Primary', items: props.items ?? [] }];

    const renderLink = (item: NavItem): JSXElement | JSXElement[] | null => {
        const active = isActive(item, props.currentPath);
        const icon = item.icon ? <Icon name={item.icon} size={17} /> : null;
        return slots.link
            ? slots.link({ item, active, icon })
            : <a href={item.href} aria-current={active ? 'page' : undefined}>{icon}{item.label}</a>;
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

    // The app bar's leading control on a detail route: back to the breadcrumb's parent.
    const backLink = (href: string) => {
        const icon = <Icon name="back" size={20} />;
        return (
            <span data-scope="ai-shell" data-part="back">
                {slots.back ? slots.back({ href, icon }) : <a href={href} aria-label="Back">{icon}</a>}
            </span>
        );
    };

    return () => (
        <div data-scope="ai-shell" data-part="root">
            <aside data-scope="ai-shell" data-part="sidebar">
                {brandMark()}
                {navGroups()}
                <div data-scope="ai-shell" data-part="sidebar-spacer" aria-hidden="true" />
                {foot()}
            </aside>
            <div data-scope="ai-shell" data-part="body">
                <div data-scope="ai-shell" data-part="bar" data-regime={props.back ? 'detail' : 'root'}>
                    <Navbar.Root>
                        <Navbar.Start>
                            <Drawer.Root model={() => state.open} placement="start" label="Navigation">
                                <span data-scope="ai-shell" data-part="menu">
                                    <Drawer.Trigger asChild>
                                        {(p: PartProps) => <button type="button" aria-label="Menu" {...p}><Icon name="menu" size={20} /></button>}
                                    </Drawer.Trigger>
                                </span>
                                <Drawer.Panel>
                                    <div data-scope="ai-shell" data-part="drawer-head">
                                        {brandMark()}
                                        <Drawer.Close asChild>
                                            {(p: PartProps) => <button type="button" aria-label="Close" {...p}><Icon name="close" size={20} /></button>}
                                        </Drawer.Close>
                                    </div>
                                    <Drawer.Title>{`${brand()} navigation`}</Drawer.Title>
                                    {navGroups()}
                                    <div data-scope="ai-shell" data-part="sidebar-spacer" aria-hidden="true" />
                                    {foot()}
                                </Drawer.Panel>
                            </Drawer.Root>
                            {props.back ? backLink(props.back) : null}
                            <div data-scope="ai-shell" data-part="breadcrumb">{slots.breadcrumb?.()}</div>
                            {props.title ? (
                                <div data-scope="ai-shell" data-part="title">
                                    <span data-scope="ai-shell" data-part="title-text">{props.title}</span>
                                    {slots.subtitle ? <span data-scope="ai-shell" data-part="subtitle">{slots.subtitle()}</span> : null}
                                </div>
                            ) : brandMark()}
                        </Navbar.Start>
                        <Navbar.End>
                            <div data-scope="ai-shell" data-part="actions">{slots.actions?.()}</div>
                            {slots.phoneAction ? <div data-scope="ai-shell" data-part="phone-action">{slots.phoneAction()}</div> : null}
                        </Navbar.End>
                    </Navbar.Root>
                </div>
                <main data-scope="ai-shell" data-part="main" data-flush={props.flush ? '' : undefined}>{slots.default?.()}</main>
            </div>
        </div>
    );
}, { name: 'AppShell' });
