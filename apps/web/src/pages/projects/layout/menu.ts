/**
 * The project's own menu (#725; HANDOFF "Navigation inside a project"): while a project route is open the sidebar's
 * `Projects` entry expands into it — Core (Overview, Chats, Work, Requests when the project has a manager), Features
 * (one item per enabled feature that draws a section) and Settings. `App.tsx` passes it to `NAV_GROUPS`; the shell
 * draws it (`NavItem.children`). Mock mode reads the sample workspace; live mode what `ProjectLayout` published.
 *
 * #728 owns this file (the switcher, counts and the picker come there); #727 draws it.
 */
import type { NavGroup, NavItem } from '@agentic/ui';
import type { TopbarRoute } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { projectNamed } from '../../../mock/workspace';
import { featureHref, featureViewsOf } from '../features/registry';
import { projectHead, type ProjectHead } from '../head';
import { SETTINGS_TABS, settingsHref } from '../settings/tabs';

/** Every route drawn inside a project (`router.ts`), by name. */
export const PROJECT_ROUTE_NAMES: ReadonlySet<string> = new Set([
    'project', 'project-chats', 'project-work', 'project-work-item', 'project-requests', 'project-plan', 'project-settings', 'project-feature'
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

/** The menu's blocks for a project: Core (headed by the project's name), Features, Settings. An empty block is dropped by the shell. */
export function projectMenu(src: ProjectHead): readonly NavGroup[] {
    const base = `/projects/${src.id}`;
    const core: NavItem[] = [
        { href: base, label: 'Overview' },
        { href: `${base}/chats`, label: 'Chats' },
        { href: `${base}/work`, label: 'Work' },
        ...(src.manager ? [{ href: `${base}/requests`, label: 'Requests' }] : [])
    ];
    const features: NavItem[] = (src.features ?? []).flatMap((id) => {
        const views = featureViewsOf(id);
        return views?.Section ? [{ href: featureHref(src.id, id), label: views.label ?? id }] : [];
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
    return src ? projectMenu(src) : undefined;
}
