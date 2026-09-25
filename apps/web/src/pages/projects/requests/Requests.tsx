import { component, signal } from 'sigx';
import { Page } from '../../../components/Page';
import { defineTopbar } from '../../../components/topbar';
import { dataMode } from '../../../data-mode';
import { MOCK_REQUEST_ITEM_FLOOR, MOCK_REQUEST_PHASES, MOCK_REQUESTS } from '../../../mock/projects/requests';
import { AGENTS, MOCK_NOW, USER } from '../../../mock/workspace';
import { projectTrail } from '../layout/trail';
import type { ProjectPageProps } from '../layout/types';
import { LiveRequests } from './LiveRequests';
import { accept, askForMore, decline, nextItemNumber, type ActorNames, type RequestEntry } from './model';
import { RequestsView, type AcceptEdit } from './RequestsView';

defineTopbar('project-requests', (route) => ({ trail: projectTrail(route, { label: 'Requests', href: `/projects/${String(route.params.id)}/requests` }) }));

/** Agents by id from the sample workspace; an agent of another project shows by its id, capitalised. */
const mockNames: ActorNames = (id) => {
    const a = AGENTS.find((x) => x.id === id);
    return a ? { name: a.name, hue: a.hue as 1 | 2 | 3 | 4 } : { name: id.slice(0, 1).toUpperCase() + id.slice(1) };
};

/**
 * `/projects/:id/requests` — the project manager's inbox (#761; HANDOFF.md → "Project manager and requests"). On mock
 * data the board's batch; a person's accept, ask or decline changes it for the page's lifetime. Live, the project's
 * Requests store (#758), read and resolved by `LiveRequests` (#831).
 */
export const ProjectRequests = component<ProjectPageProps>(({ props }) => {
    if (dataMode() === 'live') return () => <LiveRequests project={props.project} />;
    const st = signal({ entries: (MOCK_REQUESTS[props.project.id] ?? []) as readonly RequestEntry[] });
    const managerId = props.project.members.coordinator;
    const manager = (): string => (managerId ? mockNames(managerId).name : 'The project manager');
    const change = (id: string, f: (e: RequestEntry) => RequestEntry): void => {
        st.entries = st.entries.map((e) => (e.request.id === id ? f(e) : e));
    };
    const onAccept = (id: string, edit?: AcceptEdit): void => {
        const n = nextItemNumber(st.entries, MOCK_REQUEST_ITEM_FLOOR[props.project.id] ?? 0);
        change(id, (e) => accept(e, n, MOCK_NOW, edit));
    };
    return () => (
        <Page title="Requests" page="project-requests">
            <RequestsView
                project={props.project}
                entries={st.entries}
                manager={manager()}
                names={mockNames}
                you={USER.name}
                phases={MOCK_REQUEST_PHASES[props.project.id] ?? []}
                now={MOCK_NOW}
                onAccept={onAccept}
                onAskForMore={(id: string, q: string) => change(id, (e) => askForMore(e, q, manager(), MOCK_NOW))}
                onDecline={(id: string, reason: string) => change(id, (e) => decline(e, reason, MOCK_NOW))}
            />
        </Page>
    );
}, { name: 'ProjectRequests' });
