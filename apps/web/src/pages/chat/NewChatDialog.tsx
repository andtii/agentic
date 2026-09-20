import { component, signal, watch, type Define } from 'sigx';
import type { ProjectRecord } from '@agentic/core';
import { ConfirmDialog, SelectField, type WorkdirEnvironment } from '@agentic/ui';
import type { AgentIdentity } from './live';
import { MemberPicker } from './MemberPicker';

/** What the picker needs of a project: `ProjectRecord` fits. */
export type NewChatProject = Pick<ProjectRecord, 'id' | 'name' | 'members' | 'folders' | 'connectors'>;

export type NewChatDialogProps =
    & Define.Model<boolean>
    /** The workspace's agents to pick members from. */
    & Define.Prop<'agents', readonly AgentIdentity[], true>
    /** The workspace's environments with their accounts' limits (#315): each card shows where its agent runs and the headroom there. */
    & Define.Prop<'environments', readonly WorkdirEnvironment[]>
    /** The workspace's projects (#333): the picker at the top; absent or empty, the dialog shows no picker. */
    & Define.Prop<'projects', readonly NewChatProject[]>
    /** The project used last (`Workspace.get().lastProjectId`): preselected when the dialog opens. */
    & Define.Prop<'lastProjectId', string | null>
    & Define.Prop<'busy', boolean>
    & Define.Event<'create', { readonly agentIds: readonly string[]; readonly coordinator: string | null; readonly projectId: string | null }>
    & Define.Event<'cancel'>;

/**
 * "New chat" (CHT-01, CHT-07): pick one or more agents from cards, optionally
 * name a coordinator among them. Every picked member sees all history — the
 * chat is new, there is none to hide. A direct chat is one agent; a group is
 * several; a coordinator is optional (a single global assistant is not
 * required).
 *
 * With projects (#333) the dialog opens on a project picker preselected from
 * the last one used: picking a project fills the members and the coordinator
 * from its roster (still editable) and says which connectors and folders a
 * chat in it gets; "No project" keeps the plain flow.
 */
export const NewChatDialog = component<NewChatDialogProps>(({ props, emit }) => {
    const projectOf = (id: string): NewChatProject | undefined => props.projects?.find((p) => p.id === id);
    /** The project an opening starts on: the last used one, when the workspace still has it. */
    const lastProject = (): string => (props.lastProjectId && projectOf(props.lastProjectId) ? props.lastProjectId : '');
    /** The roster a project names — the members the workspace still has, and the coordinator when it is one of them. */
    const rosterOf = (id: string): { picked: string[]; coordinator: string } => {
        const p = projectOf(id);
        if (!p) return { picked: [], coordinator: '' };
        const picked = p.members.agentIds.filter((a) => props.agents.some((x) => x.id === a));
        return { picked, coordinator: p.members.coordinator && picked.includes(p.members.coordinator) ? p.members.coordinator : '' };
    };
    // Mounted open (the tests): already on the last used project and its roster.
    const first = props.model?.value === true ? lastProject() : '';
    const st = signal({ ...rosterOf(first), attempted: false, project: first });
    const toggle = (id: string, on: boolean): void => {
        st.picked = on ? [...new Set([...st.picked, id])] : st.picked.filter((p) => p !== id);
        if (!on && st.coordinator === id) st.coordinator = '';
        if (on) st.attempted = false;
    };
    const nameOf = (id: string): string => props.agents.find((a) => a.id === id)?.name ?? id;
    /** A picked project fills the roster from its members (still editable). */
    const applyProject = (id: string): void => {
        if (!projectOf(id)) return;
        Object.assign(st, rosterOf(id));
        if (st.picked.length) st.attempted = false;
    };
    // Each opening starts on the last used project and the roster it names — including when the projects or the
    // last id land while the dialog is open. Not `immediate`: the initial state above covers the mount, and a
    // watch callback that runs inside setup must not read `st` (it would become a dependency of the key).
    let syncing = false;
    watch(
        () => (props.model?.value === true ? `open\n${props.lastProjectId ?? ''}\n${props.projects?.length ?? 0}\n${props.agents.length}` : ''),
        (key) => {
            if (!key) return;
            const last = lastProject();
            if (st.project === last) {
                applyProject(last);
                return;
            }
            syncing = true;
            st.project = last;
            applyProject(last);
        }
    );
    // A person's pick in the select fills the roster; the opening sync already did.
    watch(
        () => st.project,
        (id) => {
            if (syncing) syncing = false;
            else applyProject(id);
        }
    );
    return () => {
        const group = st.picked.length > 1;
        const project = projectOf(st.project);
        const envLabel = (id: string): string => props.environments?.find((e) => e.id === id)?.label ?? id;
        const folders = project ? Object.entries(project.folders).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
        return (
            <ConfirmDialog
                model={props.model}
                title="New chat"
                description="Who is in it? Pick one agent for a direct chat, or several for a group. Each card shows where the agent runs and how much of that account’s plan is left."
                confirmLabel={st.picked.length > 1 ? `Create chat with ${st.picked.length}` : 'Create chat'}
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    // A chat needs at least one member (CHT-01): confirming with none picked keeps the dialog open.
                    if (!st.picked.length) {
                        st.attempted = true;
                        return;
                    }
                    emit('create', { agentIds: st.picked, coordinator: st.coordinator || null, projectId: st.project || null });
                }}
                onCancel={() => emit('cancel')}
            >
                {props.projects?.length ? (
                    <div data-new-chat-project>
                        <SelectField
                            model={() => st.project}
                            name="chat-project"
                            label="Project"
                            options={[{ value: '', label: 'No project' }, ...props.projects.map((p) => ({ value: p.id, label: p.name }))]}
                            description="A chat in a project starts with its members and runs in its folders."
                        />
                        {project ? (
                            <p data-new-chat-project-line>
                                {project.connectors.length ? `Connectors: ${project.connectors.map((c) => c.id).join(', ')}` : 'No connectors'}
                                {' · '}
                                {folders.length ? folders.map(([env, path]) => `${envLabel(env)}: ${path}`).join(' · ') : 'no folders yet'}
                            </p>
                        ) : null}
                    </div>
                ) : null}
                <MemberPicker agents={props.agents} environments={props.environments} picked={st.picked} coordinator={st.coordinator} onToggle={(e) => toggle(e.id, e.on)} onPickCoordinator={(id) => { st.coordinator = id; }} />
                <p data-new-chat-summary aria-live="polite">
                    {!st.picked.length
                        ? (st.attempted ? <span data-new-chat-required role="alert">Pick at least one agent.</span> : 'Nobody picked yet.')
                        : !group
                            ? `A direct chat with ${nameOf(st.picked[0]!)}.`
                            : st.coordinator
                                ? <>A group of {st.picked.length}. {nameOf(st.coordinator)} answers unless you mention someone. <button type="button" data-link-button onClick={() => { st.coordinator = ''; }}>No coordinator</button></>
                                : `A group of ${st.picked.length}, no coordinator: mention an agent to address it.`}
                </p>
            </ConfirmDialog>
        );
    };
});
