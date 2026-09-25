import { component, signal, type Define, type JSXElement } from '@sigx/runtime-core';
import { Badge, Drawer, Navbar, NavList, type PartProps } from '@sigx/zero';
import type { ProjectColor } from '@agentic/core';
import { Icon, type IconName } from '../kit/icons';
import { ProjectSquare } from '../projects/ProjectSquare';
import { SHELL_SCOPE } from './anatomy';

/**
 * One navigation entry. `badge` is a count that needs the person (the Home count: open inbox items of kind approval,
 * input or interrupted; a project sub-item's `needs-you` count).
 */
export interface NavItem {
    href: string;
    label: string;
    badge?: number;
    /**
     * A plain count (`mono` 11 px `text-dim`, e.g. a project's chats) — drawn only on a sub-item, and only when there
     * is no `badge`: a count that needs the person is the badge.
     */
    count?: number;
    /** The 17 px glyph before the label (20 px in the drawer); the `link` slot renders it through `NavLinkSlotProps.icon`. */
    icon?: IconName;
    /**
     * A sub-menu drawn indented under the item (#725: a project's own menu under `Projects` while a project route is
     * open), in blocks (#727): 32 px items at 13 px with 15 px glyphs, indented behind a 1 px `line-strong` rule; the
     * first block renders without a heading, the rest under a mono label (`FEATURES`) or after a divider
     * (`NavGroup.divider`, Settings). The page is the longest matching sub-item, not the entry.
     */
    children?: readonly NavGroup[];
    /**
     * The switcher on top of the sub-menu (#727): the project's square, name and a chevron, a button named "Switch
     * project" that makes the shell emit `switch` with this entry. Drawn only with `children`.
     */
    switcher?: NavSwitcher;
}

/** What the sub-menu's switcher shows: the project it is on (#727). */
export interface NavSwitcher {
    name: string;
    /** The project's id — the square's colour seed when `color` is unset. */
    id?: string;
    color?: ProjectColor;
}

/** A labelled group of entries — the sidebar shows "Primary" unlabelled and "Workspace" with its heading. */
export interface NavGroup {
    label: string;
    items: readonly NavItem[];
    /** In a sub-menu: open the block with a 1 px divider instead of its heading (the project's Settings, #727). */
    divider?: boolean;
}

/**
 * What the `link` slot receives — the app renders its router's link around
 * `icon` + the label. `props` is zero's `NavList.Link` part bag (scope, part,
 * `data-state`, `aria-current="page"` when `active`, `href`): spread it on
 * the anchor the slot renders, as `asChild` does.
 */
export interface NavLinkSlotProps {
    item: NavItem;
    active: boolean;
    /** The item's glyph in a `NavList.Icon`, already sized for the nav; `null` when the item declares none. */
    icon: JSXElement | null;
    /** The item's count as a `Badge` in a `NavList.Meta`, to render after the label; `null` when there is none. */
    meta: JSXElement | null;
    /** The `NavList.Link` part props to spread on the rendered anchor. */
    props: PartProps;
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
    /**
     * Below 768 px a back link replaces the menu button — the breadcrumb's parent. While the navigation carries a
     * sub-menu for the current route (a project's own menu, #923) the menu stays beside it, so the sub-menu is one tap
     * away on the phone too.
     */
    & Define.Prop<'back', string>
    /** The sub-menu's switcher was pressed (#727): the entry carrying it — the app opens its picker. */
    & Define.Event<'switch', NavItem>
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

/** The sub-item a path is on: the longest `href` it matches, so a project's Overview (`/projects/p`) does not claim `/projects/p/work`. */
function activeChild(groups: readonly NavGroup[], path: string | undefined): NavItem | undefined {
    let best: NavItem | undefined;
    for (const group of groups) {
        for (const item of group.items) if (isActive(item, path) && (!best || item.href.length > best.href.length)) best = item;
    }
    return best;
}

/** The Home count's accessible name. */
const needsLabel = (n: number): string => (n === 1 ? '1 item needs you' : `${n} items need you`);

/**
 * Sidebar + topbar + content, on the handoff's shell
 * (`docs/design/HANDOFF.md` → "Layout and shell", "Mobile specifics") and
 * zero's app-shell composition (Navbar + responsive Drawer + NavList): a
 * 232 px sidebar (brand, nav groups, connection strip, user) beside a
 * column of 60 px topbar (breadcrumb, actions) and the main content. Below
 * 768 px the sidebar is a 312 px modal sheet behind a 44 px menu button and
 * the topbar becomes a 60 px app bar: menu or back, title with an optional
 * sub-line, one right slot. Router-agnostic: the app supplies its link
 * through the `link` and `back` slots (a plain `<a>` is the fallback), so
 * the shell owns the responsive behaviour and nothing about navigation
 * semantics.
 *
 * The navigation renders once, in one `Drawer.Root modal={{ below: 'md' }}`:
 * docked inline from md up, a modal sheet below. The server renders it
 * docked (`open` in markup) and the design system's compiled CSS hides it
 * on a narrow viewport until the runtime catches up, so neither width
 * flashes; a sheet still up when the viewport widens closes itself, and the
 * trigger and close hide while docked.
 */
export const AppShell = component<AppShellProps>(({ props, slots, emit }) => {
    // The sheet's open state; docked, the drawer ignores it.
    const state = signal({ open: false });

    const brand = () => props.brand ?? 'agentic';
    const groups = (): readonly NavGroup[] =>
        props.groups ?? [{ label: 'Primary', items: props.items ?? [] }];

    // A top-level entry (`sub` unset: 17 px glyph, badge only) or a sub-item (15 px glyph, badge else count).
    const renderLink = (item: NavItem, current?: boolean, sub = false): JSXElement => {
        const active = current ?? isActive(item, props.currentPath);
        const icon = item.icon ? <NavList.Icon><Icon name={item.icon} size={sub ? 15 : 17} /></NavList.Icon> : null;
        const meta = item.badge
            ? <NavList.Meta><Badge.Root color="warning" size="sm" aria-label={needsLabel(item.badge)}>{item.badge}</Badge.Root></NavList.Meta>
            : sub && item.count
                ? <NavList.Meta><span data-nav-count="">{item.count}</span></NavList.Meta>
                : null;
        return (
            <NavList.Link asChild href={item.href} current={active}>
                {(p: PartProps) => (slots.link
                    ? slots.link({ item, active, icon, meta, props: p })
                    : <a {...p}>{icon}{item.label}{meta}</a>)}
            </NavList.Link>
        );
    };

    const switcher = (item: NavItem, s: NavSwitcher): JSXElement => (
        <button type="button" data-nav-switcher="" aria-label="Switch project" onClick={() => emit('switch', item)}>
            <ProjectSquare name={s.name} id={s.id} color={s.color} size={22} />
            <span data-nav-switcher-name="">{s.name}</span>
            <Icon name="chevron-down" size={15} />
        </button>
    );

    // A sub-menu block's opening: none for the first, a divider when asked, else its mono label with a rule after it.
    const blockHead = (group: NavGroup, index: number): JSXElement | null => {
        if (index === 0) return null;
        if (group.divider) return <hr data-nav-block-divider="" />;
        return <span data-nav-block-heading="">{group.label}</span>;
    };

    // An entry with a sub-menu: the entry, then the switcher and its blocks indented under it. The page is the sub-item it is on, not the entry.
    const renderItem = (item: NavItem): JSXElement => {
        const children = item.children?.filter((group) => group.items.length) ?? [];
        if (!children.length) return renderLink(item);
        const on = activeChild(children, props.currentPath);
        return (
            <>
                {renderLink(item, on ? false : undefined)}
                <div data-nav-children="">
                    {item.switcher ? switcher(item, item.switcher) : null}
                    {children.map((group, index) => (
                        <div data-nav-block={group.label}>
                            {blockHead(group, index)}
                            <NavList.List aria-label={group.label}>
                                {group.items.map((child) => <NavList.Item>{renderLink(child, child === on, true)}</NavList.Item>)}
                            </NavList.List>
                        </div>
                    ))}
                </div>
            </>
        );
    };

    // A click on any link in the navigation closes the sheet (docked, there is nothing to close).
    const onNavClick = (e: MouseEvent) => {
        if ((e.target as Element | null)?.closest('a')) state.open = false;
    };

    const nav = () => (
        <div data-scope={SHELL_SCOPE} data-part="nav" onClick={onNavClick}>
            <NavList.Root label="Main">
                {groups().map((group, index) => (
                    // The first group has no heading, so its label names it; the rest are named by their heading.
                    <NavList.Group aria-label={index === 0 ? group.label : undefined}>
                        {index > 0 ? <NavList.Heading>{group.label}</NavList.Heading> : null}
                        <NavList.List>
                            {group.items.map(item => <NavList.Item>{renderItem(item)}</NavList.Item>)}
                        </NavList.List>
                    </NavList.Group>
                ))}
            </NavList.Root>
        </div>
    );

    const brandMark = () => (
        <span data-scope={SHELL_SCOPE} data-part="brand">
            <span data-scope={SHELL_SCOPE} data-part="brand-mark" aria-hidden="true">a/</span>
            <span data-scope={SHELL_SCOPE} data-part="brand-name">{brand()}</span>
        </span>
    );

    const foot = () => (
        <>
            {slots.connection ? <div data-scope={SHELL_SCOPE} data-part="connection">{slots.connection()}</div> : null}
            {slots.user ? <div data-scope={SHELL_SCOPE} data-part="user">{slots.user()}</div> : null}
        </>
    );

    // The current route opens an entry's sub-menu: the phone keeps its menu beside the back link (#923).
    const hasSubMenu = (): boolean => groups().some((group) => group.items.some((item) =>
        isActive(item, props.currentPath) && !!item.children?.some((child) => child.items.length)));

    // The app bar's leading control on a detail route: back to the breadcrumb's parent.
    const backLink = (href: string) => {
        const icon = <Icon name="back" size={20} />;
        return (
            <span data-scope={SHELL_SCOPE} data-part="back">
                {slots.back ? slots.back({ href, icon }) : <a href={href} aria-label="Back">{icon}</a>}
            </span>
        );
    };

    return () => (
        <div data-scope={SHELL_SCOPE} data-part="root">
            <Drawer.Root model={() => state.open} modal={{ below: 'md' }} placement="start" label="Navigation">
                <Drawer.Panel>
                    <div data-scope={SHELL_SCOPE} data-part="drawer-head">
                        {brandMark()}
                        <Drawer.Close asChild>
                            {(p: PartProps) => <button type="button" aria-label="Close" {...p}><Icon name="close" size={20} /></button>}
                        </Drawer.Close>
                    </div>
                    <Drawer.Title visuallyHidden>{`${brand()} navigation`}</Drawer.Title>
                    {nav()}
                    <div data-scope={SHELL_SCOPE} data-part="sidebar-spacer" aria-hidden="true" />
                    {foot()}
                </Drawer.Panel>
                <div data-scope={SHELL_SCOPE} data-part="body">
                    <div data-scope={SHELL_SCOPE} data-part="bar" data-regime={props.back ? 'detail' : 'root'} data-sub-menu={hasSubMenu() ? '' : undefined}>
                        <Navbar.Root>
                            <Navbar.Start>
                                {/* Back leads, so with a sub-menu (#923) the focus order matches the phone's Back, Menu. */}
                                {props.back ? backLink(props.back) : null}
                                <Drawer.Trigger asChild>
                                    {(p: PartProps) => <button type="button" aria-label="Menu" {...p}><Icon name="menu" size={20} /></button>}
                                </Drawer.Trigger>
                                <div data-scope={SHELL_SCOPE} data-part="breadcrumb">{slots.breadcrumb?.()}</div>
                                {props.title ? (
                                    <div data-scope={SHELL_SCOPE} data-part="title">
                                        <span data-scope={SHELL_SCOPE} data-part="title-text">{props.title}</span>
                                        {slots.subtitle ? <span data-scope={SHELL_SCOPE} data-part="subtitle">{slots.subtitle()}</span> : null}
                                    </div>
                                ) : brandMark()}
                            </Navbar.Start>
                            <Navbar.End>
                                <div data-scope={SHELL_SCOPE} data-part="actions">{slots.actions?.()}</div>
                                {slots.phoneAction ? <div data-scope={SHELL_SCOPE} data-part="phone-action">{slots.phoneAction()}</div> : null}
                            </Navbar.End>
                        </Navbar.Root>
                    </div>
                    <main data-scope={SHELL_SCOPE} data-part="main" data-flush={props.flush ? '' : undefined}>{slots.default?.()}</main>
                </div>
            </Drawer.Root>
        </div>
    );
}, { name: 'AppShell' });
