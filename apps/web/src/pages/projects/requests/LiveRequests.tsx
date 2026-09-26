/**
 * The Requests inbox on the platform (#831): the project's Requests actor (#758) — `incoming()`, `sent()`, `linked()`
 * read live — with the project names from the workspace, the agent names from the directory and the phases from the
 * project's first plan. A person's Accept / Edit first / Ask for more / Decline is the actor's `resolve` (Let it in,
 * for a request the sender rules held back, its `admit`); the actor runs every rule, and a refusal shows as the note.
 */
import { component, signal, type Define } from 'sigx';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import type { ProjectRecord } from '@agentic/core';
import { useActorDefs, useViewer, type ActorDefs } from '../../../actors/defs';
import { planKeyOf, requestsKeyOf } from '../../../actors/keys';
import { Page } from '../../../components/Page';
import { useWorkspaceZone } from '../../../time';
import { useAgentDirectory } from '../../chat/directory';
import { useProjects } from '../live';
import { acceptResolution, failureNote, liveEntries, phasesOf } from './live';
import type { ActorNames } from './model';
import { RequestsView, type AcceptEdit } from './RequestsView';

type RequestsClient = ReturnType<typeof actor<ActorDefs['Requests']>>;

export const LiveRequests = component<Define.Prop<'project', ProjectRecord, true>>(({ props }) => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const directory = useAgentDirectory(defs, viewer);
    const projects = useProjects(defs, viewer);
    const key = (): string | null => (viewer.workspaceId ? requestsKeyOf(viewer.workspaceId, props.project.id) : null);
    const incoming = useActorState(defs.Requests, () => viewer.workspaceId && ([requestsKeyOf(viewer.workspaceId, props.project.id), 'incoming'] as const), { live: true });
    const sent = useActorState(defs.Requests, () => viewer.workspaceId && ([requestsKeyOf(viewer.workspaceId, props.project.id), 'sent'] as const), { live: true });
    const linked = useActorState(defs.Requests, () => viewer.workspaceId && ([requestsKeyOf(viewer.workspaceId, props.project.id), 'linked'] as const), { live: true });
    const plans = useActorState(defs.Plan, () => viewer.workspaceId && ([planKeyOf(viewer.workspaceId, props.project.id), 'list'] as const), { live: true });
    const zone = useWorkspaceZone(defs, viewer);
    const st = signal({ note: '' });

    const names: ActorNames = (id) => {
        const a = directory.lookup(id);
        return { name: a.name, hue: a.hue as 1 | 2 | 3 | 4 };
    };
    const manager = (): string => {
        const id = props.project.pm?.agentId ?? props.project.members.coordinator;
        return id ? names(id).name : 'The project manager';
    };
    const projectName = (id: string): string => projects.byId(id)?.name ?? id;

    /** One call on this project's Requests actor; a refusal becomes the note, a success clears it. */
    const run = async (what: string, call: (client: RequestsClient) => Promise<unknown>): Promise<void> => {
        const k = key();
        if (!k) return;
        try {
            await call(actor(defs.Requests, k));
            st.note = '';
        } catch (error) {
            st.note = failureNote(what, error);
        }
    };
    const needsOf = (id: string) => (incoming.value ?? []).find((r) => r.id === id)?.needs;
    const onAccept = (id: string, edit?: AcceptEdit): Promise<void> =>
        needsOf(id) === 'admit' ? run('let it in', (c) => c.admit(id)) : run('accept it', (c) => c.resolve(id, acceptResolution(edit)));

    return () => {
        const error = incoming.error ?? sent.error ?? linked.error;
        const entries = liveEntries({ incoming: incoming.value ?? [], sent: sent.value ?? [], linked: linked.value ?? [] }, projectName, manager());
        // Skeleton rows until the first read of each box lands, not the empty state (#942).
        const loading = !error && [incoming, sent, linked].some((r) => r.loading && r.value == null);
        const note = st.note || (error ? failureNote('read the requests', error) : '');
        return (
            <Page title="Requests" page="project-requests">
                <RequestsView
                    project={props.project}
                    entries={entries}
                    manager={manager()}
                    names={names}
                    you="you"
                    phases={phasesOf(plans.value?.plans)}
                    now={Date.now()}
                    zone={zone()}
                    loading={loading}
                    {...(note ? { note } : {})}
                    onAccept={(id: string, edit?: AcceptEdit) => void onAccept(id, edit)}
                    onAskForMore={(id: string, question: string) => void run('ask for more', (c) => c.resolve(id, { action: 'ask', question: question.trim() }))}
                    onDecline={(id: string, reason: string) => void run('decline it', (c) => c.resolve(id, { action: 'decline', reason: reason.trim() }))}
                />
            </Page>
        );
    };
}, { name: 'LiveRequests' });
