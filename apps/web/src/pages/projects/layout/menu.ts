/**
 * The project's own menu (#725; HANDOFF "Navigation inside a project"): while a project route is open the sidebar's
 * `Projects` entry expands into it — Core (Overview, Chats, Work, Requests when the project has a manager), Features
 * (one item per enabled feature that draws a section) and Settings. `App.tsx` passes it to `NAV_GROUPS`; the shell
 * draws it (`NavItem.children`). Mock mode reads the sample workspace; live mode what `ProjectLayout` published.
 *
 * Counts (#728, `counts.ts`): Chats carries `count`, Work carries the `needs-you` `badge` when something there waits
 * on the person and its `count` otherwise, a feature section its own `count`. The first block's label is the project's
 * name — the switcher #727 draws, which opens the picker (`ProjectPicker.tsx`).
 *
 * #728 owns this file; #727 draws it.
 */
import type { NavGroup, NavItem } from '@agentic/ui';
import type { TopbarRoute } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { MOCK_PROJECT_MENU_COUNTS } from '../../../mock/projects/layout';
import { CHATS, projectNamed } from '../../../mock/workspace';
import { featureHref, featureViewsOf } from '../features/registry';
import { projectHead, type ProjectHead } from '../head';
import { SETTINGS_TABS, settingsHref } from '../settings/tabs';
import { countsFromChats, projectCounts, type ProjectMenuCounts } from './counts';

/** A menu entry with its plain count (mono, `text-dim`), beside `badge`, the count that needs the person. */
export interface ProjectMenuItem extends NavItem {
    readonly count?: number;
}

const counted = (n: number | undefined): { count?: number } => (n ? { count: n } : {});

/** Every route drawn inside a project (`router.ts`), by name. */
export const PROJECT_ROUTE_NAMES: ReadonlySet<string> = new Set([
    'project', 'project-chats', 'project-work', 'project-work-item', 'project-requests', 'project-plan', 'project-settings', 'project-code', 'project-feature'
]);

/** The project a route is inside, as far as the menu needs it; `undefined` off a project route or before it loads. */
export function projectMenuSource(route: TopbarRoute): ProjectHead | undefined {
    if (typeof route.name !== 'string' || !PROJECT_ROUTE_NAMES.has(route.name)) return undefined;
    const id = String(route.params.id ?? '');
    if (!id) return undefined;
    if (dataMode() === 'live') {
        const head = projectHead.value;
        return head?.id === id ? head : { id, name: id };
    }
    const p = projectNamed(id);
    return p ? { id, name: p.name, features: Object.keys(p.features), manager: p.members.coordinator !== null } : undefined;
}

/** The counts of the project a route is inside: live what `ProjectLayout` read, mock the sample counts or the sample chats. */
export function projectMenuCounts(id: string): ProjectMenuCounts | undefined {
    if (dataMode() === 'live') {
        const c = projectCounts.value;
        return c?.id === id ? c.counts : undefined;
    }
    return MOCK_PROJECT_MENU_COUNTS[id] ?? countsFromChats(id, CHATS);
}

/**
 * The menu's blocks for a project: Core (headed by the project's name), Features, Settings, with `counts` on Chats,
 * Work and the feature sections. An empty block is dropped by the shell.
 */
export function projectMenu(src: ProjectHead, counts: ProjectMenuCounts = {}): readonly NavGroup[] {
    const base = `/projects/${src.id}`;
    const needsYou = counts.needsYou ?? 0;
    const core: ProjectMenuItem[] = [
        { href: base, label: 'Overview', icon: 'home' },
        { href: `${base}/chats`, label: 'Chats', icon: 'chats', ...counted(counts.chats) },
        { href: `${base}/work`, label: 'Work', icon: 'check', ...(needsYou > 0 ? { badge: needsYou } : counted(counts.work)) },
        ...(src.manager ? [{ href: `${base}/requests`, label: 'Requests', icon: 'delegate' as const }] : [])
    ];
    const features: ProjectMenuItem[] = (src.features ?? []).flatMap((id) => {
        const views = featureViewsOf(id);
        return views?.Section ? [{ href: featureHref(src.id, id), label: views.label ?? id, ...counted(counts.features?.[id]) }] : [];
    });
    const settings: NavItem[] = SETTINGS_TABS.map((t) => ({ href: settingsHref(src.id, t.id), label: t.label }));
    return [
        { label: src.name, items: core },
        { label: 'Features', items: features },
        { label: 'Settings', items: settings }
    ];
}

/** The menu for the current route, or `undefined` off a project. */
export function projectMenuFor(route: TopbarRoute): readonly NavGroup[] | undefined {
    const src = projectMenuSource(route);
    return src ? projectMenu(src, projectMenuCounts(src.id)) : undefined;
}
