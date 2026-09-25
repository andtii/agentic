/**
 * The breadcrumb inside a project (#725): always `Projects › <project> › …` (HANDOFF "Navigation inside a project").
 * A page's topbar contribution returns `{ trail: projectTrail(route, …) }` with its own tail.
 */
import type { TopbarRoute } from '../../../components/topbar';
import { projectMenuSource } from './menu';

export interface TrailCrumb {
    readonly label: string;
    readonly href: string;
}

/** `Projects › <project name>`, then `tail`; the last crumb is the current page. */
export function projectTrail(route: TopbarRoute, ...tail: readonly TrailCrumb[]): TrailCrumb[] {
    const id = String(route.params.id ?? '');
    const name = projectMenuSource(route)?.name ?? id;
    return [{ label: 'Projects', href: '/projects' }, { label: name, href: `/projects/${id}` }, ...tail];
}
