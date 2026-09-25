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
    'chat-new': { label: 'Chats', href: '/chats' },
    chat: { label: 'Chats', href: '/chats' },
    projects: { label: 'Projects', href: '/projects' },
    'projects-links': { label: 'Projects', href: '/projects' },
    'project-new': { label: 'Projects', href: '/projects' },
    project: { label: 'Projects', href: '/projects' },
    // Inside a project (#725) each page's topbar gives the whole trail, `Projects › <project> › …` (`projects/layout/trail.ts`).
    'project-chats': { label: 'Projects', href: '/projects' },
    'project-work': { label: 'Projects', href: '/projects' },
    'project-work-item': { label: 'Projects', href: '/projects' },
    'project-requests': { label: 'Projects', href: '/projects' },
    'project-plan': { label: 'Projects', href: '/projects' },
    'project-settings': { label: 'Projects', href: '/projects' },
    'project-code': { label: 'Projects', href: '/projects' },
    'project-git-legacy': { label: 'Projects', href: '/projects' },
    'project-feature': { label: 'Projects', href: '/projects' },
    agents: { label: 'Agents', href: '/agents' },
    agent: { label: 'Agents', href: '/agents' },
    tasks: { label: 'Tasks', href: '/tasks' },
    task: { label: 'Tasks', href: '/tasks' },
    session: { label: 'Sessions', href: '/' },
    'session-changes': { label: 'Sessions', href: '/' },
    'session-files': { label: 'Sessions', href: '/' },
    machines: { label: 'Machines', href: '/machines' },
    machine: { label: 'Machines', href: '/machines' },
    pair: { label: 'Machines', href: '/machines' },
    schedules: { label: 'Schedules', href: '/schedules' },
    plugins: { label: 'Plugins', href: '/plugins' },
    plugin: { label: 'Plugins', href: '/plugins' },
    'connector-add': { label: 'Plugins', href: '/plugins' },
    settings: { label: 'Settings', href: '/settings' },
    history: { label: 'History', href: '/history' },
    usage: { label: 'Usage', href: '/usage' },
    // The desktop app's quick-ask window (#849) renders without the shell; the crumb is for completeness.
    quick: { label: 'Quick ask', href: '/' }
};

/** Fixed trails for routes deeper than section › entity that carry no id. */
export const TRAILS: Record<string, readonly { label: string; href: string }[]> = {
    'connector-add': [
        { label: 'Plugins', href: '/plugins' },
        { label: 'Connectors', href: '/plugins?kind=connector' },
        { label: 'Add connector', href: '/plugins/connectors/add' }
    ],
    'projects-links': [
        { label: 'Projects', href: '/projects' },
        { label: 'Links', href: '/projects/links' }
    ]
};

/**
 * The trail for a route: the root alone on a section page; root + the
 * entity on a detail page (the page's `crumb`, else its `:id`). `/pair` is
 * a child of Machines without an id, so a page may also name itself with
 * `crumb` on a route that has no parameter.
 */
export function trailFor(route: TopbarRoute, contribution: TopbarContribution | undefined): Crumb[] {
    if (contribution?.trail?.length) return contribution.trail.map((c, i, all) => ({ label: c.label, href: c.href, ...(i === all.length - 1 ? { current: true } : {}) }));
    const fixed = TRAILS[String(route.name ?? '')];
    if (fixed) return fixed.map((c, i, all) => ({ ...c, ...(i === all.length - 1 ? { current: true } : {}) }));
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
