import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { enabledProjectFeatures } from '@agentic/core';
import { CardSkeleton, EmptyState, Icon, ProjectSquare, StatusPill, Tag, type IconName } from '@agentic/ui';
import { MemberTiles } from '../../chat/ChatList';
import type { AgentLookup } from '../../chat/live';
import { LinkButton } from '../../ops/LinkButton';
import { projectPlaces, type ProjectMachine } from '../model';
import { cardPills, featureTag, openLinksText, unassignedText, type OpenLinksData, type ProjectCardData, type UnassignedData } from './model';

export type ProjectsBoardProps =
    & Define.Prop<'cards', readonly ProjectCardData[], true>
    /** The paired machines and their environments, for the place tags' labels (#702). */
    & Define.Prop<'machines', readonly ProjectMachine[], true>
    & Define.Prop<'lookup', AgentLookup, true>
    /** Absent: the strip and the tab count stay hidden (no links source yet). */
    & Define.Prop<'links', OpenLinksData>
    & Define.Prop<'unassigned', UnassignedData>
    & Define.Prop<'loading', boolean>;

const FEATURE_ICONS: Readonly<Record<string, IconName>> = { git: 'branch', plan: 'tree', calendar: 'schedules', budget: 'usage' };

/**
 * `/projects` (#729; PRJ-02): the index board — heading with the count and New project, the Projects | Links tabs,
 * the open-links strip, one card per project in a 3-column grid (what needs you there and what comes next), the
 * dashed strip for work outside any project; three skeleton cards while loading, the empty state when there are none.
 * Both data sources render this.
 */
export const ProjectsBoard = component<ProjectsBoardProps>(({ props }) => () => {
    const loading = props.loading && !props.cards.length;
    const outside = unassignedText(props.unassigned);
    return (
        <section data-page="projects" data-projects-index="" aria-label="Projects" aria-busy={loading ? 'true' : undefined}>
            <div data-projects-head="">
                <h1 data-page-title="">
                    Projects
                    {!loading ? <span data-projects-count="">{String(props.cards.length)}</span> : null}
                </h1>
                <LinkButton to="/projects/new" intent="primary" icon="plus">New project</LinkButton>
            </div>
            <nav data-projects-tabs="" aria-label="Projects views">
                <Link to="/projects" class="projects-tab" ariaCurrentValue="page">Projects</Link>
                <Link to="/projects/links" class="projects-tab">
                    Links
                    {props.links ? <span data-projects-tab-count="">{String(props.links.count)}</span> : null}
                </Link>
            </nav>
            {props.links && props.links.count > 0 ? (
                <div data-projects-links-strip="">
                    <Icon name="link" />
                    <strong>{openLinksText(props.links)}</strong>
                    <span data-projects-links-summary="">{props.links.summary}</span>
                    <Link to="/projects/links" class="projects-strip-action">See links</Link>
                </div>
            ) : null}
            {loading
                ? (
                    <div data-projects-grid="">
                        {[0, 1, 2].map(() => <CardSkeleton lines={3} label="" />)}
                    </div>
                )
                : !props.cards.length
                    ? (
                        <EmptyState
                            variant="generic"
                            title="No projects yet"
                            caption="A project is the home for everything done toward one goal: its chats, its work, its plan and the features switched on for it."
                            slots={{ actions: () => <LinkButton to="/projects/new" intent="primary" icon="plus">New project</LinkButton> }}
                        />
                    )
                    : (
                        <ul data-projects-grid="" aria-label="Projects">
                            {props.cards.map((card) => {
                                const p = card.project;
                                return (
                                    <li data-project-row={p.id}>
                                        <Link to={`/projects/${p.id}`} class="project-card">
                                            <span data-project-card-head="">
                                                <ProjectSquare name={p.name} id={p.id} size={36} {...(p.color ? { color: p.color } : {})} />
                                                <span data-project-card-title="">
                                                    <span data-project-name="">{p.name}</span>
                                                    {p.description ? <span data-project-description="">{p.description}</span> : null}
                                                </span>
                                                <MemberTiles agentIds={p.members.agentIds} lookup={props.lookup} />
                                            </span>
                                            <span data-project-badges="">
                                                {enabledProjectFeatures(p).map((id) => {
                                                    const tag = featureTag(id);
                                                    const icon = FEATURE_ICONS[tag];
                                                    return <Tag class="project-feature">{icon ? <Icon name={icon} size={12} /> : null}{tag}</Tag>;
                                                })}
                                                {projectPlaces(p, props.machines).map((e) => <Tag class="project-env"><Icon name="machines" size={12} />{e.label}</Tag>)}
                                            </span>
                                            {cardPills(card).length ? (
                                                <span data-project-pills="">
                                                    {cardPills(card).map((pill) => <StatusPill status={pill.kind} label={pill.label} tone={pill.tone} hollow={pill.hollow ?? false} />)}
                                                </span>
                                            ) : null}
                                            {card.next ? <span data-project-next="">{card.next}</span> : null}
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
            {outside ? (
                <div data-projects-unassigned="">
                    <Icon name="chats" />
                    <span>{outside}</span>
                    <Link to="/chats?project=none" class="projects-strip-action">Show</Link>
                </div>
            ) : null}
        </section>
    );
}, { name: 'ProjectsBoard' });
