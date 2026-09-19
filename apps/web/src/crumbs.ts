/**
 * The topbar breadcrumb per route: a root (the section) and, on a detail
 * route, the entity the page names through its topbar contribution
 * (`components/topbar.ts` → `crumb`). One trail feeds both regimes: ≥ 768
 * the breadcrumb (`Machines › alien01`, one line, ellipsis on the entity),
 * < 768 the app bar's title (the current crumb) and its back link (the
 * parent) — `docs/design/HANDOFF.md` → "Layout and shell", "Mobile specifics".
 */
import type { TopbarContribution, TopbarRoute } from './components/topbar';

export interface Crumb {
    readonly label: string;
    readonly href: string;
    readonly current?: boolean;
}

/** Breadcrumb roots per route name. */
export const CRUMBS: Record<string, { label: string; href: string }> = {
    home: { label: 'Home', href: '/' },
    chats: { label: 'Chats', href: '/chats' },
    chat: { label: 'Chats', href: '/chats' },
    agents: { label: 'Agents', href: '/agents' },
    agent: { label: 'Agents', href: '/agents' },
    tasks: { label: 'Tasks', href: '/tasks' },
    task: { label: 'Tasks', href: '/tasks' },
    session: { label: 'Sessions', href: '/' },
    machines: { label: 'Machines', href: '/machines' },
    machine: { label: 'Machines', href: '/machines' },
    pair: { label: 'Machines', href: '/machines' },
    schedules: { label: 'Schedules', href: '/schedules' },
    plugins: { label: 'Plugins', href: '/plugins' },
    plugin: { label: 'Plugins', href: '/plugins' },
    settings: { label: 'Settings', href: '/settings' },
    history: { label: 'History', href: '/history' },
    usage: { label: 'Usage', href: '/usage' }
};

/**
 * The trail for a route: the root alone on a section page; root + the
 * entity on a detail page (the page's `crumb`, else its `:id`). `/pair` is
 * a child of Machines without an id, so a page may also name itself with
 * `crumb` on a route that has no parameter.
 */
export function trailFor(route: TopbarRoute, contribution: TopbarContribution | undefined): Crumb[] {
    const root = CRUMBS[String(route.name ?? '')];
    if (!root) return [];
    const id = route.params.id;
    const isRoot = route.path === root.href;
    const label = contribution?.crumb ?? (id ? String(id) : undefined);
    if (isRoot || !label) return [{ ...root, current: true }];
    return [root, { label, href: route.path, current: true }];
}

/** The app bar's title below 768 px: the current crumb. */
export const titleOf = (trail: readonly Crumb[]): string | undefined => trail.at(-1)?.label;

/** The app bar's back link below 768 px: the parent crumb on a detail route. */
export const backOf = (trail: readonly Crumb[]): string | undefined => (trail.length > 1 ? trail[trail.length - 2]!.href : undefined);
