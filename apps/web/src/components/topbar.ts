/**
 * What a page contributes to the shell's topbar: its actions (rendered in
 * the `actions` slot) and the breadcrumb's current label when the route's
 * `:id` is not what a person should read ("Mobile pass #47", not "c1").
 *
 * A registry keyed by route name, filled at module load by each page
 * (`defineTopbar`) and read by the App from the current route. Pure
 * functions of the route: no per-request state, so a server rendering
 * many requests in one process and a client hydrating the same HTML agree.
 */
import type { JSXElement } from 'sigx';

export interface TopbarRoute {
    readonly name?: string | symbol | null;
    readonly path: string;
    readonly params: Record<string, string | string[] | undefined>;
}

export interface TopbarContribution {
    /** Rendered in the topbar's actions slot, right-aligned. */
    readonly actions?: () => JSXElement;
    /** The breadcrumb's current-page label. */
    readonly crumb?: string;
}

const registry = new Map<string, (route: TopbarRoute) => TopbarContribution>();

/** Register a route's topbar contribution; the last definition for a name wins. */
export function defineTopbar(routeName: string, resolve: (route: TopbarRoute) => TopbarContribution): void {
    registry.set(routeName, resolve);
}

/** The contribution for the current route, if its page defined one. */
export function topbarFor(route: TopbarRoute): TopbarContribution | undefined {
    const name = typeof route.name === 'string' ? route.name : undefined;
    return name ? registry.get(name)?.(route) : undefined;
}

/** The `:id` of a route as a string. */
export const routeId = (route: TopbarRoute): string => String(route.params.id ?? '');
