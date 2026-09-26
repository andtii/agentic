/**
 * `/projects/:id` — the project's home (#730, HANDOFF.md → "Project home"): what needs me here, and what is going on.
 * Header (square, name, feature tags, description, folder line, member tiles, New task / New chat); left, **Your
 * move** and the five most recent **Chats**; right, a 360px rail with one card per enabled feature that registers an
 * `OverviewCard` (`features/registry.ts`), then Schedules, People and places, and the dashed Add-a-feature card.
 * The rail drops under the main column below 1280px.
 *
 * On mock data the rows come from `mock/projects/overview.ts`; live (#933, `LiveOverview.tsx`), Your move is the
 * project's `your-move` work items, Chats its five most recent chats and Schedules its schedules — skeleton rows until
 * each first read lands. The header, the feature cards and People and places read the record.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { ProjectRecord } from '@agentic/core';
import { AgentTile, Button, Icon, ProjectSquare, StatusPill, TableSkeleton, type IconName } from '@agentic/ui';
import { Age } from '../../../components/Age';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { MOCK_PROJECT_OVERVIEW } from '../../../mock/projects/overview';
import { AGENTS, USER } from '../../../mock/workspace';
import { featureViewsOf, type ProjectFeatureViews } from '../features/registry';
import { projectMenuSource } from '../layout/menu';
import type { ProjectPageProps } from '../layout/types';
import { settingsHref } from '../settings/tabs';
import { addFeatureHintOf, CHAT_STATE_PILL, EMPTY_OVERVIEW, folderLineOf, peopleOf, projectTagsOf, recentChatsOf, type AgentNames, type OverviewChat, type OverviewData, type OverviewLoading, type OverviewMove } from './model';
import { useLiveOverview } from './LiveOverview';
import { chatHref } from '../../chat/href';
import { newChatInProjectHref } from '../../chat/new-chat-prefill';

export type OverviewViewProps =
    & Define.Prop<'project', ProjectRecord, true>
    & Define.Prop<'data', OverviewData, true>
    & Define.Prop<'names', AgentNames, true>
    /** The feature views by id; the registry's by default (a test passes its own). */
    & Define.Prop<'views', (featureId: string) => ProjectFeatureViews | undefined>
    /** The chats card's total when it knows more chats than `data.chats` holds. */
    & Define.Prop<'chatCount', number>
    /** The live cards still waiting for their first read (#933): skeleton rows instead of the empty line. */
    & Define.Prop<'loading', OverviewLoading>;

// The project's home is the route's own crumb: `Projects › <project name>` (live, what `ProjectLayout` published).
defineTopbar('project', (route) => ({ crumb: projectMenuSource(route)?.name }));

const base = (p: ProjectRecord): string => `/projects/${p.id}`;

const cardHead = (icon: IconName, title: string, aside?: JSXElement, feature?: boolean) => (
    <header data-overview-card-head="">
        <Icon name={icon} size={15} />
        <h2 data-overview-card-title="">{title}</h2>
        {feature ? <span data-overview-feature-tag="">FEATURE</span> : null}
        {aside ? <span data-overview-card-aside="">{aside}</span> : null}
    </header>
);

const moveRow = (m: OverviewMove) => (
    <li data-overview-move={m.id}>
        <span data-overview-dot="" aria-hidden="true" />
        <span data-overview-row-main="">
            <Link to={m.href}>
                <span data-overview-row-title="">{m.title}</span>
                <span data-overview-row-detail="">{m.detail}</span>
            </Link>
        </span>
        <span data-overview-ref="">{m.refIcon ? <Icon name={m.refIcon} size={12} /> : null}{m.ref}</span>
        <Age at={m.at} />
    </li>
);

const chatRow = (c: OverviewChat, names: AgentNames, projectId: string) => {
    const pill = CHAT_STATE_PILL[c.state];
    return (
        <li data-overview-chat={c.id} data-state={c.state}>
            <span data-overview-chat-state=""><StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} /></span>
            <span data-overview-row-main="">
                <Link to={chatHref({ id: c.id, projectId })}>
                    <span data-overview-row-title="">{c.title}</span>
                    <span data-overview-row-detail="">{c.lastBy ? <><b>{`${c.lastBy}:`}</b>{' '}</> : null}{c.lastLine}</span>
                </Link>
            </span>
            <span data-overview-tiles="">
                <AgentTile name={USER.name} person size={20} />
                {c.members.map((id) => {
                    const a = names(id);
                    return <AgentTile name={a.name} hue={a.hue} size={20} />;
                })}
            </span>
            <span data-overview-links="">
                {c.links.length
                    ? c.links.map((l) => <span data-overview-ref="">{l.icon ? <Icon name={l.icon} size={12} /> : null}{l.label}</span>)
                    : <span data-overview-none="">—</span>}
            </span>
            <Age at={c.at} />
        </li>
    );
};

/** The Overview over a record and its data: what both the mock and the live page render. */
export const OverviewView = component<OverviewViewProps>(({ props }) => () => {
    const p = props.project;
    const names = props.names;
    const data = props.data;
    const views = props.views ?? featureViewsOf;
    const chats = recentChatsOf(data.chats);
    const chatCount = props.chatCount ?? data.chats.length;
    const loading = props.loading ?? {};
    const skeleton = (label: string) => <div data-overview-loading=""><TableSkeleton rows={3} cols="1fr 80px" label={label} /></div>;
    const cards = Object.keys(p.features).flatMap((id) => {
        const Card = views(id)?.OverviewCard;
        return Card ? [{ id, Card }] : [];
    });
    return (
        <Page title={p.name} page="project-overview" hideTitle>
            <header data-overview-header="">
                <ProjectSquare name={p.name} id={p.id} color={p.color} size={44} />
                <div data-overview-ident="">
                    <div data-overview-name-line="">
                        <span data-overview-name="">{p.name}</span>
                        {projectTagsOf(p).map((t) => <span data-overview-tag={t.kind} data-id={t.id}>{t.label}</span>)}
                    </div>
                    <div data-overview-sub="">
                        {p.description ? <span data-overview-description="">{p.description}</span> : null}
                        <span data-overview-folder="">{folderLineOf(p)}</span>
                    </div>
                </div>
                <div data-overview-actions="">
                    <span data-overview-tiles="">
                        {p.members.agentIds.map((id) => {
                            const a = names(id);
                            return <AgentTile name={a.name} hue={a.hue} size={22} labelled />;
                        })}
                    </span>
                    <Button icon="plus" href={`${base(p)}/work`}>New task</Button>
                    <Button intent="primary" icon="chats" href={newChatInProjectHref(p.id)}>New chat</Button>
                </div>
            </header>

            <div data-overview-main="">
                <section data-overview-card="move" aria-label="Your move">
                    {cardHead('check', 'Your move', <Link to={`${base(p)}/work`}>All work →</Link>)}
                    {loading.moves && !data.moves.length ? skeleton('Loading your move') : data.moves.length
                        ? <ul data-overview-rows="">{data.moves.map(moveRow)}</ul>
                        : <p data-overview-empty="">Nothing needs you here.</p>}
                </section>
                <section data-overview-card="chats" aria-label="Chats">
                    {cardHead('chats', 'Chats', <Link to={`${base(p)}/chats`}>{`All ${chatCount} chats →`}</Link>)}
                    {loading.chats && !chats.length ? skeleton('Loading chats') : chats.length
                        ? <ul data-overview-rows="">{chats.map((c) => chatRow(c, names, p.id))}</ul>
                        : <p data-overview-empty="">No chats in this project yet.</p>}
                </section>
            </div>

            <aside data-overview-rail="" aria-label="Project cards">
                {cards.map(({ id, Card }) => (
                    <div data-overview-feature={id}>
                        <Card project={p} />
                    </div>
                ))}
                <section data-overview-card="schedules" aria-label="Schedules">
                    {cardHead('schedules', 'Schedules', <Link to="/schedules">Edit</Link>)}
                    {loading.schedules && !data.schedules.length ? skeleton('Loading schedules') : data.schedules.length
                        ? data.schedules.map((s) => {
                            const a = s.agentId ? names(s.agentId) : null;
                            return (
                                <div data-overview-schedule={s.id}>
                                    <div data-overview-kv="">
                                        <span data-overview-row-title="">{s.title}</span>
                                        {a ? <AgentTile name={a.name} hue={a.hue} size={20} /> : null}
                                    </div>
                                    <div data-overview-kv="">
                                        <span data-overview-k="">Next run</span>
                                        <span data-overview-v="" data-mono="">{s.next}</span>
                                    </div>
                                </div>
                            );
                        })
                        : <p data-overview-empty="">No schedules in this project.</p>}
                </section>
                <section data-overview-card="people" aria-label="People and places">
                    {cardHead('agents', 'People and places', <Link to={settingsHref(p.id, 'members')}>Edit</Link>)}
                    <dl data-overview-people="">
                        {peopleOf(p, names).map((row) => (
                            <div data-overview-kv="">
                                <dt data-overview-k="">{row.label}</dt>
                                <dd data-overview-v="" data-mono={row.mono ? '' : undefined}>{row.value}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
                <div data-overview-add-feature="">
                    <Link to={settingsHref(p.id, 'features')}>
                        <span data-overview-add-icon=""><Icon name="plus" size={15} /></span>
                        <span>
                            <span data-overview-row-title="">Add a feature</span>
                            <span data-overview-row-detail="">{addFeatureHintOf(p)}</span>
                        </span>
                    </Link>
                </div>
            </aside>
        </Page>
    );
}, { name: 'OverviewView' });

const mockNames: AgentNames = (id) => {
    const a = AGENTS.find((x) => x.id === id);
    return a ? { name: a.name, hue: a.hue } : { name: id };
};

const MockOverview = component<ProjectPageProps>(({ props }) => () => (
    <OverviewView project={props.project} data={MOCK_PROJECT_OVERVIEW[props.project.id] ?? EMPTY_OVERVIEW} names={mockNames} />
), { name: 'MockProjectOverview' });

/** Live (#933): the project's work items, chats and schedules over the actor wire, with watchers keeping them current. */
const LiveOverview = component<ProjectPageProps>(({ props }) => {
    const live = useLiveOverview(() => props.project);
    return () => (
        <>
            <OverviewView project={props.project} data={live.data()} names={live.names} chatCount={live.chatCount()} loading={live.loading()} />
            {live.watchers()}
        </>
    );
}, { name: 'LiveProjectOverview' });

export const ProjectOverview = component<ProjectPageProps>(({ props }) => () => (dataMode() === 'live'
    ? <LiveOverview project={props.project} />
    : <MockOverview project={props.project} />), { name: 'ProjectOverview' });
