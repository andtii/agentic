/**
 * `/plugins/connectors/add` (#639; PLG-01, PLG-04, AGT-02; board `AddConnector`,
 * `docs/design/plugins/HANDOFF-plugins.md` → "Add a connector"): three columns.
 *
 * - Left, 220 px: the categories with counts (`categoryCounts`), the Show control (Everything / Not connected) and
 *   "Not listed?" with `Add MCP server`.
 * - Middle: the title and `Done`, the search (`?q=`, `matchListing`), then one section per category with three tiles
 *   and "See all N" — or, with a query or a category, a flat grid. A connected tile is dimmed and opens its plugin.
 * - Right, 380 px: the `?selected=` listing's preview and `Connect <name>`. Below 1280 px it drops under the tiles;
 *   below 768 px the page is one column and the preview is a full-screen sheet with Connect docked at its foot (#641).
 *   On a phone that sheet is a modal: `role="dialog"`, focus moves to its Close, Escape closes it, and the columns
 *   under it are `inert`; focus goes back to the tile that opened it.
 *
 * Connecting runs the existing flows through the page's `AddConnectorPort` (mock or live): a conduit connector's
 * sign-in, or the MCP form prefilled from the listing. Then `?next=agents` swaps the middle column for the step that
 * adds the connector to the agents you pick — none by default. Nothing here grants anything (PLG-04).
 */
import { component, onMounted, onUnmounted, signal, useHead, watch, type Define } from 'sigx';
import { Link, useRoute, useRouter } from '@sigx/router';
import { AgentTile, Button, CategoryMenu, ConnectorTile, Icon, Label, SearchField, Segmented, Tag, type AgentHue } from '@agentic/ui';
import { CONNECTOR_CATEGORIES, CONNECTOR_LISTINGS, categoryCounts, listingPluginId, listingsByCategory, type ConnectorListing } from '../../../plugins/listings';
import { AddConnectorDialog, type AddConnectorRequest } from '../AddConnectorDialog';
import type { ConnectorDraft, ConnectorProbe } from '../connector';
import { connectorPluginPage } from '../../../connectors/paths';
import { CONNECTORS_PATH, SECTION_TILES, addHref, parseAddQuery, runsOnText, transportLabel, visibleListings, type AddQuery, type ShowFilter } from './model';

/** An agent the step offers. */
export interface ChoosableAgent {
    readonly id: string;
    readonly name: string;
    readonly role?: string;
    readonly hue?: AgentHue;
}

/** What the page reads and does — the platform's (`./live`) or the mock workspace's (`./mock`). */
export interface AddConnectorPort {
    /** The plugin ids already connected: a conduit connector with an account, an MCP server that is installed. */
    connected(): ReadonlySet<string>;
    /** Every plugin id the workspace has — a new MCP server's id must not collide. */
    taken(): ReadonlySet<string>;
    /** The workspace's agents; `null` while loading. */
    agents(): readonly ChoosableAgent[] | null;
    /**
     * Connect a conduit listing: turn its plugin on if it is off, then sign in. `redirected` when the browser left for
     * the provider (the callback brings it back to the agent step); `connected` when it is done here (mock).
     */
    connectConduit(listing: ConnectorListing): Promise<'redirected' | 'connected'>;
    /** Add an MCP server the form describes (`addConnector`); resolves to its plugin id. */
    addMcp(request: AddConnectorRequest): Promise<string>;
    /** Append `{ id: pluginId }` to each agent's connectors, one new config version each. */
    addToAgents(pluginId: string, name: string, agentIds: readonly string[]): Promise<void>;
}

export type AddConnectorViewProps =
    & Define.Prop<'port', AddConnectorPort, true>
    /** The MCP form's probe; tests hand in one over a fake server. */
    & Define.Prop<'probe', (draft: ConnectorDraft) => Promise<ConnectorProbe>>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The phone breakpoint (`--below-md`): the preview is a full-screen modal sheet below it. */
export const SHEET_MEDIA = '(max-width: 767px)';

/** The listing `?selected=` names: by its id, or by the plugin id it installs as (the sign-in callback's). */
const listingFor = (selected: string | undefined): ConnectorListing | undefined =>
    selected ? CONNECTOR_LISTINGS.find((l) => l.id === selected) ?? CONNECTOR_LISTINGS.find((l) => listingPluginId(l) === selected) : undefined;

export const AddConnectorView = component<AddConnectorViewProps>(({ props }) => {
    useHead({ title: 'Add a connector' });
    const route = useRoute();
    const router = useRouter();
    const query = (): AddQuery => parseAddQuery(route.query as Record<string, unknown>);
    const go = (q: AddQuery): void => { void router.replace(addHref(q)); };

    const st = signal<{ q: string; show: ShowFilter; busy: boolean; error: string; mcp: ConnectorListing | 'blank' | null; dialog: boolean; addError: string; picked: string[]; saving: boolean; saveError: string }>({
        q: query().q ?? '',
        show: query().show ?? 'everything',
        busy: false,
        error: '',
        mcp: null,
        dialog: false,
        addError: '',
        picked: [],
        saving: false,
        saveError: ''
    });
    /** Below `SHEET_MEDIA` — set on the client only, so a server render draws no modal. */
    const phone = signal({ on: false });

    const closePreview = (): void => { const { selected: _selected, ...rest } = query(); go(rest); };
    /** The preview is a modal sheet: a phone, a listing selected, and not on the agent step. */
    const sheetOpen = (): boolean => {
        const q = query();
        return phone.on && !!listingFor(q.selected) && q.next !== 'agents';
    };

    onMounted(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(SHEET_MEDIA);
        const sync = (): void => { phone.on = mq.matches; };
        sync();
        mq.addEventListener('change', sync);
        // Escape closes the sheet — unless the MCP dialog is open over it, which handles its own Escape.
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape' || st.dialog || !sheetOpen()) return;
            e.preventDefault();
            closePreview();
        };
        document.addEventListener('keydown', onKey);
        // Focus into the sheet on open (its Close), and back to the tile that opened it on close.
        let opener: string | undefined;
        const stop = watch(sheetOpen, (open) => {
            if (open) {
                opener = query().selected;
                requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-add-preview][data-sheet] [data-preview-close] button')?.focus());
            } else if (opener) {
                const id = opener;
                opener = undefined;
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-add-grid] [data-connector="${CSS.escape(id)}"]`)?.focus());
            }
        }, { immediate: true });
        onUnmounted(() => {
            mq.removeEventListener('change', sync);
            document.removeEventListener('keydown', onKey);
            stop.stop();
        });
    });

    const search = (value: string): void => {
        st.q = value;
        const { selected, ...rest } = query();
        go({ ...rest, ...(value.trim() ? { q: value } : { q: undefined }), ...(selected ? { selected } : {}) });
    };

    const open = (listing: ConnectorListing): void => {
        if (props.port.connected().has(listingPluginId(listing))) {
            void router.push(connectorPluginPage(listingPluginId(listing)));
            return;
        }
        go({ ...query(), selected: listing.id });
    };

    const toAgents = (listing: ConnectorListing | undefined, pluginId: string): void => {
        st.picked = [];
        st.saveError = '';
        go({ ...(listing ? { selected: listing.id } : {}), next: 'agents', ...(!listing || listingPluginId(listing) !== pluginId ? { plugin: pluginId } : {}) });
    };

    const connect = async (listing: ConnectorListing): Promise<void> => {
        st.error = '';
        if (listing.transport !== 'conduit') {
            st.addError = '';
            st.mcp = listing;
            st.dialog = true;
            return;
        }
        st.busy = true;
        try {
            if ((await props.port.connectConduit(listing)) === 'connected') toAgents(listing, listingPluginId(listing));
        } catch (e) {
            st.error = errorText(e);
        } finally {
            st.busy = false;
        }
    };

    const addMcp = async (request: AddConnectorRequest): Promise<void> => {
        const listing = st.mcp === 'blank' ? undefined : st.mcp ?? undefined;
        st.busy = true;
        st.addError = '';
        try {
            const id = await props.port.addMcp(request);
            st.dialog = false;
            st.mcp = null;
            toAgents(listing, id);
        } catch (e) {
            st.addError = errorText(e);
        } finally {
            st.busy = false;
        }
    };

    const save = async (pluginId: string, name: string): Promise<void> => {
        st.saving = true;
        st.saveError = '';
        try {
            await props.port.addToAgents(pluginId, name, st.picked);
            await router.push(connectorPluginPage(pluginId));
        } catch (e) {
            st.saveError = errorText(e);
        } finally {
            st.saving = false;
        }
    };

    const tile = (listing: ConnectorListing, selected: string | undefined, connected: ReadonlySet<string>) => (
        <ConnectorTile
            key={listing.id}
            id={listing.id}
            name={listing.name}
            transport={transportLabel(listing.transport)}
            description={listing.description}
            selected={listing.id === selected}
            connected={connected.has(listingPluginId(listing))}
            onSelect={() => open(listing)}
        />
    );

    const side = (q: AddQuery, connected: ReadonlySet<string>, covered: boolean) => {
        const counts = categoryCounts(CONNECTOR_LISTINGS, connected, q.show ?? 'everything');
        const base = { ...(q.q ? { q: q.q } : {}), ...(q.show ? { show: q.show } : {}) };
        return (
            <aside data-add-side aria-label="Connector filters" inert={covered || undefined}>
                <CategoryMenu
                    label="Connector categories"
                    current={q.category ?? 'all'}
                    groups={[{
                        label: 'Categories',
                        items: [
                            { id: 'all', label: 'All', count: counts.all, href: addHref(base) },
                            ...CONNECTOR_CATEGORIES.map((c) => ({ id: c.id, label: c.label, count: counts[c.id], href: addHref({ ...base, category: c.id }) }))
                        ]
                    }]}
                />
                <div data-add-show>
                    <Label>Show</Label>
                    <Segmented
                        label="Show"
                        model={() => st.show}
                        options={[{ value: 'not-connected', label: 'Not connected' }, { value: 'everything', label: 'Everything' }]}
                        onValueChange={(v: string) => { st.show = v === 'not-connected' ? 'not-connected' : 'everything'; const { show: _show, ...rest } = query(); go({ ...rest, ...(v === 'not-connected' ? { show: 'not-connected' as const } : {}) }); }}
                    />
                </div>
                <div data-add-unlisted>
                    <Label>Not listed?</Label>
                    <p>Any MCP server works: paste its URL, or run it on a paired machine.</p>
                    <Button icon="plus" onClick={() => { st.addError = ''; st.mcp = 'blank'; st.dialog = true; }}>Add MCP server</Button>
                </div>
            </aside>
        );
    };

    const browse = (q: AddQuery, connected: ReadonlySet<string>, covered: boolean) => {
        const shown = visibleListings(CONNECTOR_LISTINGS, connected, q);
        const flat = !!q.q?.trim() || !!q.category;
        return (
            <div data-add-main inert={covered || undefined}>
                <header data-add-head>
                    <div>
                        <h1>Add a connector</h1>
                        <p>Give agents access to your services. Nothing is shared with an agent until you add it to that agent’s tools.</p>
                    </div>
                    <Button href={CONNECTORS_PATH}>Done</Button>
                </header>
                <SearchField
                    label="Search connectors"
                    placeholder="Search by name, service or what it does — “calendar”, “send email”"
                    model={() => st.q}
                    onValueChange={search}
                />
                {flat ? (
                    shown.length
                        ? <div data-add-grid data-add-results>{shown.map((l) => tile(l, q.selected, connected))}</div>
                        : <p data-add-none>No connector matches. Not listed? Add it as an MCP server.</p>
                ) : (
                    listingsByCategory(shown).filter((s) => s.listings.length).map((s) => (
                        <section data-add-section={s.category.id} aria-label={s.category.label}>
                            <div data-add-section-head>
                                <h2>{s.category.label}</h2>
                                <span data-count>{s.listings.length}</span>
                                <Link to={addHref({ ...q, category: s.category.id })}>See all {s.listings.length}</Link>
                            </div>
                            <div data-add-grid>{s.listings.slice(0, SECTION_TILES).map((l) => tile(l, q.selected, connected))}</div>
                        </section>
                    ))
                )}
            </div>
        );
    };

    const preview = (listing: ConnectorListing | undefined, connected: ReadonlySet<string>, step: boolean, modal: boolean) => {
        if (!listing) return <aside data-add-preview data-empty><p>Pick a connector to see what it adds and what it will ask for.</p></aside>;
        const isConnected = connected.has(listingPluginId(listing));
        const asks = [...(listing.asks.signIn ? [listing.asks.signIn] : []), ...listing.asks.scopes];
        return (
            <aside data-add-preview data-connector={listing.id} data-sheet={step ? undefined : ''}
                {...(modal ? { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'add-preview-title' } : { 'aria-label': `${listing.name} preview` })}>
                <div data-preview-head>
                    <AgentTile name={listing.name} size={44} />
                    <div>
                        <h2 id="add-preview-title">{listing.name}</h2>
                        <div data-preview-meta>
                            <Tag>{transportLabel(listing.transport)}</Tag>
                            <code data-mono>{listing.publisher.toLowerCase()} · {listing.version}</code>
                        </div>
                    </div>
                    {/* The phone's full-screen sheet (#641) closes back to the list; hidden wider, where the preview is a column. */}
                    {step ? null : <span data-preview-close><Button intent="icon" icon="close" label="Close preview" onClick={closePreview} /></span>}
                </div>
                <p data-preview-description>{listing.description}</p>
                <div data-preview-group="tools">
                    <Label>Tools it adds{listing.tools.length ? ` · ${listing.tools.length}` : ''}</Label>
                    {listing.tools.length ? (
                        <ul>
                            {listing.tools.map((t) => (
                                <li data-tool={t.name} data-asks={t.askByDefault ? '' : undefined}>
                                    <Icon name="check" size={13} />
                                    <code data-mono>{t.name}</code>
                                    {t.askByDefault ? <span data-dim>asks by default</span> : null}
                                </li>
                            ))}
                        </ul>
                    ) : <p data-dim>The server lists its own tools; Test connection shows them before anything is saved.</p>}
                </div>
                <div data-preview-group="asks">
                    <Label>It will ask for</Label>
                    <ul>
                        {asks.map((a) => <li><Icon name="check" size={13} /><code data-mono>{a}</code></li>)}
                        {listing.asks.secrets.map((s) => <li data-secret><Icon name="check" size={13} /><code data-mono>{s}</code><span data-dim>secret</span></li>)}
                    </ul>
                </div>
                <div data-preview-group="runs-on">
                    <Label>Runs on</Label>
                    <p>{runsOnText(listing)}</p>
                </div>
                {step ? null : <div data-preview-foot>
                    {isConnected ? (
                        <Button block href={connectorPluginPage(listingPluginId(listing))}>Open {listing.name}</Button>
                    ) : (
                        <Button intent="primary" block loading={st.busy} disabled={st.busy} onClick={() => { void connect(listing); }}>Connect {listing.name}</Button>
                    )}
                    {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
                    <p data-dim>{isConnected ? 'Already connected. Add it to agents from their Config.' : 'Next: sign in, then choose which agents get it.'}</p>
                </div>}
            </aside>
        );
    };

    const agentsStep = (listing: ConnectorListing | undefined, pluginId: string) => {
        // A listing renamed on the way in (Sentry → `sentry-eu`) was installed under its own id: name it by that, not the listing.
        const name = listing && listingPluginId(listing) === pluginId ? listing.name : pluginId;
        const agents = props.port.agents();
        const toggle = (id: string, on: boolean): void => { st.picked = on ? [...st.picked.filter((x) => x !== id), id] : st.picked.filter((x) => x !== id); };
        return (
            <div data-add-main data-add-step="agents">
                <header data-add-head>
                    <div>
                        <h1>Choose agents for {name}</h1>
                        <p>{name} is connected. Pick the agents that get its tools; none are picked for you. Each one gets a new config version, and you can change it later on the agent’s Config.</p>
                    </div>
                </header>
                {agents === null ? <p data-add-none>Loading agents…</p> : agents.length === 0 ? <p data-add-none>This workspace has no agents yet.</p> : (
                    <fieldset data-add-agents>
                        <legend data-visually-hidden>Agents that get {name}</legend>
                        {agents.map((a) => (
                            <label data-add-agent={a.id}>
                                <input type="checkbox" name="agent" value={a.id} checked={st.picked.includes(a.id)} onChange={(e: Event) => toggle(a.id, (e.target as HTMLInputElement).checked)} />
                                <AgentTile name={a.name} {...(a.hue ? { hue: a.hue } : {})} size={32} />
                                <span data-add-agent-name>{a.name}</span>
                                {a.role ? <span data-dim>{a.role}</span> : null}
                            </label>
                        ))}
                    </fieldset>
                )}
                {st.saveError ? <p data-chat-error role="alert">{st.saveError}</p> : null}
                <div data-add-step-actions>
                    <Button intent="primary" loading={st.saving} disabled={st.saving || st.picked.length === 0} onClick={() => { void save(pluginId, name); }}>
                        {st.picked.length ? `Add to ${st.picked.length} ${st.picked.length === 1 ? 'agent' : 'agents'}` : 'Add to agents'}
                    </Button>
                    <Button disabled={st.saving} onClick={() => { void router.push(connectorPluginPage(pluginId)); }}>Skip</Button>
                </div>
            </div>
        );
    };

    return () => {
        const q = query();
        const connected = props.port.connected();
        const listing = listingFor(q.selected);
        const stepPlugin = q.next === 'agents' ? q.plugin ?? (listing ? listingPluginId(listing) : undefined) : undefined;
        const modal = sheetOpen();
        const dialogListing = st.mcp && st.mcp !== 'blank' ? st.mcp : undefined;
        return (
            <section data-page="connector-add" aria-label="Add a connector">
                {side(q, connected, modal)}
                {stepPlugin ? agentsStep(listing, stepPlugin) : browse(q, connected, modal)}
                {preview(listing, connected, !!stepPlugin, modal)}
                <AddConnectorDialog
                    model={() => st.dialog}
                    busy={st.busy}
                    taken={props.port.taken()}
                    error={st.addError}
                    initial={dialogListing?.mcpPreset ? { name: dialogListing.name, url: dialogListing.mcpPreset.url, auth: dialogListing.mcpPreset.auth ?? 'none', header: dialogListing.mcpPreset.header ?? '' } : undefined}
                    {...(props.probe ? { probe: props.probe } : {})}
                    onAdd={(request: AddConnectorRequest) => { void addMcp(request); }}
                    onCancel={() => { st.dialog = false; st.mcp = null; }}
                />
            </section>
        );
    };
}, { name: 'AddConnectorView' });
