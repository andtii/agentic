import { component, type Define } from 'sigx';
import { Link } from '@sigx/router';
import { enabledProjectFeatures, type ProjectRecord } from '@agentic/core';
import { EmptyState, Tag } from '@agentic/ui';
import { MemberTiles } from '../chat/ChatList';
import type { AgentLookup } from '../chat/live';
import { LinkButton } from '../ops/LinkButton';
import { projectPlaces, type ProjectMachine } from './model';

export type ProjectsViewProps =
    & Define.Prop<'projects', readonly ProjectRecord[], true>
    /** The paired machines and their environments, for the badges' labels (#702). */
    & Define.Prop<'machines', readonly ProjectMachine[], true>
    & Define.Prop<'lookup', AgentLookup, true>
    /** Feature plugin id → its name; an unknown id shows as the id. */
    & Define.Prop<'featureName', (id: string) => string>
    & Define.Prop<'loading', boolean>;

/**
 * `/projects` (#333): one row per project — name, members, a badge per
 * environment it has a folder on, and its enabled features — the row is
 * the link to its page. Both data sources render this.
 */
export const ProjectsView = component<ProjectsViewProps>(({ props }) => () => (
    <div data-page="projects" aria-busy={props.loading ? 'true' : undefined}>
        <div data-page-head="">
            <h1 data-page-title>Projects</h1>
        </div>
        {!props.projects.length && !props.loading
            ? (
                <EmptyState
                    variant="generic"
                    title="No projects yet"
                    caption="A project says where the work lives on each machine, who works on it and which connectors every session gets. New chat starts from one."
                    slots={{ actions: () => <LinkButton to="/projects/new" intent="primary" icon="plus">New project</LinkButton> }}
                />
            )
            : (
                <ul data-project-list aria-label="Projects">
                    {props.projects.map((p) => (
                        <li data-project-row={p.id}>
                            <Link to={`/projects/${p.id}`} class="project-row">
                                <span data-project-row-head>
                                    <span data-project-name>{p.name}</span>
                                    <MemberTiles agentIds={p.members.agentIds} lookup={props.lookup} />
                                </span>
                                {p.description ? <span data-project-description>{p.description}</span> : null}
                                <span data-project-badges>
                                    {projectPlaces(p, props.machines).map((e) => <Tag class="project-env" tone="live">{e.label}</Tag>)}
                                    {enabledProjectFeatures(p).map((id) => <Tag class="project-feature">{props.featureName?.(id) ?? id}</Tag>)}
                                    {!Object.keys(p.folders).length ? <span data-project-nofolder>No folder yet</span> : null}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
    </div>
));
