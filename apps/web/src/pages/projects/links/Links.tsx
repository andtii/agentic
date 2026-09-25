/**
 * `/projects/links` (#765, PRJ-17): links across projects — the Projects | Links tabs, an Open / Done toggle, one
 * 150px lane per project with its manager, 230px item nodes, bezier arrows from the item waited on to the waiting one,
 * the selected milestone's chain highlighted (1.8px) with the legend, and the chain panel listing it in order with
 * `Open plan`. Below 768px the graph gives way to a stacked list of chains. The layout is `linksLayout` (./model.ts).
 * Its trail is `crumbs.ts`'s.
 *
 * Mock data draws `MOCK_PROJECT_LINKS`; live, every project's `Plan.linkItems()` through `workspaceLinks` (#881,
 * ./live.ts), with the agents' names from the directory.
 */
import { component, signal, useHead, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { AgentTile, EmptyState, Icon, ItemGlyph } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { dataMode } from '../../../data-mode';
import { MOCK_PROJECT_LINKS } from '../../../mock/projects/links';
import { useAgentDirectory } from '../../chat/directory';
import { useProjects } from '../live';
import { liveLinksData, useLiveLinks, type LinkAgentNames } from './live';
import { chainOf, itemsOf, linkChains, linkCount, linksLayout, LINKS_NODE_W, milestonesOf, toggleLabel, type LinkActor, type LinkItem, type LinksData, type LinksView } from './model';


const Tile = (a: LinkActor) => <AgentTile name={a.name} hue={a.hue} person={a.person ?? false} monogram={a.monogram} size={18} />;

const RefChip = (ref: string) => (
    <span data-links-ref="">
        <Icon name="folder" size={11} />
        <span>{ref}</span>
    </span>
);

const Flag = () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 21V4" />
        <path d="M5 4h11l-2 4 2 4H5" />
    </svg>
);

const NodeBody = (i: LinkItem) => (
    <>
        <span data-links-node-head="">
            <span data-links-node-ref="">{i.ref}</span>
            <ItemGlyph state={i.state} />
            <span data-links-grow="" />
            {i.owner ? Tile(i.owner) : null}
        </span>
        <span data-links-node-title="" title={i.title}>{i.title}</span>
        <span data-links-node-meta="">{i.meta}</span>
    </>
);

export type LinksGraphProps =
    & Define.Prop<'view', LinksView, true>
    /** The selected milestone: its chain is highlighted. */
    & Define.Prop<'selected', string>
    & Define.Event<'select', string>;

/** The lanes, arrows and nodes of one view. */
export const LinksGraph = component<LinksGraphProps>(({ props, emit }) => () => {
    const chain = new Set(props.selected ? chainOf(props.view, props.selected).map((i) => i.ref) : []);
    const g = linksLayout(props.view, chain);
    const item = itemsOf(props.view);
    return (
        <div data-links-scroll="">
            <div data-links-canvas="" style={{ width: `${g.width}px`, height: `${g.height}px` }}>
                {g.lanes.map((l) => (
                    <div key={l.projectId} data-links-lane={l.projectId} style={{ top: `${l.y}px` }}>
                        <span data-links-lane-name="">
                            <Icon name="folder" size={13} />
                            <span>{l.name}</span>
                        </span>
                        {l.manager ? (
                            <span data-links-lane-pm="">
                                {Tile(l.manager)}
                                <span>{`PM ${l.manager.name}`}</span>
                            </span>
                        ) : null}
                    </div>
                ))}
                <svg data-links-edges="" width={g.width} height={g.height} viewBox={`0 0 ${g.width} ${g.height}`} aria-hidden="true">
                    {g.edges.map((e) => (
                        <g key={`${e.from}>${e.to}`} data-links-edge={`${e.from}>${e.to}`} data-highlighted={e.highlighted ? '' : undefined}>
                            <path d={e.d} data-links-edge-line="" />
                            <path d={e.head} data-links-edge-head="" />
                        </g>
                    ))}
                </svg>
                <ol data-links-nodes="" aria-label="Linked items">
                    {g.nodes.map((n) => {
                        const i = item.get(n.ref)!;
                        const style = { left: `${n.x}px`, top: `${n.y}px`, width: `${LINKS_NODE_W}px` };
                        return (
                            <li key={n.ref} data-links-node={n.ref} data-state={i.state} data-in-chain={chain.has(n.ref) ? '' : undefined} style={style}>
                                {i.milestone ? (
                                    <button type="button" data-links-node-body="" aria-pressed={props.selected === n.ref ? 'true' : 'false'} aria-label={`Highlight the chain holding up ${n.ref}`} onClick={() => emit('select', n.ref)}>
                                        {NodeBody(i)}
                                    </button>
                                ) : (
                                    <div data-links-node-body="">{NodeBody(i)}</div>
                                )}
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}, { name: 'LinksGraph' });

/** The panel under the graph: the selected milestone's chain in order, who is on each step, and Open plan. */
export const ChainPanel = component<Define.Prop<'view', LinksView, true> & Define.Prop<'selected', string, true>>(({ props }) => () => {
    const steps = chainOf(props.view, props.selected);
    const end = steps.at(-1);
    if (!end) return null;
    return (
        <section data-links-chain="" aria-label={`What ${end.ref} is waiting for`}>
            <header data-links-chain-head="">
                <span data-links-chain-icon=""><Flag /></span>
                <h2>{`What ${end.ref} is waiting for`}</h2>
                <span data-links-grow="" />
                <Link to={`/projects/${end.projectId}/plan`} class="links-open-plan">Open plan</Link>
            </header>
            <ol data-links-chain-steps="">
                {steps.map((s, n) => (
                    <li key={s.ref} data-links-step={s.ref}>
                        <span data-links-step-n="">{String(n + 1)}</span>
                        {RefChip(s.ref)}
                        {s.owner ? Tile(s.owner) : null}
                        <span data-links-step-text="" data-tone={s.step?.tone ?? 'muted'}>{s.step?.text ?? s.meta}</span>
                    </li>
                ))}
            </ol>
        </section>
    );
}, { name: 'ChainPanel' });

/** Below 768px: each chain as a stacked list, the item holding it up first. */
export const ChainList = component<Define.Prop<'view', LinksView, true>>(({ props }) => () => (
    <ol data-links-chains="" aria-label="Chains">
        {linkChains(props.view).map((c) => (
            <li key={c.end.ref} data-links-chain-card={c.end.ref}>
                <span data-links-chain-card-head="">
                    {RefChip(c.end.ref)}
                    <span data-links-chain-card-title="">{c.end.title}</span>
                </span>
                <ol data-links-chain-card-steps="">
                    {c.steps.map((s) => (
                        <li key={s.ref} data-links-chain-card-step={s.ref}>
                            <ItemGlyph state={s.state} />
                            <span data-links-node-ref="">{s.ref}</span>
                            <span data-links-chain-card-step-title="">{s.title}</span>
                            {s.owner ? Tile(s.owner) : null}
                        </li>
                    ))}
                </ol>
            </li>
        ))}
    </ol>
), { name: 'ChainList' });

const LEGEND: readonly { readonly state: 'claimed' | 'ready' | 'blocked'; readonly text: string }[] = [
    { state: 'claimed', text: 'working' },
    { state: 'ready', text: 'ready' },
    { state: 'blocked', text: 'waiting on another item' }
];

export type LinksBoardProps = Define.Prop<'data', LinksData, true>;

/** The page body over any data source: head with the toggle, graph (or chains), legend, chain panel. */
export const LinksBoard = component<LinksBoardProps>(({ props }) => {
    const st = signal<{ which: 'open' | 'done'; selected: string | null }>({ which: 'open', selected: null });
    return (): JSXElement => {
        const view = props.data[st.which];
        const milestones = milestonesOf(view);
        const selected = milestones.find((m) => m.ref === st.selected)?.ref ?? milestones[0]?.ref;
        const openCount = linkCount(props.data.open);
        const empty = linkCount(view) === 0;
        return (
            <section data-page="projects-links" data-projects-links="" aria-label="Links across projects">
                <nav data-projects-tabs="" aria-label="Projects views">
                    <Link to="/projects" class="projects-tab">Projects</Link>
                    <Link to="/projects/links" class="projects-tab" ariaCurrentValue="page">
                        Links
                        <span data-projects-tab-count="">{String(openCount)}</span>
                    </Link>
                </nav>
                <div data-links-head="">
                    <div data-links-heading="">
                        <h1 data-page-title="">Links across projects</h1>
                        <p data-links-sub="">Work in one project that waits on work in another. Follow a chain to see what is really holding a release up.</p>
                    </div>
                    <div data-links-toggle="" role="group" aria-label="Show links">
                        {(['open', 'done'] as const).map((w) => (
                            <button type="button" data-links-toggle-option={w} aria-pressed={st.which === w ? 'true' : 'false'} onClick={() => { st.which = w; }}>
                                {toggleLabel(w, props.data[w])}
                            </button>
                        ))}
                    </div>
                </div>
                {empty ? (
                    <EmptyState
                        variant="generic"
                        title={st.which === 'open' ? 'No open links across projects' : 'No done links yet'}
                        caption="An item that waits on an item in another project shows here, one lane per project. Links inside one project stay in that project's Plan graph."
                    />
                ) : (
                    <>
                        <LinksGraph view={view} selected={selected} onSelect={(ref: string) => { st.selected = ref; }} />
                        <ChainList view={view} />
                        <div data-links-foot="">
                            {selected ? (
                                <span data-links-highlight="">
                                    <span>Highlighted: the chain holding up</span>
                                    {RefChip(selected)}
                                </span>
                            ) : null}
                            <span data-links-grow="" />
                            <ul data-links-legend="" aria-label="Legend">
                                {LEGEND.map((l) => (
                                    <li key={l.state}>
                                        <ItemGlyph state={l.state} label="" />
                                        <span>{l.text}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        {selected ? <ChainPanel view={view} selected={selected} /> : null}
                    </>
                )}
            </section>
        );
    };
}, { name: 'LinksBoard' });

/** The board over the workspace's live link graphs (#881). */
const LiveProjectLinks = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const links = useLiveLinks(defs, viewer, () => projects.list());
    const names: LinkAgentNames = (id) => {
        const a = directory.lookup(id);
        return { name: a.name, hue: a.hue };
    };
    return () => <LinksBoard data={liveLinksData(links.graphs(), names)} />;
}, { name: 'LiveProjectLinks' });

/** `/projects/links`. */
export const ProjectLinks = component(() => {
    useHead({ title: 'Links' });
    return () => (dataMode() === 'live' ? <LiveProjectLinks /> : <LinksBoard data={MOCK_PROJECT_LINKS} />);
}, { name: 'ProjectLinks' });
