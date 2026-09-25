/**
 * `/projects/:id` — the project's home (#730, HANDOFF.md → "Project home"): what needs me here, and what is going on.
 * Header (square, name, feature tags, description, folder line, member tiles, New task / New chat); left, **Your
 * move** and the five most recent **Chats**; right, a 360px rail with one card per enabled feature that registers an
 * `OverviewCard` (`features/registry.ts`), then Schedules, People and places, and the dashed Add-a-feature card.
 * The rail drops under the main column below 1280px.
 *
 * On mock data the rows come from `mock/projects/overview.ts`; live, Your move waits for the derived work items (K1)
 * and the chats and schedules for their project reads, so those cards say so — the header, the feature cards and
 * People and places read the record.
 */
import { component, type Define, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import type { ProjectRecord } from '@agentic/core';
import { AgentTile, Button, Icon, ProjectSquare, StatusPill, type IconName } from '@agentic/ui';
import { useActorDefs, useViewer } from '../../../actors/defs';
import { Age } from '../../../components/Age';
import { Page } from '../../../components/Page';
import { dataMode } from '../../../data-mode';
import { MOCK_PROJECT_OVERVIEW } from '../../../mock/projects/overview';
import { AGENTS, USER } from '../../../mock/workspace';
import { useAgentDirectory } from '../../chat/directory';
import { featureViewsOf, type ProjectFeatureViews } from '../features/registry';
import type { ProjectPageProps } from '../layout/types';
import { settingsHref } from '../settings/tabs';
import { addFeatureHintOf, CHAT_STATE_PILL, EMPTY_OVERVIEW, folderLineOf, peopleOf, projectTagsOf, recentChatsOf, type AgentNames, type OverviewChat, type OverviewData, type OverviewMove } from './model';

export type OverviewViewProps =
    & Define.Prop<'project', ProjectRecord, true>
    & Define.Prop<'data', OverviewData, true>
    & Define.Prop<'names', AgentNames, true>
    /** The feature views by id; the registry's by default (a test passes its own). */
    & Define.Prop<'views', (featureId: string) => ProjectFeatureViews | undefined>
    /** The chats card's total when it knows more chats than `data.chats` holds. */
    & Define.Prop<'chatCount', number>;

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

const chatRow = (c: OverviewChat, names: AgentNames) => {
    const pill = CHAT_STATE_PILL[c.state];
    return (
        <li data-overview-chat={c.id} data-state={c.state}>
            <span data-overview-chat-state=""><StatusPill status={pill.status} label={pill.label} hollow={pill.hollow} /></span>
            <span data-overview-row-main="">
                <Link to={`/chats/${c.id}`}>
                    <span data-overview-row-title="">{c.title}</span>
                    <span data-overview-row-detail=""><b>{c.lastBy}:</b> {c.lastLine}</span>
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
                    <Button intent="primary" icon="chats" href="/chats/new">New chat</Button>
                </div>
            </header>

            <div data-overview-main="">
                <section data-overview-card="move" aria-label="Your move">
                    {cardHead('check', 'Your move', <Link to={`${base(p)}/work`}>All work →</Link>)}
                    {data.moves.length
                        ? <ul data-overview-rows="">{data.moves.map(moveRow)}</ul>
                        : <p data-overview-empty="">Nothing needs you here.</p>}
                </section>
                <section data-overview-card="chats" aria-label="Chats">
                    {cardHead('chats', 'Chats', <Link to={`${base(p)}/chats`}>{`All ${chatCount} chats →`}</Link>)}
                    {chats.length
                        ? <ul data-overview-rows="">{chats.map((c) => chatRow(c, names))}</ul>
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
                    {data.schedules.length
                        ? data.schedules.map((s) => {
                            const a = names(s.agentId);
                            return (
                                <div data-overview-schedule={s.id}>
                                    <div data-overview-kv="">
                                        <span data-overview-row-title="">{s.title}</span>
                                        <AgentTile name={a.name} hue={a.hue} size={20} />
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

const LiveOverview = component<ProjectPageProps>(({ props }) => {
    const directory = useAgentDirectory(useActorDefs(), useViewer()());
    const names: AgentNames = (id) => {
        const a = directory.lookup(id);
        return { name: a.name, hue: a.hue };
    };
    return () => <OverviewView project={props.project} data={EMPTY_OVERVIEW} names={names} />;
}, { name: 'LiveProjectOverview' });

export const ProjectOverview = component<ProjectPageProps>(({ props }) => () => (dataMode() === 'live'
    ? <LiveOverview project={props.project} />
    : <MockOverview project={props.project} />), { name: 'ProjectOverview' });
