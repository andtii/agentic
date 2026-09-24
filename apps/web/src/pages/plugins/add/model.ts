/**
 * The Add connector page's state (#639; PLG-01, PLG-04, AGT-02), all of it in the URL so a reload restores it:
 * `?category=` the menu's pick, `?q=` the search, `?show=not-connected` the Show control, `?selected=` the listing
 * the preview shows, and `?next=agents` the step after connecting (with `?plugin=` when the plugin id is not the
 * listing's — an MCP server renamed in the form, or one added from "Not listed?"). Nothing here draws.
 */
import type { AgentConfig, ConnectorRef } from '@agentic/core';
import { CONNECTOR_CATEGORIES, listingPluginId, matchListing, type ConnectorCategory, type ConnectorListing, type ConnectorTransport } from '../../../plugins/listings';
import { queryOf } from '../../session/files';

export const ADD_CONNECTOR_PATH = '/plugins/connectors/add';

/** Where `Done` goes: the connectors you have. */
export const CONNECTORS_PATH = '/plugins?kind=connector';

export type ShowFilter = 'everything' | 'not-connected';

export interface AddQuery {
    readonly category?: ConnectorCategory;
    readonly q?: string;
    readonly show?: ShowFilter;
    readonly selected?: string;
    readonly next?: 'agents';
    readonly plugin?: string;
}

const isCategory = (v: string | undefined): v is ConnectorCategory => CONNECTOR_CATEGORIES.some((c) => c.id === v);

/** The page's state from the route's query; anything it does not know is dropped. */
export function parseAddQuery(query: Record<string, unknown>): AddQuery {
    const category = queryOf(query.category);
    const q = queryOf(query.q);
    const show = queryOf(query.show);
    const selected = queryOf(query.selected);
    const plugin = queryOf(query.plugin);
    return {
        ...(isCategory(category) ? { category } : {}),
        ...(q ? { q } : {}),
        ...(show === 'not-connected' ? { show } : {}),
        ...(selected ? { selected } : {}),
        ...(queryOf(query.next) === 'agents' ? { next: 'agents' as const } : {}),
        ...(plugin ? { plugin } : {})
    };
}

/**
 * `/plugins/connectors/add` with `q`, every value percent-encoded (`%20`, never `+`: the router decodes with
 * `decodeURIComponent`), in a fixed order so equal states are equal links.
 */
export function addHref(q: AddQuery = {}): string {
    const pairs: [string, string | undefined][] = [['category', q.category], ['q', q.q], ['show', q.show], ['selected', q.selected], ['next', q.next], ['plugin', q.plugin]];
    const s = pairs.filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
    return `${ADD_CONNECTOR_PATH}${s ? `?${s}` : ''}`;
}

/** The listings the page shows: the search, the Show control, the category (the menu's counts ignore the category). */
export function visibleListings(listings: readonly ConnectorListing[], connected: ReadonlySet<string>, q: AddQuery): ConnectorListing[] {
    return listings.filter(
        (l) => matchListing(l, q.q ?? '') && (q.show !== 'not-connected' || !connected.has(listingPluginId(l))) && (!q.category || l.category === q.category)
    );
}

/** A section's tiles when no query narrows the page: three, then "See all N". */
export const SECTION_TILES = 3;

/** How a transport reads on a tile and in the preview. */
export const transportLabel = (t: ConnectorTransport): string => (t === 'mcp-stdio' ? 'mcp stdio' : t);

/** "Runs on", in words. */
export const runsOnText = (l: Pick<ConnectorListing, 'runsOn'>): string => (l.runsOn === 'machine' ? 'A paired machine. It runs there, over stdio.' : 'The platform. No machine needed.');

/** The version a new agent config gets when a connector is added to it from here. */
export const addedReason = (name: string): string => `Added ${name} from Plugins`;

/** The agent's connectors with `pluginId` appended — or `null` when it already lists it (no new version). */
export function withConnector(connectors: readonly ConnectorRef[], pluginId: string): ConnectorRef[] | null {
    return connectors.some((c) => c.id === pluginId) ? null : [...connectors, { id: pluginId }];
}

/** The config the agent step saves: the agent's own, with the connector appended; `null` when it already has it. */
export function configWithConnector(config: AgentConfig, pluginId: string): AgentConfig | null {
    const connectors = withConnector(config.connectors, pluginId);
    return connectors ? { ...config, connectors } : null;
}
